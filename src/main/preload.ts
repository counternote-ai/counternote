import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  onCaptureReady: (callback: () => void) => ipcRenderer.on('capture-ready', callback),
});
