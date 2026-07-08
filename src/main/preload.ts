import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  onCaptureReady: (callback: () => void) => ipcRenderer.on('capture-ready', callback),
  sendAudioData: (data: ArrayBuffer) => ipcRenderer.send('audio-data', data),
  startRecording: () => ipcRenderer.invoke('start-recording'),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  listRecordings: () => ipcRenderer.invoke('list-recordings'),
  transcribe: (audioPath: string) => ipcRenderer.invoke('transcribe', audioPath),
  exportTranscript: (transcriptPath: string, format: string) => ipcRenderer.invoke('export-transcript', transcriptPath, format),
  saveConfig: (config: { apiKey?: string; model?: string; autoTranscribe?: boolean }) => ipcRenderer.invoke('save-config', config),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  onStopRecording: (callback: () => void) => ipcRenderer.on('stop-recording-from-tray', callback),
  onOpenSettings: (callback: () => void) => ipcRenderer.on('open-settings', callback),
});
