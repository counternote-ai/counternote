import { LocalWhisperProvider, LocalChannelRequest } from '../local-whisper-provider';
import { WhisperProcessInput } from '../whisper-process';

const baseRequest: LocalChannelRequest = {
  audioPath: '/recordings/attempt/audio.wav',
  speaker: 'Interviewer',
  durationSeconds: 10,
  outputPrefix: '/recordings/attempt/interviewer',
};

describe('LocalWhisperProvider', () => {
  const createProvider = (overrides: {
    ensureModel?: jest.MockedFunction<() => Promise<string>>;
    runProcess?: jest.MockedFunction<(_input: WhisperProcessInput) => Promise<unknown>>;
    isChannelSilent?: jest.MockedFunction<() => Promise<boolean>>;
  }) =>
    new LocalWhisperProvider({
      cliPath: '/bin/whisper-cli',
      ensureModel: overrides.ensureModel ?? jest.fn().mockResolvedValue('/models/model.bin'),
      runProcess: overrides.runProcess ?? jest.fn().mockResolvedValue({ transcription: [] }),
      isChannelSilent: overrides.isChannelSilent ?? jest.fn().mockResolvedValue(false),
    });

  it('returns an empty array for silent channels without loading the model', async () => {
    const ensureModel = jest.fn();
    const runProcess = jest.fn();
    const provider = createProvider({
      ensureModel,
      runProcess,
      isChannelSilent: jest.fn().mockResolvedValue(true),
    });

    const onProgress = jest.fn();
    await expect(provider.transcribe(baseRequest, onProgress)).resolves.toEqual([]);

    expect(ensureModel).not.toHaveBeenCalled();
    expect(runProcess).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
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
    await expect(provider.transcribe(baseRequest, onProgress)).resolves.toEqual([
      {
        start: 4.48,
        end: 7.86,
        text: 'Tell me about yourself.',
        speaker: 'Interviewer',
      },
    ]);

    expect(ensureModel).toHaveBeenCalledWith(onProgress);
    expect(runProcess).toHaveBeenCalledWith({
      cliPath: '/bin/whisper-cli',
      modelPath: '/models/model.bin',
      channelPath: baseRequest.audioPath,
      outputPrefix: baseRequest.outputPrefix,
      channelDurationMs: 10_000,
    });
  });

  it('rejects malformed transcription', async () => {
    const provider = createProvider({
      runProcess: jest.fn().mockResolvedValue({ notTranscription: [] }),
    });

    await expect(provider.transcribe(baseRequest, jest.fn())).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_FAILED',
    });
  });

  it('rejects non-finite offsets', async () => {
    const provider = createProvider({
      runProcess: jest.fn().mockResolvedValue({
        transcription: [{ offsets: { from: NaN, to: 1000 }, text: 'x' }],
      }),
    });

    await expect(provider.transcribe(baseRequest, jest.fn())).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_FAILED',
    });
  });

  it('rejects null offsets', async () => {
    const provider = createProvider({
      runProcess: jest.fn().mockResolvedValue({
        transcription: [{ offsets: { from: null, to: 7860 }, text: 'x' }],
      }),
    });

    await expect(provider.transcribe(baseRequest, jest.fn())).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_FAILED',
    });
  });

  it('rejects reversed offsets', async () => {
    const provider = createProvider({
      runProcess: jest.fn().mockResolvedValue({
        transcription: [{ offsets: { from: 5000, to: 4000 }, text: 'x' }],
      }),
    });

    await expect(provider.transcribe(baseRequest, jest.fn())).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_FAILED',
    });
  });

  it('rejects non-string text', async () => {
    const provider = createProvider({
      runProcess: jest.fn().mockResolvedValue({
        transcription: [{ offsets: { from: 1000, to: 2000 }, text: 123 }],
      }),
    });

    await expect(provider.transcribe(baseRequest, jest.fn())).rejects.toMatchObject({
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

    await expect(provider.transcribe(baseRequest, jest.fn())).resolves.toEqual([
      { start: 3, end: 4, text: 'hello', speaker: 'Interviewer' },
    ]);
  });
});
