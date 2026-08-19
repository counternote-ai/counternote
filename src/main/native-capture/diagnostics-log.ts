import * as fs from 'fs';
import * as path from 'path';

export interface DiagnosticsLogLike {
  write(entry: Record<string, unknown>): void;
  close(): void;
}

/**
 * Append-only JSONL sink for capture diagnostics. Diagnostics are observability
 * only: every failure is swallowed so logging can never break capture. Lines
 * written before the file is open are buffered in memory (bounded by the
 * session's own rate limits upstream).
 */
export function createDiagnosticsLog(filePath: string): DiagnosticsLogLike {
  let stream: fs.WriteStream | undefined;
  let failed = false;
  let closed = false;
  const pending: string[] = [];

  fs.mkdir(path.dirname(filePath), { recursive: true }, (mkdirError) => {
    if (mkdirError || failed) {
      failed = true;
      pending.length = 0;
      return;
    }
    if (closed) return;
    const opened = fs.createWriteStream(filePath, { flags: 'a' });
    opened.on('error', () => {
      failed = true;
    });
    stream = opened;
    for (const line of pending) opened.write(line);
    pending.length = 0;
  });

  return {
    write(entry: Record<string, unknown>): void {
      if (failed || closed) return;
      let line: string;
      try {
        line = `${JSON.stringify(entry)}\n`;
      } catch {
        return;
      }
      if (stream) {
        stream.write(line);
      } else {
        pending.push(line);
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      pending.length = 0;
      if (stream && !failed) stream.end();
    },
  };
}
