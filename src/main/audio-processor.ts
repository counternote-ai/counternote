import { execFile as childProcessExecFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execFileAsync = promisify(childProcessExecFile);

// Get ffmpeg path from ffmpeg-static
const ffmpegPath = require('ffmpeg-static');

export interface AudioProcessorDependencies {
  execFile: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

function defaultDependencies(): AudioProcessorDependencies {
  return {
    execFile: execFileAsync,
  };
}

export async function splitChannels(
  audioPath: string,
  deps: AudioProcessorDependencies = defaultDependencies(),
  output?: { system?: string; mic?: string }
): Promise<{ system: string; mic: string }> {
  const dir = path.dirname(audioPath);
  const systemPath = output?.system ?? path.join(dir, 'channel-system.wav');
  const micPath = output?.mic ?? path.join(dir, 'channel-mic.wav');

  // Extract channel 1 (system audio)
  await deps.execFile(ffmpegPath, [
    '-nostdin',
    '-y',
    '-i',
    audioPath,
    '-filter_complex',
    'channelsplit=channel_layout=stereo:channels=FL[left]',
    '-map',
    '[left]',
    '-ar',
    '16000',
    '-ac',
    '1',
    systemPath,
  ]);

  // Extract channel 2 (microphone)
  await deps.execFile(ffmpegPath, [
    '-nostdin',
    '-y',
    '-i',
    audioPath,
    '-filter_complex',
    'channelsplit=channel_layout=stereo:channels=FR[right]',
    '-map',
    '[right]',
    '-ar',
    '16000',
    '-ac',
    '1',
    micPath,
  ]);

  return { system: systemPath, mic: micPath };
}

export async function convertToFlac(
  wavPath: string,
  deps: AudioProcessorDependencies = defaultDependencies()
): Promise<string> {
  const flacPath = wavPath.replace('.wav', '.flac');

  await deps.execFile(ffmpegPath, [
    '-nostdin',
    '-y',
    '-i',
    wavPath,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'flac',
    flacPath,
  ]);

  return flacPath;
}

export async function isChannelSilent(
  audioPath: string,
  deps: AudioProcessorDependencies = defaultDependencies()
): Promise<boolean> {
  const durationSeconds = await getAudioDuration(audioPath);

  const { stderr } = await deps.execFile(ffmpegPath, [
    '-nostdin',
    '-y',
    '-i',
    audioPath,
    '-af',
    'silencedetect=noise=-50dB:d=0.5',
    '-f',
    'null',
    '-',
  ]);

  return parseSilenceResult(stderr, durationSeconds);
}

export function parseSilenceResult(
  stderr: string,
  durationSeconds: number,
  toleranceSeconds = 0.1
): boolean {
  const starts: number[] = [];
  const ends: number[] = [];

  for (const match of stderr.matchAll(/silence_start:\s*([0-9.]+)/g)) {
    starts.push(parseFloat(match[1]));
  }
  for (const match of stderr.matchAll(/silence_end:\s*([0-9.]+)/g)) {
    ends.push(parseFloat(match[1]));
  }

  if (starts.length === 0 || ends.length === 0) {
    return false;
  }

  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    if (starts[i] <= toleranceSeconds && durationSeconds - ends[i] <= toleranceSeconds) {
      return true;
    }
  }

  return false;
}

export async function getAudioDuration(audioPath: string): Promise<number> {
  const fd = await fs.promises.open(audioPath, 'r');

  try {
    const stat = await fd.stat();
    const riffHeader = await readWavBytes(fd, 0, 12);
    if (
      riffHeader.toString('ascii', 0, 4) !== 'RIFF' ||
      riffHeader.toString('ascii', 8, 12) !== 'WAVE'
    ) {
      throw new Error('Invalid WAV file');
    }

    let byteRate: number | undefined;
    let dataSize: number | undefined;
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
        const format = await readWavBytes(fd, chunkDataOffset, 16);
        byteRate = format.readUInt32LE(8);
      } else if (chunkId === 'data') {
        dataSize = chunkSize;
      }

      if (byteRate !== undefined && dataSize !== undefined) {
        if (byteRate === 0) {
          throw new Error('Invalid WAV file: byte rate is zero');
        }
        return dataSize / byteRate;
      }

      offset = chunkDataOffset + chunkSize + (chunkSize % 2);
    }

    throw new Error('Invalid WAV file');
  } finally {
    await fd.close();
  }
}

async function readWavBytes(
  fd: fs.promises.FileHandle,
  position: number,
  length: number
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await fd.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new Error('Invalid WAV file');
  }
  return buffer;
}
