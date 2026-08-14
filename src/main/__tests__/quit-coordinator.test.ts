import { QuitCoordinator, type QuitCoordinatorDependencies } from '../quit-coordinator';

function createMockEvent(): Electron.Event {
  return { preventDefault: jest.fn() } as unknown as Electron.Event;
}

function createMockDeps(overrides: Partial<QuitCoordinatorDependencies> = {}): QuitCoordinatorDependencies {
  return {
    app: { quit: jest.fn(), on: jest.fn() },
    isIdle: jest.fn().mockReturnValue(false),
    closeAndDrain: jest.fn().mockResolvedValue(undefined),
    stopCaptureIfActive: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('QuitCoordinator', () => {
  it('allows quit when idle', () => {
    const deps = createMockDeps({ isIdle: jest.fn().mockReturnValue(true) });
    const coordinator = new QuitCoordinator(deps);
    const event = createMockEvent();

    coordinator.handleBeforeQuit(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(deps.app.quit).not.toHaveBeenCalled();
  });

  it('prevents quit and starts drain when not idle', () => {
    const deps = createMockDeps();
    const coordinator = new QuitCoordinator(deps);
    const event = createMockEvent();

    coordinator.handleBeforeQuit(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.closeAndDrain).toHaveBeenCalledTimes(1);
    expect(deps.stopCaptureIfActive).toHaveBeenCalledTimes(1);
    expect(coordinator.isQuitRequested()).toBe(true);
    expect(coordinator.isFinishing()).toBe(true);
  });

  it('calls app.quit() after drain and stop settle', async () => {
    const deps = createMockDeps();
    const coordinator = new QuitCoordinator(deps);
    const event = createMockEvent();

    coordinator.handleBeforeQuit(event);

    // Wait for the barrier promise to resolve
    await new Promise(process.nextTick);

    expect(deps.app.quit).toHaveBeenCalledTimes(1);
    expect(coordinator.isFinishing()).toBe(false);
  });

  it('reuses the same barrier promise on repeated quit attempts', () => {
    const deps = createMockDeps();
    const coordinator = new QuitCoordinator(deps);
    const event1 = createMockEvent();
    const event2 = createMockEvent();

    coordinator.handleBeforeQuit(event1);
    coordinator.handleBeforeQuit(event2);

    expect(event1.preventDefault).toHaveBeenCalledTimes(1);
    expect(event2.preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.closeAndDrain).toHaveBeenCalledTimes(1);
    expect(deps.stopCaptureIfActive).toHaveBeenCalledTimes(1);
  });

  it('continues with app.quit() even when stopCaptureIfActive rejects', async () => {
    const deps = createMockDeps({
      stopCaptureIfActive: jest.fn().mockRejectedValue(new Error('stop failed')),
    });
    const coordinator = new QuitCoordinator(deps);
    const event = createMockEvent();

    coordinator.handleBeforeQuit(event);

    await new Promise(process.nextTick);

    expect(deps.app.quit).toHaveBeenCalledTimes(1);
  });

  it('continues with app.quit() even when closeAndDrain rejects', async () => {
    const deps = createMockDeps({
      closeAndDrain: jest.fn().mockRejectedValue(new Error('drain failed')),
    });
    const coordinator = new QuitCoordinator(deps);
    const event = createMockEvent();

    coordinator.handleBeforeQuit(event);

    await new Promise(process.nextTick);

    expect(deps.app.quit).toHaveBeenCalledTimes(1);
  });

  it('reports finishing status truthfully', () => {
    const deps = createMockDeps();
    const coordinator = new QuitCoordinator(deps);

    expect(coordinator.isQuitRequested()).toBe(false);
    expect(coordinator.isFinishing()).toBe(false);

    const event = createMockEvent();
    coordinator.handleBeforeQuit(event);

    expect(coordinator.isQuitRequested()).toBe(true);
    expect(coordinator.isFinishing()).toBe(true);
  });

  it('exposes allowQuit as false before quit completes', () => {
    const deps = createMockDeps();
    const coordinator = new QuitCoordinator(deps);

    expect(coordinator.allowQuit).toBe(false);
  });

  it('exposes allowQuit as true after quit barriers settle', async () => {
    const deps = createMockDeps();
    const coordinator = new QuitCoordinator(deps);
    const event = createMockEvent();

    coordinator.handleBeforeQuit(event);
    expect(coordinator.allowQuit).toBe(false);

    await new Promise(process.nextTick);
    expect(coordinator.allowQuit).toBe(true);
  });
});
