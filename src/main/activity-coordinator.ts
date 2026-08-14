export class AppActivityCoordinator {
  private transcribing = false;

  tryStartTranscription(): boolean {
    if (this.transcribing) return false;
    this.transcribing = true;
    return true;
  }

  finishTranscription(): void {
    this.transcribing = false;
  }

  isTranscribing(): boolean {
    return this.transcribing;
  }
}
