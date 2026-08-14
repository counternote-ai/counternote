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
  listRecordings: () => ipcRenderer.invoke('list-recordings'),
  transcribe: (recordingId: string): Promise<TranscriptionIpcResult> =>
    ipcRenderer.invoke('transcribe', recordingId),
  onTranscriptionProgress: (callback: (progress: TranscriptionProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: TranscriptionProgress): void =>
      callback(progress);
    ipcRenderer.on('transcription-progress', listener);
    return () => ipcRenderer.removeListener('transcription-progress', listener);
  },
  getLocalModelStatus: (): Promise<LocalModelStatus> =>
    ipcRenderer.invoke('get-local-model-status'),
  installLocalModel: (): Promise<TranscriptionIpcResult> =>
    ipcRenderer.invoke('install-local-model'),
  onLocalModelStatus: (callback: (status: LocalModelStatus) => void): (() => void) => {
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
  onOpenSettings: (callback: () => void) => ipcRenderer.on('open-settings', callback),

  /* ── Native capture commands ──────────────────────────────── */
  recordingStart: () => ipcRenderer.invoke('recording:start'),
  recordingCancel: () => ipcRenderer.invoke('recording:cancel'),
  recordingStop: () => ipcRenderer.invoke('recording:stop'),
  recordingGetStatus: () => ipcRenderer.invoke('recording:get-status'),
  recordingListRecovery: () => ipcRenderer.invoke('recording:list-recovery'),
  recordingRecover: (id: string) => ipcRenderer.invoke('recording:recover', { id }),
  recordingTrashRecovery: (id: string) => ipcRenderer.invoke('recording:trash-recovery', { id }),
  onRecordingStatus: (callback: (snapshot: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown): void =>
      callback(snapshot);
    ipcRenderer.on('recording:status', listener);
    return () => ipcRenderer.removeListener('recording:status', listener);
  },
});
