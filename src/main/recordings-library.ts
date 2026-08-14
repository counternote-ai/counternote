import * as fs from 'fs/promises';
import * as path from 'path';
import {
  type PersistedInterruption,
  parseCaptureMetadata,
  validateRecoveredCaptureMetadata,
} from './native-capture/capture-metadata';

const RECORDING_ID_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const MAX_LIBRARY_DIAGNOSTICS = 20;

export interface LibraryRecording {
  id: string;
  captureStatus: 'legacy' | 'complete' | 'interrupted';
  interruptions: PersistedInterruption[];
}

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

  /** Enumerates only publishable direct children and never follows user-controlled links. */
  async list(): Promise<LibraryRecording[]> {
    const configuredRoot = this.getRoot();
    let root: string;
    try {
      root = await fs.realpath(configuredRoot);
      const stat = await fs.lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    } catch (error) {
      if (isNotFound(error)) return [];
      this.diagnostic('Could not inspect recordings directory.');
      return [];
    }

    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      this.diagnostic('Could not enumerate recordings directory.');
      return [];
    }
    const recordings: LibraryRecording[] = [];
    for (const id of entries.sort()) {
      if (!isRecordingId(id)) continue;
      const directory = path.join(root, id);
      try {
        const stat = await fs.lstat(directory);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          !isContained(root, await fs.realpath(directory))
        ) {
          this.diagnostic('Skipped unsafe recording directory.');
          continue;
        }
        const audio = path.join(directory, 'audio.wav');
        const audioStat = await fs.lstat(audio);
        if (
          !audioStat.isFile() ||
          audioStat.isSymbolicLink() ||
          !isContained(directory, await fs.realpath(audio))
        ) {
          this.diagnostic('Skipped unsafe recording audio.');
          continue;
        }
        const metadataPath = path.join(directory, 'capture.json');
        let metadataStat;
        try {
          metadataStat = await fs.lstat(metadataPath);
        } catch (error) {
          if (isNotFound(error)) {
            recordings.push({ id, captureStatus: 'legacy', interruptions: [] });
            continue;
          }
          throw error;
        }
        if (
          !metadataStat.isFile() ||
          metadataStat.isSymbolicLink() ||
          !isContained(directory, await fs.realpath(metadataPath))
        ) {
          this.diagnostic('Skipped unsafe capture metadata.');
          continue;
        }
        const parsedJson = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as unknown;
        const metadata =
          parseCaptureMetadata(parsedJson) ?? parseRecoveredMetadata(parsedJson, audioStat.size);
        if (
          metadata === null ||
          (metadata.status !== 'complete' && metadata.status !== 'interrupted')
        ) {
          this.diagnostic('Skipped unpublished or invalid capture metadata.');
          continue;
        }
        recordings.push({
          id,
          captureStatus: metadata.status,
          interruptions: metadata.interruptions,
        });
      } catch {
        this.diagnostic('Skipped unreadable recording directory.');
      }
    }
    return recordings;
  }

  private resolveRecordingFile(
    recordingId: string,
    fileName: 'audio.wav' | 'transcript.json',
  ): string {
    if (!isRecordingId(recordingId)) {
      throw new Error('INVALID_RECORDING_ID');
    }

    return path.join(this.getRoot(), recordingId, fileName);
  }

  private diagnostic(message: string): void {
    if (this.diagnosticCount >= MAX_LIBRARY_DIAGNOSTICS) return;
    this.diagnosticCount += 1;
    console.warn(message);
  }

  private diagnosticCount: number = 0;
}

function isRecordingId(value: string): boolean {
  if (!RECORDING_ID_REGEX.test(value)) return false;
  const iso = value.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
  return new Date(iso).toISOString() === iso;
}

function isContained(root: string, candidate: string): boolean {
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

function parseRecoveredMetadata(
  value: unknown,
  audioBytes: number,
): ReturnType<typeof validateRecoveredCaptureMetadata> | null {
  const pcmBytes = audioBytes - 44;
  if (!Number.isSafeInteger(pcmBytes) || pcmBytes < 0 || pcmBytes % 4 !== 0) return null;
  try {
    return validateRecoveredCaptureMetadata(value, pcmBytes / 64);
  } catch {
    return null;
  }
}
