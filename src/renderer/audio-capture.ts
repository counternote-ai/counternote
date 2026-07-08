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

    // Listen for audio data
    this.workletNode.port.onmessage = (event) => {
      if (event.data.type === 'audio') {
        // TODO: Send to main process via IPC
        console.log('Audio data received:', event.data.data.length, 'channels');
      }
    };
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
