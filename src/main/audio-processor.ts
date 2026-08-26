import { randomUUID } from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

const CAPTURE_SAMPLE_RATE_HZ = 16_000;
const CAPTURE_CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const PCM_FORMAT = 1;
const WAV_HEADER_BYTES = 44;
const STREAM_CHUNK_BYTES = 64 * 1024;
const MIN_SILENCE_SECONDS = 0.5;
const SILENCE_THRESHOLD_SAMPLE = Math.floor(32767 * 10 ** (-50 / 20));

export interface AudioInterval {
  start: number;
  end: number;
}

interface WavPcmInfo {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

export async function splitChannels(
  audioPath: string,
  output?: { system?: string; mic?: string },
): Promise<{ system: string; mic: string }> {
  const dir = path.dirname(audioPath);
  const systemPath = output?.system ?? path.join(dir, 'channel-system.wav');
  const micPath = output?.mic ?? path.join(dir, 'channel-mic.wav');
  const resolvedInput = path.resolve(audioPath);

  if (
    path.resolve(systemPath) === resolvedInput ||
    path.resolve(micPath) === resolvedInput ||
    path.resolve(systemPath) === path.resolve(micPath)
  ) {
    throw new Error('Invalid channel output path');
  }

  const input = await fs.promises.open(audioPath, 'r');
  const suffix = `.tmp-${process.pid}-${randomUUID()}`;
  const systemTempPath = `${systemPath}${suffix}`;
  const micTempPath = `${micPath}${suffix}`;
  let systemOutput: fs.promises.FileHandle | undefined;
  let micOutput: fs.promises.FileHandle | undefined;

  try {
    const info = await readWavPcmInfo(input);
    assertFixedCaptureFormat(info);

    systemOutput = await fs.promises.open(systemTempPath, 'wx');
    micOutput = await fs.promises.open(micTempPath, 'wx');

    const monoDataSize = info.dataSize / CAPTURE_CHANNELS;
    const monoHeader = createPcmWavHeader(monoDataSize, CAPTURE_SAMPLE_RATE_HZ, 1);
    await Promise.all([
      writeFileBytes(systemOutput, monoHeader, 0),
      writeFileBytes(micOutput, monoHeader, 0),
    ]);

    let inputOffset = info.dataOffset;
    let outputOffset = WAV_HEADER_BYTES;
    let remaining = info.dataSize;

    while (remaining > 0) {
      const requested = Math.min(STREAM_CHUNK_BYTES, remaining);
      const chunkSize = requested - (requested % info.blockAlign);
      if (chunkSize === 0) {
        throw new Error('Invalid WAV file');
      }

      const interleaved = await readWavBytes(input, inputOffset, chunkSize);
      const frameCount = chunkSize / info.blockAlign;
      const system = Buffer.allocUnsafe(frameCount * 2);
      const mic = Buffer.allocUnsafe(frameCount * 2);

      for (let frame = 0; frame < frameCount; frame += 1) {
        const sourceOffset = frame * info.blockAlign;
        system.writeInt16LE(interleaved.readInt16LE(sourceOffset), frame * 2);
        mic.writeInt16LE(interleaved.readInt16LE(sourceOffset + 2), frame * 2);
      }

      await Promise.all([
        writeFileBytes(systemOutput, system, outputOffset),
        writeFileBytes(micOutput, mic, outputOffset),
      ]);
      inputOffset += chunkSize;
      outputOffset += system.length;
      remaining -= chunkSize;
    }

    await Promise.all([systemOutput.sync(), micOutput.sync()]);
    await Promise.all([systemOutput.close(), micOutput.close()]);
    systemOutput = undefined;
    micOutput = undefined;

    await Promise.all([
      fs.promises.rm(systemPath, { force: true }),
      fs.promises.rm(micPath, { force: true }),
    ]);
    await fs.promises.rename(systemTempPath, systemPath);
    await fs.promises.rename(micTempPath, micPath);

    return { system: systemPath, mic: micPath };
  } catch (error) {
    await Promise.allSettled([
      systemOutput?.close(),
      micOutput?.close(),
      fs.promises.rm(systemTempPath, { force: true }),
      fs.promises.rm(micTempPath, { force: true }),
      fs.promises.rm(systemPath, { force: true }),
      fs.promises.rm(micPath, { force: true }),
    ]);
    throw error;
  } finally {
    await input.close();
  }
}

export async function isChannelSilent(audioPath: string): Promise<boolean> {
  return (await getAudibleIntervals(audioPath)).length === 0;
}

export async function getAudibleIntervals(audioPath: string): Promise<AudioInterval[]> {
  const input = await fs.promises.open(audioPath, 'r');

  try {
    const info = await readWavPcmInfo(input);
    assertMonoAnalysisFormat(info);

    const minimumSilenceFrames = Math.ceil(info.sampleRate * MIN_SILENCE_SECONDS);
    const totalFrames = info.dataSize / info.blockAlign;
    const intervals: AudioInterval[] = [];
    let audibleStartFrame = 0;
    let silenceStartFrame: number | undefined;
    let hasAudibleSample = false;
    let frameIndex = 0;
    let inputOffset = info.dataOffset;
    let remaining = info.dataSize;

    while (remaining > 0) {
      const requested = Math.min(STREAM_CHUNK_BYTES, remaining);
      const chunkSize = requested - (requested % info.blockAlign);
      if (chunkSize === 0) {
        throw new Error('Invalid WAV file');
      }
      const pcm = await readWavBytes(input, inputOffset, chunkSize);

      for (let offset = 0; offset < pcm.length; offset += info.blockAlign) {
        const isSilent = Math.abs(pcm.readInt16LE(offset)) <= SILENCE_THRESHOLD_SAMPLE;
        if (isSilent) {
          silenceStartFrame ??= frameIndex;
        } else if (silenceStartFrame !== undefined) {
          hasAudibleSample = true;
          if (frameIndex - silenceStartFrame >= minimumSilenceFrames) {
            pushInterval(intervals, audibleStartFrame, silenceStartFrame, info.sampleRate);
            audibleStartFrame = frameIndex;
          }
          silenceStartFrame = undefined;
        } else {
          hasAudibleSample = true;
        }
        frameIndex += 1;
      }

      inputOffset += chunkSize;
      remaining -= chunkSize;
    }

    if (!hasAudibleSample) {
      return [];
    }

    if (
      silenceStartFrame !== undefined &&
      totalFrames - silenceStartFrame >= minimumSilenceFrames
    ) {
      pushInterval(intervals, audibleStartFrame, silenceStartFrame, info.sampleRate);
    } else {
      pushInterval(intervals, audibleStartFrame, totalFrames, info.sampleRate);
    }

    return intervals;
  } finally {
    await input.close();
  }
}

export async function getAudioDuration(audioPath: string): Promise<number> {
  const fd = await fs.promises.open(audioPath, 'r');

  try {
    const info = await readWavPcmInfo(fd);
    if (info.byteRate === 0) {
      throw new Error('Invalid WAV file: byte rate is zero');
    }
    return info.dataSize / info.byteRate;
  } finally {
    await fd.close();
  }
}

function assertFixedCaptureFormat(info: WavPcmInfo): void {
  if (
    info.audioFormat !== PCM_FORMAT ||
    info.channels !== CAPTURE_CHANNELS ||
    info.sampleRate !== CAPTURE_SAMPLE_RATE_HZ ||
    info.bitsPerSample !== BITS_PER_SAMPLE ||
    info.blockAlign !== 4 ||
    info.byteRate !== CAPTURE_SAMPLE_RATE_HZ * 4 ||
    info.dataSize % info.blockAlign !== 0
  ) {
    throw new Error('Unsupported WAV format');
  }
}

function assertMonoAnalysisFormat(info: WavPcmInfo): void {
  if (
    info.audioFormat !== PCM_FORMAT ||
    info.channels !== 1 ||
    info.sampleRate !== CAPTURE_SAMPLE_RATE_HZ ||
    info.bitsPerSample !== BITS_PER_SAMPLE ||
    info.blockAlign !== 2 ||
    info.byteRate !== CAPTURE_SAMPLE_RATE_HZ * 2 ||
    info.dataSize % info.blockAlign !== 0
  ) {
    throw new Error('Unsupported WAV format');
  }
}

function pushInterval(
  intervals: AudioInterval[],
  startFrame: number,
  endFrame: number,
  sampleRate: number,
): void {
  if (endFrame > startFrame) {
    intervals.push({ start: startFrame / sampleRate, end: endFrame / sampleRate });
  }
}

async function readWavPcmInfo(fd: fs.promises.FileHandle): Promise<WavPcmInfo> {
  const stat = await fd.stat();
  const riffHeader = await readWavBytes(fd, 0, 12);
  if (
    riffHeader.toString('ascii', 0, 4) !== 'RIFF' ||
    riffHeader.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Invalid WAV file');
  }

  let format: Omit<WavPcmInfo, 'dataOffset' | 'dataSize'> | undefined;
  let data: Pick<WavPcmInfo, 'dataOffset' | 'dataSize'> | undefined;
  let offset = 12;

  while (offset + 8 <= stat.size) {
    const chunkHeader = await readWavBytes(fd, offset, 8);
    const chunkId = chunkHeader.toString('ascii', 0, 4);
    const chunkSize = chunkHeader.readUInt32LE(4);
    const chunkDataOffset = offset + 8;

    if (chunkDataOffset + chunkSize > stat.size) {
      throw new Error('Invalid WAV file');
    }

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) {
        throw new Error('Invalid WAV file');
      }
      const bytes = await readWavBytes(fd, chunkDataOffset, 16);
      format = {
        audioFormat: bytes.readUInt16LE(0),
        channels: bytes.readUInt16LE(2),
        sampleRate: bytes.readUInt32LE(4),
        byteRate: bytes.readUInt32LE(8),
        blockAlign: bytes.readUInt16LE(12),
        bitsPerSample: bytes.readUInt16LE(14),
      };
    } else if (chunkId === 'data') {
      data = { dataOffset: chunkDataOffset, dataSize: chunkSize };
    }

    if (format !== undefined && data !== undefined) {
      return { ...format, ...data };
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  throw new Error('Invalid WAV file');
}

function createPcmWavHeader(dataSize: number, sampleRate: number, channels: number): Buffer {
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0);
  header.writeUInt32LE(dataSize + WAV_HEADER_BYTES - 8, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(PCM_FORMAT, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

async function readWavBytes(
  fd: fs.promises.FileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let totalRead = 0;
  while (totalRead < length) {
    const { bytesRead } = await fd.read(
      buffer,
      totalRead,
      length - totalRead,
      position + totalRead,
    );
    if (bytesRead === 0) {
      throw new Error('Invalid WAV file');
    }
    totalRead += bytesRead;
  }
  return buffer;
}

async function writeFileBytes(
  fd: fs.promises.FileHandle,
  bytes: Buffer,
  position: number,
): Promise<void> {
  let totalWritten = 0;
  while (totalWritten < bytes.length) {
    const { bytesWritten } = await fd.write(
      bytes,
      totalWritten,
      bytes.length - totalWritten,
      position + totalWritten,
    );
    if (bytesWritten === 0) {
      throw new Error('Could not write WAV file');
    }
    totalWritten += bytesWritten;
  }
}
