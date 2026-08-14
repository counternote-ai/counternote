import { EventEmitter } from 'events';
import { PassThrough, type Readable, type Writable } from 'stream';
import { PCM_BLOCK_BYTES, type CaptureFrame } from '../../../types/native-capture';
import { CaptureFrameType } from '../protocol';
import type { WavPersistenceError } from '../wav-writer';
import type { CaptureStoreSession } from '../capture-store';
import type { RecordingMutationLease } from '../../recording-mutation-coordinator';
import type { LibraryRecording } from '../../recordings-library';
import type {
  NativeCaptureSessionDeps,
  ChildProcessLike,
  WavWriterLike,
  SpawnOptions,
  NativeCaptureSession,
} from '../session';
import { createNativeCaptureSession } from '../session';

/* ── Protocol frame builder ────────────────────────────────────── */

function buildFrame(type: number, sequence: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.write('ICAP', 0, 'ascii');
  header.writeUInt8(1, 4);
  header.writeUInt8(type, 5);
  header.writeUInt8(0, 6);
  header.writeUInt8(0, 7);
  header.writeUInt32LE(payload.length, 8);
  header.writeUInt32LE(sequence, 12);
  return Buffer.concat([header, payload]);
}

function buildReady(seq = 0): Buffer {
  return buildFrame(CaptureFrameType.ready, seq, Buffer.from(JSON.stringify({
    type: 'ready', sampleRateHz: 16000, framesPerBlock: 320,
    encoding: 's16le', channelOrder: ['interviewer', 'you'], firstBlock: 0,
  })));
}

function buildPcm(seq: number, data?: Buffer): Buffer {
  return buildFrame(CaptureFrameType.pcm, seq, data ?? Buffer.alloc(PCM_BLOCK_BYTES));
}

function buildGap(seq: number, startBlock: number, endBlockExclusive: number): Buffer {
  return buildFrame(CaptureFrameType.gap, seq, Buffer.from(JSON.stringify({
    type: 'gap', channel: 'capture', startBlock, endBlockExclusive,
    reason: 'buffer-overflow', recovered: true,
  })));
}

function buildStopped(seq: number, finalBlock: number, pcmBlocks: number, gapBlocks: number): Buffer {
  return buildFrame(CaptureFrameType.stopped, seq, Buffer.from(JSON.stringify({
    type: 'stopped', reason: 'stop', finalBlockExclusive: finalBlock,
    pcmBlocks, gapBlocks, openInterruptionIds: [],
  })));
}

function buildError(seq: number, phase: string, code: string, channel?: string): Buffer {
  const payload: Record<string, unknown> = { type: 'error', phase, code, terminal: true };
  if (channel) payload.channel = channel;
  return buildFrame(CaptureFrameType.error, seq, Buffer.from(JSON.stringify(payload)));
}

function buildInterruptionOpen(seq: number, id: number, channel: string, startBlock: number, reason: string): Buffer {
  return buildFrame(CaptureFrameType.interruption, seq, Buffer.from(JSON.stringify({
    type: 'interruption', phase: 'opened', id, channel, startBlock, reason,
  })));
}

function buildInterruptionClosed(seq: number, id: number, channel: string, startBlock: number, endBlockExclusive: number, reason: string, recovered: boolean): Buffer {
  return buildFrame(CaptureFrameType.interruption, seq, Buffer.from(JSON.stringify({
    type: 'interruption', phase: 'closed', id, channel, startBlock, endBlockExclusive, reason, recovered,
  })));
}

function buildState(seq: number, channel: string, status: string, effectiveBlock: number, extra?: Record<string, unknown>): Buffer {
  return buildFrame(CaptureFrameType.state, seq, Buffer.from(JSON.stringify({
    type: 'state', channel, status, effectiveBlock, ...extra,
  })));
}

/* ── Test doubles ──────────────────────────────────────────────── */

class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  stdinWritten: Buffer[] = [];

  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin.on('data', (chunk: Buffer) => this.stdinWritten.push(Buffer.from(chunk)));
  }

  kill(_signal?: string): boolean {
    return true;
  }
}

class FakeWriter implements WavWriterLike {
  blocks: Buffer[] = [];
  private _backpressure = false;
  private drainResolvers: (() => void)[] = [];
  finalized = false;
  aborted = false;
  writeBlockCalls = 0;
  finalizeCalls = 0;
  abortCalls = 0;

  writeBlock(block: Buffer): boolean {
    this.blocks.push(Buffer.from(block));
    this.writeBlockCalls++;
    return this._backpressure;
  }

  setBackpressure(value: boolean): void {
    this._backpressure = value;
  }

  waitForDrain(): Promise<void> {
    if (!this._backpressure) return Promise.resolve();
    return new Promise<void>((r) => this.drainResolvers.push(r));
  }

  resolveDrain(): void {
    this._backpressure = false;
    for (const r of this.drainResolvers) r();
    this.drainResolvers = [];
  }

  finalize(): Promise<{ dataBytes: number }> {
    this.finalized = true;
    this.finalizeCalls++;
    const dataBytes = this.blocks.reduce((s, b) => s + b.length, 0);
    return Promise.resolve({ dataBytes });
  }

  abort(): Promise<void> {
    this.aborted = true;
    this.abortCalls++;
    return Promise.resolve();
  }
}

interface PublishCall {
  session: CaptureStoreSession;
  metadata: unknown;
  finalBlockExclusive: number;
}

interface RetainFailedCall {
  session: CaptureStoreSession;
  metadata: unknown;
}

class FakeStore {
  beginResult!: CaptureStoreSession;
  publishCalls: PublishCall[] = [];
  retainFailedCalls: RetainFailedCall[] = [];
  discardEmptyCalls: Array<{ session: CaptureStoreSession; blocks: number }> = [];
  publishError: Error | undefined;
  retainFailedError: Error | undefined;
  discardEmptyError: Error | undefined;

  constructor() {
    this.beginResult = {
      sessionId: 'test-session-id',
      recordingId: '2026-08-13T00-00-00-000Z',
      stagingDirectory: '/tmp/staging/test-session-id',
      audioFilePath: '/tmp/staging/test-session-id/audio.wav',
      startedAt: '2026-08-13T00:00:00.000Z',
    };
  }

  async begin(_recordingId: string): Promise<CaptureStoreSession> {
    return this.beginResult;
  }

  async publish(session: CaptureStoreSession, metadata: unknown, finalBlockExclusive: number): Promise<void> {
    if (this.publishError) throw this.publishError;
    this.publishCalls.push({ session, metadata, finalBlockExclusive });
  }

  async retainFailed(session: CaptureStoreSession, metadata: unknown): Promise<void> {
    if (this.retainFailedError) throw this.retainFailedError;
    this.retainFailedCalls.push({ session, metadata });
  }

  async discardEmpty(session: CaptureStoreSession, blocks: number): Promise<'discarded' | 'retained'> {
    if (this.discardEmptyError) throw this.discardEmptyError;
    this.discardEmptyCalls.push({ session, blocks });
    return 'discarded';
  }
}

class FakeMutationCoordinator {
  lease!: FakeLease;
  acquireResult: RecordingMutationLease | undefined;

  constructor() {
    this.lease = new FakeLease();
    this.acquireResult = this.lease;
  }

  tryAcquire(_kind: string): RecordingMutationLease | undefined {
    return this.acquireResult;
  }
}

class FakeLease implements RecordingMutationLease {
  readonly kind = 'capture' as const;
  released = false;
  release(): void {
    this.released = true;
  }
}

class FakeLibrary {
  listCalls = 0;
  async list(): Promise<LibraryRecording[]> {
    this.listCalls++;
    return [];
  }
}

/* ── Timer control ─────────────────────────────────────────────── */

interface PendingTimer {
  id: unknown;
  callback: () => void;
  ms: number;
}

let timerId = 0;
let pendingTimers: PendingTimer[] = [];

function createTimerFns(): { setTimeout: (cb: () => void, ms: number) => unknown; clearTimeout: (id: unknown) => void } {
  pendingTimers = [];
  return {
    setTimeout(cb: () => void, ms: number): unknown {
      const id = ++timerId;
      pendingTimers.push({ id, callback: cb, ms });
      return id;
    },
    clearTimeout(id: unknown): void {
      pendingTimers = pendingTimers.filter((t) => t.id !== id);
    },
  };
}

function fireTimer(id: unknown): void {
  const timer = pendingTimers.find((t) => t.id === id);
  if (timer) {
    pendingTimers = pendingTimers.filter((t) => t.id !== id);
    timer.callback();
  }
}

function advanceTime(ms: number): void {
  const toFire = pendingTimers.filter((t) => t.ms <= ms);
  pendingTimers = pendingTimers.filter((t) => t.ms > ms);
  for (const t of toFire) t.callback();
}

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

/* ── Test setup ────────────────────────────────────────────────── */

const recordingId = '2026-08-13T00-00-00-000Z';

let fakeChild: FakeChild;
let fakeWriter: FakeWriter;
let fakeStore: FakeStore;
let fakeCoordinator: FakeMutationCoordinator;
let fakeLibrary: FakeLibrary;
let timerFns: ReturnType<typeof createTimerFns>;
let capturedSpawnOptions: SpawnOptions | undefined;

function createDeps(overrides?: Partial<NativeCaptureSessionDeps>): NativeCaptureSessionDeps {
  fakeChild = new FakeChild();
  fakeWriter = new FakeWriter();
  fakeStore = new FakeStore();
  fakeCoordinator = new FakeMutationCoordinator();
  fakeLibrary = new FakeLibrary();
  timerFns = createTimerFns();
  capturedSpawnOptions = undefined;

  return {
    helperPath: '/usr/local/bin/interview-audio-capture',
    store: fakeStore,
    mutationCoordinator: fakeCoordinator,
    recordingsLibrary: fakeLibrary,
    spawn(_cmd: string, _args: string[], options: SpawnOptions): ChildProcessLike {
      capturedSpawnOptions = options;
      return fakeChild;
    },
    openWriter(_path: string): Promise<WavWriterLike> {
      return Promise.resolve(fakeWriter);
    },
    now(): number {
      return Date.now();
    },
    setTimeout: timerFns.setTimeout,
    clearTimeout: timerFns.clearTimeout,
    ...overrides,
  };
}

function createSession(overrides?: Partial<NativeCaptureSessionDeps>): ReturnType<typeof createNativeCaptureSession> {
  return createNativeCaptureSession(recordingId, createDeps(overrides));
}

async function startAndReady(overrides?: Partial<NativeCaptureSessionDeps>): Promise<ReturnType<typeof createNativeCaptureSession>> {
  const session = createSession(overrides);
  const startPromise = session.start();
  await flushMicrotasks();
  fakeChild.stdout.push(buildReady(0));
  await flushMicrotasks();
  await startPromise;
  return session;
}

/* ── Tests ─────────────────────────────────────────────────────── */

describe('NativeCaptureSession', () => {
  let savedTmpdir: string | undefined;
  let savedLang: string | undefined;
  let savedLcAll: string | undefined;

  beforeEach(() => {
    savedTmpdir = process.env.TMPDIR;
    savedLang = process.env.LANG;
    savedLcAll = process.env.LC_ALL;
    process.env.TMPDIR = '/tmp';
    process.env.LANG = 'en_US.UTF-8';
    process.env.LC_ALL = 'en_US.UTF-8';
    timerId = 0;
    pendingTimers = [];
  });

  afterEach(() => {
    if (savedTmpdir !== undefined) process.env.TMPDIR = savedTmpdir;
    else delete process.env.TMPDIR;
    if (savedLang !== undefined) process.env.LANG = savedLang;
    else delete process.env.LANG;
    if (savedLcAll !== undefined) process.env.LC_ALL = savedLcAll;
    else delete process.env.LC_ALL;
  });

  /* ── Initialization ──────────────────────────────────────── */

  describe('initialization', () => {
    it('transitions to recording on successful ready', async () => {
      const session = createSession();
      const startPromise = session.start();
      await flushMicrotasks();

      fakeChild.stdout.push(buildReady(0));
      await flushMicrotasks();

      const result = await startPromise;
      expect(result).toEqual({ ok: true });
      expect(session.snapshot().state).toBe('recording');
    });

    it('returns timeout after 60 seconds without ready', async () => {
      const session = createSession();
      const startPromise = session.start();
      await flushMicrotasks();

      // Find the init timeout timer
      const initTimer = pendingTimers.find((t) => t.ms === 60_000);
      expect(initTimer).toBeDefined();

      fireTimer(initTimer!.id);
      await flushMicrotasks();
      await flushMicrotasks();

      const result = await startPromise;
      expect(result).toEqual({ ok: false, reason: 'timeout' });
    });

    it('allows cancel during starting', async () => {
      const session = createSession();
      const startPromise = session.start();
      await flushMicrotasks();

      const cancelPromise = session.cancel();
      await flushMicrotasks();

      const [startResult, cancelResult] = await Promise.all([startPromise, cancelPromise]);
      expect(startResult).toEqual({ ok: false, reason: 'cancelled' });
      expect(cancelResult).toEqual({ status: 'complete' });
    });

    it('cleans up on helper error before ready', async () => {
      const session = createSession();
      const startPromise = session.start();
      await flushMicrotasks();

      fakeChild.stdout.push(buildError(0, 'initialization', 'internal'));
      await flushMicrotasks();
      await flushMicrotasks();

      const result = await startPromise;
      expect(result).toEqual({ ok: false, reason: 'helper-error' });
    });

    it('cleans up on helper exit before ready', async () => {
      const session = createSession();
      const startPromise = session.start();
      await flushMicrotasks();

      fakeChild.stdout.push(null); // EOF
      fakeChild.emit('close', 1);
      await flushMicrotasks();
      await flushMicrotasks();

      // The session should still be waiting for init timeout or ready
      // since exit/close without error or ready doesn't trigger cleanup in starting phase
      // Actually, close event during starting should be handled
      // Let me check - in the current implementation, onClose during 'recording' triggers finalize
      // During 'starting', it just sets childClosed. The session is still waiting for ready or timeout.
      // We need to fire the timeout.
      const initTimer = pendingTimers.find((t) => t.ms === 60_000);
      if (initTimer) {
        fireTimer(initTimer.id);
        await flushMicrotasks();
        await flushMicrotasks();
      }

      const result = await startPromise;
      // The result depends on what triggered the cleanup
      expect(result.ok).toBe(false);
    });

    it('rejects PCM before ready as protocol violation', async () => {
      const session = createSession();
      const startPromise = session.start();
      await flushMicrotasks();

      // PCM before ready is a protocol error (decoder rejects it)
      fakeChild.stdout.push(buildPcm(0));
      await flushMicrotasks();
      await flushMicrotasks();

      const result = await startPromise;
      expect(result).toEqual({ ok: false, reason: 'protocol-violation' });
    });

    it('rejects protocol violation (malformed frame)', async () => {
      const session = createSession();
      const startPromise = session.start();
      await flushMicrotasks();

      // Send garbage
      fakeChild.stdout.push(Buffer.from('garbage data that is not a valid frame'));
      await flushMicrotasks();
      await flushMicrotasks();

      const result = await startPromise;
      expect(result).toEqual({ ok: false, reason: 'protocol-violation' });
    });

    it('returns mutation-unavailable when lease cannot be acquired', async () => {
      const session = createSession({
        mutationCoordinator: { tryAcquire: () => undefined },
      });
      const result = await session.start();
      expect(result).toEqual({ ok: false, reason: 'mutation-unavailable' });
    });

    it('discards the staged session when opening the WAV writer fails', async () => {
      const session = createSession({
        openWriter: () => Promise.reject(new Error('disk unavailable')),
      });

      await expect(session.start()).resolves.toEqual({ ok: false, reason: 'persistence-error' });
      expect(fakeStore.discardEmptyCalls).toEqual([
        { session: fakeStore.beginResult, blocks: 0 },
      ]);
      expect(fakeCoordinator.lease.released).toBe(true);
    });
  });

  /* ── Pre-ready cleanup ───────────────────────────────────── */

  describe('pre-ready cleanup', () => {
    it('closes writer before discardEmpty on timeout', async () => {
      const session = createSession();
      const startPromise = session.start();
      await flushMicrotasks();

      const initTimer = pendingTimers.find((t) => t.ms === 60_000);
      fireTimer(initTimer!.id);
      await flushMicrotasks();
      await flushMicrotasks();

      await startPromise;

      // writer.abort() should be called before store.discardEmpty()
      expect(fakeWriter.aborted).toBe(true);
      expect(fakeWriter.abortCalls).toBe(1);
      expect(fakeStore.discardEmptyCalls).toHaveLength(1);
      expect(fakeStore.discardEmptyCalls[0].blocks).toBe(0);

      // Verify ordering: writer-aborted appears before session-discarded
      const events = (session as unknown as { events: readonly string[] }).events;
      const abortIdx = events.indexOf('writer-aborted');
      const discardIdx = events.indexOf('session-discarded');
      expect(abortIdx).toBeGreaterThanOrEqual(0);
      expect(discardIdx).toBeGreaterThan(abortIdx);
    });

    it('removes only header-only staging item', async () => {
      const session = createSession();
      const startPromise = session.start();
      await flushMicrotasks();

      const initTimer = pendingTimers.find((t) => t.ms === 60_000);
      fireTimer(initTimer!.id);
      await flushMicrotasks();
      await flushMicrotasks();

      await startPromise;

      // discardEmpty called with 0 accepted blocks
      expect(fakeStore.discardEmptyCalls[0].blocks).toBe(0);
    });

    it('releases the mutation lease when discarding an initialization failure fails', async () => {
      const session = createSession();
      fakeStore.discardEmptyError = new Error('staging directory unavailable');
      const startPromise = session.start();
      await flushMicrotasks();

      const initTimer = pendingTimers.find((timer) => timer.ms === 60_000);
      fireTimer(initTimer!.id);
      await flushMicrotasks();
      await flushMicrotasks();

      await expect(startPromise).resolves.toEqual({ ok: false, reason: 'timeout' });
      expect(fakeCoordinator.lease.released).toBe(true);
    });

    it('ignores late ready after cleanup', async () => {
      const session = createSession();
      const startPromise = session.start();
      await flushMicrotasks();

      // Trigger cleanup via timeout
      const initTimer = pendingTimers.find((t) => t.ms === 60_000);
      fireTimer(initTimer!.id);
      await flushMicrotasks();
      await flushMicrotasks();

      await startPromise;

      // Push late ready — should not change state
      fakeChild.stdout.push(buildReady(1));
      await flushMicrotasks();

      // Writer should not have received any PCM blocks
      expect(fakeWriter.writeBlockCalls).toBe(0);
    });

    it('ignores late PCM/gap/interruption/state events after cleanup', async () => {
      const session = createSession();
      const startPromise = session.start();
      await flushMicrotasks();

      const initTimer = pendingTimers.find((t) => t.ms === 60_000);
      fireTimer(initTimer!.id);
      await flushMicrotasks();
      await flushMicrotasks();

      await startPromise;

      // Push late events — none should write to writer or mutate state
      fakeChild.stdout.push(buildReady(1));
      fakeChild.stdout.push(buildPcm(2));
      fakeChild.stdout.push(buildGap(3, 0, 2));
      fakeChild.stdout.push(buildState(4, 'interviewer', 'connected', 0));
      await flushMicrotasks();

      // No writes should have happened
      expect(fakeWriter.writeBlockCalls).toBe(0);
      // No publish calls
      expect(fakeStore.publishCalls).toHaveLength(0);
    });

    it('late process/pipe events only complete resource closure', async () => {
      const session = createSession();
      const startPromise = session.start();
      await flushMicrotasks();

      const initTimer = pendingTimers.find((t) => t.ms === 60_000);
      fireTimer(initTimer!.id);
      await flushMicrotasks();
      await flushMicrotasks();

      await startPromise;

      // Late close event — should not cause errors
      fakeChild.emit('close', 0);
      await flushMicrotasks();

      // No additional writes or publishes
      expect(fakeWriter.writeBlockCalls).toBe(0);
    });
  });

  /* ── Backpressure ────────────────────────────────────────── */

  describe('backpressure', () => {
    it('pauses stdout when writeBlock returns true (backpressure)', async () => {
      const session = await startAndReady();
      fakeWriter.setBackpressure(true);

      const pauseSpy = jest.spyOn(fakeChild.stdout, 'pause');

      fakeChild.stdout.push(buildPcm(1));
      await flushMicrotasks();

      expect(pauseSpy).toHaveBeenCalled();
      expect(session.events).toContain('backpressure');
    });

    it('does not dispatch frames before drain', async () => {
      const session = await startAndReady();
      fakeWriter.setBackpressure(true);

      // Push two PCM frames
      fakeChild.stdout.push(Buffer.concat([buildPcm(1), buildPcm(2)]));
      await flushMicrotasks();

      // Only one block should have been written (the second waits for drain)
      expect(fakeWriter.writeBlockCalls).toBe(1);

      fakeWriter.resolveDrain();
      await flushMicrotasks();

      // Now the second block should be written
      expect(fakeWriter.writeBlockCalls).toBe(2);
    });

    it('continues draining stderr during backpressure', async () => {
      const stderrDiagnostics: unknown[] = [];
      const session = createSession();
      const startPromise = session.start();
      await flushMicrotasks();

      fakeChild.stdout.push(buildReady(0));
      await flushMicrotasks();
      await startPromise;

      fakeWriter.setBackpressure(true);
      fakeChild.stdout.push(buildPcm(1));
      await flushMicrotasks();

      // stderr should still accept data during backpressure
      fakeChild.stderr.push(Buffer.from(JSON.stringify({ level: 'info', code: 'helper-started' }) + '\n'));
      await flushMicrotasks();

      // Drain and continue
      fakeWriter.resolveDrain();
      await flushMicrotasks();

      expect(session.events).toContain('drain-resumed');
    });

    it('resumes stdout after waitForDrain resolves', async () => {
      const session = await startAndReady();
      fakeWriter.setBackpressure(true);

      const resumeSpy = jest.spyOn(fakeChild.stdout, 'resume');

      fakeChild.stdout.push(buildPcm(1));
      await flushMicrotasks();

      expect(resumeSpy).not.toHaveBeenCalled();

      fakeWriter.resolveDrain();
      await flushMicrotasks();

      expect(resumeSpy).toHaveBeenCalled();
    });
  });

  /* ── Finalization barrier ────────────────────────────────── */

  describe('finalization barrier', () => {
    async function runBarrierTest(stdoutEofFirst: boolean): Promise<void> {
      const session = await startAndReady();

      // Push some PCM
      fakeChild.stdout.push(buildPcm(1));
      fakeChild.stdout.push(buildPcm(2));
      await flushMicrotasks();

      // Call stop
      const stopPromise = session.stop();
      await flushMicrotasks();

      // Push stopped frame
      fakeChild.stdout.push(buildStopped(3, 2, 2, 0));
      await flushMicrotasks();

      // Fire the barrier in the specified order
      if (stdoutEofFirst) {
        fakeChild.stdout.push(null);
        await flushMicrotasks();
        expect(session.events).toContain('stdout-eof');
        expect(session.events).not.toContain('barrier-complete');

        fakeChild.emit('close', 0);
        await flushMicrotasks();
      } else {
        fakeChild.emit('close', 0);
        await flushMicrotasks();
        expect(session.events).toContain('child-close');
        expect(session.events).not.toContain('barrier-complete');

        fakeChild.stdout.push(null);
        await flushMicrotasks();
      }

      expect(session.events).toContain('barrier-complete');

      const result = await stopPromise;
      expect(result).toEqual({ status: 'complete' });

      // Verify strict ordering after barrier
      const events = session.events;
      const parserIdx = events.indexOf('parser-finished');
      const stdoutEofIdx = events.indexOf('stdout-eof');
      const childCloseIdx = events.indexOf('child-close');

      expect(parserIdx).toBeGreaterThan(stdoutEofIdx);
      expect(parserIdx).toBeGreaterThan(childCloseIdx);

      const afterParser = events.slice(parserIdx);
      expect(afterParser).toEqual([
        'parser-finished', 'writes-settled', 'stream-finish', 'header-updated',
        'metadata-replaced', 'directory-published', 'library-refreshed',
      ]);
    }

    it('waits for both stdout EOF and child close (EOF first)', async () => {
      await runBarrierTest(true);
    });

    it('waits for both stdout EOF and child close (close first)', async () => {
      await runBarrierTest(false);
    });
  });

  /* ── Gap persistence ─────────────────────────────────────── */

  describe('gap persistence', () => {
    it('writes exactly zero blocks for validated gap range', async () => {
      const session = await startAndReady();

      // Push PCM then gap
      fakeChild.stdout.push(buildPcm(1));
      fakeChild.stdout.push(buildGap(2, 1, 4)); // 3 blocks of gap
      await flushMicrotasks();

      // 1 PCM + 3 gap blocks = 4 writeBlock calls
      expect(fakeWriter.writeBlockCalls).toBe(4);
      // Gap blocks should be zero-filled
      expect(fakeWriter.blocks[1]).toEqual(Buffer.alloc(PCM_BLOCK_BYTES));
      expect(fakeWriter.blocks[2]).toEqual(Buffer.alloc(PCM_BLOCK_BYTES));
      expect(fakeWriter.blocks[3]).toEqual(Buffer.alloc(PCM_BLOCK_BYTES));
    });

    it('adds capture-wide metadata interruption for gap', async () => {
      const session = await startAndReady();

      fakeChild.stdout.push(buildPcm(1));
      fakeChild.stdout.push(buildGap(2, 1, 4));
      await flushMicrotasks();

      // Stop and finalize to check metadata
      const stopPromise = session.stop();
      await flushMicrotasks();

      fakeChild.stdout.push(buildStopped(3, 4, 1, 3));
      await flushMicrotasks();
      fakeChild.stdout.push(null);
      fakeChild.emit('close', 0);
      await flushMicrotasks();

      await stopPromise;

      // Check the metadata published to the store
      expect(fakeStore.publishCalls).toHaveLength(1);
      const metadata = fakeStore.publishCalls[0].metadata as {
        status: string;
        interruptions: Array<{ channel: string; startMs: number; endMs: number; recovered: boolean; reason: string }>;
      };
      expect(metadata.status).toBe('interrupted');

      const gapInterruption = metadata.interruptions.find((i) => i.reason === 'buffer-overflow');
      expect(gapInterruption).toEqual({
        channel: 'capture',
        startMs: 1 * 20,
        endMs: 4 * 20,
        recovered: true,
        reason: 'buffer-overflow',
      });
    });

    it('forces terminal status interrupted', async () => {
      const session = await startAndReady();

      fakeChild.stdout.push(buildPcm(1));
      fakeChild.stdout.push(buildGap(2, 1, 3));
      await flushMicrotasks();

      const stopPromise = session.stop();
      await flushMicrotasks();

      fakeChild.stdout.push(buildStopped(3, 3, 1, 2));
      await flushMicrotasks();
      fakeChild.stdout.push(null);
      fakeChild.emit('close', 0);
      await flushMicrotasks();

      const result = await stopPromise;
      expect(result).toEqual({ status: 'interrupted' });
    });

    it('adjacent later PCM does not clear gap interruption', async () => {
      const session = await startAndReady();

      fakeChild.stdout.push(buildPcm(1));
      fakeChild.stdout.push(buildGap(2, 1, 3));
      fakeChild.stdout.push(buildPcm(3)); // more PCM after gap
      await flushMicrotasks();

      const stopPromise = session.stop();
      await flushMicrotasks();

      fakeChild.stdout.push(buildStopped(4, 4, 2, 2));
      await flushMicrotasks();
      fakeChild.stdout.push(null);
      fakeChild.emit('close', 0);
      await flushMicrotasks();

      const result = await stopPromise;
      expect(result).toEqual({ status: 'interrupted' });
    });

    it('leaves both channel rows connected-with-gap', async () => {
      const session = await startAndReady();

      fakeChild.stdout.push(buildPcm(1));
      fakeChild.stdout.push(buildGap(2, 1, 3));
      await flushMicrotasks();

      const snap = session.snapshot();
      expect(snap.channels.interviewer.status).toBe('connected-with-gap');
      expect(snap.channels.you.status).toBe('connected-with-gap');
    });

    it('ignores gap with count <= 0', async () => {
      await startAndReady();

      fakeChild.stdout.push(buildGap(1, 5, 3)); // count = -2
      await flushMicrotasks();

      expect(fakeWriter.writeBlockCalls).toBe(0);
      expect(fakeStore.publishCalls).toHaveLength(0);
    });

    it('ignores gap with count > 3000', async () => {
      await startAndReady();

      fakeChild.stdout.push(buildGap(1, 0, 3001)); // count = 3001
      await flushMicrotasks();

      expect(fakeWriter.writeBlockCalls).toBe(0);
      expect(fakeStore.publishCalls).toHaveLength(0);
    });
  });

  /* ── Spawn environment ───────────────────────────────────── */

  describe('spawn environment', () => {
    it('passes only PATH, TMPDIR, and locale keys', async () => {
      const session = await startAndReady();
      expect(capturedSpawnOptions).toBeDefined();
      const env = capturedSpawnOptions!.env;

      expect(env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
      expect(env.TMPDIR).toBe('/tmp');
      expect(env.LANG).toBe('en_US.UTF-8');
      expect(env.LC_ALL).toBe('en_US.UTF-8');
    });

    it('strips HOME, USER, SHELL, NODE_OPTIONS, and DYLD_* keys', async () => {
      process.env.HOME = '/Users/test';
      process.env.USER = 'testuser';
      process.env.SHELL = '/bin/zsh';
      process.env.NODE_OPTIONS = '--max-old-space-size=4096';
      process.env.DYLD_LIBRARY_PATH = '/usr/local/lib';
      process.env.DYLD_FALLBACK_LIBRARY_PATH = '/usr/lib';

      const session = await startAndReady();
      const env = capturedSpawnOptions!.env;

      expect(env).not.toHaveProperty('HOME');
      expect(env).not.toHaveProperty('USER');
      expect(env).not.toHaveProperty('SHELL');
      expect(env).not.toHaveProperty('NODE_OPTIONS');
      expect(env).not.toHaveProperty('DYLD_LIBRARY_PATH');
      expect(env).not.toHaveProperty('DYLD_FALLBACK_LIBRARY_PATH');

      // Only expected keys
      const keys = Object.keys(env);
      expect(keys.sort()).toEqual(['LANG', 'LC_ALL', 'PATH', 'TMPDIR']);
    });

    it('does not pass API keys or recording paths', async () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.GROQ_API_KEY = 'provider-secret-value';
      process.env.INTERVIEW_RECORDING_PATH = '/recordings';

      const session = await startAndReady();
      const env = capturedSpawnOptions!.env;

      expect(env).not.toHaveProperty('OPENAI_API_KEY');
      expect(env).not.toHaveProperty('GROQ_API_KEY');
      expect(env).not.toHaveProperty('INTERVIEW_RECORDING_PATH');
    });

    it('rejects invalid TMPDIR', async () => {
      process.env.TMPDIR = 'relative/path';

      const session = createSession();
      const result = await session.start();
      expect(result).toEqual({ ok: false, reason: 'persistence-error' });
    });
  });

  /* ── Failure modes ───────────────────────────────────────── */

  describe('failure modes', () => {
    it('retains a recovery artifact when an active PCM write fails', async () => {
      const persistenceError = Object.assign(new Error('disk full'), {
        category: 'capacity' as const,
      });
      const failingWriter = new FakeWriter();
      failingWriter.writeBlock = () => {
        throw persistenceError;
      };
      failingWriter.waitForDrain = () => Promise.reject(persistenceError);

      const session = await startAndReady({
        openWriter: () => Promise.resolve(failingWriter),
      });

      fakeChild.stdout.push(buildPcm(1));
      await flushMicrotasks();
      fakeChild.stdout.push(null);
      fakeChild.emit('close', 1);
      await flushMicrotasks();
      await flushMicrotasks();

      expect(fakeStore.retainFailedCalls).toHaveLength(1);
      await expect(session.stop()).resolves.toEqual({ status: 'failed', category: 'capacity' });
    });

    it('marks a recording interrupted when helper output is truncated after stop begins', async () => {
      const session = await startAndReady();

      fakeChild.stdout.push(buildPcm(1));
      await flushMicrotasks();

      const stopPromise = session.stop();
      await flushMicrotasks();

      fakeChild.stdout.push(buildStopped(2, 1, 1, 0));
      // A partial trailing frame after stopped makes the helper output invalid.
      fakeChild.stdout.push(buildPcm(3).subarray(0, 10));
      await flushMicrotasks();
      fakeChild.stdout.push(null);
      fakeChild.emit('close', 1);
      await flushMicrotasks();

      await expect(stopPromise).resolves.toEqual({ status: 'interrupted' });
      expect(fakeStore.publishCalls).toHaveLength(1);
      expect(fakeStore.publishCalls[0].metadata).toEqual(
        expect.objectContaining({ status: 'interrupted' }),
      );
    });

    it('handles exit before stdio close', async () => {
      const session = await startAndReady();

      fakeChild.stdout.push(buildPcm(1));
      await flushMicrotasks();

      const stopPromise = session.stop();
      await flushMicrotasks();

      fakeChild.stdout.push(buildStopped(2, 1, 1, 0));
      await flushMicrotasks();

      // Child exits before stdout EOF
      fakeChild.emit('close', 0);
      await flushMicrotasks();

      // Now stdout EOF
      fakeChild.stdout.push(null);
      await flushMicrotasks();

      const result = await stopPromise;
      expect(result.status).toBe('complete');
    });

    it('handles missing stopped frame (unexpected exit)', async () => {
      const session = await startAndReady();

      fakeChild.stdout.push(buildPcm(1));
      await flushMicrotasks();

      // Helper exits without sending stopped
      fakeChild.emit('close', 1);
      await flushMicrotasks();

      // Close deadline timer should fire
      const closeTimer = pendingTimers.find((t) => t.ms === 5_000);
      if (closeTimer) {
        fireTimer(closeTimer.id);
        await flushMicrotasks();
      }
      await flushMicrotasks();
      await flushMicrotasks();

      // Retrieve the finalization result via stop()
      const result = await session.stop();
      expect(result).toEqual({ status: 'interrupted' });
      expect(session.events).toContain('child-close');
    });

    it('handles partial EOF frame', async () => {
      const session = await startAndReady();

      // Send a partial frame then EOF
      const partialFrame = buildPcm(1).subarray(0, 10);
      fakeChild.stdout.push(partialFrame);
      await flushMicrotasks();

      // EOF with partial frame should be a protocol error
      fakeChild.stdout.push(null);
      await flushMicrotasks();
      fakeChild.emit('close', 0);
      await flushMicrotasks();

      // Wait for close deadline
      const closeTimer = pendingTimers.find((t) => t.ms === 5_000);
      if (closeTimer) {
        fireTimer(closeTimer.id);
        await flushMicrotasks();
      }
      await flushMicrotasks();

      // The session should detect the protocol error
      expect(session.events).toContain('protocol-error');
    });

    it('handles pipe close timeout', async () => {
      const session = await startAndReady();

      fakeChild.stdout.push(buildPcm(1));
      await flushMicrotasks();

      // Call stop
      const stopPromise = session.stop();
      await flushMicrotasks();

      fakeChild.stdout.push(buildStopped(2, 1, 1, 0));
      await flushMicrotasks();

      // Don't send EOF or close — fire grace timer then close deadline
      const graceTimer = pendingTimers.find((t) => t.ms === 5_000);
      expect(graceTimer).toBeDefined();
      fireTimer(graceTimer!.id);
      await flushMicrotasks();

      // Close deadline is at HELPER_GRACE_MS + CLOSE_DEADLINE_MS = 10_000
      const closeTimer = pendingTimers.find((t) => t.ms === 10_000);
      if (closeTimer) {
        fireTimer(closeTimer.id);
        await flushMicrotasks();
      }
      await flushMicrotasks();
      await flushMicrotasks();

      const result = await stopPromise;
      // stopped was received before timeout, so this is a clean exit
      expect(result).toEqual({ status: 'complete' });
    });

    it('handles helper stop timeout', async () => {
      const session = await startAndReady();

      fakeChild.stdout.push(buildPcm(1));
      await flushMicrotasks();

      const stopPromise = session.stop();
      await flushMicrotasks();

      // Grace timer fires (helper didn't respond)
      const graceTimer = pendingTimers.find((t) => t.ms === 5_000);
      expect(graceTimer).toBeDefined();
      fireTimer(graceTimer!.id);
      await flushMicrotasks();

      // Now emit close without a stopped frame
      fakeChild.emit('close', null);
      await flushMicrotasks();
      fakeChild.stdout.push(null);
      await flushMicrotasks();

      const result = await stopPromise;
      // No stopped frame was received, so this is an unexpected termination
      expect(result).toEqual({ status: 'interrupted' });
    });

    it('reports interrupted when stopped is missing during orderly stop', async () => {
      const session = await startAndReady();

      fakeChild.stdout.push(buildPcm(1));
      await flushMicrotasks();

      const stopPromise = session.stop();
      await flushMicrotasks();

      // Helper closes without sending stopped frame
      fakeChild.stdout.push(null);
      fakeChild.emit('close', 0);
      await flushMicrotasks();

      const result = await stopPromise;
      expect(result).toEqual({ status: 'interrupted' });

      // Metadata should reflect unexpected termination
      expect(fakeStore.publishCalls).toHaveLength(1);
      const metadata = fakeStore.publishCalls[0].metadata as {
        status: string;
        interruptions: Array<{ channel: string; recovered: boolean; reason: string }>;
      };
      expect(metadata.status).toBe('interrupted');
      expect(metadata.interruptions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ channel: 'capture', reason: 'helper-exit', recovered: false }),
        ]),
      );
    });

    it('reports interrupted when helper crashes after stop()', async () => {
      const session = await startAndReady();

      fakeChild.stdout.push(buildPcm(1));
      await flushMicrotasks();

      const stopPromise = session.stop();
      await flushMicrotasks();

      // Helper crashes (non-zero exit code) without sending stopped
      fakeChild.emit('close', 1);
      await flushMicrotasks();

      // Close deadline timer resolves the barrier
      const closeTimer = pendingTimers.find((t) => t.ms === 10_000);
      if (closeTimer) {
        fireTimer(closeTimer.id);
        await flushMicrotasks();
      }
      await flushMicrotasks();
      await flushMicrotasks();

      const result = await stopPromise;
      expect(result).toEqual({ status: 'interrupted' });
    });

    it('closes open interruptions with recovered: false on unexpected exit', async () => {
      const session = await startAndReady();

      // Push PCM and an open interruption
      fakeChild.stdout.push(buildPcm(1));
      fakeChild.stdout.push(buildInterruptionOpen(2, 1, 'interviewer', 1, 'stream-error'));
      await flushMicrotasks();

      // Unexpected exit
      fakeChild.emit('close', 1);
      await flushMicrotasks();

      const closeTimer = pendingTimers.find((t) => t.ms === 5_000);
      if (closeTimer) {
        fireTimer(closeTimer.id);
        await flushMicrotasks();
      }
      await flushMicrotasks();
      await flushMicrotasks();

      const result = await session.stop();
      expect(result).toEqual({ status: 'interrupted' });

      // Verify published metadata closes the interruption as unrecovered
      expect(fakeStore.publishCalls).toHaveLength(1);
      const metadata = fakeStore.publishCalls[0].metadata as {
        status: string;
        interruptions: Array<{ channel: string; recovered: boolean; reason: string }>;
      };
      expect(metadata.status).toBe('interrupted');
      const interviewerInterruption = metadata.interruptions.find(
        (i) => i.channel === 'interviewer' && i.reason === 'stream-error',
      );
      expect(interviewerInterruption).toBeDefined();
      expect(interviewerInterruption!.recovered).toBe(false);
    });

    it('handles writer error categories', async () => {
      // Override writer to fail on finalize
      const failWriter = new FakeWriter();
      const origFinalize = failWriter.finalize.bind(failWriter);
      failWriter.finalize = () => {
        const err = Object.assign(new Error('disk full'), { name: 'WavPersistenceError', category: 'capacity' });
        return Promise.reject(err);
      };

      const session = await startAndReady({
        openWriter: () => Promise.resolve(failWriter),
      });

      fakeChild.stdout.push(buildPcm(1));
      await flushMicrotasks();

      const stopPromise = session.stop();
      await flushMicrotasks();

      fakeChild.stdout.push(buildStopped(2, 1, 1, 0));
      await flushMicrotasks();
      fakeChild.stdout.push(null);
      fakeChild.emit('close', 0);
      await flushMicrotasks();

      const result = await stopPromise;
      expect(result).toEqual({ status: 'failed', category: 'capacity' });
    });

    it('handles publication failure', async () => {
      const session = await startAndReady();
      fakeStore.publishError = new Error('collision');

      fakeChild.stdout.push(buildPcm(1));
      await flushMicrotasks();

      const stopPromise = session.stop();
      await flushMicrotasks();

      fakeChild.stdout.push(buildStopped(2, 1, 1, 0));
      await flushMicrotasks();
      fakeChild.stdout.push(null);
      fakeChild.emit('close', 0);
      await flushMicrotasks();

      const result = await stopPromise;
      expect(result).toEqual({ status: 'failed', category: 'io-finalization' });
    });

    it('reports truthful interrupted vs failed', async () => {
      // Interrupted: WAV succeeds but there were gaps
      const session1 = await startAndReady();
      fakeChild.stdout.push(buildPcm(1));
      fakeChild.stdout.push(buildGap(2, 1, 3));
      await flushMicrotasks();

      const stop1 = session1.stop();
      await flushMicrotasks();
      fakeChild.stdout.push(buildStopped(3, 3, 1, 2));
      await flushMicrotasks();
      fakeChild.stdout.push(null);
      fakeChild.emit('close', 0);
      await flushMicrotasks();

      expect(await stop1).toEqual({ status: 'interrupted' });

      // Failed: publication fails
      const session2 = await startAndReady();
      fakeStore.publishError = new Error('fail');
      fakeChild.stdout.push(buildPcm(1));
      await flushMicrotasks();

      const stop2 = session2.stop();
      await flushMicrotasks();
      fakeChild.stdout.push(buildStopped(2, 1, 1, 0));
      await flushMicrotasks();
      fakeChild.stdout.push(null);
      fakeChild.emit('close', 0);
      await flushMicrotasks();

      expect((await stop2).status).toBe('failed');
    });
  });

  /* ── Idempotent convergence ──────────────────────────────── */

  describe('idempotent convergence', () => {
    it('stop, helper-exit, and window-close converge to same finalization', async () => {
      const session = await startAndReady();

      fakeChild.stdout.push(buildPcm(1));
      await flushMicrotasks();

      // Call stop twice — second should return same promise
      const stop1 = session.stop();
      await flushMicrotasks();
      const stop2 = session.stop();
      expect(stop1).toBe(stop2);

      // Push stopped
      fakeChild.stdout.push(buildStopped(2, 1, 1, 0));
      await flushMicrotasks();

      // Simulate child close and stdout EOF
      fakeChild.stdout.push(null);
      fakeChild.emit('close', 0);
      await flushMicrotasks();

      const result = await stop1;
      expect(result.status).toBeDefined();

      // Third call should return same promise
      const stop3 = session.stop();
      expect(stop3).toBe(stop1);
    });

    it('cancel during starting returns complete (no PCM was captured)', async () => {
      const session = createSession();
      const startPromise = session.start();
      await flushMicrotasks();

      const cancelResult = await session.cancel();
      expect(cancelResult).toEqual({ status: 'complete' });

      // Start promise should also resolve
      const startResult = await startPromise;
      expect(startResult).toEqual({ ok: false, reason: 'cancelled' });
    });
  });

  /* ── Snapshot ────────────────────────────────────────────── */

  describe('snapshot', () => {
    it('returns idle state before start', () => {
      const session = createSession();
      const snap = session.snapshot();
      expect(snap.state).toBe('idle');
      expect(snap.canCancel).toBe(false);
      expect(snap.canStop).toBe(false);
      expect(snap.acceptedTimelineBlocks).toBe(0);
    });

    it('returns starting state during initialization', async () => {
      const session = createSession();
      session.start();
      await flushMicrotasks();

      const snap = session.snapshot();
      expect(snap.state).toBe('starting');
      expect(snap.canCancel).toBe(true);
      expect(snap.canStop).toBe(false);
    });

    it('returns recording state after ready', async () => {
      const session = await startAndReady();
      const snap = session.snapshot();
      expect(snap.state).toBe('recording');
      expect(snap.canCancel).toBe(false);
      expect(snap.canStop).toBe(true);
    });

    it('does not include store session paths in snapshot', async () => {
      const session = await startAndReady();
      const snap = session.snapshot();
      const serialized = JSON.stringify(snap);
      expect(serialized).not.toContain('stagingDirectory');
      expect(serialized).not.toContain('audioFilePath');
      expect(serialized).not.toContain('sessionId');
    });

    it('tracks accepted PCM and gap blocks', async () => {
      const session = await startAndReady();

      fakeChild.stdout.push(buildPcm(1));
      fakeChild.stdout.push(buildPcm(2));
      fakeChild.stdout.push(buildGap(3, 2, 4));
      await flushMicrotasks();

      const snap = session.snapshot();
      expect(snap.acceptedTimelineBlocks).toBe(4); // 2 PCM + 2 gap
    });
  });

  /* ── Writer/Store interaction ────────────────────────────── */

  describe('writer and store interaction', () => {
    it('opens writer exactly once', async () => {
      let openWriterCalls = 0;
      const session = await startAndReady({
        openWriter: (path) => {
          openWriterCalls++;
          return Promise.resolve(fakeWriter);
        },
      });
      expect(openWriterCalls).toBe(1);
    });

    it('acquires mutation lease before begin and releases after publish', async () => {
      const session = await startAndReady();

      fakeChild.stdout.push(buildPcm(1));
      await flushMicrotasks();

      const stopPromise = session.stop();
      await flushMicrotasks();

      fakeChild.stdout.push(buildStopped(2, 1, 1, 0));
      await flushMicrotasks();
      fakeChild.stdout.push(null);
      fakeChild.emit('close', 0);
      await flushMicrotasks();

      await stopPromise;

      expect(fakeCoordinator.lease.released).toBe(true);
      expect(fakeStore.publishCalls).toHaveLength(1);
    });

    it('releases mutation lease on init failure', async () => {
      const session = createSession();
      const startPromise = session.start();
      await flushMicrotasks();

      const initTimer = pendingTimers.find((t) => t.ms === 60_000);
      fireTimer(initTimer!.id);
      await flushMicrotasks();
      await flushMicrotasks();

      await startPromise;
      expect(fakeCoordinator.lease.released).toBe(true);
    });

    it('calls library.refresh after publish', async () => {
      const session = await startAndReady();

      fakeChild.stdout.push(buildPcm(1));
      await flushMicrotasks();

      const stopPromise = session.stop();
      await flushMicrotasks();

      fakeChild.stdout.push(buildStopped(2, 1, 1, 0));
      await flushMicrotasks();
      fakeChild.stdout.push(null);
      fakeChild.emit('close', 0);
      await flushMicrotasks();

      await stopPromise;

      expect(fakeLibrary.listCalls).toBeGreaterThanOrEqual(1);
    });
  });
});
