import {
  MAX_BLOCKS,
  MAX_JSON_PAYLOAD_BYTES,
  PCM_BLOCK_BYTES,
  type BlockIndex,
  type CaptureFrame,
  type ErrorPayload,
  type GapPayload,
  type InterruptionPayload,
  type ReadyPayload,
  type RecoverableReason,
  type SourceChannel,
  type SourceInterruptionReason,
  type StatePayload,
  type StoppedPayload,
} from '../../types/native-capture';

export const CAPTURE_PROTOCOL_VERSION = 1;
export const HEADER_BYTES = 16;
export const MAX_RETAINED_BYTES = 65_536;
export { MAX_BLOCKS, MAX_JSON_PAYLOAD_BYTES, PCM_BLOCK_BYTES };

export const CaptureFrameType = {
  ready: 0x01,
  pcm: 0x02,
  gap: 0x03,
  interruption: 0x04,
  state: 0x05,
  stopped: 0x06,
  error: 0x07,
} as const;

type FrameType = keyof typeof CaptureFrameType;
type JsonObject = Record<string, unknown>;
type ProtocolErrorCode =
  | 'RETAINED_BUFFER_LIMIT'
  | 'INVALID_MAGIC'
  | 'UNSUPPORTED_VERSION'
  | 'NONZERO_RESERVED_BYTES'
  | 'UNKNOWN_FRAME_TYPE'
  | 'INVALID_PAYLOAD_LENGTH'
  | 'INVALID_SEQUENCE'
  | 'PARTIAL_FRAME_AT_EOF'
  | 'MALFORMED_JSON'
  | 'DUPLICATE_JSON_KEY'
  | 'INVALID_SCHEMA'
  | 'INVALID_INVARIANT'
  | 'TERMINAL_FRAME';

export class CaptureProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = 'CaptureProtocolError';
    this.code = code;
  }
}

interface OpenInterruption {
  id: number;
  channel: SourceChannel;
  startBlock: number;
  reason: SourceInterruptionReason;
}

/**
 * Validates the untrusted helper stdout stream before any audio reaches
 * persistence. Frames are returned only after their individual and session
 * invariants have been checked.
 */
export class CaptureProtocolDecoder {
  private retained = Buffer.alloc(0);
  private expectedSequence = 0;
  private sequenceExhausted = false;
  private readySeen = false;
  private stoppedSeen = false;
  private errorSeen = false;
  private persistedBlocks = 0;
  private pcmBlocks = 0;
  private gapBlocks = 0;
  private readonly lastStateBlock: Record<SourceChannel, number> = {
    interviewer: 0,
    you: 0,
  };
  private readonly stateSeen: Record<SourceChannel, boolean> = {
    interviewer: false,
    you: false,
  };
  private readonly openInterruptions = new Map<SourceChannel, OpenInterruption>();
  private readonly usedInterruptionIds = new Set<number>();
  private requirePcmAfterOpen = false;
  private unrecoveredClosePending = false;

  push(chunk: Buffer): CaptureFrame[] {
    if (!Buffer.isBuffer(chunk)) {
      throw new CaptureProtocolError('INVALID_SCHEMA', 'Protocol chunks must be Buffers.');
    }
    if (this.retained.length + chunk.length > MAX_RETAINED_BYTES) {
      throw new CaptureProtocolError(
        'RETAINED_BUFFER_LIMIT',
        'Protocol retained buffer exceeded 64 KiB.',
      );
    }
    this.retained = Buffer.concat([this.retained, chunk]);

    const frames: CaptureFrame[] = [];
    while (this.retained.length >= HEADER_BYTES) {
      const header = this.readHeader(this.retained);
      if (this.retained.length < HEADER_BYTES + header.payloadLength) {
        break;
      }
      const payload = this.retained.subarray(HEADER_BYTES, HEADER_BYTES + header.payloadLength);
      const frame = this.decodeFrame(header.frameType, header.sequence, payload);
      this.retained = this.retained.subarray(HEADER_BYTES + header.payloadLength);
      frames.push(frame);
    }
    return frames;
  }

  finish(): void {
    if (this.retained.length !== 0) {
      throw new CaptureProtocolError(
        'PARTIAL_FRAME_AT_EOF',
        'Protocol stream ended with a partial frame.',
      );
    }
  }

  private readHeader(buffer: Buffer): {
    frameType: FrameType;
    payloadLength: number;
    sequence: number;
  } {
    if (buffer.toString('ascii', 0, 4) !== 'ICAP') {
      throw new CaptureProtocolError('INVALID_MAGIC', 'Protocol frame has invalid magic.');
    }
    if (buffer.readUInt8(4) !== CAPTURE_PROTOCOL_VERSION) {
      throw new CaptureProtocolError(
        'UNSUPPORTED_VERSION',
        'Protocol frame has an unsupported version.',
      );
    }
    if (buffer.readUInt8(6) !== 0 || buffer.readUInt8(7) !== 0) {
      throw new CaptureProtocolError(
        'NONZERO_RESERVED_BYTES',
        'Protocol frame reserved bytes must be zero.',
      );
    }
    const frameType = this.frameTypeFor(buffer.readUInt8(5));
    const payloadLength = buffer.readUInt32LE(8);
    const sequence = buffer.readUInt32LE(12);
    const expectedLength = frameType === 'pcm' ? PCM_BLOCK_BYTES : MAX_JSON_PAYLOAD_BYTES;
    if (
      payloadLength > expectedLength ||
      (frameType === 'pcm' && payloadLength !== PCM_BLOCK_BYTES)
    ) {
      throw new CaptureProtocolError(
        'INVALID_PAYLOAD_LENGTH',
        'Protocol frame payload length is invalid.',
      );
    }
    if (this.sequenceExhausted || sequence !== this.expectedSequence) {
      throw new CaptureProtocolError(
        'INVALID_SEQUENCE',
        'Protocol sequence is not the exact successor.',
      );
    }
    return { frameType, payloadLength, sequence };
  }

  private frameTypeFor(value: number): FrameType {
    for (const [frameType, code] of Object.entries(CaptureFrameType)) {
      if (value === code) {
        return frameType as FrameType;
      }
    }
    throw new CaptureProtocolError('UNKNOWN_FRAME_TYPE', 'Protocol frame type is unknown.');
  }

  private decodeFrame(frameType: FrameType, sequence: number, payload: Buffer): CaptureFrame {
    if (this.errorSeen || this.stoppedSeen) {
      throw new CaptureProtocolError(
        'TERMINAL_FRAME',
        'A semantic frame followed a terminal frame.',
      );
    }
    if (this.unrecoveredClosePending && frameType !== 'stopped' && frameType !== 'interruption') {
      throw new CaptureProtocolError(
        'INVALID_INVARIANT',
        'An unrecovered interruption close must end in stopped.',
      );
    }

    const decodedPayload = frameType === 'pcm' ? payload : this.decodeJsonPayload(payload);
    if (
      this.requirePcmAfterOpen &&
      frameType !== 'pcm' &&
      (frameType !== 'interruption' || !this.isInterruptionOpen(decodedPayload))
    ) {
      throw new CaptureProtocolError(
        'INVALID_INVARIANT',
        'An interruption open must immediately precede PCM.',
      );
    }
    const frame = this.validateFrame(frameType, sequence, decodedPayload);
    this.advanceSequence();
    return frame;
  }

  private advanceSequence(): void {
    if (this.expectedSequence === 0xffff_ffff) {
      this.sequenceExhausted = true;
      return;
    }
    this.expectedSequence += 1;
  }

  private validateFrame(frameType: FrameType, sequence: number, payload: unknown): CaptureFrame {
    if (frameType !== 'error' && !this.readySeen && frameType !== 'ready') {
      throw new CaptureProtocolError(
        'INVALID_INVARIANT',
        'Ready must be the first non-error frame.',
      );
    }
    if (frameType === 'ready') {
      if (this.readySeen) {
        this.invalidInvariant('Ready may only be emitted once.');
      }
      const ready = this.validateReady(payload);
      this.readySeen = true;
      return { frameType, sequence, payload: ready };
    }
    if (frameType === 'pcm') {
      if (!Buffer.isBuffer(payload) || payload.length !== PCM_BLOCK_BYTES) {
        this.invalidSchema('PCM payload must be exactly one stereo block.');
      }
      if (this.persistedBlocks >= MAX_BLOCKS) {
        this.invalidInvariant('PCM exceeds the RIFF block limit.');
      }
      this.persistedBlocks += 1;
      this.pcmBlocks += 1;
      this.requirePcmAfterOpen = false;
      return { frameType, sequence, payload };
    }
    if (frameType === 'gap') {
      const gap = this.validateGap(payload);
      this.persistedBlocks = gap.endBlockExclusive;
      this.gapBlocks += gap.endBlockExclusive - gap.startBlock;
      return { frameType, sequence, payload: gap };
    }
    if (frameType === 'interruption') {
      const interruption = this.validateInterruption(payload);
      return { frameType, sequence, payload: interruption };
    }
    if (frameType === 'state') {
      const state = this.validateState(payload);
      return { frameType, sequence, payload: state };
    }
    if (frameType === 'stopped') {
      const stopped = this.validateStopped(payload);
      this.stoppedSeen = true;
      return { frameType, sequence, payload: stopped };
    }
    const error = this.validateError(payload);
    this.errorSeen = true;
    return { frameType, sequence, payload: error };
  }

  private validateReady(value: unknown): ReadyPayload {
    const object = this.closedObject(value, [
      'type',
      'sampleRateHz',
      'framesPerBlock',
      'encoding',
      'channelOrder',
      'firstBlock',
    ]);
    if (
      object.type !== 'ready' ||
      object.sampleRateHz !== 16_000 ||
      object.framesPerBlock !== 320 ||
      object.encoding !== 's16le' ||
      object.firstBlock !== 0 ||
      !Array.isArray(object.channelOrder) ||
      object.channelOrder.length !== 2 ||
      object.channelOrder[0] !== 'interviewer' ||
      object.channelOrder[1] !== 'you'
    ) {
      this.invalidSchema('Ready payload does not describe the fixed PCM format.');
    }
    return object as unknown as ReadyPayload;
  }

  private validateGap(value: unknown): GapPayload {
    const object = this.closedObject(value, [
      'type',
      'channel',
      'startBlock',
      'endBlockExclusive',
      'reason',
      'recovered',
    ]);
    const startBlock = this.blockIndex(object.startBlock, 'gap.startBlock');
    const endBlockExclusive = this.blockIndex(object.endBlockExclusive, 'gap.endBlockExclusive');
    if (
      object.type !== 'gap' ||
      object.channel !== 'capture' ||
      object.reason !== 'buffer-overflow' ||
      object.recovered !== true ||
      startBlock !== this.persistedBlocks ||
      endBlockExclusive <= startBlock ||
      endBlockExclusive - startBlock > 3_000
    ) {
      this.invalidInvariant('Gap payload does not describe a valid contiguous timeline range.');
    }
    return object as unknown as GapPayload;
  }

  private validateInterruption(value: unknown): InterruptionPayload {
    const object = this.object(value);
    if (this.unrecoveredClosePending && (object.phase !== 'closed' || object.recovered !== false)) {
      this.invalidInvariant('Only unrecovered closes may precede stopped.');
    }
    if (object.phase === 'opened') {
      const opened = this.closedObject(object, [
        'type',
        'phase',
        'id',
        'channel',
        'startBlock',
        'reason',
      ]);
      const id = this.uint32(opened.id, 'interruption.id');
      const startBlock = this.blockIndex(opened.startBlock, 'interruption.startBlock');
      const channel = this.sourceChannel(opened.channel, 'interruption.channel');
      const reason = this.sourceReason(opened.reason, 'interruption.reason');
      if (
        opened.type !== 'interruption' ||
        startBlock !== this.persistedBlocks ||
        startBlock >= MAX_BLOCKS ||
        this.openInterruptions.has(channel) ||
        this.usedInterruptionIds.has(id)
      ) {
        this.invalidInvariant('Interruption open is invalid for the current session.');
      }
      this.openInterruptions.set(channel, { id, channel, startBlock, reason });
      this.usedInterruptionIds.add(id);
      this.requirePcmAfterOpen = true;
      return opened as unknown as InterruptionPayload;
    }
    if (object.phase === 'closed') {
      const closed = this.closedObject(object, [
        'type',
        'phase',
        'id',
        'channel',
        'startBlock',
        'endBlockExclusive',
        'reason',
        'recovered',
      ]);
      const id = this.uint32(closed.id, 'interruption.id');
      const channel = this.sourceChannel(closed.channel, 'interruption.channel');
      const startBlock = this.blockIndex(closed.startBlock, 'interruption.startBlock');
      const endBlockExclusive = this.blockIndex(
        closed.endBlockExclusive,
        'interruption.endBlockExclusive',
      );
      const reason = this.sourceReason(closed.reason, 'interruption.reason');
      const open = this.openInterruptions.get(channel);
      if (
        closed.type !== 'interruption' ||
        typeof closed.recovered !== 'boolean' ||
        !open ||
        open.id !== id ||
        open.startBlock !== startBlock ||
        open.reason !== reason ||
        endBlockExclusive !== this.persistedBlocks ||
        endBlockExclusive <= startBlock
      ) {
        this.invalidInvariant('Interruption close does not match an open range.');
      }
      this.openInterruptions.delete(channel);
      if (!closed.recovered) {
        this.unrecoveredClosePending = true;
      }
      return closed as unknown as InterruptionPayload;
    }
    this.invalidSchema('Interruption phase is invalid.');
  }

  private validateState(value: unknown): StatePayload {
    const object = this.object(value);
    const status = object.status;
    const allowed =
      status === 'connected'
        ? ['type', 'channel', 'status', 'effectiveBlock']
        : status === 'connected-with-gap'
          ? ['type', 'channel', 'status', 'effectiveBlock', 'reason']
          : status === 'no-audio-detected'
            ? ['type', 'channel', 'status', 'effectiveBlock', 'silentBlocks']
            : status === 'reconnecting' || status === 'disconnected'
              ? ['type', 'channel', 'status', 'effectiveBlock', 'reason', 'attempt']
              : undefined;
    if (!allowed) {
      this.invalidSchema('State status is invalid.');
    }
    const state = this.closedObject(object, allowed);
    const channel = this.sourceChannel(state.channel, 'state.channel');
    const effectiveBlock = this.blockIndex(state.effectiveBlock, 'state.effectiveBlock');
    if (
      state.type !== 'state' ||
      effectiveBlock > this.persistedBlocks ||
      (this.stateSeen[channel] && effectiveBlock < this.lastStateBlock[channel])
    ) {
      this.invalidInvariant('State effective block is invalid for the current timeline.');
    }
    if (status === 'connected-with-gap') {
      this.gapReason(state.reason, 'state.reason');
    } else if (status === 'no-audio-detected') {
      if (this.blockIndex(state.silentBlocks, 'state.silentBlocks') < 1_500) {
        this.invalidInvariant('No-audio state requires at least 1500 silent blocks.');
      }
    } else if (status === 'reconnecting' || status === 'disconnected') {
      this.recoverableReason(state.reason, 'state.reason');
      const attempt = this.uint32(state.attempt, 'state.attempt');
      if (status === 'reconnecting' && attempt < 1) {
        this.invalidInvariant('Reconnecting state requires a positive attempt.');
      }
    }
    this.lastStateBlock[channel] = effectiveBlock;
    this.stateSeen[channel] = true;
    return state as unknown as StatePayload;
  }

  private validateStopped(value: unknown): StoppedPayload {
    const object = this.closedObject(value, [
      'type',
      'reason',
      'finalBlockExclusive',
      'pcmBlocks',
      'gapBlocks',
      'openInterruptionIds',
    ]);
    const finalBlockExclusive = this.blockIndex(
      object.finalBlockExclusive,
      'stopped.finalBlockExclusive',
    );
    const pcmBlocks = this.blockIndex(object.pcmBlocks, 'stopped.pcmBlocks');
    const gapBlocks = this.blockIndex(object.gapBlocks, 'stopped.gapBlocks');
    if (
      object.type !== 'stopped' ||
      (object.reason !== 'stop' && object.reason !== 'format-limit') ||
      !Array.isArray(object.openInterruptionIds) ||
      object.openInterruptionIds.length !== 0 ||
      this.openInterruptions.size !== 0 ||
      finalBlockExclusive !== this.persistedBlocks ||
      pcmBlocks !== this.pcmBlocks ||
      gapBlocks !== this.gapBlocks ||
      finalBlockExclusive !== pcmBlocks + gapBlocks ||
      (object.reason === 'format-limit' && finalBlockExclusive !== MAX_BLOCKS)
    ) {
      this.invalidInvariant('Stopped counters do not match the accepted timeline.');
    }
    this.unrecoveredClosePending = false;
    return object as unknown as StoppedPayload;
  }

  private validateError(value: unknown): ErrorPayload {
    const object = this.object(value);
    const phase = object.phase;
    const code = object.code;
    const withChannel =
      phase === 'initialization' &&
      (code === 'source-start-failed' || code === 'source-timestamp-unavailable');
    const withoutChannel =
      (phase === 'initialization' && (code === 'unsupported-format' || code === 'internal')) ||
      (phase === 'runtime' && (code === 'invalid-control' || code === 'internal'));
    if (!withChannel && !withoutChannel) {
      this.invalidSchema('Error phase and code are invalid.');
    }
    const error = this.closedObject(
      object,
      withChannel
        ? ['type', 'phase', 'code', 'channel', 'terminal']
        : ['type', 'phase', 'code', 'terminal'],
    );
    if (
      error.type !== 'error' ||
      error.terminal !== true ||
      (withChannel && !this.isSourceChannel(error.channel))
    ) {
      this.invalidSchema('Error payload is invalid.');
    }
    return error as unknown as ErrorPayload;
  }

  private decodeJsonPayload(payload: Buffer): unknown {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    } catch {
      throw new CaptureProtocolError('MALFORMED_JSON', 'JSON payload is not valid UTF-8.');
    }
    try {
      return new StrictJsonParser(text).parse();
    } catch (error: unknown) {
      if (error instanceof CaptureProtocolError) {
        throw error;
      }
      throw new CaptureProtocolError('MALFORMED_JSON', 'JSON payload is malformed.');
    }
  }

  private isInterruptionOpen(value: unknown): boolean {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as JsonObject).phase === 'opened'
    );
  }

  private closedObject(value: unknown, keys: readonly string[]): JsonObject {
    const object = this.object(value);
    const actual = Object.keys(object);
    if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
      this.invalidSchema('JSON payload contains unknown or missing fields.');
    }
    return object;
  }

  private object(value: unknown): JsonObject {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this.invalidSchema('JSON payload value must be an object.');
    }
    return value as JsonObject;
  }

  private uint32(value: unknown, label: string): number {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > 0xffff_ffff
    ) {
      this.invalidSchema(`${label} must be a UInt32.`);
    }
    return value;
  }

  private blockIndex(value: unknown, label: string): BlockIndex {
    const index = this.uint32(value, label);
    if (index > MAX_BLOCKS) {
      this.invalidSchema(`${label} exceeds the RIFF block limit.`);
    }
    return index;
  }

  private sourceChannel(value: unknown, label: string): SourceChannel {
    if (!this.isSourceChannel(value)) {
      this.invalidSchema(`${label} is invalid.`);
    }
    return value;
  }

  private isSourceChannel(value: unknown): value is SourceChannel {
    return value === 'interviewer' || value === 'you';
  }

  private sourceReason(value: unknown, label: string): SourceInterruptionReason {
    return this.gapReason(value, label);
  }

  private gapReason(value: unknown, label: string): SourceInterruptionReason {
    if (value === 'source-gap' || value === 'late-data' || this.isRecoverableReason(value)) {
      return value;
    }
    this.invalidSchema(`${label} is invalid.`);
  }

  private recoverableReason(value: unknown, label: string): RecoverableReason {
    if (this.isRecoverableReason(value)) {
      return value;
    }
    this.invalidSchema(`${label} is invalid.`);
  }

  private isRecoverableReason(value: unknown): value is RecoverableReason {
    return (
      value === 'stream-error' ||
      value === 'callback-stall' ||
      value === 'route-invalidated' ||
      value === 'timestamp-invalid' ||
      value === 'timestamp-discontinuity'
    );
  }

  private invalidSchema(message: string): never {
    throw new CaptureProtocolError('INVALID_SCHEMA', message);
  }

  private invalidInvariant(message: string): never {
    throw new CaptureProtocolError('INVALID_INVARIANT', message);
  }
}

/** Minimal JSON parser that rejects duplicate keys at every object depth. */
class StrictJsonParser {
  private position = 0;

  constructor(private readonly input: string) {}

  parse(): unknown {
    this.whitespace();
    const value = this.value();
    this.whitespace();
    if (this.position !== this.input.length) {
      this.malformed();
    }
    return value;
  }

  private value(): unknown {
    this.whitespace();
    const token = this.input[this.position];
    if (token === '{') return this.object();
    if (token === '[') return this.array();
    if (token === '"') return this.string();
    if (token === 't') return this.literal('true', true);
    if (token === 'f') return this.literal('false', false);
    if (token === 'n') return this.literal('null', null);
    if (token === '-' || (token !== undefined && token >= '0' && token <= '9'))
      return this.number();
    this.malformed();
  }

  private object(): JsonObject {
    this.expect('{');
    this.whitespace();
    const result: JsonObject = {};
    const keys = new Set<string>();
    if (this.consume('}')) return result;
    while (true) {
      this.whitespace();
      if (this.input[this.position] !== '"') this.malformed();
      const key = this.string();
      if (keys.has(key)) {
        throw new CaptureProtocolError(
          'DUPLICATE_JSON_KEY',
          'JSON payload contains a duplicate key.',
        );
      }
      keys.add(key);
      this.whitespace();
      this.expect(':');
      result[key] = this.value();
      this.whitespace();
      if (this.consume('}')) return result;
      this.expect(',');
    }
  }

  private array(): unknown[] {
    this.expect('[');
    this.whitespace();
    const result: unknown[] = [];
    if (this.consume(']')) return result;
    while (true) {
      result.push(this.value());
      this.whitespace();
      if (this.consume(']')) return result;
      this.expect(',');
    }
  }

  private string(): string {
    const start = this.position;
    if (this.input[this.position] !== '"') this.malformed();
    this.position += 1;
    let escaped = false;
    while (this.position < this.input.length) {
      const character = this.input[this.position++];
      if (!escaped && character === '"') {
        try {
          return JSON.parse(this.input.slice(start, this.position)) as string;
        } catch {
          this.malformed();
        }
      }
      if (!escaped && character.charCodeAt(0) < 0x20) this.malformed();
      if (!escaped && character === '\\') escaped = true;
      else escaped = false;
    }
    this.malformed();
  }

  private number(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.input.slice(this.position),
    );
    if (!match) this.malformed();
    this.position += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.malformed();
    return value;
  }

  private literal(token: string, value: boolean | null): boolean | null {
    if (this.input.slice(this.position, this.position + token.length) !== token) this.malformed();
    this.position += token.length;
    return value;
  }

  private whitespace(): void {
    while (/[ \t\r\n]/.test(this.input[this.position] ?? '')) this.position += 1;
  }

  private expect(character: string): void {
    if (!this.consume(character)) this.malformed();
  }

  private consume(character: string): boolean {
    if (this.input[this.position] !== character) return false;
    this.position += 1;
    return true;
  }

  private malformed(): never {
    throw new Error('Malformed JSON');
  }
}
