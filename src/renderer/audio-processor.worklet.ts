class AudioCaptureProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    const input = inputs[0];
    if (input && input.length > 0) {
      // Send PCM data to main thread
      this.port.postMessage({
        type: 'audio',
        data: input.map((channel) => channel.slice()),
      });
    }
    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
