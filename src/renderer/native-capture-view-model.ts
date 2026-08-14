/* ── Native capture view model ───────────────────────────────────
 *
 * Pure translation from protocol-facing status codes to user-facing
 * copy. React components stay declarative; all mapping logic lives
 * here.
 *
 * No Electron, IPC, or filesystem imports.
 * ──────────────────────────────────────────────────────────────── */

/* ── View types ──────────────────────────────────────────────── */

export type HealthTone = 'ok' | 'warning' | 'error' | 'idle';

export interface ChannelHealthView {
  readonly label: string;
  readonly statusText: string;
  readonly tone: HealthTone;
  readonly ariaLabel: string;
}

export interface RecordingHealthView {
  readonly state: ControllerState;
  readonly startingMessage: string | null;
  readonly finishingMessage: string | null;
  readonly channels: [ChannelHealthView, ChannelHealthView];
  readonly ariaSummary: string;
  readonly canCancel: boolean;
  readonly canStop: boolean;
}

export interface RecoveryItemView {
  readonly id: string;
  readonly dateLabel: string;
  readonly sizeLabel: string;
  readonly stateLabel: string;
  readonly state: 'recoverable' | 'not-recoverable' | 'recovering';
}

export interface RecoveryListView {
  readonly notice: string;
  readonly items: RecoveryItemView[];
  readonly totalBytes: number;
}

/* ── Channel status mapping ──────────────────────────────────── */

type ControllerState = 'idle' | 'starting' | 'recording' | 'finishing';

interface ChannelHealth {
  readonly status: string;
  readonly started: boolean;
}

const CHANNEL_STATUS_COPY: Record<string, { text: string; tone: HealthTone }> = {
  connected: { text: 'Connected', tone: 'ok' },
  'connected-with-gap': { text: 'Connected (gap detected)', tone: 'warning' },
  reconnecting: { text: 'Reconnecting…', tone: 'warning' },
  disconnected: { text: 'Disconnected', tone: 'error' },
  'no-audio-detected': { text: 'No audio detected', tone: 'warning' },
  'format-limit': { text: 'Format limit reached', tone: 'error' },
  'helper-exit': { text: 'Connection lost', tone: 'error' },
  idle: { text: 'Waiting', tone: 'idle' },
};

function resolveChannelCopy(status: string): { text: string; tone: HealthTone } {
  return CHANNEL_STATUS_COPY[status] ?? { text: status, tone: 'idle' };
}

export function toChannelHealthView(
  channel: ChannelHealth,
  label: string,
): ChannelHealthView {
  const { text, tone } = resolveChannelCopy(channel.status);
  return {
    label,
    statusText: text,
    tone,
    ariaLabel: `${label}: ${text}`,
  };
}

/* ── Recording health view ───────────────────────────────────── */

interface SnapshotInput {
  readonly state: ControllerState;
  readonly recordingId: string | undefined;
  readonly canCancel: boolean;
  readonly canStop: boolean;
  readonly channels: {
    readonly interviewer: ChannelHealth;
    readonly you: ChannelHealth;
  };
}

export function toRecordingHealthView(snapshot: SnapshotInput): RecordingHealthView {
  const interviewer = toChannelHealthView(snapshot.channels.interviewer, 'Interviewer');
  const you = toChannelHealthView(snapshot.channels.you, 'You');

  return {
    state: snapshot.state,
    startingMessage: snapshot.state === 'starting' ? 'Starting…' : null,
    finishingMessage: snapshot.state === 'finishing' ? 'Finishing recording before quitting…' : null,
    channels: [interviewer, you],
    ariaSummary: `${interviewer.ariaLabel}. ${you.ariaLabel}.`,
    canCancel: snapshot.canCancel,
    canStop: snapshot.canStop,
  };
}

/* ── Start error mapping ─────────────────────────────────────── */

type StartResult =
  | { readonly ok: true; readonly recordingId: string }
  | { readonly ok: false; readonly reason: string };

const START_ERROR_COPY: Record<string, string> = {
  busy: 'A recording is already in progress.',
  timeout: 'Recording could not start. The audio helper did not respond.',
  'helper-error': 'Recording could not start. The audio helper encountered an error.',
  'protocol-violation': 'Recording could not start. The audio helper sent unexpected data.',
  'persistence-error': 'Recording could not start. Check available disk space.',
  'mutation-unavailable': 'A recording is already in progress.',
};

export function toStartErrorMessage(result: StartResult): string | null {
  if (result.ok) return null;
  if (result.reason === 'cancelled') return null;
  return START_ERROR_COPY[result.reason] ?? 'Recording could not start. Please try again.';
}

/* ── Stop feedback mapping ───────────────────────────────────── */

type StopResult =
  | { readonly status: 'complete' }
  | { readonly status: 'interrupted' }
  | { readonly status: 'failed'; readonly category: string }
  | { readonly status: 'not-active' };

const STOP_FAILURE_COPY: Record<string, string> = {
  capacity: 'Recording stopped unexpectedly. Check available disk space.',
  access: 'Recording stopped unexpectedly. The audio file could not be saved.',
  'io-finalization': 'Recording stopped unexpectedly. The audio file could not be finalized.',
};

export function toStopFeedback(result: StopResult): string | null {
  if (result.status === 'complete' || result.status === 'not-active') return null;
  if (result.status === 'interrupted') return 'Recording was interrupted. Partial audio was saved.';
  return STOP_FAILURE_COPY[result.category] ?? 'Recording stopped unexpectedly.';
}

/* ── Recovery item mapping ───────────────────────────────────── */

interface RecoveryItemInput {
  readonly id: string;
  readonly createdAt: string;
  readonly bytes: number;
  readonly state: 'recoverable' | 'not-recoverable';
}

export function toRecoveryItemView(item: RecoveryItemInput): RecoveryItemView {
  return {
    id: item.id,
    dateLabel: formatDate(item.createdAt),
    sizeLabel: formatBytes(item.bytes),
    stateLabel:
      item.state === 'recoverable'
        ? 'Partial audio can be recovered'
        : 'Partial audio could not be repaired',
    state: item.state,
  };
}

export function toRecoveringItemView(item: RecoveryItemView): RecoveryItemView {
  return {
    ...item,
    stateLabel: 'Recovering partial recording…',
    state: 'recovering',
  };
}

/* ── Recovery list mapping ───────────────────────────────────── */

export function toRecoveryListView(items: RecoveryItemInput[]): RecoveryListView {
  if (items.length === 0) {
    return { notice: 'No recordings to recover', items: [], totalBytes: 0 };
  }

  let totalBytes = 0;
  for (const item of items) {
    const safeBytes = Number.isSafeInteger(item.bytes) && item.bytes >= 0 ? item.bytes : 0;
    if (totalBytes <= Number.MAX_SAFE_INTEGER - safeBytes) {
      totalBytes += safeBytes;
    } else {
      totalBytes = Number.MAX_SAFE_INTEGER;
    }
  }

  const countLabel = items.length === 1 ? '1 recording' : `${items.length} recordings`;
  return {
    notice: `${countLabel}, ${formatBytes(totalBytes)}`,
    items: items.map(toRecoveryItemView),
    totalBytes,
  };
}

/* ── Formatting utilities ────────────────────────────────────── */

export function formatBytes(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return isoString;
  }
}
