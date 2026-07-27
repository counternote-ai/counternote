import {
  getTranscriptionErrorMessage,
  getTranscriptionStageLabel,
} from './transcription-ui';

interface MockElement {
  type: unknown;
  props: Record<string, unknown>;
}

const mockCreateElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): MockElement => ({
  type,
  props: {
    ...props,
    ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
  },
});
const mockIcon = (): null => null;
const mockBadge = (): null => null;
const mockAlert = (): null => null;
const mockAlertDescription = (): null => null;
const mockButton = (): null => null;
const mockCard = (): null => null;
const mockCardContent = (): null => null;
const mockScrollArea = (): null => null;
const mockTooltip = (): null => null;
const mockTooltipContent = (): null => null;
const mockTooltipProvider = (): null => null;
const mockTooltipTrigger = (): null => null;

jest.mock('react', () => ({ __esModule: true, default: { createElement: mockCreateElement } }));
jest.mock('lucide-react', () => ({
  FileText: mockIcon,
  LoaderCircle: mockIcon,
  Mic: mockIcon,
  Plus: mockIcon,
  Settings: mockIcon,
  Square: mockIcon,
}));
jest.mock('./components/ui/badge', () => ({ Badge: mockBadge }));
jest.mock('./components/ui/alert', () => ({ Alert: mockAlert, AlertDescription: mockAlertDescription }));
jest.mock('./components/ui/button', () => ({ Button: mockButton }));
jest.mock('./components/ui/card', () => ({ Card: mockCard, CardContent: mockCardContent }));
jest.mock('./components/ui/scroll-area', () => ({ ScrollArea: mockScrollArea }));
jest.mock('./components/ui/tooltip', () => ({
  Tooltip: mockTooltip,
  TooltipContent: mockTooltipContent,
  TooltipProvider: mockTooltipProvider,
  TooltipTrigger: mockTooltipTrigger,
}));

const ControlPanel = require('./components/ControlPanel').ControlPanel as typeof import('./components/ControlPanel').ControlPanel;

function findElements(value: unknown, predicate: (element: MockElement) => boolean): MockElement[] {
  if (typeof value !== 'object' || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((child) => findElements(child, predicate));

  const element = value as MockElement;
  const matches = predicate(element) ? [element] : [];
  return matches.concat(findElements(element.props.children, predicate));
}

function renderedText(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object' || value === null) return [];
  if (Array.isArray(value)) return value.flatMap(renderedText);
  return renderedText((value as MockElement).props.children);
}

function renderControlPanel(overrides: Partial<Parameters<typeof ControlPanel>[0]> = {}): MockElement {
  return ControlPanel({
    recordings: [
      { id: 'active-recording', title: 'Active interview', duration: 60, transcribed: false },
      { id: 'ready-recording', title: 'Ready interview', duration: 90, transcribed: true },
    ],
    onStartRecording: jest.fn(),
    onStopRecording: jest.fn(),
    onTranscribe: jest.fn(),
    onSelectRecording: jest.fn(),
    onOpenSettings: jest.fn(),
    onOpenPermissionSettings: jest.fn(),
    onDismissPermissionNotice: jest.fn(),
    isRecording: false,
    ...overrides,
  }) as unknown as MockElement;
}

describe('transcription UI copy', () => {
  it('uses literal progress labels for every transcription stage', () => {
    expect(getTranscriptionStageLabel({ recordingId: 'rec-1', stage: 'preparing-audio' })).toBe('Preparing audio');
    expect(getTranscriptionStageLabel({
      recordingId: 'rec-1',
      stage: 'downloading-model',
      percent: 42,
    })).toBe('Downloading model · 42%');
    expect(getTranscriptionStageLabel({ recordingId: 'rec-1', stage: 'transcribing-interviewer' })).toBe(
      'Transcribing interviewer'
    );
    expect(getTranscriptionStageLabel({ recordingId: 'rec-1', stage: 'transcribing-you' })).toBe('Transcribing you');
    expect(getTranscriptionStageLabel({ recordingId: 'rec-1', stage: 'finishing-transcript' })).toBe(
      'Finishing transcript'
    );
  });

  it.each([
    ['TRANSCRIPTION_BUSY', undefined, 'Another recording is already being transcribed. Wait for it to finish, then try again.'],
    ['LOCAL_UNAVAILABLE', undefined, 'Local transcription could not start. Your recording is still saved. Retry, or select Groq in Settings.'],
    ['MODEL_DOWNLOAD_FAILED', undefined, 'The local model download failed. Your recording is still saved. Check your connection and try again.'],
    ['MODEL_CHECKSUM_FAILED', undefined, 'The local model could not be verified. Your recording is still saved. Try downloading it again.'],
    ['LOCAL_TRANSCRIPTION_FAILED', undefined, 'Local transcription failed. Your recording is still saved. Try again, or select Groq in Settings.'],
    ['LOCAL_TRANSCRIPTION_TIMEOUT', undefined, 'Local transcription stopped responding. Your recording is still saved. Try again, or select Groq in Settings.'],
    ['GROQ_KEY_MISSING', undefined, 'Transcription needs a Groq API key. Your recording is still saved. Add one in Settings, then try again.'],
    ['GROQ_RATE_LIMITED', 1080, "Groq's rate limit was reached. Your recording is still saved. Try again in 18 minutes."],
    ['GROQ_TIMEOUT', undefined, 'Groq transcription timed out. Your recording is still saved. Check your connection and try again.'],
    ['GROQ_REJECTED', undefined, 'Groq could not transcribe this recording. Your recording is still saved. Check Settings and try again.'],
    ['AUDIO_PREPARATION_FAILED', undefined, 'Audio preparation failed. Your recording is still saved. Try again.'],
    ['TRANSCRIPT_WRITE_FAILED', undefined, 'The transcript could not be saved. Your recording is still saved. Try again.'],
  ] as const)('maps %s to safe recovery copy', (code, retryAfterSeconds, expected) => {
    expect(getTranscriptionErrorMessage({ code, retryAfterSeconds })).toBe(expected);
  });

  it('rounds rate-limit recovery up and falls back safely for unknown retry values', () => {
    expect(getTranscriptionErrorMessage({ code: 'GROQ_RATE_LIMITED', retryAfterSeconds: 1.1 })).toBe(
      "Groq's rate limit was reached. Your recording is still saved. Try again in 2 seconds."
    );
    expect(getTranscriptionErrorMessage({ code: 'GROQ_RATE_LIMITED', retryAfterSeconds: 60.1 })).toBe(
      "Groq's rate limit was reached. Your recording is still saved. Try again in 2 minutes."
    );
    expect(getTranscriptionErrorMessage({ code: 'GROQ_RATE_LIMITED', retryAfterSeconds: Number.NaN })).toBe(
      "Groq's rate limit was reached. Your recording is still saved. Try again later."
    );
  });
});

describe('transcription progress cards', () => {
  it('localizes busy progress to the matching recording while a ready transcript stays selectable', () => {
    const onSelectRecording = jest.fn();
    const tree = renderControlPanel({
      onSelectRecording,
      transcriptionProgress: {
        recordingId: 'active-recording',
        stage: 'transcribing-interviewer',
      },
    });
    const cards = findElements(tree, (element) => element.type === mockCard);

    expect(cards[0].props['aria-busy']).toBe(true);
    expect(cards[1].props['aria-busy']).toBeUndefined();
    expect(renderedText(cards[0])).toContain('Transcribing interviewer');

    const readyCardAction = findElements(cards[1], (element) => element.type === 'button')[0];
    expect(readyCardAction.props.disabled).toBe(false);
    (readyCardAction.props.onClick as () => void)();
    expect(onSelectRecording).toHaveBeenCalledWith('ready-recording');
  });

  it.each([
    ['preparing-audio', 'Preparing audio'],
    ['transcribing-interviewer', 'Transcribing interviewer'],
    ['transcribing-you', 'Transcribing you'],
    ['finishing-transcript', 'Finishing transcript'],
  ] as const)('renders %s as %s on the active card', (stage, label) => {
    const tree = renderControlPanel({
      transcriptionProgress: { recordingId: 'active-recording', stage },
    });
    const activeCard = findElements(tree, (element) => element.type === mockCard)[0];

    expect(renderedText(activeCard)).toContain(label);
  });
});
