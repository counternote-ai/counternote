import { type RecordingPermissionSnapshot } from '../types/recording-permissions';
import { AudioCapture } from './audio-capture';
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
      tone: 'error',
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
      tone: 'error',
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
      tone: 'error',
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

describe('AudioCapture', () => {
  const displayAudioStop = jest.fn();
  const displayVideoStop = jest.fn();
  const microphoneStop = jest.fn();
  const close = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    jest.clearAllMocks();

    const displayStream = {
      getVideoTracks: jest.fn(() => [{ stop: displayVideoStop }]),
      getTracks: jest.fn(() => [
        { stop: displayAudioStop },
        { stop: displayVideoStop },
      ]),
    } as unknown as MediaStream;
    const microphoneStream = {
      getTracks: jest.fn(() => [{ stop: microphoneStop }]),
    } as unknown as MediaStream;

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getDisplayMedia: jest.fn().mockResolvedValue(displayStream),
          getUserMedia: jest.fn().mockResolvedValue(microphoneStream),
        },
      },
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { href: 'file:///app/index.html' } },
    });
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      value: jest.fn().mockImplementation(() => ({
        audioWorklet: {
          addModule: jest.fn().mockRejectedValue(new Error('worklet failed')),
        },
        close,
      })),
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'navigator');
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'AudioContext');
  });

  it('cleans up streams and the audio context when setup fails partway through', async () => {
    const capture = new AudioCapture();

    await expect(capture.start()).rejects.toThrow('worklet failed');

    expect(displayAudioStop).toHaveBeenCalledTimes(1);
    expect(microphoneStop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    capture.stop();

    expect(displayAudioStop).toHaveBeenCalledTimes(1);
    expect(microphoneStop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
