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
    'ggml-large-v3-turbo-q5_0.bin?download=true'
  ),
  fileName: 'ggml-large-v3-turbo-q5_0.bin',
  byteSize: 574_041_195,
  sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
};
