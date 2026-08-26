jest.mock('os', () => {
  const actual = jest.requireActual<typeof import('os')>('os');
  return { ...actual, homedir: jest.fn(() => actual.tmpdir()) };
});

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig } from '../config';

const TEST_CONFIG_DIR = path.join(os.homedir(), 'CounterNote');
const TEST_CONFIG_FILE = path.join(TEST_CONFIG_DIR, 'config.json');

function writeConfig(raw: unknown): void {
  fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify(raw));
}

describe('Config', () => {
  beforeEach(() => {
    fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
  });

  it('uses the local recordings directory by default', () => {
    expect(loadConfig()).toEqual({
      outputDir: path.join(TEST_CONFIG_DIR, 'recordings'),
    });
  });

  it('loads the existing recordings directory', () => {
    writeConfig({ outputDir: '/test/recordings' });

    expect(loadConfig()).toEqual({ outputDir: '/test/recordings' });
  });

  it('ignores legacy Groq settings while preserving the recordings directory', () => {
    writeConfig({
      transcriptionProvider: 'groq',
      groqModel: 'whisper-large-v3-turbo',
      outputDir: '/test/recordings',
    });

    expect(loadConfig()).toEqual({ outputDir: '/test/recordings' });
  });

  it('falls back safely when the config shape is invalid', () => {
    writeConfig({ outputDir: 42, transcriptionProvider: 'groq' });

    expect(loadConfig()).toEqual({
      outputDir: path.join(TEST_CONFIG_DIR, 'recordings'),
    });
  });
});
