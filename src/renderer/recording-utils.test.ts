import { formatDuration, getRecordingStatus, getTranscriptMeta } from './recording-utils';

describe('recording renderer utilities', () => {
  it('formats durations as compact minutes and seconds', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3725)).toBe('62:05');
  });

  it('describes recording transcription state', () => {
    expect(getRecordingStatus({ transcribed: true, isTranscribing: false })).toEqual({
      label: 'Ready',
      tone: 'ready',
    });
    expect(getRecordingStatus({ transcribed: false, isTranscribing: true })).toEqual({
      label: 'Transcribing',
      tone: 'loading',
    });
    expect(getRecordingStatus({ transcribed: false, isTranscribing: false })).toEqual({
      label: 'Needs transcript',
      tone: 'pending',
    });
  });

  it('builds transcript metadata from duration and segment count', () => {
    expect(getTranscriptMeta({ duration: 1850, segmentCount: 42 })).toBe('30:50 - 42 segments - transcript ready');
  });
});
