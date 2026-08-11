import { TranscriptionSegment } from '../../types/transcript';
import { TranscriptionErrorCode } from '../../types/transcription';
import { type AudioInterval } from '../audio-processor';
import { WhisperProcessInput } from './whisper-process';

const MIN_AUDIBLE_COVERAGE = 0.4;

export interface LocalChannelRequest {
  audioPath: string;
  speaker: 'Interviewer' | 'You';
  durationSeconds: number;
  outputPrefix: string;
}

export interface LocalWhisperProviderDependencies {
  cliPath: string;
  ensureModel: (onProgress: (percent: number) => void) => Promise<string>;
  runProcess: (input: WhisperProcessInput) => Promise<unknown>;
  getAudibleIntervals: (audioPath: string) => Promise<AudioInterval[]>;
}

export class LocalTranscriptionError extends Error {
  constructor(
    readonly code: TranscriptionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'LocalTranscriptionError';
  }
}

export class LocalWhisperProvider {
  constructor(private readonly deps: LocalWhisperProviderDependencies) {}

  async transcribe(
    request: LocalChannelRequest,
    onModelProgress: (percent: number) => void,
    onInferenceStart: () => void
  ): Promise<TranscriptionSegment[]> {
    const audibleIntervals = await this.deps.getAudibleIntervals(request.audioPath);
    if (audibleIntervals.length === 0) {
      return [];
    }

    const modelPath = await this.deps.ensureModel(onModelProgress);

    onInferenceStart();

    const raw = await this.deps.runProcess({
      cliPath: this.deps.cliPath,
      modelPath,
      channelPath: request.audioPath,
      outputPrefix: request.outputPrefix,
      channelDurationMs: request.durationSeconds * 1000,
    });

    return normalizeTranscription(raw, request.speaker, audibleIntervals);
  }
}

function normalizeTranscription(
  raw: unknown,
  speaker: string,
  audibleIntervals: AudioInterval[]
): TranscriptionSegment[] {
  if (!isObject(raw) || !Array.isArray(raw.transcription)) {
    throw new LocalTranscriptionError(
      'LOCAL_TRANSCRIPTION_FAILED',
      'transcription output is malformed'
    );
  }

  const segments: TranscriptionSegment[] = [];

  for (const item of raw.transcription) {
    if (!isObject(item) || !isObject(item.offsets)) {
      throw new LocalTranscriptionError(
        'LOCAL_TRANSCRIPTION_FAILED',
        'segment offsets are malformed'
      );
    }

    if (
      typeof item.offsets.from !== 'number' ||
      typeof item.offsets.to !== 'number' ||
      !Number.isFinite(item.offsets.from) ||
      !Number.isFinite(item.offsets.to)
    ) {
      throw new LocalTranscriptionError(
        'LOCAL_TRANSCRIPTION_FAILED',
        'segment offsets are malformed'
      );
    }

    const startMs = item.offsets.from;
    const endMs = item.offsets.to;

    const start = startMs / 1000;
    const end = endMs / 1000;

    if (start < 0 || end < 0) {
      throw new LocalTranscriptionError(
        'LOCAL_TRANSCRIPTION_FAILED',
        'segment offsets are negative'
      );
    }

    if (start === end) {
      continue; // whisper repetition artifact: no playable range
    }

    if (start > end) {
      throw new LocalTranscriptionError(
        'LOCAL_TRANSCRIPTION_FAILED',
        'segment offsets are reversed'
      );
    }

    if (typeof item.text !== 'string') {
      throw new LocalTranscriptionError(
        'LOCAL_TRANSCRIPTION_FAILED',
        'segment text is not a string'
      );
    }

    const text = item.text.trim();
    if (text.length === 0) {
      continue;
    }

    if (!hasEnoughAudibleAudio(start, end, audibleIntervals)) {
      continue;
    }

    segments.push({ start, end, text, speaker });
  }

  return segments;
}

function hasEnoughAudibleAudio(
  start: number,
  end: number,
  audibleIntervals: AudioInterval[]
): boolean {
  const audibleSeconds = audibleIntervals.reduce((total, interval) => (
    total + Math.max(0, Math.min(end, interval.end) - Math.max(start, interval.start))
  ), 0);

  return audibleSeconds / (end - start) >= MIN_AUDIBLE_COVERAGE;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
