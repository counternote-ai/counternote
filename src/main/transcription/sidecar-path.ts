import * as fs from 'fs';
import * as path from 'path';
import { TranscriptionErrorCode } from '../../types/transcription';

export interface WhisperCliPathOptions {
  isPackaged: boolean;
  resourcesPath: string;
  projectRoot: string;
  platform: string;
  arch: string;
  env?: {
    COUNTERNOTE_E2E?: string;
    COUNTERNOTE_WHISPER_CLI?: string;
  };
}

export class WhisperSidecarError extends Error {
  constructor(
    readonly code: TranscriptionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WhisperSidecarError';
  }
}

export function resolveWhisperCliPath(options: WhisperCliPathOptions): string {
  if (options.platform !== 'darwin' || options.arch !== 'arm64') {
    throw new WhisperSidecarError(
      'LOCAL_UNAVAILABLE',
      'local transcription is only supported on macOS Apple Silicon',
    );
  }

  const env = options.env ?? (process.env as NodeJS.ProcessEnv);
  const e2eCliPath = env.COUNTERNOTE_WHISPER_CLI;
  if (!options.isPackaged && env.COUNTERNOTE_E2E === '1' && e2eCliPath) {
    if (!isExecutable(e2eCliPath)) {
      throw new WhisperSidecarError(
        'LOCAL_UNAVAILABLE',
        'E2E whisper-cli override path is not executable',
      );
    }
    return e2eCliPath;
  }

  const resolved = options.isPackaged
    ? path.join(options.resourcesPath, 'whisper', 'bin', 'whisper-cli')
    : path.join(
        options.projectRoot,
        'build',
        'whisper',
        `${options.platform}-${options.arch}`,
        'whisper-cli',
      );

  if (!isExecutable(resolved)) {
    throw new WhisperSidecarError(
      'LOCAL_UNAVAILABLE',
      'whisper-cli sidecar is missing or not executable',
    );
  }

  return resolved;
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
