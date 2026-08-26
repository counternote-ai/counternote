import type { TranscriptionErrorCode, TranscriptionProgress } from '../types/transcription';

export interface TranscriptionErrorInput {
  code: TranscriptionErrorCode;
  retryAfterSeconds?: number;
}

export function getTranscriptionStageLabel(progress: TranscriptionProgress): string {
  switch (progress.stage) {
    case 'preparing-audio':
      return 'Preparing audio';
    case 'downloading-model':
      return progress.percent === undefined
        ? 'Downloading model'
        : `Downloading model · ${progress.percent}%`;
    case 'transcribing-interviewer':
      return 'Transcribing meeting audio';
    case 'transcribing-you':
      return 'Transcribing you';
    case 'finishing-transcript':
      return 'Finishing transcript';
    default:
      return assertNever(progress.stage);
  }
}

export function getTranscriptionErrorMessage(failure: TranscriptionErrorInput): string {
  switch (failure.code) {
    case 'TRANSCRIPTION_BUSY':
      return 'Another recording is already being transcribed. Wait for it to finish, then try again.';
    case 'LOCAL_UNAVAILABLE':
      return 'Local transcription could not start. Your recording is still saved. Open Settings and check the local model, then try again.';
    case 'MODEL_DOWNLOAD_FAILED':
      return 'The local model download failed. Your recording is still saved. Check your connection and try again.';
    case 'MODEL_CHECKSUM_FAILED':
      return 'The local model could not be verified. Your recording is still saved. Try downloading it again.';
    case 'LOCAL_TRANSCRIPTION_FAILED':
      return 'Local transcription failed. Your recording is still saved. Try again.';
    case 'LOCAL_TRANSCRIPTION_TIMEOUT':
      return 'Local transcription stopped responding. Your recording is still saved. Try again.';
    case 'AUDIO_PREPARATION_FAILED':
      return 'Audio preparation failed. Your recording is still saved. Try again.';
    case 'TRANSCRIPT_WRITE_FAILED':
      return 'The transcript could not be saved. Your recording is still saved. Try again.';
    default:
      return assertNever(failure.code);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected transcription value: ${String(value)}`);
}
