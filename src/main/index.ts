import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { WavWriter as NativeWavWriter } from './native-capture/wav-writer';
import { TrayManager } from './tray';
import { saveExport } from './export';
import { loadConfig } from './config';
import { getAudioDuration, getAudibleIntervals, splitChannels } from './audio-processor';
import { AppActivityCoordinator } from './activity-coordinator';
import { hasTranscriptSegments, RecordingsLibrary } from './recordings-library';
import {
  getRecordingPermissionSnapshot,
  openRecordingPermissionSettings,
  requestRecordingPermissions,
} from './recording-permissions';
import { type RecordingPermission } from '../types/recording-permissions';
import {
  type LocalModelStatus,
  type TranscriptionErrorCode,
  type TranscriptionIpcResult,
} from '../types/transcription';
import { type ShowInFinderIpcResult, type TranscriptExportIpcResult } from '../types/settings';
import { TranscriptionOrchestrator } from './transcription/orchestrator';
import { TranscriptionError } from './transcription/errors';
import { ConsoleTranscriptionLogger } from './transcription/logger';
import { LocalModelManager, ModelInstallError } from './transcription/local-model-manager';
import { PRODUCTION_MODEL_ARTIFACT, type ModelArtifactSpec } from './transcription/model-artifact';
import { HttpsModelDownloadTransport } from './transcription/model-download';
import { LocalWhisperProvider } from './transcription/local-whisper-provider';
import { WhisperProcessRunner } from './transcription/whisper-process';
import { resolveWhisperCliPath } from './transcription/sidecar-path';
import { QuitCoordinator } from './quit-coordinator';
import { RecordingMutationCoordinator } from './recording-mutation-coordinator';
import { RecoveryService } from './recovery-service';
import {
  createNativeCaptureController,
  type NativeCaptureController,
} from './native-capture/controller';
import { createNativeCaptureSession, type NativeCaptureSession } from './native-capture/session';
import { resolveAudioCaptureHelper } from './native-capture/helper-path';
import { CaptureStore } from './native-capture/capture-store';
import { spawn } from 'child_process';

let mainWindow: BrowserWindow | null = null;
let trayManager: TrayManager | null = null;
const activity = new AppActivityCoordinator();
const recordingsLibrary = new RecordingsLibrary(() => loadConfig().outputDir);
let modelService: LocalModelManager | null = null;
let transcriptionService: TranscriptionOrchestrator | null = null;
let localUnavailableStatus: LocalModelStatus | null = null;
let quitCoordinator: QuitCoordinator | null = null;

/* ── Native capture controller ──────────────────────────────── */

const mutationCoordinator = new RecordingMutationCoordinator();
const captureStore = new CaptureStore(() => loadConfig().outputDir);
const recoveryService = new RecoveryService(() => loadConfig().outputDir, mutationCoordinator);

let nativeCaptureController: NativeCaptureController | null = null;

function getNativeCaptureController(): NativeCaptureController {
  if (nativeCaptureController === null) {
    nativeCaptureController = createNativeCaptureController({
      mutationCoordinator,
      recoveryService,
      now: () => new Date(),
      createSession: (recordingId: string): NativeCaptureSession => {
        const helperPath = resolveAudioCaptureHelper({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath ?? '',
          mainDirectory: __dirname,
          platform: process.platform,
          arch: process.arch,
        });
        return createNativeCaptureSession(recordingId, {
          helperPath,
          store: captureStore,
          mutationCoordinator,
          recordingsLibrary,
          spawn: (
            command: string,
            args: string[],
            options: { stdio: ['pipe', 'pipe', 'pipe']; env: Record<string, string> },
          ) => {
            return spawn(
              command,
              args,
              options,
            ) as unknown as import('./native-capture/session').ChildProcessLike;
          },
          openWriter: (filePath: string) =>
            NativeWavWriter.open(filePath) as unknown as Promise<
              import('./native-capture/session').WavWriterLike
            >,
          now: Date.now,
          setTimeout: (cb, ms) => global.setTimeout(cb, ms),
          clearTimeout: (id) => global.clearTimeout(id as NodeJS.Timeout),
        });
      },
    });
  }
  return nativeCaptureController;
}

// Set app name for macOS menu bar and Activity Monitor
app.name = 'CounterNote';

// Single-instance lock: must be acquired before whenReady
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Initialize quit coordinator before any window or tray can request exit
  quitCoordinator = new QuitCoordinator({
    app,
    isIdle: () => {
      const controller = getNativeCaptureController();
      const snap = controller.snapshot();
      return snap.state === 'idle' && !activity.isTranscribing();
    },
    closeAndDrain: async () => {
      await mutationCoordinator.closeAndDrain();
    },
    stopCaptureIfActive: async () => {
      const controller = getNativeCaptureController();
      await controller.stopRecording();
    },
  });

  app.on('before-quit', (event) => {
    quitCoordinator!.handleBeforeQuit(event);
  });
}

function e2eEnabled(): boolean {
  return !app.isPackaged && process.env.COUNTERNOTE_E2E === '1';
}

function modelArtifact(): ModelArtifactSpec {
  const manifestPath = e2eEnabled() ? process.env.COUNTERNOTE_MODEL_MANIFEST : undefined;
  if (!manifestPath) return PRODUCTION_MODEL_ARTIFACT;

  try {
    const artifact = parseModelArtifact(
      JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown,
    );
    return artifact ?? PRODUCTION_MODEL_ARTIFACT;
  } catch {
    console.error('E2E model manifest could not be loaded.');
    return PRODUCTION_MODEL_ARTIFACT;
  }
}

function parseModelArtifact(value: unknown): ModelArtifactSpec | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (
    keys.length !== 4 ||
    !keys.every((key) => ['url', 'fileName', 'byteSize', 'sha256'].includes(key)) ||
    typeof candidate.url !== 'string' ||
    typeof candidate.fileName !== 'string' ||
    candidate.fileName.length === 0 ||
    path.basename(candidate.fileName) !== candidate.fileName ||
    typeof candidate.byteSize !== 'number' ||
    !Number.isSafeInteger(candidate.byteSize) ||
    candidate.byteSize <= 0 ||
    typeof candidate.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.sha256)
  ) {
    return null;
  }

  try {
    const url = new URL(candidate.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return {
      url,
      fileName: candidate.fileName,
      byteSize: candidate.byteSize,
      sha256: candidate.sha256,
    };
  } catch {
    return null;
  }
}

function getModelService(): LocalModelManager {
  if (modelService === null) {
    const artifact = modelArtifact();
    const transport = new HttpsModelDownloadTransport(artifact.byteSize);
    modelService = new LocalModelManager(
      path.join(app.getPath('userData'), 'models'),
      artifact,
      transport.download.bind(transport),
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
      reason:
        process.platform === 'darwin' && process.arch === 'arm64'
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
      getAudibleIntervals,
    });
  } catch {
    localUnavailableStatus = {
      state: 'unavailable',
      reason:
        process.platform === 'darwin' && process.arch === 'arm64'
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
    localProvider,
    splitChannels,
    getAudioDuration,
    fs: fs.promises,
    logger: new ConsoleTranscriptionLogger(),
  });
  return transcriptionService;
}

function transcriptionFailure(
  error: unknown,
  fallback: TranscriptionErrorCode,
): TranscriptionIpcResult {
  const code =
    error instanceof TranscriptionError || error instanceof ModelInstallError
      ? error.code
      : fallback;
  const retryAfterSeconds =
    error instanceof TranscriptionError ? error.details.retryAfterSeconds : undefined;
  console.error('Transcription operation failed.', { code });
  return { success: false, code, retryAfterSeconds };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    title: 'CounterNote',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#faf6ed',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  // Create tray
  trayManager = new TrayManager(mainWindow, () => app.quit());

  // Wire tray to controller state and broadcast status to renderer
  const controller = getNativeCaptureController();
  controller.onStatusChange((snapshot) => {
    // Update tray
    if (snapshot.state === 'recording' || snapshot.state === 'starting') {
      trayManager?.setState('recording');
    } else if (snapshot.state === 'finishing') {
      trayManager?.setState('finishing');
    } else {
      trayManager?.setState('idle');
    }
    // Broadcast to renderer
    mainWindow?.webContents.send('recording:status', snapshot);
  });

  // Tray stop action delegates to controller
  trayManager.onStop = () => {
    void controller.stopRecording();
  };
}

/* ── Native capture IPC handlers ────────────────────────────── */

ipcMain.handle('recording:start', async () => {
  try {
    return await getNativeCaptureController().startRecording();
  } catch {
    return { ok: false as const, reason: 'persistence-error' as const };
  }
});

ipcMain.handle('recording:cancel', async () => {
  try {
    return await getNativeCaptureController().cancelRecording();
  } catch {
    return { status: 'not-active' as const };
  }
});

ipcMain.handle('recording:stop', async () => {
  try {
    return await getNativeCaptureController().stopRecording();
  } catch {
    return { status: 'not-active' as const };
  }
});

ipcMain.handle('recording:get-status', () => {
  return getNativeCaptureController().snapshot();
});

ipcMain.handle('recording:list-recovery', async () => {
  try {
    return await getNativeCaptureController().listRecovery();
  } catch {
    return [];
  }
});

ipcMain.handle('recording:recover', async (_event, args: unknown) => {
  if (!isRecoveryIdArgs(args)) {
    return { outcome: 'not-found' as const };
  }
  try {
    return await getNativeCaptureController().recoverRecording(args.id);
  } catch {
    return { outcome: 'recovery-failed' as const };
  }
});

ipcMain.handle('recording:trash-recovery', async (_event, args: unknown) => {
  if (!isRecoveryIdArgs(args)) {
    return { outcome: 'not-found' as const };
  }
  try {
    return await getNativeCaptureController().trashRecovery(args.id);
  } catch {
    return { outcome: 'trash-failed' as const };
  }
});

function isRecoveryIdArgs(value: unknown): value is { id: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && candidate.id.length > 0;
}

ipcMain.handle('get-recording-permissions', () => ({
  success: true,
  permissions: getRecordingPermissionSnapshot(),
}));

ipcMain.handle('request-recording-permissions', async () => ({
  success: true,
  permissions: await requestRecordingPermissions(),
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
  },
);

ipcMain.handle('list-recordings', async () => {
  try {
    const captureRecords = new Map(
      (await recordingsLibrary.list()).map((recording) => [recording.id, recording]),
    );
    const recordingsDir = recordingsLibrary.getRoot();
    if (!fs.existsSync(recordingsDir)) {
      return { success: true, recordings: [] };
    }

    const entries = fs.readdirSync(recordingsDir, { withFileTypes: true });
    const recordings = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && captureRecords.has(entry.name))
        .map(async (entry) => {
          const captureRecord = captureRecords.get(entry.name)!;
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

          const hasTranscriptArtifact = fs.existsSync(transcriptPath);

          // Load transcript segments if available
          let segments: unknown;
          if (hasTranscriptArtifact) {
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
            title: `Meeting — ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`,
            duration,
            transcribed: hasTranscriptSegments(segments),
            segments,
            captureStatus: captureRecord.captureStatus,
            interruptions: captureRecord.interruptions,
          };
        }),
    );

    return { success: true, recordings: recordings.filter(Boolean) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
});

ipcMain.handle(
  'transcribe',
  async (event, recordingId: unknown): Promise<TranscriptionIpcResult> => {
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
  },
);

ipcMain.handle('get-local-model-status', (): Promise<LocalModelStatus> => getLocalModelStatus());

ipcMain.handle('install-local-model', async (): Promise<TranscriptionIpcResult> => {
  const status = await getLocalModelStatus();
  if (status.state === 'unavailable') {
    return { success: false, code: 'LOCAL_UNAVAILABLE' };
  }

  try {
    await getModelService().ensureModel(
      (percent) => {
        mainWindow?.webContents.send('local-model-status', {
          state: 'downloading',
          percent,
        } satisfies LocalModelStatus);
      },
      { recoverInvalidModel: status.state === 'invalid' },
    );
    mainWindow?.webContents.send('local-model-status', {
      state: 'ready',
    } satisfies LocalModelStatus);
    return { success: true };
  } catch (error) {
    const latestStatus = await getModelService().getStatus();
    mainWindow?.webContents.send('local-model-status', latestStatus);
    return transcriptionFailure(error, 'MODEL_DOWNLOAD_FAILED');
  }
});

ipcMain.handle(
  'export-transcript',
  async (_event, recordingId: unknown, format: unknown): Promise<TranscriptExportIpcResult> => {
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
  },
);

ipcMain.handle(
  'show-exported-transcript',
  async (_event, recordingId: unknown): Promise<ShowInFinderIpcResult> => {
    if (typeof recordingId !== 'string') {
      console.error('Show exported transcript request rejected.');
      return { success: false, code: 'SHOW_IN_FINDER_FAILED' };
    }

    try {
      const transcriptPath = recordingsLibrary.resolveRecordingTranscript(recordingId);
      const exportedTranscriptPath = path.join(path.dirname(transcriptPath), 'transcript.txt');
      if (!fs.lstatSync(exportedTranscriptPath).isFile()) {
        throw new Error('EXPORTED_TRANSCRIPT_NOT_FOUND');
      }
      shell.showItemInFolder(exportedTranscriptPath);
      return { success: true };
    } catch {
      console.error('Could not show exported transcript in Finder.');
      return { success: false, code: 'SHOW_IN_FINDER_FAILED' };
    }
  },
);

ipcMain.handle(
  'show-recording-files',
  async (_event, recordingId: unknown): Promise<ShowInFinderIpcResult> => {
    if (typeof recordingId !== 'string') {
      console.error('Show recording files request rejected.');
      return { success: false, code: 'SHOW_IN_FINDER_FAILED' };
    }

    try {
      const recordingDirectory = path.dirname(recordingsLibrary.resolveRecordingAudio(recordingId));
      const directoryStat = fs.lstatSync(recordingDirectory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error('RECORDING_DIRECTORY_NOT_FOUND');
      }
      const openError = await shell.openPath(recordingDirectory);
      if (openError !== '') {
        throw new Error('FINDER_OPEN_FAILED');
      }
      return { success: true };
    } catch {
      console.error('Could not open recording files in Finder.');
      return { success: false, code: 'SHOW_IN_FINDER_FAILED' };
    }
  },
);

app.whenReady().then(() => {
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
