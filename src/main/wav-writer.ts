import * as fs from 'fs';

export class WavWriter {
  private stream: fs.WriteStream;
  private dataSize: number = 0;
  private readonly sampleRate: number;
  private readonly channels: number;

  constructor(filePath: string, sampleRate: number = 16000, channels: number = 2) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.stream = fs.createWriteStream(filePath);

    // Write WAV header (will be updated on close)
    this.writeHeader(0);
  }

  write(pcmData: Buffer): void {
    this.stream.write(pcmData);
    this.dataSize += pcmData.length;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Update header with final size
      this.stream.end(() => {
        // Re-open file to update header
        const fd = fs.openSync(this.stream.path as string, 'r+');
        const header = this.createHeader(this.dataSize);
        fs.writeSync(fd, header, 0, header.length, 0);
        fs.closeSync(fd);
        resolve();
      });
    });
  }

  private writeHeader(dataSize: number): void {
    const header = this.createHeader(dataSize);
    this.stream.write(header);
  }

  private createHeader(dataSize: number): Buffer {
    const header = Buffer.alloc(44);
    const bitsPerSample = 16;
    const byteRate = this.sampleRate * this.channels * (bitsPerSample / 8);
    const blockAlign = this.channels * (bitsPerSample / 8);

    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);

    // fmt chunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // chunk size
    header.writeUInt16LE(1, 20); // PCM format
    header.writeUInt16LE(this.channels, 22);
    header.writeUInt32LE(this.sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);

    // data chunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return header;
  }
}
