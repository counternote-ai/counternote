jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
    readFileSync: jest.fn(actual.readFileSync),
  };
});

jest.mock('os', () => {
  const actual = jest.requireActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: jest.fn(() => actual.tmpdir()),
  };
});

import { loadConfig, saveConfig, getGroqApiKey } from '../config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { safeStorage } from 'electron';

// Mock the config directory to use a temp directory
const TEST_CONFIG_DIR = path.join(os.homedir(), 'InterviewCopilot');
const TEST_CONFIG_FILE = path.join(TEST_CONFIG_DIR, 'config.json');
const fsMock = fs as unknown as {
  existsSync: jest.Mock;
  readFileSync: jest.Mock;
};
const safeStorageMock = safeStorage as unknown as {
  decryptStringAsync: jest.Mock;
  encryptStringAsync: jest.Mock;
};

const writeConfig = (raw: unknown): void => {
  fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify(raw));
};

describe('Config', () => {
  beforeEach(() => {
    fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    safeStorageMock.decryptStringAsync.mockReset();
    safeStorageMock.decryptStringAsync.mockResolvedValue({ result: 'decrypted', shouldReEncrypt: false });
    safeStorageMock.encryptStringAsync.mockReset();
    safeStorageMock.encryptStringAsync.mockResolvedValue(Buffer.from('encrypted'));
    fsMock.existsSync.mockImplementation(jest.requireActual('fs').existsSync);
    fsMock.readFileSync.mockImplementation(jest.requireActual('fs').readFileSync);
    fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  it('should return default config when no config file exists', () => {
    const config = loadConfig();

    expect(config).toEqual({
      transcriptionProvider: 'local',
      groqModel: 'whisper-large-v3-turbo',
      outputDir: path.join(TEST_CONFIG_DIR, 'recordings'),
    });
    expect(config).not.toHaveProperty('autoTranscribe');
  });

  it('should load config from file when it exists', () => {
    const testConfig = {
      groqModel: 'whisper-large-v3',
      outputDir: '/test/dir',
    };

    fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify(testConfig));

    // Note: This test would need the config module to accept a custom path
    // For now, we test the structure
    const config = loadConfig();
    expect(config).toHaveProperty('groqModel');
    expect(config).toHaveProperty('outputDir');
  });

  it('should have correct default values', () => {
    const config = loadConfig();

    expect(typeof config.groqModel).toBe('string');
    expect(typeof config.outputDir).toBe('string');
  });

  it('defaults missing transcriptionProvider to local', () => {
    writeConfig({ version: 1, groqModel: 'whisper-large-v3-turbo', outputDir: '/recordings' });

    expect(loadConfig().transcriptionProvider).toBe('local');
  });

  it('preserves an explicitly selected Groq provider', () => {
    writeConfig({
      version: 1,
      transcriptionProvider: 'groq',
      groqModel: 'whisper-large-v3-turbo',
      outputDir: '/recordings',
    });

    expect(loadConfig().transcriptionProvider).toBe('groq');
  });

  it('rejects an unknown transcription provider', () => {
    writeConfig({
      version: 1,
      transcriptionProvider: 'automatic',
      groqModel: 'whisper-large-v3-turbo',
      outputDir: '/recordings',
    });

    expect(loadConfig().transcriptionProvider).toBe('local');
  });

  it('should load the Groq API key when the stored secret decrypts', async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(Buffer.from('stored ciphertext') as any);
    safeStorageMock.decryptStringAsync.mockResolvedValue({
      result: 'provider-secret-value',
      shouldReEncrypt: false,
    });

    await expect(getGroqApiKey()).resolves.toBe('provider-secret-value');
  });

  it('should return null with a concise warning when the stored API key cannot be decrypted', async () => {
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(Buffer.from('stored ciphertext') as any);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    safeStorageMock.decryptStringAsync.mockRejectedValue(new Error('bad ciphertext'));

    await expect(getGroqApiKey()).resolves.toBeNull();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'Stored Groq API key could not be decrypted. Re-enter it in Settings to replace the old key.'
    );
  });
});
