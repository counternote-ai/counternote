import {
  splitChannels,
  convertToFlac,
  getAudioDuration,
  isChannelSilent,
  parseSilenceResult,
  AudioProcessorDependencies,
} from '../audio-processor';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('AudioProcessor', () => {
  const testDir = path.join(os.tmpdir(), 'audio-processor-test');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const createMockExecFile = (
    stderr = '',
    stdout = ''
  ): jest.MockedFunction<AudioProcessorDependencies['execFile']> =>
    jest.fn().mockResolvedValue({ stdout, stderr });

  const writeWavHeader = (
    filePath: string,
    durationSeconds: number,
    sampleRate = 16000,
    channels = 2,
    bitsPerSample = 16
  ): void => {
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const dataSize = Math.floor(durationSeconds * byteRate);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(dataSize + 36, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM format
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    fs.writeFileSync(filePath, Buffer.concat([header, Buffer.alloc(dataSize)]));
  };

  describe('splitChannels', () => {
    it('adds non-interactive flags before input', async () => {
      const execFile = createMockExecFile();
      const audioPath = path.join(testDir, 'audio.wav');
      writeWavHeader(audioPath, 1);

      await splitChannels(audioPath, { execFile });

      expect(execFile).toHaveBeenCalledTimes(2);
      expect(execFile.mock.calls[0][1].slice(0, 4)).toEqual([
        '-nostdin',
        '-y',
        '-i',
        audioPath,
      ]);
      expect(execFile.mock.calls[1][1].slice(0, 4)).toEqual([
        '-nostdin',
        '-y',
        '-i',
        audioPath,
      ]);
    });
  });

  describe('convertToFlac', () => {
    it('adds non-interactive flags before input', async () => {
      const execFile = createMockExecFile();
      const wavPath = path.join(testDir, 'channel.wav');
      writeWavHeader(wavPath, 1, 16000, 1);

      await convertToFlac(wavPath, { execFile });

      expect(execFile).toHaveBeenCalledTimes(1);
      expect(execFile.mock.calls[0][1].slice(0, 4)).toEqual([
        '-nostdin',
        '-y',
        '-i',
        wavPath,
      ]);
    });
  });

  describe('parseSilenceResult', () => {
    it('detects full-duration silence', () => {
      expect(parseSilenceResult('silence_start: 0\nsilence_end: 60.0', 60)).toBe(true);
    });

    it('rejects partial silence', () => {
      expect(parseSilenceResult('silence_start: 0\nsilence_end: 2.0', 60)).toBe(false);
    });

    it('rejects missing silence markers', () => {
      expect(parseSilenceResult('', 60)).toBe(false);
    });

    it('rejects silence that does not start near zero', () => {
      expect(parseSilenceResult('silence_start: 0.2\nsilence_end: 60.0', 60)).toBe(false);
    });

    it('rejects silence that does not reach the end', () => {
      expect(parseSilenceResult('silence_start: 0\nsilence_end: 59.89', 60)).toBe(false);
    });
  });

  describe('isChannelSilent', () => {
    it('runs silencedetect and returns true when silence covers the full track', async () => {
      const execFile = createMockExecFile('silence_start: 0\nsilence_end: 2.0');
      const audioPath = path.join(testDir, 'silent.wav');
      writeWavHeader(audioPath, 2, 16000, 1);

      const result = await isChannelSilent(audioPath, { execFile });

      expect(result).toBe(true);
      expect(execFile).toHaveBeenCalledWith('/usr/local/bin/ffmpeg', [
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
    });

    it('returns false when silence does not cover the full track', async () => {
      const execFile = createMockExecFile('silence_start: 0\nsilence_end: 1.0');
      const audioPath = path.join(testDir, 'noisy.wav');
      writeWavHeader(audioPath, 2, 16000, 1);

      const result = await isChannelSilent(audioPath, { execFile });

      expect(result).toBe(false);
    });
  });

  describe('getAudioDuration', () => {
    it('should calculate duration from WAV header correctly', async () => {
      const testFile = path.join(testDir, 'test.wav');

      // Create a minimal WAV file with known duration
      // 16kHz sample rate, 2 channels, 16-bit = 64000 bytes/sec
      // 32000 bytes = 0.5 seconds
      const header = Buffer.alloc(44);
      header.write('RIFF', 0);
      header.writeUInt32LE(32036, 4); // file size - 8
      header.write('WAVE', 8);
      header.write('fmt ', 12);
      header.writeUInt32LE(16, 16); // chunk size
      header.writeUInt16LE(1, 20); // PCM format
      header.writeUInt16LE(2, 22); // 2 channels
      header.writeUInt32LE(16000, 24); // sample rate
      header.writeUInt32LE(64000, 28); // byte rate
      header.writeUInt16LE(4, 32); // block align
      header.writeUInt16LE(16, 34); // bits per sample
      header.write('data', 36);
      header.writeUInt32LE(32000, 40); // data size

      const data = Buffer.alloc(32000);
      const wavFile = Buffer.concat([header, data]);

      fs.writeFileSync(testFile, wavFile);

      const duration = await getAudioDuration(testFile);

      // 32000 bytes / 64000 bytes per sec = 0.5 sec
      expect(duration).toBeCloseTo(0.5, 1);
    });

    it('should handle different sample rates', async () => {
      const testFile = path.join(testDir, 'test-44100.wav');

      // 44.1kHz, 2 channels, 16-bit = 176400 bytes/sec
      // 176400 bytes = 1 second
      const header = Buffer.alloc(44);
      header.write('RIFF', 0);
      header.writeUInt32LE(176436, 4);
      header.write('WAVE', 8);
      header.write('fmt ', 12);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(2, 22);
      header.writeUInt32LE(44100, 24);
      header.writeUInt32LE(176400, 28);
      header.writeUInt16LE(4, 32);
      header.writeUInt16LE(16, 34);
      header.write('data', 36);
      header.writeUInt32LE(176400, 40);

      const data = Buffer.alloc(176400);
      const wavFile = Buffer.concat([header, data]);

      fs.writeFileSync(testFile, wavFile);

      const duration = await getAudioDuration(testFile);
      expect(duration).toBeCloseTo(1.0, 1);
    });

    it('reads duration when metadata appears before the data chunk', async () => {
      const testFile = path.join(testDir, 'ffmpeg-style.wav');
      const byteRate = 32000;
      const dataSize = byteRate;

      const riffHeader = Buffer.alloc(12);
      riffHeader.write('RIFF', 0);
      riffHeader.write('WAVE', 8);

      const formatChunk = Buffer.alloc(24);
      formatChunk.write('fmt ', 0);
      formatChunk.writeUInt32LE(16, 4);
      formatChunk.writeUInt16LE(1, 8);
      formatChunk.writeUInt16LE(1, 10);
      formatChunk.writeUInt32LE(16000, 12);
      formatChunk.writeUInt32LE(byteRate, 16);
      formatChunk.writeUInt16LE(2, 20);
      formatChunk.writeUInt16LE(16, 22);

      const metadata = Buffer.from('INFOISFTLavf');
      const metadataChunk = Buffer.alloc(8 + metadata.length + (metadata.length % 2));
      metadataChunk.write('LIST', 0);
      metadataChunk.writeUInt32LE(metadata.length, 4);
      metadata.copy(metadataChunk, 8);

      const dataChunkHeader = Buffer.alloc(8);
      dataChunkHeader.write('data', 0);
      dataChunkHeader.writeUInt32LE(dataSize, 4);
      const wavFile = Buffer.concat([
        riffHeader,
        formatChunk,
        metadataChunk,
        dataChunkHeader,
        Buffer.alloc(dataSize),
      ]);
      wavFile.writeUInt32LE(wavFile.length - 8, 4);
      fs.writeFileSync(testFile, wavFile);

      await expect(getAudioDuration(testFile)).resolves.toBeCloseTo(1, 5);
    });

    it('should throw error for invalid WAV file', async () => {
      const testFile = path.join(testDir, 'invalid.wav');

      // Write a file with zero byte rate
      const header = Buffer.alloc(44);
      header.write('RIFF', 0);
      header.write('WAVE', 8);
      header.write('fmt ', 12);
      header.writeUInt32LE(0, 28); // byte rate = 0

      fs.writeFileSync(testFile, header);

      await expect(getAudioDuration(testFile)).rejects.toThrow('Invalid WAV file');
    });
  });
});
