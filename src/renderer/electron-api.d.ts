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
  transcribe: (audioPath: string) => Promise<{ success: boolean }>;
  exportTranscript: (transcriptPath: string, format: string) => Promise<{ success: boolean }>;
}

interface Window {
  electronAPI: ElectronAPI;
}
