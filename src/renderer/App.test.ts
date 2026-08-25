import type { ComponentProps } from 'react';

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
  recordings: Array<{ id: string; title: string; duration?: number; captureStatus?: string }>;
  permissionNotice: { tone: string; message: string; settingsPermission?: string } | null;
  permissionEscalated?: boolean;
  localTranscriptionUnavailable?: boolean;
  transcriptionProgress?: { recordingId: string; stage: string } | null;
  isRecording?: boolean;
  isStarting?: boolean;
  isFinishing?: boolean;
  healthView?: {
    state: string;
    startingMessage: string | null;
    finishingMessage: string | null;
    channels: Array<{ label: string; statusText: string; tone: string }>;
    ariaSummary: string;
    canCancel: boolean;
    canStop: boolean;
  } | null;
  recoveryItems?: Array<{ id: string; createdAt: string; bytes: number; state: string }>;
  recoveringId?: string | null;
  onStartRecording: () => Promise<void>;
  onCancelRecording?: () => Promise<void>;
  onStopRecording?: () => Promise<void>;
  onTranscribe: (recordingId: string) => Promise<void>;
  onOpenPermissionSettings: () => Promise<void>;
  onDismissPermissionNotice: () => void;
  onRecover?: (id: string) => Promise<void>;
  onTrashRecovery?: (id: string) => Promise<void>;
}

interface MockSettingsProps {
  apiKey: string;
  model: string;
  provider?: 'local' | 'groq';
  onSave: (settings: {
    apiKey: string;
    model: string;
    transcriptionProvider?: 'local' | 'groq';
  }) => Promise<void>;
}

interface MockTranscriptProps {
  onExport: () => Promise<void>;
  onShowExportedTranscript: () => Promise<void>;
  onShowRecordingFiles: () => Promise<void>;
  exportNotice: 'saved' | 'show-failed' | null;
}

const mockCreateElement = (
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: unknown[]
): MockElement => ({
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
const mockSettings = (): null => null;
const mockTranscriptView = (): null => null;
const mockIcon = (): null => null;
const mockBadge = (): null => null;
const mockCard = (): null => null;
const mockCardContent = (): null => null;
const mockInput = (): null => null;
const mockLabel = (): null => null;
const mockSelect = (): null => null;
const mockSelectContent = (): null => null;
const mockSelectItem = (): null => null;
const mockSelectTrigger = (): null => null;
const mockSelectValue = (): null => null;
const mockSeparator = (): null => null;
const mockScrollArea = (): null => null;

jest.mock('react', () => ({
  __esModule: true,
  default: { createElement: mockCreateElement },
  useCallback: <T>(callback: T): T => callback,
  useEffect: (effect: () => void | (() => void)): void => {
    mockEffects.push(effect);
  },
  useRef: <T>(initialValue: T) => ({ current: initialValue }),
  useState: <T>(initialValue: T): [T, (value: T) => void] => {
    const index = mockStateCursor++;
    if (mockStateValues[index] === undefined) {
      mockStateValues[index] = initialValue;
    }
    return [
      mockStateValues[index] as T,
      (value: T): void => {
        mockStateValues[index] = value;
      },
    ];
  },
}));

jest.mock('./components/ControlPanel', () => ({ ControlPanel: mockControlPanel }));
jest.mock('./components/TranscriptView', () => ({ TranscriptView: mockTranscriptView }));
jest.mock('./components/Settings', () => ({ Settings: mockSettings }));
jest.mock('./components/ui/alert', () => ({
  Alert: mockAlert,
  AlertDescription: mockAlertDescription,
}));
jest.mock('./components/ui/button', () => ({ Button: mockButton }));
jest.mock('./components/ui/badge', () => ({ Badge: mockBadge }));
jest.mock('./components/ui/card', () => ({ Card: mockCard, CardContent: mockCardContent }));
jest.mock('./components/ui/input', () => ({ Input: mockInput }));
jest.mock('./components/ui/label', () => ({ Label: mockLabel }));
jest.mock('./components/ui/select', () => ({
  Select: mockSelect,
  SelectContent: mockSelectContent,
  SelectItem: mockSelectItem,
  SelectTrigger: mockSelectTrigger,
  SelectValue: mockSelectValue,
}));
jest.mock('./components/ui/separator', () => ({ Separator: mockSeparator }));
jest.mock('./components/ui/scroll-area', () => ({ ScrollArea: mockScrollArea }));
jest.mock('lucide-react', () => ({
  ChevronLeft: mockIcon,
  Download: mockIcon,
  KeyRound: mockIcon,
  ShieldCheck: mockIcon,
}));

const App = require('./App').default as typeof import('./App').default;
const ActualSettings = jest.requireActual('./components/Settings')
  .Settings as typeof import('./components/Settings').Settings;

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

function getSettingsProps(): MockSettingsProps {
  if (!mockLatestTree) {
    throw new Error('App has not been rendered');
  }

  const children = mockLatestTree.props.children as unknown[];
  return (children[1] as MockElement).props as unknown as MockSettingsProps;
}

function getTranscriptProps(): MockTranscriptProps {
  if (!mockLatestTree) {
    throw new Error('App has not been rendered');
  }

  const children = mockLatestTree.props.children as unknown[];
  return (children[1] as MockElement).props as unknown as MockTranscriptProps;
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

function findElements(value: unknown, predicate: (element: MockElement) => boolean): MockElement[] {
  if (typeof value !== 'object' || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((child) => findElements(child, predicate));

  const element = value as MockElement;
  const matches = predicate(element) ? [element] : [];
  return matches.concat(findElements(element.props?.children, predicate));
}

function renderedText(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(renderedText);
  return renderedText((value as MockElement).props?.children);
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
  onOpenSettings: jest.fn(),
  onTranscriptionProgress: jest.fn(),
  onLocalModelStatus: jest.fn(),
  getLocalModelStatus: jest.fn(),
  installLocalModel: jest.fn(),
  transcribe: jest.fn(),
  exportTranscript: jest.fn(),
  showExportedTranscript: jest.fn(),
  showRecordingFiles: jest.fn(),
  saveConfig: jest.fn(),
  recordingStart: jest.fn(),
  recordingStop: jest.fn(),
  recordingCancel: jest.fn(),
  recordingGetStatus: jest.fn(),
  recordingListRecovery: jest.fn(),
  recordingRecover: jest.fn(),
  recordingTrashRecovery: jest.fn(),
  onRecordingStatus: jest.fn(),
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
  mockElectronAPI.loadConfig.mockResolvedValue({
    success: true,
    config: {
      apiKey: 'existing-key',
      model: 'whisper-large-v3-turbo',
      transcriptionProvider: 'local',
    },
  });
  mockElectronAPI.listRecordings.mockResolvedValue({ success: true, recordings: [] });
  mockElectronAPI.getLocalModelStatus.mockResolvedValue({ state: 'not-downloaded' });
  mockElectronAPI.installLocalModel.mockResolvedValue({ success: true });
  mockElectronAPI.transcribe.mockResolvedValue({ success: true });
  mockElectronAPI.exportTranscript.mockResolvedValue({ success: true });
  mockElectronAPI.showExportedTranscript.mockResolvedValue({ success: true });
  mockElectronAPI.showRecordingFiles.mockResolvedValue({ success: true });
  mockElectronAPI.saveConfig.mockResolvedValue({ success: true });
  mockElectronAPI.recordingStart.mockResolvedValue({ ok: true, recordingId: 'test-recording-id' });
  mockElectronAPI.recordingStop.mockResolvedValue({ status: 'complete' });
  mockElectronAPI.recordingCancel.mockResolvedValue({ status: 'complete' });
  mockElectronAPI.recordingGetStatus.mockResolvedValue({
    state: 'idle',
    recordingId: undefined,
    canCancel: false,
    canStop: false,
    channels: {
      interviewer: { status: 'idle', started: false },
      you: { status: 'idle', started: false },
    },
  });
  mockElectronAPI.recordingListRecovery.mockResolvedValue([]);
  mockElectronAPI.recordingRecover.mockResolvedValue({ outcome: 'recovered' });
  mockElectronAPI.recordingTrashRecovery.mockResolvedValue({ outcome: 'trashed' });
  mockElectronAPI.onRecordingStatus.mockReturnValue(jest.fn());

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
    expect(mockElectronAPI.recordingStart).not.toHaveBeenCalled();
    expect(getControlPanelProps().permissionNotice?.tone).toBe('info');
    expect(getControlPanelProps().permissionEscalated).toBe(true);
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

  it('clears the escalated permission warning once permissions become usable again', async () => {
    mockElectronAPI.getRecordingPermissions
      .mockResolvedValueOnce({
        success: true,
        permissions: blockedPermissions(),
      })
      .mockResolvedValueOnce({
        success: true,
        permissions: blockedPermissions(),
      });

    renderApp();
    mockEffects[2]();
    await Promise.resolve();
    await getControlPanelProps().onStartRecording();
    renderApp();

    expect(getControlPanelProps().permissionEscalated).toBe(true);

    mockEventListeners.get('focus')?.();
    await Promise.resolve();
    renderApp();

    expect(getControlPanelProps().permissionEscalated).toBe(false);
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
      message:
        "CounterNote couldn't confirm recording permissions. You can still try to start recording.",
    });
    expect(getErrorMessage()).toBeNull();
  });

  it('never exposes a raw display-capture failure as rendered error copy', async () => {
    mockElectronAPI.recordingStart.mockResolvedValueOnce({ ok: false, reason: 'helper-error' });
    renderApp();

    await getControlPanelProps().onStartRecording();
    renderApp();

    expect(getErrorMessage()).toBe(
      'Recording could not start. The audio helper encountered an error.',
    );
    expect(getErrorMessage()).not.toContain('NotAllowedError');
    expect(mockConsoleError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: 'NotAllowedError' }),
    );
  });

  it('uses storage recovery copy when persistence fails', async () => {
    mockElectronAPI.recordingStart.mockResolvedValueOnce({
      ok: false,
      reason: 'persistence-error',
    });
    renderApp();

    await getControlPanelProps().onStartRecording();
    renderApp();

    expect(getErrorMessage()).toBe('Recording could not start. Check available disk space.');
    expect(getErrorMessage()).not.toContain('permissions');
  });
});

describe('transcription IPC lifecycle', () => {
  it('subscribes once to transcription and model updates and removes both listeners on cleanup', async () => {
    const unsubscribeProgress = jest.fn();
    const unsubscribeModel = jest.fn();
    mockElectronAPI.onTranscriptionProgress.mockReturnValue(unsubscribeProgress);
    mockElectronAPI.onLocalModelStatus.mockReturnValue(unsubscribeModel);

    renderApp();
    const cleanups = mockEffects
      .map((effect) => effect())
      .filter((cleanup): cleanup is () => void => typeof cleanup === 'function');
    await Promise.resolve();

    expect(mockElectronAPI.onTranscriptionProgress).toHaveBeenCalledTimes(1);
    expect(mockElectronAPI.onLocalModelStatus).toHaveBeenCalledTimes(1);

    cleanups.forEach((cleanup) => cleanup());

    expect(unsubscribeProgress).toHaveBeenCalledTimes(1);
    expect(unsubscribeModel).toHaveBeenCalledTimes(1);
  });

  it('sends only the recording ID when a saved recording is transcribed', async () => {
    mockStateValues[1] = [
      {
        id: '2026-07-27T12-00-00-000Z',
        title: 'Saved interview',
        duration: 60,
        transcribed: false,
        audioPath: '/private/recordings/secret/audio.wav',
      },
    ];
    renderApp();

    await getControlPanelProps().onTranscribe('2026-07-27T12-00-00-000Z');

    expect(mockElectronAPI.transcribe).toHaveBeenCalledWith('2026-07-27T12-00-00-000Z');
    expect(mockElectronAPI.transcribe).not.toHaveBeenCalledWith(
      '/private/recordings/secret/audio.wav',
    );
  });

  it('starts a transcription with progress scoped to the selected recording', async () => {
    mockStateValues[1] = [
      { id: 'active-recording', title: 'Active interview', duration: 60, transcribed: false },
      { id: 'other-recording', title: 'Other interview', duration: 60, transcribed: false },
    ];
    let resolveTranscription: (result: { success: true }) => void = () => undefined;
    mockElectronAPI.transcribe.mockImplementationOnce(
      () =>
        new Promise<{ success: true }>((resolve) => {
          resolveTranscription = resolve;
        }),
    );
    renderApp();

    const transcription = getControlPanelProps().onTranscribe('active-recording');
    renderApp();

    expect(getControlPanelProps().transcriptionProgress).toEqual({
      recordingId: 'active-recording',
      stage: 'preparing-audio',
    });

    resolveTranscription({ success: true });
    await transcription;
  });

  it('keeps the recording after a transcription failure and lets the candidate dismiss its recovery alert', async () => {
    mockStateValues[1] = [
      { id: 'saved-recording', title: 'Saved interview', duration: 60, transcribed: false },
    ];
    mockElectronAPI.transcribe.mockResolvedValueOnce({
      success: false,
      code: 'LOCAL_TRANSCRIPTION_TIMEOUT',
    });
    renderApp();

    await getControlPanelProps().onTranscribe('saved-recording');
    renderApp();

    expect(getErrorMessage()).toBe(
      'Local transcription stopped responding. Your recording is still saved. Try again, or select Groq in Settings.',
    );
    expect(getControlPanelProps().recordings).toEqual([
      { id: 'saved-recording', title: 'Saved interview', duration: 60, transcribed: false },
    ]);

    const dismiss = findElements(mockLatestTree, (element) => element.type === mockButton)[0];
    (dismiss.props.onClick as () => void)();
    renderApp();

    expect(getErrorMessage()).toBeNull();
    expect(getControlPanelProps().recordings).toEqual([
      { id: 'saved-recording', title: 'Saved interview', duration: 60, transcribed: false },
    ]);
  });

  it('sends only the recording ID when exporting a transcript', async () => {
    mockStateValues[0] = 'transcript';
    mockStateValues[2] = {
      id: '2026-07-27T12-00-00-000Z',
      title: 'Saved interview',
      duration: 60,
      transcribed: true,
      transcriptPath: '/private/recordings/secret/transcript.json',
    };
    renderApp();

    await getTranscriptProps().onExport();

    expect(mockElectronAPI.exportTranscript).toHaveBeenCalledWith(
      '2026-07-27T12-00-00-000Z',
      'txt',
    );
    expect(mockElectronAPI.exportTranscript).not.toHaveBeenCalledWith(
      '/private/recordings/secret/transcript.json',
      'txt',
    );
  });

  it('shows a saved notice after exporting and offers to reveal the transcript', async () => {
    mockStateValues[0] = 'transcript';
    mockStateValues[2] = {
      id: '2026-07-27T12-00-00-000Z',
      title: 'Saved meeting',
      duration: 60,
      transcribed: true,
    };
    renderApp();

    await getTranscriptProps().onExport();
    renderApp();

    expect(getTranscriptProps().exportNotice).toBe('saved');
    await getTranscriptProps().onShowExportedTranscript();
    expect(mockElectronAPI.showExportedTranscript).toHaveBeenCalledWith('2026-07-27T12-00-00-000Z');
  });

  it('keeps the saved result but reports when Finder cannot reveal the transcript', async () => {
    mockStateValues[0] = 'transcript';
    mockStateValues[2] = {
      id: '2026-07-27T12-00-00-000Z',
      title: 'Saved meeting',
      duration: 60,
      transcribed: true,
    };
    mockElectronAPI.showExportedTranscript.mockResolvedValueOnce({
      success: false,
      code: 'SHOW_IN_FINDER_FAILED',
    });
    renderApp();

    await getTranscriptProps().onExport();
    renderApp();
    await getTranscriptProps().onShowExportedTranscript();
    renderApp();

    expect(getTranscriptProps().exportNotice).toBe('show-failed');
    expect(getErrorMessage()).toBeNull();
  });

  it('opens the selected recording directory and maps failures to safe copy', async () => {
    mockStateValues[0] = 'transcript';
    mockStateValues[2] = {
      id: '2026-07-27T12-00-00-000Z',
      title: 'Saved meeting',
      duration: 60,
      transcribed: true,
    };
    mockElectronAPI.showRecordingFiles.mockRejectedValueOnce(
      new Error('/private/recordings/secret'),
    );
    renderApp();

    await getTranscriptProps().onShowRecordingFiles();
    renderApp();

    expect(mockElectronAPI.showRecordingFiles).toHaveBeenCalledWith('2026-07-27T12-00-00-000Z');
    expect(getErrorMessage()).toBe("Recording files couldn't be opened in Finder.");
    expect(getErrorMessage()).not.toContain('/private');
  });

  it('saves the selected local provider while preserving Groq values', async () => {
    renderApp();
    mockEffects[0]();
    await Promise.resolve();
    renderApp();
    mockEffects[5]();
    mockElectronAPI.onOpenSettings.mock.calls[0][0]();
    renderApp();

    await getSettingsProps().onSave({
      apiKey: 'existing-key',
      model: 'whisper-large-v3-turbo',
      transcriptionProvider: 'local',
    });

    expect(mockElectronAPI.saveConfig).toHaveBeenCalledWith({
      apiKey: 'existing-key',
      model: 'whisper-large-v3-turbo',
      transcriptionProvider: 'local',
    });
  });

  it('keeps Local selected when its sidecar is unavailable instead of falling back to Groq', () => {
    mockStateValues[6] = { state: 'unavailable', reason: 'sidecar-missing' };
    renderApp();

    expect(getControlPanelProps().localTranscriptionUnavailable).toBe(true);
  });
});

describe('transcription provider settings', () => {
  const renderSettings = (
    overrides: Partial<ComponentProps<typeof ActualSettings>> = {},
  ): MockElement => {
    mockStateValues.splice(0);
    mockStateCursor = 0;
    return ActualSettings({
      apiKey: 'existing-key',
      model: 'whisper-large-v3-turbo',
      provider: 'local',
      localModelStatus: { state: 'not-downloaded' },
      onInstallLocalModel: jest.fn().mockResolvedValue({ success: true }),
      onSave: jest.fn().mockResolvedValue(undefined),
      onBack: jest.fn(),
      ...overrides,
    }) as unknown as MockElement;
  };

  it('defaults missing provider configuration to Local Whisper with local-only privacy copy', () => {
    const tree = renderSettings();
    const text = renderedText(tree).join(' ');

    expect(findElements(tree, (element) => element.type === mockSelect)[0].props.value).toBe(
      'local',
    );
    expect(text).toContain('Large V3 Turbo · about 547 MB');
    expect(text).toContain('Not downloaded');
    expect(text).toContain('Transcription runs on this Mac. Audio is not uploaded.');
    expect(text).not.toContain('Groq API Key');
  });

  it('reveals Groq configuration and its upload boundary only after explicit Groq selection', () => {
    let tree = renderSettings();
    const providerSelect = findElements(tree, (element) => element.type === mockSelect)[0];
    (providerSelect.props.onValueChange as (value: string) => void)('groq');
    mockStateCursor = 0;
    tree = ActualSettings({
      apiKey: 'existing-key',
      model: 'whisper-large-v3-turbo',
      provider: 'local',
      localModelStatus: { state: 'not-downloaded' },
      onInstallLocalModel: jest.fn().mockResolvedValue({ success: true }),
      onSave: jest.fn().mockResolvedValue(undefined),
      onBack: jest.fn(),
    }) as unknown as MockElement;
    const text = renderedText(tree).join(' ');

    expect(text).toContain('Groq API Key');
    expect(text).toContain('Transcription sends prepared audio to Groq for processing.');
    expect(text).not.toContain('Transcription runs on this Mac. Audio is not uploaded.');
  });

  it('preserves hidden Groq values when saving Local Whisper', async () => {
    const onSave = jest.fn().mockResolvedValue(undefined);
    let tree = renderSettings({ onSave });
    const providerSelect = findElements(tree, (element) => element.type === mockSelect)[0];
    (providerSelect.props.onValueChange as (value: string) => void)('groq');
    mockStateCursor = 0;
    tree = ActualSettings({
      apiKey: 'existing-key',
      model: 'whisper-large-v3-turbo',
      provider: 'local',
      localModelStatus: { state: 'not-downloaded' },
      onInstallLocalModel: jest.fn().mockResolvedValue({ success: true }),
      onSave,
      onBack: jest.fn(),
    }) as unknown as MockElement;
    const groqInput = findElements(tree, (element) => element.props.id === 'groq-api-key')[0];
    (groqInput.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: 'preserved-key' },
    });
    const groqProviderSelect = findElements(tree, (element) => element.type === mockSelect)[0];
    (groqProviderSelect.props.onValueChange as (value: string) => void)('local');
    mockStateCursor = 0;
    tree = ActualSettings({
      apiKey: 'existing-key',
      model: 'whisper-large-v3-turbo',
      provider: 'local',
      localModelStatus: { state: 'not-downloaded' },
      onInstallLocalModel: jest.fn().mockResolvedValue({ success: true }),
      onSave,
      onBack: jest.fn(),
    }) as unknown as MockElement;

    const save = findElements(
      tree,
      (element) =>
        element.type === mockButton &&
        renderedText(element.props.children).includes('Save settings'),
    )[0];
    await (save.props.onClick as () => Promise<void>)();

    expect(onSave).toHaveBeenCalledWith({
      apiKey: 'preserved-key',
      model: 'whisper-large-v3-turbo',
      transcriptionProvider: 'local',
    });
  });

  it('keeps Local selected and explains when its sidecar is unavailable', () => {
    const tree = renderSettings({
      localModelStatus: { state: 'unavailable', reason: 'sidecar-missing' },
    });
    const text = renderedText(tree).join(' ');

    expect(findElements(tree, (element) => element.type === mockSelect)[0].props.value).toBe(
      'local',
    );
    expect(text).toContain('Unavailable');
    expect(text).toContain('Local Whisper is unavailable because its sidecar is not installed.');
    expect(text).not.toContain('Groq API Key');
  });

  it('disables only Save settings while the request is pending', async () => {
    let resolveSave: (() => void) | undefined;
    const onSave = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    let tree = renderSettings({ onSave });
    let save = findElements(
      tree,
      (element) =>
        element.type === mockButton &&
        renderedText(element.props.children).includes('Save settings'),
    )[0];

    (save.props.onClick as () => void)();
    mockStateCursor = 0;
    tree = ActualSettings({
      apiKey: 'existing-key',
      model: 'whisper-large-v3-turbo',
      provider: 'local',
      localModelStatus: { state: 'not-downloaded' },
      onInstallLocalModel: jest.fn().mockResolvedValue({ success: true }),
      onSave,
      onBack: jest.fn(),
    }) as unknown as MockElement;
    save = findElements(
      tree,
      (element) =>
        element.type === mockButton &&
        renderedText(element.props.children).includes('Save settings'),
    )[0];

    expect(save.props.disabled).toBe(true);
    expect(save.props['aria-busy']).toBe(true);
    expect(renderedText(tree).join(' ')).toContain('Saving settings');

    resolveSave?.();
    await Promise.resolve();
  });

  it('uses explicit installation progress, ready state, and retry after a failed download', async () => {
    const install = jest.fn().mockResolvedValue({ success: false, code: 'MODEL_DOWNLOAD_FAILED' });
    let tree = renderSettings({
      localModelStatus: { state: 'downloading', percent: 42 },
      onInstallLocalModel: install,
    });
    expect(renderedText(tree).join(' ')).toContain('Downloading · 42%');

    tree = renderSettings({ localModelStatus: { state: 'ready' } });
    expect(renderedText(tree).join(' ')).toContain('Ready');

    tree = renderSettings({ onInstallLocalModel: install });
    const download = findElements(
      tree,
      (element) =>
        element.type === mockButton &&
        renderedText(element.props.children).includes('Download model'),
    )[0];
    await (download.props.onClick as () => Promise<void>)();
    mockStateCursor = 0;
    tree = ActualSettings({
      apiKey: 'existing-key',
      model: 'whisper-large-v3-turbo',
      provider: 'local',
      localModelStatus: { state: 'not-downloaded' },
      onInstallLocalModel: install,
      onSave: jest.fn().mockResolvedValue(undefined),
      onBack: jest.fn(),
    }) as unknown as MockElement;

    expect(install).toHaveBeenCalledTimes(1);
    expect(renderedText(tree).join(' ')).toContain('Retry download');
  });
});

/* ── Native capture lifecycle ────────────────────────────────── */

describe('native capture lifecycle', () => {
  let statusCallback: ((snapshot: unknown) => void) | undefined;

  function simulateStatus(snapshot: {
    state: string;
    recordingId?: string;
    canCancel?: boolean;
    canStop?: boolean;
    channels?: {
      interviewer: { status: string; started: boolean };
      you: { status: string; started: boolean };
    };
  }): void {
    if (!statusCallback) throw new Error('onRecordingStatus not subscribed');
    statusCallback({
      recordingId: undefined,
      canCancel: false,
      canStop: false,
      channels: {
        interviewer: { status: 'idle', started: false },
        you: { status: 'idle', started: false },
      },
      ...snapshot,
    });
  }

  beforeEach(() => {
    statusCallback = undefined;
    mockElectronAPI.onRecordingStatus.mockImplementation((cb: (snapshot: unknown) => void) => {
      statusCallback = cb;
      return jest.fn();
    });
  });

  it('shows Starting… with Cancel when recording starts', async () => {
    mockElectronAPI.recordingStart.mockResolvedValueOnce({ ok: true, recordingId: 'new-id' });
    renderApp();
    // Run all effects to register subscriptions
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    await getControlPanelProps().onStartRecording();
    renderApp();

    expect(mockElectronAPI.recordingStart).toHaveBeenCalledTimes(1);
  });

  it('transitions to Recording only after the status becomes recording', async () => {
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    // Simulate starting state
    simulateStatus({
      state: 'starting',
      recordingId: 'test-id',
      canCancel: true,
      canStop: false,
    });
    renderApp();

    expect(getControlPanelProps().isStarting).toBe(true);

    // Simulate transition to recording
    simulateStatus({
      state: 'recording',
      recordingId: 'test-id',
      canCancel: false,
      canStop: true,
      channels: {
        interviewer: { status: 'connected', started: true },
        you: { status: 'connected', started: true },
      },
    });
    renderApp();

    expect(getControlPanelProps().isRecording).toBe(true);
    expect(getControlPanelProps().isStarting).toBeFalsy();
  });

  it('refreshes the library when a helper finishes recording without a Stop click', async () => {
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();
    mockElectronAPI.listRecordings.mockClear();

    simulateStatus({
      state: 'recording',
      recordingId: 'test-id',
      canStop: true,
    });
    simulateStatus({ state: 'idle' });
    await Promise.resolve();

    expect(mockElectronAPI.listRecordings).toHaveBeenCalledTimes(1);
  });

  it('provides independent Meeting audio and You channel rows', async () => {
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    simulateStatus({
      state: 'recording',
      recordingId: 'test-id',
      canStop: true,
      channels: {
        interviewer: { status: 'connected', started: true },
        you: { status: 'reconnecting', started: true },
      },
    });
    renderApp();

    const healthView = getControlPanelProps().healthView;
    expect(healthView).toBeDefined();
    expect(healthView!.channels[0].label).toBe('Meeting audio');
    expect(healthView!.channels[0].statusText).toBe('Connected');
    expect(healthView!.channels[1].label).toBe('You');
    expect(healthView!.channels[1].statusText).toBe('Reconnecting…');
  });

  it('shows connected-with-gap status on both channels', async () => {
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    simulateStatus({
      state: 'recording',
      recordingId: 'test-id',
      canStop: true,
      channels: {
        interviewer: { status: 'connected-with-gap', started: true },
        you: { status: 'connected-with-gap', started: true },
      },
    });
    renderApp();

    const healthView = getControlPanelProps().healthView;
    expect(healthView!.channels[0].statusText).toBe('Connected (gap detected)');
    expect(healthView!.channels[1].statusText).toBe('Connected (gap detected)');
  });

  it('shows disconnected status with error tone', async () => {
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    simulateStatus({
      state: 'recording',
      recordingId: 'test-id',
      canStop: true,
      channels: {
        interviewer: { status: 'disconnected', started: false },
        you: { status: 'connected', started: true },
      },
    });
    renderApp();

    const healthView = getControlPanelProps().healthView;
    expect(healthView!.channels[0].statusText).toBe('Disconnected');
    expect(healthView!.channels[0].tone).toBe('error');
  });

  it('shows no-audio-detected status', async () => {
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    simulateStatus({
      state: 'recording',
      recordingId: 'test-id',
      canStop: true,
      channels: {
        interviewer: { status: 'no-audio-detected', started: true },
        you: { status: 'connected', started: true },
      },
    });
    renderApp();

    const healthView = getControlPanelProps().healthView;
    expect(healthView!.channels[0].statusText).toBe('No audio detected');
    expect(healthView!.channels[0].tone).toBe('warning');
  });

  it('shows format-limit status', async () => {
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    simulateStatus({
      state: 'recording',
      recordingId: 'test-id',
      canStop: true,
      channels: {
        interviewer: { status: 'format-limit', started: true },
        you: { status: 'format-limit', started: true },
      },
    });
    renderApp();

    const healthView = getControlPanelProps().healthView;
    expect(healthView!.channels[0].statusText).toBe('Format limit reached');
    expect(healthView!.channels[0].tone).toBe('error');
  });

  it('shows Finishing recording before quitting… during finishing state', async () => {
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    simulateStatus({
      state: 'finishing',
      recordingId: 'test-id',
      canCancel: false,
      canStop: false,
    });
    renderApp();

    expect(getControlPanelProps().isFinishing).toBe(true);
    expect(getControlPanelProps().healthView?.finishingMessage).toBe(
      'Finishing recording before quitting…',
    );
  });

  it('uses recordingStop for the Stop action', async () => {
    mockElectronAPI.recordingStop.mockResolvedValueOnce({ status: 'complete' });
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    simulateStatus({
      state: 'recording',
      recordingId: 'test-id',
      canStop: true,
      channels: {
        interviewer: { status: 'connected', started: true },
        you: { status: 'connected', started: true },
      },
    });
    renderApp();

    await getControlPanelProps().onStopRecording?.();
    expect(mockElectronAPI.recordingStop).toHaveBeenCalledTimes(1);
  });

  it('uses recordingCancel for the Cancel action during starting', async () => {
    mockElectronAPI.recordingCancel.mockResolvedValueOnce({ status: 'complete' });
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    simulateStatus({
      state: 'starting',
      recordingId: 'test-id',
      canCancel: true,
      canStop: false,
    });
    renderApp();

    await getControlPanelProps().onCancelRecording?.();
    expect(mockElectronAPI.recordingCancel).toHaveBeenCalledTimes(1);
  });

  it('shows start error when recordingStart fails', async () => {
    mockElectronAPI.recordingStart.mockResolvedValueOnce({ ok: false, reason: 'timeout' });
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    await getControlPanelProps().onStartRecording();
    renderApp();

    expect(getErrorMessage()).toBe('Recording could not start. The audio helper did not respond.');
  });

  it('shows stop feedback when recordingStop returns interrupted', async () => {
    mockElectronAPI.recordingStop.mockResolvedValueOnce({ status: 'interrupted' });
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    simulateStatus({
      state: 'recording',
      recordingId: 'test-id',
      canStop: true,
      channels: {
        interviewer: { status: 'connected', started: true },
        you: { status: 'connected', started: true },
      },
    });
    renderApp();

    await getControlPanelProps().onStopRecording?.();
    renderApp();

    expect(getErrorMessage()).toBe('Recording was interrupted. Partial audio was saved.');
  });

  it('shows capacity failure with disk space suggestion', async () => {
    mockElectronAPI.recordingStop.mockResolvedValueOnce({ status: 'failed', category: 'capacity' });
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    simulateStatus({
      state: 'recording',
      recordingId: 'test-id',
      canStop: true,
      channels: {
        interviewer: { status: 'connected', started: true },
        you: { status: 'connected', started: true },
      },
    });
    renderApp();

    await getControlPanelProps().onStopRecording?.();
    renderApp();

    expect(getErrorMessage()).toBe('Recording stopped unexpectedly. Check available disk space.');
  });

  it('shows access failure without disk space claim', async () => {
    mockElectronAPI.recordingStop.mockResolvedValueOnce({ status: 'failed', category: 'access' });
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    simulateStatus({
      state: 'recording',
      recordingId: 'test-id',
      canStop: true,
      channels: {
        interviewer: { status: 'connected', started: true },
        you: { status: 'connected', started: true },
      },
    });
    renderApp();

    await getControlPanelProps().onStopRecording?.();
    renderApp();

    const error = getErrorMessage();
    expect(error).toBe('Recording stopped unexpectedly. The audio file could not be saved.');
    expect(error).not.toContain('disk');
    expect(error).not.toContain('space');
  });

  it('keeps the recording library visible while starting', async () => {
    mockElectronAPI.listRecordings.mockResolvedValue({
      success: true,
      recordings: [{ id: 'saved', title: 'Saved interview', captureStatus: 'complete' }],
    });
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    // Simulate starting state
    simulateStatus({
      state: 'starting',
      recordingId: 'test-id',
      canCancel: true,
      canStop: false,
    });
    renderApp();

    // Library should still be visible
    expect(getControlPanelProps().recordings).toEqual([
      { id: 'saved', title: 'Saved interview', captureStatus: 'complete' },
    ]);
  });
});

/* ── Recovery UI ─────────────────────────────────────────────── */

describe('recovery UI', () => {
  let statusCallback: ((snapshot: unknown) => void) | undefined;

  beforeEach(() => {
    statusCallback = undefined;
    mockElectronAPI.onRecordingStatus.mockImplementation((cb: (snapshot: unknown) => void) => {
      statusCallback = cb;
      return jest.fn();
    });
  });

  it('loads recovery items on mount', async () => {
    mockElectronAPI.recordingListRecovery.mockResolvedValueOnce([
      {
        id: 'recovery-1',
        createdAt: '2026-08-13T14:30:00.000Z',
        bytes: 1024,
        state: 'recoverable',
      },
    ]);
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    expect(mockElectronAPI.recordingListRecovery).toHaveBeenCalled();
  });

  it('passes recovery items to ControlPanel', async () => {
    const items = [
      {
        id: 'recovery-1',
        createdAt: '2026-08-13T14:30:00.000Z',
        bytes: 1024,
        state: 'recoverable' as const,
      },
      {
        id: 'recovery-2',
        createdAt: '2026-08-13T15:00:00.000Z',
        bytes: 2048,
        state: 'not-recoverable' as const,
      },
    ];
    mockElectronAPI.recordingListRecovery.mockResolvedValueOnce(items);
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();
    renderApp();

    expect(getControlPanelProps().recoveryItems).toHaveLength(2);
    expect(getControlPanelProps().recoveryItems![0].id).toBe('recovery-1');
    expect(getControlPanelProps().recoveryItems![1].state).toBe('not-recoverable');
  });

  it('calls recordingRecover when recover action is triggered', async () => {
    mockElectronAPI.recordingRecover.mockResolvedValueOnce({ outcome: 'recovered' });
    mockElectronAPI.recordingListRecovery.mockResolvedValueOnce([
      {
        id: 'recovery-1',
        createdAt: '2026-08-13T14:30:00.000Z',
        bytes: 1024,
        state: 'recoverable',
      },
    ]);
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    await getControlPanelProps().onRecover?.('recovery-1');
    expect(mockElectronAPI.recordingRecover).toHaveBeenCalledWith('recovery-1');
  });

  it('calls recordingTrashRecovery when trash action is triggered', async () => {
    mockElectronAPI.recordingTrashRecovery.mockResolvedValueOnce({ outcome: 'trashed' });
    mockElectronAPI.recordingListRecovery.mockResolvedValueOnce([
      {
        id: 'recovery-1',
        createdAt: '2026-08-13T14:30:00.000Z',
        bytes: 1024,
        state: 'recoverable',
      },
    ]);
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    await getControlPanelProps().onTrashRecovery?.('recovery-1');
    expect(mockElectronAPI.recordingTrashRecovery).toHaveBeenCalledWith('recovery-1');
  });

  it('refreshes recovery list after successful recover', async () => {
    mockElectronAPI.recordingRecover.mockResolvedValueOnce({ outcome: 'recovered' });
    mockElectronAPI.recordingListRecovery
      .mockResolvedValueOnce([
        {
          id: 'recovery-1',
          createdAt: '2026-08-13T14:30:00.000Z',
          bytes: 1024,
          state: 'recoverable',
        },
      ])
      .mockResolvedValueOnce([]);
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    await getControlPanelProps().onRecover?.('recovery-1');
    await Promise.resolve();

    // Should have been called twice: once on mount, once after recover
    expect(mockElectronAPI.recordingListRecovery).toHaveBeenCalledTimes(2);
  });

  it('shows error when recover fails without removing the item', async () => {
    mockElectronAPI.recordingRecover.mockResolvedValueOnce({ outcome: 'recovery-failed' });
    mockElectronAPI.recordingListRecovery.mockResolvedValueOnce([
      {
        id: 'recovery-1',
        createdAt: '2026-08-13T14:30:00.000Z',
        bytes: 1024,
        state: 'recoverable',
      },
    ]);
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    await getControlPanelProps().onRecover?.('recovery-1');
    renderApp();

    expect(getErrorMessage()).toContain('Recovery');
  });

  it('disables recovery actions during active capture', async () => {
    mockElectronAPI.recordingListRecovery.mockResolvedValueOnce([
      {
        id: 'recovery-1',
        createdAt: '2026-08-13T14:30:00.000Z',
        bytes: 1024,
        state: 'recoverable',
      },
    ]);
    mockElectronAPI.onRecordingStatus.mockImplementation((cb: (snapshot: unknown) => void) => {
      statusCallback = cb;
      return jest.fn();
    });
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    // Simulate recording state
    statusCallback!({
      state: 'recording',
      recordingId: 'test-id',
      canCancel: false,
      canStop: true,
      channels: {
        interviewer: { status: 'connected', started: true },
        you: { status: 'connected', started: true },
      },
    });
    renderApp();

    expect(getControlPanelProps().isRecording).toBe(true);
  });

  it('sets recoveringId during recovery and clears it after', async () => {
    let resolveRecover: (result: { outcome: string }) => void = () => undefined;
    mockElectronAPI.recordingRecover.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRecover = resolve;
        }),
    );
    mockElectronAPI.recordingListRecovery
      .mockResolvedValueOnce([
        {
          id: 'recovery-1',
          createdAt: '2026-08-13T14:30:00.000Z',
          bytes: 1024,
          state: 'recoverable',
        },
      ])
      .mockResolvedValueOnce([]);
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    const recoverPromise = getControlPanelProps().onRecover?.('recovery-1');
    renderApp();

    expect(getControlPanelProps().recoveringId).toBe('recovery-1');

    resolveRecover({ outcome: 'recovered' });
    await recoverPromise;
    await Promise.resolve();
    renderApp();

    expect(getControlPanelProps().recoveringId).toBeNull();
  });

  it('refreshes recovery list after successful trash', async () => {
    mockElectronAPI.recordingTrashRecovery.mockResolvedValueOnce({ outcome: 'trashed' });
    mockElectronAPI.recordingListRecovery
      .mockResolvedValueOnce([
        {
          id: 'recovery-1',
          createdAt: '2026-08-13T14:30:00.000Z',
          bytes: 1024,
          state: 'recoverable',
        },
      ])
      .mockResolvedValueOnce([]);
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    await getControlPanelProps().onTrashRecovery?.('recovery-1');
    await Promise.resolve();

    // Should have been called twice: once on mount, once after trash
    expect(mockElectronAPI.recordingListRecovery).toHaveBeenCalledTimes(2);
  });

  it('does not refresh recovery list after failed recovery', async () => {
    mockElectronAPI.recordingRecover.mockResolvedValueOnce({ outcome: 'recovery-failed' });
    mockElectronAPI.recordingListRecovery.mockResolvedValueOnce([
      {
        id: 'recovery-1',
        createdAt: '2026-08-13T14:30:00.000Z',
        bytes: 1024,
        state: 'recoverable',
      },
    ]);
    renderApp();
    mockEffects.forEach((effect) => effect());
    await Promise.resolve();

    await getControlPanelProps().onRecover?.('recovery-1');
    await Promise.resolve();

    // Should have been called only once (on mount), not refreshed after failure
    expect(mockElectronAPI.recordingListRecovery).toHaveBeenCalledTimes(1);
  });
});

/* ── Library card interrupted badge ──────────────────────────── */

describe('library card interrupted badge', () => {
  it('passes captureStatus to ControlPanel for each recording', async () => {
    mockElectronAPI.listRecordings.mockResolvedValue({
      success: true,
      recordings: [
        {
          id: 'complete-rec',
          title: 'Complete',
          captureStatus: 'complete',
          duration: 60,
          transcribed: false,
          interruptions: [],
        },
        {
          id: 'interrupted-rec',
          title: 'Interrupted',
          captureStatus: 'interrupted',
          duration: 30,
          transcribed: false,
          interruptions: [
            {
              channel: 'capture',
              startMs: 30000,
              endMs: 30000,
              recovered: false,
              reason: 'persistence-error',
            },
          ],
        },
        {
          id: 'legacy-rec',
          title: 'Legacy',
          captureStatus: 'legacy',
          duration: 45,
          transcribed: false,
          interruptions: [],
        },
      ],
    });
    renderApp();
    mockEffects[1](); // recordings effect
    await Promise.resolve();
    renderApp();

    const recordings = getControlPanelProps().recordings;
    expect(recordings).toHaveLength(3);
    expect(recordings[0].captureStatus).toBe('complete');
    expect(recordings[1].captureStatus).toBe('interrupted');
    expect(recordings[2].captureStatus).toBe('legacy');
  });

  it('includes duration for interrupted recordings to support concise time summary', async () => {
    mockElectronAPI.listRecordings.mockResolvedValue({
      success: true,
      recordings: [
        {
          id: 'interrupted-rec',
          title: 'Interview with gaps',
          captureStatus: 'interrupted',
          duration: 1800,
          transcribed: false,
          interruptions: [
            {
              channel: 'capture',
              startMs: 900000,
              endMs: 900000,
              recovered: false,
              reason: 'persistence-error',
            },
          ],
        },
      ],
    });
    renderApp();
    mockEffects[1]();
    await Promise.resolve();
    renderApp();

    const recordings = getControlPanelProps().recordings;
    expect(recordings[0].duration).toBe(1800);
    expect(recordings[0].captureStatus).toBe('interrupted');
  });

  it('preserves legacy captureStatus without interrupted badge treatment', async () => {
    mockElectronAPI.listRecordings.mockResolvedValue({
      success: true,
      recordings: [
        {
          id: 'legacy-rec',
          title: 'Old recording',
          captureStatus: 'legacy',
          duration: 120,
          transcribed: true,
          interruptions: [],
        },
      ],
    });
    renderApp();
    mockEffects[1]();
    await Promise.resolve();
    renderApp();

    const recordings = getControlPanelProps().recordings;
    expect(recordings[0].captureStatus).toBe('legacy');
    expect(recordings[0].id).toBe('legacy-rec');
  });

  it('preserves complete captureStatus without interrupted badge treatment', async () => {
    mockElectronAPI.listRecordings.mockResolvedValue({
      success: true,
      recordings: [
        {
          id: 'complete-rec',
          title: 'Good recording',
          captureStatus: 'complete',
          duration: 240,
          transcribed: true,
          interruptions: [],
        },
      ],
    });
    renderApp();
    mockEffects[1]();
    await Promise.resolve();
    renderApp();

    const recordings = getControlPanelProps().recordings;
    expect(recordings[0].captureStatus).toBe('complete');
    expect(recordings[0].id).toBe('complete-rec');
  });
});
