import { app, shell, systemPreferences } from 'electron';
import {
  type RecordingPermission,
  type RecordingPermissionSnapshot,
  type RecordingPermissionStatus,
} from '../types/recording-permissions';

const SETTINGS_URLS: Record<RecordingPermission, string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
};

const BLOCKING_STATUSES: ReadonlySet<RecordingPermissionStatus> = new Set([
  'denied',
  'restricted',
]);

function readStatus(permission: RecordingPermission): RecordingPermissionStatus {
  try {
    return systemPreferences.getMediaAccessStatus(permission);
  } catch {
    return 'unknown';
  }
}

export function getRecordingPermissionSnapshot(): RecordingPermissionSnapshot {
  if (!app.isPackaged && process.env.INTERVIEW_COPILOT_E2E === '1') {
    return {
      screen: 'granted',
      microphone: 'granted',
      permissionOwnerName: 'Electron',
      canAttemptRecording: true,
    };
  }

  const screen = readStatus('screen');
  const microphone = readStatus('microphone');

  return {
    screen,
    microphone,
    permissionOwnerName: app.isPackaged ? 'Interview Copilot' : 'Electron',
    canAttemptRecording:
      !BLOCKING_STATUSES.has(screen) && !BLOCKING_STATUSES.has(microphone),
  };
}

export async function openRecordingPermissionSettings(
  permission: RecordingPermission
): Promise<void> {
  await shell.openExternal(SETTINGS_URLS[permission]);
}
