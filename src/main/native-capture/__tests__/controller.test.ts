import type {
  NativeCaptureSession,
  StartCaptureResult,
  StopCaptureResult,
  CaptureStatusSnapshot,
} from '../session';
import type { RecordingMutationLease } from '../../recording-mutation-coordinator';
import type {
  RecordingRecoveryItem,
  RecoverRecordingResult,
  TrashRecoveryResult,
} from '../../recovery-service';
import type {
  NativeCaptureController,
  NativeCaptureControllerDeps,
  ControllerSnapshot,
} from '../controller';
import { createNativeCaptureController } from '../controller';

/* ── Fake session ──────────────────────────────────────────────── */

class FakeSession implements NativeCaptureSession {
  private startResult: StartCaptureResult = { ok: true };
  private stopResult: StopCaptureResult = { status: 'complete' };
  private _snapshot: CaptureStatusSnapshot = {
    state: 'idle',
    channels: {
      interviewer: { status: 'connected', started: false },
      you: { status: 'connected', started: false },
    },
    acceptedTimelineBlocks: 0,
    canCancel: false,
    canStop: false,
  };

  startCalls = 0;
  cancelCalls = 0;
  stopCalls = 0;
  private readonly statusSubscribers = new Set<() => void>();

  setStartResult(result: StartCaptureResult): void {
    this.startResult = result;
  }

  setStopResult(result: StopCaptureResult): void {
    this.stopResult = result;
  }

  setSnapshot(snapshot: Partial<CaptureStatusSnapshot>): void {
    this._snapshot = { ...this._snapshot, ...snapshot };
  }

  emitStatus(): void {
    for (const subscriber of this.statusSubscribers) subscriber();
  }

  async start(): Promise<StartCaptureResult> {
    this.startCalls++;
    return this.startResult;
  }

  async cancel(): Promise<StopCaptureResult> {
    this.cancelCalls++;
    return this.stopResult;
  }

  async stop(): Promise<StopCaptureResult> {
    this.stopCalls++;
    return this.stopResult;
  }

  snapshot(): CaptureStatusSnapshot {
    return this._snapshot;
  }

  onStatusChange(callback: () => void): () => void {
    this.statusSubscribers.add(callback);
    return () => this.statusSubscribers.delete(callback);
  }
}

/* ── Fake mutation coordinator ─────────────────────────────────── */

class FakeLease implements RecordingMutationLease {
  readonly kind = 'capture' as const;
  released = false;
  release(): void {
    this.released = true;
  }
}

class FakeMutationCoordinator {
  private owner: string | undefined;
  private closing = false;
  lease: FakeLease;

  constructor() {
    this.lease = new FakeLease();
  }

  tryAcquire(_kind: string): RecordingMutationLease | undefined {
    if (this.closing || this.owner !== undefined) return undefined;
    this.owner = _kind;
    const lease = this.lease;
    const originalRelease = lease.release.bind(lease);
    lease.release = (): void => {
      originalRelease();
      this.owner = undefined;
    };
    return lease;
  }

  closeAndDrain(): Promise<void> {
    this.closing = true;
    return Promise.resolve();
  }

  snapshot(): { owner?: string; closing: boolean } {
    return this.owner === undefined
      ? { closing: this.closing }
      : { owner: this.owner, closing: this.closing };
  }
}

/* ── Fake recovery service ─────────────────────────────────────── */

class FakeRecoveryService {
  listCalls = 0;
  recoverCalls: string[] = [];
  trashCalls: string[] = [];
  lastActiveSessionId: string | undefined;

  listResult: RecordingRecoveryItem[] = [];
  recoverResult: RecoverRecordingResult = { outcome: 'recovered' };
  trashResult: TrashRecoveryResult = { outcome: 'trashed' };

  async list(activeSessionId?: string): Promise<RecordingRecoveryItem[]> {
    this.listCalls++;
    this.lastActiveSessionId = activeSessionId;
    return this.listResult;
  }

  async recover(id: string): Promise<RecoverRecordingResult> {
    this.recoverCalls.push(id);
    return this.recoverResult;
  }

  async moveToTrash(id: string): Promise<TrashRecoveryResult> {
    this.trashCalls.push(id);
    return this.trashResult;
  }
}

/* ── Controller tests ──────────────────────────────────────────── */

describe('NativeCaptureController', () => {
  let session: FakeSession;
  let coordinator: FakeMutationCoordinator;
  let recovery: FakeRecoveryService;
  let controller: NativeCaptureController;
  let now: Date;

  function createDeps(
    overrides?: Partial<NativeCaptureControllerDeps>,
  ): NativeCaptureControllerDeps {
    return {
      mutationCoordinator:
        coordinator as unknown as NativeCaptureControllerDeps['mutationCoordinator'],
      recoveryService: recovery as unknown as NativeCaptureControllerDeps['recoveryService'],
      now: () => now,
      createSession: () => session,
      ...overrides,
    };
  }

  beforeEach(() => {
    session = new FakeSession();
    coordinator = new FakeMutationCoordinator();
    recovery = new FakeRecoveryService();
    now = new Date('2026-08-13T12:00:00.000Z');
    controller = createNativeCaptureController(createDeps());
  });

  /* ── startRecording ────────────────────────────────────────── */

  describe('startRecording', () => {
    it('starts a recording session and returns ok with recordingId', async () => {
      const result = await controller.startRecording();

      expect(result).toEqual({ ok: true, recordingId: expect.any(String) });
      expect(session.startCalls).toBe(1);
    });

    it('returns busy when already recording', async () => {
      session.setSnapshot({ state: 'recording', canStop: true });
      await controller.startRecording();

      const result = await controller.startRecording();

      expect(result).toEqual({ ok: false, reason: 'busy' });
      expect(session.startCalls).toBe(1);
    });

    it('returns busy when session is starting', async () => {
      // Make start() hang so we stay in 'starting' state
      let startResolve: (r: StartCaptureResult) => void;
      session.setStartResult({ ok: true });
      session.start = () => {
        session.setSnapshot({ state: 'starting', canCancel: true });
        return new Promise<StartCaptureResult>((resolve) => {
          startResolve = resolve;
        });
      };

      const first = controller.startRecording();
      // Let the event loop tick so session snapshot updates
      await new Promise((r) => setImmediate(r));
      session.setSnapshot({ state: 'starting', canCancel: true });

      const result = await controller.startRecording();

      expect(result).toEqual({ ok: false, reason: 'busy' });

      // Clean up: resolve the hanging start
      startResolve!({ ok: true });
      await first;
    });

    it('returns busy when session is stopping', async () => {
      session.setSnapshot({ state: 'recording', canStop: true });
      await controller.startRecording();

      // Make stop() hang so we stay in 'stopping' state
      let stopResolve: (r: StopCaptureResult) => void;
      session.stop = () => {
        session.setSnapshot({ state: 'stopping' });
        return new Promise<StopCaptureResult>((resolve) => {
          stopResolve = resolve;
        });
      };

      const stopPromise = controller.stopRecording();
      await new Promise((r) => setImmediate(r));
      session.setSnapshot({ state: 'stopping' });

      const result = await controller.startRecording();

      expect(result).toEqual({ ok: false, reason: 'busy' });

      stopResolve!({ status: 'complete' });
      await stopPromise;
    });

    it('maps session start failure reason to controller result', async () => {
      session.setStartResult({ ok: false, reason: 'timeout' });

      const result = await controller.startRecording();

      expect(result).toEqual({ ok: false, reason: 'timeout' });
    });

    it('maps mutation-unavailable to busy', async () => {
      session.setStartResult({ ok: false, reason: 'mutation-unavailable' });

      const result = await controller.startRecording();

      expect(result).toEqual({ ok: false, reason: 'busy' });
    });
  });

  /* ── cancelRecording ───────────────────────────────────────── */

  describe('cancelRecording', () => {
    it('delegates to session cancel when starting', async () => {
      let startResolve: (r: StartCaptureResult) => void;
      session.start = () => {
        session.setSnapshot({ state: 'starting', canCancel: true });
        return new Promise<StartCaptureResult>((resolve) => {
          startResolve = resolve;
        });
      };

      const startPromise = controller.startRecording();
      await new Promise((r) => setImmediate(r));
      session.setSnapshot({ state: 'starting', canCancel: true });

      const result = await controller.cancelRecording();

      expect(result).toEqual({ status: 'complete' });
      expect(session.cancelCalls).toBe(1);

      startResolve!({ ok: false, reason: 'cancelled' });
      await startPromise;
    });

    it('returns not-active when idle', async () => {
      const result = await controller.cancelRecording();

      expect(result).toEqual({ status: 'not-active' });
      expect(session.cancelCalls).toBe(0);
    });
  });

  /* ── stopRecording ─────────────────────────────────────────── */

  describe('stopRecording', () => {
    it('delegates to session stop', async () => {
      session.setSnapshot({ state: 'recording', canStop: true });
      await controller.startRecording();

      const result = await controller.stopRecording();

      expect(result).toEqual({ status: 'complete' });
      expect(session.stopCalls).toBe(1);
    });

    it('is idempotent: repeated stop returns same result', async () => {
      session.setSnapshot({ state: 'recording', canStop: true });
      await controller.startRecording();

      const first = await controller.stopRecording();
      const second = await controller.stopRecording();

      expect(first).toEqual(second);
      expect(session.stopCalls).toBe(1);
    });

    it('returns not-active when idle', async () => {
      const result = await controller.stopRecording();

      expect(result).toEqual({ status: 'not-active' });
      expect(session.stopCalls).toBe(0);
    });
  });

  /* ── recovery while recording ──────────────────────────────── */

  describe('recovery during recording', () => {
    it('returns busy when trying to recover while recording', async () => {
      session.setSnapshot({ state: 'recording', canStop: true });
      await controller.startRecording();

      const result = await controller.recoverRecording('12345678-1234-1234-1234-123456789abc');

      expect(result).toEqual({ outcome: 'busy' });
      expect(recovery.recoverCalls).toHaveLength(0);
    });

    it('returns busy when trying to trash while recording', async () => {
      session.setSnapshot({ state: 'recording', canStop: true });
      await controller.startRecording();

      const result = await controller.trashRecovery('12345678-1234-1234-1234-123456789abc');

      expect(result).toEqual({ outcome: 'busy' });
      expect(recovery.trashCalls).toHaveLength(0);
    });
  });

  /* ── recording during recovery ─────────────────────────────── */

  describe('recording during recovery', () => {
    it('returns busy when session reports mutation-unavailable', async () => {
      session.setStartResult({ ok: false, reason: 'mutation-unavailable' });

      const result = await controller.startRecording();

      expect(result).toEqual({ ok: false, reason: 'busy' });
    });
  });

  /* ── status broadcasting ───────────────────────────────────── */

  describe('status subscription', () => {
    it('calls subscriber with initial snapshot on subscribe', () => {
      const snapshots: ControllerSnapshot[] = [];
      controller.onStatusChange((snapshot: ControllerSnapshot) => snapshots.push(snapshot));

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].state).toBe('idle');
    });

    it('broadcasts snapshot after start', async () => {
      const snapshots: ControllerSnapshot[] = [];
      controller.onStatusChange((snapshot: ControllerSnapshot) => snapshots.push(snapshot));

      session.setSnapshot({ state: 'recording', canStop: true });
      await controller.startRecording();

      // Should have: initial idle + after start recording
      expect(snapshots.length).toBeGreaterThanOrEqual(2);
      const last = snapshots[snapshots.length - 1];
      expect(last.state).toBe('recording');
    });

    it('broadcasts starting while session initialization is pending', async () => {
      let resolveStart: (result: StartCaptureResult) => void;
      session.start = () => {
        session.setSnapshot({ state: 'starting', canCancel: true });
        return new Promise<StartCaptureResult>((resolve) => {
          resolveStart = resolve;
        });
      };
      const snapshots: ControllerSnapshot[] = [];
      controller.onStatusChange((snapshot) => snapshots.push(snapshot));

      const start = controller.startRecording();

      expect(snapshots[snapshots.length - 1]?.state).toBe('starting');
      resolveStart!({ ok: true });
      await start;
    });

    it('broadcasts automatic session completion', async () => {
      session.setSnapshot({ state: 'recording', canStop: true });
      const snapshots: ControllerSnapshot[] = [];
      controller.onStatusChange((snapshot) => snapshots.push(snapshot));
      await controller.startRecording();

      session.setSnapshot({ state: 'idle', canStop: false });
      session.emitStatus();

      expect(snapshots[snapshots.length - 1]?.state).toBe('idle');
    });

    it('broadcasts snapshot after stop', async () => {
      session.setSnapshot({ state: 'recording', canStop: true });
      await controller.startRecording();

      const snapshots: ControllerSnapshot[] = [];
      controller.onStatusChange((snapshot: ControllerSnapshot) => snapshots.push(snapshot));

      session.setSnapshot({ state: 'idle' });
      await controller.stopRecording();

      // Should have: initial + after stop
      expect(snapshots.length).toBeGreaterThanOrEqual(2);
      const last = snapshots[snapshots.length - 1];
      expect(last.state).toBe('idle');
    });

    it('returns unsubscribe function that stops delivery', () => {
      const snapshots: ControllerSnapshot[] = [];
      const unsubscribe = controller.onStatusChange((snapshot: ControllerSnapshot) =>
        snapshots.push(snapshot),
      );

      const countBefore = snapshots.length;
      unsubscribe();

      // Trigger a state change
      controller.startRecording();

      expect(snapshots).toHaveLength(countBefore);
    });
  });

  /* ── recovery list ─────────────────────────────────────────── */

  describe('listRecovery', () => {
    it('returns recovery items from the recovery service', async () => {
      recovery.listResult = [
        {
          id: '12345678-1234-1234-1234-123456789abc',
          createdAt: '2026-08-13T00:00:00.000Z',
          bytes: 1024,
          state: 'recoverable',
        },
      ];

      const items = await controller.listRecovery();

      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('12345678-1234-1234-1234-123456789abc');
      expect(recovery.listCalls).toBe(1);
    });

    it('passes active recording ID to exclude from recovery list', async () => {
      session.setSnapshot({ state: 'recording', canStop: true });
      await controller.startRecording();

      await controller.listRecovery();

      expect(recovery.listCalls).toBe(1);
      expect(recovery.lastActiveSessionId).toBeDefined();
    });
  });

  /* ── library refresh only after publication ────────────────── */

  describe('library refresh only after publication', () => {
    it('excludes active recording from recovery list while recording', async () => {
      session.setSnapshot({ state: 'recording', canStop: true });
      await controller.startRecording();

      await controller.listRecovery();

      // Active recording must be excluded so it does not appear as a recovery item
      expect(recovery.lastActiveSessionId).toBeDefined();
    });

    it('removes active exclusion from recovery list after stop completes', async () => {
      session.setSnapshot({ state: 'recording', canStop: true });
      await controller.startRecording();

      session.setSnapshot({ state: 'idle' });
      await controller.stopRecording();

      await controller.listRecovery();

      // After stop and publication, there is no active session to exclude
      expect(recovery.lastActiveSessionId).toBeUndefined();
    });

    it('keeps active exclusion from recovery list during finishing state', async () => {
      session.setSnapshot({ state: 'recording', canStop: true });
      await controller.startRecording();

      let stopResolve: (r: StopCaptureResult) => void;
      session.stop = () => {
        session.setSnapshot({ state: 'stopping' });
        return new Promise<StopCaptureResult>((resolve) => {
          stopResolve = resolve;
        });
      };

      const stopPromise = controller.stopRecording();
      await new Promise((r) => setImmediate(r));
      session.setSnapshot({ state: 'stopping' });

      // During finishing, publication has not yet occurred
      await controller.listRecovery();
      expect(recovery.lastActiveSessionId).toBeDefined();

      stopResolve!({ status: 'complete' });
      await stopPromise;
    });
  });

  /* ── snapshot safety ────────────────────────────────────────── */

  describe('snapshot safety', () => {
    it('returns snapshot with expected shape', () => {
      const snapshot = controller.snapshot();

      expect(snapshot).toHaveProperty('state');
      expect(snapshot).toHaveProperty('canCancel');
      expect(snapshot).toHaveProperty('canStop');
      expect(snapshot).toHaveProperty('recordingId');
      expect(snapshot).toHaveProperty('channels');
    });

    it('includes channel data from the session', async () => {
      session.setSnapshot({
        state: 'recording',
        canStop: true,
        channels: {
          interviewer: { status: 'connected', started: true },
          you: { status: 'reconnecting', started: true },
        },
      });
      await controller.startRecording();

      const snapshot = controller.snapshot();

      expect(snapshot.channels.interviewer.status).toBe('connected');
      expect(snapshot.channels.interviewer.started).toBe(true);
      expect(snapshot.channels.you.status).toBe('reconnecting');
      expect(snapshot.channels.you.started).toBe(true);
    });

    it('returns idle channels when no session is active', () => {
      const snapshot = controller.snapshot();

      expect(snapshot.channels.interviewer.status).toBe('idle');
      expect(snapshot.channels.interviewer.started).toBe(false);
      expect(snapshot.channels.you.status).toBe('idle');
      expect(snapshot.channels.you.started).toBe(false);
    });

    it('never exposes native errors or paths in snapshot', () => {
      const snapshot = controller.snapshot();
      const json = JSON.stringify(snapshot);

      expect(json).not.toContain('/tmp');
      expect(json).not.toContain('.wav');
      expect(json).not.toContain('Error');
    });
  });

  /* ── controller state mapping ──────────────────────────────── */

  describe('state mapping', () => {
    it('maps session idle to controller idle', () => {
      session.setSnapshot({ state: 'idle' });

      expect(controller.snapshot().state).toBe('idle');
    });

    it('maps session starting to controller starting', async () => {
      let startResolve: (r: StartCaptureResult) => void;
      session.start = () => {
        session.setSnapshot({ state: 'starting', canCancel: true });
        return new Promise<StartCaptureResult>((resolve) => {
          startResolve = resolve;
        });
      };

      const startPromise = controller.startRecording();
      await new Promise((r) => setImmediate(r));
      session.setSnapshot({ state: 'starting', canCancel: true });

      expect(controller.snapshot().state).toBe('starting');

      startResolve!({ ok: true });
      await startPromise;
    });

    it('maps session recording to controller recording', async () => {
      session.setSnapshot({ state: 'recording', canStop: true });
      await controller.startRecording();

      expect(controller.snapshot().state).toBe('recording');
    });

    it('maps session stopping to controller finishing', async () => {
      session.setSnapshot({ state: 'recording', canStop: true });
      await controller.startRecording();

      // Make stop() hang so we stay in 'stopping' state
      let stopResolve: (r: StopCaptureResult) => void;
      session.stop = () => {
        session.setSnapshot({ state: 'stopping' });
        return new Promise<StopCaptureResult>((resolve) => {
          stopResolve = resolve;
        });
      };

      const stopPromise = controller.stopRecording();
      await new Promise((r) => setImmediate(r));
      session.setSnapshot({ state: 'stopping' });

      // While stop is in progress, controller should show 'finishing'
      expect(controller.snapshot().state).toBe('finishing');

      // After stop completes, controller should show 'idle'
      stopResolve!({ status: 'complete' });
      await stopPromise;

      expect(controller.snapshot().state).toBe('idle');
    });
  });
});
