import { MAX_BLOCKS, type BlockIndex } from '../../types/native-capture';

export type CaptureChannel = 'interviewer' | 'you' | 'capture';

export type CaptureInterruptionReason =
  | 'stream-error'
  | 'callback-stall'
  | 'route-invalidated'
  | 'timestamp-invalid'
  | 'timestamp-discontinuity'
  | 'source-gap'
  | 'late-data'
  | 'buffer-overflow'
  | 'helper-exit'
  | 'protocol-error'
  | 'persistence-error'
  | 'stop-timeout'
  | 'format-limit';

export interface PersistedInterruption {
  channel: CaptureChannel;
  startMs: number;
  endMs: number;
  recovered: boolean;
  reason: CaptureInterruptionReason;
}

interface CaptureMetadataBase {
  version: 1;
  startedAt: string;
  channels: {
    interviewer: { started: boolean };
    you: { started: boolean };
  };
  interruptions: PersistedInterruption[];
}

export type CaptureProvisionalMetadata = CaptureMetadataBase & { status: 'provisional' };
export type CaptureTerminalMetadata = CaptureMetadataBase & {
  status: 'complete' | 'interrupted' | 'failed';
  endedAt: string;
};
export type CaptureInterruptedMetadata = CaptureMetadataBase & {
  status: 'interrupted';
  endedAt: string;
};
export type CaptureMetadata = CaptureProvisionalMetadata | CaptureTerminalMetadata;

export const BLOCK_DURATION_MS = 20;
export const MAX_CAPTURE_DURATION_MS = MAX_BLOCKS * BLOCK_DURATION_MS;

/** Converts only validated protocol boundaries to the persisted millisecond timeline. */
export function blockIndexToMilliseconds(blockIndex: BlockIndex): number {
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0 || blockIndex > MAX_BLOCKS) {
    throw new Error('INVALID_BLOCK_INDEX');
  }
  return blockIndex * BLOCK_DURATION_MS;
}

const SOURCE_REASONS = new Set<CaptureInterruptionReason>([
  'stream-error', 'callback-stall', 'route-invalidated', 'timestamp-invalid',
  'timestamp-discontinuity', 'source-gap', 'late-data',
]);
const TERMINAL_CAPTURE_REASONS = new Set<CaptureInterruptionReason>([
  'helper-exit', 'protocol-error', 'persistence-error', 'stop-timeout',
]);
const CAPTURE_REASONS = new Set<CaptureInterruptionReason>([
  'buffer-overflow', ...TERMINAL_CAPTURE_REASONS, 'format-limit',
]);
const ALL_REASONS = new Set<CaptureInterruptionReason>([
  ...SOURCE_REASONS, ...CAPTURE_REASONS,
]);
const CAPTURE_CHANNELS = new Set<CaptureChannel>(['interviewer', 'you', 'capture']);

/** Parses the closed on-disk capture.json schema without trusting its source. */
export function parseCaptureMetadata(value: unknown): CaptureMetadata | null {
  return parseMetadata(value, 'protocol');
}

/** Validates recovery metadata against the exact repaired WAV duration. */
export function validateRecoveredCaptureMetadata(
  value: unknown,
  wavDurationMs: number,
): CaptureInterruptedMetadata {
  if (!isRecoveryWavExtent(wavDurationMs)) throw new Error('INVALID_RECOVERY_WAV_EXTENT');
  const metadata = parseMetadata(value, 'recovery', wavDurationMs);
  if (metadata === null || metadata.status !== 'interrupted') throw new Error('INVALID_RECOVERY_METADATA');
  return metadata as CaptureInterruptedMetadata;
}

function parseMetadata(
  value: unknown,
  context: 'protocol' | 'recovery',
  wavDurationMs?: number,
): CaptureMetadata | null {
  if (!isPlainObject(value)) return null;
  const status = value.status;
  const expectedKeys = status === 'provisional'
    ? ['version', 'status', 'startedAt', 'channels', 'interruptions']
    : ['version', 'status', 'startedAt', 'endedAt', 'channels', 'interruptions'];
  if (!hasExactlyKeys(value, expectedKeys) || value.version !== 1 || !isCaptureStatus(status)) return null;
  if (!isIsoTimestamp(value.startedAt) || !isChannels(value.channels) || !Array.isArray(value.interruptions)) return null;
  const interruptions = value.interruptions.map((interruption) => parseInterruption(interruption, context, wavDurationMs));
  if (interruptions.some((interruption) => interruption === null)) return null;

  if (status === 'provisional') {
    return {
      version: 1,
      status,
      startedAt: value.startedAt,
      channels: value.channels,
      interruptions: interruptions as PersistedInterruption[],
    };
  }
  if (!isIsoTimestamp(value.endedAt) || Date.parse(value.endedAt) < Date.parse(value.startedAt)) return null;
  if ((status === 'complete' && interruptions.length !== 0) || (status === 'interrupted' && interruptions.length === 0)) return null;
  return {
    version: 1,
    status,
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    channels: value.channels,
    interruptions: interruptions as PersistedInterruption[],
  };
}

/** Verifies terminal metadata against the fully validated protocol timeline. */
export function validateTerminalMetadata(
  value: unknown,
  finalBlockExclusive: number,
): CaptureTerminalMetadata {
  if (!Number.isSafeInteger(finalBlockExclusive) || finalBlockExclusive < 0 || finalBlockExclusive > MAX_BLOCKS) {
    throw new Error('INVALID_FINAL_BLOCK');
  }
  const metadata = parseCaptureMetadata(value);
  if (metadata === null || metadata.status === 'provisional') throw new Error('INVALID_CAPTURE_METADATA');
  const finalMs = blockIndexToMilliseconds(finalBlockExclusive);
  if (!metadata.interruptions.every((interruption) => interruption.endMs <= finalMs)) {
    throw new Error('INTERRUPTION_OUTSIDE_TIMELINE');
  }
  return metadata;
}

function parseInterruption(
  value: unknown,
  context: 'protocol' | 'recovery',
  wavDurationMs?: number,
): PersistedInterruption | null {
  if (!isPlainObject(value) || !hasExactlyKeys(value, ['channel', 'startMs', 'endMs', 'recovered', 'reason'])) return null;
  const { channel, startMs, endMs, recovered, reason } = value;
  if (!isCaptureChannel(channel) || !isInterruptionReason(reason)) return null;
  if (!isFiniteMillisecond(startMs) || !isFiniteMillisecond(endMs) || startMs > endMs || typeof recovered !== 'boolean') return null;
  if (endMs > MAX_CAPTURE_DURATION_MS) return null;
  if (SOURCE_REASONS.has(reason)) {
    if ((channel !== 'interviewer' && channel !== 'you') || startMs === endMs) return null;
  } else if (reason === 'buffer-overflow') {
    if (channel !== 'capture' || !recovered || startMs === endMs) return null;
  } else if (reason === 'format-limit') {
    if (channel !== 'capture' || recovered || startMs !== MAX_CAPTURE_DURATION_MS || endMs !== MAX_CAPTURE_DURATION_MS) return null;
  } else if (TERMINAL_CAPTURE_REASONS.has(reason)) {
    if (channel !== 'capture' || recovered || startMs !== endMs) return null;
  } else {
    return null;
  }
  if (context === 'protocol' && (!isProtocolBoundary(startMs) || !isProtocolBoundary(endMs))) return null;
  if (context === 'recovery') {
    if (wavDurationMs === undefined || endMs > wavDurationMs) return null;
    const fractionalRecoveryPoint = reason === 'persistence-error'
      && startMs === endMs
      && startMs === wavDurationMs
      && !isProtocolBoundary(wavDurationMs);
    if (!fractionalRecoveryPoint && (!isProtocolBoundary(startMs) || !isProtocolBoundary(endMs))) return null;
  }
  return { channel, startMs, endMs, recovered, reason };
}

function isCaptureStatus(value: unknown): value is CaptureMetadata['status'] {
  return value === 'provisional' || value === 'complete' || value === 'interrupted' || value === 'failed';
}

function isCaptureChannel(value: unknown): value is CaptureChannel {
  return typeof value === 'string' && CAPTURE_CHANNELS.has(value as CaptureChannel);
}

function isInterruptionReason(value: unknown): value is CaptureInterruptionReason {
  return typeof value === 'string' && ALL_REASONS.has(value as CaptureInterruptionReason);
}

function isChannels(value: unknown): value is CaptureMetadata['channels'] {
  return isPlainObject(value)
    && hasExactlyKeys(value, ['interviewer', 'you'])
    && isPlainObject(value.interviewer)
    && hasExactlyKeys(value.interviewer, ['started'])
    && typeof value.interviewer.started === 'boolean'
    && isPlainObject(value.you)
    && hasExactlyKeys(value.you, ['started'])
    && typeof value.you.started === 'boolean';
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isFiniteMillisecond(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isProtocolBoundary(value: number): boolean {
  return Number.isSafeInteger(value) && value % BLOCK_DURATION_MS === 0;
}

function isRecoveryWavExtent(value: number): boolean {
  return isFiniteMillisecond(value)
    && value <= MAX_CAPTURE_DURATION_MS
    && Number.isSafeInteger(value * 16);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
