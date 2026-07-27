import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { safeStorage } from 'electron';

const CONFIG_DIR = path.join(os.homedir(), 'InterviewCopilot');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SECRETS_FILE = path.join(CONFIG_DIR, 'secrets.enc');

export interface Config {
  groqModel: string;
  outputDir: string;
}

const DEFAULT_CONFIG: Config = {
  groqModel: 'whisper-large-v3-turbo',
  outputDir: path.join(CONFIG_DIR, 'recordings'),
};

export function loadConfig(): Config {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const savedConfig: Partial<Config> = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      return {
        groqModel: savedConfig.groqModel ?? DEFAULT_CONFIG.groqModel,
        outputDir: savedConfig.outputDir ?? DEFAULT_CONFIG.outputDir,
      };
    }
  } catch (err) {
    console.error('Failed to load config:', err);
  }
  return DEFAULT_CONFIG;
}

export function saveConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export async function getGroqApiKey(): Promise<string | null> {
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      const encrypted = fs.readFileSync(SECRETS_FILE);
      const { result } = await safeStorage.decryptStringAsync(encrypted);
      return result;
    }
  } catch {
    console.warn('Stored Groq API key could not be decrypted. Re-enter it in Settings to replace the old key.');
  }
  return null;
}

export async function setGroqApiKey(apiKey: string): Promise<void> {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const encrypted = await safeStorage.encryptStringAsync(apiKey);
  fs.writeFileSync(SECRETS_FILE, encrypted);
}
