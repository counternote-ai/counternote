export type RecordingPermissionStatus =
  'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export type RecordingPermission = 'screen' | 'microphone';
export type PermissionOwnerName = 'Electron' | 'Interview Copilot';

export interface RecordingPermissionSnapshot {
  screen: RecordingPermissionStatus;
  microphone: RecordingPermissionStatus;
  permissionOwnerName: PermissionOwnerName;
  canAttemptRecording: boolean;
}
