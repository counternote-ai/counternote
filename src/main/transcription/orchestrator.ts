import * as path from 'path';
import { Transcript, TranscriptionSegment } from '../../types/transcript';
import {
  TranscriptionStage,
  TranscriptionProgress,
  TranscriptionErrorCode,
} from '../../types/transcription';
import { LocalChannelRequest } from './local-whisper-provider';
import { TranscriptionError } from './errors';
import { TranscriptionLogger } from './logger';

const RECORDING_ID_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9A-Za-z.-]+Z$/;
const INVALID_RECORDING_ID_LOG_TOKEN = 'invalid-recording-id';
const TRANSCRIPTION_ERROR_CODES = new Set<TranscriptionErrorCode>([
  'TRANSCRIPTION_BUSY',
  'LOCAL_UNAVAILABLE',
  'MODEL_DOWNLOAD_FAILED',
  'MODEL_CHECKSUM_FAILED',
  'LOCAL_TRANSCRIPTION_FAILED',
  'LOCAL_TRANSCRIPTION_TIMEOUT',
  'AUDIO_PREPARATION_FAILED',
  'TRANSCRIPT_WRITE_FAILED',
]);

export interface TranscriptionOrchestratorRequest {
  recordingId: string;
  onProgress?: (progress: TranscriptionProgress) => void;
}

export interface TranscriptionOrchestratorDependencies {
  coordinator: {
    tryStartTranscription(): boolean;
    finishTranscription(): void;
  };
  recordingsLibrary: {
    resolveRecordingAudio(recordingId: string): string;
    contains(candidate: string): boolean;
  };
  localProvider: {
    transcribe(
      request: LocalChannelRequest,
      onProgress: (percent: number) => void,
      onInferenceStart: () => void,
    ): Promise<TranscriptionSegment[]>;
  };
  splitChannels: (
    audioPath: string,
    output?: { system?: string; mic?: string },
  ) => Promise<{ system: string; mic: string }>;
  getAudioDuration: (audioPath: string) => Promise<number>;
  fs: {
    writeFile: (filePath: string, data: string) => Promise<void>;
    rename: (oldPath: string, newPath: string) => Promise<void>;
    rm: (filePath: string, options?: { force?: boolean }) => Promise<void>;
  };
  logger: TranscriptionLogger;
  attemptIdGenerator?: () => string;
  now?: () => number;
  dateFactory?: () => string;
  timeZone?: string;
}

class ArtifactRegistry {
  private readonly artifacts = new Set<string>();

  constructor(
    private readonly forbidden: Set<string>,
    private readonly attemptId: string,
  ) {}

  add(filePath: string): void {
    if (this.forbidden.has(filePath)) {
      throw new TranscriptionError('AUDIO_PREPARATION_FAILED');
    }
    this.artifacts.add(filePath);
  }

  getTempTranscriptPath(finalPath: string): string {
    return `${finalPath}.tmp-${this.attemptId}`;
  }

  async cleanup(
    fs: TranscriptionOrchestratorDependencies['fs'],
    onError: (error: unknown) => void,
  ): Promise<void> {
    for (const artifact of this.artifacts) {
      try {
        await fs.rm(artifact, { force: true });
      } catch (err) {
        onError(err);
      }
    }
  }
}

export class TranscriptionOrchestrator {
  constructor(private readonly deps: TranscriptionOrchestratorDependencies) {}

  async transcribe(request: TranscriptionOrchestratorRequest): Promise<Transcript> {
    const now = this.deps.now ?? (() => Date.now());
    const startTime = now();
    const attemptId = (this.deps.attemptIdGenerator ?? this.defaultAttemptIdGenerator)();
    const hasSafeRecordingId = RECORDING_ID_PATTERN.test(request.recordingId);
    const safeRecordingId = hasSafeRecordingId
      ? request.recordingId
      : INVALID_RECORDING_ID_LOG_TOKEN;

    let currentStage: TranscriptionStage = 'preparing-audio';
    let acquired = false;

    try {
      if (!this.deps.coordinator.tryStartTranscription()) {
        throw new TranscriptionError('TRANSCRIPTION_BUSY');
      }
      acquired = true;

      if (!hasSafeRecordingId) {
        throw new TranscriptionError('AUDIO_PREPARATION_FAILED');
      }

      const safeRequest: TranscriptionOrchestratorRequest = {
        ...request,
        recordingId: safeRecordingId,
      };

      const audioPath = this.deps.recordingsLibrary.resolveRecordingAudio(safeRecordingId);
      if (!this.deps.recordingsLibrary.contains(audioPath)) {
        throw new TranscriptionError('AUDIO_PREPARATION_FAILED');
      }

      const finalTranscriptPath = path.join(path.dirname(audioPath), 'transcript.json');
      const registry = new ArtifactRegistry(new Set([audioPath, finalTranscriptPath]), attemptId);

      this.log(safeRecordingId, currentStage, 'start', startTime, now());

      try {
        this.emit(safeRequest, currentStage);
        const duration = await this.deps.getAudioDuration(audioPath);

        const systemPath = path.join(path.dirname(audioPath), `channel-system-${attemptId}.wav`);
        const micPath = path.join(path.dirname(audioPath), `channel-mic-${attemptId}.wav`);
        registry.add(systemPath);
        registry.add(micPath);

        await this.deps.splitChannels(audioPath, {
          system: systemPath,
          mic: micPath,
        });

        const segments: TranscriptionSegment[] = [];

        const interviewerSegments = await this.transcribeChannel({
          request: safeRequest,
          channelPath: systemPath,
          speaker: 'Interviewer',
          audioPath,
          attemptId,
          registry,
          durationSeconds: duration,
          setCurrentStage: (stage) => {
            currentStage = stage;
          },
        });
        segments.push(...interviewerSegments);

        const youSegments = await this.transcribeChannel({
          request: safeRequest,
          channelPath: micPath,
          speaker: 'You',
          audioPath,
          attemptId,
          registry,
          durationSeconds: duration,
          setCurrentStage: (stage) => {
            currentStage = stage;
          },
        });
        segments.push(...youSegments);

        this.validateSegments(segments);
        segments.sort((a, b) => a.start - b.start);

        const transcript = this.buildTranscript(safeRecordingId, duration, segments);
        currentStage = 'finishing-transcript';
        this.emit(safeRequest, currentStage);

        const tmpTranscriptPath = registry.getTempTranscriptPath(finalTranscriptPath);
        registry.add(tmpTranscriptPath);

        try {
          await this.deps.fs.writeFile(tmpTranscriptPath, JSON.stringify(transcript, null, 2));
          await this.deps.fs.rename(tmpTranscriptPath, finalTranscriptPath);
        } catch {
          throw new TranscriptionError('TRANSCRIPT_WRITE_FAILED');
        }

        this.log(safeRecordingId, currentStage, 'success', startTime, now());
        return transcript;
      } finally {
        const cleanupStage = currentStage;
        this.log(safeRecordingId, cleanupStage, 'cleanup', startTime, now());
        await registry.cleanup(this.deps.fs, (err) => {
          this.log(safeRecordingId, cleanupStage, 'cleanup-failed', startTime, now(), err);
        });
      }
    } catch (err) {
      this.log(safeRecordingId, currentStage, 'failure', startTime, now());
      throw this.normalizeError(err, currentStage);
    } finally {
      if (acquired) {
        this.deps.coordinator.finishTranscription();
      }
    }
  }

  private async transcribeChannel(options: {
    request: TranscriptionOrchestratorRequest;
    channelPath: string;
    speaker: 'Interviewer' | 'You';
    audioPath: string;
    attemptId: string;
    registry: ArtifactRegistry;
    durationSeconds: number;
    setCurrentStage: (stage: TranscriptionStage) => void;
  }): Promise<TranscriptionSegment[]> {
    const {
      request,
      channelPath,
      speaker,
      audioPath,
      attemptId,
      registry,
      durationSeconds,
      setCurrentStage,
    } = options;

    const outputPrefix = path.join(
      path.dirname(audioPath),
      `whisper-${attemptId}-${speaker.toLowerCase()}`,
    );
    registry.add(`${outputPrefix}.json`);

    const onModelProgress = (percent: number): void => {
      this.emit(request, 'downloading-model', percent);
    };

    const channelRequest: LocalChannelRequest = {
      audioPath: channelPath,
      speaker,
      durationSeconds,
      outputPrefix,
    };

    const stage = `transcribing-${speaker.toLowerCase()}` as TranscriptionStage;
    setCurrentStage(stage);

    return this.deps.localProvider.transcribe(channelRequest, onModelProgress, () => {
      setCurrentStage(stage);
      this.emit(request, stage);
    });
  }

  private emit(
    request: TranscriptionOrchestratorRequest,
    stage: TranscriptionStage,
    percent?: number,
  ): void {
    try {
      request.onProgress?.({
        recordingId: request.recordingId,
        stage,
        percent,
      });
    } catch {
      // Progress is observational; a closed renderer must not abort audio processing.
    }
  }

  private log(
    recordingId: string,
    stage: TranscriptionStage,
    category: 'start' | 'success' | 'failure' | 'cleanup' | 'cleanup-failed',
    startTime: number,
    now: number,
    _error?: unknown,
  ): void {
    this.deps.logger.log(recordingId, stage, category, now - startTime);
  }

  private normalizeError(err: unknown, stage: TranscriptionStage): TranscriptionError {
    if (err instanceof TranscriptionError) {
      return err;
    }

    if (isRecord(err) && isTranscriptionErrorCode(err.code)) {
      return new TranscriptionError(err.code, extractSafeErrorDetails(err));
    }

    return new TranscriptionError(this.safeCodeForStage(stage));
  }

  private safeCodeForStage(stage: TranscriptionStage): TranscriptionErrorCode {
    if (stage === 'finishing-transcript') {
      return 'TRANSCRIPT_WRITE_FAILED';
    }
    if (stage === 'transcribing-interviewer' || stage === 'transcribing-you') {
      return 'LOCAL_TRANSCRIPTION_FAILED';
    }
    return 'AUDIO_PREPARATION_FAILED';
  }

  private buildTranscript(
    recordingId: string,
    duration: number,
    segments: TranscriptionSegment[],
  ): Transcript {
    const dateFactory = this.deps.dateFactory ?? (() => new Date().toISOString());
    const recordedAt = new Date(
      recordingId.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z'),
    );
    return {
      id: recordingId,
      title: `Meeting — ${recordedAt.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: this.deps.timeZone,
      })}`,
      duration,
      audioFile: 'audio.wav',
      createdAt: dateFactory(),
      transcribedAt: dateFactory(),
      segments: segments.map((segment) => ({
        ...segment,
        speaker: segment.speaker === 'Interviewer' ? 'Meeting audio' : segment.speaker,
      })),
    };
  }

  private validateSegments(segments: TranscriptionSegment[]): void {
    for (const segment of segments) {
      if (
        typeof segment.start !== 'number' ||
        typeof segment.end !== 'number' ||
        typeof segment.text !== 'string' ||
        typeof segment.speaker !== 'string' ||
        !Number.isFinite(segment.start) ||
        !Number.isFinite(segment.end)
      ) {
        throw new TranscriptionError('LOCAL_TRANSCRIPTION_FAILED');
      }
    }
  }

  private defaultAttemptIdGenerator(): string {
    return `attempt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTranscriptionErrorCode(value: unknown): value is TranscriptionErrorCode {
  return (
    typeof value === 'string' && TRANSCRIPTION_ERROR_CODES.has(value as TranscriptionErrorCode)
  );
}

function extractSafeErrorDetails(error: Record<string, unknown>): {
  retryAfterSeconds?: number;
  status?: number;
  exitCode?: number;
} {
  const details = isRecord(error.details) ? error.details : error;
  const safeDetails: { retryAfterSeconds?: number; status?: number; exitCode?: number } = {};

  if (isNonNegativeInteger(details.retryAfterSeconds)) {
    safeDetails.retryAfterSeconds = details.retryAfterSeconds;
  }
  if (isHttpStatus(details.status)) {
    safeDetails.status = details.status;
  }
  if (isInteger(details.exitCode)) {
    safeDetails.exitCode = details.exitCode;
  }

  return safeDetails;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}
