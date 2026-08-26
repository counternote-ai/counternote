import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CONFIG_DIR = path.join(os.homedir(), 'CounterNote');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface Config {
  outputDir: string;
}

const DEFAULT_CONFIG: Config = {
  outputDir: path.join(CONFIG_DIR, 'recordings'),
};

export function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as unknown;
      if (isRecord(savedConfig) && typeof savedConfig.outputDir === 'string') {
        return { outputDir: savedConfig.outputDir };
      }
    }
  } catch (err) {
    console.error('Failed to load config:', err);
  }
  return DEFAULT_CONFIG;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
