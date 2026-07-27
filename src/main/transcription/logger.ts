import { TranscriptionStage } from '../../types/transcription';

export type TranscriptionLogCategory =
  | 'start'
  | 'success'
  | 'failure'
  | 'cleanup'
  | 'cleanup-failed';

export interface TranscriptionLogger {
  log(
    recordingId: string,
    stage: TranscriptionStage,
    category: TranscriptionLogCategory,
    elapsedMs: number
  ): void;
}

export class ConsoleTranscriptionLogger implements TranscriptionLogger {
  log(
    recordingId: string,
    stage: TranscriptionStage,
    category: TranscriptionLogCategory,
    elapsedMs: number
  ): void {
    console.log(
      `[transcription] ${category} recording=${recordingId} stage=${stage} elapsedMs=${elapsedMs}`
    );
  }
}
