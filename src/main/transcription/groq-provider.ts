import * as fs from 'fs';
import * as path from 'path';
import { TranscriptionSegment } from '../../types/transcript';
import { TranscriptionErrorCode } from '../../types/transcription';

export interface GroqProviderRequest {
  audioPath: string;
  speaker: string;
  apiKey?: string;
  model?: string;
}

export interface GroqProviderDependencies {
  fetch: typeof globalThis.fetch;
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  now?: () => number;
}

/**
 * Groq-specific failure carrying a transcription error code. Task 6 replaces
 * this with a shared TranscriptionError; the shape (an Error with a readonly
 * `code`) is intentionally compatible with ModelInstallError.
 */
export class GroqTranscriptionError extends Error {
  constructor(
    readonly code: TranscriptionErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'GroqTranscriptionError';
  }
}

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const TEN_MINUTES_MS = 10 * 60 * 1000;
const MIN_RETRY_AFTER_MS = 1 * 1000;
const MAX_RETRY_AFTER_MS = 60 * 1000;

export class GroqProvider {
  private readonly deps: Required<GroqProviderDependencies>;
  private readonly defaultModel = 'whisper-large-v3-turbo';

  constructor(deps: GroqProviderDependencies) {
    this.deps = {
      now: Date.now,
      ...deps,
    };
  }

  async transcribe(request: GroqProviderRequest): Promise<TranscriptionSegment[]> {
    if (!request.apiKey || request.apiKey.trim().length === 0) {
      throw new GroqTranscriptionError('GROQ_KEY_MISSING', 'Groq API key is missing');
    }

    const audioBuffer = fs.readFileSync(request.audioPath);
    const audioBlob = new Blob([audioBuffer], { type: 'audio/flac' });
    const fileName = path.basename(request.audioPath);

    const formData = new FormData();
    formData.append('file', audioBlob, fileName);
    formData.append('model', request.model ?? this.defaultModel);
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'segment');

    return this.transcribeWithRetry(formData, request.apiKey, request.speaker);
  }

  private async transcribeWithRetry(
    formData: FormData,
    apiKey: string,
    speaker: string,
    isRetry = false,
  ): Promise<TranscriptionSegment[]> {
    const controller = new AbortController();
    const timeoutId = this.deps.setTimeout(() => controller.abort(), TEN_MINUTES_MS);

    let response: Response;
    try {
      response = await this.deps.fetch(GROQ_TRANSCRIBE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GroqTranscriptionError('GROQ_TIMEOUT', 'Groq request timed out');
      }
      throw new GroqTranscriptionError(
        'GROQ_REJECTED',
        `Groq request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.deps.clearTimeout(timeoutId);
    }

    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'), this.deps.now);
      const retryAfterMs = retryAfterSeconds !== undefined ? retryAfterSeconds * 1000 : undefined;

      if (
        !isRetry &&
        retryAfterMs !== undefined &&
        retryAfterMs >= MIN_RETRY_AFTER_MS &&
        retryAfterMs <= MAX_RETRY_AFTER_MS
      ) {
        await this.delay(retryAfterMs);
        return this.transcribeWithRetry(formData, apiKey, speaker, true);
      }

      throw new GroqTranscriptionError(
        'GROQ_RATE_LIMITED',
        'Groq rate limit exceeded',
        retryAfterSeconds,
      );
    }

    if (!response.ok) {
      throw new GroqTranscriptionError(
        'GROQ_REJECTED',
        `Groq API returned status ${response.status}`,
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new GroqTranscriptionError('GROQ_REJECTED', 'Groq response body is not valid JSON');
    }

    return this.normalizeSegments(data, speaker);
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.deps.setTimeout(resolve, ms));
  }

  private normalizeSegments(data: unknown, speaker: string): TranscriptionSegment[] {
    if (!isObject(data) || !Array.isArray(data.segments)) {
      throw new GroqTranscriptionError('GROQ_REJECTED', 'Groq response is missing segments');
    }

    const segments: TranscriptionSegment[] = [];

    for (const item of data.segments) {
      if (!isObject(item)) {
        throw new GroqTranscriptionError('GROQ_REJECTED', 'Groq segment is not an object');
      }

      if (
        typeof item.start !== 'number' ||
        typeof item.end !== 'number' ||
        !Number.isFinite(item.start) ||
        !Number.isFinite(item.end)
      ) {
        throw new GroqTranscriptionError('GROQ_REJECTED', 'Groq segment has invalid timestamps');
      }

      const start = item.start;
      const end = item.end;

      if (start < 0 || end < 0) {
        throw new GroqTranscriptionError('GROQ_REJECTED', 'Groq segment has invalid timestamps');
      }

      if (end < start) {
        throw new GroqTranscriptionError('GROQ_REJECTED', 'Groq segment has reversed timestamps');
      }

      if (typeof item.text !== 'string') {
        throw new GroqTranscriptionError('GROQ_REJECTED', 'Groq segment text is not a string');
      }

      const text = item.text.trim();
      if (text.length === 0) {
        continue;
      }

      segments.push({ start, end, text, speaker });
    }

    return segments;
  }
}

function parseRetryAfter(value: string | null, now: () => number): number | undefined {
  if (value === null) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const asInteger = Number(trimmed);
  if (Number.isInteger(asInteger) && asInteger >= 0) {
    return asInteger;
  }

  const asDate = new Date(trimmed);
  if (!Number.isNaN(asDate.getTime())) {
    const seconds = Math.ceil((asDate.getTime() - now()) / 1000);
    return seconds;
  }

  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
