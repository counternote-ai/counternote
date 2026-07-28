import * as path from 'path';
import { hasTranscriptSegments, RecordingsLibrary } from '../recordings-library';

describe('RecordingsLibrary', () => {
  it('resolves audio only inside the configured recordings root', () => {
    const library = new RecordingsLibrary(() => '/library');

    expect(library.resolveRecordingAudio('2026-07-27T01-03-28-361Z'))
      .toBe('/library/2026-07-27T01-03-28-361Z/audio.wav');
    expect(() => library.resolveRecordingAudio('../secrets'))
      .toThrow('INVALID_RECORDING_ID');
  });

  it('resolves transcripts only from a validated recording directory', () => {
    const library = new RecordingsLibrary(() => '/library');

    expect(library.resolveRecordingTranscript('2026-07-27T01-03-28-361Z'))
      .toBe('/library/2026-07-27T01-03-28-361Z/transcript.json');
    expect(() => library.resolveRecordingTranscript('/private/secret/transcript.json'))
      .toThrow('INVALID_RECORDING_ID');
  });

  it('rejects sibling paths that merely share the root prefix', () => {
    const library = new RecordingsLibrary(() => '/library');

    expect(library.contains('/library/item/audio.wav')).toBe(true);
    expect(library.contains('/library-copy/item/audio.wav')).toBe(false);
  });

  it('rejects traversal that escapes the root', () => {
    const library = new RecordingsLibrary(() => '/library');

    expect(library.contains('/library/../secrets/audio.wav')).toBe(false);
  });

  it('does not mark an empty transcript artifact as ready', () => {
    expect(hasTranscriptSegments([])).toBe(false);
    expect(hasTranscriptSegments(undefined)).toBe(false);
    expect(hasTranscriptSegments([{ start: 0, end: 1, text: 'Hello', speaker: 'You' }]))
      .toBe(true);
  });
});
