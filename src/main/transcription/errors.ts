import { TranscriptionErrorCode } from '../../types/transcription';

export class TranscriptionError extends Error {
  constructor(
    readonly code: TranscriptionErrorCode,
    readonly details: { retryAfterSeconds?: number; status?: number; exitCode?: number } = {}
  ) {
    super(code);
    this.name = 'TranscriptionError';
  }
}
