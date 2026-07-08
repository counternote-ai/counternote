import { app, BrowserWindow, ipcMain, session, desktopCapturer } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { WavWriter } from './wav-writer';
import { transcribeRecording } from './transcription';
import { TrayManager } from './tray';
import { saveExport } from './export';
import { loadConfig, saveConfig, getGroqApiKey, setGroqApiKey } from './config';
import { getAudioDuration } from './audio-processor';

let mainWindow: BrowserWindow | null = null;
let wavWriter: WavWriter | null = null;
let trayManager: TrayManager | null = null;

// Set app name for macOS menu bar and Activity Monitor
app.name = 'Interview Copilot';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    title: 'Interview Copilot',
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

  // Update tray to show recording state
  trayManager?.setRecording(true);

  console.log('Recording started:', audioPath);
  return { success: true, path: audioPath };
});

ipcMain.handle('stop-recording', async () => {
  if (wavWriter) {
    await wavWriter.close();
    wavWriter = null;
    console.log('Recording stopped');
  }
  // Update tray to hide recording state
  trayManager?.setRecording(false);
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
    const recordings = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const dirPath = path.join(recordingsDir, entry.name);
          const audioPath = path.join(dirPath, 'audio.wav');
          const transcriptPath = path.join(dirPath, 'transcript.json');

          if (!fs.existsSync(audioPath)) {
            return null;
          }

          let duration = 0;
          try {
            duration = await getAudioDuration(audioPath);
          } catch (err) {
            console.error('Failed to get audio duration:', err);
          }

          const hasTranscript = fs.existsSync(transcriptPath);

          // Load transcript segments if available
          let segments: any[] | undefined;
          if (hasTranscript) {
            try {
              const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));
              segments = transcript.segments;
            } catch (err) {
              console.error('Failed to read transcript:', err);
            }
          }

          // Convert directory name back to ISO format for date parsing
          // Format: 2026-07-08T05-41-50-570Z -> 2026-07-08T05:41:50.570Z
          const isoDate = entry.name
            .replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z')
            .replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
          const date = new Date(isoDate);

          return {
            id: entry.name,
            title: `Interview — ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`,
            duration,
            audioPath,
            transcriptPath,
            transcribed: hasTranscript,
            segments,
          };
        })
    );

    return { success: true, recordings: recordings.filter(Boolean) };
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

ipcMain.handle('export-transcript', async (event, transcriptPath: string, format: 'txt') => {
  try {
    const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));
    const exportPath = saveExport(transcript, format, transcriptPath);
    return { success: true, path: exportPath };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
});

// Settings IPC handlers
ipcMain.handle('save-config', async (event, config: { apiKey?: string; model?: string; autoTranscribe?: boolean }) => {
  try {
    // Save API key via safeStorage if provided
    if (config.apiKey !== undefined) {
      await setGroqApiKey(config.apiKey);
    }
    // Save other config fields
    const currentConfig = loadConfig();
    saveConfig({
      ...currentConfig,
      ...(config.model !== undefined && { groqModel: config.model }),
      ...(config.autoTranscribe !== undefined && { autoTranscribe: config.autoTranscribe }),
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
});

ipcMain.handle('load-config', async () => {
  try {
    const config = loadConfig();
    const apiKey = await getGroqApiKey();
    return {
      success: true,
      config: {
        apiKey: apiKey || '',
        model: config.groqModel,
        autoTranscribe: config.autoTranscribe,
      },
    };
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
          throw new Error('No screen sources available for display media capture');
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
