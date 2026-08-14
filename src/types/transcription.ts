export type TranscriptionProvider = 'local' | 'groq';

export type TranscriptionStage =
  | 'preparing-audio'
  | 'downloading-model'
  | 'transcribing-interviewer'
  | 'transcribing-you'
  | 'finishing-transcript';

export interface TranscriptionProgress {
  recordingId: string;
  stage: TranscriptionStage;
  percent?: number;
}

export type LocalModelState =
  'not-downloaded' | 'downloading' | 'ready' | 'invalid' | 'unavailable';

export interface LocalModelStatus {
  state: LocalModelState;
  percent?: number;
  reason?: 'unsupported-platform' | 'sidecar-missing';
}

export type TranscriptionErrorCode =
  | 'TRANSCRIPTION_BUSY'
  | 'LOCAL_UNAVAILABLE'
  | 'MODEL_DOWNLOAD_FAILED'
  | 'MODEL_CHECKSUM_FAILED'
  | 'LOCAL_TRANSCRIPTION_FAILED'
  | 'LOCAL_TRANSCRIPTION_TIMEOUT'
  | 'GROQ_KEY_MISSING'
  | 'GROQ_RATE_LIMITED'
  | 'GROQ_TIMEOUT'
  | 'GROQ_REJECTED'
  | 'AUDIO_PREPARATION_FAILED'
  | 'TRANSCRIPT_WRITE_FAILED';

export interface TranscriptionFailure {
  success: false;
  code: TranscriptionErrorCode;
  retryAfterSeconds?: number;
}

export interface TranscriptionSuccess {
  success: true;
}

export type TranscriptionIpcResult = TranscriptionSuccess | TranscriptionFailure;
