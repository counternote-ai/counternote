import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import { constants as fsConstants, type Stats } from 'fs';
import * as path from 'path';
import { shell } from 'electron';
import { getAudioDuration } from './audio-processor';
import {
  parseCaptureMetadata,
  validateRecoveredCaptureMetadata,
  type CaptureMetadata,
} from './native-capture/capture-metadata';
import { RecordingMutationCoordinator } from './recording-mutation-coordinator';

const AUDIO_FILE = 'audio.wav';
const METADATA_FILE = 'capture.json';
const HEADER_BYTES = 44;
const FRAME_BYTES = 4;
const BYTE_RATE = 64_000;
const MAX_WAV_DATA_BYTES = 0xffff_ffff - 36;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RecordingRecoveryItem {
  id: string;
  createdAt: string;
  bytes: number;
  state: 'recoverable' | 'not-recoverable';
}

export type RecoverRecordingResult =
  | { outcome: 'busy' }
  | { outcome: 'not-found' }
  | { outcome: 'not-recoverable' }
  | { outcome: 'recovery-failed' }
  | { outcome: 'recovered' }
  | { outcome: 'recovered-with-retained-source' };

export type TrashRecoveryResult =
  | { outcome: 'busy' }
  | { outcome: 'not-found' }
  | { outcome: 'trash-failed' }
  | { outcome: 'trashed' };

export interface RecoveryServiceDependencies {
  trashItem(target: string): Promise<void>;
  readAudioDuration(audioPath: string): Promise<number>;
  removeSource(directory: string): Promise<void>;
  beforeCopy(sourcePath: string): Promise<void>;
  now(): Date;
}

interface RecoverySource {
  directory: string;
  stat: Stats;
}

interface RecoveryInspection extends RecoverySource {
  audioPath: string;
  audioStat: Stats | undefined;
  metadata: CaptureMetadata | undefined;
}

/** Recovers failed local captures without ever returning filesystem paths to the bridge. */
export class RecoveryService {
  private readonly dependencies: RecoveryServiceDependencies;

  public constructor(
    private readonly getConfiguredRoot: () => string,
    private readonly mutations: RecordingMutationCoordinator,
    dependencies: Partial<RecoveryServiceDependencies> = {},
  ) {
    this.dependencies = {
      trashItem: (target: string): Promise<void> => shell.trashItem(target),
      readAudioDuration: getAudioDuration,
      removeSource: (directory: string): Promise<void> => fs.rm(directory, { recursive: true, force: false }),
      beforeCopy: (): Promise<void> => Promise.resolve(),
      now: (): Date => new Date(),
      ...dependencies,
    };
  }

  public async list(activeSessionId?: string): Promise<RecordingRecoveryItem[]> {
    const root = await this.prepareRoot();
    const recoveryIds = await this.readSessionIds(root, '.recovery');
    const inProgressIds = await this.readSessionIds(root, '.in-progress');
    const items = new Map<string, RecordingRecoveryItem>();
    const normalizationLease = inProgressIds.length === 0 ? undefined : this.mutations.tryAcquire('recover');
    try {
      for (const id of recoveryIds) {
        if (id === activeSessionId) continue;
        const item = await this.toRecoveryItem(root, '.recovery', id);
        if (item !== undefined) items.set(id, item);
      }
      for (const id of inProgressIds) {
        if (id === activeSessionId || items.has(id)) continue;
        const normalized = normalizationLease === undefined ? false : await this.normalizeInProgress(root, id);
        const item = await this.toRecoveryItem(root, normalized ? '.recovery' : '.in-progress', id);
        if (item !== undefined) items.set(id, item);
      }
      return [...items.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    } finally {
      normalizationLease?.release();
    }
  }

  public async recover(id: string): Promise<RecoverRecordingResult> {
    if (!isUuid(id)) return { outcome: 'not-found' };
    const lease = this.mutations.tryAcquire('recover');
    if (lease === undefined) return { outcome: 'busy' };

    let repairDirectory: string | undefined;
    try {
      const root = await this.prepareRoot();
      const source = await this.findSource(root, id);
      if (source === undefined) return { outcome: 'not-found' };
      const inspected = await this.inspectSource(source);
      const audioStat = inspected.audioStat;
      const pcmBytes = audioStat === undefined ? -1 : audioStat.size - HEADER_BYTES;
      if (audioStat === undefined || !isRecoverablePcm(pcmBytes)) return { outcome: 'not-recoverable' };

      repairDirectory = await this.createRepairDirectory(root);
      const repairAudio = path.join(repairDirectory, AUDIO_FILE);
      await this.dependencies.beforeCopy(inspected.audioPath);
      await copyStableRegularFile(inspected.audioPath, audioStat, repairAudio);
      await this.repairFixedHeader(repairAudio, pcmBytes);
      const durationSeconds = await this.dependencies.readAudioDuration(repairAudio);
      if (!Number.isFinite(durationSeconds) || Math.abs(durationSeconds - pcmBytes / BYTE_RATE) > Number.EPSILON) {
        throw new Error('INVALID_REPAIRED_DURATION');
      }

      const durationMs = pcmBytes / 64;
      const metadata = recoveredMetadata(inspected.metadata, inspected.stat, durationMs);
      validateRecoveredCaptureMetadata(metadata, durationMs);
      await writeMetadataAtomically(repairDirectory, metadata);

      await this.publishRepairDirectory(root, repairDirectory);
      repairDirectory = undefined;
      try {
        await this.dependencies.removeSource(source.directory);
      } catch {
        return { outcome: 'recovered-with-retained-source' };
      }
      return { outcome: 'recovered' };
    } catch {
      if (repairDirectory !== undefined) await removeRepairDirectory(repairDirectory);
      return { outcome: 'recovery-failed' };
    } finally {
      lease.release();
    }
  }

  public async moveToTrash(id: string): Promise<TrashRecoveryResult> {
    if (!isUuid(id)) return { outcome: 'not-found' };
    const lease = this.mutations.tryAcquire('trash');
    if (lease === undefined) return { outcome: 'busy' };
    try {
      const root = await this.prepareRoot();
      const source = await this.findSource(root, id);
      if (source === undefined) return { outcome: 'not-found' };
      await this.dependencies.trashItem(source.directory);
      return { outcome: 'trashed' };
    } catch {
      return { outcome: 'trash-failed' };
    } finally {
      lease.release();
    }
  }

  private async prepareRoot(): Promise<string> {
    const configured = path.resolve(this.getConfiguredRoot());
    await fs.mkdir(configured, { recursive: true });
    return fs.realpath(configured);
  }

  private async readSessionIds(root: string, parent: '.recovery' | '.in-progress'): Promise<string[]> {
    const directory = path.join(root, parent);
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) return [];
      return (await fs.readdir(directory)).filter(isUuid).sort();
    } catch {
      return [];
    }
  }

  private async normalizeInProgress(root: string, id: string): Promise<boolean> {
    const source = await this.sourceAt(root, '.in-progress', id);
    if (source === undefined) return false;
    const recovery = path.join(root, '.recovery');
    try {
      await ensureContainedDirectory(root, recovery);
      const target = path.join(recovery, id);
      await fs.lstat(target);
      return false;
    } catch (error) {
      if (!isNotFound(error)) return false;
    }
    try {
      await fs.rename(source.directory, path.join(recovery, id));
      return true;
    } catch {
      return false;
    }
  }

  private async toRecoveryItem(
    root: string,
    parent: '.recovery' | '.in-progress',
    id: string,
  ): Promise<RecordingRecoveryItem | undefined> {
    const source = await this.sourceAt(root, parent, id);
    if (source === undefined) return undefined;
    const inspected = await this.inspectSource(source);
    const pcmBytes = inspected.audioStat === undefined ? -1 : inspected.audioStat.size - HEADER_BYTES;
    return {
      id,
      createdAt: inspected.metadata?.status === 'failed' ? inspected.metadata.startedAt : source.stat.birthtime.toISOString(),
      bytes: await sumRegularFileBytes(source.directory),
      state: isRecoverablePcm(pcmBytes) ? 'recoverable' : 'not-recoverable',
    };
  }

  private async findSource(root: string, id: string): Promise<RecoverySource | undefined> {
    return await this.sourceAt(root, '.recovery', id) ?? await this.sourceAt(root, '.in-progress', id);
  }

  private async sourceAt(
    root: string,
    parent: '.recovery' | '.in-progress',
    id: string,
  ): Promise<RecoverySource | undefined> {
    const directory = path.join(root, parent, id);
    if (!isContained(root, directory) || !isUuid(id)) return undefined;
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) return undefined;
      return { directory, stat };
    } catch {
      return undefined;
    }
  }

  private async inspectSource(source: RecoverySource): Promise<RecoveryInspection> {
    const audioPath = path.join(source.directory, AUDIO_FILE);
    let audioStat: Stats | undefined;
    try {
      const stat = await fs.lstat(audioPath);
      if (stat.isFile() && !stat.isSymbolicLink() && await fs.realpath(audioPath) === audioPath) audioStat = stat;
    } catch {
      // A damaged source stays visible as not-recoverable.
    }
    return { ...source, audioPath, audioStat, metadata: await readFailedMetadata(source.directory) };
  }

  private async createRepairDirectory(root: string): Promise<string> {
    const parent = path.join(root, '.recovery');
    await ensureContainedDirectory(root, parent);
    for (;;) {
      const directory = path.join(parent, `.repair-${randomUUID()}`);
      try {
        await fs.mkdir(directory, { mode: 0o700 });
        return directory;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
    }
  }

  private async repairFixedHeader(audioPath: string, pcmBytes: number): Promise<void> {
    if (pcmBytes > MAX_WAV_DATA_BYTES) throw new Error('WAV_TOO_LARGE');
    const handle = await fs.open(audioPath, 'r+');
    try {
      await handle.write(createFixedWavHeader(pcmBytes), 0, HEADER_BYTES, 0);
    } finally {
      await handle.close();
    }
  }

  private async publishRepairDirectory(root: string, repairDirectory: string): Promise<string> {
    const baseline = this.dependencies.now().getTime();
    for (let offset = 0; offset < 10_000; offset += 1) {
      const id = toRecordingId(new Date(baseline + offset));
      const destination = path.join(root, id);
      try {
        await fs.lstat(destination);
        continue;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      try {
        await fs.rename(repairDirectory, destination);
        return destination;
      } catch (error) {
        if (isAlreadyExists(error) || isNotEmpty(error)) continue;
        throw error;
      }
    }
    throw new Error('RECORDING_ID_COLLISION');
  }
}

function recoveredMetadata(metadata: CaptureMetadata | undefined, stat: Stats, durationMs: number): Record<string, unknown> {
  const startedAt = metadata?.status === 'failed' ? metadata.startedAt : stat.birthtime.toISOString();
  const interruptions = metadata?.status === 'failed' ? [...metadata.interruptions] : [];
  if (!interruptions.some((interruption) => interruption.reason === 'persistence-error')) {
    interruptions.push({ channel: 'capture', startMs: durationMs, endMs: durationMs, recovered: false, reason: 'persistence-error' });
  }
  return {
    version: 1,
    status: 'interrupted',
    startedAt,
    endedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(),
    channels: metadata?.status === 'failed'
      ? metadata.channels
      : { interviewer: { started: false }, you: { started: false } },
    interruptions,
  };
}

async function readFailedMetadata(directory: string): Promise<CaptureMetadata | undefined> {
  const metadataPath = path.join(directory, METADATA_FILE);
  try {
    const stat = await fs.lstat(metadataPath);
    if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(metadataPath) !== metadataPath) return undefined;
    const metadata = parseCaptureMetadata(JSON.parse(await fs.readFile(metadataPath, 'utf8')) as unknown);
    return metadata?.status === 'failed' ? metadata : undefined;
  } catch {
    return undefined;
  }
}

async function sumRegularFileBytes(directory: string): Promise<number> {
  let total = 0;
  const visit = async (current: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await fs.readdir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry);
      try {
        const stat = await fs.lstat(candidate);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          if (Number.isSafeInteger(stat.size) && stat.size >= 0 && total <= Number.MAX_SAFE_INTEGER - stat.size) total += stat.size;
        } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
          await visit(candidate);
        }
      } catch {
        // A concurrent disappearance is not a reason to expose a path or throw from list.
      }
    }
  };
  await visit(directory);
  return total;
}

async function ensureContainedDirectory(root: string, directory: string): Promise<void> {
  if (!isContained(root, directory)) throw new Error('UNSAFE_RECOVERY_DIRECTORY');
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) throw new Error('UNSAFE_RECOVERY_DIRECTORY');
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await fs.mkdir(directory, { mode: 0o700 });
  }
}

async function writeMetadataAtomically(directory: string, metadata: Record<string, unknown>): Promise<void> {
  const temporary = path.join(directory, `.${METADATA_FILE}.tmp-${randomUUID()}`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, path.join(directory, METADATA_FILE));
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

/** Copies from the already-open source descriptor so later pathname swaps cannot escape recovery. */
async function copyStableRegularFile(sourcePath: string, expected: Stats, destinationPath: string): Promise<void> {
  const source = await fs.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const actual = await source.stat();
    if (!sameRegularFile(actual, expected)) throw new Error('UNSAFE_RECOVERY_AUDIO');
    const destination = await fs.open(destinationPath, 'wx', 0o600);
    try {
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) return;
        await destination.write(buffer, 0, bytesRead, null);
      }
    } finally {
      await destination.close();
    }
  } finally {
    await source.close();
  }
}

async function removeRepairDirectory(directory: string): Promise<void> {
  try {
    await fs.rm(directory, { recursive: true, force: true });
  } catch {
    // A failed cleanup must never cause the failed source to be removed.
  }
}

function createFixedWavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('RIFF', 0);
  header.writeUInt32LE(dataBytes + 36, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(BYTE_RATE, 28);
  header.writeUInt16LE(FRAME_BYTES, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function isRecoverablePcm(pcmBytes: number): boolean {
  return Number.isSafeInteger(pcmBytes) && pcmBytes > 0 && pcmBytes % FRAME_BYTES === 0 && pcmBytes <= MAX_WAV_DATA_BYTES;
}

function sameRegularFile(actual: Stats, expected: Stats): boolean {
  return actual.isFile()
    && !actual.isSymbolicLink()
    && actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.size === expected.size;
}

function isUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function toRecordingId(value: Date): string {
  return value.toISOString().replace(/T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/, 'T$1-$2-$3-$4Z');
}

function isNotFound(error: unknown): boolean {
  return codeIs(error, 'ENOENT');
}

function isAlreadyExists(error: unknown): boolean {
  return codeIs(error, 'EEXIST');
}

function isNotEmpty(error: unknown): boolean {
  return codeIs(error, 'ENOTEMPTY');
}

function codeIs(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code;
}
