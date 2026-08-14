import type { Readable } from 'stream';

export interface StderrDiagnostic {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly code: string;
}

const MAX_LINE_BYTES = 1_024;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;

const VALID_LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'warn', 'error']);
const VALID_CODES: ReadonlySet<string> = new Set([
  'helper-started',
  'source-restart-attempt',
  'source-restart-failed',
  'helper-stopping',
]);

export interface StderrDrainHandle {
  close(): void;
}

/**
 * Continuously drains helper stderr, validates allow-listed diagnostics,
 * rate-limits output, and never blocks capture. Synchronous listener
 * attachment ensures no stderr data is lost before `ready`.
 */
export function createStderrDrain(
  stderr: Readable,
  onDiagnostic: (diagnostic: StderrDiagnostic) => void,
  onSuppressed?: (count: number) => void,
): StderrDrainHandle {
  let partial = '';
  let disabled = false;
  const windowTimestamps: number[] = [];
  let suppressedEmitted = false;

  function processLine(line: string): void {
    if (line.length === 0) return;
    if (line.length > MAX_LINE_BYTES) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    if (!isPlainObject(parsed)) return;
    const keys = Object.keys(parsed);
    if (keys.length !== 2) return;
    if (!keys.includes('level') || !keys.includes('code')) return;

    const level = parsed.level as string;
    const code = parsed.code as string;
    if (!VALID_LEVELS.has(level)) return;
    if (!VALID_CODES.has(code)) return;

    const now = Date.now();
    while (windowTimestamps.length > 0 && windowTimestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
      windowTimestamps.shift();
      suppressedEmitted = false;
    }

    if (windowTimestamps.length >= RATE_LIMIT_MAX) {
      if (!suppressedEmitted) {
        suppressedEmitted = true;
        onSuppressed?.(1);
      }
      return;
    }

    windowTimestamps.push(now);
    onDiagnostic({ level: level as StderrDiagnostic['level'], code });
  }

  function handleData(chunk: Buffer): void {
    if (disabled) return;

    const text = partial + chunk.toString('utf8');
    const lines = text.split('\n');
    partial = lines.pop() ?? '';

    for (const line of lines) {
      processLine(line);
    }
  }

  function handleError(): void {
    disabled = true;
  }

  // Attach listeners synchronously — no tick gap before `ready`.
  stderr.on('data', handleData);
  stderr.on('error', handleError);

  return {
    close(): void {
      stderr.off('data', handleData);
      stderr.off('error', handleError);
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
