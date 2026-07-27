type RecordingPermission = import('../types/recording-permissions').RecordingPermission;
type RecordingPermissionSnapshot =
  import('../types/recording-permissions').RecordingPermissionSnapshot;
type TranscriptionProvider = import('../types/transcription').TranscriptionProvider;
type TranscriptionProgress = import('../types/transcription').TranscriptionProgress;
type TranscriptionIpcResult = import('../types/transcription').TranscriptionIpcResult;
type LocalModelStatus = import('../types/transcription').LocalModelStatus;

// CSS module declarations
declare module '*.css' {}

// Type declarations for Electron API exposed via preload
interface Recording {
  id: string;
  title: string;
  duration: number;
  transcribed: boolean;
  audioPath: string;
  transcriptPath?: string;
  segments?: Array<{ start: number; end: number; text: string; speaker: string }>;
}

interface ElectronAPI {
  onCaptureReady: (callback: () => void) => void;
  sendAudioData: (data: ArrayBuffer) => void;
  startRecording: () => Promise<{ success: boolean; path?: string }>;
  stopRecording: () => Promise<{ success: boolean }>;
  listRecordings: () => Promise<{ success: boolean; recordings: Recording[] }>;
  transcribe: (recordingId: string) => Promise<TranscriptionIpcResult>;
  onTranscriptionProgress: (callback: (progress: TranscriptionProgress) => void) => () => void;
  getLocalModelStatus: () => Promise<LocalModelStatus>;
  installLocalModel: () => Promise<TranscriptionIpcResult>;
  onLocalModelStatus: (callback: (status: LocalModelStatus) => void) => () => void;
  exportTranscript: (transcriptPath: string, format: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  saveConfig: (config: {
    apiKey?: string;
    model?: string;
    transcriptionProvider?: TranscriptionProvider;
  }) => Promise<{ success: boolean; error?: string }>;
  loadConfig: () => Promise<{
    success: boolean;
    config?: { apiKey: string; model: string; transcriptionProvider: TranscriptionProvider };
    error?: string;
  }>;
  getRecordingPermissions: () => Promise<{
    success: boolean;
    permissions?: RecordingPermissionSnapshot;
    error?: string;
  }>;
  openRecordingPermissionSettings: (
    permission: RecordingPermission
  ) => Promise<{ success: boolean; error?: string }>;
  onStopRecording: (callback: () => void) => void;
  onOpenSettings: (callback: () => void) => void;
}

interface Window {
  electronAPI: ElectronAPI;
}
