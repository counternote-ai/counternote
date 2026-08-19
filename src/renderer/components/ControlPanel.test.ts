const mockStateValues: unknown[] = [];
let mockStateCursor = 0;

interface MockElement {
  type: unknown;
  props: Record<string, unknown>;
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

const mockComponent = (): null => null;

jest.mock('react', () => ({
  __esModule: true,
  default: { createElement: mockCreateElement },
  useCallback: <T>(callback: T): T => callback,
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

jest.mock('./ui/badge', () => ({ Badge: mockComponent }));
jest.mock('./ui/alert', () => ({ Alert: mockComponent, AlertDescription: mockComponent }));
jest.mock('./ui/button', () => ({
  Button: function MockButton() {
    return null;
  },
}));
jest.mock('./ui/card', () => ({ Card: mockComponent, CardContent: mockComponent }));
jest.mock('./ui/scroll-area', () => ({ ScrollArea: mockComponent }));
jest.mock('./ui/tooltip', () => ({
  Tooltip: mockComponent,
  TooltipContent: mockComponent,
  TooltipProvider: mockComponent,
  TooltipTrigger: mockComponent,
}));
jest.mock('lucide-react', () => ({
  FileText: mockComponent,
  LoaderCircle: mockComponent,
  Mic: mockComponent,
  Plus: mockComponent,
  Settings: mockComponent,
  Square: mockComponent,
  X: mockComponent,
}));
jest.mock('./RecordingHealth', () => ({ RecordingHealth: mockComponent }));
jest.mock('./RecordingRecovery', () => ({ RecordingRecovery: mockComponent }));

const ControlPanel = require('./ControlPanel')
  .ControlPanel as typeof import('./ControlPanel').ControlPanel;
const { Button } = require('./ui/button') as { Button: unknown };

interface RecordingRow {
  id: string;
  title: string;
  duration: number;
  transcribed: boolean;
  captureStatus?: 'legacy' | 'complete' | 'interrupted';
}

function makeProps(recordings: RecordingRow[]) {
  return {
    recordings,
    onStartRecording: jest.fn(),
    onStopRecording: jest.fn(),
    onTranscribe: jest.fn(),
    onSelectRecording: jest.fn(),
    onOpenSettings: jest.fn(),
    isRecording: false,
    onOpenPermissionSettings: jest.fn(),
    onDismissPermissionNotice: jest.fn(),
  };
}

function collectElements(node: unknown, type: unknown, out: MockElement[] = []): MockElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, type, out);
    return out;
  }
  if (node && typeof node === 'object' && 'type' in node && 'props' in node) {
    const element = node as MockElement;
    if (element.type === type) out.push(element);
    collectElements(element.props?.children, type, out);
  }
  return out;
}

function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (node && typeof node === 'object' && 'props' in node) {
    return textOf((node as MockElement).props?.children);
  }
  return '';
}

function transcribeButtons(tree: MockElement): MockElement[] {
  return collectElements(tree, Button).filter((button) =>
    textOf(button.props.children).includes('Transcribe audio'),
  );
}

describe('ControlPanel recording rows', () => {
  it('offers transcription for an interrupted recording', () => {
    const props = makeProps([
      {
        id: 'rec-1',
        title: 'Interview — 18 Aug',
        duration: 30,
        transcribed: false,
        captureStatus: 'interrupted',
      },
    ]);
    const tree = ControlPanel(props) as unknown as MockElement;

    const buttons = transcribeButtons(tree);
    expect(buttons).toHaveLength(1);
    (buttons[0].props.onClick as () => void)();
    expect(props.onTranscribe).toHaveBeenCalledWith('rec-1');
    expect(textOf(tree)).toContain('Interrupted');
    expect(textOf(tree)).toContain('saved audio can still be transcribed');
  });

  it('keeps transcription available for complete and legacy recordings', () => {
    const props = makeProps([
      { id: 'rec-1', title: 'A', duration: 10, transcribed: false, captureStatus: 'complete' },
      { id: 'rec-2', title: 'B', duration: 20, transcribed: false, captureStatus: 'legacy' },
    ]);
    const tree = ControlPanel(props) as unknown as MockElement;

    const buttons = transcribeButtons(tree);
    expect(buttons).toHaveLength(2);
    (buttons[0].props.onClick as () => void)();
    (buttons[1].props.onClick as () => void)();
    expect(props.onTranscribe).toHaveBeenNthCalledWith(1, 'rec-1');
    expect(props.onTranscribe).toHaveBeenNthCalledWith(2, 'rec-2');
  });

  it('hides the transcribe action once a transcript exists', () => {
    const props = makeProps([
      { id: 'rec-1', title: 'A', duration: 10, transcribed: true, captureStatus: 'interrupted' },
    ]);
    const tree = ControlPanel(props) as unknown as MockElement;

    expect(transcribeButtons(tree)).toHaveLength(0);
    expect(textOf(tree)).toContain('Interrupted');
  });
});
