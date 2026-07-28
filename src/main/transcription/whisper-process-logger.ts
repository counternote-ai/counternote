import { type TranscriptionErrorCode } from '../../types/transcription';

export type WhisperWatchdogReason = 'inactivity' | 'hard-deadline';
export type WhisperProcessFailurePhase = 'spawn' | 'runtime' | 'output-read';

export type WhisperProcessLogEvent =
  | { type: 'start'; mode: 'cpu'; pid: number | null; channelDurationMs: number }
  | { type: 'terminate'; reason: WhisperWatchdogReason; elapsedMs: number }
  | {
      type: 'exit';
      code: number | null;
      signal: NodeJS.Signals | null;
      elapsedMs: number;
      jsonRead: boolean;
    }
  | {
      type: 'failure';
      code: TranscriptionErrorCode;
      phase: WhisperProcessFailurePhase;
      diagnostic?: string;
    };

export interface WhisperProcessLogger {
  log(event: WhisperProcessLogEvent): void;
}

export class ConsoleWhisperProcessLogger implements WhisperProcessLogger {
  log(event: WhisperProcessLogEvent): void {
    switch (event.type) {
      case 'start':
        console.log(
          `[whisper-process] start mode=${event.mode} pid=${event.pid ?? 'unknown'} ` +
          `channelDurationMs=${event.channelDurationMs}`
        );
        return;
      case 'terminate':
        console.log(
          `[whisper-process] terminate reason=${event.reason} elapsedMs=${event.elapsedMs}`
        );
        return;
      case 'exit':
        console.log(
          `[whisper-process] exit code=${event.code ?? 'unknown'} ` +
          `signal=${event.signal ?? 'none'} elapsedMs=${event.elapsedMs} ` +
          `jsonRead=${event.jsonRead}`
        );
        return;
      case 'failure':
        console.log(
          `[whisper-process] failure code=${event.code} phase=${event.phase}` +
          (event.diagnostic === undefined
            ? ''
            : ` diagnostic=${JSON.stringify(event.diagnostic)}`)
        );
    }
  }
}

const MAX_LINE_CHARACTERS = 512;
const MAX_TAIL_CHARACTERS = 4096;
const ALLOWED_DIAGNOSTIC =
  /^(whisper_|ggml_|read_audio_data:|system_info:|main:|output_json:|error:|failed\b)/i;
const TRANSCRIPT_LINE = /^\s*\[[0-9:.]+\s*-->\s*[0-9:.]+\]/;
const ABSOLUTE_PATH = /(^|[\s"'=])\/(?:[^\s"'=]+\/?)+/g;
const GROQ_KEY = /\bgsk_[A-Za-z0-9_-]+\b/g;

export class WhisperDiagnosticBuffer {
  private partial = '';
  private readonly lines: string[] = [];

  append(chunk: string | Buffer): void {
    const parts = `${this.partial}${chunk.toString()}`.split(/[\r\n]/);
    this.partial = (parts.pop() ?? '').slice(-MAX_TAIL_CHARACTERS);
    for (const line of parts) {
      this.retain(line);
    }
  }

  finish(): void {
    if (this.partial.length > 0) {
      this.retain(this.partial);
      this.partial = '';
    }
  }

  summary(): string {
    return this.lines.join('\n');
  }

  private retain(line: string): void {
    const trimmed = line.trim();
    if (
      trimmed.length === 0 ||
      TRANSCRIPT_LINE.test(trimmed) ||
      !ALLOWED_DIAGNOSTIC.test(trimmed)
    ) {
      return;
    }

    const safeLine = trimmed
      .replace(GROQ_KEY, '<redacted-key>')
      .replace(
        ABSOLUTE_PATH,
        (_match: string, prefix: string) => `${prefix}<redacted-path>`
      )
      .slice(0, MAX_LINE_CHARACTERS);

    this.lines.push(safeLine);
    while (this.summary().length > MAX_TAIL_CHARACTERS) {
      this.lines.shift();
    }
  }
}
