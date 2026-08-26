import * as fs from 'fs';
import * as path from 'path';

export interface AudioCaptureHelperOptions {
  isPackaged: boolean;
  resourcesPath: string;
  mainDirectory: string;
  platform: string;
  arch: string;
  env?: NodeJS.ProcessEnv;
}

export class AudioCaptureHelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioCaptureHelperError';
  }
}

export function resolveAudioCaptureHelper(options: AudioCaptureHelperOptions): string {
  if (options.platform !== 'darwin' || options.arch !== 'arm64') {
    throw new AudioCaptureHelperError(
      'Audio capture helper is only supported on macOS Apple Silicon',
    );
  }

  const env = options.env ?? process.env;
  const envOverride = env.COUNTERNOTE_AUDIO_CAPTURE_HELPER;

  if (envOverride) {
    if (options.isPackaged) {
      throw new AudioCaptureHelperError(
        'COUNTERNOTE_AUDIO_CAPTURE_HELPER is not available in packaged production',
      );
    }
    if (!isExecutable(envOverride)) {
      throw new AudioCaptureHelperError(
        `Audio capture helper override path is not executable: ${envOverride}`,
      );
    }
    return envOverride;
  }

  const resolved = options.isPackaged
    ? path.join(options.resourcesPath, 'audio-capture', 'bin', 'counternote-audio-capture')
    : path.join(
        path.resolve(options.mainDirectory, '../..'),
        'build',
        'audio-capture',
        `${options.platform}-${options.arch}`,
        'counternote-audio-capture',
      );

  if (!isExecutable(resolved)) {
    throw new AudioCaptureHelperError(
      `Audio capture helper is missing or not executable: ${resolved}`,
    );
  }

  return resolved;
}

function isExecutable(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
