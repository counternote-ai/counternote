// Type declarations for AudioWorklet API
// These are needed because TypeScript's built-in types don't include AudioWorkletProcessor

interface AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}

declare var AudioWorkletProcessor: {
  prototype: AudioWorkletProcessor;
  new (): AudioWorkletProcessor;
};

declare function registerProcessor(name: string, processorClass: new () => AudioWorkletProcessor): void;
