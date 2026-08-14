import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { MAX_BLOCKS } from '../../types/native-capture';
import {
  type CaptureMetadata,
  parseCaptureMetadata,
  validateTerminalMetadata,
} from './capture-metadata';

export type { CaptureMetadata } from './capture-metadata';

export interface CaptureStoreSession {
  sessionId: string;
  recordingId: string;
  stagingDirectory: string;
  audioFilePath: string;
  startedAt: string;
}

export interface CaptureStoreOperations {
  reserveDirectory(destination: string): Promise<void>;
  linkAudio(source: string, destination: string): Promise<void>;
}

const RECORDING_ID_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const AUDIO_FILE = 'audio.wav';
const METADATA_FILE = 'capture.json';

/** Owns only the private directory lifecycle; WAV stream ownership stays with the supervisor. */
export class CaptureStore {
  public constructor(
    private readonly getConfiguredRoot: () => string,
    private readonly operations: CaptureStoreOperations = {
      reserveDirectory: fs.mkdir,
      linkAudio: fs.link,
    },
  ) {}

  public async begin(recordingId: string): Promise<CaptureStoreSession> {
    if (!isRecordingId(recordingId)) throw new Error('INVALID_RECORDING_ID');
    const root = await this.prepareRoot();
    const target = path.join(root, recordingId);
    await rejectExisting(target, 'RECORDING_ID_COLLISION');
    const inProgress = path.join(root, '.in-progress');
    await ensureDirectory(inProgress);
    const sessionId = randomUUID();
    const stagingDirectory = path.join(inProgress, sessionId);
    await fs.mkdir(stagingDirectory);
    const startedAt = new Date().toISOString();
    const audioFilePath = path.join(stagingDirectory, AUDIO_FILE);
    try {
      const handle = await fs.open(audioFilePath, 'wx');
      await handle.close();
      await writeMetadataAtomically(stagingDirectory, provisionalMetadata(startedAt));
    } catch (error) {
      await fs.rm(stagingDirectory, { recursive: true, force: true });
      throw error;
    }
    return { sessionId, recordingId, stagingDirectory, audioFilePath, startedAt };
  }

  public async publish(
    session: CaptureStoreSession,
    metadata: CaptureMetadata,
    finalBlockExclusive: number,
  ): Promise<void> {
    const root = await this.prepareRoot();
    await this.assertSession(root, session);
    const terminal = validateTerminalMetadata(metadata, finalBlockExclusive);
    if (terminal.status !== 'complete' && terminal.status !== 'interrupted')
      throw new Error('INVALID_PUBLICATION_STATUS');
    await writeMetadataAtomically(session.stagingDirectory, terminal);
    const destination = path.join(root, session.recordingId);
    await this.publishReservedDirectory(session, destination, terminal, 'RECORDING_ID_COLLISION');
  }

  public async retainFailed(
    session: CaptureStoreSession,
    metadata: CaptureMetadata,
  ): Promise<void> {
    const root = await this.prepareRoot();
    await this.assertSession(root, session);
    const terminal = validateTerminalMetadata(metadata, MAX_BLOCKS);
    if (terminal.status !== 'failed') throw new Error('INVALID_RECOVERY_STATUS');
    try {
      await writeMetadataAtomically(session.stagingDirectory, terminal);
    } catch {
      // The artifact itself is more valuable than its status annotation.
    }
    const recovery = path.join(root, '.recovery');
    await ensureDirectory(recovery);
    const destination = path.join(recovery, session.sessionId);
    await this.publishReservedDirectory(session, destination, terminal, 'RECOVERY_ID_COLLISION');
  }

  public async discardEmpty(
    session: CaptureStoreSession,
    acceptedTimelineBlocks: number,
  ): Promise<'discarded' | 'retained'> {
    if (!Number.isSafeInteger(acceptedTimelineBlocks) || acceptedTimelineBlocks < 0)
      return 'retained';
    const root = await this.prepareRoot();
    if (!(await isMissingOrValidSession(root, session))) return 'retained';
    try {
      const directory = await fs.lstat(session.stagingDirectory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) return 'retained';
    } catch (error) {
      if (isNotFound(error)) return 'discarded';
      throw error;
    }
    if (acceptedTimelineBlocks !== 0) return 'retained';
    const entries = await fs.readdir(session.stagingDirectory);
    if (entries.length !== 2 || !entries.includes(AUDIO_FILE) || !entries.includes(METADATA_FILE))
      return 'retained';
    const audioPath = path.join(session.stagingDirectory, AUDIO_FILE);
    const metadataPath = path.join(session.stagingDirectory, METADATA_FILE);
    try {
      const audio = await fs.lstat(audioPath);
      const metadata = await fs.lstat(metadataPath);
      if (
        !audio.isFile() ||
        audio.isSymbolicLink() ||
        audio.size !== 44 ||
        !metadata.isFile() ||
        metadata.isSymbolicLink()
      )
        return 'retained';
      if (!isFixedProvisionalWavHeader(await fs.readFile(audioPath))) return 'retained';
      const parsed = parseCaptureMetadata(
        JSON.parse(await fs.readFile(metadataPath, 'utf8')) as unknown,
      );
      if (parsed === null || parsed.status !== 'provisional') return 'retained';
    } catch {
      return 'retained';
    }
    await fs.rm(session.stagingDirectory, { recursive: true, force: false });
    return 'discarded';
  }

  private async prepareRoot(): Promise<string> {
    const configured = path.resolve(this.getConfiguredRoot());
    await fs.mkdir(configured, { recursive: true });
    return fs.realpath(configured);
  }

  private async assertSession(root: string, session: CaptureStoreSession): Promise<void> {
    if (!isRecordingId(session.recordingId) || !isUuid(session.sessionId))
      throw new Error('INVALID_CAPTURE_SESSION');
    const expectedDirectory = path.join(root, '.in-progress', session.sessionId);
    const expectedAudio = path.join(expectedDirectory, AUDIO_FILE);
    if (
      session.stagingDirectory !== expectedDirectory ||
      session.audioFilePath !== expectedAudio ||
      !isInside(root, expectedDirectory)
    ) {
      throw new Error('INVALID_CAPTURE_SESSION');
    }
    const stat = await fs.lstat(expectedDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_CAPTURE_SESSION');
    const real = await fs.realpath(expectedDirectory);
    if (real !== expectedDirectory) throw new Error('UNSAFE_CAPTURE_SESSION');
  }

  /** The terminal metadata rename is the visibility switch after mkdir atomically reserves the name. */
  private async publishReservedDirectory(
    session: CaptureStoreSession,
    destination: string,
    metadata: CaptureMetadata,
    collisionCode: string,
  ): Promise<void> {
    await reserveDirectory(this.operations, destination, collisionCode);
    await assertRegularFile(session.audioFilePath);
    // Keep staging intact on failure; without both terminal metadata and audio this reservation is not a library item.
    await writeMetadataAtomically(destination, metadata);
    await this.operations.linkAudio(session.audioFilePath, path.join(destination, AUDIO_FILE));
    try {
      await fs.rm(session.stagingDirectory, { recursive: true, force: false });
    } catch {
      // Publication has succeeded; leave the private duplicate for later recovery cleanup.
    }
  }
}

function provisionalMetadata(startedAt: string): CaptureMetadata {
  return {
    version: 1,
    status: 'provisional',
    startedAt,
    channels: { interviewer: { started: false }, you: { started: false } },
    interruptions: [],
  };
}

async function writeMetadataAtomically(
  directory: string,
  metadata: CaptureMetadata,
): Promise<void> {
  const target = path.join(directory, METADATA_FILE);
  const temporary = path.join(directory, `.${METADATA_FILE}.tmp-${randomUUID()}`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('UNSAFE_STORE_DIRECTORY');
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await fs.mkdir(directory);
  }
}

async function rejectExisting(target: string, code: string): Promise<void> {
  try {
    await fs.lstat(target);
    throw new Error(code);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

async function reserveDirectory(
  operations: CaptureStoreOperations,
  destination: string,
  collisionCode: string,
): Promise<void> {
  try {
    await operations.reserveDirectory(destination);
  } catch (error) {
    if (isAlreadyExists(error)) throw Object.assign(new Error(collisionCode), { cause: error });
    throw error;
  }
}

async function assertRegularFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('UNSAFE_AUDIO_FILE');
}

async function isMissingOrValidSession(
  root: string,
  session: CaptureStoreSession,
): Promise<boolean> {
  if (!isRecordingId(session.recordingId) || !isUuid(session.sessionId)) return false;
  const expected = path.join(root, '.in-progress', session.sessionId);
  return (
    session.stagingDirectory === expected &&
    session.audioFilePath === path.join(expected, AUDIO_FILE) &&
    isInside(root, expected)
  );
}

function isRecordingId(value: string): boolean {
  if (!RECORDING_ID_REGEX.test(value)) return false;
  const iso = value.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
  return new Date(iso).toISOString() === iso;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

function isFixedProvisionalWavHeader(value: Buffer): boolean {
  return (
    value.length === 44 &&
    value.toString('ascii', 0, 4) === 'RIFF' &&
    value.readUInt32LE(4) === 36 &&
    value.toString('ascii', 8, 12) === 'WAVE' &&
    value.toString('ascii', 12, 16) === 'fmt ' &&
    value.readUInt32LE(16) === 16 &&
    value.readUInt16LE(20) === 1 &&
    value.readUInt16LE(22) === 2 &&
    value.readUInt32LE(24) === 16_000 &&
    value.readUInt32LE(28) === 64_000 &&
    value.readUInt16LE(32) === 4 &&
    value.readUInt16LE(34) === 16 &&
    value.toString('ascii', 36, 40) === 'data' &&
    value.readUInt32LE(40) === 0
  );
}
