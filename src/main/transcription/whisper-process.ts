import { spawn, SpawnOptions, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { TranscriptionErrorCode } from '../../types/transcription';

const INACTIVITY_MS = 5 * 60 * 1000;
const HARD_DEADLINE_MIN_MS = 15 * 60 * 1000;
const KILL_DELAY_MS = 5_000;

export interface WhisperProcessInput {
  cliPath: string;
  modelPath: string;
  channelPath: string;
  outputPrefix: string;
  channelDurationMs: number;
}

export interface WhisperProcessDependencies {
  spawn: typeof spawn;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  readFile: typeof fs.promises.readFile;
}

export class WhisperProcessError extends Error {
  constructor(
    readonly code: TranscriptionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'WhisperProcessError';
  }
}

function defaultDependencies(): WhisperProcessDependencies {
  return {
    spawn,
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as NodeJS.Timeout),
    readFile: fs.promises.readFile,
  };
}

export class WhisperProcessRunner {
  constructor(private readonly deps: WhisperProcessDependencies = defaultDependencies()) {}

  async run(input: WhisperProcessInput): Promise<unknown> {
    const args = [
      '-m',
      input.modelPath,
      '-f',
      input.channelPath,
      '-of',
      input.outputPrefix,
      '-ojf',
      '-pp',
      '-np',
      '-l',
      'auto',
      '-sns',
      '-nth',
      '0.60',
    ];

    let child: ChildProcess;
    try {
      child = this.deps.spawn(input.cliPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      } as SpawnOptions);
    } catch {
      throw new WhisperProcessError(
        'LOCAL_TRANSCRIPTION_FAILED',
        'whisper-cli failed to start'
      );
    }

    if (!child.stdout || !child.stderr) {
      throw new WhisperProcessError(
        'LOCAL_TRANSCRIPTION_FAILED',
        'whisper-cli was spawned without stdout or stderr'
      );
    }
    const stdout = child.stdout;
    const stderr = child.stderr;

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let inactivityTimer: unknown | undefined;
      let hardDeadlineTimer: unknown | undefined;
      let killTimer: unknown | undefined;

      const cleanup = (): void => {
        if (inactivityTimer !== undefined) {
          this.deps.clearTimeout(inactivityTimer);
          inactivityTimer = undefined;
        }
        if (hardDeadlineTimer !== undefined) {
          this.deps.clearTimeout(hardDeadlineTimer);
          hardDeadlineTimer = undefined;
        }
        if (killTimer !== undefined) {
          this.deps.clearTimeout(killTimer);
          killTimer = undefined;
        }
        stdout.removeAllListeners('data');
        stderr.removeAllListeners('data');
        child.removeAllListeners('close');
        child.removeAllListeners('error');
      };

      const failOnce = (code: TranscriptionErrorCode, message: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new WhisperProcessError(code, message));
      };

      const succeedOnce = (value: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };

      const resetInactivityTimer = (): void => {
        if (inactivityTimer !== undefined) {
          this.deps.clearTimeout(inactivityTimer);
        }
        inactivityTimer = this.deps.setTimeout(() => {
          inactivityTimer = undefined;
          terminate('inactivity watchdog');
        }, INACTIVITY_MS);
      };

      const terminate = (_reason: string): void => {
        if (settled) {
          return;
        }
        timedOut = true;
        if (killTimer === undefined) {
          child.kill('SIGTERM');
          killTimer = this.deps.setTimeout(() => {
            killTimer = undefined;
            child.kill('SIGKILL');
          }, KILL_DELAY_MS);
        }
      };

      const onClose = async (code: number | null): Promise<void> => {
        if (settled) {
          return;
        }
        if (timedOut) {
          failOnce('LOCAL_TRANSCRIPTION_TIMEOUT', 'whisper-cli transcription timed out');
          return;
        }
        if (code !== 0) {
          failOnce(
            'LOCAL_TRANSCRIPTION_FAILED',
            `whisper-cli exited with code ${code ?? 'unknown'}`
          );
          return;
        }
        // The child is gone; clear timers and listeners now so a slow readFile
        // cannot trigger the watchdog or leave a live killTimer handle.
        cleanup();
        try {
          const data = await this.deps.readFile(`${input.outputPrefix}.json`, 'utf-8');
          succeedOnce(JSON.parse(data));
        } catch {
          failOnce('LOCAL_TRANSCRIPTION_FAILED', 'failed to read transcription output');
        }
      };

      const onSpawnError = (): void => {
        failOnce('LOCAL_TRANSCRIPTION_FAILED', 'whisper-cli failed to start');
      };

      stdout.on('data', resetInactivityTimer);
      stderr.on('data', resetInactivityTimer);
      child.on('close', onClose);
      child.on('error', onSpawnError);

      resetInactivityTimer();
      const hardDeadlineMs = Math.max(HARD_DEADLINE_MIN_MS, input.channelDurationMs * 2);
      hardDeadlineTimer = this.deps.setTimeout(() => {
        hardDeadlineTimer = undefined;
        terminate('hard deadline');
      }, hardDeadlineMs);
    });
  }
}
