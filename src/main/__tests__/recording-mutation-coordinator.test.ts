import { RecordingMutationCoordinator } from '../recording-mutation-coordinator';

describe('RecordingMutationCoordinator', () => {
  it('grants one non-reentrant lease at a time', () => {
    const coordinator = new RecordingMutationCoordinator();
    const capture = coordinator.tryAcquire('capture');

    expect(capture).toBeDefined();
    expect(coordinator.tryAcquire('capture')).toBeUndefined();
    expect(coordinator.tryAcquire('recover')).toBeUndefined();
    expect(coordinator.snapshot()).toEqual({ owner: 'capture', closing: false });

    capture?.release();
    expect(coordinator.tryAcquire('trash')?.kind).toBe('trash');
  });

  it('releases in a finally block and drains after the owner releases', async () => {
    const coordinator = new RecordingMutationCoordinator();
    const lease = coordinator.tryAcquire('recover');
    let settled = false;
    const drained = coordinator.closeAndDrain().then(() => {
      settled = true;
    });

    expect(coordinator.tryAcquire('trash')).toBeUndefined();
    await Promise.resolve();
    expect(settled).toBe(false);

    try {
      throw new Error('recovery failed');
    } catch {
      // The calling service owns its terminal outcome.
    } finally {
      lease?.release();
    }

    await drained;
    expect(settled).toBe(true);
    expect(coordinator.snapshot()).toEqual({ closing: true });
  });

  it('reuses its settled drain promise when closed without an owner', async () => {
    const coordinator = new RecordingMutationCoordinator();

    const first = coordinator.closeAndDrain();
    expect(coordinator.closeAndDrain()).toBe(first);
    await expect(first).resolves.toBeUndefined();
  });
});
