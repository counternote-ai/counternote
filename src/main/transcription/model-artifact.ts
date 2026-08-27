export interface ModelArtifactSpec {
  url: URL;
  fileName: string;
  byteSize: number;
  sha256: string;
}

export const PRODUCTION_MODEL_ARTIFACT: ModelArtifactSpec = {
  url: new URL(
    'https://huggingface.co/ggerganov/whisper.cpp/resolve/' +
      '98aa99a0a9db05ae2342309f5096248665f7cba3/' +
      'ggml-large-v3-turbo-q5_0.bin?download=true',
  ),
  fileName: 'ggml-large-v3-turbo-q5_0.bin',
  byteSize: 574_041_195,
  sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
};

/** Silero VAD model passed to whisper-cli so mostly-silent channels are
 * transcribed from actual speech instead of whole-file hallucinations. */
export const VAD_MODEL_ARTIFACT: ModelArtifactSpec = {
  url: new URL(
    'https://huggingface.co/ggml-org/whisper-vad/resolve/' +
      '9ffd54a1e1ee413ddf265af9913beaf518d1639b/' +
      'ggml-silero-v5.1.2.bin?download=true',
  ),
  fileName: 'ggml-silero-v5.1.2.bin',
  byteSize: 885_098,
  sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf',
};
