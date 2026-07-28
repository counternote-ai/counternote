import { spawn, SpawnOptions, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { TranscriptionErrorCode } from '../../types/transcription';
import {
  ConsoleWhisperProcessLogger,
  WhisperDiagnosticBuffer,
  type WhisperProcessFailurePhase,
  type WhisperProcessLogger,
  type WhisperWatchdogReason,
} from './whisper-process-logger';

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
  logger: WhisperProcessLogger;
  now: () => number;
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
    logger: new ConsoleWhisperProcessLogger(),
    now: Date.now,
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
      '-l',
      'auto',
      '-sns',
      '-nth',
      '0.60',
      '-ng',
    ];

    const startedAt = this.deps.now();
    const diagnostics = new WhisperDiagnosticBuffer();

    let child: ChildProcess;
    try {
      child = this.deps.spawn(input.cliPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      } as SpawnOptions);
    } catch {
      diagnostics.finish();
      this.deps.logger.log({
        type: 'failure',
        code: 'LOCAL_TRANSCRIPTION_FAILED',
        phase: 'spawn',
        ...(diagnostics.summary() ? { diagnostic: diagnostics.summary() } : {}),
      });
      throw new WhisperProcessError(
        'LOCAL_TRANSCRIPTION_FAILED',
        'whisper-cli failed to start'
      );
    }

    this.deps.logger.log({
      type: 'start',
      mode: 'cpu',
      pid: child.pid ?? null,
      channelDurationMs: input.channelDurationMs,
    });

    if (!child.stdout || !child.stderr) {
      diagnostics.finish();
      this.deps.logger.log({
        type: 'failure',
        code: 'LOCAL_TRANSCRIPTION_FAILED',
        phase: 'spawn',
        ...(diagnostics.summary() ? { diagnostic: diagnostics.summary() } : {}),
      });
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
      let childExited = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;

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

      const failOnce = (
        code: TranscriptionErrorCode,
        message: string
      ): void => {
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
          terminate('inactivity');
        }, INACTIVITY_MS);
      };

      const terminate = (reason: WhisperWatchdogReason): void => {
        if (settled) {
          return;
        }
        timedOut = true;
        this.deps.logger.log({
          type: 'terminate',
          reason,
          elapsedMs: this.deps.now() - startedAt,
        });
        if (killTimer === undefined) {
          child.kill('SIGTERM');
          killTimer = this.deps.setTimeout(() => {
            killTimer = undefined;
            child.kill('SIGKILL');
          }, KILL_DELAY_MS);
        }
      };

      const logFailure = (
        code: TranscriptionErrorCode,
        phase: WhisperProcessFailurePhase
      ): void => {
        diagnostics.finish();
        if (childExited) {
          this.deps.logger.log({
            type: 'exit',
            code: exitCode,
            signal: exitSignal,
            elapsedMs: this.deps.now() - startedAt,
            jsonRead: false,
          });
        }
        this.deps.logger.log({
          type: 'failure',
          code,
          phase,
          ...(diagnostics.summary() ? { diagnostic: diagnostics.summary() } : {}),
        });
      };

      const onClose = async (
        code: number | null,
        signal: NodeJS.Signals | null
      ): Promise<void> => {
        if (settled) {
          return;
        }
        childExited = true;
        exitCode = code;
        exitSignal = signal ?? null;
        if (timedOut) {
          failOnce('LOCAL_TRANSCRIPTION_TIMEOUT', 'whisper-cli transcription timed out');
          return;
        }
        if (code !== 0) {
          const exitReason = signal === null || signal === undefined
            ? `code ${code ?? 'unknown'}`
            : `signal ${signal}`;
          logFailure('LOCAL_TRANSCRIPTION_FAILED', 'runtime');
          failOnce(
            'LOCAL_TRANSCRIPTION_FAILED',
            `whisper-cli exited with ${exitReason}`
          );
          return;
        }
        // The child is gone; clear timers and listeners now so a slow readFile
        // cannot trigger the watchdog or leave a live killTimer handle.
        cleanup();
        try {
          const data = await this.deps.readFile(`${input.outputPrefix}.json`, 'utf-8');
          this.deps.logger.log({
            type: 'exit',
            code: 0,
            signal: null,
            elapsedMs: this.deps.now() - startedAt,
            jsonRead: true,
          });
          succeedOnce(JSON.parse(data));
        } catch {
          logFailure('LOCAL_TRANSCRIPTION_FAILED', 'output-read');
          failOnce('LOCAL_TRANSCRIPTION_FAILED', 'failed to read transcription output');
        }
      };

      const onSpawnError = (): void => {
        logFailure('LOCAL_TRANSCRIPTION_FAILED', 'spawn');
        failOnce('LOCAL_TRANSCRIPTION_FAILED', 'whisper-cli failed to start');
      };

      stdout.on('data', resetInactivityTimer);
      stderr.on('data', (chunk: string | Buffer) => {
        diagnostics.append(chunk);
        resetInactivityTimer();
      });
      child.on('close', onClose);
      child.on('error', onSpawnError);

      resetInactivityTimer();
      const hardDeadlineMs = Math.max(HARD_DEADLINE_MIN_MS, input.channelDurationMs * 2);
      hardDeadlineTimer = this.deps.setTimeout(() => {
        hardDeadlineTimer = undefined;
        terminate('hard-deadline');
      }, hardDeadlineMs);
    });
  }
}
