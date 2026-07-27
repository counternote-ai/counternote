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
  recordings: Array<{ id: string; title: string }>;
  permissionNotice: { tone: string; message: string; settingsPermission?: string } | null;
  localTranscriptionUnavailable?: boolean;
  transcriptionProgress?: { recordingId: string; stage: string } | null;
  onStartRecording: () => Promise<void>;
  onTranscribe: (recordingId: string) => Promise<void>;
  onOpenPermissionSettings: () => Promise<void>;
  onDismissPermissionNotice: () => void;
}

interface MockSettingsProps {
  apiKey: string;
  model: string;
  provider?: 'local' | 'groq';
  onSave: (settings: { apiKey: string; model: string; transcriptionProvider?: 'local' | 'groq' }) => Promise<void>;
}

interface MockTranscriptProps {
  onExport: () => Promise<void>;
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
jest.mock('lucide-react', () => ({
  ChevronLeft: mockIcon,
  Download: mockIcon,
  KeyRound: mockIcon,
  ShieldCheck: mockIcon,
}));

const mockCaptureStart = jest.fn<Promise<void>, []>();
const mockCaptureStop = jest.fn<void, []>();
jest.mock('./audio-capture', () => ({
  AudioCapture: jest.fn().mockImplementation(() => ({
    start: mockCaptureStart,
    stop: mockCaptureStop,
  })),
}));

const App = require('./App').default as typeof import('./App').default;
const ActualSettings = jest.requireActual('./components/Settings').Settings as typeof import('./components/Settings').Settings;

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
  startRecording: jest.fn(),
  onStopRecording: jest.fn(),
  onOpenSettings: jest.fn(),
  onTranscriptionProgress: jest.fn(),
  onLocalModelStatus: jest.fn(),
  getLocalModelStatus: jest.fn(),
  installLocalModel: jest.fn(),
  transcribe: jest.fn(),
  exportTranscript: jest.fn(),
  saveConfig: jest.fn(),
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
  mockElectronAPI.startRecording.mockResolvedValue({ success: true });
  mockElectronAPI.getLocalModelStatus.mockResolvedValue({ state: 'not-downloaded' });
  mockElectronAPI.installLocalModel.mockResolvedValue({ success: true });
  mockElectronAPI.transcribe.mockResolvedValue({ success: true });
  mockElectronAPI.exportTranscript.mockResolvedValue({ success: true });
  mockElectronAPI.saveConfig.mockResolvedValue({ success: true });
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
    expect(mockConsoleError).toHaveBeenCalledWith('Renderer recording start failed.');
    expect(mockConsoleError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: rawCaptureError })
    );
  });

  it('uses storage recovery copy when recording-file creation fails', async () => {
    const rawFileError = 'ENOSPC: no space left on device';
    mockElectronAPI.startRecording.mockRejectedValueOnce(new Error(rawFileError));
    renderApp();

    await getControlPanelProps().onStartRecording();
    renderApp();

    expect(getErrorMessage()).toBe('Unable to create the recording file. Check available disk space and try again.');
    expect(getErrorMessage()).not.toContain('permissions');
    expect(getErrorMessage()).not.toContain(rawFileError);
    expect(mockCaptureStop).toHaveBeenCalledTimes(1);
    expect(mockConsoleError).toHaveBeenCalledWith('Renderer recording file creation failed.');
    expect(mockConsoleError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: rawFileError })
    );
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
    mockStateValues[2] = [{
      id: '2026-07-27T12-00-00-000Z',
      title: 'Saved interview',
      duration: 60,
      transcribed: false,
      audioPath: '/private/recordings/secret/audio.wav',
    }];
    renderApp();

    await getControlPanelProps().onTranscribe('2026-07-27T12-00-00-000Z');

    expect(mockElectronAPI.transcribe).toHaveBeenCalledWith('2026-07-27T12-00-00-000Z');
    expect(mockElectronAPI.transcribe).not.toHaveBeenCalledWith('/private/recordings/secret/audio.wav');
  });

  it('starts a transcription with progress scoped to the selected recording', async () => {
    mockStateValues[2] = [
      { id: 'active-recording', title: 'Active interview', duration: 60, transcribed: false },
      { id: 'other-recording', title: 'Other interview', duration: 60, transcribed: false },
    ];
    let resolveTranscription: (result: { success: true }) => void = () => undefined;
    mockElectronAPI.transcribe.mockImplementationOnce(
      () => new Promise<{ success: true }>((resolve) => { resolveTranscription = resolve; })
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
    mockStateValues[2] = [
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
      'Local transcription stopped responding. Your recording is still saved. Try again, or select Groq in Settings.'
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
    mockStateValues[3] = {
      id: '2026-07-27T12-00-00-000Z',
      title: 'Saved interview',
      duration: 60,
      transcribed: true,
      transcriptPath: '/private/recordings/secret/transcript.json',
    };
    renderApp();

    await getTranscriptProps().onExport();

    expect(mockElectronAPI.exportTranscript).toHaveBeenCalledWith('2026-07-27T12-00-00-000Z', 'txt');
    expect(mockElectronAPI.exportTranscript).not.toHaveBeenCalledWith(
      '/private/recordings/secret/transcript.json',
      'txt'
    );
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
    mockStateValues[7] = { state: 'unavailable', reason: 'sidecar-missing' };
    renderApp();

    expect(getControlPanelProps().localTranscriptionUnavailable).toBe(true);
  });
});

describe('transcription provider settings', () => {
  const renderSettings = (overrides: Partial<ComponentProps<typeof ActualSettings>> = {}): MockElement => {
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

    expect(findElements(tree, (element) => element.type === mockSelect)[0].props.value).toBe('local');
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
    (groqInput.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'preserved-key' } });
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
      (element) => element.type === mockButton && renderedText(element.props.children).includes('Save settings')
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

    expect(findElements(tree, (element) => element.type === mockSelect)[0].props.value).toBe('local');
    expect(text).toContain('Unavailable');
    expect(text).toContain('Local Whisper is unavailable because its sidecar is not installed.');
    expect(text).not.toContain('Groq API Key');
  });

  it('disables only Save settings while the request is pending', async () => {
    let resolveSave: (() => void) | undefined;
    const onSave = jest.fn(() => new Promise<void>((resolve) => {
      resolveSave = resolve;
    }));
    let tree = renderSettings({ onSave });
    let save = findElements(
      tree,
      (element) => element.type === mockButton && renderedText(element.props.children).includes('Save settings')
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
      (element) => element.type === mockButton && renderedText(element.props.children).includes('Save settings')
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
      (element) => element.type === mockButton && renderedText(element.props.children).includes('Download model')
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
