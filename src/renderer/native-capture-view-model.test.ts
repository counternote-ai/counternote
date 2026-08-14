import {
  toChannelHealthView,
  toRecordingHealthView,
  toStartErrorMessage,
  toStopFeedback,
  toRecoveryItemView,
  toRecoveryListView,
  formatBytes,
  formatDate,
} from './native-capture-view-model';

/* ── Channel health mapping ──────────────────────────────────── */

describe('toChannelHealthView', () => {
  it('maps connected status to ok tone with Connected label', () => {
    const view = toChannelHealthView({ status: 'connected', started: true }, 'Interviewer');

    expect(view.label).toBe('Interviewer');
    expect(view.statusText).toBe('Connected');
    expect(view.tone).toBe('ok');
  });

  it('maps connected-with-gap status to warning tone', () => {
    const view = toChannelHealthView({ status: 'connected-with-gap', started: true }, 'You');

    expect(view.label).toBe('You');
    expect(view.statusText).toBe('Connected (gap detected)');
    expect(view.tone).toBe('warning');
  });

  it('maps reconnecting status to warning tone', () => {
    const view = toChannelHealthView({ status: 'reconnecting', started: true }, 'Interviewer');

    expect(view.statusText).toBe('Reconnecting…');
    expect(view.tone).toBe('warning');
  });

  it('maps disconnected status to error tone', () => {
    const view = toChannelHealthView({ status: 'disconnected', started: false }, 'You');

    expect(view.statusText).toBe('Disconnected');
    expect(view.tone).toBe('error');
  });

  it('maps no-audio-detected status to warning tone', () => {
    const view = toChannelHealthView({ status: 'no-audio-detected', started: true }, 'Interviewer');

    expect(view.statusText).toBe('No audio detected');
    expect(view.tone).toBe('warning');
  });

  it('maps format-limit status to error tone', () => {
    const view = toChannelHealthView({ status: 'format-limit', started: true }, 'You');

    expect(view.statusText).toBe('Format limit reached');
    expect(view.tone).toBe('error');
  });

  it('maps idle status to idle tone', () => {
    const view = toChannelHealthView({ status: 'idle', started: false }, 'Interviewer');

    expect(view.statusText).toBe('Waiting');
    expect(view.tone).toBe('idle');
  });

  it('maps helper-exit status to error tone with generic message', () => {
    const view = toChannelHealthView({ status: 'helper-exit', started: true }, 'You');

    expect(view.tone).toBe('error');
    expect(view.statusText).toBe('Connection lost');
  });

  it('provides an aria label combining label and status', () => {
    const view = toChannelHealthView({ status: 'connected', started: true }, 'Interviewer');

    expect(view.ariaLabel).toBe('Interviewer: Connected');
  });
});

/* ── Recording health view ───────────────────────────────────── */

describe('toRecordingHealthView', () => {
  const baseSnapshot = {
    state: 'idle' as const,
    recordingId: undefined,
    canCancel: false,
    canStop: false,
    channels: {
      interviewer: { status: 'idle', started: false },
      you: { status: 'idle', started: false },
    },
  };

  it('maps idle state with no starting message', () => {
    const view = toRecordingHealthView(baseSnapshot);

    expect(view.state).toBe('idle');
    expect(view.startingMessage).toBeNull();
    expect(view.finishingMessage).toBeNull();
  });

  it('maps starting state with starting message and cancel enabled', () => {
    const view = toRecordingHealthView({
      ...baseSnapshot,
      state: 'starting',
      canCancel: true,
    });

    expect(view.state).toBe('starting');
    expect(view.startingMessage).toBe('Starting…');
    expect(view.canCancel).toBe(true);
  });

  it('maps recording state with channel health rows', () => {
    const view = toRecordingHealthView({
      ...baseSnapshot,
      state: 'recording',
      canStop: true,
      channels: {
        interviewer: { status: 'connected', started: true },
        you: { status: 'connected-with-gap', started: true },
      },
    });

    expect(view.state).toBe('recording');
    expect(view.channels[0].statusText).toBe('Connected');
    expect(view.channels[1].statusText).toBe('Connected (gap detected)');
    expect(view.canStop).toBe(true);
  });

  it('maps finishing state with finishing message', () => {
    const view = toRecordingHealthView({
      ...baseSnapshot,
      state: 'finishing',
    });

    expect(view.state).toBe('finishing');
    expect(view.finishingMessage).toBe('Finishing recording before quitting…');
  });

  it('includes an aria summary that describes both channels', () => {
    const view = toRecordingHealthView({
      ...baseSnapshot,
      state: 'recording',
      canStop: true,
      channels: {
        interviewer: { status: 'connected', started: true },
        you: { status: 'disconnected', started: false },
      },
    });

    expect(view.ariaSummary).toContain('Interviewer: Connected');
    expect(view.ariaSummary).toContain('You: Disconnected');
  });

  it('labels channels independently as Interviewer and You', () => {
    const view = toRecordingHealthView({
      ...baseSnapshot,
      state: 'recording',
      canStop: true,
      channels: {
        interviewer: { status: 'connected', started: true },
        you: { status: 'reconnecting', started: true },
      },
    });

    expect(view.channels[0].label).toBe('Interviewer');
    expect(view.channels[1].label).toBe('You');
  });
});

/* ── Start error messages ────────────────────────────────────── */

describe('toStartErrorMessage', () => {
  it('returns null for successful start', () => {
    expect(toStartErrorMessage({ ok: true, recordingId: 'id' })).toBeNull();
  });

  it('returns busy message for busy reason', () => {
    expect(toStartErrorMessage({ ok: false, reason: 'busy' })).toBe(
      'A recording is already in progress.',
    );
  });

  it('returns null for cancelled (user action, not an error)', () => {
    expect(toStartErrorMessage({ ok: false, reason: 'cancelled' })).toBeNull();
  });

  it('returns timeout message without disk space claim', () => {
    const message = toStartErrorMessage({ ok: false, reason: 'timeout' });

    expect(message).toBe('Recording could not start. The audio helper did not respond.');
    expect(message).not.toContain('disk');
    expect(message).not.toContain('space');
  });

  it('returns helper-error message', () => {
    expect(toStartErrorMessage({ ok: false, reason: 'helper-error' })).toBe(
      'Recording could not start. The audio helper encountered an error.',
    );
  });

  it('returns protocol-violation message', () => {
    expect(toStartErrorMessage({ ok: false, reason: 'protocol-violation' })).toBe(
      'Recording could not start. The audio helper sent unexpected data.',
    );
  });

  it('returns persistence-error message with disk space suggestion', () => {
    const message = toStartErrorMessage({ ok: false, reason: 'persistence-error' });

    expect(message).toBe('Recording could not start. Check available disk space.');
  });

  it('returns mutation-unavailable message same as busy', () => {
    expect(toStartErrorMessage({ ok: false, reason: 'mutation-unavailable' })).toBe(
      'A recording is already in progress.',
    );
  });
});

/* ── Stop feedback ───────────────────────────────────────────── */

describe('toStopFeedback', () => {
  it('returns null for complete stop', () => {
    expect(toStopFeedback({ status: 'complete' })).toBeNull();
  });

  it('returns interrupted message', () => {
    expect(toStopFeedback({ status: 'interrupted' })).toBe(
      'Recording was interrupted. Partial audio was saved.',
    );
  });

  it('returns capacity failure with disk space suggestion', () => {
    const feedback = toStopFeedback({ status: 'failed', category: 'capacity' });

    expect(feedback).toBe('Recording stopped unexpectedly. Check available disk space.');
  });

  it('returns access failure without disk space claim', () => {
    const feedback = toStopFeedback({ status: 'failed', category: 'access' });

    expect(feedback).toBe('Recording stopped unexpectedly. The audio file could not be saved.');
    expect(feedback).not.toContain('disk');
    expect(feedback).not.toContain('space');
  });

  it('returns io-finalization failure without disk space claim', () => {
    const feedback = toStopFeedback({ status: 'failed', category: 'io-finalization' });

    expect(feedback).toBe('Recording stopped unexpectedly. The audio file could not be finalized.');
    expect(feedback).not.toContain('disk');
    expect(feedback).not.toContain('space');
  });

  it('returns null for not-active', () => {
    expect(toStopFeedback({ status: 'not-active' })).toBeNull();
  });
});

/* ── Recovery item view ──────────────────────────────────────── */

describe('toRecoveryItemView', () => {
  it('formats a recoverable item with date and size', () => {
    const view = toRecoveryItemView({
      id: '12345678-1234-1234-1234-123456789abc',
      createdAt: '2026-08-13T14:30:00.000Z',
      bytes: 1_048_576,
      state: 'recoverable',
    });

    expect(view.id).toBe('12345678-1234-1234-1234-123456789abc');
    expect(view.state).toBe('recoverable');
    expect(view.stateLabel).toBe('Partial audio can be recovered');
    expect(view.dateLabel).toContain('2026');
    expect(view.sizeLabel).toContain('MB');
  });

  it('formats a not-recoverable item with appropriate copy', () => {
    const view = toRecoveryItemView({
      id: 'abcdef12-3456-7890-abcd-ef1234567890',
      createdAt: '2026-07-01T09:00:00.000Z',
      bytes: 512,
      state: 'not-recoverable',
    });

    expect(view.stateLabel).toBe('Partial audio could not be repaired');
  });

  it('derives the date from createdAt', () => {
    const view = toRecoveryItemView({
      id: '12345678-1234-1234-1234-123456789abc',
      createdAt: '2026-08-13T14:30:00.000Z',
      bytes: 1024,
      state: 'recoverable',
    });

    // The date should be formatted from the ISO string
    expect(view.dateLabel).toBeDefined();
    expect(typeof view.dateLabel).toBe('string');
    expect(view.dateLabel.length).toBeGreaterThan(0);
  });
});

/* ── Recovery list view ──────────────────────────────────────── */

describe('toRecoveryListView', () => {
  it('returns empty notice and items for empty list', () => {
    const view = toRecoveryListView([]);

    expect(view.notice).toBe('No recordings to recover');
    expect(view.items).toEqual([]);
  });

  it('formats singular count for one item', () => {
    const view = toRecoveryListView([
      { id: 'a', createdAt: '2026-08-13T00:00:00.000Z', bytes: 1024, state: 'recoverable' },
    ]);

    expect(view.notice).toContain('1 recording');
  });

  it('formats plural count for multiple items', () => {
    const view = toRecoveryListView([
      { id: 'a', createdAt: '2026-08-13T00:00:00.000Z', bytes: 1024, state: 'recoverable' },
      { id: 'b', createdAt: '2026-08-13T01:00:00.000Z', bytes: 2048, state: 'not-recoverable' },
    ]);

    expect(view.notice).toContain('2 recordings');
  });

  it('computes total byte size across all items', () => {
    const view = toRecoveryListView([
      { id: 'a', createdAt: '2026-08-13T00:00:00.000Z', bytes: 1_000_000, state: 'recoverable' },
      { id: 'b', createdAt: '2026-08-13T01:00:00.000Z', bytes: 2_000_000, state: 'recoverable' },
    ]);

    expect(view.notice).toContain('2 recordings');
    expect(view.notice).toMatch(/MB/);
    expect(view.totalBytes).toBe(3_000_000);
  });

  it('uses safe integer addition for bytes total', () => {
    const view = toRecoveryListView([
      {
        id: 'a',
        createdAt: '2026-08-13T00:00:00.000Z',
        bytes: Number.MAX_SAFE_INTEGER,
        state: 'recoverable',
      },
      {
        id: 'b',
        createdAt: '2026-08-13T01:00:00.000Z',
        bytes: Number.MAX_SAFE_INTEGER,
        state: 'recoverable',
      },
    ]);

    // Should not overflow; should cap at MAX_SAFE_INTEGER
    expect(view.notice).toBeDefined();
    expect(view.totalBytes).toBe(Number.MAX_SAFE_INTEGER);
  });
});

/* ── formatBytes ─────────────────────────────────────────────── */

describe('formatBytes', () => {
  it('formats bytes under 1 KB', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(1024)).toContain('KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1_048_576)).toContain('MB');
  });

  it('formats gigabytes', () => {
    expect(formatBytes(1_073_741_824)).toContain('GB');
  });

  it('handles zero bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('handles negative values as zero', () => {
    expect(formatBytes(-100)).toBe('0 B');
  });
});

/* ── formatDate ──────────────────────────────────────────────── */

describe('formatDate', () => {
  it('formats an ISO date string to a localized date', () => {
    const result = formatDate('2026-08-13T14:30:00.000Z');

    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes the year in the formatted date', () => {
    const result = formatDate('2026-08-13T14:30:00.000Z');

    expect(result).toContain('2026');
  });

  it('includes the month in the formatted date', () => {
    const result = formatDate('2026-08-13T14:30:00.000Z');

    // Should contain Aug or August (locale-dependent)
    expect(result).toMatch(/Aug|8/);
  });
});
