import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, ipcMain, BrowserWindow, shell } from 'electron';
import { loadConfig } from '../config';
import { LocalModelManager } from '../transcription/local-model-manager';

jest.mock('../config', () => ({
  loadConfig: jest.fn(),
}));

jest.mock('../transcription/sidecar-path', () => ({
  resolveWhisperCliPath: jest.fn().mockReturnValue('/app-managed/whisper-cli'),
}));

import '../index';

interface IpcMainMock {
  handle: jest.Mock;
}

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

const handlers = new Map<string, IpcHandler>(
  (ipcMain as unknown as IpcMainMock).handle.mock.calls.map(([channel, handler]) => [
    channel as string,
    handler as IpcHandler,
  ]),
);

function getHandler(channel: string): IpcHandler {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler;
}

describe('single-instance startup', () => {
  it('uses integrated macOS window chrome while preserving the semantic title', async () => {
    await (app.whenReady as jest.Mock).mock.results[0].value;

    expect(BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'CounterNote',
        titleBarStyle: 'hiddenInset',
        backgroundColor: '#faf6ed',
      }),
    );
  });

  it('acquires the single-instance lock before whenReady', () => {
    expect(app.requestSingleInstanceLock).toHaveBeenCalled();
    expect(app.whenReady).toHaveBeenCalled();
    // requestSingleInstanceLock should be called before whenReady
    const lockCallOrder = (app.requestSingleInstanceLock as jest.Mock).mock.invocationCallOrder[0];
    const readyCallOrder = (app.whenReady as jest.Mock).mock.invocationCallOrder[0];
    expect(lockCallOrder).toBeLessThan(readyCallOrder);
  });

  it('registers a second-instance handler', () => {
    const onCalls = (app.on as jest.Mock).mock.calls;
    const secondInstanceCall = onCalls.find(([event]: [string]) => event === 'second-instance');
    expect(secondInstanceCall).toBeDefined();
  });

  it('restores minimized windows and focuses on second-instance', async () => {
    // Ensure createWindow has run (whenReady microtask)
    await (app.whenReady as jest.Mock).mock.results[0].value;

    // Get the BrowserWindow instance created by createWindow and augment it
    const windowInstance = (BrowserWindow as unknown as jest.Mock).mock.results[0].value;
    windowInstance.isMinimized = jest.fn().mockReturnValue(true);
    windowInstance.restore = jest.fn();

    // Get the second-instance handler and invoke it
    const onCalls = (app.on as jest.Mock).mock.calls;
    const secondInstanceCall = onCalls.find(([event]: [string]) => event === 'second-instance');
    const secondInstanceHandler = secondInstanceCall![1] as () => void;
    secondInstanceHandler();

    expect(windowInstance.restore).toHaveBeenCalledTimes(1);
    expect(windowInstance.show).toHaveBeenCalledTimes(1);
    expect(windowInstance.focus).toHaveBeenCalledTimes(1);
  });

  it('shows and focuses without restore when window is not minimized', async () => {
    await (app.whenReady as jest.Mock).mock.results[0].value;

    const windowInstance = (BrowserWindow as unknown as jest.Mock).mock.results[0].value;
    windowInstance.isMinimized = jest.fn().mockReturnValue(false);
    windowInstance.restore = jest.fn();
    // Reset show/focus counts from the previous test
    (windowInstance.show as jest.Mock).mockClear();
    (windowInstance.focus as jest.Mock).mockClear();

    const onCalls = (app.on as jest.Mock).mock.calls;
    const secondInstanceCall = onCalls.find(([event]: [string]) => event === 'second-instance');
    const secondInstanceHandler = secondInstanceCall![1] as () => void;
    secondInstanceHandler();

    expect(windowInstance.restore).not.toHaveBeenCalled();
    expect(windowInstance.show).toHaveBeenCalledTimes(1);
    expect(windowInstance.focus).toHaveBeenCalledTimes(1);
  });
});

describe('quit coordination', () => {
  it('registers a before-quit handler', () => {
    const onCalls = (app.on as jest.Mock).mock.calls;
    const beforeQuitCall = onCalls.find(([event]: [string]) => event === 'before-quit');
    expect(beforeQuitCall).toBeDefined();
  });

  it('allows quit when idle', () => {
    const onCalls = (app.on as jest.Mock).mock.calls;
    const beforeQuitCall = onCalls.find(([event]: [string]) => event === 'before-quit');
    const beforeQuitHandler = beforeQuitCall?.[1] as ((event: Electron.Event) => void) | undefined;

    if (beforeQuitHandler) {
      const event = { preventDefault: jest.fn() } as unknown as Electron.Event;

      // When idle (not recording, not transcribing), quit should pass through
      beforeQuitHandler(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  });
});

describe('recording IPC validation', () => {
  let consoleError: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('rejects recording:recover with path-like ID', async () => {
    const handler = getHandler('recording:recover');
    const result = await handler({}, { id: '/private/recordings/secret' });

    expect(result).toEqual({ outcome: 'not-found' });
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('/private'));
  });

  it('rejects recording:recover with non-UUID string', async () => {
    const handler = getHandler('recording:recover');
    const result = await handler({}, { id: 'not-a-uuid' });

    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('rejects recording:trash-recovery with path-like ID', async () => {
    const handler = getHandler('recording:trash-recovery');
    const result = await handler({}, { id: '../../../etc/passwd' });

    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('rejects recording:recover with missing id field', async () => {
    const handler = getHandler('recording:recover');
    const result = await handler({}, {});

    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('rejects recording:trash-recovery with missing id field', async () => {
    const handler = getHandler('recording:trash-recovery');
    const result = await handler({}, {});

    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('recording:get-status returns typed result without native errors', async () => {
    const handler = getHandler('recording:get-status');
    const result = await handler({});

    expect(result).toHaveProperty('state');
    expect(result).toHaveProperty('canCancel');
    expect(result).toHaveProperty('canStop');
    // Must not leak paths or native errors
    expect(JSON.stringify(result)).not.toContain('/tmp');
    expect(JSON.stringify(result)).not.toContain('.wav');
    expect(JSON.stringify(result)).not.toContain('Error');
  });

  it('recording:list-recovery returns items with only safe fields', async () => {
    const handler = getHandler('recording:list-recovery');
    const result = await handler({});

    expect(Array.isArray(result)).toBe(true);
    // Each item must have exactly { id, createdAt, bytes, state }
    for (const item of result as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(['bytes', 'createdAt', 'id', 'state']);
      // No paths
      expect(JSON.stringify(item)).not.toContain('/');
    }
  });
});

describe('legacy capture removal', () => {
  it('does not register an audio-data IPC listener', () => {
    // audio-data was the legacy renderer-to-main PCM bridge
    const onCalls = (ipcMain.on as jest.Mock).mock.calls;
    const audioDataCall = onCalls.find(([channel]: [string]) => channel === 'audio-data');
    expect(audioDataCall).toBeUndefined();
  });

  it('does not register a start-recording legacy handler', () => {
    expect(handlers.has('start-recording')).toBe(false);
  });

  it('does not register a stop-recording legacy handler', () => {
    expect(handlers.has('stop-recording')).toBe(false);
  });

  it('does not register a capture-ready event sender', () => {
    // capture-ready was the legacy main-to-renderer notification
    // Verify no ipcMain.handle or ipcMain.on listener exists for capture-ready
    expect(handlers.has('capture-ready')).toBe(false);
    const onCalls = (ipcMain.on as jest.Mock).mock.calls;
    const captureReadyOn = onCalls.find(([channel]: [string]) => channel === 'capture-ready');
    expect(captureReadyOn).toBeUndefined();
  });

  it('does not import the legacy wav-writer module', () => {
    // The legacy src/main/wav-writer.ts should not be imported;
    // only src/main/native-capture/wav-writer.ts is the production writer.
    const indexSource = fs.readFileSync(path.join(__dirname, '../index.ts'), 'utf-8');
    // Must not contain a bare "./wav-writer" import (the legacy path).
    // The valid import "./native-capture/wav-writer" is allowed.
    expect(indexSource).not.toMatch(/from\s+['"]\.\/wav-writer['"]/);
  });

  it('does not register a display-media loopback handler', () => {
    // display-media loopback was the legacy renderer-to-main screen audio capture
    expect(handlers.has('display-media')).toBe(false);
    expect(handlers.has('get-display-media')).toBe(false);
    expect(handlers.has('desktop-capturer')).toBe(false);
  });

  it('does not include a worklet webpack entry', () => {
    const webpackSource = fs.readFileSync(
      path.join(__dirname, '../../../webpack.config.js'),
      'utf-8',
    );
    expect(webpackSource).not.toMatch(/audio-processor\.worklet/);
  });

  it('does not expose a raw-audio preload method', () => {
    const preloadSource = fs.readFileSync(path.join(__dirname, '../preload.ts'), 'utf-8');
    expect(preloadSource).not.toMatch(/rawAudio|sendRawAudio|onRawAudio/);
  });
});

describe('sensitive IPC failures', () => {
  let consoleError: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.clearAllMocks();
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('does not register cloud configuration IPC handlers', () => {
    expect(handlers.has('save-config')).toBe(false);
    expect(handlers.has('load-config')).toBe(false);
  });

  it('rejects renderer-supplied transcript paths before reading the filesystem', async () => {
    const rendererPath = '/private/recordings/secret/transcript.json';

    const result = await getHandler('export-transcript')({}, rendererPath, 'txt');

    expect(result).toEqual({ success: false, code: 'TRANSCRIPT_EXPORT_FAILED' });
    expect(consoleError).toHaveBeenCalledWith('Transcript export failed.');
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining(rendererPath));
  });

  it('rejects renderer-supplied paths before opening recording files', async () => {
    const rendererPath = '/private/recordings/secret';

    const result = await getHandler('show-recording-files')({}, rendererPath);

    expect(result).toEqual({ success: false, code: 'SHOW_IN_FINDER_FAILED' });
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining(rendererPath));
  });

  it('opens a validated recording directory without returning its path', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'counternote-show-files-'));
    const recordingDirectory = path.join(outputDir, '2026-07-27T12-00-00-000Z');
    fs.mkdirSync(recordingDirectory);
    (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValueOnce({
      outputDir,
    } as ReturnType<typeof loadConfig>);

    try {
      const result = await getHandler('show-recording-files')({}, '2026-07-27T12-00-00-000Z');

      expect(shell.openPath).toHaveBeenCalledWith(recordingDirectory);
      expect(result).toEqual({ success: true });
      expect(JSON.stringify(result)).not.toContain(outputDir);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('maps Finder directory failures to a safe result', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'counternote-show-files-'));
    const recordingDirectory = path.join(outputDir, '2026-07-27T12-00-00-000Z');
    fs.mkdirSync(recordingDirectory);
    (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValueOnce({
      outputDir,
    } as ReturnType<typeof loadConfig>);
    (shell.openPath as jest.Mock).mockResolvedValueOnce(`Unable to open ${recordingDirectory}`);

    try {
      const result = await getHandler('show-recording-files')({}, '2026-07-27T12-00-00-000Z');

      expect(result).toEqual({ success: false, code: 'SHOW_IN_FINDER_FAILED' });
      expect(JSON.stringify(result)).not.toContain(outputDir);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('reveals only the exported transcript derived from a validated recording ID', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'counternote-show-files-'));
    const recordingDirectory = path.join(outputDir, '2026-07-27T12-00-00-000Z');
    const exportedTranscriptPath = path.join(recordingDirectory, 'transcript.txt');
    fs.mkdirSync(recordingDirectory);
    fs.writeFileSync(exportedTranscriptPath, 'Meeting audio: Hello');
    (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValueOnce({
      outputDir,
    } as ReturnType<typeof loadConfig>);

    try {
      const result = await getHandler('show-exported-transcript')({}, '2026-07-27T12-00-00-000Z');

      expect(shell.showItemInFolder).toHaveBeenCalledWith(exportedTranscriptPath);
      expect(result).toEqual({ success: true });
      expect(JSON.stringify(result)).not.toContain(outputDir);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('fails safely when the exported transcript no longer exists', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'counternote-show-files-'));
    const recordingDirectory = path.join(outputDir, '2026-07-27T12-00-00-000Z');
    fs.mkdirSync(recordingDirectory);
    (loadConfig as jest.MockedFunction<typeof loadConfig>).mockReturnValueOnce({
      outputDir,
    } as ReturnType<typeof loadConfig>);

    try {
      const result = await getHandler('show-exported-transcript')({}, '2026-07-27T12-00-00-000Z');

      expect(result).toEqual({ success: false, code: 'SHOW_IN_FINDER_FAILED' });
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(outputDir);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('rejects renderer-supplied paths before revealing an exported transcript', async () => {
    const rendererPath = '../../../private/transcript.txt';

    const result = await getHandler('show-exported-transcript')({}, rendererPath);

    expect(result).toEqual({ success: false, code: 'SHOW_IN_FINDER_FAILED' });
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining(rendererPath));
  });

  it('derives invalid-model recovery from a fresh main-process status', async () => {
    const getStatus = jest
      .spyOn(LocalModelManager.prototype, 'getStatus')
      .mockResolvedValueOnce({ state: 'invalid' });
    const ensureModel = jest
      .spyOn(LocalModelManager.prototype, 'ensureModel')
      .mockResolvedValueOnce('/app-managed/models/model.bin');

    try {
      const result = await getHandler('install-local-model')({}, { recoverInvalidModel: false });

      expect(result).toEqual({ success: true });
      expect(getStatus).toHaveBeenCalledTimes(1);
      expect(ensureModel).toHaveBeenCalledWith(expect.any(Function), { recoverInvalidModel: true });
    } finally {
      getStatus.mockRestore();
      ensureModel.mockRestore();
    }
  });

  it('does not grant invalid-model recovery from renderer input', async () => {
    const getStatus = jest
      .spyOn(LocalModelManager.prototype, 'getStatus')
      .mockResolvedValueOnce({ state: 'not-downloaded' });
    const ensureModel = jest
      .spyOn(LocalModelManager.prototype, 'ensureModel')
      .mockResolvedValueOnce('/app-managed/models/model.bin');

    try {
      const result = await getHandler('install-local-model')({}, { recoverInvalidModel: true });

      expect(result).toEqual({ success: true });
      expect(getStatus).toHaveBeenCalledTimes(1);
      expect(ensureModel).toHaveBeenCalledWith(expect.any(Function), {
        recoverInvalidModel: false,
      });
    } finally {
      getStatus.mockRestore();
      ensureModel.mockRestore();
    }
  });
});
