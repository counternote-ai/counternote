import * as path from 'path';
import { TranscriptionSegment } from '../../../types/transcript';
import { TranscriptionStage } from '../../../types/transcription';
import { TranscriptionOrchestrator, TranscriptionOrchestratorRequest } from '../orchestrator';
import { TranscriptionError } from '../errors';
import { TranscriptionLogger } from '../logger';
import { AppActivityCoordinator } from '../../activity-coordinator';

type FakeFs = {
  files: Map<string, Buffer>;
  writeFile: jest.MockedFunction<(filePath: string, data: string) => Promise<void>>;
  rename: jest.MockedFunction<(oldPath: string, newPath: string) => Promise<void>>;
  rm: jest.MockedFunction<(filePath: string, options?: { force?: boolean }) => Promise<void>>;
};

const RECORDING_ID = '2026-07-27T12-00-00-000Z';
const ROOT = '/recordings';
const ATTEMPT_ID = 'attempt-1';
const AUDIO_PATH = path.join(ROOT, RECORDING_ID, 'audio.wav');
const TRANSCRIPT_PATH = path.join(ROOT, RECORDING_ID, 'transcript.json');
const SYSTEM_PATH = path.join(ROOT, RECORDING_ID, `channel-system-${ATTEMPT_ID}.wav`);
const MIC_PATH = path.join(ROOT, RECORDING_ID, `channel-mic-${ATTEMPT_ID}.wav`);

function makeAudioBytes(): Buffer {
  return Buffer.from('audio-wav-bytes');
}

function makeTranscriptBytes(): Buffer {
  return Buffer.from('existing-transcript');
}

function makeSegment(
  start: number,
  end: number,
  text: string,
  speaker: string,
): TranscriptionSegment {
  return { start, end, text, speaker };
}

function createFakeFs(initial: Record<string, Buffer> = {}, order?: string[]): FakeFs {
  const files = new Map<string, Buffer>(Object.entries(initial));
  const writeFile = jest.fn(async (filePath: string, data: string) => {
    order?.push('write');
    files.set(filePath, Buffer.from(data));
  });
  const rename = jest.fn(async (oldPath: string, newPath: string) => {
    if (!files.has(oldPath)) {
      throw new Error(`ENOENT: ${oldPath}`);
    }
    files.set(newPath, files.get(oldPath)!);
    files.delete(oldPath);
  });
  const rm = jest.fn(async (filePath: string, options?: { force?: boolean }) => {
    if (!files.has(filePath) && !options?.force) {
      throw new Error(`ENOENT: ${filePath}`);
    }
    files.delete(filePath);
  });
  return { files, writeFile, rename, rm };
}

interface CreateOrchestratorOverrides {
  coordinator?: TranscriptionOrchestrator['deps']['coordinator'];
  recordingsLibrary?: TranscriptionOrchestrator['deps']['recordingsLibrary'];
  localProvider?: { transcribe: jest.Mock };
  splitChannels?: TranscriptionOrchestrator['deps']['splitChannels'];
  getAudioDuration?: TranscriptionOrchestrator['deps']['getAudioDuration'];
  fs?: FakeFs;
  logger?: TranscriptionLogger;
}

function createOrchestrator(overrides: CreateOrchestratorOverrides = {}) {
  const order: string[] = [];
  const fs = overrides.fs ?? createFakeFs({ [AUDIO_PATH]: makeAudioBytes() }, order);

  const coordinator: TranscriptionOrchestrator['deps']['coordinator'] = overrides.coordinator ?? {
    tryStartTranscription: jest.fn(() => {
      order.push('lock');
      return true;
    }),
    finishTranscription: jest.fn(() => {
      order.push('unlock');
    }),
  };

  const recordingsLibrary: TranscriptionOrchestrator['deps']['recordingsLibrary'] =
    overrides.recordingsLibrary ?? {
      resolveRecordingAudio: jest.fn((recordingId: string) => {
        return path.join(ROOT, recordingId, 'audio.wav');
      }),
      contains: jest.fn(() => true),
    };

  const localProvider = overrides.localProvider ?? {
    transcribe: jest.fn(async (req: { speaker: string }) => {
      order.push(req.speaker.toLowerCase());
      return [];
    }),
  };

  const splitChannels =
    overrides.splitChannels ??
    jest.fn(async () => {
      order.push('prepare');
      return { system: SYSTEM_PATH, mic: MIC_PATH };
    });

  const getAudioDuration = overrides.getAudioDuration ?? jest.fn(async () => 120);

  const logger: TranscriptionLogger = overrides.logger ?? {
    log: jest.fn((_recordingId, _stage, category) => {
      if (category === 'cleanup') {
        order.push('cleanup');
      }
    }),
  };

  const progressStages: TranscriptionStage[] = [];

  const orchestrator = new TranscriptionOrchestrator({
    coordinator,
    recordingsLibrary,
    localProvider: localProvider as unknown as TranscriptionOrchestrator['deps']['localProvider'],
    splitChannels,
    getAudioDuration,
    fs,
    logger,
    attemptIdGenerator: () => ATTEMPT_ID,
    now: () => 0,
    dateFactory: () => '2026-07-27T12:00:00.000Z',
  });

  const request: TranscriptionOrchestratorRequest = {
    recordingId: RECORDING_ID,
    onProgress: (progress) => {
      progressStages.push(progress.stage);
    },
  };

  return {
    orchestrator,
    request,
    deps: {
      coordinator,
      recordingsLibrary,
      localProvider,
      splitChannels,
      getAudioDuration,
      fs,
      logger,
    },
    order,
    progressStages,
  };
}

describe('TranscriptionOrchestrator', () => {
  describe('single-flight and routing', () => {
    it('acquires coordinator before preparation and releases in finally on success', async () => {
      const { orchestrator, request, order, deps } = createOrchestrator();

      await orchestrator.transcribe(request);

      expect(order).toEqual([
        'lock',
        'prepare',
        'interviewer',
        'you',
        'write',
        'cleanup',
        'unlock',
      ]);
      expect(deps.coordinator.finishTranscription).toHaveBeenCalled();
    });

    it('keeps the original owner locked when a busy request is rejected', async () => {
      const coordinator = new AppActivityCoordinator();
      const finishTranscription = jest.spyOn(coordinator, 'finishTranscription');
      let startSplit: (() => void) | undefined;
      let releaseSplit: (() => void) | undefined;
      const splitStarted = new Promise<void>((resolve) => {
        startSplit = resolve;
      });
      const splitGate = new Promise<void>((resolve) => {
        releaseSplit = resolve;
      });
      const splitChannels = jest.fn(async () => {
        startSplit?.();
        await splitGate;
        return { system: SYSTEM_PATH, mic: MIC_PATH };
      });
      const first = createOrchestrator({ coordinator, splitChannels });
      const second = createOrchestrator({ coordinator });
      const third = createOrchestrator({ coordinator });

      const firstRun = first.orchestrator.transcribe(first.request);
      await splitStarted;

      await expect(second.orchestrator.transcribe(second.request)).rejects.toMatchObject({
        code: 'TRANSCRIPTION_BUSY',
      });
      await expect(third.orchestrator.transcribe(third.request)).rejects.toMatchObject({
        code: 'TRANSCRIPTION_BUSY',
      });

      expect(second.deps.splitChannels).not.toHaveBeenCalled();
      expect(third.deps.splitChannels).not.toHaveBeenCalled();
      expect(finishTranscription).not.toHaveBeenCalled();

      releaseSplit?.();
      await firstRun;

      expect(finishTranscription).toHaveBeenCalledTimes(1);
    });

    it('uses Local Whisper for both channel WAVs', async () => {
      const { orchestrator, request, deps } = createOrchestrator();

      await orchestrator.transcribe(request);

      expect(deps.localProvider.transcribe).toHaveBeenCalledTimes(2);
      expect(deps.localProvider.transcribe).toHaveBeenCalledWith(
        expect.objectContaining({ audioPath: SYSTEM_PATH }),
        expect.any(Function),
        expect.any(Function),
      );
      expect(deps.localProvider.transcribe).toHaveBeenCalledWith(
        expect.objectContaining({ audioPath: MIC_PATH }),
        expect.any(Function),
        expect.any(Function),
      );
    });

    it('ignores a legacy Groq provider property and still uses Local Whisper', async () => {
      const { orchestrator, request, deps } = createOrchestrator();
      const legacyRequest = { ...request, provider: 'groq' } as TranscriptionOrchestratorRequest;

      await orchestrator.transcribe(legacyRequest);

      expect(deps.localProvider.transcribe).toHaveBeenCalledTimes(2);
    });

    it('processes channels sequentially in Interviewer then You order', async () => {
      const order: string[] = [];
      const { orchestrator, request } = createOrchestrator({
        localProvider: {
          transcribe: jest.fn(async (req: { speaker: string }) => {
            order.push(req.speaker);
            return [
              makeSegment(order.length, order.length + 1, `text-${req.speaker}`, req.speaker),
            ];
          }),
        },
      });

      const result = await orchestrator.transcribe(request);

      expect(order).toEqual(['Interviewer', 'You']);
      expect(result.segments[0].speaker).toBe('Meeting audio');
      expect(result.segments[1].speaker).toBe('You');
    });

    it('releases coordinator in finally after every failure', async () => {
      const { orchestrator, request, deps } = createOrchestrator({
        splitChannels: jest.fn(async () => {
          throw new Error('audio split failed');
        }),
      });

      await expect(orchestrator.transcribe(request)).rejects.toBeDefined();
      expect(deps.coordinator.finishTranscription).toHaveBeenCalled();
    });
  });

  describe('cleanup and atomic write', () => {
    it('removes temporary artifacts, preserves audio.wav, and keeps existing transcript on split failure', async () => {
      const fs = createFakeFs({
        [AUDIO_PATH]: makeAudioBytes(),
        [TRANSCRIPT_PATH]: makeTranscriptBytes(),
      });
      const { orchestrator, request } = createOrchestrator({
        fs,
        splitChannels: jest.fn(async () => {
          // Simulate split creating files
          fs.files.set(SYSTEM_PATH, Buffer.from('system'));
          fs.files.set(MIC_PATH, Buffer.from('mic'));
          throw new Error('split failed');
        }),
      });

      await expect(orchestrator.transcribe(request)).rejects.toMatchObject({
        code: 'AUDIO_PREPARATION_FAILED',
      });

      expect(fs.files.has(AUDIO_PATH)).toBe(true);
      expect(fs.files.get(AUDIO_PATH)?.equals(makeAudioBytes())).toBe(true);
      expect(fs.files.get(TRANSCRIPT_PATH)?.equals(makeTranscriptBytes())).toBe(true);
      expect(fs.files.has(SYSTEM_PATH)).toBe(false);
      expect(fs.files.has(MIC_PATH)).toBe(false);
    });

    it('removes artifacts, preserves audio.wav, and keeps existing transcript on first provider failure', async () => {
      const fs = createFakeFs({
        [AUDIO_PATH]: makeAudioBytes(),
        [TRANSCRIPT_PATH]: makeTranscriptBytes(),
      });
      const tmpTranscriptPath = `${TRANSCRIPT_PATH}.tmp-${ATTEMPT_ID}`;
      const { orchestrator, request } = createOrchestrator({
        fs,
        localProvider: {
          transcribe: jest.fn(async (req: { speaker: string }) => {
            if (req.speaker === 'Interviewer') {
              throw Object.assign(new Error('local failed'), {
                code: 'LOCAL_TRANSCRIPTION_FAILED',
              });
            }
            return [];
          }),
        },
      });

      await expect(orchestrator.transcribe(request)).rejects.toMatchObject({
        code: 'LOCAL_TRANSCRIPTION_FAILED',
      });

      expect(fs.files.has(AUDIO_PATH)).toBe(true);
      expect(fs.files.get(AUDIO_PATH)?.equals(makeAudioBytes())).toBe(true);
      expect(fs.files.get(TRANSCRIPT_PATH)?.equals(makeTranscriptBytes())).toBe(true);
      expect(fs.files.has(SYSTEM_PATH)).toBe(false);
      expect(fs.files.has(MIC_PATH)).toBe(false);
      expect(fs.files.has(tmpTranscriptPath)).toBe(false);
    });

    it('removes artifacts, preserves audio.wav, and keeps existing transcript on second provider failure', async () => {
      const fs = createFakeFs({
        [AUDIO_PATH]: makeAudioBytes(),
        [TRANSCRIPT_PATH]: makeTranscriptBytes(),
      });
      const tmpTranscriptPath = `${TRANSCRIPT_PATH}.tmp-${ATTEMPT_ID}`;
      const { orchestrator, request } = createOrchestrator({
        fs,
        localProvider: {
          transcribe: jest.fn(async (req: { speaker: string }) => {
            if (req.speaker === 'You') {
              throw Object.assign(new Error('local failed'), {
                code: 'LOCAL_TRANSCRIPTION_FAILED',
              });
            }
            return [];
          }),
        },
      });

      await expect(orchestrator.transcribe(request)).rejects.toMatchObject({
        code: 'LOCAL_TRANSCRIPTION_FAILED',
      });

      expect(fs.files.has(AUDIO_PATH)).toBe(true);
      expect(fs.files.get(AUDIO_PATH)?.equals(makeAudioBytes())).toBe(true);
      expect(fs.files.get(TRANSCRIPT_PATH)?.equals(makeTranscriptBytes())).toBe(true);
      expect(fs.files.has(SYSTEM_PATH)).toBe(false);
      expect(fs.files.has(MIC_PATH)).toBe(false);
      expect(fs.files.has(tmpTranscriptPath)).toBe(false);
    });

    it('preserves existing transcript when JSON normalization fails', async () => {
      const fs = createFakeFs({
        [AUDIO_PATH]: makeAudioBytes(),
        [TRANSCRIPT_PATH]: makeTranscriptBytes(),
      });
      const { orchestrator, request } = createOrchestrator({
        fs,
        localProvider: {
          transcribe: jest.fn(async () => {
            return [{ invalid: true } as unknown as TranscriptionSegment];
          }),
        },
      });

      await expect(orchestrator.transcribe(request)).rejects.toBeDefined();

      expect(fs.files.get(AUDIO_PATH)?.equals(makeAudioBytes())).toBe(true);
      expect(fs.files.get(TRANSCRIPT_PATH)?.equals(makeTranscriptBytes())).toBe(true);
    });

    it('preserves existing transcript when atomic rename fails and removes temp file', async () => {
      const fs = createFakeFs({
        [AUDIO_PATH]: makeAudioBytes(),
        [TRANSCRIPT_PATH]: makeTranscriptBytes(),
      });
      const tmpTranscriptPath = `${TRANSCRIPT_PATH}.tmp-${ATTEMPT_ID}`;
      fs.rename = jest.fn(async (_oldPath: string, _newPath: string) => {
        throw new Error('rename failed');
      });

      const { orchestrator, request } = createOrchestrator({ fs });

      await expect(orchestrator.transcribe(request)).rejects.toMatchObject({
        code: 'TRANSCRIPT_WRITE_FAILED',
      });

      expect(fs.files.has(tmpTranscriptPath)).toBe(false);
      expect(fs.files.get(TRANSCRIPT_PATH)?.equals(makeTranscriptBytes())).toBe(true);
    });

    it('logs cleanup errors but preserves the original error code', async () => {
      const fs = createFakeFs({
        [AUDIO_PATH]: makeAudioBytes(),
      });
      fs.rm = jest.fn(async (_filePath: string, _options?: { force?: boolean }) => {
        throw new Error('cleanup failed');
      });

      const { orchestrator, request, deps } = createOrchestrator({
        fs,
        localProvider: {
          transcribe: jest.fn(async (req: { speaker: string }) => {
            if (req.speaker === 'Interviewer') {
              throw Object.assign(new Error('local failed'), {
                code: 'LOCAL_TRANSCRIPTION_FAILED',
              });
            }
            return [];
          }),
        },
      });

      await expect(orchestrator.transcribe(request)).rejects.toMatchObject({
        code: 'LOCAL_TRANSCRIPTION_FAILED',
      });

      expect(deps.logger.log).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'cleanup-failed',
        expect.any(Number),
      );
    });
  });

  describe('progress and safe logging', () => {
    it('keeps transcribing when a progress listener throws', async () => {
      const { orchestrator, request, deps } = createOrchestrator();

      await expect(
        orchestrator.transcribe({
          ...request,
          onProgress: () => {
            throw new Error('renderer progress listener was destroyed');
          },
        }),
      ).resolves.toMatchObject({ id: RECORDING_ID });

      expect(deps.localProvider.transcribe).toHaveBeenCalledTimes(2);
    });

    it('emits interviewer progress while Local Whisper is still pending', async () => {
      let releaseProvider: ((segments: TranscriptionSegment[]) => void) | undefined;
      let signalProviderStarted: (() => void) | undefined;
      const providerStarted = new Promise<void>((resolve) => {
        signalProviderStarted = resolve;
      });
      const providerGate = new Promise<TranscriptionSegment[]>((resolve) => {
        releaseProvider = resolve;
      });
      const { orchestrator, request } = createOrchestrator({
        localProvider: {
          transcribe: jest.fn((_request, _onProgress, onInferenceStart) => {
            signalProviderStarted?.();
            onInferenceStart();
            return providerGate;
          }),
        },
      });
      const progressEvents: { recordingId: string; stage: TranscriptionStage }[] = [];

      const transcription = orchestrator.transcribe({
        ...request,
        onProgress: (progress) => {
          progressEvents.push(progress);
        },
      });
      await providerStarted;

      try {
        expect(progressEvents).toContainEqual({
          recordingId: RECORDING_ID,
          stage: 'transcribing-interviewer',
        });
      } finally {
        releaseProvider?.([]);
        await transcription;
      }

      expect(progressEvents.filter(({ stage }) => stage === 'transcribing-interviewer')).toEqual([
        { recordingId: RECORDING_ID, stage: 'transcribing-interviewer' },
      ]);
    });

    it('never logs an absolute-path recording ID supplied through IPC', async () => {
      const unsafeRecordingId = '/Users/example/private-interviews/audio.wav';
      const { orchestrator, request, deps } = createOrchestrator();

      await expect(
        orchestrator.transcribe({ ...request, recordingId: unsafeRecordingId }),
      ).rejects.toMatchObject({ code: 'AUDIO_PREPARATION_FAILED' });

      expect(deps.recordingsLibrary.resolveRecordingAudio).not.toHaveBeenCalled();
      const logs = (deps.logger.log as jest.Mock).mock.calls;
      expect(logs).toEqual([['invalid-recording-id', 'preparing-audio', 'failure', 0]]);
      expect(JSON.stringify(logs)).not.toContain(unsafeRecordingId);
    });

    it('returns to local transcription progress after model download before each speaker CPU inference', async () => {
      const { orchestrator, request, progressStages } = createOrchestrator({
        localProvider: {
          transcribe: jest.fn(
            async (
              req: { speaker: 'Interviewer' | 'You' },
              onProgress: (percent: number) => void,
              onInferenceStart?: () => void,
            ) => {
              if (req.speaker === 'Interviewer') {
                onProgress(50);
              }
              onInferenceStart?.();
              return [];
            },
          ),
        },
      });

      await orchestrator.transcribe(request);

      expect(progressStages).toEqual([
        'preparing-audio',
        'downloading-model',
        'transcribing-interviewer',
        'transcribing-you',
        'finishing-transcript',
      ]);
    });

    it('emits model download and transcription progress only for an audible second channel', async () => {
      const { orchestrator, request, progressStages } = createOrchestrator({
        localProvider: {
          transcribe: jest.fn(
            async (
              req: { speaker: 'Interviewer' | 'You' },
              onProgress: (percent: number) => void,
              onInferenceStart?: () => void,
            ) => {
              if (req.speaker === 'Interviewer') {
                return [];
              }
              onProgress(50);
              onInferenceStart?.();
              return [];
            },
          ),
        },
      });

      await orchestrator.transcribe(request);

      expect(progressStages).toEqual([
        'preparing-audio',
        'downloading-model',
        'transcribing-you',
        'finishing-transcript',
      ]);
    });

    it('preserves local error classification without emitting transcription progress before inference starts', async () => {
      const { orchestrator, request } = createOrchestrator({
        localProvider: {
          transcribe: jest.fn(async () => {
            throw new Error('model loading failed');
          }),
        },
      });
      const progressStages: TranscriptionStage[] = [];

      await expect(
        orchestrator.transcribe({
          ...request,
          onProgress: (progress) => {
            progressStages.push(progress.stage);
          },
        }),
      ).rejects.toMatchObject({ code: 'LOCAL_TRANSCRIPTION_FAILED' });

      expect(progressStages).toEqual(['preparing-audio']);
    });

    it('scopes local inference progress to the requested recording ID', async () => {
      const { orchestrator, request } = createOrchestrator({
        localProvider: {
          transcribe: jest.fn(
            async (
              _req: unknown,
              _onProgress: (percent: number) => void,
              onInferenceStart?: () => void,
            ) => {
              onInferenceStart?.();
              return [];
            },
          ),
        },
      });
      const progressEvents: { recordingId: string; stage: TranscriptionStage }[] = [];

      await orchestrator.transcribe({
        ...request,
        onProgress: (progress) => {
          progressEvents.push(progress);
        },
      });

      expect(progressEvents.filter(({ stage }) => stage.startsWith('transcribing-'))).toEqual([
        { recordingId: RECORDING_ID, stage: 'transcribing-interviewer' },
        { recordingId: RECORDING_ID, stage: 'transcribing-you' },
      ]);
    });

    it('carries the safe recording ID, not the full path, in progress events', async () => {
      const { orchestrator, request } = createOrchestrator();
      const progressEvents: { recordingId: string; stage: TranscriptionStage }[] = [];

      await orchestrator.transcribe({
        ...request,
        onProgress: (progress) => {
          progressEvents.push(progress);
        },
      });

      for (const event of progressEvents) {
        expect(event.recordingId).toBe(RECORDING_ID);
        expect(event.recordingId).not.toContain('/');
        expect(event.recordingId).not.toContain(ROOT);
      }
    });

    it('logs stage, category, status, and elapsed without full paths', async () => {
      const { orchestrator, request, deps } = createOrchestrator();

      await orchestrator.transcribe(request);

      const logs = (deps.logger.log as jest.Mock).mock.calls as [
        string,
        TranscriptionStage,
        string,
        number,
      ][];

      for (const [recordingId, stage, category, elapsed] of logs) {
        expect(typeof recordingId).toBe('string');
        expect(recordingId).not.toContain('/');
        expect(recordingId).not.toContain(ROOT);
        expect(typeof stage).toBe('string');
        expect(typeof category).toBe('string');
        expect(typeof elapsed).toBe('number');
      }

      const logString = JSON.stringify(logs);
      expect(logString).not.toContain(ROOT);
      expect(logString).not.toContain(AUDIO_PATH);
    });

    it('normalizes a recognized local provider failure into a typed error with safe details', async () => {
      const providerFailure = Object.assign(new Error('provider response body'), {
        code: 'LOCAL_TRANSCRIPTION_TIMEOUT',
        exitCode: 9,
      });
      const { orchestrator, request } = createOrchestrator({
        localProvider: {
          transcribe: jest.fn(async () => {
            throw providerFailure;
          }),
        },
      });

      let thrown: unknown;
      try {
        await orchestrator.transcribe(request);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(TranscriptionError);
      expect(thrown).toMatchObject({
        code: 'LOCAL_TRANSCRIPTION_TIMEOUT',
        details: { exitCode: 9 },
      });
    });

    it('maps an unknown local provider failure to a typed safe local error', async () => {
      const { orchestrator, request } = createOrchestrator({
        localProvider: {
          transcribe: jest.fn(async () => {
            throw new Error('untrusted provider body');
          }),
        },
      });

      let thrown: unknown;
      try {
        await orchestrator.transcribe(request);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(TranscriptionError);
      expect(thrown).toMatchObject({ code: 'LOCAL_TRANSCRIPTION_FAILED' });
    });
  });
});
