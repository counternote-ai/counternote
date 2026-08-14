import { type RecordingPermissionSnapshot } from '../types/recording-permissions';
import { getRecordingPermissionNotice } from './recording-permissions';

const grantedSnapshot: RecordingPermissionSnapshot = {
  screen: 'granted',
  microphone: 'granted',
  permissionOwnerName: 'Electron',
  canAttemptRecording: true,
};

describe('getRecordingPermissionNotice', () => {
  it('returns no notice when recording permissions are granted', () => {
    expect(getRecordingPermissionNotice(grantedSnapshot)).toBeNull();
  });

  it('explains how to recover screen recording access', () => {
    expect(getRecordingPermissionNotice({
      ...grantedSnapshot,
      screen: 'denied',
      canAttemptRecording: false,
    })).toEqual({
      tone: 'info',
      message: 'Screen and system audio access is off. Allow Electron in System Settings, then restart the app.',
      settingsPermission: 'screen',
    });
  });

  it('explains how to recover microphone access for the current permission owner', () => {
    expect(getRecordingPermissionNotice({
      ...grantedSnapshot,
      microphone: 'denied',
      permissionOwnerName: 'Interview Copilot',
      canAttemptRecording: false,
    })).toEqual({
      tone: 'info',
      message: 'Microphone access is off. Allow Interview Copilot in System Settings, then restart the app.',
      settingsPermission: 'microphone',
    });
  });

  it('names both blocked permissions and recovers screen access first', () => {
    expect(getRecordingPermissionNotice({
      ...grantedSnapshot,
      screen: 'restricted',
      microphone: 'denied',
      canAttemptRecording: false,
    })).toEqual({
      tone: 'info',
      message: 'Screen, system audio, and microphone access are off. Allow Electron in System Settings, then restart the app.',
      settingsPermission: 'screen',
    });
  });

  it('explains that macOS will ask for undetermined permissions', () => {
    expect(getRecordingPermissionNotice({
      ...grantedSnapshot,
      screen: 'not-determined',
    })).toEqual({
      tone: 'info',
      message: 'Recording needs screen, system audio, and microphone access. macOS will ask when you start recording.',
    });
  });

  it('allows a recording attempt when permission status is unknown', () => {
    expect(getRecordingPermissionNotice({
      ...grantedSnapshot,
      microphone: 'unknown',
    })).toEqual({
      tone: 'info',
      message: "Interview Copilot couldn't confirm recording permissions. You can still try to start recording.",
    });
  });
});
