import { contextBridge, ipcRenderer } from 'electron';
import { type RecordingPermission } from '../types/recording-permissions';

contextBridge.exposeInMainWorld('electronAPI', {
  onCaptureReady: (callback: () => void) => ipcRenderer.on('capture-ready', callback),
  sendAudioData: (data: ArrayBuffer) => ipcRenderer.send('audio-data', data),
  startRecording: () => ipcRenderer.invoke('start-recording'),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  listRecordings: () => ipcRenderer.invoke('list-recordings'),
  transcribe: (audioPath: string) => ipcRenderer.invoke('transcribe', audioPath),
  exportTranscript: (transcriptPath: string, format: string) => ipcRenderer.invoke('export-transcript', transcriptPath, format),
  saveConfig: (config: { apiKey?: string; model?: string }) =>
    ipcRenderer.invoke('save-config', config),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  getRecordingPermissions: () => ipcRenderer.invoke('get-recording-permissions'),
  openRecordingPermissionSettings: (permission: RecordingPermission) =>
    ipcRenderer.invoke('open-recording-permission-settings', permission),
  onStopRecording: (callback: () => void) => ipcRenderer.on('stop-recording-from-tray', callback),
  onOpenSettings: (callback: () => void) => ipcRenderer.on('open-settings', callback),
});
