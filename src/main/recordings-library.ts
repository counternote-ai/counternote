import * as path from 'path';

const RECORDING_ID_REGEX = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9A-Za-z.-]+Z$/;

export class RecordingsLibrary {
  constructor(private readonly getConfiguredRoot: () => string) {}

  getRoot(): string {
    return path.resolve(this.getConfiguredRoot());
  }

  resolveRecordingAudio(recordingId: string): string {
    if (!RECORDING_ID_REGEX.test(recordingId)) {
      throw new Error('INVALID_RECORDING_ID');
    }

    const root = this.getRoot();
    return path.join(root, recordingId, 'audio.wav');
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
}
