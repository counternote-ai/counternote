import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execFileAsync = promisify(execFile);

// Get ffmpeg path from ffmpeg-static
const ffmpegPath = require('ffmpeg-static');

export async function splitChannels(audioPath: string): Promise<{ system: string; mic: string }> {
  const dir = path.dirname(audioPath);
  const systemPath = path.join(dir, 'channel-system.wav');
  const micPath = path.join(dir, 'channel-mic.wav');

  // Extract channel 1 (system audio)
  await execFileAsync(ffmpegPath, [
    '-i', audioPath,
    '-filter_complex', 'channelsplit=channel_layout=stereo:channels=FL[left]',
    '-map', '[left]',
    '-ar', '16000',
    '-ac', '1',
    systemPath,
  ]);

  // Extract channel 2 (microphone)
  await execFileAsync(ffmpegPath, [
    '-i', audioPath,
    '-filter_complex', 'channelsplit=channel_layout=stereo:channels=FR[right]',
    '-map', '[right]',
    '-ar', '16000',
    '-ac', '1',
    micPath,
  ]);

  return { system: systemPath, mic: micPath };
}

export async function convertToFlac(wavPath: string): Promise<string> {
  const flacPath = wavPath.replace('.wav', '.flac');

  await execFileAsync(ffmpegPath, [
    '-i', wavPath,
    '-ar', '16000',
    '-ac', '1',
    '-c:a', 'flac',
    flacPath,
  ]);

  return flacPath;
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
