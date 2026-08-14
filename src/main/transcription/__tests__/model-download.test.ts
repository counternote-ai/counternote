import { HttpsModelDownloadTransport } from '../model-download';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('HttpsModelDownloadTransport', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('aborts a fetch that never produces a response', async () => {
    jest.useFakeTimers();
    let aborted = false;
    jest.spyOn(global, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          (init?.signal as AbortSignal | null)?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('request aborted'));
          });
        }),
    );
    const transport = new HttpsModelDownloadTransport(4);
    const download = transport.download(
      new URL('https://models.example.com/model.bin'),
      '/tmp/model.bin',
      jest.fn(),
    );
    const expectedFailure = expect(download).rejects.toThrow('model download timed out');

    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(aborted).toBe(true);
    await expectedFailure;
  });

  it('resets the inactivity watchdog when response headers arrive', async () => {
    jest.useFakeTimers();
    let aborted = false;
    let resolveFetch: ((response: Response) => void) | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    jest.spyOn(global, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise<Response>((resolve) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
          });
          resolveFetch = resolve;
        }),
    );
    const destination = path.join(os.tmpdir(), `model-download-${process.pid}-headers.bin`);
    const transport = new HttpsModelDownloadTransport(4);
    const download = transport.download(
      new URL('https://models.example.com/model.bin'),
      destination,
      jest.fn(),
    );
    void download.catch(() => undefined);

    try {
      await jest.advanceTimersByTimeAsync(4 * 60 * 1000);
      resolveFetch?.(new Response(body, { headers: { 'content-length': '4' } }));
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(2 * 60 * 1000);

      expect(aborted).toBe(false);

      streamController?.enqueue(new Uint8Array([1, 2, 3, 4]));
      streamController?.close();
      await expect(download).resolves.toBeUndefined();
    } finally {
      fs.rmSync(destination, { force: true });
    }
  });
});
