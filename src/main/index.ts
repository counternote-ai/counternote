import { app, BrowserWindow, ipcMain, session, desktopCapturer } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { WavWriter } from './wav-writer';
import { TrayManager } from './tray';
import { saveExport } from './export';
import { loadConfig, saveConfig, getGroqApiKey, setGroqApiKey } from './config';
import { getAudioDuration } from './audio-processor';
import { isChannelSilent, splitChannels } from './audio-processor';
import { AppActivityCoordinator } from './activity-coordinator';
import { RecordingsLibrary } from './recordings-library';
import {
  getRecordingPermissionSnapshot,
  openRecordingPermissionSettings,
} from './recording-permissions';
import { type RecordingPermission } from '../types/recording-permissions';
import {
  type LocalModelStatus,
  type TranscriptionErrorCode,
  type TranscriptionIpcResult,
} from '../types/transcription';
import {
  type SettingsLoadIpcResult,
  type SettingsSaveIpcResult,
  type TranscriptExportIpcResult,
  type TranscriptionSettings,
} from '../types/settings';
import { TranscriptionOrchestrator } from './transcription/orchestrator';
import { TranscriptionError } from './transcription/errors';
import { ConsoleTranscriptionLogger } from './transcription/logger';
import { LocalModelManager, ModelInstallError } from './transcription/local-model-manager';
import { PRODUCTION_MODEL_ARTIFACT, type ModelArtifactSpec } from './transcription/model-artifact';
import { HttpsModelDownloadTransport } from './transcription/model-download';
import { LocalWhisperProvider } from './transcription/local-whisper-provider';
import { GroqProvider } from './transcription/groq-provider';
import { WhisperProcessRunner } from './transcription/whisper-process';
import { resolveWhisperCliPath } from './transcription/sidecar-path';

let mainWindow: BrowserWindow | null = null;
let wavWriter: WavWriter | null = null;
let trayManager: TrayManager | null = null;
const activity = new AppActivityCoordinator();
const recordingsLibrary = new RecordingsLibrary(() => loadConfig().outputDir);
let modelService: LocalModelManager | null = null;
let transcriptionService: TranscriptionOrchestrator | null = null;
let localUnavailableStatus: LocalModelStatus | null = null;

// Set app name for macOS menu bar and Activity Monitor
app.name = 'Interview Copilot';

function e2eEnabled(): boolean {
  return !app.isPackaged && process.env.INTERVIEW_COPILOT_E2E === '1';
}

function modelArtifact(): ModelArtifactSpec {
  const manifestPath = e2eEnabled() ? process.env.INTERVIEW_COPILOT_MODEL_MANIFEST : undefined;
  if (!manifestPath) return PRODUCTION_MODEL_ARTIFACT;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
    if (!isModelArtifact(manifest)) return PRODUCTION_MODEL_ARTIFACT;
    return {
      url: new URL(manifest.url),
      fileName: manifest.fileName,
      byteSize: manifest.byteSize,
      sha256: manifest.sha256,
    };
  } catch {
    console.error('E2E model manifest could not be loaded.');
    return PRODUCTION_MODEL_ARTIFACT;
  }
}

function isModelArtifact(value: unknown): value is {
  url: string;
  fileName: string;
  byteSize: number;
  sha256: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.url === 'string'
    && typeof candidate.fileName === 'string'
    && typeof candidate.byteSize === 'number'
    && Number.isSafeInteger(candidate.byteSize)
    && candidate.byteSize > 0
    && typeof candidate.sha256 === 'string'
    && /^[a-f0-9]{64}$/i.test(candidate.sha256);
}

function getModelService(): LocalModelManager {
  if (modelService === null) {
    const artifact = modelArtifact();
    const transport = new HttpsModelDownloadTransport(artifact.byteSize);
    modelService = new LocalModelManager(
      path.join(app.getPath('userData'), 'models'),
      artifact,
      transport.download.bind(transport)
    );
  }
  return modelService;
}

function getLocalModelStatus(): Promise<LocalModelStatus> {
  if (localUnavailableStatus) return Promise.resolve(localUnavailableStatus);

  try {
    resolveWhisperCliPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      projectRoot: path.resolve(__dirname, '../..'),
      platform: process.platform,
      arch: process.arch,
    });
  } catch {
    localUnavailableStatus = {
      state: 'unavailable',
      reason: process.platform === 'darwin' && process.arch === 'arm64'
        ? 'sidecar-missing'
        : 'unsupported-platform',
    };
    return Promise.resolve(localUnavailableStatus);
  }

  return getModelService().getStatus();
}

function getTranscriptionService(): TranscriptionOrchestrator {
  if (transcriptionService !== null) return transcriptionService;

  let localProvider: LocalWhisperProvider | { transcribe: () => Promise<never> };
  try {
    const cliPath = resolveWhisperCliPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      projectRoot: path.resolve(__dirname, '../..'),
      platform: process.platform,
      arch: process.arch,
    });
    const runner = new WhisperProcessRunner();
    const manager = getModelService();
    localProvider = new LocalWhisperProvider({
      cliPath,
      ensureModel: manager.ensureModel.bind(manager),
      runProcess: runner.run.bind(runner),
      isChannelSilent,
    });
  } catch {
    localUnavailableStatus = {
      state: 'unavailable',
      reason: process.platform === 'darwin' && process.arch === 'arm64'
        ? 'sidecar-missing'
        : 'unsupported-platform',
    };
    localProvider = {
      transcribe: async (): Promise<never> => {
        throw new TranscriptionError('LOCAL_UNAVAILABLE');
      },
    };
  }

  transcriptionService = new TranscriptionOrchestrator({
    coordinator: activity,
    recordingsLibrary,
    loadConfig: () => loadConfig(),
    getGroqApiKey,
    localProvider,
    groqProvider: new GroqProvider({ fetch, setTimeout, clearTimeout }),
    splitChannels: (audioPath, output) => splitChannels(audioPath, undefined, output),
    getAudioDuration,
    fs: fs.promises,
    logger: new ConsoleTranscriptionLogger(),
  });
  return transcriptionService;
}

function transcriptionFailure(error: unknown, fallback: TranscriptionErrorCode): TranscriptionIpcResult {
  const code = error instanceof TranscriptionError || error instanceof ModelInstallError
    ? error.code
    : fallback;
  const retryAfterSeconds = error instanceof TranscriptionError
    ? error.details.retryAfterSeconds
    : undefined;
  console.error('Transcription operation failed.', { code });
  return { success: false, code, retryAfterSeconds };
}

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
  const recordingsDir = path.join(recordingsLibrary.getRoot(), timestamp);

  // Create directory
  fs.mkdirSync(recordingsDir, { recursive: true });

  const audioPath = path.join(recordingsDir, 'audio.wav');
  wavWriter = new WavWriter(audioPath, 16000, 2);

  activity.startRecording();

  // Update tray to show recording state
  trayManager?.setRecording(true);

  console.log('Recording started.');
  return { success: true };
});

ipcMain.handle('stop-recording', async () => {
  if (wavWriter) {
    await wavWriter.close();
    wavWriter = null;
    console.log('Recording stopped');
  }
  activity.finishRecording();
  // Update tray to hide recording state
  trayManager?.setRecording(false);
  return { success: true };
});

ipcMain.on('audio-data', (event, data: ArrayBuffer) => {
  if (wavWriter) {
    wavWriter.write(Buffer.from(data));
  }
});

ipcMain.handle('get-recording-permissions', () => ({
  success: true,
  permissions: getRecordingPermissionSnapshot(),
}));

ipcMain.handle(
  'open-recording-permission-settings',
  async (_event, permission: RecordingPermission) => {
    try {
      await openRecordingPermissionSettings(permission);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unable to open System Settings',
      };
    }
  }
);

ipcMain.handle('list-recordings', async () => {
  try {
    const recordingsDir = recordingsLibrary.getRoot();
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

ipcMain.handle('transcribe', async (event, recordingId: unknown): Promise<TranscriptionIpcResult> => {
  if (typeof recordingId !== 'string') {
    return { success: false, code: 'AUDIO_PREPARATION_FAILED' };
  }

  try {
    await getTranscriptionService().transcribe({
      recordingId,
      onProgress: (progress) => event.sender.send('transcription-progress', progress),
    });
    return { success: true };
  } catch (error) {
    return transcriptionFailure(error, 'AUDIO_PREPARATION_FAILED');
  }
});

ipcMain.handle('get-local-model-status', (): Promise<LocalModelStatus> => getLocalModelStatus());

ipcMain.handle('install-local-model', async (): Promise<TranscriptionIpcResult> => {
  const status = await getLocalModelStatus();
  if (status.state === 'unavailable') {
    return { success: false, code: 'LOCAL_UNAVAILABLE' };
  }

  try {
    await getModelService().ensureModel((percent) => {
      mainWindow?.webContents.send('local-model-status', {
        state: 'downloading',
        percent,
      } satisfies LocalModelStatus);
    });
    mainWindow?.webContents.send('local-model-status', { state: 'ready' } satisfies LocalModelStatus);
    return { success: true };
  } catch (error) {
    const latestStatus = await getModelService().getStatus();
    mainWindow?.webContents.send('local-model-status', latestStatus);
    return transcriptionFailure(error, 'MODEL_DOWNLOAD_FAILED');
  }
});

ipcMain.handle('export-transcript', async (
  _event,
  recordingId: unknown,
  format: unknown
): Promise<TranscriptExportIpcResult> => {
  if (typeof recordingId !== 'string' || format !== 'txt') {
    console.error('Transcript export request rejected.');
    return { success: false, code: 'TRANSCRIPT_EXPORT_FAILED' };
  }

  try {
    const transcriptPath = recordingsLibrary.resolveRecordingTranscript(recordingId);
    const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'));
    saveExport(transcript, format, transcriptPath);
    return { success: true };
  } catch {
    console.error('Transcript export failed.');
    return { success: false, code: 'TRANSCRIPT_EXPORT_FAILED' };
  }
});

// Settings IPC handlers
ipcMain.handle('save-config', async (
  _event,
  config: unknown
): Promise<SettingsSaveIpcResult> => {
  if (!isSettingsUpdate(config)) {
    console.error('Settings config request rejected.');
    return { success: false, code: 'SETTINGS_SAVE_FAILED' };
  }

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
      ...(config.transcriptionProvider !== undefined && {
        transcriptionProvider: config.transcriptionProvider,
      }),
    });
    return { success: true };
  } catch {
    console.error('Settings config save failed.');
    return { success: false, code: 'SETTINGS_SAVE_FAILED' };
  }
});

ipcMain.handle('load-config', async (): Promise<SettingsLoadIpcResult> => {
  try {
    const config = loadConfig();
    const apiKey = await getGroqApiKey();
    return {
      success: true,
      config: {
        apiKey: apiKey || '',
        model: config.groqModel,
        transcriptionProvider: config.transcriptionProvider,
      },
    };
  } catch {
    console.error('Settings config load failed.');
    return { success: false, code: 'SETTINGS_LOAD_FAILED' };
  }
});

function isSettingsUpdate(value: unknown): value is Partial<TranscriptionSettings> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.apiKey === undefined || typeof candidate.apiKey === 'string')
    && (candidate.model === undefined || typeof candidate.model === 'string')
    && (candidate.transcriptionProvider === undefined
      || candidate.transcriptionProvider === 'local'
      || candidate.transcriptionProvider === 'groq');
}

app.whenReady().then(() => {
  // Configure loopback audio capture
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      // Provide the first screen source with loopback audio
      desktopCapturer.getSources({ types: ['screen'] })
        .then((sources) => {
          const source = sources[0];
          if (!source) {
            console.error('No screen sources are available for display media capture.');
            callback({});
            return;
          }
          callback({ video: source, audio: 'loopback' });
        })
        .catch((err: unknown) => {
          console.error('Failed to get screen sources:', err);
          callback({});
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
