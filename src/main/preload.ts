import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  onCaptureReady: (callback: () => void) => ipcRenderer.on('capture-ready', callback),
  sendAudioData: (data: ArrayBuffer) => ipcRenderer.send('audio-data', data),
  startRecording: () => ipcRenderer.invoke('start-recording'),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  listRecordings: () => ipcRenderer.invoke('list-recordings'),
  transcribe: (audioPath: string) => ipcRenderer.invoke('transcribe', audioPath),
  exportTranscript: (transcriptPath: string, format: string) => ipcRenderer.invoke('export-transcript', transcriptPath, format),
});
