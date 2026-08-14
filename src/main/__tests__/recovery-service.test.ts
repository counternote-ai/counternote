import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getAudioDuration } from '../audio-processor';
import { RecordingMutationCoordinator } from '../recording-mutation-coordinator';
import { RecoveryService } from '../recovery-service';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const SECOND_SESSION_ID = '123e4567-e89b-42d3-a456-426614174001';

describe('RecoveryService', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-recovery-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('lists recovery and inactive in-progress items without paths, normalizing when possible', async () => {
    await writeFailed(root, '.recovery', SESSION_ID, 128, validFailedMetadata());
    await writeFailed(root, '.in-progress', SECOND_SESSION_ID, 2, undefined);
    const service = createService();

    await expect(service.list(SECOND_SESSION_ID)).resolves.toEqual([
      { id: SESSION_ID, createdAt: '2026-08-12T01:02:03.004Z', bytes: expect.any(Number), state: 'recoverable' },
    ]);
    await expect(fs.stat(path.join(root, '.in-progress', SECOND_SESSION_ID))).resolves.toBeDefined();

    await expect(service.list()).resolves.toEqual(expect.arrayContaining([
      { id: SESSION_ID, createdAt: '2026-08-12T01:02:03.004Z', bytes: expect.any(Number), state: 'recoverable' },
      { id: SECOND_SESSION_ID, createdAt: expect.any(String), bytes: expect.any(Number), state: 'not-recoverable' },
    ]));
    await expect(fs.stat(path.join(root, '.recovery', SECOND_SESSION_ID))).resolves.toBeDefined();
  });

  it('excludes the active session even when a failed item has reached recovery', async () => {
    await writeFailed(root, '.recovery', SESSION_ID, 128, validFailedMetadata());
    await writeFailed(root, '.recovery', SECOND_SESSION_ID, 128, validFailedMetadata());

    await expect(createService().list(SESSION_ID)).resolves.toEqual([
      expect.objectContaining({ id: SECOND_SESSION_ID }),
    ]);
  });

  it.each([
    ['short', 43],
    ['empty', 44],
    ['misaligned', 45],
  ])('preserves a %s source byte-for-byte when it cannot be recovered', async (_name, size) => {
    const directory = await writeFailed(root, '.recovery', SESSION_ID, Math.max(0, size - 44), validFailedMetadata());
    await fs.writeFile(path.join(directory, 'audio.wav'), Buffer.alloc(size));
    const before = await snapshot(directory);

    await expect(createService().recover(SESSION_ID)).resolves.toEqual({ outcome: 'not-recoverable' });

    expect(await snapshot(directory)).toEqual(before);
    await expect(fs.readdir(path.join(root, '.recovery'))).resolves.toEqual([SESSION_ID]);
    await expect(fs.readdir(root)).resolves.not.toContain(expect.stringMatching(/^2026-/));
  });

  it('rejects symlinked audio and an escaping recovery directory without changing the target', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-recovery-outside-'));
    const source = await writeFailed(root, '.recovery', SESSION_ID, 128, validFailedMetadata());
    await fs.rename(path.join(source, 'audio.wav'), path.join(outside, 'audio.wav'));
    await fs.symlink(path.join(outside, 'audio.wav'), path.join(source, 'audio.wav'));
    await fs.symlink(outside, path.join(root, '.recovery', SECOND_SESSION_ID));
    const before = await snapshot(source);

    await expect(createService().recover(SESSION_ID)).resolves.toEqual({ outcome: 'not-recoverable' });
    await expect(createService().recover(SECOND_SESSION_ID)).resolves.toEqual({ outcome: 'not-found' });

    expect(await snapshot(source)).toEqual(before);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('repairs aligned PCM, preserves known interruptions, and publishes only after normal WAV validation', async () => {
    const metadata = validFailedMetadata({
      interruptions: [{ channel: 'capture', startMs: 0, endMs: 0, recovered: false, reason: 'helper-exit' }],
    });
    const source = await writeFailed(root, '.recovery', SESSION_ID, 1_280, metadata);
    const before = await snapshot(source);
    const service = createService();

    await expect(service.recover(SESSION_ID)).resolves.toEqual({ outcome: 'recovered' });

    await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    const [id] = (await fs.readdir(root)).filter((entry) => /^\d{4}-/.test(entry));
    const published = path.join(root, id);
    await expect(getAudioDuration(path.join(published, 'audio.wav'))).resolves.toBeCloseTo(1_280 / 64_000, 10);
    await expect(fs.readFile(path.join(published, 'capture.json'), 'utf8')).resolves.toContain('"persistence-error"');
    expect(before['audio.wav']).toEqual(await fs.readFile(path.join(published, 'audio.wav')).then((audio) => Buffer.concat([before['audio.wav'].subarray(0, 44), audio.subarray(44)])));
  });

  it('does not duplicate a persistence-error interruption and retains the source after post-publication cleanup failure', async () => {
    const durationMs = 20;
    await writeFailed(root, '.recovery', SESSION_ID, 1_280, validFailedMetadata({
      interruptions: [{ channel: 'capture', startMs: durationMs, endMs: durationMs, recovered: false, reason: 'persistence-error' }],
    }));
    await expect(createService({
      removeSource: async (): Promise<void> => { throw new Error('no'); },
    }).recover(SESSION_ID)).resolves.toEqual({ outcome: 'recovered-with-retained-source' });

    const [id] = (await fs.readdir(root)).filter((entry) => /^\d{4}-/.test(entry));
    const metadata = JSON.parse(await fs.readFile(path.join(root, id, 'capture.json'), 'utf8')) as { interruptions: unknown[] };
    expect(metadata.interruptions).toHaveLength(1);
    await expect(fs.stat(path.join(root, '.recovery', SESSION_ID))).resolves.toBeDefined();
  });

  it('removes only its hidden repair directory when normal WAV validation fails', async () => {
    const source = await writeFailed(root, '.recovery', SESSION_ID, 1_280, validFailedMetadata());
    const before = await snapshot(source);

    await expect(createService({
      readAudioDuration: async (): Promise<number> => { throw new Error('invalid WAV'); },
    }).recover(SESSION_ID)).resolves.toEqual({ outcome: 'recovery-failed' });

    expect(await snapshot(source)).toEqual(before);
    await expect(fs.readdir(path.join(root, '.recovery'))).resolves.toEqual([SESSION_ID]);
    await expect(fs.readdir(root)).resolves.not.toContain(expect.stringMatching(/^2026-/));
  });

  it('does not follow an audio path swapped to an escaping symlink after inspection', async () => {
    const source = await writeFailed(root, '.recovery', SESSION_ID, 1_280, validFailedMetadata());
    const original = await fs.readFile(path.join(source, 'audio.wav'));
    const backup = path.join(root, '.recovery', '.original-audio.wav');
    const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'recovery-race-outside-'));
    const outside = path.join(outsideDirectory, 'audio.wav');
    const outsideAudio = Buffer.concat([Buffer.alloc(44), Buffer.alloc(1_280, 9)]);
    await fs.writeFile(outside, outsideAudio);
    try {
      await expect(createService({
        beforeCopy: async (audioPath: string): Promise<void> => {
          await fs.rename(audioPath, backup);
          await fs.symlink(outside, audioPath);
        },
      }).recover(SESSION_ID)).resolves.toEqual({ outcome: 'recovery-failed' });

      await expect(fs.readFile(backup)).resolves.toEqual(original);
      await expect(fs.readFile(outside)).resolves.toEqual(outsideAudio);
      expect((await fs.lstat(path.join(source, 'audio.wav'))).isSymbolicLink()).toBe(true);
      await expect(fs.readdir(path.join(root, '.recovery'))).resolves.toEqual(expect.arrayContaining([SESSION_ID, '.original-audio.wav']));
      await expect(fs.readdir(root)).resolves.not.toContain(expect.stringMatching(/^2026-/));
    } finally {
      await fs.rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  it('uses the platform Trash only after validating a UUID item and leaves failures visible', async () => {
    await writeFailed(root, '.recovery', SESSION_ID, 128, validFailedMetadata());
    const trashItem = jest.fn().mockRejectedValue(new Error('cancelled'));
    const service = createService({ trashItem });

    await expect(service.moveToTrash('../not-an-id')).resolves.toEqual({ outcome: 'not-found' });
    await expect(service.moveToTrash(SESSION_ID)).resolves.toEqual({ outcome: 'trash-failed' });

    expect(trashItem).toHaveBeenCalledTimes(1);
    await expect(fs.stat(path.join(root, '.recovery', SESSION_ID))).resolves.toBeDefined();
  });

  function createService(overrides: {
    trashItem?: (target: string) => Promise<void>;
    removeSource?: (directory: string) => Promise<void>;
    readAudioDuration?: (audioPath: string) => Promise<number>;
    beforeCopy?: (audioPath: string) => Promise<void>;
  } = {}): RecoveryService {
    return new RecoveryService(() => root, new RecordingMutationCoordinator(), {
      trashItem: overrides.trashItem ?? jest.fn().mockResolvedValue(undefined),
      ...(overrides.removeSource === undefined ? {} : { removeSource: overrides.removeSource }),
      ...(overrides.readAudioDuration === undefined ? {} : { readAudioDuration: overrides.readAudioDuration }),
      ...(overrides.beforeCopy === undefined ? {} : { beforeCopy: overrides.beforeCopy }),
      now: () => new Date('2026-08-13T00:00:00.000Z'),
    });
  }
});

async function writeFailed(
  root: string,
  parent: '.recovery' | '.in-progress',
  id: string,
  pcmBytes: number,
  metadata: object | undefined,
): Promise<string> {
  const directory = path.join(root, parent, id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'audio.wav'), Buffer.concat([Buffer.alloc(44), Buffer.alloc(pcmBytes, 7)]));
  if (metadata !== undefined) await fs.writeFile(path.join(directory, 'capture.json'), JSON.stringify(metadata));
  return directory;
}

function validFailedMetadata(overrides: Record<string, unknown> = {}): object {
  return {
    version: 1,
    status: 'failed',
    startedAt: '2026-08-12T01:02:03.004Z',
    endedAt: '2026-08-12T01:02:03.024Z',
    channels: { interviewer: { started: true }, you: { started: true } },
    interruptions: [],
    ...overrides,
  };
}

async function snapshot(directory: string): Promise<Record<string, Buffer>> {
  const snapshot: Record<string, Buffer> = {};
  for (const entry of await fs.readdir(directory)) {
    const stat = await fs.lstat(path.join(directory, entry));
    if (stat.isFile() || stat.isSymbolicLink()) snapshot[entry] = await fs.readFile(path.join(directory, entry));
  }
  return snapshot;
}
