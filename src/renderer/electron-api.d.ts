type RecordingPermission = import('../types/recording-permissions').RecordingPermission;
type RecordingPermissionSnapshot =
  import('../types/recording-permissions').RecordingPermissionSnapshot;
type TranscriptionProvider = import('../types/transcription').TranscriptionProvider;
type TranscriptionProgress = import('../types/transcription').TranscriptionProgress;
type TranscriptionIpcResult = import('../types/transcription').TranscriptionIpcResult;
type LocalModelStatus = import('../types/transcription').LocalModelStatus;
type TranscriptionSettings = import('../types/settings').TranscriptionSettings;
type SettingsSaveIpcResult = import('../types/settings').SettingsSaveIpcResult;
type SettingsLoadIpcResult = import('../types/settings').SettingsLoadIpcResult;
type TranscriptExportIpcResult = import('../types/settings').TranscriptExportIpcResult;

// CSS module declarations
declare module '*.css' {}

// Type declarations for Electron API exposed via preload
interface Recording {
  id: string;
  title: string;
  duration: number;
  transcribed: boolean;
  segments?: Array<{ start: number; end: number; text: string; speaker: string }>;
}

interface ElectronAPI {
  onCaptureReady: (callback: () => void) => void;
  sendAudioData: (data: ArrayBuffer) => void;
  startRecording: () => Promise<{ success: boolean }>;
  stopRecording: () => Promise<{ success: boolean }>;
  listRecordings: () => Promise<{ success: boolean; recordings: Recording[] }>;
  transcribe: (recordingId: string) => Promise<TranscriptionIpcResult>;
  onTranscriptionProgress: (callback: (progress: TranscriptionProgress) => void) => () => void;
  getLocalModelStatus: () => Promise<LocalModelStatus>;
  installLocalModel: () => Promise<TranscriptionIpcResult>;
  onLocalModelStatus: (callback: (status: LocalModelStatus) => void) => () => void;
  exportTranscript: (recordingId: string, format: 'txt') => Promise<TranscriptExportIpcResult>;
  saveConfig: (config: Partial<TranscriptionSettings>) => Promise<SettingsSaveIpcResult>;
  loadConfig: () => Promise<SettingsLoadIpcResult>;
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
