type RecordingPermission = import('../types/recording-permissions').RecordingPermission;
type RecordingPermissionSnapshot =
  import('../types/recording-permissions').RecordingPermissionSnapshot;
type TranscriptionProgress = import('../types/transcription').TranscriptionProgress;
type TranscriptionIpcResult = import('../types/transcription').TranscriptionIpcResult;
type LocalModelStatus = import('../types/transcription').LocalModelStatus;
type TranscriptExportIpcResult = import('../types/settings').TranscriptExportIpcResult;
type ShowInFinderIpcResult = import('../types/settings').ShowInFinderIpcResult;
type PersistedInterruption =
  import('../main/native-capture/capture-metadata').PersistedInterruption;

// CSS module declarations
declare module '*.css' {}

// Type declarations for Electron API exposed via preload
interface Recording {
  id: string;
  title: string;
  duration: number;
  transcribed: boolean;
  segments?: Array<{ start: number; end: number; text: string; speaker: string }>;
  captureStatus: 'legacy' | 'complete' | 'interrupted';
  interruptions: PersistedInterruption[];
}

/* ── Native capture IPC result types ────────────────────────── */

type ControllerState = 'idle' | 'starting' | 'recording' | 'finishing';

interface ChannelHealth {
  readonly status: string;
  readonly started: boolean;
}

interface RecordingStatusSnapshot {
  readonly state: ControllerState;
  readonly recordingId: string | undefined;
  readonly canCancel: boolean;
  readonly canStop: boolean;
  readonly channels: {
    readonly interviewer: ChannelHealth;
    readonly you: ChannelHealth;
  };
}

type RecordingStartResult =
  | { readonly ok: true; readonly recordingId: string }
  | {
      readonly ok: false;
      readonly reason:
        | 'busy'
        | 'cancelled'
        | 'timeout'
        | 'helper-error'
        | 'protocol-violation'
        | 'persistence-error'
        | 'mutation-unavailable';
    };

type RecordingStopResult =
  | { readonly status: 'complete' }
  | { readonly status: 'interrupted' }
  | { readonly status: 'failed'; readonly category: 'capacity' | 'access' | 'io-finalization' }
  | { readonly status: 'not-active' };

type RecordingCancelResult = { readonly status: 'complete' } | { readonly status: 'not-active' };

interface RecordingRecoveryItem {
  readonly id: string;
  readonly createdAt: string;
  readonly bytes: number;
  readonly state: 'recoverable' | 'not-recoverable';
}

type RecordingRecoverResult =
  | { readonly outcome: 'busy' }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'not-recoverable' }
  | { readonly outcome: 'recovery-failed' }
  | { readonly outcome: 'recovered' }
  | { readonly outcome: 'recovered-with-retained-source' };

type RecordingTrashResult =
  | { readonly outcome: 'busy' }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'trash-failed' }
  | { readonly outcome: 'trashed' };

/* ── ElectronAPI bridge ─────────────────────────────────────── */

interface ElectronAPI {
  listRecordings: () => Promise<{ success: boolean; recordings: Recording[] }>;
  transcribe: (recordingId: string) => Promise<TranscriptionIpcResult>;
  onTranscriptionProgress: (callback: (progress: TranscriptionProgress) => void) => () => void;
  getLocalModelStatus: () => Promise<LocalModelStatus>;
  installLocalModel: () => Promise<TranscriptionIpcResult>;
  onLocalModelStatus: (callback: (status: LocalModelStatus) => void) => () => void;
  exportTranscript: (recordingId: string, format: 'txt') => Promise<TranscriptExportIpcResult>;
  showExportedTranscript: (recordingId: string) => Promise<ShowInFinderIpcResult>;
  showRecordingFiles: (recordingId: string) => Promise<ShowInFinderIpcResult>;
  getRecordingPermissions: () => Promise<{
    success: boolean;
    permissions?: RecordingPermissionSnapshot;
    error?: string;
  }>;
  openRecordingPermissionSettings: (
    permission: RecordingPermission,
  ) => Promise<{ success: boolean; error?: string }>;
  onOpenSettings: (callback: () => void) => void;

  /* ── Native capture commands ──────────────────────────────── */
  recordingStart: () => Promise<RecordingStartResult>;
  recordingCancel: () => Promise<RecordingCancelResult>;
  recordingStop: () => Promise<RecordingStopResult>;
  recordingGetStatus: () => Promise<RecordingStatusSnapshot>;
  recordingListRecovery: () => Promise<RecordingRecoveryItem[]>;
  recordingRecover: (id: string) => Promise<RecordingRecoverResult>;
  recordingTrashRecovery: (id: string) => Promise<RecordingTrashResult>;
  onRecordingStatus: (callback: (snapshot: RecordingStatusSnapshot) => void) => () => void;
}

interface Window {
  electronAPI: ElectronAPI;
}
