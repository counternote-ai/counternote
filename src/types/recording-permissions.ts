export type RecordingPermissionStatus =
  'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export type RecordingPermission = 'screen' | 'microphone';
export type PermissionOwnerName = 'Electron' | 'CounterNote';

export interface RecordingPermissionSnapshot {
  screen: RecordingPermissionStatus;
  microphone: RecordingPermissionStatus;
  permissionOwnerName: PermissionOwnerName;
  canAttemptRecording: boolean;
}
