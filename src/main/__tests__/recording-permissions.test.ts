import { app, desktopCapturer, shell, systemPreferences } from 'electron';
import {
  createRecordingPermissionRequester,
  getRecordingPermissionSnapshot,
  openRecordingPermissionSettings,
} from '../recording-permissions';

const appMock = app as unknown as { isPackaged: boolean };
const systemPreferencesMock = systemPreferences as unknown as {
  getMediaAccessStatus: jest.Mock;
  askForMediaAccess: jest.Mock;
};
const desktopCapturerMock = desktopCapturer as unknown as { getSources: jest.Mock };
const shellMock = shell as unknown as { openExternal: jest.Mock };

describe('recording permissions', () => {
  beforeEach(() => {
    appMock.isPackaged = false;
    systemPreferencesMock.getMediaAccessStatus.mockReset();
    systemPreferencesMock.getMediaAccessStatus.mockReturnValue('granted');
    systemPreferencesMock.askForMediaAccess.mockReset();
    systemPreferencesMock.askForMediaAccess.mockResolvedValue(true);
    desktopCapturerMock.getSources.mockReset();
    desktopCapturerMock.getSources.mockResolvedValue([]);
    shellMock.openExternal.mockReset();
    shellMock.openExternal.mockResolvedValue(undefined);
  });

  it('requests undetermined microphone access before probing screen access', async () => {
    const events: string[] = [];
    systemPreferencesMock.getMediaAccessStatus.mockImplementation((permission: string) => {
      if (permission === 'microphone') return 'not-determined';
      return 'denied';
    });
    systemPreferencesMock.askForMediaAccess.mockImplementation(async () => {
      events.push('microphone');
      return true;
    });
    desktopCapturerMock.getSources.mockImplementation(async () => {
      events.push('screen');
      return [];
    });

    await createRecordingPermissionRequester()();

    expect(events).toEqual(['microphone', 'screen']);
    expect(systemPreferencesMock.askForMediaAccess).toHaveBeenCalledWith('microphone');
    expect(desktopCapturerMock.getSources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
  });

  it('does not prompt for permissions that are already granted', async () => {
    await createRecordingPermissionRequester()();

    expect(systemPreferencesMock.askForMediaAccess).not.toHaveBeenCalled();
    expect(desktopCapturerMock.getSources).not.toHaveBeenCalled();
  });

  it('does not probe a screen permission restricted by device policy', async () => {
    systemPreferencesMock.getMediaAccessStatus.mockImplementation((permission: string) =>
      permission === 'screen' ? 'restricted' : 'denied',
    );

    await createRecordingPermissionRequester()();

    expect(systemPreferencesMock.askForMediaAccess).not.toHaveBeenCalled();
    expect(desktopCapturerMock.getSources).not.toHaveBeenCalled();
  });

  it('coalesces concurrent startup permission requests', async () => {
    systemPreferencesMock.getMediaAccessStatus.mockImplementation((permission: string) =>
      permission === 'screen' ? 'denied' : 'granted',
    );
    let finishProbe: (() => void) | undefined;
    desktopCapturerMock.getSources.mockReturnValue(
      new Promise<void>((resolve) => {
        finishProbe = resolve;
      }),
    );
    const requestPermissions = createRecordingPermissionRequester();

    const first = requestPermissions();
    const second = requestPermissions();
    finishProbe?.();
    await Promise.all([first, second]);

    expect(desktopCapturerMock.getSources).toHaveBeenCalledTimes(1);
  });

  it('finishes when the screen permission probe does not settle', async () => {
    jest.useFakeTimers();
    systemPreferencesMock.getMediaAccessStatus.mockImplementation((permission: string) =>
      permission === 'screen' ? 'denied' : 'granted',
    );
    desktopCapturerMock.getSources.mockReturnValue(new Promise(() => undefined));
    const requestPermissions = createRecordingPermissionRequester({ screenProbeTimeoutMs: 25 });

    const resultPromise = requestPermissions();
    jest.advanceTimersByTime(25);
    const result = await resultPromise;

    expect(result.screen).toBe('denied');
    jest.useRealTimers();
  });

  it('returns a refreshed snapshot when screen source discovery throws', async () => {
    systemPreferencesMock.getMediaAccessStatus.mockImplementation((permission: string) =>
      permission === 'screen' ? 'denied' : 'granted',
    );
    desktopCapturerMock.getSources.mockImplementation(() => {
      throw new Error('raw screen discovery failure');
    });

    await expect(createRecordingPermissionRequester()()).resolves.toEqual(
      expect.objectContaining({ screen: 'denied', canAttemptRecording: false }),
    );
  });

  it('reports screen and microphone status with the development permission owner', () => {
    systemPreferencesMock.getMediaAccessStatus.mockImplementation((permission: string) =>
      permission === 'screen' ? 'denied' : 'granted',
    );

    expect(getRecordingPermissionSnapshot()).toEqual({
      screen: 'denied',
      microphone: 'granted',
      permissionOwnerName: 'Electron',
      canAttemptRecording: false,
    });
  });

  it('uses the packaged app name as the permission owner', () => {
    appMock.isPackaged = true;

    expect(getRecordingPermissionSnapshot().permissionOwnerName).toBe('CounterNote');
  });

  it('grants recording permissions only for the development E2E harness', () => {
    process.env.COUNTERNOTE_E2E = '1';
    systemPreferencesMock.getMediaAccessStatus.mockReturnValue('denied');

    expect(getRecordingPermissionSnapshot()).toEqual({
      screen: 'granted',
      microphone: 'granted',
      permissionOwnerName: 'Electron',
      canAttemptRecording: true,
    });

    delete process.env.COUNTERNOTE_E2E;
  });

  it('does not invoke native prompts for the development E2E harness', async () => {
    process.env.COUNTERNOTE_E2E = '1';
    systemPreferencesMock.getMediaAccessStatus.mockReturnValue('denied');

    await createRecordingPermissionRequester()();

    expect(systemPreferencesMock.askForMediaAccess).not.toHaveBeenCalled();
    expect(desktopCapturerMock.getSources).not.toHaveBeenCalled();
    delete process.env.COUNTERNOTE_E2E;
  });

  it('does not let the E2E flag bypass a packaged permission request', async () => {
    process.env.COUNTERNOTE_E2E = '1';
    appMock.isPackaged = true;
    systemPreferencesMock.getMediaAccessStatus.mockImplementation((permission: string) =>
      permission === 'screen' ? 'denied' : 'not-determined',
    );

    await createRecordingPermissionRequester()();

    expect(systemPreferencesMock.askForMediaAccess).toHaveBeenCalledWith('microphone');
    expect(desktopCapturerMock.getSources).toHaveBeenCalledTimes(1);
    delete process.env.COUNTERNOTE_E2E;
  });

  it.each(['not-determined', 'unknown'] as const)(
    'allows an attempt when screen access is %s',
    (status) => {
      systemPreferencesMock.getMediaAccessStatus.mockImplementation((permission: string) =>
        permission === 'screen' ? status : 'granted',
      );

      expect(getRecordingPermissionSnapshot().canAttemptRecording).toBe(true);
    },
  );

  it.each(['denied', 'restricted'] as const)(
    'blocks an attempt when microphone access is %s',
    (status) => {
      systemPreferencesMock.getMediaAccessStatus.mockImplementation((permission: string) =>
        permission === 'microphone' ? status : 'granted',
      );

      expect(getRecordingPermissionSnapshot().canAttemptRecording).toBe(false);
    },
  );

  it('opens the Screen Recording settings pane', async () => {
    await openRecordingPermissionSettings('screen');

    expect(shellMock.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    );
  });

  it('opens the Microphone settings pane', async () => {
    await openRecordingPermissionSettings('microphone');

    expect(shellMock.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    );
  });
});
