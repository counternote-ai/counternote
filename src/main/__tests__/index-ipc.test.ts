import { ipcMain } from 'electron';
import { loadConfig, setGroqApiKey } from '../config';

jest.mock('../config', () => ({
  getGroqApiKey: jest.fn(),
  loadConfig: jest.fn(),
  saveConfig: jest.fn(),
  setGroqApiKey: jest.fn(),
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
});
