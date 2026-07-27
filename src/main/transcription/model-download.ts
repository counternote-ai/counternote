import * as fs from 'fs';
import { Readable } from 'stream';
import type { ReadableStream as NodeReadableStream } from 'stream/web';
import { pipeline } from 'stream/promises';

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
    const response = await fetch(source);

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

    let receivedBytes = 0;
    body.on('data', (chunk: Buffer) => {
      receivedBytes += chunk.length;
      onProgress(receivedBytes, totalBytes);
    });

    // pipeline destroys both streams when either side fails.
    await pipeline(body, file);
  }
}
