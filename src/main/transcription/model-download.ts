import * as fs from 'fs';
import { Readable } from 'stream';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import { pipeline } from 'stream/promises';

const MODEL_DOWNLOAD_INACTIVITY_MS = 5 * 60 * 1000;

export interface ModelDownloadTransport {
  download(
    source: URL,
    destination: string,
    onProgress: (receivedBytes: number, totalBytes: number) => void
  ): Promise<void>;
}

/**
 * Streams an artifact over HTTPS into a destination file.
 *
 * Error messages deliberately omit the URL, its query string, and every
 * header value: the pinned artifact URL carries a `?download=true` query and
 * upstream CDN redirects may attach signed parameters that must not be logged.
 */
export class HttpsModelDownloadTransport implements ModelDownloadTransport {
  constructor(private readonly expectedBytes: number) {}

  async download(
    source: URL,
    destination: string,
    onProgress: (receivedBytes: number, totalBytes: number) => void
  ): Promise<void> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const resetInactivityTimer = (): void => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => controller.abort(), MODEL_DOWNLOAD_INACTIVITY_MS);
    };

    resetInactivityTimer();

    try {
      const response = await fetch(source, { signal: controller.signal });
      resetInactivityTimer();

      if (!response.ok) {
        throw new Error(`model download failed with HTTP status ${response.status}`);
      }
      if (response.body === null) {
        throw new Error('model download failed: response had no body');
      }

      const contentLengthHeader = response.headers.get('content-length');
      const totalBytes = contentLengthHeader === null ? NaN : Number(contentLengthHeader);
      if (!Number.isFinite(totalBytes) || totalBytes !== this.expectedBytes) {
        throw new Error('model download failed: response size did not match the pinned artifact');
      }

      // Node's fetch body is a stream/web ReadableStream; the cast bridges the
      // DOM lib type with the one Readable.fromWeb expects.
      const body = Readable.fromWeb(response.body as unknown as NodeReadableStream);
      const file = fs.createWriteStream(destination);
      controller.signal.addEventListener(
        'abort',
        () => body.destroy(new Error('model download timed out')),
        { once: true }
      );

      let receivedBytes = 0;
      body.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        onProgress(receivedBytes, totalBytes);
        resetInactivityTimer();
      });

      // pipeline destroys both streams when either side fails.
      await pipeline(body, file);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('model download timed out');
      }
      throw error;
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }
}
