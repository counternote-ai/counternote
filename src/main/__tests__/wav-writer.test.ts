import { WavWriter } from '../wav-writer';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('WavWriter', () => {
  const testDir = path.join(os.tmpdir(), 'wav-writer-test');
  const testFile = path.join(testDir, 'test.wav');

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should create a valid WAV file with correct header', () => {
    const writer = new WavWriter(testFile, 16000, 2);

    // Write some test PCM data
    const pcmData = Buffer.alloc(1000);
    writer.write(pcmData);

    return writer.close().then(() => {
      const buffer = fs.readFileSync(testFile);

      // Check RIFF header
      expect(buffer.toString('ascii', 0, 4)).toBe('RIFF');
      expect(buffer.toString('ascii', 8, 12)).toBe('WAVE');

      // Check fmt chunk
      expect(buffer.toString('ascii', 12, 16)).toBe('fmt ');
      expect(buffer.readUInt16LE(20)).toBe(1); // PCM format
      expect(buffer.readUInt16LE(22)).toBe(2); // 2 channels
      expect(buffer.readUInt32LE(24)).toBe(16000); // sample rate

      // Check data chunk
      expect(buffer.toString('ascii', 36, 40)).toBe('data');
      expect(buffer.readUInt32LE(40)).toBe(1000); // data size
    });
  });

  it('should write PCM data correctly', () => {
    const writer = new WavWriter(testFile, 44100, 1);

    // Create test PCM data (16-bit samples)
    const pcmData = Buffer.alloc(4); // 2 samples
    pcmData.writeInt16LE(1000, 0);
    pcmData.writeInt16LE(-1000, 2);

    writer.write(pcmData);

    return writer.close().then(() => {
      const buffer = fs.readFileSync(testFile);

      // Data starts at byte 44 (after header)
      expect(buffer.readInt16LE(44)).toBe(1000);
      expect(buffer.readInt16LE(46)).toBe(-1000);
    });
  });

  it('should update header with final data size on close', () => {
    const writer = new WavWriter(testFile, 16000, 2);

    // Write data in chunks
    writer.write(Buffer.alloc(500));
    writer.write(Buffer.alloc(300));

    return writer.close().then(() => {
      const buffer = fs.readFileSync(testFile);

      // Total data should be 800 bytes
      expect(buffer.readUInt32LE(40)).toBe(800);
      // File size should be 800 + 44 (header) = 844
      expect(buffer.readUInt32LE(4)).toBe(844 - 8); // RIFF size = file size - 8
    });
  });
});
