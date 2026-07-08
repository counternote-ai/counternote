import { getAudioDuration } from '../audio-processor';
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
