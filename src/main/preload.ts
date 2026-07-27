import { contextBridge, ipcRenderer } from 'electron';
import { type RecordingPermission } from '../types/recording-permissions';
import {
  type LocalModelStatus,
  type TranscriptionIpcResult,
  type TranscriptionProgress,
} from '../types/transcription';
import {
  type SettingsLoadIpcResult,
  type SettingsSaveIpcResult,
  type TranscriptExportIpcResult,
  type TranscriptionSettings,
} from '../types/settings';

contextBridge.exposeInMainWorld('electronAPI', {
  onCaptureReady: (callback: () => void) => ipcRenderer.on('capture-ready', callback),
  sendAudioData: (data: ArrayBuffer) => ipcRenderer.send('audio-data', data),
  startRecording: () => ipcRenderer.invoke('start-recording'),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  listRecordings: () => ipcRenderer.invoke('list-recordings'),
  transcribe: (recordingId: string): Promise<TranscriptionIpcResult> =>
    ipcRenderer.invoke('transcribe', recordingId),
  onTranscriptionProgress: (
    callback: (progress: TranscriptionProgress) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: TranscriptionProgress): void =>
      callback(progress);
    ipcRenderer.on('transcription-progress', listener);
    return () => ipcRenderer.removeListener('transcription-progress', listener);
  },
  getLocalModelStatus: (): Promise<LocalModelStatus> => ipcRenderer.invoke('get-local-model-status'),
  installLocalModel: (): Promise<TranscriptionIpcResult> => ipcRenderer.invoke('install-local-model'),
  onLocalModelStatus: (
    callback: (status: LocalModelStatus) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: LocalModelStatus): void =>
      callback(status);
    ipcRenderer.on('local-model-status', listener);
    return () => ipcRenderer.removeListener('local-model-status', listener);
  },
  exportTranscript: (recordingId: string, format: 'txt'): Promise<TranscriptExportIpcResult> =>
    ipcRenderer.invoke('export-transcript', recordingId, format),
  saveConfig: (config: Partial<TranscriptionSettings>): Promise<SettingsSaveIpcResult> =>
    ipcRenderer.invoke('save-config', config),
  loadConfig: (): Promise<SettingsLoadIpcResult> => ipcRenderer.invoke('load-config'),
  getRecordingPermissions: () => ipcRenderer.invoke('get-recording-permissions'),
  openRecordingPermissionSettings: (permission: RecordingPermission) =>
    ipcRenderer.invoke('open-recording-permission-settings', permission),
  onStopRecording: (callback: () => void) => ipcRenderer.on('stop-recording-from-tray', callback),
  onOpenSettings: (callback: () => void) => ipcRenderer.on('open-settings', callback),
});
