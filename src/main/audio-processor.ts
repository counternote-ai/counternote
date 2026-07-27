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
  deps: AudioProcessorDependencies = defaultDependencies()
): Promise<{ system: string; mic: string }> {
  const dir = path.dirname(audioPath);
  const systemPath = path.join(dir, 'channel-system.wav');
  const micPath = path.join(dir, 'channel-mic.wav');

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
  const buffer = Buffer.alloc(44);
  const fd = await fs.promises.open(audioPath, 'r');

  try {
    await fd.read(buffer, 0, 44, 0);
  } finally {
    await fd.close();
  }

  // WAV header fields (little-endian)
  // Bytes 22-23: Number of channels
  const channels = buffer.readUInt16LE(22);
  // Bytes 24-27: Sample rate
  const sampleRate = buffer.readUInt32LE(24);
  // Bytes 28-31: Byte rate (sampleRate * channels * bytesPerSample)
  const byteRate = buffer.readUInt32LE(28);
  // Bytes 40-43: Data chunk size
  const dataSize = buffer.readUInt32LE(40);

  if (byteRate === 0) {
    throw new Error(`Invalid WAV file: byte rate is zero in ${audioPath}`);
  }

  return dataSize / byteRate;
}
