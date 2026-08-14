import { app, shell, systemPreferences } from 'electron';
import {
  getRecordingPermissionSnapshot,
  openRecordingPermissionSettings,
} from '../recording-permissions';

const appMock = app as unknown as { isPackaged: boolean };
const systemPreferencesMock = systemPreferences as unknown as {
  getMediaAccessStatus: jest.Mock;
};
const shellMock = shell as unknown as { openExternal: jest.Mock };

describe('recording permissions', () => {
  beforeEach(() => {
    appMock.isPackaged = false;
    systemPreferencesMock.getMediaAccessStatus.mockReset();
    systemPreferencesMock.getMediaAccessStatus.mockReturnValue('granted');
    shellMock.openExternal.mockReset();
    shellMock.openExternal.mockResolvedValue(undefined);
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

    expect(getRecordingPermissionSnapshot().permissionOwnerName).toBe('Interview Copilot');
  });

  it('grants recording permissions only for the development E2E harness', () => {
    process.env.INTERVIEW_COPILOT_E2E = '1';
    systemPreferencesMock.getMediaAccessStatus.mockReturnValue('denied');

    expect(getRecordingPermissionSnapshot()).toEqual({
      screen: 'granted',
      microphone: 'granted',
      permissionOwnerName: 'Electron',
      canAttemptRecording: true,
    });

    delete process.env.INTERVIEW_COPILOT_E2E;
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
