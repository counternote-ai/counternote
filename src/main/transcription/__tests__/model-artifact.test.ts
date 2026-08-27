import { PRODUCTION_MODEL_ARTIFACT, VAD_MODEL_ARTIFACT } from '../model-artifact';

describe('model artifacts', () => {
  it('pins the production whisper model artifact', () => {
    expect(PRODUCTION_MODEL_ARTIFACT.url.toString()).toBe(
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/' +
        '98aa99a0a9db05ae2342309f5096248665f7cba3/' +
        'ggml-large-v3-turbo-q5_0.bin?download=true',
    );
    expect(PRODUCTION_MODEL_ARTIFACT.fileName).toBe('ggml-large-v3-turbo-q5_0.bin');
    expect(PRODUCTION_MODEL_ARTIFACT.byteSize).toBe(574_041_195);
    expect(PRODUCTION_MODEL_ARTIFACT.sha256).toBe(
      '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    );
  });

  it('pins the silero VAD model artifact used for speech filtering', () => {
    expect(VAD_MODEL_ARTIFACT.url.toString()).toBe(
      'https://huggingface.co/ggml-org/whisper-vad/resolve/' +
        '9ffd54a1e1ee413ddf265af9913beaf518d1639b/' +
        'ggml-silero-v5.1.2.bin?download=true',
    );
    expect(VAD_MODEL_ARTIFACT.fileName).toBe('ggml-silero-v5.1.2.bin');
    expect(VAD_MODEL_ARTIFACT.byteSize).toBe(885_098);
    expect(VAD_MODEL_ARTIFACT.sha256).toBe(
      '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf',
    );
  });
});
