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
});
