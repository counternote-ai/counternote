export interface AudioCaptureConfig {
  sampleRate: number;
  onAudioData: (data: { system: Float32Array[]; mic: Float32Array[] }) => void;
}

export class AudioCapture {
  private audioContext: AudioContext | null = null;
  private systemStream: MediaStream | null = null;
  private micStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;

  async start(): Promise<void> {
    // Request display media with audio
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    // Stop video track immediately
    displayStream.getVideoTracks().forEach((track) => track.stop());

    // Get microphone
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });

    this.systemStream = displayStream;
    this.micStream = micStream;

    // Create audio context
    this.audioContext = new AudioContext({ sampleRate: 16000 });

    // Load worklet
    await this.audioContext.audioWorklet.addModule(
      new URL('./audio-processor.worklet.ts', import.meta.url)
    );

    // Create worklet node
    this.workletNode = new AudioWorkletNode(
      this.audioContext,
      'audio-capture-processor'
    );

    // Connect streams to worklet
    const systemSource = this.audioContext.createMediaStreamSource(displayStream);
    const micSource = this.audioContext.createMediaStreamSource(micStream);

    systemSource.connect(this.workletNode);
    micSource.connect(this.workletNode);

    // Listen for audio data and send via IPC
    this.workletNode.port.onmessage = (event) => {
      if (event.data.type === 'audio') {
        // Convert Float32Arrays to ArrayBuffer and send to main
        const channels: Float32Array[] = event.data.data;
        const buffer = this.pcmToBuffer(channels);
        window.electronAPI.sendAudioData(buffer);
      }
    };
  }

  private pcmToBuffer(channels: Float32Array[]): ArrayBuffer {
    // Assume first channel is system audio, second is mic (if available)
    const system = channels[0] || new Float32Array(0);
    const mic = channels[1] || channels[0] || new Float32Array(0);
    const length = Math.max(system.length, mic.length);

    // Interleave system and mic channels: 2 channels, 2 bytes per sample (16-bit)
    const buffer = new ArrayBuffer(length * 2 * 2);
    const view = new Int16Array(buffer);

    for (let i = 0; i < length; i++) {
      // System audio (channel 1)
      const systemSample = i < system.length ? system[i] : 0;
      view[i * 2] = Math.max(-32768, Math.min(32767, systemSample * 32768));
      // Microphone (channel 2)
      const micSample = i < mic.length ? mic[i] : 0;
      view[i * 2 + 1] = Math.max(-32768, Math.min(32767, micSample * 32768));
    }

    return buffer;
  }

  stop(): void {
    this.systemStream?.getTracks().forEach((track) => track.stop());
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.audioContext?.close();

    this.systemStream = null;
    this.micStream = null;
    this.audioContext = null;
    this.workletNode = null;
  }
}
