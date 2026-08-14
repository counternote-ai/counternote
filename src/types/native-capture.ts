/** A validated unsigned 32-bit integer. */
export type UInt32 = number;

/** A validated boundary in the persisted 20 ms audio timeline. */
export type BlockIndex = number;

/** Version 1 protocol limits shared by capture producers and consumers. */
export const MAX_BLOCKS = 3_355_443;
export const PCM_BLOCK_BYTES = 1_280;
export const MAX_JSON_PAYLOAD_BYTES = 4_096;

export type SourceChannel = 'interviewer' | 'you';

export type RecoverableReason =
  | 'stream-error'
  | 'callback-stall'
  | 'route-invalidated'
  | 'timestamp-invalid'
  | 'timestamp-discontinuity';

export type GapReason = 'source-gap' | 'late-data' | RecoverableReason;
export type SourceInterruptionReason = GapReason;

export interface ReadyPayload {
  type: 'ready';
  sampleRateHz: 16000;
  framesPerBlock: 320;
  encoding: 's16le';
  channelOrder: ['interviewer', 'you'];
  firstBlock: 0;
}

export type StatePayload =
  | {
      type: 'state';
      channel: SourceChannel;
      status: 'connected';
      effectiveBlock: BlockIndex;
    }
  | {
      type: 'state';
      channel: SourceChannel;
      status: 'connected-with-gap';
      effectiveBlock: BlockIndex;
      reason: GapReason;
    }
  | {
      type: 'state';
      channel: SourceChannel;
      status: 'no-audio-detected';
      effectiveBlock: BlockIndex;
      silentBlocks: BlockIndex;
    }
  | {
      type: 'state';
      channel: SourceChannel;
      status: 'reconnecting' | 'disconnected';
      effectiveBlock: BlockIndex;
      reason: RecoverableReason;
      attempt: UInt32;
    };

export interface StoppedPayload {
  type: 'stopped';
  reason: 'stop' | 'format-limit';
  finalBlockExclusive: BlockIndex;
  pcmBlocks: BlockIndex;
  gapBlocks: BlockIndex;
  openInterruptionIds: [];
}

export type ErrorPayload =
  | {
      type: 'error';
      phase: 'initialization';
      code: 'source-start-failed' | 'source-timestamp-unavailable';
      channel: SourceChannel;
      terminal: true;
    }
  | {
      type: 'error';
      phase: 'initialization';
      code: 'unsupported-format' | 'internal';
      terminal: true;
    }
  | {
      type: 'error';
      phase: 'runtime';
      code: 'invalid-control' | 'internal';
      terminal: true;
    };

export type InterruptionPayload =
  | {
      type: 'interruption';
      phase: 'opened';
      id: UInt32;
      channel: SourceChannel;
      startBlock: BlockIndex;
      reason: SourceInterruptionReason;
    }
  | {
      type: 'interruption';
      phase: 'closed';
      id: UInt32;
      channel: SourceChannel;
      startBlock: BlockIndex;
      endBlockExclusive: BlockIndex;
      reason: SourceInterruptionReason;
      recovered: boolean;
    };

export interface GapPayload {
  type: 'gap';
  channel: 'capture';
  startBlock: BlockIndex;
  endBlockExclusive: BlockIndex;
  reason: 'buffer-overflow';
  recovered: true;
}

export type CaptureFrame =
  | { frameType: 'ready'; sequence: UInt32; payload: ReadyPayload }
  | { frameType: 'pcm'; sequence: UInt32; payload: Buffer }
  | { frameType: 'gap'; sequence: UInt32; payload: GapPayload }
  | { frameType: 'interruption'; sequence: UInt32; payload: InterruptionPayload }
  | { frameType: 'state'; sequence: UInt32; payload: StatePayload }
  | { frameType: 'stopped'; sequence: UInt32; payload: StoppedPayload }
  | { frameType: 'error'; sequence: UInt32; payload: ErrorPayload };
