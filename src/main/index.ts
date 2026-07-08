import { app, BrowserWindow, ipcMain, session, desktopCapturer } from 'electron';
import * as path from 'path';

let mainWindow: BrowserWindow | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let recordingStream: any = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

// IPC handlers for recording
ipcMain.handle('start-recording', async () => {
  // TODO: Create WAV file and return write stream
  console.log('Recording started');
  return { success: true };
});

ipcMain.handle('stop-recording', async () => {
  // TODO: Finalize WAV file
  console.log('Recording stopped');
  return { success: true };
});

ipcMain.on('audio-data', (event, data: ArrayBuffer) => {
  // TODO: Write PCM data to file
  if (recordingStream) {
    recordingStream.write(Buffer.from(data));
  }
});

app.whenReady().then(() => {
  // Configure loopback audio capture
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      // Provide the first screen source with loopback audio
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        if (sources.length > 0) {
          callback({ video: sources[0], audio: 'loopback' });
        } else {
          callback({ video: sources[0] });
        }
      });
    }
  );

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
