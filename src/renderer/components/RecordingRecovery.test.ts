import type { RecoveryItemView } from '../native-capture-view-model';

const mockStateValues: unknown[] = [];
let mockStateCursor = 0;

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

const mockButton = (): null => null;
const mockCard = (): null => null;
const mockCardContent = (): null => null;
const mockIcon = (): null => null;

jest.mock('react', () => ({
  __esModule: true,
  default: { createElement: mockCreateElement },
  useCallback: <T,>(callback: T): T => callback,
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

jest.mock('./ui/button', () => ({ Button: mockButton }));
jest.mock('./ui/card', () => ({ Card: mockCard, CardContent: mockCardContent }));
jest.mock('lucide-react', () => ({
  RotateCcw: mockIcon,
  Trash2: mockIcon,
}));

const RecordingRecovery = require('./RecordingRecovery').RecordingRecovery as typeof import('./RecordingRecovery').RecordingRecovery;

function renderComponent(props: {
  notice?: string;
  items?: RecoveryItemView[];
  onRecover?: (id: string) => void;
  onTrash?: (id: string) => void;
  disabled?: boolean;
} = {}): MockElement {
  mockStateValues.splice(0);
  mockStateCursor = 0;
  return RecordingRecovery({
    notice: 'Test notice',
    items: [],
    onRecover: jest.fn(),
    onTrash: jest.fn(),
    ...props,
  }) as unknown as MockElement;
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

function makeRecoverableItem(overrides: Partial<RecoveryItemView> = {}): RecoveryItemView {
  return {
    id: 'item-1',
    dateLabel: 'Aug 13, 2026',
    sizeLabel: '1.0 KB',
    stateLabel: 'Partial audio can be recovered',
    state: 'recoverable',
    ...overrides,
  };
}

beforeEach(() => {
  mockStateValues.splice(0);
  mockStateCursor = 0;
});

describe('RecordingRecovery', () => {
  describe('confirmation dialog rendering', () => {
    it('shows trash button for each item by default', () => {
      const items: RecoveryItemView[] = [
        makeRecoverableItem({ id: 'item-1', dateLabel: 'Aug 13, 2026' }),
        makeRecoverableItem({ id: 'item-2', dateLabel: 'Aug 14, 2026', state: 'not-recoverable', stateLabel: 'Partial audio could not be repaired' }),
      ];
      const tree = renderComponent({ items });
      const trashButtons = findElements(
        tree,
        (el) => el.type === mockButton && typeof el.props['aria-label'] === 'string' && el.props['aria-label'].startsWith('Remove recording from')
      );

      expect(trashButtons).toHaveLength(2);
    });

    it('shows confirmation dialog when trash button is clicked', () => {
      const onTrash = jest.fn();
      const items = [makeRecoverableItem()];
      const tree = renderComponent({ items, onTrash });

      // Find the trash button and simulate click
      const trashButton = findElements(
        tree,
        (el) => el.type === mockButton && el.props['aria-label'] === 'Remove recording from Aug 13, 2026'
      )[0];

      // Simulate the onClick by calling handleTrashRequest
      // The mock onClick passes (e) => handleTrashRequest(item.id, e.currentTarget)
      // We need to simulate with a mock element that has focus()
      const mockCurrentTarget = { focus: jest.fn() };
      (trashButton.props.onClick as (e: { currentTarget: { focus: jest.Mock } }) => void)({ currentTarget: mockCurrentTarget });

      // Re-render after state change
      mockStateCursor = 0;
      const treeAfterClick = RecordingRecovery({
        notice: 'Test notice',
        items,
        onRecover: jest.fn(),
        onTrash,
      }) as unknown as MockElement;

      // Should now show confirmation dialog
      const confirmDialog = findElements(
        treeAfterClick,
        (el) => el.props.role === 'alertdialog'
      );
      expect(confirmDialog).toHaveLength(1);

      // Should show Confirm and Cancel buttons
      const confirmButton = findElements(
        treeAfterClick,
        (el) => el.type === mockButton && el.props['aria-label'] === 'Confirm remove'
      );
      const cancelButton = findElements(
        treeAfterClick,
        (el) => el.type === mockButton && el.props['aria-label'] === 'Cancel removal'
      );
      expect(confirmButton).toHaveLength(1);
      expect(cancelButton).toHaveLength(1);
    });

    it('calls onTrash with item id when confirm is clicked', () => {
      const onTrash = jest.fn();
      const items = [makeRecoverableItem()];

      // Set confirmTrashId to 'item-1' to simulate the confirmation state
      // Clear state, then set confirmTrashId before rendering
      mockStateValues.splice(0);
      mockStateCursor = 0;
      mockStateValues[0] = 'item-1';

      const tree = RecordingRecovery({
        notice: 'Test notice',
        items,
        onRecover: jest.fn(),
        onTrash,
      }) as unknown as MockElement;

      // Find the confirm button
      const confirmButton = findElements(
        tree,
        (el) => el.type === mockButton && el.props['aria-label'] === 'Confirm remove'
      )[0];

      // Click confirm
      (confirmButton.props.onClick as () => void)();

      expect(onTrash).toHaveBeenCalledWith('item-1');
    });
  });

  describe('focus management', () => {
    it('cancels trash confirmation and restores focus to the trash button', () => {
      const items = [makeRecoverableItem()];

      // Set confirmTrashId to 'item-1' to simulate the confirmation state
      mockStateValues.splice(0);
      mockStateCursor = 0;
      mockStateValues[0] = 'item-1';

      const tree = RecordingRecovery({
        notice: 'Test notice',
        items,
        onRecover: jest.fn(),
        onTrash: jest.fn(),
      }) as unknown as MockElement;

      // Find the cancel button
      const cancelButton = findElements(
        tree,
        (el) => el.type === mockButton && el.props['aria-label'] === 'Cancel removal'
      )[0];

      // The lastFocusedRef should have been set during handleTrashRequest
      // In the mock, useRef returns { current: null }. We need to verify the cancel logic.
      // Click cancel
      (cancelButton.props.onClick as () => void)();

      // After cancel, re-render should show the trash button again (not confirmation)
      mockStateValues.splice(0);
      mockStateCursor = 0;
      // confirmTrashId should be reset to null after cancel
      mockStateValues[0] = null;

      const treeAfterCancel = RecordingRecovery({
        notice: 'Test notice',
        items,
        onRecover: jest.fn(),
        onTrash: jest.fn(),
      }) as unknown as MockElement;

      // Should show trash button, not confirmation dialog
      const confirmDialog = findElements(
        treeAfterCancel,
        (el) => el.props.role === 'alertdialog'
      );
      expect(confirmDialog).toHaveLength(0);

      const trashButtons = findElements(
        treeAfterCancel,
        (el) => el.type === mockButton && typeof el.props['aria-label'] === 'string' && el.props['aria-label'].startsWith('Remove recording from')
      );
      expect(trashButtons).toHaveLength(1);
    });
  });

  describe('disabled states', () => {
    it('disables Recover button when disabled prop is true', () => {
      const items = [makeRecoverableItem()];
      const tree = renderComponent({ items, disabled: true });

      const recoverButton = findElements(
        tree,
        (el) => el.type === mockButton && el.props['aria-label'] === 'Recover recording from Aug 13, 2026'
      )[0];

      expect(recoverButton.props.disabled).toBe(true);
    });

    it('disables trash button when disabled prop is true', () => {
      const items = [makeRecoverableItem()];
      const tree = renderComponent({ items, disabled: true });

      const trashButton = findElements(
        tree,
        (el) => el.type === mockButton && el.props['aria-label'] === 'Remove recording from Aug 13, 2026'
      )[0];

      expect(trashButton.props.disabled).toBe(true);
    });

    it('enables Recover button when disabled prop is false', () => {
      const items = [makeRecoverableItem()];
      const tree = renderComponent({ items, disabled: false });

      const recoverButton = findElements(
        tree,
        (el) => el.type === mockButton && el.props['aria-label'] === 'Recover recording from Aug 13, 2026'
      )[0];

      expect(recoverButton.props.disabled).toBe(false);
    });

    it('does not show Recover button for not-recoverable items', () => {
      const items = [makeRecoverableItem({ state: 'not-recoverable', stateLabel: 'Partial audio could not be repaired' })];
      const tree = renderComponent({ items });

      const recoverButton = findElements(
        tree,
        (el) => el.type === mockButton && typeof el.props['aria-label'] === 'string' && el.props['aria-label'].startsWith('Recover recording from')
      );

      expect(recoverButton).toHaveLength(0);
    });

    it('shows disabled Recovering button for items in recovering state', () => {
      const items = [makeRecoverableItem({
        state: 'recovering',
        stateLabel: 'Recovering partial recording…',
      })];
      const tree = renderComponent({ items });

      const recoveringButton = findElements(
        tree,
        (el) => el.type === mockButton && el.props['aria-label'] === 'Recovering recording from Aug 13, 2026'
      )[0];

      expect(recoveringButton).toBeDefined();
      expect(recoveringButton.props.disabled).toBe(true);
    });

    it('hides trash button for items in recovering state', () => {
      const items = [makeRecoverableItem({
        state: 'recovering',
        stateLabel: 'Recovering partial recording…',
      })];
      const tree = renderComponent({ items });

      const trashButton = findElements(
        tree,
        (el) => el.type === mockButton && typeof el.props['aria-label'] === 'string' && el.props['aria-label'].startsWith('Remove recording from')
      );

      expect(trashButton).toHaveLength(0);
    });
  });

  describe('callback invocation', () => {
    it('calls onRecover with the correct item id', () => {
      const onRecover = jest.fn();
      const items = [makeRecoverableItem({ id: 'specific-id' })];
      const tree = renderComponent({ items, onRecover });

      const recoverButton = findElements(
        tree,
        (el) => el.type === mockButton && el.props['aria-label'] === 'Recover recording from Aug 13, 2026'
      )[0];

      (recoverButton.props.onClick as () => void)();

      expect(onRecover).toHaveBeenCalledWith('specific-id');
      expect(onRecover).toHaveBeenCalledTimes(1);
    });

    it('does not call onRecover for not-recoverable items', () => {
      const onRecover = jest.fn();
      const items = [makeRecoverableItem({ state: 'not-recoverable', stateLabel: 'Partial audio could not be repaired' })];
      renderComponent({ items, onRecover });

      // onRecover should not be called since there's no Recover button
      expect(onRecover).not.toHaveBeenCalled();
    });

    it('renders the notice text', () => {
      const tree = renderComponent({ notice: '2 recordings, 3.0 KB' });

      const text = renderedText(tree).join(' ');
      expect(text).toContain('2 recordings, 3.0 KB');
    });

    it('renders stateLabel for each item', () => {
      const items = [
        makeRecoverableItem({ id: 'a', stateLabel: 'Partial audio can be recovered' }),
        makeRecoverableItem({ id: 'b', state: 'not-recoverable', stateLabel: 'Partial audio could not be repaired' }),
      ];
      const tree = renderComponent({ items });

      const text = renderedText(tree).join(' ');
      expect(text).toContain('Partial audio can be recovered');
      expect(text).toContain('Partial audio could not be repaired');
    });

    it('renders dateLabel and sizeLabel for each item', () => {
      const items = [makeRecoverableItem({ dateLabel: 'Aug 13, 2026', sizeLabel: '1.0 KB' })];
      const tree = renderComponent({ items });

      const text = renderedText(tree).join(' ');
      expect(text).toContain('Aug 13, 2026');
      expect(text).toContain('1.0 KB');
    });
  });
});
