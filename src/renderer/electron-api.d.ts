// Type declarations for Electron API exposed via preload

interface ElectronAPI {
  onCaptureReady: (callback: () => void) => void;
  sendAudioData: (data: ArrayBuffer) => void;
  startRecording: () => Promise<{ success: boolean; path?: string }>;
  stopRecording: () => Promise<{ success: boolean }>;
  listRecordings: () => Promise<string[]>;
  transcribe: (audioPath: string) => Promise<{ success: boolean }>;
  exportTranscript: (transcriptPath: string, format: string) => Promise<{ success: boolean }>;
}

interface Window {
  electronAPI: ElectronAPI;
}
