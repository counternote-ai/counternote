import * as path from 'path';
import { RecordingsLibrary } from '../recordings-library';

describe('RecordingsLibrary', () => {
  it('resolves audio only inside the configured recordings root', () => {
    const library = new RecordingsLibrary(() => '/library');

    expect(library.resolveRecordingAudio('2026-07-27T01-03-28-361Z'))
      .toBe('/library/2026-07-27T01-03-28-361Z/audio.wav');
    expect(() => library.resolveRecordingAudio('../secrets'))
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
});
