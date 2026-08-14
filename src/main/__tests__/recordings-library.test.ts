import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
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

  it('shows only valid legacy, complete, and interrupted recording directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'recordings-library-'));
    const valid = {
      version: 1,
      status: 'complete',
      startedAt: '2026-08-12T01:02:03.004Z',
      endedAt: '2026-08-12T01:02:03.024Z',
      channels: { interviewer: { started: true }, you: { started: true } },
      interruptions: [],
    };
    const create = async (id: string, metadata?: object): Promise<void> => {
      const directory = path.join(root, id);
      await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, 'audio.wav'), Buffer.alloc(44));
      if (metadata !== undefined) await fs.writeFile(path.join(directory, 'capture.json'), JSON.stringify(metadata));
    };
    await create('2026-08-12T01-02-03-004Z');
    await create('2026-08-12T01-02-03-005Z', valid);
    await create('2026-08-12T01-02-03-006Z', { ...valid, status: 'interrupted', interruptions: [{ channel: 'capture', startMs: 0, endMs: 0, recovered: false, reason: 'helper-exit' }] });
    await create('2026-08-12T01-02-03-007Z', { ...valid, status: 'provisional' });
    await create('2026-08-12T01-02-03-008Z', { ...valid, startedAt: 'invalid' });
    await create('2026-08-12T01-02-03-009Z', { ...valid, status: 'interrupted', interruptions: [{ channel: 'you', startMs: 0, endMs: 20, recovered: true, reason: 'format-limit' }] });
    await create('2026-08-12T01-02-03-011Z', valid);
    await fs.unlink(path.join(root, '2026-08-12T01-02-03-011Z', 'audio.wav'));
    await fs.symlink(path.join(root, '2026-08-12T01-02-03-004Z', 'audio.wav'), path.join(root, '2026-08-12T01-02-03-011Z', 'audio.wav'));
    await create('2026-08-12T01-02-03-012Z', {
      ...valid,
      status: 'interrupted',
      interruptions: [{ channel: 'capture', startMs: 20.0625, endMs: 20.0625, recovered: false, reason: 'persistence-error' }],
    });
    await fs.writeFile(path.join(root, '2026-08-12T01-02-03-012Z', 'audio.wav'), Buffer.alloc(44 + 1_284));
    await fs.mkdir(path.join(root, '.in-progress'));
    await fs.symlink(path.join(root, '2026-08-12T01-02-03-004Z'), path.join(root, '2026-08-12T01-02-03-010Z'));

    const recordings = await new RecordingsLibrary(() => root).list();

    expect(recordings).toEqual([
      { id: '2026-08-12T01-02-03-004Z', captureStatus: 'legacy', interruptions: [] },
      { id: '2026-08-12T01-02-03-005Z', captureStatus: 'complete', interruptions: [] },
      { id: '2026-08-12T01-02-03-006Z', captureStatus: 'interrupted', interruptions: [{ channel: 'capture', startMs: 0, endMs: 0, recovered: false, reason: 'helper-exit' }] },
      { id: '2026-08-12T01-02-03-012Z', captureStatus: 'interrupted', interruptions: [{ channel: 'capture', startMs: 20.0625, endMs: 20.0625, recovered: false, reason: 'persistence-error' }] },
    ]);
    await fs.rm(root, { recursive: true });
  });
});
