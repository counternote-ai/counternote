import {
  type RecordingPermission,
  type RecordingPermissionSnapshot,
} from '../types/recording-permissions';

export interface RecordingPermissionNotice {
  tone: 'info' | 'error';
  message: string;
  settingsPermission?: RecordingPermission;
}

const isBlocked = (status: RecordingPermissionSnapshot['screen']): boolean =>
  status === 'denied' || status === 'restricted';

export function getRecordingPermissionNotice(
  snapshot: RecordingPermissionSnapshot,
): RecordingPermissionNotice | null {
  const screenBlocked = isBlocked(snapshot.screen);
  const microphoneBlocked = isBlocked(snapshot.microphone);

  if (screenBlocked && microphoneBlocked) {
    return {
      tone: 'info',
      message: `Screen, system audio, and microphone access are off. Allow ${snapshot.permissionOwnerName} in System Settings, then restart the app.`,
      settingsPermission: 'screen',
    };
  }
  if (screenBlocked) {
    return {
      tone: 'info',
      message: `Screen and system audio access is off. Allow ${snapshot.permissionOwnerName} in System Settings, then restart the app.`,
      settingsPermission: 'screen',
    };
  }
  if (microphoneBlocked) {
    return {
      tone: 'info',
      message: `Microphone access is off. Allow ${snapshot.permissionOwnerName} in System Settings, then restart the app.`,
      settingsPermission: 'microphone',
    };
  }
  if (snapshot.screen === 'not-determined' || snapshot.microphone === 'not-determined') {
    return {
      tone: 'info',
      message:
        'Recording needs screen, system audio, and microphone access. macOS will ask when you start recording.',
    };
  }
  if (snapshot.screen === 'unknown' || snapshot.microphone === 'unknown') {
    return {
      tone: 'info',
      message:
        "CounterNote couldn't confirm recording permissions. You can still try to start recording.",
    };
  }
  return null;
}
