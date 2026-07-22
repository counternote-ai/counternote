const mockEffects: Array<() => void | (() => void)> = [];
const mockEventListeners = new Map<string, () => void>();
const mockStateValues: unknown[] = [];
let mockStateCursor = 0;
let mockLatestTree: MockElement | null = null;
let mockConsoleError: jest.SpiedFunction<typeof console.error>;

interface MockElement {
  type: unknown;
  props: Record<string, unknown>;
}

interface MockControlPanelProps {
  recordings: Array<{ id: string; title: string }>;
  permissionNotice: { tone: string; message: string; settingsPermission?: string } | null;
  onStartRecording: () => Promise<void>;
  onOpenPermissionSettings: () => Promise<void>;
  onDismissPermissionNotice: () => void;
}

const mockCreateElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): MockElement => ({
  type,
  props: {
    ...props,
    ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
  },
});

const mockAlert = (): null => null;
const mockAlertDescription = (): null => null;
const mockButton = (): null => null;
const mockControlPanel = (): null => null;

jest.mock('react', () => ({
  __esModule: true,
  default: { createElement: mockCreateElement },
  useCallback: <T,>(callback: T): T => callback,
  useEffect: (effect: () => void | (() => void)): void => {
    mockEffects.push(effect);
  },
  useRef: <T,>(initialValue: T) => ({ current: initialValue }),
  useState: <T,>(initialValue: T): [T, (value: T) => void] => {
    const index = mockStateCursor++;
    if (mockStateValues[index] === undefined) {
      mockStateValues[index] = initialValue;
    }
    return [mockStateValues[index] as T, (value: T): void => {
      mockStateValues[index] = value;
    }];
  },
}));

jest.mock('./components/ControlPanel', () => ({ ControlPanel: mockControlPanel }));
jest.mock('./components/TranscriptView', () => ({ TranscriptView: (): null => null }));
jest.mock('./components/Settings', () => ({ Settings: (): null => null }));
jest.mock('./components/ui/alert', () => ({
  Alert: mockAlert,
  AlertDescription: mockAlertDescription,
}));
jest.mock('./components/ui/button', () => ({ Button: mockButton }));

const mockCaptureStart = jest.fn<Promise<void>, []>();
const mockCaptureStop = jest.fn<void, []>();
jest.mock('./audio-capture', () => ({
  AudioCapture: jest.fn().mockImplementation(() => ({
    start: mockCaptureStart,
    stop: mockCaptureStop,
  })),
}));

const App = require('./App').default as typeof import('./App').default;

function renderApp(): MockElement {
  mockStateCursor = 0;
  mockLatestTree = App() as unknown as MockElement;
  return mockLatestTree;
}

function getControlPanelProps(): MockControlPanelProps {
  if (!mockLatestTree) {
    throw new Error('App has not been rendered');
  }

  const children = mockLatestTree.props.children as unknown[];
  const panel = children[1] as MockElement;
  return panel.props as unknown as MockControlPanelProps;
}

function getErrorMessage(): string | null {
  if (!mockLatestTree) {
    throw new Error('App has not been rendered');
  }

  const children = mockLatestTree.props.children as unknown[];
  const errorBanner = children[0] as MockElement | null;
  if (!errorBanner) return null;

  const description = errorBanner.props.children as MockElement;
  const descriptionChildren = description.props.children as MockElement[];
  const message = descriptionChildren[0];
  return message.props.children as string;
}

function grantedPermissions() {
  return {
    screen: 'granted' as const,
    microphone: 'granted' as const,
    permissionOwnerName: 'Electron' as const,
    canAttemptRecording: true,
  };
}

function blockedPermissions() {
  return {
    ...grantedPermissions(),
    screen: 'denied' as const,
    canAttemptRecording: false,
  };
}

const mockElectronAPI = {
  getRecordingPermissions: jest.fn(),
  openRecordingPermissionSettings: jest.fn(),
  loadConfig: jest.fn(),
  listRecordings: jest.fn(),
  startRecording: jest.fn(),
  onStopRecording: jest.fn(),
  onOpenSettings: jest.fn(),
};

beforeEach(() => {
  mockEffects.splice(0);
  mockEventListeners.clear();
  mockStateValues.splice(0);
  mockStateCursor = 0;
  mockLatestTree = null;
  jest.clearAllMocks();
  mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

  mockElectronAPI.getRecordingPermissions.mockResolvedValue({
    success: true,
    permissions: grantedPermissions(),
  });
  mockElectronAPI.openRecordingPermissionSettings.mockResolvedValue({ success: true });
  mockElectronAPI.loadConfig.mockResolvedValue({ success: true });
  mockElectronAPI.listRecordings.mockResolvedValue({ success: true, recordings: [] });
  mockElectronAPI.startRecording.mockResolvedValue({ success: true });
  mockCaptureStart.mockResolvedValue(undefined);

  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      electronAPI: mockElectronAPI,
      addEventListener: jest.fn((event: string, listener: () => void) => {
        mockEventListeners.set(event, listener);
      }),
      removeEventListener: jest.fn((event: string) => {
        mockEventListeners.delete(event);
      }),
    },
  });
});

afterEach(() => {
  mockConsoleError.mockRestore();
});

describe('recording permission lifecycle', () => {
  it('refreshes on startup and focus without opening System Settings', async () => {
    renderApp();
    const permissionEffect = mockEffects[2];
    permissionEffect();
    await Promise.resolve();

    mockEventListeners.get('focus')?.();
    await Promise.resolve();

    expect(mockElectronAPI.getRecordingPermissions).toHaveBeenCalledTimes(2);
    expect(mockElectronAPI.openRecordingPermissionSettings).not.toHaveBeenCalled();
  });

  it('refreshes before Record, blocks capture, and keeps the recordings library available after dismissal', async () => {
    mockElectronAPI.listRecordings.mockResolvedValue({
      success: true,
      recordings: [{ id: 'saved-recording', title: 'Saved interview' }],
    });
    mockElectronAPI.getRecordingPermissions.mockResolvedValueOnce({
      success: true,
      permissions: blockedPermissions(),
    });

    renderApp();
    const recordingsEffect = mockEffects[1];
    recordingsEffect();
    await Promise.resolve();
    await getControlPanelProps().onStartRecording();
    renderApp();

    expect(mockElectronAPI.getRecordingPermissions).toHaveBeenCalledTimes(1);
    expect(mockCaptureStart).not.toHaveBeenCalled();
    expect(getControlPanelProps().permissionNotice?.tone).toBe('error');
    expect(getControlPanelProps().recordings).toEqual([
      { id: 'saved-recording', title: 'Saved interview' },
    ]);

    getControlPanelProps().onDismissPermissionNotice();
    renderApp();

    expect(getControlPanelProps().permissionNotice).toBeNull();
    expect(getControlPanelProps().recordings).toEqual([
      { id: 'saved-recording', title: 'Saved interview' },
    ]);
  });

  it('only opens settings from the explicit recovery action', async () => {
    mockElectronAPI.getRecordingPermissions.mockResolvedValue({
      success: true,
      permissions: blockedPermissions(),
    });
    renderApp();
    mockEffects[2]();
    await Promise.resolve();
    renderApp();

    expect(mockElectronAPI.openRecordingPermissionSettings).not.toHaveBeenCalled();

    await getControlPanelProps().onOpenPermissionSettings();

    expect(mockElectronAPI.openRecordingPermissionSettings).toHaveBeenCalledWith('screen');
  });

  it('uses the inline unknown-permission notice without an additional error banner when the query fails', async () => {
    mockElectronAPI.getRecordingPermissions.mockResolvedValue({
      success: false,
      error: 'raw IPC query failure',
    });
    renderApp();
    mockEffects[2]();
    await Promise.resolve();
    renderApp();

    expect(getControlPanelProps().permissionNotice).toEqual({
      tone: 'info',
      message: "Interview Copilot couldn't confirm recording permissions. You can still try to start recording.",
    });
    expect(getErrorMessage()).toBeNull();
  });

  it('never exposes a raw display-capture failure as rendered error copy', async () => {
    const rawCaptureError = 'NotAllowedError: Chromium display capture failure 42';
    mockCaptureStart.mockRejectedValueOnce(new Error(rawCaptureError));
    renderApp();

    await getControlPanelProps().onStartRecording();
    renderApp();

    expect(getErrorMessage()).toBe('Unable to start recording. Check your recording permissions and try again.');
    expect(getErrorMessage()).not.toContain(rawCaptureError);
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Failed to start audio capture:',
      expect.objectContaining({ message: rawCaptureError })
    );
  });
});
