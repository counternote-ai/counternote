import * as fs from 'fs';
import * as path from 'path';
import { app, ipcMain, BrowserWindow } from 'electron';
import { loadConfig, setGroqApiKey } from '../config';
import { LocalModelManager } from '../transcription/local-model-manager';

jest.mock('../config', () => ({
  getGroqApiKey: jest.fn(),
  loadConfig: jest.fn(),
  saveConfig: jest.fn(),
  setGroqApiKey: jest.fn(),
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
  (ipcMain as unknown as IpcMainMock).handle.mock.calls.map(
    ([channel, handler]) => [channel as string, handler as IpcHandler]
  )
);

function getHandler(channel: string): IpcHandler {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler;
}

describe('single-instance startup', () => {
  it('acquires the single-instance lock before whenReady', () => {
    expect(app.requestSingleInstanceLock).toHaveBeenCalled();
    expect(app.whenReady).toHaveBeenCalled();
    // requestSingleInstanceLock should be called before whenReady
    const lockCallOrder = (app.requestSingleInstanceLock as jest.Mock).mock
      .invocationCallOrder[0];
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
    const indexSource = fs.readFileSync(
      path.join(__dirname, '../index.ts'),
      'utf-8',
    );
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
    const preloadSource = fs.readFileSync(
      path.join(__dirname, '../preload.ts'),
      'utf-8',
    );
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

  it('returns a typed settings-save failure without safe-storage details', async () => {
    const rawError = new Error('safeStorage failed for /private/keychain/Interview Copilot');
    (setGroqApiKey as jest.MockedFunction<typeof setGroqApiKey>).mockRejectedValueOnce(rawError);

    const result = await getHandler('save-config')({}, {
      apiKey: 'provider-secret-value',
      model: 'whisper-large-v3-turbo',
      transcriptionProvider: 'local',
    });

    expect(result).toEqual({ success: false, code: 'SETTINGS_SAVE_FAILED' });
    expect(consoleError).toHaveBeenCalledWith('Settings config save failed.');
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining(rawError.message));
  });

  it('returns a typed settings-load failure without filesystem details', async () => {
    const rawError = new Error('ENOENT: /private/config/interview-copilot.json');
    (loadConfig as jest.MockedFunction<typeof loadConfig>).mockImplementationOnce(() => {
      throw rawError;
    });

    const result = await getHandler('load-config')({});

    expect(result).toEqual({ success: false, code: 'SETTINGS_LOAD_FAILED' });
    expect(consoleError).toHaveBeenCalledWith('Settings config load failed.');
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining(rawError.message));
  });

  it('rejects renderer-supplied transcript paths before reading the filesystem', async () => {
    const rendererPath = '/private/recordings/secret/transcript.json';

    const result = await getHandler('export-transcript')({}, rendererPath, 'txt');

    expect(result).toEqual({ success: false, code: 'TRANSCRIPT_EXPORT_FAILED' });
    expect(consoleError).toHaveBeenCalledWith('Transcript export failed.');
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining(rendererPath));
  });

  it('derives invalid-model recovery from a fresh main-process status', async () => {
    const getStatus = jest.spyOn(LocalModelManager.prototype, 'getStatus')
      .mockResolvedValueOnce({ state: 'invalid' });
    const ensureModel = jest.spyOn(LocalModelManager.prototype, 'ensureModel')
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
    const getStatus = jest.spyOn(LocalModelManager.prototype, 'getStatus')
      .mockResolvedValueOnce({ state: 'not-downloaded' });
    const ensureModel = jest.spyOn(LocalModelManager.prototype, 'ensureModel')
      .mockResolvedValueOnce('/app-managed/models/model.bin');

    try {
      const result = await getHandler('install-local-model')({}, { recoverInvalidModel: true });

      expect(result).toEqual({ success: true });
      expect(getStatus).toHaveBeenCalledTimes(1);
      expect(ensureModel).toHaveBeenCalledWith(expect.any(Function), { recoverInvalidModel: false });
    } finally {
      getStatus.mockRestore();
      ensureModel.mockRestore();
    }
  });
});
