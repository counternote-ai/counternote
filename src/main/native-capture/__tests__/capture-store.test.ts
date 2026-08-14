import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  CaptureStore,
  type CaptureMetadata,
} from '../capture-store';
import {
  blockIndexToMilliseconds,
  MAX_CAPTURE_DURATION_MS,
  parseCaptureMetadata,
  validateRecoveredCaptureMetadata,
} from '../capture-metadata';
import { RecordingsLibrary } from '../../recordings-library';

const recordingId = '2026-08-12T01-02-03-004Z';

function terminalMetadata(
  overrides: Partial<Extract<CaptureMetadata, { status: 'complete' | 'interrupted' | 'failed' }>> = {},
): Extract<CaptureMetadata, { status: 'complete' | 'interrupted' | 'failed' }> {
  return {
    version: 1,
    status: 'complete',
    startedAt: '2026-08-12T01:02:03.004Z',
    endedAt: '2026-08-12T01:02:03.024Z',
    channels: { interviewer: { started: true }, you: { started: true } },
    interruptions: [],
    ...overrides,
  };
}

async function temporaryRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'capture-store-'));
}

function provisionalWavHeader(): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(64_000, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(0, 40);
  return header;
}

describe('capture metadata', () => {
  it('accepts only the closed persisted schema', () => {
    expect(parseCaptureMetadata({
      version: 1,
      status: 'provisional',
      startedAt: '2026-08-12T01:02:03.004Z',
      channels: { interviewer: { started: true }, you: { started: false } },
      interruptions: [],
    })).not.toBeNull();

    expect(parseCaptureMetadata({ ...terminalMetadata(), endedAt: undefined })).toBeNull();
    expect(parseCaptureMetadata({ ...terminalMetadata(), startedAt: 'not-an-iso-time' })).toBeNull();
    expect(parseCaptureMetadata({ ...terminalMetadata(), endedAt: '2026-08-12T01:02:03.003Z' })).toBeNull();
    expect(parseCaptureMetadata({ ...terminalMetadata(), channels: { interviewer: { started: true } } })).toBeNull();
    expect(parseCaptureMetadata({ ...terminalMetadata(), interruptions: [{
      channel: 'interviewer', startMs: 0, endMs: 20, recovered: true, reason: 'buffer-overflow',
    }] })).toBeNull();
    expect(parseCaptureMetadata({ ...terminalMetadata(), interruptions: [{
      channel: 'interviewer', startMs: 0, endMs: 20, recovered: true, reason: 'source-gap',
    }] })).toBeNull();
    expect(parseCaptureMetadata({ ...terminalMetadata(), status: 'interrupted', interruptions: [] })).toBeNull();
    expect(parseCaptureMetadata({ ...terminalMetadata(), sessionId: 'private' })).toBeNull();

    const serialized = JSON.stringify(terminalMetadata());
    expect(serialized).not.toMatch(/sessionId|recordingId|createdAt|finalBlockExclusive/);
    expect(blockIndexToMilliseconds(1)).toBe(20);
    expect(blockIndexToMilliseconds(3_355_443)).toBe(MAX_CAPTURE_DURATION_MS);
    expect(() => blockIndexToMilliseconds(3_355_444)).toThrow('INVALID_BLOCK_INDEX');
  });

  it('allows fractional interruption timing only through recovery validation at the WAV extent', () => {
    const recovered = terminalMetadata({
      status: 'interrupted',
      interruptions: [{
        channel: 'capture', startMs: 20.0625, endMs: 20.0625, recovered: false, reason: 'persistence-error',
      }],
    });
    const ordinary = terminalMetadata({
      status: 'interrupted',
      interruptions: [{
        channel: 'capture', startMs: 0.5, endMs: 0.5, recovered: false, reason: 'helper-exit',
      }],
    });

    expect(parseCaptureMetadata(recovered)).toBeNull();
    expect(parseCaptureMetadata(ordinary)).toBeNull();
    expect(validateRecoveredCaptureMetadata(recovered, 20.0625)).toMatchObject({ status: 'interrupted' });
    expect(() => validateRecoveredCaptureMetadata(recovered, 20)).toThrow('INVALID_RECOVERY_METADATA');
    expect(() => validateRecoveredCaptureMetadata(recovered, 20.1)).toThrow('INVALID_RECOVERY_WAV_EXTENT');
  });
});

describe('CaptureStore', () => {
  it('stages provisional metadata privately and rejects target collisions', async () => {
    const root = await temporaryRoot();
    const store = new CaptureStore(() => root);
    await fs.mkdir(path.join(root, recordingId));

    await expect(store.begin(recordingId)).rejects.toThrow('RECORDING_ID_COLLISION');
    await fs.rm(path.join(root, recordingId), { recursive: true });

    const session = await store.begin(recordingId);
    expect(session.stagingDirectory).toMatch(/\/\.in-progress\//);
    expect(session.audioFilePath).toBe(path.join(session.stagingDirectory, 'audio.wav'));
    const metadata = JSON.parse(await fs.readFile(path.join(session.stagingDirectory, 'capture.json'), 'utf8')) as Record<string, unknown>;
    expect(metadata.status).toBe('provisional');
    expect(metadata).not.toHaveProperty('sessionId');
    expect(metadata).not.toHaveProperty('recordingId');
    await fs.rm(root, { recursive: true });
  });

  it('atomically replaces metadata and publishes by same-filesystem rename', async () => {
    const root = await temporaryRoot();
    const store = new CaptureStore(() => root);
    const session = await store.begin(recordingId);
    await fs.writeFile(session.audioFilePath, Buffer.alloc(44));

    await store.publish(session, terminalMetadata(), 1);

    const published = path.join(root, recordingId);
    expect(await fs.stat(published)).toMatchObject({ isDirectory: expect.any(Function) });
    expect(JSON.parse(await fs.readFile(path.join(published, 'capture.json'), 'utf8'))).toMatchObject({ status: 'complete' });
    expect((await fs.readdir(published)).some((entry) => entry.includes('.tmp-'))).toBe(false);
    await fs.rm(root, { recursive: true });
  });

  it('moves failed sessions into recovery and leaves them in progress when recovery rename fails', async () => {
    const root = await temporaryRoot();
    const store = new CaptureStore(() => root);
    const first = await store.begin(recordingId);
    await store.retainFailed(first, terminalMetadata({ status: 'failed' }));
    await expect(fs.stat(path.join(root, '.recovery', first.sessionId))).resolves.toBeDefined();

    const second = await store.begin('2026-08-12T01-02-03-005Z');
    const failingStore = new CaptureStore(() => root, {
      reserveDirectory: async () => { throw new Error('reservation failed'); },
      linkAudio: fs.link,
    });
    await expect(failingStore.retainFailed(second, terminalMetadata({ status: 'failed' }))).rejects.toThrow('reservation failed');
    expect(await fs.stat(second.stagingDirectory)).toMatchObject({ isDirectory: expect.any(Function) });
    await fs.rm(root, { recursive: true });
  });

  it('does not replace a recording or recovery directory reserved by a deterministic race', async () => {
    const root = await temporaryRoot();
    const racingOperations = {
      reserveDirectory: async (destination: string): Promise<void> => {
        await fs.mkdir(destination);
        await fs.writeFile(path.join(destination, 'sentinel'), 'preserve me');
        await fs.mkdir(destination);
      },
      linkAudio: fs.link,
    };
    const store = new CaptureStore(() => root, racingOperations);
    const published = await store.begin(recordingId);
    await fs.writeFile(published.audioFilePath, provisionalWavHeader());
    await expect(store.publish(published, terminalMetadata(), 0)).rejects.toThrow('RECORDING_ID_COLLISION');
    expect(await fs.readFile(path.join(root, recordingId, 'sentinel'), 'utf8')).toBe('preserve me');
    await expect(fs.stat(published.stagingDirectory)).resolves.toBeDefined();

    const recovered = await store.begin('2026-08-12T01-02-03-005Z');
    await expect(store.retainFailed(recovered, terminalMetadata({ status: 'failed' }))).rejects.toThrow('RECOVERY_ID_COLLISION');
    expect(await fs.readFile(path.join(root, '.recovery', recovered.sessionId, 'sentinel'), 'utf8')).toBe('preserve me');
    await expect(fs.stat(recovered.stagingDirectory)).resolves.toBeDefined();
    await fs.rm(root, { recursive: true });
  });

  it('keeps a reserved publication invisible when audio placement fails after terminal metadata', async () => {
    const root = await temporaryRoot();
    const store = new CaptureStore(() => root, {
      reserveDirectory: fs.mkdir,
      linkAudio: async () => { throw new Error('audio link failed'); },
    });
    const session = await store.begin(recordingId);
    await fs.writeFile(session.audioFilePath, provisionalWavHeader());

    await expect(store.publish(session, terminalMetadata(), 0)).rejects.toThrow('audio link failed');

    expect(await new RecordingsLibrary(() => root).list()).toEqual([]);
    await expect(fs.stat(session.stagingDirectory)).resolves.toBeDefined();
    await expect(fs.stat(path.join(root, recordingId, 'capture.json'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(root, recordingId, 'audio.wav'))).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rm(root, { recursive: true });
  });

  it('discards only a missing session or an exact header-only provisional recording', async () => {
    const root = await temporaryRoot();
    const store = new CaptureStore(() => root);
    const missingId = '00000000-0000-4000-8000-000000000000';
    const realRoot = await fs.realpath(root);
    const missing = { sessionId: missingId, recordingId, stagingDirectory: path.join(realRoot, '.in-progress', missingId), audioFilePath: path.join(realRoot, '.in-progress', missingId, 'audio.wav'), startedAt: '' };
    await expect(store.discardEmpty(missing, 0)).resolves.toBe('discarded');

    const empty = await store.begin(recordingId);
    await fs.writeFile(empty.audioFilePath, provisionalWavHeader());
    await expect(store.discardEmpty(empty, 0)).resolves.toBe('discarded');
    await expect(fs.stat(empty.stagingDirectory)).rejects.toMatchObject({ code: 'ENOENT' });

    const withGap = await store.begin('2026-08-12T01-02-03-005Z');
    await fs.writeFile(withGap.audioFilePath, provisionalWavHeader());
    await expect(store.discardEmpty(withGap, 1)).resolves.toBe('retained');
    const withPcm = await store.begin('2026-08-12T01-02-03-006Z');
    await fs.writeFile(withPcm.audioFilePath, Buffer.alloc(45));
    await expect(store.discardEmpty(withPcm, 0)).resolves.toBe('retained');
    const suspiciousHeader = await store.begin('2026-08-12T01-02-03-007Z');
    await fs.writeFile(suspiciousHeader.audioFilePath, Buffer.alloc(44));
    await expect(store.discardEmpty(suspiciousHeader, 0)).resolves.toBe('retained');
    await fs.rm(root, { recursive: true });
  });
});
