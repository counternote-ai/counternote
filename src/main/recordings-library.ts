import * as path from 'path';

const RECORDING_ID_REGEX = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9A-Za-z.-]+Z$/;

export function hasTranscriptSegments(segments: unknown): boolean {
  return Array.isArray(segments) && segments.length > 0;
}

export class RecordingsLibrary {
  constructor(private readonly getConfiguredRoot: () => string) {}

  getRoot(): string {
    return path.resolve(this.getConfiguredRoot());
  }

  resolveRecordingAudio(recordingId: string): string {
    return this.resolveRecordingFile(recordingId, 'audio.wav');
  }

  resolveRecordingTranscript(recordingId: string): string {
    return this.resolveRecordingFile(recordingId, 'transcript.json');
  }

  contains(candidate: string): boolean {
    const root = this.getRoot();
    const absolute = path.resolve(candidate);
    const relative = path.relative(root, absolute);

    if (relative === '') {
      return true;
    }

    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  private resolveRecordingFile(recordingId: string, fileName: 'audio.wav' | 'transcript.json'): string {
    if (!RECORDING_ID_REGEX.test(recordingId)) {
      throw new Error('INVALID_RECORDING_ID');
    }

    return path.join(this.getRoot(), recordingId, fileName);
  }
}
