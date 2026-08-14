import corpus from '../../../../native/audio-capture/Tests/Fixtures/protocol-v1.json';
import { MAX_BLOCKS, MAX_JSON_PAYLOAD_BYTES, PCM_BLOCK_BYTES } from '../../../types/native-capture';
import { CaptureProtocolDecoder, CaptureFrameType } from '../protocol';

function frame(type: number, sequence: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.write('ICAP', 0, 'ascii');
  header.writeUInt8(1, 4);
  header.writeUInt8(type, 5);
  header.writeUInt32LE(payload.length, 8);
  header.writeUInt32LE(sequence, 12);
  return Buffer.concat([header, payload]);
}

const readyPayload = {
  type: 'ready',
  sampleRateHz: 16000,
  framesPerBlock: 320,
  encoding: 's16le',
  channelOrder: ['interviewer', 'you'],
  firstBlock: 0,
};

function jsonFrame(type: number, sequence: number, payload: unknown): Buffer {
  return frame(type, sequence, Buffer.from(JSON.stringify(payload)));
}

function ready(sequence: number = 0): Buffer {
  return jsonFrame(CaptureFrameType.ready, sequence, readyPayload);
}

function pcm(sequence: number, payload: Buffer = Buffer.alloc(1280)): Buffer {
  return frame(CaptureFrameType.pcm, sequence, payload);
}

function frames(...items: Buffer[]): ReturnType<CaptureProtocolDecoder['push']> {
  const decoder = new CaptureProtocolDecoder();
  const result = decoder.push(Buffer.concat(items));
  decoder.finish();
  return result;
}

function expectCode(action: () => unknown, code: string): void {
  expect(action).toThrow(expect.objectContaining({ code }));
}

describe('CaptureProtocolDecoder', () => {
  it('exports shared runtime protocol limits from the native capture contract', () => {
    expect(MAX_BLOCKS).toBe(3_355_443);
    expect(PCM_BLOCK_BYTES).toBe(1_280);
    expect(MAX_JSON_PAYLOAD_BYTES).toBe(4_096);
  });

  it('decodes headers and payloads split across chunks', () => {
    const ready = frame(0x01, 0, Buffer.from(JSON.stringify(readyPayload)));
    const pcm = frame(0x02, 1, Buffer.alloc(1280));
    const secondPcm = frame(0x02, 2, Buffer.alloc(1280));
    const decoder = new CaptureProtocolDecoder();

    expect(decoder.push(ready.subarray(0, 7))).toEqual([]);
    expect(decoder.push(ready.subarray(7))).toEqual([
      { frameType: 'ready', sequence: 0, payload: readyPayload },
    ]);
    expect(decoder.push(pcm.subarray(0, 200))).toEqual([]);
    expect(decoder.push(Buffer.concat([pcm.subarray(200), secondPcm]))).toEqual([
      { frameType: 'pcm', sequence: 1, payload: Buffer.alloc(1280) },
      { frameType: 'pcm', sequence: 2, payload: Buffer.alloc(1280) },
    ]);
    expect(decoder.finish()).toBeUndefined();
  });

  it('consumes the shared header and payload corpus', () => {
    for (const testCase of corpus.cases) {
      const decoder = new CaptureProtocolDecoder();
      const action = (): void => {
        for (const encoded of testCase.frames) decoder.push(Buffer.from(encoded, 'base64'));
        decoder.finish();
      };
      if (testCase.outcome === 'ok') expect(action).not.toThrow();
      else expectCode(action, testCase.outcome);
    }
  });

  it('accepts every valid JSON payload variant', () => {
    const validCases: Array<{
      name: string;
      type: number;
      payload: unknown;
      errorFirst?: boolean;
    }> = [
      {
        name: 'gap',
        type: CaptureFrameType.gap,
        payload: {
          type: 'gap',
          channel: 'capture',
          startBlock: 0,
          endBlockExclusive: 1,
          reason: 'buffer-overflow',
          recovered: true,
        },
      },
      {
        name: 'state connected',
        type: CaptureFrameType.state,
        payload: { type: 'state', channel: 'you', status: 'connected', effectiveBlock: 0 },
      },
      {
        name: 'state with gap',
        type: CaptureFrameType.state,
        payload: {
          type: 'state',
          channel: 'you',
          status: 'connected-with-gap',
          effectiveBlock: 0,
          reason: 'late-data',
        },
      },
      {
        name: 'state silence',
        type: CaptureFrameType.state,
        payload: {
          type: 'state',
          channel: 'you',
          status: 'no-audio-detected',
          effectiveBlock: 0,
          silentBlocks: 1500,
        },
      },
      {
        name: 'state reconnecting',
        type: CaptureFrameType.state,
        payload: {
          type: 'state',
          channel: 'you',
          status: 'reconnecting',
          effectiveBlock: 0,
          reason: 'callback-stall',
          attempt: 1,
        },
      },
      {
        name: 'state disconnected',
        type: CaptureFrameType.state,
        payload: {
          type: 'state',
          channel: 'you',
          status: 'disconnected',
          effectiveBlock: 0,
          reason: 'callback-stall',
          attempt: 0,
        },
      },
      {
        name: 'stopped',
        type: CaptureFrameType.stopped,
        payload: {
          type: 'stopped',
          reason: 'stop',
          finalBlockExclusive: 0,
          pcmBlocks: 0,
          gapBlocks: 0,
          openInterruptionIds: [],
        },
      },
      {
        name: 'initialization error with channel',
        type: CaptureFrameType.error,
        payload: {
          type: 'error',
          phase: 'initialization',
          code: 'source-start-failed',
          channel: 'you',
          terminal: true,
        },
        errorFirst: true,
      },
      {
        name: 'initialization error',
        type: CaptureFrameType.error,
        payload: { type: 'error', phase: 'initialization', code: 'internal', terminal: true },
        errorFirst: true,
      },
      {
        name: 'runtime error',
        type: CaptureFrameType.error,
        payload: { type: 'error', phase: 'runtime', code: 'invalid-control', terminal: true },
        errorFirst: true,
      },
    ];
    for (const testCase of validCases) {
      const output = testCase.errorFirst
        ? [jsonFrame(testCase.type, 0, testCase.payload)]
        : [ready(), jsonFrame(testCase.type, 1, testCase.payload)];
      expect(() => frames(...output)).not.toThrow();
    }
    expect(() =>
      frames(
        ready(),
        jsonFrame(CaptureFrameType.interruption, 1, {
          type: 'interruption',
          phase: 'opened',
          id: 1,
          channel: 'you',
          startBlock: 0,
          reason: 'source-gap',
        }),
        pcm(2),
        jsonFrame(CaptureFrameType.interruption, 3, {
          type: 'interruption',
          phase: 'closed',
          id: 1,
          channel: 'you',
          startBlock: 0,
          endBlockExclusive: 1,
          reason: 'source-gap',
          recovered: true,
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    ['unknown type', () => frame(0x08, 0, Buffer.alloc(0)), 'UNKNOWN_FRAME_TYPE'],
    [
      'wrong PCM length',
      () => frame(CaptureFrameType.pcm, 1, Buffer.alloc(1279)),
      'INVALID_PAYLOAD_LENGTH',
    ],
    ['sequence gap', () => Buffer.concat([ready(), pcm(2)]), 'INVALID_SEQUENCE'],
    ['sequence reuse', () => Buffer.concat([ready(), pcm(0)]), 'INVALID_SEQUENCE'],
    ['partial EOF', () => ready().subarray(0, 10), 'PARTIAL_FRAME_AT_EOF'],
    [
      'malformed UTF-8',
      () => frame(CaptureFrameType.ready, 0, Buffer.from([0xff])),
      'MALFORMED_JSON',
    ],
    [
      'non-JSON whitespace',
      () => frame(CaptureFrameType.ready, 0, Buffer.from(`\u00a0${JSON.stringify(readyPayload)}`)),
      'MALFORMED_JSON',
    ],
  ])('rejects %s', (_name, make, code) => {
    const decoder = new CaptureProtocolDecoder();
    if (code === 'PARTIAL_FRAME_AT_EOF') {
      expect(decoder.push(make())).toEqual([]);
      expectCode(() => decoder.finish(), code);
    } else expectCode(() => decoder.push(make()), code);
  });

  it('rejects sequence wraparound after UInt32 maximum', () => {
    const decoder = new CaptureProtocolDecoder() as unknown as {
      expectedSequence: number;
      push(chunk: Buffer): unknown;
    };
    decoder.push(ready());
    // A normal session reaches this state only after four billion frames; the
    // decoder must nevertheless reject the successor that would wrap to zero.
    decoder.expectedSequence = 0xffff_ffff;
    expect(() => decoder.push(pcm(0xffff_ffff))).not.toThrow();
    expectCode(() => decoder.push(pcm(0)), 'INVALID_SEQUENCE');
  });

  it.each([
    ['PCM before ready', [pcm(0)], 'INVALID_INVARIANT'],
    ['a second ready', [ready(), ready(1)], 'INVALID_INVARIANT'],
    [
      'state nonmonotonic',
      [
        ready(),
        pcm(1),
        jsonFrame(CaptureFrameType.state, 2, {
          type: 'state',
          channel: 'you',
          status: 'connected',
          effectiveBlock: 1,
        }),
        jsonFrame(CaptureFrameType.state, 3, {
          type: 'state',
          channel: 'you',
          status: 'connected',
          effectiveBlock: 0,
        }),
      ],
      'INVALID_INVARIANT',
    ],
    [
      'no-audio under threshold',
      [
        ready(),
        jsonFrame(CaptureFrameType.state, 1, {
          type: 'state',
          channel: 'you',
          status: 'no-audio-detected',
          effectiveBlock: 0,
          silentBlocks: 1499,
        }),
      ],
      'INVALID_INVARIANT',
    ],
    [
      'reconnecting zero attempt',
      [
        ready(),
        jsonFrame(CaptureFrameType.state, 1, {
          type: 'state',
          channel: 'you',
          status: 'reconnecting',
          effectiveBlock: 0,
          reason: 'callback-stall',
          attempt: 0,
        }),
      ],
      'INVALID_INVARIANT',
    ],
    [
      'gap not contiguous',
      [
        ready(),
        pcm(1),
        jsonFrame(CaptureFrameType.gap, 2, {
          type: 'gap',
          channel: 'capture',
          startBlock: 0,
          endBlockExclusive: 1,
          reason: 'buffer-overflow',
          recovered: true,
        }),
      ],
      'INVALID_INVARIANT',
    ],
    [
      'gap too large',
      [
        ready(),
        jsonFrame(CaptureFrameType.gap, 1, {
          type: 'gap',
          channel: 'capture',
          startBlock: 0,
          endBlockExclusive: 3001,
          reason: 'buffer-overflow',
          recovered: true,
        }),
      ],
      'INVALID_INVARIANT',
    ],
    [
      'invalid stopped counters',
      [
        ready(),
        pcm(1),
        jsonFrame(CaptureFrameType.stopped, 2, {
          type: 'stopped',
          reason: 'stop',
          finalBlockExclusive: 1,
          pcmBlocks: 0,
          gapBlocks: 1,
          openInterruptionIds: [],
        }),
      ],
      'INVALID_INVARIANT',
    ],
    [
      'error followed by PCM',
      [
        jsonFrame(CaptureFrameType.error, 0, {
          type: 'error',
          phase: 'runtime',
          code: 'internal',
          terminal: true,
        }),
        pcm(1),
      ],
      'TERMINAL_FRAME',
    ],
    [
      'stopped followed by state',
      [
        ready(),
        jsonFrame(CaptureFrameType.stopped, 1, {
          type: 'stopped',
          reason: 'stop',
          finalBlockExclusive: 0,
          pcmBlocks: 0,
          gapBlocks: 0,
          openInterruptionIds: [],
        }),
        jsonFrame(CaptureFrameType.state, 2, {
          type: 'state',
          channel: 'you',
          status: 'connected',
          effectiveBlock: 0,
        }),
      ],
      'TERMINAL_FRAME',
    ],
  ])('rejects invalid cross-frame condition: %s', (_name, input, code) => {
    expectCode(() => frames(...input), code);
  });

  it('enforces the interruption lifecycle, unique IDs, matching closes, and recovery rule', () => {
    const open = {
      type: 'interruption',
      phase: 'opened',
      id: 1,
      channel: 'you',
      startBlock: 0,
      reason: 'source-gap',
    };
    const close = {
      type: 'interruption',
      phase: 'closed',
      id: 1,
      channel: 'you',
      startBlock: 0,
      endBlockExclusive: 1,
      reason: 'source-gap',
      recovered: true,
    };
    expect(() =>
      frames(
        ready(),
        jsonFrame(CaptureFrameType.interruption, 1, open),
        pcm(2),
        jsonFrame(CaptureFrameType.interruption, 3, close),
      ),
    ).not.toThrow();
    expect(() =>
      frames(
        ready(),
        jsonFrame(CaptureFrameType.interruption, 1, open),
        jsonFrame(CaptureFrameType.interruption, 2, { ...open, id: 2, channel: 'interviewer' }),
        pcm(3),
        jsonFrame(CaptureFrameType.interruption, 4, close),
        jsonFrame(CaptureFrameType.interruption, 5, { ...close, id: 2, channel: 'interviewer' }),
      ),
    ).not.toThrow();
    expectCode(
      () =>
        frames(
          ready(),
          jsonFrame(CaptureFrameType.interruption, 1, open),
          jsonFrame(CaptureFrameType.interruption, 2, { ...open, id: 2 }),
        ),
      'INVALID_INVARIANT',
    );
    expectCode(
      () =>
        frames(
          ready(),
          jsonFrame(CaptureFrameType.interruption, 1, open),
          pcm(2),
          jsonFrame(CaptureFrameType.interruption, 3, { ...close, id: 2 }),
        ),
      'INVALID_INVARIANT',
    );
    expectCode(
      () =>
        frames(
          ready(),
          jsonFrame(CaptureFrameType.interruption, 1, open),
          pcm(2),
          jsonFrame(CaptureFrameType.interruption, 3, close),
          jsonFrame(CaptureFrameType.interruption, 4, { ...open, startBlock: 1 }),
        ),
      'INVALID_INVARIANT',
    );
    expectCode(
      () =>
        frames(
          ready(),
          jsonFrame(CaptureFrameType.interruption, 1, open),
          pcm(2),
          jsonFrame(CaptureFrameType.interruption, 3, { ...close, recovered: false }),
          pcm(4),
        ),
      'INVALID_INVARIANT',
    );
    expect(() =>
      frames(
        ready(),
        jsonFrame(CaptureFrameType.interruption, 1, open),
        pcm(2),
        jsonFrame(CaptureFrameType.interruption, 3, { ...close, recovered: false }),
        jsonFrame(CaptureFrameType.stopped, 4, {
          type: 'stopped',
          reason: 'stop',
          finalBlockExclusive: 1,
          pcmBlocks: 1,
          gapBlocks: 0,
          openInterruptionIds: [],
        }),
      ),
    ).not.toThrow();
  });

  it('accounts for PCM and gaps as one persisted timeline and allows format-limit only at MAX_BLOCKS', () => {
    const normal = frames(
      ready(),
      pcm(1),
      jsonFrame(CaptureFrameType.gap, 2, {
        type: 'gap',
        channel: 'capture',
        startBlock: 1,
        endBlockExclusive: 3,
        reason: 'buffer-overflow',
        recovered: true,
      }),
      jsonFrame(CaptureFrameType.stopped, 3, {
        type: 'stopped',
        reason: 'stop',
        finalBlockExclusive: 3,
        pcmBlocks: 1,
        gapBlocks: 2,
        openInterruptionIds: [],
      }),
    );
    expect(normal).toHaveLength(4);

    const decoder = new CaptureProtocolDecoder() as unknown as {
      persistedBlocks: number;
      pcmBlocks: number;
      gapBlocks: number;
      push(chunk: Buffer): unknown;
    };
    decoder.push(ready());
    decoder.persistedBlocks = MAX_BLOCKS - 2;
    decoder.pcmBlocks = MAX_BLOCKS - 2;
    decoder.gapBlocks = 0;
    expect(() =>
      decoder.push(
        jsonFrame(CaptureFrameType.gap, 1, {
          type: 'gap',
          channel: 'capture',
          startBlock: MAX_BLOCKS - 2,
          endBlockExclusive: MAX_BLOCKS,
          reason: 'buffer-overflow',
          recovered: true,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      decoder.push(
        jsonFrame(CaptureFrameType.stopped, 2, {
          type: 'stopped',
          reason: 'format-limit',
          finalBlockExclusive: MAX_BLOCKS,
          pcmBlocks: MAX_BLOCKS - 2,
          gapBlocks: 2,
          openInterruptionIds: [],
        }),
      ),
    ).not.toThrow();
    expectCode(
      () =>
        frames(
          ready(),
          jsonFrame(CaptureFrameType.stopped, 1, {
            type: 'stopped',
            reason: 'format-limit',
            finalBlockExclusive: 0,
            pcmBlocks: 0,
            gapBlocks: 0,
            openInterruptionIds: [],
          }),
        ),
      'INVALID_INVARIANT',
    );
  });
});
