import { app, desktopCapturer, shell, systemPreferences } from 'electron';
import {
  type RecordingPermission,
  type RecordingPermissionSnapshot,
  type RecordingPermissionStatus,
} from '../types/recording-permissions';

const SETTINGS_URLS: Record<RecordingPermission, string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
};

const BLOCKING_STATUSES: ReadonlySet<RecordingPermissionStatus> = new Set(['denied', 'restricted']);
const DEFAULT_SCREEN_PROBE_TIMEOUT_MS = 10_000;

interface RecordingPermissionRequesterOptions {
  screenProbeTimeoutMs?: number;
}

function readStatus(permission: RecordingPermission): RecordingPermissionStatus {
  try {
    return systemPreferences.getMediaAccessStatus(permission);
  } catch {
    return 'unknown';
  }
}

export function getRecordingPermissionSnapshot(): RecordingPermissionSnapshot {
  if (!app.isPackaged && process.env.COUNTERNOTE_E2E === '1') {
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
    permissionOwnerName: app.isPackaged ? 'CounterNote' : 'Electron',
    canAttemptRecording: !BLOCKING_STATUSES.has(screen) && !BLOCKING_STATUSES.has(microphone),
  };
}

async function probeScreenPermission(timeoutMs: number): Promise<void> {
  let probe: ReturnType<typeof desktopCapturer.getSources>;
  try {
    probe = desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
  } catch {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    void probe.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      () => {
        clearTimeout(timeout);
        resolve();
      },
    );
  });
}

export function createRecordingPermissionRequester(
  options: RecordingPermissionRequesterOptions = {},
): () => Promise<RecordingPermissionSnapshot> {
  let request: Promise<RecordingPermissionSnapshot> | null = null;

  return () => {
    request ??= (async () => {
      let permissions = getRecordingPermissionSnapshot();

      if (permissions.microphone === 'not-determined') {
        try {
          await systemPreferences.askForMediaAccess('microphone');
        } catch {
          // A failed prompt is represented by the refreshed permission snapshot below.
        }
        permissions = getRecordingPermissionSnapshot();
      }

      if (permissions.screen !== 'granted' && permissions.screen !== 'restricted') {
        await probeScreenPermission(
          options.screenProbeTimeoutMs ?? DEFAULT_SCREEN_PROBE_TIMEOUT_MS,
        );
      }

      return getRecordingPermissionSnapshot();
    })();

    return request;
  };
}

export const requestRecordingPermissions = createRecordingPermissionRequester();

export async function openRecordingPermissionSettings(
  permission: RecordingPermission,
): Promise<void> {
  await shell.openExternal(SETTINGS_URLS[permission]);
}
