type RecordingPermission = import('../types/recording-permissions').RecordingPermission;
type RecordingPermissionSnapshot =
  import('../types/recording-permissions').RecordingPermissionSnapshot;

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
  transcribe: (audioPath: string) => Promise<{ success: boolean; transcript?: any; error?: string }>;
  exportTranscript: (transcriptPath: string, format: string) => Promise<{ success: boolean; path?: string; error?: string }>;
  saveConfig: (config: {
    apiKey?: string;
    model?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  loadConfig: () => Promise<{
    success: boolean;
    config?: { apiKey: string; model: string };
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
