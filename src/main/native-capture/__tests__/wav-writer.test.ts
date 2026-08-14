import { EventEmitter } from 'events';
import * as fs from 'fs';
import { PCM_BLOCK_BYTES } from '../../../types/native-capture';
import { WavPersistenceError, WavWriter } from '../wav-writer';

jest.mock('fs', () => {
  const actual = jest.requireActual<typeof import('fs')>('fs');
  return {
    ...actual,
    createWriteStream: jest.fn(),
    promises: {
      ...actual.promises,
      open: jest.fn(),
    },
  };
});

class ControllableWritable extends EventEmitter {
  public readonly writes: Buffer[] = [];
  public readonly events: string[] = [];
  public writeResults: boolean[] = [];
  public finishAutomatically: boolean = true;

  public write(chunk: Buffer, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(Buffer.from(chunk));
    queueMicrotask(() => callback?.(null));
    return this.writeResults.shift() ?? true;
  }

  public end(): this {
    this.events.push('end');
    if (this.finishAutomatically) queueMicrotask(() => this.emitFinish());
    return this;
  }

  public destroy(): this {
    queueMicrotask(() => {
      this.events.push('close');
      this.emit('close');
    });
    return this;
  }

  public emitDrain(): void {
    this.emit('drain');
  }

  public emitFinish(): void {
    this.events.push('finish');
    this.emit('finish');
  }

  public emitFailure(code: string): void {
    this.emit('error', Object.assign(new Error('stream failed'), { code }));
  }
}

interface HeaderHandle {
  dataSize: number;
  writeResults: number[];
  write: jest.Mock<
    Promise<{ bytesWritten: number; buffer: Buffer }>,
    [Buffer, number, number, number]
  >;
  close: jest.Mock<Promise<void>, []>;
}

describe('native-capture WavWriter', () => {
  let stream: ControllableWritable;
  let header: HeaderHandle;
  let createWriteStream: jest.MockedFunction<typeof fs.createWriteStream>;
  let open: jest.MockedFunction<typeof fs.promises.open>;

  beforeEach(() => {
    stream = new ControllableWritable();
    header = {
      dataSize: 0,
      writeResults: [],
      write: jest.fn(async (buffer: Buffer, _offset: number, length: number, _position: number) => {
        header.dataSize = buffer.readUInt32LE(40);
        stream.events.push('header-updated');
        return { bytesWritten: header.writeResults.shift() ?? length, buffer };
      }),
      close: jest.fn(async () => {
        stream.events.push('closed');
      }),
    };
    createWriteStream = fs.createWriteStream as jest.MockedFunction<typeof fs.createWriteStream>;
    createWriteStream.mockReturnValue(stream as unknown as fs.WriteStream);
    open = fs.promises.open as jest.MockedFunction<typeof fs.promises.open>;
    open.mockResolvedValue(header as unknown as fs.promises.FileHandle);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('writes a provisional 16 kHz signed 16-bit stereo header', async () => {
    await WavWriter.open('/recordings/audio.wav');

    const wavHeader = stream.writes[0];
    expect(wavHeader).toHaveLength(44);
    expect(wavHeader.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wavHeader.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wavHeader.readUInt16LE(20)).toBe(1);
    expect(wavHeader.readUInt16LE(22)).toBe(2);
    expect(wavHeader.readUInt32LE(24)).toBe(16_000);
    expect(wavHeader.readUInt16LE(34)).toBe(16);
    expect(wavHeader.readUInt32LE(40)).toBe(0);
  });

  it('counts every accepted block once and reports backpressure', async () => {
    stream.writeResults = [true, true, false];
    const writer = await WavWriter.open('/recordings/audio.wav');

    expect(writer.writeBlock(Buffer.alloc(PCM_BLOCK_BYTES))).toBe(false);
    expect(writer.writeBlock(Buffer.alloc(PCM_BLOCK_BYTES))).toBe(true);

    stream.emitDrain();
    await expect(writer.finalize()).resolves.toEqual({ dataBytes: 2_560 });
    expect(header.dataSize).toBe(2_560);
  });

  it('settles waitForDrain only after drain', async () => {
    stream.writeResults = [true, false];
    const writer = await WavWriter.open('/recordings/audio.wav');
    writer.writeBlock(Buffer.alloc(PCM_BLOCK_BYTES));

    let settled = false;
    const waiting = writer.waitForDrain().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    stream.emitDrain();
    await waiting;
    expect(settled).toBe(true);
  });

  it('waits for finish before updating the header and shares concurrent finalization', async () => {
    stream.finishAutomatically = false;
    const writer = await WavWriter.open('/recordings/audio.wav');
    writer.writeBlock(Buffer.alloc(PCM_BLOCK_BYTES));
    writer.writeBlock(Buffer.alloc(PCM_BLOCK_BYTES));

    const first = writer.finalize();
    const second = writer.finalize();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(header.write).not.toHaveBeenCalled();

    stream.emitFinish();
    await expect(first).resolves.toEqual({ dataBytes: 2_560 });
    expect(stream.events).toEqual(['end', 'finish', 'header-updated', 'closed']);
  });

  it('aborts idempotently without finalizing or deleting the partial artifact', async () => {
    const writer = await WavWriter.open('/recordings/audio.wav');
    writer.writeBlock(Buffer.alloc(PCM_BLOCK_BYTES));
    const retainedWrites = stream.writes.map((write) => Buffer.from(write));

    const first = writer.abort();
    const second = writer.abort();
    expect(first).toBe(second);
    await expect(first).resolves.toBeUndefined();

    expect(stream.writes).toEqual(retainedWrites);
    expect(header.write).not.toHaveBeenCalled();
    expect(header.close).not.toHaveBeenCalled();
    await expect(writer.finalize()).rejects.toBeInstanceOf(WavPersistenceError);
  });

  it('closes a failed partial artifact without converting it into a finalized success', async () => {
    const writer = await WavWriter.open('/recordings/audio.wav');
    writer.writeBlock(Buffer.alloc(PCM_BLOCK_BYTES));
    stream.emitFailure('EIO');

    await expect(writer.abort()).resolves.toBeUndefined();
    expect(header.write).not.toHaveBeenCalled();
    expect(header.close).not.toHaveBeenCalled();
    await expect(writer.finalize()).rejects.toMatchObject({ category: 'io-finalization' });
  });

  it('aborts an in-progress finalization without updating the header or producing success', async () => {
    stream.finishAutomatically = false;
    const writer = await WavWriter.open('/recordings/audio.wav');
    writer.writeBlock(Buffer.alloc(PCM_BLOCK_BYTES));

    const finalizing = writer.finalize();
    await Promise.resolve();
    const firstAbort = writer.abort();
    const secondAbort = writer.abort();

    expect(firstAbort).toBe(secondAbort);
    await expect(firstAbort).resolves.toBeUndefined();
    await expect(finalizing).rejects.toMatchObject({ category: 'io-finalization' });
    expect(header.write).not.toHaveBeenCalled();
    expect(header.close).not.toHaveBeenCalled();
  });

  it('keeps an in-progress abort best-effort when finalization receives an error', async () => {
    stream.finishAutomatically = false;
    const writer = await WavWriter.open('/recordings/audio.wav');
    const finalizing = writer.finalize();
    await Promise.resolve();

    const aborting = writer.abort();
    stream.emitFailure('EIO');

    await expect(aborting).resolves.toBeUndefined();
    await expect(finalizing).rejects.toMatchObject({ category: 'io-finalization' });
    expect(header.write).not.toHaveBeenCalled();
  });

  it('rolls back a header write when abort arrives during asynchronous header update', async () => {
    let releaseHeaderWrite: (() => void) | undefined;
    let markHeaderWriteStarted: (() => void) | undefined;
    const headerWriteStarted = new Promise<void>((resolve) => {
      markHeaderWriteStarted = resolve;
    });
    const headerWriteReleased = new Promise<void>((resolve) => {
      releaseHeaderWrite = resolve;
    });
    header.write.mockImplementationOnce(
      async (buffer: Buffer, _offset: number, length: number, _position: number) => {
        markHeaderWriteStarted?.();
        await headerWriteReleased;
        header.dataSize = buffer.readUInt32LE(40);
        stream.events.push('header-updated');
        return { bytesWritten: length, buffer };
      },
    );
    const writer = await WavWriter.open('/recordings/audio.wav');
    writer.writeBlock(Buffer.alloc(PCM_BLOCK_BYTES));

    const finalizing = writer.finalize();
    await headerWriteStarted;
    const aborting = writer.abort();
    releaseHeaderWrite?.();

    await expect(aborting).resolves.toBeUndefined();
    await expect(finalizing).rejects.toMatchObject({ category: 'io-finalization' });
    expect(header.write).toHaveBeenCalledTimes(2);
    expect(header.dataSize).toBe(0);
  });

  it('rolls back the finalized header when abort arrives during header close', async () => {
    let releaseClose: (() => void) | undefined;
    let markCloseStarted: (() => void) | undefined;
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    const closeReleased = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    header.close.mockImplementationOnce(async () => {
      markCloseStarted?.();
      await closeReleased;
    });
    const writer = await WavWriter.open('/recordings/audio.wav');
    writer.writeBlock(Buffer.alloc(PCM_BLOCK_BYTES));

    const finalizing = writer.finalize();
    await closeStarted;
    const aborting = writer.abort();
    releaseClose?.();

    await expect(aborting).resolves.toBeUndefined();
    await expect(finalizing).rejects.toMatchObject({ category: 'io-finalization' });
    expect(header.write).toHaveBeenCalledTimes(2);
    expect(header.dataSize).toBe(0);
  });

  it('completes a partial header write before finalization succeeds', async () => {
    header.writeResults = [20, 24];
    const writer = await WavWriter.open('/recordings/audio.wav');
    writer.writeBlock(Buffer.alloc(PCM_BLOCK_BYTES));

    await expect(writer.finalize()).resolves.toEqual({ dataBytes: PCM_BLOCK_BYTES });
    expect(header.write).toHaveBeenCalledTimes(2);
    expect(header.write.mock.calls[0].slice(1)).toEqual([0, 44, 0]);
    expect(header.write.mock.calls[1].slice(1)).toEqual([20, 24, 20]);
    expect(header.dataSize).toBe(PCM_BLOCK_BYTES);
  });

  it.each([
    ['open', 'EACCES', 'access'],
    ['stream', 'ENOSPC', 'capacity'],
    ['flush', 'EIO', 'io-finalization'],
  ] as const)('rejects %s failures with the safe category', async (stage, code, category) => {
    if (stage === 'open') {
      const opening = WavWriter.open('/recordings/audio.wav');
      stream.emitFailure(code);
      await expect(opening).rejects.toMatchObject({ category });
      return;
    }

    const writer = await WavWriter.open('/recordings/audio.wav');
    if (stage === 'stream') {
      stream.writeResults = [false];
      writer.writeBlock(Buffer.alloc(PCM_BLOCK_BYTES));
      const waiting = writer.waitForDrain();
      stream.emitFailure(code);
      await expect(waiting).rejects.toMatchObject({ category });
      return;
    }

    stream.finishAutomatically = false;
    const finalizing = writer.finalize();
    stream.emitFailure(code);
    await expect(finalizing).rejects.toMatchObject({ category });
  });

  it.each([
    [
      'reopen',
      () => open.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' })),
      'access',
    ],
    [
      'header update',
      () => header.write.mockRejectedValueOnce(new Error('write failed')),
      'io-finalization',
    ],
    [
      'close',
      () => header.close.mockRejectedValueOnce(new Error('close failed')),
      'io-finalization',
    ],
  ] as const)('rejects %s failures with the safe category', async (_stage, prepare, category) => {
    const writer = await WavWriter.open('/recordings/audio.wav');
    prepare();

    await expect(writer.finalize()).rejects.toMatchObject({ category });
  });

  it('rejects malformed blocks and writes after finalization begins', async () => {
    const writer = await WavWriter.open('/recordings/audio.wav');

    expect(() => writer.writeBlock(Buffer.alloc(PCM_BLOCK_BYTES - 1))).toThrow(WavPersistenceError);
    const finalizing = writer.finalize();
    expect(() => writer.writeBlock(Buffer.alloc(PCM_BLOCK_BYTES))).toThrow(WavPersistenceError);
    await finalizing;
  });
});
