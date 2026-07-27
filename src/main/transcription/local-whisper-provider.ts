import { TranscriptionSegment } from '../../types/transcript';
import { TranscriptionErrorCode } from '../../types/transcription';
import { WhisperProcessInput } from './whisper-process';

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
  isChannelSilent: (audioPath: string) => Promise<boolean>;
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
    onModelProgress: (percent: number) => void
  ): Promise<TranscriptionSegment[]> {
    if (await this.deps.isChannelSilent(request.audioPath)) {
      return [];
    }

    const modelPath = await this.deps.ensureModel(onModelProgress);

    const raw = await this.deps.runProcess({
      cliPath: this.deps.cliPath,
      modelPath,
      channelPath: request.audioPath,
      outputPrefix: request.outputPrefix,
      channelDurationMs: request.durationSeconds * 1000,
    });

    return normalizeTranscription(raw, request.speaker);
  }
}

function normalizeTranscription(
  raw: unknown,
  speaker: string
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

    const startMs = Number(item.offsets.from);
    const endMs = Number(item.offsets.to);

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new LocalTranscriptionError(
        'LOCAL_TRANSCRIPTION_FAILED',
        'segment offsets are non-finite'
      );
    }

    const start = startMs / 1000;
    const end = endMs / 1000;

    if (start >= end) {
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

    segments.push({ start, end, text, speaker });
  }

  return segments;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
