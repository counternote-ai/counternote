import { type TranscriptionProvider } from './transcription';

export interface TranscriptionSettings {
  apiKey: string;
  model: string;
  transcriptionProvider: TranscriptionProvider;
}

export type SettingsSaveIpcResult =
  | { success: true }
  | { success: false; code: 'SETTINGS_SAVE_FAILED' };

export type SettingsLoadIpcResult =
  | { success: true; config: TranscriptionSettings }
  | { success: false; code: 'SETTINGS_LOAD_FAILED' };

export type TranscriptExportIpcResult =
  | { success: true }
  | { success: false; code: 'TRANSCRIPT_EXPORT_FAILED' };
