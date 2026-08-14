import type {
  NativeCaptureSession,
  StartFailureReason,
  StopCaptureResult,
  SessionState,
  ChannelStatus,
} from './session';
import type { RecordingMutationCoordinator } from '../recording-mutation-coordinator';
import type {
  RecordingRecoveryItem,
  RecoverRecordingResult,
  TrashRecoveryResult,
} from '../recovery-service';

/* ── Public types ─────────────────────────────────────────────── */

export type ControllerState = 'idle' | 'starting' | 'recording' | 'finishing';

export interface ControllerSnapshot {
  readonly state: ControllerState;
  readonly recordingId: string | undefined;
  readonly canCancel: boolean;
  readonly canStop: boolean;
  readonly channels: {
    readonly interviewer: ChannelStatus;
    readonly you: ChannelStatus;
  };
}

export type ControllerStartResult =
  | { readonly ok: true; readonly recordingId: string }
  | { readonly ok: false; readonly reason: StartFailureReason | 'busy' };

export type ControllerStopResult =
  | { readonly status: 'complete' }
  | { readonly status: 'interrupted' }
  | { readonly status: 'failed'; readonly category: 'capacity' | 'access' | 'io-finalization' }
  | { readonly status: 'not-active' };

export type ControllerCancelResult =
  | { readonly status: 'complete' }
  | { readonly status: 'not-active' };

export type StatusChangeCallback = (snapshot: ControllerSnapshot) => void;

export interface NativeCaptureController {
  startRecording(): Promise<ControllerStartResult>;
  cancelRecording(): Promise<ControllerCancelResult>;
  stopRecording(): Promise<ControllerStopResult>;
  snapshot(): ControllerSnapshot;
  onStatusChange(callback: StatusChangeCallback): () => void;
  listRecovery(): Promise<RecordingRecoveryItem[]>;
  recoverRecording(id: string): Promise<RecoverRecordingResult>;
  trashRecovery(id: string): Promise<TrashRecoveryResult>;
}

export interface NativeCaptureControllerDeps {
  readonly mutationCoordinator: RecordingMutationCoordinator;
  readonly recoveryService: {
    list(activeSessionId?: string): Promise<RecordingRecoveryItem[]>;
    recover(id: string): Promise<RecoverRecordingResult>;
    moveToTrash(id: string): Promise<TrashRecoveryResult>;
  };
  readonly now: () => Date;
  readonly createSession: (recordingId: string) => NativeCaptureSession;
}

/* ── Recording ID generation ──────────────────────────────────── */

function makeRecordingId(date: Date): string {
  return date.toISOString().replace(/T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/, 'T$1-$2-$3-$4Z');
}

/* ── Session state to controller state mapping ────────────────── */

function mapSessionState(sessionState: SessionState, hasStopPromise: boolean): ControllerState {
  if (sessionState === 'idle') return 'idle';
  if (sessionState === 'starting') return 'starting';
  if (sessionState === 'recording') return 'recording';
  // sessionState === 'stopping'
  return 'finishing';
}

/* ── Factory ──────────────────────────────────────────────────── */

export function createNativeCaptureController(
  deps: NativeCaptureControllerDeps,
): NativeCaptureController {
  /* state */
  let activeSession: NativeCaptureSession | undefined;
  let activeRecordingId: string | undefined;
  let unsubscribeSessionStatus: (() => void) | undefined;
  let lastStopPromise: Promise<StopCaptureResult> | undefined;
  let lastStopResult: StopCaptureResult | undefined;
  let isRecordingActive = false;
  const subscribers = new Set<StatusChangeCallback>();

  /* helpers */

  function notifySubscribers(): void {
    const snap = snapshot();
    for (const cb of subscribers) {
      try { cb(snap); } catch { /* subscriber errors are non-fatal */ }
    }
  }

  function mapStartResult(result: { readonly ok: true } | { readonly ok: false; readonly reason: StartFailureReason }): ControllerStartResult {
    if (result.ok) {
      return { ok: true, recordingId: activeRecordingId! };
    }
    if (result.reason === 'mutation-unavailable') {
      return { ok: false, reason: 'busy' };
    }
    return { ok: false, reason: result.reason };
  }

  function mapStopResult(result: StopCaptureResult): ControllerStopResult {
    if (result.status === 'complete') return { status: 'complete' };
    if (result.status === 'interrupted') return { status: 'interrupted' };
    return { status: 'failed', category: result.category };
  }

  function isBusy(): boolean {
    if (!activeSession) return false;
    const state = activeSession.snapshot().state;
    return state !== 'idle';
  }

  const IDLE_CHANNELS: ControllerSnapshot['channels'] = {
    interviewer: { status: 'idle', started: false },
    you: { status: 'idle', started: false },
  };

  function snapshot(): ControllerSnapshot {
    if (!activeSession) {
      return {
        state: 'idle',
        recordingId: undefined,
        canCancel: false,
        canStop: false,
        channels: IDLE_CHANNELS,
      };
    }
    const sessionSnap = activeSession.snapshot();
    return {
      state: mapSessionState(sessionSnap.state, !!lastStopPromise),
      recordingId: activeRecordingId,
      canCancel: sessionSnap.canCancel,
      canStop: sessionSnap.canStop,
      channels: sessionSnap.channels,
    };
  }

  /* ── startRecording ─────────────────────────────────────────── */

  async function startRecording(): Promise<ControllerStartResult> {
    if (isBusy()) {
      return { ok: false, reason: 'busy' };
    }

    const recordingId = makeRecordingId(deps.now());
    activeRecordingId = recordingId;
    activeSession = deps.createSession(recordingId);
    const session = activeSession;
    lastStopPromise = undefined;
    lastStopResult = undefined;
    isRecordingActive = true;

    unsubscribeSessionStatus = session.onStatusChange?.(() => {
      if (activeSession !== session) return;
      if (session.snapshot().state === 'idle') {
        isRecordingActive = false;
        activeRecordingId = undefined;
        activeSession = undefined;
        unsubscribeSessionStatus?.();
        unsubscribeSessionStatus = undefined;
      }
      notifySubscribers();
    });

    const startPromise = session.start();
    notifySubscribers();
    const result = await startPromise;

    if (!result.ok) {
      if (result.reason === 'mutation-unavailable') {
        isRecordingActive = false;
        activeSession = undefined;
        activeRecordingId = undefined;
        unsubscribeSessionStatus?.();
        unsubscribeSessionStatus = undefined;
        notifySubscribers();
        return { ok: false, reason: 'busy' };
      }
      isRecordingActive = false;
      activeSession = undefined;
      activeRecordingId = undefined;
      unsubscribeSessionStatus?.();
      unsubscribeSessionStatus = undefined;
      notifySubscribers();
      return { ok: false, reason: result.reason };
    }

    return { ok: true, recordingId };
  }

  /* ── cancelRecording ────────────────────────────────────────── */

  async function cancelRecording(): Promise<ControllerCancelResult> {
    if (!activeSession || !isRecordingActive) {
      return { status: 'not-active' };
    }

    const sessionSnap = activeSession.snapshot();
    if (sessionSnap.state !== 'starting') {
      return { status: 'not-active' };
    }

    const result = await activeSession.cancel();
    lastStopResult = result;
    isRecordingActive = false;
    notifySubscribers();

    return { status: 'complete' };
  }

  /* ── stopRecording ──────────────────────────────────────────── */

  async function stopRecording(): Promise<ControllerStopResult> {
    // Idempotent: return cached result if stop already happened
    if (lastStopResult) {
      return mapStopResult(lastStopResult);
    }

    if (!activeSession || !isRecordingActive) {
      return { status: 'not-active' };
    }

    if (!lastStopPromise) {
      lastStopPromise = activeSession.stop();
      notifySubscribers();
    }

    lastStopResult = await lastStopPromise;
    isRecordingActive = false;
    activeRecordingId = undefined;
    activeSession = undefined;
    unsubscribeSessionStatus?.();
    unsubscribeSessionStatus = undefined;
    notifySubscribers();

    return mapStopResult(lastStopResult);
  }

  /* ── onStatusChange ─────────────────────────────────────────── */

  function onStatusChange(callback: StatusChangeCallback): () => void {
    subscribers.add(callback);
    // Deliver current snapshot immediately
    try { callback(snapshot()); } catch { /* non-fatal */ }
    return () => {
      subscribers.delete(callback);
    };
  }

  /* ── recovery ───────────────────────────────────────────────── */

  async function listRecovery(): Promise<RecordingRecoveryItem[]> {
    return deps.recoveryService.list(activeRecordingId);
  }

  async function recoverRecording(id: string): Promise<RecoverRecordingResult> {
    if (isBusy()) {
      return { outcome: 'busy' };
    }
    return deps.recoveryService.recover(id);
  }

  async function trashRecovery(id: string): Promise<TrashRecoveryResult> {
    if (isBusy()) {
      return { outcome: 'busy' };
    }
    return deps.recoveryService.moveToTrash(id);
  }

  /* ── public API ─────────────────────────────────────────────── */

  return {
    startRecording,
    cancelRecording,
    stopRecording,
    snapshot,
    onStatusChange,
    listRecovery,
    recoverRecording,
    trashRecovery,
  };
}
