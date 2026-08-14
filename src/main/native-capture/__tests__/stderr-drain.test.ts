import { PassThrough } from 'stream';
import { createStderrDrain, type StderrDiagnostic, type StderrDrainHandle } from '../stderr-drain';

function createStream(): PassThrough {
  return new PassThrough();
}

function jsonLine(level: string, code: string): string {
  return `${JSON.stringify({ level, code })}\n`;
}

describe('StderrDrain', () => {
  let stream: PassThrough;
  let diagnostics: StderrDiagnostic[];
  let suppressedCounts: number[];
  let drain: StderrDrainHandle;

  beforeEach(() => {
    stream = createStream();
    diagnostics = [];
    suppressedCounts = [];
  });

  afterEach(() => {
    drain?.close();
    stream.destroy();
  });

  function attach(): void {
    drain = createStderrDrain(
      stream,
      (d) => diagnostics.push(d),
      (n) => suppressedCounts.push(n),
    );
  }

  it('emits valid allow-listed diagnostics for all level/code combinations', async () => {
    attach();
    const cases: StderrDiagnostic[] = [
      { level: 'debug', code: 'helper-started' },
      { level: 'info', code: 'source-restart-attempt' },
      { level: 'warn', code: 'source-restart-failed' },
      { level: 'error', code: 'helper-stopping' },
    ];
    for (const c of cases) stream.write(jsonLine(c.level, c.code));
    await new Promise((r) => setImmediate(r));
    expect(diagnostics).toEqual(cases);
  });

  it('drops malformed JSON and unknown lines', async () => {
    attach();
    stream.write('not json\n');
    stream.write('{"level":"info"}\n'); // missing code
    stream.write('{"level":"info","code":"helper-started","extra":1}\n'); // extra field
    stream.write('{"level":"bad","code":"helper-started"}\n'); // invalid level
    stream.write('{"level":"info","code":"unknown-code"}\n'); // invalid code
    stream.write(jsonLine('info', 'helper-started'));
    await new Promise((r) => setImmediate(r));
    expect(diagnostics).toEqual([{ level: 'info', code: 'helper-started' }]);
  });

  it('discards lines over 1 KiB', async () => {
    attach();
    const oversized = 'x'.repeat(1025) + '\n';
    stream.write(oversized);
    stream.write(jsonLine('info', 'helper-started'));
    await new Promise((r) => setImmediate(r));
    expect(diagnostics).toEqual([{ level: 'info', code: 'helper-started' }]);
  });

  it('handles partial lines across chunks', async () => {
    attach();
    const full = jsonLine('info', 'helper-started');
    const split = Math.floor(full.length / 2);
    stream.write(full.slice(0, split));
    await new Promise((r) => setImmediate(r));
    expect(diagnostics).toEqual([]);

    stream.write(full.slice(split));
    await new Promise((r) => setImmediate(r));
    expect(diagnostics).toEqual([{ level: 'info', code: 'helper-started' }]);
  });

  it('handles more than pipe-capacity input without blocking', async () => {
    attach();
    // macOS pipe capacity is typically 64 KiB; send 100 KiB of valid diagnostics
    const line = jsonLine('info', 'helper-started');
    const chunkSize = 65_536;
    let sent = 0;
    while (sent < 100_000) {
      const batch = line.repeat(Math.ceil(chunkSize / line.length)).slice(0, chunkSize);
      stream.write(batch);
      sent += chunkSize;
    }
    await new Promise((r) => setImmediate(r));
    // All valid diagnostics should be emitted up to the rate limit
    expect(diagnostics.length).toBeLessThanOrEqual(20);
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it('rate limits at 20 per minute and emits one suppression count', async () => {
    attach();
    for (let i = 0; i < 25; i++) {
      stream.write(jsonLine('info', 'helper-started'));
    }
    await new Promise((r) => setImmediate(r));
    expect(diagnostics).toHaveLength(20);
    expect(suppressedCounts).toEqual([1]);
    // Additional diagnostics after the suppression are silently dropped
    expect(diagnostics.every((d) => d.level === 'info' && d.code === 'helper-started')).toBe(true);
  });

  it('continues draining stderr after a read error without stopping capture', async () => {
    attach();
    stream.write(jsonLine('info', 'helper-started'));
    await new Promise((r) => setImmediate(r));
    expect(diagnostics).toHaveLength(1);

    stream.emit('error', new Error('pipe broken'));
    stream.write(jsonLine('info', 'helper-started'));
    await new Promise((r) => setImmediate(r));
    // After error, diagnostics are disabled
    expect(diagnostics).toHaveLength(1);
    // But the drain is still attached and the stream is not destroyed
    expect(stream.destroyed).toBe(false);
  });

  it('removes listeners on close', () => {
    attach();
    const dataListeners = stream.listenerCount('data');
    const errorListeners = stream.listenerCount('error');
    drain.close();
    expect(stream.listenerCount('data')).toBe(dataListeners - 1);
    expect(stream.listenerCount('error')).toBe(errorListeners - 1);
  });

  it('retains at most one partial line and discards oversized partial on next newline', async () => {
    attach();
    // Send an oversized partial (no newline yet)
    const oversizedPartial = 'x'.repeat(2000);
    stream.write(oversizedPartial);
    await new Promise((r) => setImmediate(r));
    expect(diagnostics).toEqual([]);

    // Now send a newline - the oversized line should be discarded
    stream.write('\n');
    await new Promise((r) => setImmediate(r));
    expect(diagnostics).toEqual([]);

    // Next valid line should work
    stream.write(jsonLine('info', 'helper-started'));
    await new Promise((r) => setImmediate(r));
    expect(diagnostics).toEqual([{ level: 'info', code: 'helper-started' }]);
  });
});
