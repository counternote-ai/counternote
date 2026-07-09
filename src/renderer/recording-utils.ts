export type RecordingStatusTone = 'ready' | 'pending' | 'loading';

export interface RecordingStatusInput {
  transcribed: boolean;
  isTranscribing: boolean;
}

export interface RecordingStatus {
  label: string;
  tone: RecordingStatusTone;
}

export function formatDuration(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function getRecordingStatus(input: RecordingStatusInput): RecordingStatus {
  if (input.isTranscribing) {
    return { label: 'Transcribing', tone: 'loading' };
  }

  if (input.transcribed) {
    return { label: 'Ready', tone: 'ready' };
  }

  return { label: 'Needs transcript', tone: 'pending' };
}

export function getTranscriptMeta(input: { duration: number; segmentCount: number }): string {
  const segmentLabel = input.segmentCount === 1 ? '1 segment' : `${input.segmentCount} segments`;
  return `${formatDuration(input.duration)} - ${segmentLabel} - transcript ready`;
}
