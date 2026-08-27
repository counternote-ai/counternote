import { LocalWhisperProvider, LocalChannelRequest } from '../local-whisper-provider';
import { WhisperProcessInput } from '../whisper-process';
import { type AudioInterval } from '../../audio-processor';

const baseRequest: LocalChannelRequest = {
  audioPath: '/recordings/attempt/audio.wav',
  speaker: 'Interviewer',
  durationSeconds: 10,
  outputPrefix: '/recordings/attempt/interviewer',
};
const onInferenceStart = (): void => undefined;

describe('LocalWhisperProvider', () => {
  const createProvider = (overrides: {
    ensureModel?: jest.MockedFunction<(_onProgress: (percent: number) => void) => Promise<string>>;
    ensureVadModel?: jest.MockedFunction<
      (_onProgress: (percent: number) => void) => Promise<string>
    >;
    runProcess?: jest.MockedFunction<(_input: WhisperProcessInput) => Promise<unknown>>;
    getAudibleIntervals?: jest.MockedFunction<() => Promise<AudioInterval[]>>;
  }) =>
    new LocalWhisperProvider({
      cliPath: '/bin/whisper-cli',
      modelByteSize: 1_000,
      vadModelByteSize: 10,
      ensureModel: overrides.ensureModel ?? jest.fn().mockResolvedValue('/models/model.bin'),
      ensureVadModel:
        overrides.ensureVadModel ?? jest.fn().mockResolvedValue('/models/ggml-silero-v5.1.2.bin'),
      runProcess: overrides.runProcess ?? jest.fn().mockResolvedValue({ transcription: [] }),
      getAudibleIntervals:
        overrides.getAudibleIntervals ??
        jest.fn().mockResolvedValue([{ start: 0, end: baseRequest.durationSeconds }]),
    });

  it('returns an empty array for silent channels without loading the model', async () => {
    const ensureModel = jest.fn();
    const ensureVadModel = jest.fn();
    const runProcess = jest.fn();
    const provider = createProvider({
      ensureModel,
      ensureVadModel,
      runProcess,
      getAudibleIntervals: jest.fn().mockResolvedValue([]),
    });

    const onProgress = jest.fn();
    const onInferenceStart = jest.fn();
    await expect(provider.transcribe(baseRequest, onProgress, onInferenceStart)).resolves.toEqual(
      [],
    );

    expect(ensureModel).not.toHaveBeenCalled();
    expect(ensureVadModel).not.toHaveBeenCalled();
    expect(runProcess).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
    expect(onInferenceStart).not.toHaveBeenCalled();
  });

  it('ensures the VAD model and passes its path to the whisper process', async () => {
    const ensureVadModel = jest.fn().mockResolvedValue('/models/ggml-silero-v5.1.2.bin');
    const runProcess = jest.fn().mockResolvedValue({ transcription: [] });
    const provider = createProvider({ ensureVadModel, runProcess });

    await provider.transcribe(baseRequest, jest.fn(), onInferenceStart);

    expect(ensureVadModel).toHaveBeenCalledTimes(1);
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({ vadModelPath: '/models/ggml-silero-v5.1.2.bin' }),
    );
  });

  it('reports monotonic model progress and reaches 100 only after both models are ready', async () => {
    const progress: number[] = [];
    const ensureModel = jest.fn(async (onProgress: (percent: number) => void) => {
      onProgress(50);
      onProgress(100);
      return '/models/model.bin';
    });
    const ensureVadModel = jest.fn(async (onProgress: (percent: number) => void) => {
      onProgress(0);
      onProgress(100);
      return '/models/ggml-silero-v5.1.2.bin';
    });
    const provider = createProvider({ ensureModel, ensureVadModel });

    await provider.transcribe(baseRequest, (percent) => progress.push(percent), onInferenceStart);

    expect(progress).toEqual([...progress].sort((left, right) => left - right));
    expect(progress.slice(0, -1)).not.toContain(100);
    expect(progress[progress.length - 1]).toBe(100);
  });

  it('signals inference immediately after the model is ready and before starting the CPU process', async () => {
    const order: string[] = [];
    const provider = createProvider({
      ensureModel: jest.fn(async (_onProgress: (percent: number) => void) => {
        order.push('model-ready');
        return '/models/model.bin';
      }),
      runProcess: jest.fn(async (_input: WhisperProcessInput) => {
        order.push('process-started');
        return { transcription: [] };
      }),
    });

    await provider.transcribe(baseRequest, jest.fn(), () => order.push('inference-started'));

    expect(order).toEqual(['model-ready', 'inference-started', 'process-started']);
  });

  it('signals inference while a cached-model CPU process is still pending', async () => {
    let releaseProcess: (() => void) | undefined;
    let signalProcessStarted: (() => void) | undefined;
    const processStarted = new Promise<void>((resolve) => {
      signalProcessStarted = resolve;
    });
    const provider = createProvider({
      runProcess: jest.fn(async (_input: WhisperProcessInput) => {
        signalProcessStarted?.();
        await new Promise<void>((resolve) => {
          releaseProcess = resolve;
        });
        return { transcription: [] };
      }),
    });
    const inferenceStarted = jest.fn();

    const transcription = provider.transcribe(baseRequest, jest.fn(), inferenceStarted);
    await processStarted;

    try {
      expect(inferenceStarted).toHaveBeenCalledTimes(1);
    } finally {
      releaseProcess?.();
      await transcription;
    }
  });

  it('normalizes whisper-cli JSON into TranscriptionSegment', async () => {
    const ensureModel = jest.fn().mockResolvedValue('/models/model.bin');
    const runProcess = jest.fn().mockResolvedValue({
      transcription: [
        {
          timestamps: { from: '00:00:04,480', to: '00:00:07,860' },
          offsets: { from: 4480, to: 7860 },
          text: ' Tell me about yourself. ',
        },
      ],
    });
    const provider = createProvider({ ensureModel, runProcess });

    const onProgress = jest.fn();
    await expect(provider.transcribe(baseRequest, onProgress, onInferenceStart)).resolves.toEqual([
      {
        start: 4.48,
        end: 7.86,
        text: 'Tell me about yourself.',
        speaker: 'Interviewer',
      },
    ]);

    expect(ensureModel).toHaveBeenCalledWith(expect.any(Function));
    expect(runProcess).toHaveBeenCalledTimes(1);
    expect(runProcess).toHaveBeenCalledWith({
      cliPath: '/bin/whisper-cli',
      modelPath: '/models/model.bin',
      vadModelPath: '/models/ggml-silero-v5.1.2.bin',
      channelPath: baseRequest.audioPath,
      outputPrefix: baseRequest.outputPrefix,
      channelDurationMs: 10_000,
    });
  });

  it('omits hallucinated segments without enough audible audio', async () => {
    const provider = createProvider({
      getAudibleIntervals: jest.fn().mockResolvedValue([
        { start: 0, end: 0.2 },
        { start: 4, end: 5 },
      ]),
      runProcess: jest.fn().mockResolvedValue({
        transcription: [
          { offsets: { from: 0, to: 10_000 }, text: 'Thank you.' },
          { offsets: { from: 3000, to: 5000 }, text: 'Audible sentence.' },
        ],
      }),
    });

    await expect(provider.transcribe(baseRequest, jest.fn(), onInferenceStart)).resolves.toEqual([
      {
        start: 3,
        end: 5,
        text: 'Audible sentence.',
        speaker: 'Interviewer',
      },
    ]);
  });

  it('does not retry a failed CPU process', async () => {
    const failure = Object.assign(new Error('cpu process failed'), {
      code: 'LOCAL_TRANSCRIPTION_FAILED',
    });
    const runProcess = jest.fn().mockRejectedValue(failure);
    const provider = createProvider({ runProcess });

    await expect(provider.transcribe(baseRequest, jest.fn(), onInferenceStart)).rejects.toBe(
      failure,
    );
    expect(runProcess).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed transcription', async () => {
    const provider = createProvider({
      runProcess: jest.fn().mockResolvedValue({ notTranscription: [] }),
    });

    await expect(
      provider.transcribe(baseRequest, jest.fn(), onInferenceStart),
    ).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_FAILED',
    });
  });

  it('rejects non-finite offsets', async () => {
    const provider = createProvider({
      runProcess: jest.fn().mockResolvedValue({
        transcription: [{ offsets: { from: NaN, to: 1000 }, text: 'x' }],
      }),
    });

    await expect(
      provider.transcribe(baseRequest, jest.fn(), onInferenceStart),
    ).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_FAILED',
    });
  });

  it('rejects null offsets', async () => {
    const provider = createProvider({
      runProcess: jest.fn().mockResolvedValue({
        transcription: [{ offsets: { from: null, to: 7860 }, text: 'x' }],
      }),
    });

    await expect(
      provider.transcribe(baseRequest, jest.fn(), onInferenceStart),
    ).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_FAILED',
    });
  });

  it('rejects reversed offsets', async () => {
    const provider = createProvider({
      runProcess: jest.fn().mockResolvedValue({
        transcription: [{ offsets: { from: 5000, to: 4000 }, text: 'x' }],
      }),
    });

    await expect(
      provider.transcribe(baseRequest, jest.fn(), onInferenceStart),
    ).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_FAILED',
    });
  });

  it('rejects negative offsets that otherwise overlap audible audio', async () => {
    const provider = createProvider({
      getAudibleIntervals: jest.fn().mockResolvedValue([{ start: 0, end: 2 }]),
      runProcess: jest.fn().mockResolvedValue({
        transcription: [{ offsets: { from: -1000, to: 1000 }, text: 'invalid range' }],
      }),
    });

    await expect(
      provider.transcribe(baseRequest, jest.fn(), onInferenceStart),
    ).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_FAILED',
    });
  });

  it('omits zero-duration segments and keeps valid ones', async () => {
    const provider = createProvider({
      runProcess: jest.fn().mockResolvedValue({
        transcription: [
          { offsets: { from: 1000, to: 2000 }, text: 'First.' },
          { offsets: { from: 342000, to: 342000 }, text: ' Yeah.' },
          { offsets: { from: 4000, to: 5000 }, text: 'Second.' },
        ],
      }),
    });

    await expect(provider.transcribe(baseRequest, jest.fn(), onInferenceStart)).resolves.toEqual([
      { start: 1, end: 2, text: 'First.', speaker: 'Interviewer' },
      { start: 4, end: 5, text: 'Second.', speaker: 'Interviewer' },
    ]);
  });

  it('rejects non-string text', async () => {
    const provider = createProvider({
      runProcess: jest.fn().mockResolvedValue({
        transcription: [{ offsets: { from: 1000, to: 2000 }, text: 123 }],
      }),
    });

    await expect(
      provider.transcribe(baseRequest, jest.fn(), onInferenceStart),
    ).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_FAILED',
    });
  });

  it('omits all-whitespace segments', async () => {
    const provider = createProvider({
      runProcess: jest.fn().mockResolvedValue({
        transcription: [
          { offsets: { from: 1000, to: 2000 }, text: '   ' },
          { offsets: { from: 3000, to: 4000 }, text: 'hello' },
        ],
      }),
    });

    await expect(provider.transcribe(baseRequest, jest.fn(), onInferenceStart)).resolves.toEqual([
      { start: 3, end: 4, text: 'hello', speaker: 'Interviewer' },
    ]);
  });
});
