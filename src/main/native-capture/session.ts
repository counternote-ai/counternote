import { EventEmitter } from 'events';
import type { Readable, Writable } from 'stream';
import { PCM_BLOCK_BYTES, type CaptureFrame, type SourceChannel } from '../../types/native-capture';
import { CaptureProtocolDecoder } from './protocol';
import { WavPersistenceError } from './wav-writer';
import type { CaptureStore, CaptureStoreSession } from './capture-store';
import type {
  RecordingMutationCoordinator,
  RecordingMutationLease,
} from '../recording-mutation-coordinator';
import type { RecordingsLibrary } from '../recordings-library';
import {
  type CaptureMetadata,
  type CaptureTerminalMetadata,
  type PersistedInterruption,
  blockIndexToMilliseconds,
} from './capture-metadata';
import { createStderrDrain, type StderrDrainHandle } from './stderr-drain';

/* ── Public types ─────────────────────────────────────────────── */

export type StartFailureReason =
  | 'cancelled'
  | 'timeout'
  | 'helper-error'
  | 'protocol-violation'
  | 'persistence-error'
  | 'mutation-unavailable';

export type StartCaptureResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: StartFailureReason };

export type StopCaptureResult =
  | { readonly status: 'complete' }
  | { readonly status: 'interrupted' }
  | { readonly status: 'failed'; readonly category: PersistenceFailureCategory };

export type PersistenceFailureCategory = 'capacity' | 'access' | 'io-finalization';

export interface ChannelStatus {
  readonly status: string;
  readonly started: boolean;
}

export type SessionState = 'idle' | 'starting' | 'recording' | 'stopping';

export interface CaptureStatusSnapshot {
  readonly state: SessionState;
  readonly channels: {
    readonly interviewer: ChannelStatus;
    readonly you: ChannelStatus;
  };
  readonly acceptedTimelineBlocks: number;
  readonly canCancel: boolean;
  readonly canStop: boolean;
}

export interface NativeCaptureSession {
  start(): Promise<StartCaptureResult>;
  cancel(): Promise<StopCaptureResult>;
  stop(): Promise<StopCaptureResult>;
  snapshot(): CaptureStatusSnapshot;
  onStatusChange?(callback: () => void): () => void;
}

/* ── Injectable dependencies ──────────────────────────────────── */

export interface ChildProcessLike extends EventEmitter {
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  kill(signal?: string): boolean;
}

export interface WavWriterLike {
  writeBlock(block: Buffer): boolean;
  waitForDrain(): Promise<void>;
  finalize(): Promise<{ dataBytes: number }>;
  abort(): Promise<void>;
}

export interface NativeCaptureSessionDeps {
  readonly helperPath: string;
  readonly store: Pick<CaptureStore, 'begin' | 'publish' | 'retainFailed' | 'discardEmpty'>;
  readonly mutationCoordinator: Pick<RecordingMutationCoordinator, 'tryAcquire'>;
  readonly recordingsLibrary: Pick<RecordingsLibrary, 'list'>;
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcessLike;
  openWriter(filePath: string): Promise<WavWriterLike>;
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface SpawnOptions {
  stdio: ['pipe', 'pipe', 'pipe'];
  env: Record<string, string>;
}

/* ── Constants ────────────────────────────────────────────────── */

const INIT_TIMEOUT_MS = 60_000;
const HELPER_GRACE_MS = 5_000;
const CLOSE_DEADLINE_MS = 5_000;
const ALLOWED_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/* ── Internal types ───────────────────────────────────────────── */

interface OpenInterruption {
  id: number;
  channel: SourceChannel;
  startBlock: number;
  reason: string;
}

type Phase = 'idle' | 'starting' | 'recording' | 'stopping' | 'done';

/* ── Factory ──────────────────────────────────────────────────── */

export function createNativeCaptureSession(
  recordingId: string,
  deps: NativeCaptureSessionDeps,
): NativeCaptureSession & { readonly events: readonly string[] } {
  /* state */
  let phase: Phase = 'idle';
  let lease: RecordingMutationLease | undefined;
  let storeSession: CaptureStoreSession | undefined;
  let writer: WavWriterLike | undefined;
  let child: ChildProcessLike | undefined;
  let decoder: CaptureProtocolDecoder | undefined;
  let stderrDrain: StderrDrainHandle | undefined;

  /* timers */
  let initTimer: unknown;
  let graceTimer: unknown;
  let closeTimer: unknown;

  /* timeline */
  let acceptedPcmBlocks = 0;
  let acceptedGapBlocks = 0;
  let channelStates: Record<SourceChannel, ChannelStatus> = {
    interviewer: { status: 'connected', started: false },
    you: { status: 'connected', started: false },
  };
  const openInterruptions = new Map<SourceChannel, OpenInterruption>();
  const closedInterruptions: PersistedInterruption[] = [];
  let hasGap = false;
  let stoppedReceived = false;

  /* barrier */
  let stdoutEof = false;
  let childClosed = false;
  let barrierResolve: (() => void) | undefined;

  /* shared promises */
  let startPromise: Promise<StartCaptureResult> | undefined;
  let sharedStopPromise: Promise<StopCaptureResult> | undefined;
  let startResolve: ((r: StartCaptureResult) => void) | undefined;

  /* backpressure */
  let frameQueue: CaptureFrame[] = [];
  let queueProcessing = false;

  /* cleanup guard */
  let initCleanupDone = false;

  /* events for test observability */
  const events: string[] = [];
  const statusSubscribers = new Set<() => void>();

  /* ── helpers ──────────────────────────────────────────────── */

  function emit(event: string): void {
    events.push(event);
    // Check if start should resolve
    if (event === 'ready' || event === 'init-cleanup-done') {
      startResolve?.(event === 'ready' ? { ok: true } : classifyInitFailure());
    }
  }

  function notifyStatusSubscribers(): void {
    for (const callback of statusSubscribers) {
      try {
        callback();
      } catch {
        /* observer errors are non-fatal */
      }
    }
  }

  function acceptedBlocks(): number {
    return acceptedPcmBlocks + acceptedGapBlocks;
  }

  function clearTimers(): void {
    if (initTimer !== undefined) {
      deps.clearTimeout(initTimer);
      initTimer = undefined;
    }
    if (graceTimer !== undefined) {
      deps.clearTimeout(graceTimer);
      graceTimer = undefined;
    }
    if (closeTimer !== undefined) {
      deps.clearTimeout(closeTimer);
      closeTimer = undefined;
    }
  }

  function classifyInitFailure(): StartCaptureResult {
    const reason: StartFailureReason = events.includes('init-timeout')
      ? 'timeout'
      : events.includes('helper-error')
        ? 'helper-error'
        : events.includes('protocol-error')
          ? 'protocol-violation'
          : events.includes('persistence-error')
            ? 'persistence-error'
            : 'cancelled';
    return { ok: false, reason };
  }

  function classifyWriterError(error: unknown): PersistenceFailureCategory {
    if (error instanceof WavPersistenceError) return error.category;
    if (typeof error === 'object' && error !== null && 'category' in error) {
      const cat = (error as { category: unknown }).category;
      if (cat === 'capacity' || cat === 'access' || cat === 'io-finalization') return cat;
    }
    return 'io-finalization';
  }

  /* ── environment ─────────────────────────────────────────── */

  function buildEnvironment(): Record<string, string> {
    const src = process.env;
    const tmpdir = src.TMPDIR;
    if (!tmpdir || !tmpdir.startsWith('/')) throw new Error('INVALID_TMPDIR');
    const env: Record<string, string> = { PATH: ALLOWED_PATH, TMPDIR: tmpdir };
    if (src.LANG) env.LANG = src.LANG;
    if (src.LC_ALL) env.LC_ALL = src.LC_ALL;
    return env;
  }

  /* ── barrier ──────────────────────────────────────────────── */

  function waitForBarrier(): Promise<void> {
    if (stdoutEof && childClosed) return Promise.resolve();
    return new Promise<void>((r) => {
      barrierResolve = r;
    });
  }

  function checkBarrier(): void {
    if (stdoutEof && childClosed) {
      emit('barrier-complete');
      barrierResolve?.();
      barrierResolve = undefined;
    }
  }

  /* ── stdout frame processing ─────────────────────────────── */

  function onStdoutData(chunk: Buffer): void {
    if (!decoder) return;
    try {
      const frames = decoder.push(chunk);
      if (frames.length > 0) {
        frameQueue.push(...frames);
        if (!queueProcessing) void drainFrameQueue();
      }
    } catch {
      if (phase === 'starting') {
        emit('protocol-error');
        void performInitCleanup('protocol-violation');
      } else if (phase === 'recording') {
        emit('protocol-error');
        if (!sharedStopPromise) sharedStopPromise = doFinalize('protocol-error');
      }
    }
  }

  async function drainFrameQueue(): Promise<void> {
    queueProcessing = true;
    try {
      while (frameQueue.length > 0) {
        if (phase === 'starting' && initCleanupDone) break;
        const frame = frameQueue.shift()!;
        const needsDrain = dispatchFrame(frame);
        if (needsDrain && writer) {
          await writer.waitForDrain();
          child?.stdout?.resume();
          emit('drain-resumed');
        }
      }
    } catch {
      frameQueue = [];
      emit('persistence-error');
      if (!sharedStopPromise && (phase === 'recording' || phase === 'stopping')) {
        sharedStopPromise = doFinalize('persistence-error');
      }
    } finally {
      queueProcessing = false;
    }
  }

  function dispatchFrame(frame: CaptureFrame): boolean {
    switch (frame.frameType) {
      case 'ready':
        onReady();
        return false;
      case 'pcm':
        return onPcm(frame.payload as Buffer);
      case 'gap':
        onGap(frame.payload as { startBlock: number; endBlockExclusive: number });
        return false;
      case 'interruption':
        onInterruption(frame.payload as InterruptionPayload);
        return false;
      case 'state':
        onState(frame.payload as StatePayload);
        return false;
      case 'stopped':
        onStopped(frame.payload as StoppedPayload);
        return false;
      case 'error':
        onError(frame.payload as ErrorPayload);
        return false;
    }
  }

  function onReady(): void {
    if (phase !== 'starting' || initCleanupDone) return;
    if (initTimer !== undefined) {
      deps.clearTimeout(initTimer);
      initTimer = undefined;
    }
    phase = 'recording';
    emit('ready');
    notifyStatusSubscribers();
  }

  function onPcm(payload: Buffer): boolean {
    if (phase !== 'recording' && phase !== 'stopping') return false;
    if (!writer) return false;
    if (!channelStates.interviewer.started) {
      channelStates = {
        ...channelStates,
        interviewer: { ...channelStates.interviewer, started: true },
        you: { ...channelStates.you, started: true },
      };
    }
    const needsDrain = writer.writeBlock(payload);
    acceptedPcmBlocks += 1;
    if (needsDrain) {
      child?.stdout?.pause();
      emit('backpressure');
    }
    return needsDrain;
  }

  function onGap(payload: { startBlock: number; endBlockExclusive: number }): void {
    if (phase !== 'recording' && phase !== 'stopping') return;
    if (!writer) return;
    const count = payload.endBlockExclusive - payload.startBlock;
    if (count <= 0 || count > 3000) return;
    const zeroBlock = Buffer.alloc(PCM_BLOCK_BYTES);
    for (let i = 0; i < count; i++) {
      writer.writeBlock(zeroBlock);
    }
    acceptedGapBlocks += count;
    hasGap = true;
    closedInterruptions.push({
      channel: 'capture',
      startMs: blockIndexToMilliseconds(payload.startBlock),
      endMs: blockIndexToMilliseconds(payload.endBlockExclusive),
      recovered: true,
      reason: 'buffer-overflow',
    });
    channelStates = {
      interviewer: { status: 'connected-with-gap', started: channelStates.interviewer.started },
      you: { status: 'connected-with-gap', started: channelStates.you.started },
    };
    notifyStatusSubscribers();
  }

  interface InterruptionPayload {
    phase: string;
    id: number;
    channel: SourceChannel;
    startBlock: number;
    endBlockExclusive?: number;
    reason: string;
    recovered?: boolean;
  }

  function onInterruption(p: InterruptionPayload): void {
    if (phase !== 'recording' && phase !== 'stopping') return;
    if (p.phase === 'opened') {
      openInterruptions.set(p.channel, {
        id: p.id,
        channel: p.channel,
        startBlock: p.startBlock,
        reason: p.reason,
      });
    } else {
      openInterruptions.delete(p.channel);
      closedInterruptions.push({
        channel: p.channel,
        startMs: blockIndexToMilliseconds(p.startBlock),
        endMs: blockIndexToMilliseconds(p.endBlockExclusive!),
        recovered: p.recovered!,
        reason: p.reason as PersistedInterruption['reason'],
      });
    }
  }

  interface StatePayload {
    channel: SourceChannel;
    status: string;
    effectiveBlock: number;
    reason?: string;
    silentBlocks?: number;
    attempt?: number;
  }

  function onState(p: StatePayload): void {
    if (phase !== 'recording' && phase !== 'stopping') return;
    channelStates = {
      ...channelStates,
      [p.channel]: { status: p.status, started: channelStates[p.channel].started },
    };
    notifyStatusSubscribers();
  }

  interface StoppedPayload {
    reason: string;
    finalBlockExclusive: number;
    pcmBlocks: number;
    gapBlocks: number;
  }

  function onStopped(_p: StoppedPayload): void {
    if (phase !== 'recording' && phase !== 'stopping') return;
    stoppedReceived = true;
    emit('stopped');
    if (phase === 'recording') {
      phase = 'stopping';
      if (!sharedStopPromise) sharedStopPromise = doFinalize(undefined);
    }
    // If phase === 'stopping', doFinalize is already running; just record the receipt
  }

  interface ErrorPayload {
    phase: string;
    code: string;
    channel?: SourceChannel;
    terminal: true;
  }

  function onError(_p: ErrorPayload): void {
    if (phase === 'starting') {
      emit('helper-error');
      void performInitCleanup('helper-error');
    } else if (phase === 'recording') {
      emit('helper-error');
      if (!sharedStopPromise) sharedStopPromise = doFinalize('helper-error');
    }
  }

  function onStdoutEnd(): void {
    stdoutEof = true;
    emit('stdout-eof');
    checkBarrier();
  }

  function onClose(_code: number | null): void {
    childClosed = true;
    emit('child-close');
    checkBarrier();
    // Unexpected exit during recording
    if (phase === 'recording') {
      if (!sharedStopPromise) sharedStopPromise = doFinalize('helper-exit');
    }
  }

  /* ── init cleanup ─────────────────────────────────────────── */

  async function performInitCleanup(_reason: StartFailureReason): Promise<void> {
    if (initCleanupDone) return;
    initCleanupDone = true;
    clearTimers();

    // Abort writer first (before discardEmpty)
    let writerClosed = true;
    if (writer) {
      try {
        await writer.abort();
        emit('writer-aborted');
      } catch {
        writerClosed = false;
        emit('persistence-error');
      }
    }

    // Discard empty staging
    if (storeSession && writerClosed) {
      try {
        await deps.store.discardEmpty(storeSession, 0);
        emit('session-discarded');
      } catch {
        // Keep an unremovable staged item available to the recovery service.
        emit('persistence-error');
      }
    }

    // Terminate child
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* noop */
      }
      graceTimer = deps.setTimeout(() => {
        try {
          child?.kill('SIGKILL');
        } catch {
          /* noop */
        }
      }, HELPER_GRACE_MS);
    }

    stderrDrain?.close();
    releaseLease();
    phase = 'done';
    notifyStatusSubscribers();
    emit('init-cleanup-done');
  }

  /* ── finalization ─────────────────────────────────────────── */

  async function doFinalize(interruptionReason: string | undefined): Promise<StopCaptureResult> {
    phase = 'stopping';
    notifyStatusSubscribers();

    // Close open interruptions on unexpected termination
    if (interruptionReason) {
      const nextBlock = acceptedBlocks();
      for (const [channel, oi] of openInterruptions) {
        closedInterruptions.push({
          channel,
          startMs: blockIndexToMilliseconds(oi.startBlock),
          endMs: blockIndexToMilliseconds(nextBlock),
          recovered: false,
          reason: oi.reason as PersistedInterruption['reason'],
        });
      }
      openInterruptions.clear();

      // Add capture-wide terminal event
      if (
        !closedInterruptions.some(
          (i) =>
            i.channel === 'capture' && i.reason === interruptionReason && i.recovered === false,
        )
      ) {
        closedInterruptions.push({
          channel: 'capture',
          startMs: blockIndexToMilliseconds(nextBlock),
          endMs: blockIndexToMilliseconds(nextBlock),
          recovered: false,
          reason: interruptionReason as PersistedInterruption['reason'],
        });
      }
    }

    // Wait for barrier with deadline
    if (interruptionReason) {
      const barrier = waitForBarrier();
      const deadline = new Promise<void>((r) => {
        closeTimer = deps.setTimeout(() => {
          emit('close-timeout');
          stdoutEof = true;
          childClosed = true;
          r();
        }, CLOSE_DEADLINE_MS);
      });
      await Promise.race([barrier, deadline]);
      if (closeTimer !== undefined) {
        deps.clearTimeout(closeTimer);
        closeTimer = undefined;
      }
    } else {
      // Grace period for orderly stop
      graceTimer = deps.setTimeout(() => {
        emit('grace-timeout');
        try {
          child?.kill('SIGTERM');
        } catch {
          /* noop */
        }
      }, HELPER_GRACE_MS);

      // Also set a close deadline after grace period
      const barrier = waitForBarrier();
      const deadline = new Promise<void>((r) => {
        closeTimer = deps.setTimeout(() => {
          emit('close-timeout');
          stdoutEof = true;
          childClosed = true;
          r();
        }, HELPER_GRACE_MS + CLOSE_DEADLINE_MS);
      });
      await Promise.race([barrier, deadline]);
      if (graceTimer !== undefined) {
        deps.clearTimeout(graceTimer);
        graceTimer = undefined;
      }
      if (closeTimer !== undefined) {
        deps.clearTimeout(closeTimer);
        closeTimer = undefined;
      }

      // If orderly stop but stopped was never received, treat as unexpected termination
      if (!stoppedReceived) {
        interruptionReason = 'helper-exit';
        const nextBlock = acceptedBlocks();
        for (const [channel, oi] of openInterruptions) {
          closedInterruptions.push({
            channel,
            startMs: blockIndexToMilliseconds(oi.startBlock),
            endMs: blockIndexToMilliseconds(nextBlock),
            recovered: false,
            reason: oi.reason as PersistedInterruption['reason'],
          });
        }
        openInterruptions.clear();
        if (
          !closedInterruptions.some(
            (i) => i.channel === 'capture' && i.reason === 'helper-exit' && i.recovered === false,
          )
        ) {
          closedInterruptions.push({
            channel: 'capture',
            startMs: blockIndexToMilliseconds(nextBlock),
            endMs: blockIndexToMilliseconds(nextBlock),
            recovered: false,
            reason: 'helper-exit',
          });
        }
      }
    }

    // Parser drain
    if (decoder) {
      try {
        decoder.finish();
      } catch {
        // Partial frame at EOF is a protocol failure
        emit('protocol-error');
        if (!interruptionReason) {
          interruptionReason = 'protocol-error';
          const nextBlock = acceptedBlocks();
          closedInterruptions.push({
            channel: 'capture',
            startMs: blockIndexToMilliseconds(nextBlock),
            endMs: blockIndexToMilliseconds(nextBlock),
            recovered: false,
            reason: 'protocol-error',
          });
        }
      }
    }
    emit('parser-finished');

    // Settle writes and finalize WAV
    if (writer) {
      try {
        await writer.waitForDrain();
        emit('writes-settled');
        await writer.finalize();
        emit('stream-finish');
        emit('header-updated');
      } catch (error) {
        emit('persistence-error');
        const category = classifyWriterError(error);
        await persistFailed(category);
        cleanupFinal();
        return { status: 'failed', category };
      }
    }

    // Terminal metadata + publish
    const terminalStatus = determineStatus(interruptionReason);
    try {
      await publishMetadata(terminalStatus);
      emit('metadata-replaced');
      emit('directory-published');
    } catch {
      await persistFailed('io-finalization');
      cleanupFinal();
      return { status: 'failed', category: 'io-finalization' };
    }

    // Refresh library
    try {
      await deps.recordingsLibrary.list();
      emit('library-refreshed');
    } catch {
      /* non-fatal */
    }

    cleanupFinal();
    return terminalStatus === 'complete' ? { status: 'complete' } : { status: 'interrupted' };
  }

  function determineStatus(interruptionReason: string | undefined): 'complete' | 'interrupted' {
    if (interruptionReason) return 'interrupted';
    if (hasGap || closedInterruptions.length > 0) return 'interrupted';
    return 'complete';
  }

  async function publishMetadata(status: 'complete' | 'interrupted'): Promise<void> {
    if (!storeSession) return;
    const metadata: CaptureTerminalMetadata = {
      version: 1,
      status,
      startedAt: storeSession.startedAt,
      endedAt: new Date(deps.now()).toISOString(),
      channels: {
        interviewer: { started: channelStates.interviewer.started },
        you: { started: channelStates.you.started },
      },
      interruptions: [...closedInterruptions],
    };
    await deps.store.publish(storeSession, metadata, acceptedBlocks());
  }

  async function persistFailed(_category: PersistenceFailureCategory): Promise<void> {
    if (!storeSession) return;
    // Add persistence-error if not already present
    if (!closedInterruptions.some((i) => i.reason === 'persistence-error')) {
      closedInterruptions.push({
        channel: 'capture',
        startMs: blockIndexToMilliseconds(acceptedBlocks()),
        endMs: blockIndexToMilliseconds(acceptedBlocks()),
        recovered: false,
        reason: 'persistence-error',
      });
    }
    const metadata: CaptureMetadata = {
      version: 1,
      status: 'failed',
      startedAt: storeSession.startedAt,
      endedAt: new Date(deps.now()).toISOString(),
      channels: {
        interviewer: { started: channelStates.interviewer.started },
        you: { started: channelStates.you.started },
      },
      interruptions: [...closedInterruptions],
    };
    try {
      await deps.store.retainFailed(storeSession, metadata);
      emit('retained-failed');
    } catch {
      /* best-effort */
    }
  }

  function cleanupFinal(): void {
    stderrDrain?.close();
    releaseLease();
    child?.stdin?.destroy();
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    phase = 'done';
    notifyStatusSubscribers();
  }

  function releaseLease(): void {
    lease?.release();
    lease = undefined;
  }

  /* ── start() ──────────────────────────────────────────────── */

  async function doStart(): Promise<StartCaptureResult> {
    phase = 'starting';
    notifyStatusSubscribers();

    lease = deps.mutationCoordinator.tryAcquire('capture');
    if (!lease) {
      phase = 'idle';
      notifyStatusSubscribers();
      return { ok: false, reason: 'mutation-unavailable' };
    }

    try {
      storeSession = await deps.store.begin(recordingId);
      writer = await deps.openWriter(storeSession.audioFilePath);
    } catch {
      emit('persistence-error');
      if (storeSession) {
        try {
          await deps.store.discardEmpty(storeSession, 0);
          emit('session-discarded');
        } catch {
          // The failed session stays available to the recovery service.
        }
      }
      releaseLease();
      phase = 'idle';
      notifyStatusSubscribers();
      return { ok: false, reason: 'persistence-error' };
    }

    try {
      const env = buildEnvironment();
      child = deps.spawn(deps.helperPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
    } catch {
      await performInitCleanup('persistence-error');
      return { ok: false, reason: 'persistence-error' };
    }

    // Attach stderr drain synchronously
    stderrDrain = createStderrDrain(child.stderr!, () => {});

    // Set up decoder and stdout processing
    decoder = new CaptureProtocolDecoder();
    child.stdout!.on('data', onStdoutData);
    child.stdout!.on('end', onStdoutEnd);
    child.on('close', onClose);

    // 60-second initialization timeout
    initTimer = deps.setTimeout(() => {
      emit('init-timeout');
      void performInitCleanup('timeout');
    }, INIT_TIMEOUT_MS);

    // Await ready or cleanup
    const result = await new Promise<StartCaptureResult>((resolve) => {
      startResolve = resolve;
      // Check synchronously in case cleanup already happened
      if (phase === 'recording') resolve({ ok: true });
      if (initCleanupDone) resolve(classifyInitFailure());
    });

    startResolve = undefined;
    return result;
  }

  /* ── stop()/cancel() ──────────────────────────────────────── */

  function doStop(): Promise<StopCaptureResult> {
    if (sharedStopPromise) return sharedStopPromise;
    if (phase === 'done') {
      return Promise.resolve({ status: 'complete' as const });
    }
    if (phase === 'idle') {
      return Promise.resolve({ status: 'complete' as const });
    }
    if (phase === 'starting') {
      sharedStopPromise = performInitCleanup('cancelled').then(() => ({
        status: 'complete' as const,
      }));
      return sharedStopPromise;
    }

    // Send stop command
    if (child?.stdin && !child.stdin.destroyed) {
      child.stdin.write(JSON.stringify({ version: 1, type: 'stop' }) + '\n');
    }

    sharedStopPromise = doFinalize(undefined);
    return sharedStopPromise;
  }

  /* ── snapshot() ───────────────────────────────────────────── */

  function snapshot(): CaptureStatusSnapshot {
    return {
      state: phase === 'done' ? 'idle' : (phase as SessionState),
      channels: {
        interviewer: { ...channelStates.interviewer },
        you: { ...channelStates.you },
      },
      acceptedTimelineBlocks: acceptedBlocks(),
      canCancel: phase === 'starting',
      canStop: phase === 'recording',
    };
  }

  /* ── public API ───────────────────────────────────────────── */

  return {
    start(): Promise<StartCaptureResult> {
      if (!startPromise) startPromise = doStart();
      return startPromise;
    },
    cancel(): Promise<StopCaptureResult> {
      return doStop();
    },
    stop(): Promise<StopCaptureResult> {
      return doStop();
    },
    snapshot,
    onStatusChange(callback: () => void): () => void {
      statusSubscribers.add(callback);
      return () => statusSubscribers.delete(callback);
    },
    get events(): readonly string[] {
      return events;
    },
  };
}
