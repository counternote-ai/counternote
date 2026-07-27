export class AppActivityCoordinator {
  private recording = false;
  private transcribing = false;

  startRecording(): void {
    this.recording = true;
  }

  finishRecording(): void {
    this.recording = false;
  }

  tryStartTranscription(): boolean {
    if (this.transcribing) return false;
    this.transcribing = true;
    return true;
  }

  finishTranscription(): void {
    this.transcribing = false;
  }

  isRecording(): boolean {
    return this.recording;
  }

  isTranscribing(): boolean {
    return this.transcribing;
  }
}
