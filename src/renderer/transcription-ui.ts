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
      return 'Transcribing interviewer';
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
      return 'Local transcription could not start. Your recording is still saved. Retry, or select Groq in Settings.';
    case 'MODEL_DOWNLOAD_FAILED':
      return 'The local model download failed. Your recording is still saved. Check your connection and try again.';
    case 'MODEL_CHECKSUM_FAILED':
      return 'The local model could not be verified. Your recording is still saved. Try downloading it again.';
    case 'LOCAL_TRANSCRIPTION_FAILED':
      return 'Local transcription failed. Your recording is still saved. Try again, or select Groq in Settings.';
    case 'LOCAL_TRANSCRIPTION_TIMEOUT':
      return 'Local transcription stopped responding. Your recording is still saved. Try again, or select Groq in Settings.';
    case 'GROQ_KEY_MISSING':
      return 'Transcription needs a Groq API key. Your recording is still saved. Add one in Settings, then try again.';
    case 'GROQ_RATE_LIMITED':
      return `Groq's rate limit was reached. Your recording is still saved. ${getRetryMessage(failure.retryAfterSeconds)}`;
    case 'GROQ_TIMEOUT':
      return 'Groq transcription timed out. Your recording is still saved. Check your connection and try again.';
    case 'GROQ_REJECTED':
      return 'Groq could not transcribe this recording. Your recording is still saved. Check Settings and try again.';
    case 'AUDIO_PREPARATION_FAILED':
      return 'Audio preparation failed. Your recording is still saved. Try again.';
    case 'TRANSCRIPT_WRITE_FAILED':
      return 'The transcript could not be saved. Your recording is still saved. Try again.';
    default:
      return assertNever(failure.code);
  }
}

function getRetryMessage(retryAfterSeconds: number | undefined): string {
  if (
    !Number.isFinite(retryAfterSeconds) ||
    retryAfterSeconds === undefined ||
    retryAfterSeconds <= 0
  ) {
    return 'Try again later.';
  }

  if (retryAfterSeconds < 60) {
    const seconds = Math.ceil(retryAfterSeconds);
    return `Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
  }

  const minutes = Math.ceil(retryAfterSeconds / 60);
  return `Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected transcription value: ${String(value)}`);
}
