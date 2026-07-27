import { AppActivityCoordinator } from '../activity-coordinator';

describe('AppActivityCoordinator', () => {
  it('allows only one transcription owner', () => {
    const activity = new AppActivityCoordinator();

    expect(activity.tryStartTranscription()).toBe(true);
    expect(activity.tryStartTranscription()).toBe(false);
    expect(activity.isTranscribing()).toBe(true);

    activity.finishTranscription();
    expect(activity.isTranscribing()).toBe(false);
    expect(activity.tryStartTranscription()).toBe(true);
  });

  it('reports recording and transcription independently', () => {
    const activity = new AppActivityCoordinator();

    activity.startRecording();
    expect(activity.isRecording()).toBe(true);
    expect(activity.isTranscribing()).toBe(false);

    activity.finishRecording();
    expect(activity.isRecording()).toBe(false);
  });
});
