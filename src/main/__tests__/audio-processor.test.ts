import {
  splitChannels,
  getAudioDuration,
  getAudibleIntervals,
  isChannelSilent,
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

  const writeWavHeader = (
    filePath: string,
    durationSeconds: number,
    sampleRate = 16000,
    channels = 2,
    bitsPerSample = 16,
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

  const writePcm16Wav = (
    filePath: string,
    channels: 1 | 2,
    frames: ReadonlyArray<ReadonlyArray<number>>,
  ): void => {
    const sampleRate = 16000;
    const bytesPerFrame = channels * 2;
    const data = Buffer.alloc(frames.length * bytesPerFrame);
    frames.forEach((frame, frameIndex) => {
      frame.forEach((sample, channelIndex) => {
        data.writeInt16LE(sample, frameIndex * bytesPerFrame + channelIndex * 2);
      });
    });

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(data.length + 36, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * bytesPerFrame, 28);
    header.writeUInt16LE(bytesPerFrame, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    fs.writeFileSync(filePath, Buffer.concat([header, data]));
  };

  const readMonoSamples = (filePath: string): number[] => {
    const wav = fs.readFileSync(filePath);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16);
    const samples: number[] = [];
    for (let offset = 44; offset < wav.length; offset += 2) {
      samples.push(wav.readInt16LE(offset));
    }
    return samples;
  };

  describe('splitChannels', () => {
    it('streams fixed capture PCM into matching mono channel WAVs', async () => {
      const audioPath = path.join(testDir, 'audio.wav');
      writePcm16Wav(audioPath, 2, [
        [1000, -1000],
        [2000, -2000],
        [3000, -3000],
      ]);

      const result = await splitChannels(audioPath);

      expect(readMonoSamples(result.system)).toEqual([1000, 2000, 3000]);
      expect(readMonoSamples(result.mic)).toEqual([-1000, -2000, -3000]);
    });

    it('preserves channel order across the streaming chunk boundary', async () => {
      const audioPath = path.join(testDir, 'large-audio.wav');
      const frames = Array.from({ length: 16_386 }, (_, index) => [index, -index]);
      writePcm16Wav(audioPath, 2, frames);

      const result = await splitChannels(audioPath);

      const system = readMonoSamples(result.system);
      const mic = readMonoSamples(result.mic);
      expect(system.slice(16_382)).toEqual([16_382, 16_383, 16_384, 16_385]);
      expect(mic.slice(16_382)).toEqual([-16_382, -16_383, -16_384, -16_385]);
    });

    it('rejects unsupported WAV input without publishing partial channel files', async () => {
      const audioPath = path.join(testDir, 'mono.wav');
      const systemPath = path.join(testDir, 'system.wav');
      const micPath = path.join(testDir, 'mic.wav');
      writePcm16Wav(audioPath, 1, [[1000], [2000]]);

      await expect(splitChannels(audioPath, { system: systemPath, mic: micPath })).rejects.toThrow(
        'Unsupported WAV format',
      );

      expect(fs.existsSync(systemPath)).toBe(false);
      expect(fs.existsSync(micPath)).toBe(false);
    });
  });

  describe('isChannelSilent', () => {
    it('returns true when silence covers the full track', async () => {
      const audioPath = path.join(testDir, 'silent.wav');
      writePcm16Wav(
        audioPath,
        1,
        Array.from({ length: 16000 }, () => [0]),
      );

      const result = await isChannelSilent(audioPath);

      expect(result).toBe(true);
    });

    it('returns false when any audible interval remains', async () => {
      const audioPath = path.join(testDir, 'noisy.wav');
      writePcm16Wav(
        audioPath,
        1,
        Array.from({ length: 16000 }, () => [1000]),
      );

      const result = await isChannelSilent(audioPath);

      expect(result).toBe(false);
    });

    it('treats samples at the -50 dB threshold as silent and the next sample as audible', async () => {
      const silentPath = path.join(testDir, 'threshold-silent.wav');
      const audiblePath = path.join(testDir, 'threshold-audible.wav');
      writePcm16Wav(
        silentPath,
        1,
        Array.from({ length: 4000 }, () => [103]),
      );
      writePcm16Wav(audiblePath, 1, [...Array.from({ length: 3999 }, () => [103]), [104]]);

      await expect(isChannelSilent(silentPath)).resolves.toBe(true);
      await expect(isChannelSilent(audiblePath)).resolves.toBe(false);
    });
  });

  describe('getAudibleIntervals', () => {
    it('treats an entirely silent short channel as empty audio', async () => {
      const audioPath = path.join(testDir, 'short-silent.wav');
      writePcm16Wav(
        audioPath,
        1,
        Array.from({ length: 4000 }, () => [0]),
      );

      await expect(getAudibleIntervals(audioPath)).resolves.toEqual([]);
    });

    it('returns audio between leading and trailing half-second silence', async () => {
      const audioPath = path.join(testDir, 'partly-silent.wav');
      writePcm16Wav(audioPath, 1, [
        ...Array.from({ length: 8000 }, () => [0]),
        ...Array.from({ length: 4000 }, () => [1000]),
        ...Array.from({ length: 8000 }, () => [0]),
      ]);

      await expect(getAudibleIntervals(audioPath)).resolves.toEqual([{ start: 0.5, end: 0.75 }]);
    });

    it('does not split an audible interval for silence shorter than half a second', async () => {
      const audioPath = path.join(testDir, 'short-silence.wav');
      writePcm16Wav(audioPath, 1, [
        ...Array.from({ length: 4000 }, () => [1000]),
        ...Array.from({ length: 7999 }, () => [0]),
        ...Array.from({ length: 4000 }, () => [1000]),
      ]);

      await expect(getAudibleIntervals(audioPath)).resolves.toEqual([
        { start: 0, end: 15999 / 16000 },
      ]);
    });
  });

  describe('getAudioDuration', () => {
    it('reports the fixed capture WAV byte rate without weakening RIFF validation', async () => {
      const testFile = path.join(testDir, 'fixed-capture.wav');
      writeWavHeader(testFile, 0.02);

      await expect(getAudioDuration(testFile)).resolves.toBeCloseTo(0.02, 10);
    });

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
