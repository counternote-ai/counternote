import * as fs from 'fs';
import { MAX_BLOCKS, PCM_BLOCK_BYTES } from '../../types/native-capture';

export type PersistenceFailureCategory = 'capacity' | 'access' | 'io-finalization';

export class WavPersistenceError extends Error {
  public constructor(public readonly category: PersistenceFailureCategory) {
    super('WAV persistence failed');
    this.name = 'WavPersistenceError';
  }
}

export interface FinalizedWav {
  dataBytes: number;
}

const WAV_HEADER_BYTES = 44;
const SAMPLE_RATE_HZ = 16_000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const MAX_DATA_BYTES = MAX_BLOCKS * PCM_BLOCK_BYTES;
const ACCESS_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);
const CAPACITY_ERROR_CODES = new Set(['ENOSPC', 'EDQUOT']);

/** Persists validated native-capture PCM blocks without publishing the recording. */
export class WavWriter {
  private readonly stream: fs.WriteStream;
  private dataBytes: number = 0;
  private failure: WavPersistenceError | null = null;
  private drainPromise: Promise<void> | null = null;
  private finalizationPromise: Promise<FinalizedWav> | null = null;
  private abortPromise: Promise<void> | null = null;
  private finalizationStarted: boolean = false;
  private abortRequested: boolean = false;

  private constructor(
    private readonly filePath: string,
    stream: fs.WriteStream,
  ) {
    this.stream = stream;
    this.stream.on('error', this.handleStreamError);
  }

  public static async open(filePath: string): Promise<WavWriter> {
    let stream: fs.WriteStream;
    try {
      stream = fs.createWriteStream(filePath);
    } catch (error) {
      throw WavWriter.asPersistenceError(error);
    }

    const writer = new WavWriter(filePath, stream);
    try {
      await writer.writeProvisionalHeader();
      return writer;
    } catch (error) {
      stream.destroy();
      throw writer.asKnownFailure(error);
    }
  }

  /** Returns true when the caller must pause protocol consumption for drain. */
  public writeBlock(block: Buffer): boolean {
    this.throwIfUnavailable();
    if (block.length !== PCM_BLOCK_BYTES) {
      throw new WavPersistenceError('io-finalization');
    }
    if (this.dataBytes + block.length > MAX_DATA_BYTES) {
      throw new WavPersistenceError('capacity');
    }

    let accepted: boolean;
    try {
      accepted = this.stream.write(block);
    } catch (error) {
      throw this.fail(error);
    }

    this.dataBytes += block.length;
    if (!accepted) this.beginBackpressure();
    return !accepted;
  }

  public waitForDrain(): Promise<void> {
    if (this.failure !== null) return Promise.reject(this.failure);
    return this.drainPromise ?? Promise.resolve();
  }

  public finalize(): Promise<FinalizedWav> {
    if (this.finalizationPromise !== null) return this.finalizationPromise;
    if (this.abortPromise !== null) {
      return Promise.reject(new WavPersistenceError('io-finalization'));
    }

    this.finalizationStarted = true;
    this.finalizationPromise = this.finalizeInternal();
    return this.finalizationPromise;
  }

  /** Closes the provisional stream without modifying its header or deleting files. */
  public abort(): Promise<void> {
    if (this.abortPromise !== null) return this.abortPromise;

    this.finalizationStarted = true;
    this.abortRequested = true;
    const closeStream = this.closeStreamBestEffort();
    this.abortPromise = this.finalizationPromise === null
      ? closeStream
      : Promise.all([closeStream, this.finalizationPromise.catch(() => undefined)]).then(() => undefined);
    return this.abortPromise;
  }

  private closeStreamBestEffort(): Promise<void> {
    if (this.stream.closed) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const close = (): void => {
        cleanup();
        resolve();
      };
      const error = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        this.stream.off('close', close);
        this.stream.off('error', error);
      };

      this.stream.once('close', close);
      this.stream.once('error', error);
      try {
        this.stream.destroy();
      } catch (reason) {
        this.fail(reason);
        cleanup();
        resolve();
      }
    });
  }

  private async finalizeInternal(): Promise<FinalizedWav> {
    this.throwIfFailed();
    this.throwIfAborted();
    await this.waitForDrain();
    this.throwIfFailed();
    this.throwIfAborted();
    await this.finishStream();
    this.throwIfFailed();
    this.throwIfAborted();
    await this.updateHeader();
    this.throwIfFailed();
    this.throwIfAborted();
    return { dataBytes: this.dataBytes };
  }

  private writeProvisionalHeader(): Promise<void> {
    const header = this.createHeader(0);
    return new Promise<void>((resolve, reject) => {
      const error = (reason: Error): void => {
        cleanup();
        reject(this.fail(reason));
      };
      const written = (reason?: Error | null): void => {
        cleanup();
        if (reason) {
          reject(this.fail(reason));
          return;
        }
        if (this.failure !== null) {
          reject(this.failure);
          return;
        }
        resolve();
      };
      const cleanup = (): void => {
        this.stream.off('error', error);
      };

      this.stream.once('error', error);
      try {
        this.stream.write(header, written);
      } catch (reason) {
        cleanup();
        reject(this.fail(reason));
      }
    });
  }

  private beginBackpressure(): void {
    if (this.drainPromise !== null) return;

    this.drainPromise = new Promise<void>((resolve, reject) => {
      const drain = (): void => {
        cleanup();
        this.drainPromise = null;
        resolve();
      };
      const error = (reason: Error): void => {
        cleanup();
        reject(this.fail(reason));
      };
      const cleanup = (): void => {
        this.stream.off('drain', drain);
        this.stream.off('error', error);
      };

      this.stream.once('drain', drain);
      this.stream.once('error', error);
    });
  }

  private finishStream(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        cleanup();
        resolve();
      };
      const error = (reason: Error): void => {
        cleanup();
        reject(this.fail(reason));
      };
      const close = (): void => {
        cleanup();
        reject(new WavPersistenceError('io-finalization'));
      };
      const cleanup = (): void => {
        this.stream.off('finish', finish);
        this.stream.off('error', error);
        this.stream.off('close', close);
      };

      this.stream.once('finish', finish);
      this.stream.once('error', error);
      this.stream.once('close', close);
      try {
        this.stream.end();
      } catch (reason) {
        cleanup();
        reject(this.fail(reason));
      }
    });
  }

  private async updateHeader(): Promise<void> {
    let handle: fs.promises.FileHandle | null = null;
    let failure: WavPersistenceError | null = null;
    let headerWriteStarted = false;

    try {
      this.throwIfAborted();
      handle = await fs.promises.open(this.filePath, 'r+');
      this.throwIfAborted();
      headerWriteStarted = true;
      await this.writeCompleteHeader(handle, this.createHeader(this.dataBytes));
      this.throwIfAborted();
      await handle.close();
      handle = null;
      this.throwIfAborted();
    } catch (error) {
      failure = this.fail(error);
    } finally {
      if (failure !== null && headerWriteStarted) {
        try {
          await this.restoreProvisionalHeader();
        } catch (error) {
          failure ??= this.fail(error);
        }
      }
      if (handle !== null) {
        try {
          await handle.close();
        } catch (error) {
          failure ??= this.fail(error);
        }
      }
    }

    if (failure !== null) throw failure;
  }

  private async restoreProvisionalHeader(): Promise<void> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(this.filePath, 'r+');
      await this.writeCompleteHeader(handle, this.createHeader(0), false);
    } finally {
      if (handle !== null) await handle.close();
    }
  }

  private async writeCompleteHeader(
    handle: fs.promises.FileHandle,
    header: Buffer,
    stopOnAbort: boolean = true,
  ): Promise<void> {
    let offset = 0;
    while (offset < header.length) {
      if (stopOnAbort) this.throwIfAborted();
      const remaining = header.length - offset;
      const { bytesWritten } = await handle.write(header, offset, remaining, offset);
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
        throw new WavPersistenceError('io-finalization');
      }
      if (stopOnAbort) this.throwIfAborted();
      offset += bytesWritten;
    }
  }

  private throwIfUnavailable(): void {
    this.throwIfFailed();
    if (this.finalizationStarted) throw new WavPersistenceError('io-finalization');
  }

  private throwIfFailed(): void {
    if (this.failure !== null) throw this.failure;
  }

  private throwIfAborted(): void {
    if (this.abortRequested) throw new WavPersistenceError('io-finalization');
  }

  private handleStreamError = (error: Error): void => {
    this.fail(error);
  };

  private fail(error: unknown): WavPersistenceError {
    if (this.failure === null) this.failure = WavWriter.asPersistenceError(error);
    return this.failure;
  }

  private asKnownFailure(error: unknown): WavPersistenceError {
    return error instanceof WavPersistenceError ? error : this.fail(error);
  }

  private static asPersistenceError(error: unknown): WavPersistenceError {
    if (error instanceof WavPersistenceError) return error;
    const code = WavWriter.errorCode(error);
    if (code !== null && CAPACITY_ERROR_CODES.has(code)) return new WavPersistenceError('capacity');
    if (code !== null && ACCESS_ERROR_CODES.has(code)) return new WavPersistenceError('access');
    return new WavPersistenceError('io-finalization');
  }

  private static errorCode(error: unknown): string | null {
    if (typeof error !== 'object' || error === null || !('code' in error)) return null;
    const { code } = error as { code: unknown };
    return typeof code === 'string' ? code : null;
  }

  private createHeader(dataBytes: number): Buffer {
    const header = Buffer.alloc(WAV_HEADER_BYTES);
    const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);
    const byteRate = SAMPLE_RATE_HZ * blockAlign;

    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(CHANNELS, 22);
    header.writeUInt32LE(SAMPLE_RATE_HZ, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(BITS_PER_SAMPLE, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(dataBytes, 40);
    return header;
  }
}
