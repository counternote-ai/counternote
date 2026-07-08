import { app, BrowserWindow, ipcMain, session, desktopCapturer } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { WavWriter } from './wav-writer';
import { transcribeRecording } from './transcription';
import { TrayManager } from './tray';

let mainWindow: BrowserWindow | null = null;
let wavWriter: WavWriter | null = null;
let trayManager: TrayManager | null = null;

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

  // Create tray
  trayManager = new TrayManager(mainWindow);

  // Update tray when recording state changes
  ipcMain.on('recording-state-changed', (event, isRecording: boolean) => {
    trayManager?.setRecording(isRecording);
  });
}

// IPC handlers for recording
ipcMain.handle('start-recording', async () => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const recordingsDir = path.join(os.homedir(), 'InterviewCopilot', 'recordings', timestamp);

  // Create directory
  fs.mkdirSync(recordingsDir, { recursive: true });

  const audioPath = path.join(recordingsDir, 'audio.wav');
  wavWriter = new WavWriter(audioPath, 16000, 2);

  console.log('Recording started:', audioPath);
  return { success: true, path: audioPath };
});

ipcMain.handle('stop-recording', async () => {
  if (wavWriter) {
    await wavWriter.close();
    wavWriter = null;
    console.log('Recording stopped');
  }
  return { success: true };
});

ipcMain.on('audio-data', (event, data: ArrayBuffer) => {
  if (wavWriter) {
    wavWriter.write(Buffer.from(data));
  }
});

ipcMain.handle('list-recordings', async () => {
  try {
    const recordingsDir = path.join(os.homedir(), 'InterviewCopilot', 'recordings');
    if (!fs.existsSync(recordingsDir)) {
      return { success: true, recordings: [] };
    }

    const entries = fs.readdirSync(recordingsDir, { withFileTypes: true });
    const recordings = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dirPath = path.join(recordingsDir, entry.name);
        const audioPath = path.join(dirPath, 'audio.wav');
        const transcriptPath = path.join(dirPath, 'transcript.json');

        if (!fs.existsSync(audioPath)) {
          return null;
        }

        const stat = fs.statSync(audioPath);
        const hasTranscript = fs.existsSync(transcriptPath);

        return {
          id: entry.name,
          title: `Interview — ${new Date(entry.name).toLocaleDateString()}`,
          duration: 0, // Will be calculated from audio file
          audioPath,
          transcriptPath,
          transcribed: hasTranscript,
        };
      })
      .filter(Boolean);

    return { success: true, recordings };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
});

ipcMain.handle('transcribe', async (event, audioPath: string) => {
  try {
    const transcript = await transcribeRecording(audioPath);
    return { success: true, transcript };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
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
