# Native macOS Audio Capture Design

**Date:** 2026-08-12
**Status:** Approved

## Context

Interview Copilot currently asks Electron for display media with
`audio: 'loopback'`, asks Web Audio for a separate microphone stream, merges the
two renderer-side, and sends interleaved PCM to the main process for WAV
persistence.

The production recording `2026-08-11T02-30-23-541Z` exposed a severe failure in
that path:

- the stereo WAV remained structurally valid for 58 minutes 44 seconds;
- the microphone/right channel remained available for the complete session;
- the system/left channel carried the interviewer normally until 04:35.224;
- after 04:35.224 the system channel was almost entirely exact digital zero,
  apart from three brief returns;
- WAV writing, renderer processing, IPC, and microphone capture continued;
- the failure coincided with muting and then unmuting the meeting microphone.

The control recording `2026-08-10T03-29-32-709Z` used the same application code
and Electron installation. Its system channel remained available throughout a
16 minute 52 second session, with interviewer segments continuing through
16:45. This rules out a deterministic channel mapping error, a fixed recording
duration limit, and a general WAV writer failure.

The observed failure matches the macOS Core Audio Process Tap failure mode in
which callbacks, timestamps, and buffer sizes remain valid while every delivered
sample becomes zero. The stream can appear live and occasionally recover, so
track lifecycle alone cannot prove that audible system audio is still reaching
the app. Rebuilding only downstream Web Audio or WAV components cannot recover
PCM that the operating-system capture source no longer supplies.

## Goal

A candidate can record a long macOS interview with independently usable
`Interviewer` and `You` channels even when the meeting application mutes,
unmutes, or reconfigures its microphone session.

The application reports recording health truthfully, preserves all audio that
was captured when one input fails, and records any confirmed interruption for
later review. A capture failure must not remain hidden until transcription.

## Success Criteria

- System audio uses ScreenCaptureKit rather than Electron loopback or a Core
  Audio Process Tap.
- Microphone audio uses a raw native input rather than Web Audio or
  VoiceProcessingIO.
- Both sources share one monotonic host-time timeline and remain within 20 ms of
  one another over a 60-minute recording.
- Repeated mute and unmute operations in the meeting application do not remove
  system audio from the recording.
- A confirmed stream failure is visible during recording and remains visible on
  the saved recording.
- A helper or single-channel failure leaves a structurally valid, finalized WAV
  containing all PCM delivered before and during the surviving-channel period.
- Failed partial audio is either recoverable through an explicit local UI or can
  be moved to Trash by the user; it is never retained without visibility or
  deleted automatically.
- Existing recordings remain readable without migration.

## Non-goals

- Windows or Linux capture support.
- Speaker diarization or identity inference. The labels continue to describe
  channels only.
- Capturing video or screen pixels.
- Installing BlackHole, Loopback, or another virtual audio driver.
- Eliminating legitimate acoustic leakage from speakers into the microphone.
- Automatically treating sample-level silence as proof of capture failure.
- Changing transcription providers, export formats, or the existing
  `audio.wav` channel convention.
- Crash-proofing an abrupt loss of the Electron main process or machine power.
  This design guarantees finalization for helper and input failures that the
  main process remains alive to observe.

## Decision

Replace both renderer-owned audio inputs with one application-owned Swift
capture helper:

- ScreenCaptureKit captures outgoing system audio for the `Interviewer` channel.
- AVAudioEngine captures unprocessed microphone input for the `You` channel.
- The helper aligns and resamples both sources and emits stereo PCM on one
  timeline.
- The Electron main process supervises the helper, writes `audio.wav`, persists
  capture health, and exposes narrow status updates to the renderer.

The application will not silently fall back to Electron loopback. Failure to
start the native helper or either required input blocks recording with a
recoverable error. Shipping an unreliable fallback would recreate the original
trust failure while making the active capture path harder to diagnose.

## Process Boundaries

### Renderer

The renderer owns the visible Record and Stop actions and presents capture
health. It does not receive raw PCM and no longer creates `AudioContext`,
`AudioWorkletNode`, display-media, or microphone streams.

The existing context-isolated preload bridge remains narrow. It carries
recording commands, typed status snapshots, typed recovery items, and recovery
actions addressed by opaque item ID only; it does not expose child-process,
filesystem path, ScreenCaptureKit, or AVAudioEngine APIs.

### Electron main process

The main process owns a `NativeCaptureSession` supervisor. It:

1. resolves and validates the helper executable;
2. creates the recording directory and provisional capture metadata;
3. starts the helper after the visible Record action;
4. validates framed helper output;
5. writes PCM through the existing WAV persistence boundary;
6. persists confirmed interruptions;
7. broadcasts bounded health snapshots to the renderer;
8. stops the helper and finalizes the WAV header;
9. enumerates, recovers, or moves failed partial recordings to Trash through a
   narrow recovery service.

Only one capture session may exist at a time. Start, stop, helper exit, and
window shutdown converge on one idempotent finalization path. Session state is
an explicit `idle` → `starting` → `recording` → `stopping` → `idle` machine;
terminal failures may move from `starting` or `recording` directly through
finalization to `idle`.

The main entry point calls `app.requestSingleInstanceLock()` synchronously before
`app.whenReady()`, window/tray creation, capture startup, or recovery scanning.
If it returns false, that process calls `app.quit()` immediately and performs no
recordings-root read or mutation. The primary instance holds the lock until
termination and handles `second-instance` only by restoring and focusing its
control panel. It never releases the lock for background or tray operation.
This is required even on macOS because command-line launches can bypass Finder's
single-instance behavior. Consequently no live second app process can classify
the primary instance's `.in-progress` capture as abandoned, recover it, or move
it to Trash.

### Swift helper

The helper is an app-owned, macOS arm64 executable with no network access. It
owns all native audio objects and runs until it receives Stop, encounters an
unrecoverable initialization failure, or loses its parent pipe.

Logs go to stderr. Protocol output goes to stdout. The helper never opens the
recording directory and does not receive a user-selected path, API key,
transcript, or interview metadata.

## Native Capture

### System audio

The helper creates an `SCStream` with audio capture enabled and registers only
an audio stream output. It captures the default display's system mix, excludes
Interview Copilot's own process audio, and does not save or forward video sample
buffers.

ScreenCaptureKit callbacks retain their presentation timestamps. An SCStream
error or a callback stall is a confirmed capture failure; a valid callback
containing zero samples is not.

### Microphone

The helper uses AVAudioEngine's input node in raw mode. Voice processing, echo
cancellation, noise suppression, and automatic gain control are not enabled by
Interview Copilot. The selected device is the macOS default input at recording
start.

A default-input route change causes the helper to rebuild the microphone input
against the new default device while preserving the recording timeline. A
meeting application's logical mute does not stop Interview Copilot's independent
microphone capture.

### Format and channel contract

Native callbacks may use different sample rates and buffer sizes. Each input is
converted independently with AVAudioConverter to:

- signed 16-bit little-endian PCM;
- 16,000 Hz;
- mono per source;
- fixed 20 ms blocks, or 320 frames per channel.

The helper emits stereo blocks with system audio on channel 0/left and microphone
audio on channel 1/right. This preserves the existing WAV, channel-splitting,
and transcription contracts. In-app audio playback is not part of the shipped
product or this design.

## Synchronization

The shared clock is the macOS host clock backed by `mach_absolute_time()`.
ScreenCaptureKit requires a non-null `SCStream.synchronizationClock`; absence of
that clock fails initialization. Sample timestamps are interpreted against that
clock and converted to `CMClock.hostTimeClock` with `CMSyncConvertTime`. The
resulting `CMTime` must be valid, numeric, and convertible to host-time system
units. For microphone callbacks, the helper uses `AVAudioTime.hostTime` when
`isHostTimeValid == true` and converts it to the same Core Media host-clock
representation.

If a microphone callback lacks host time but has valid sample time, the helper
may use `extrapolateTime(fromAnchor:)` only with the most recent callback from
the same AVAudioEngine generation that contained both valid host time and valid
sample time. It must not anchor sample time to callback arrival time. If no such
anchor exists, or if a ScreenCaptureKit presentation timestamp is invalid, the
buffer is rejected and that source enters the timestamp-failure recovery path.

The helper records the first valid start timestamp from each input and chooses
the first 20 ms host-time boundary at or after the later timestamp as recording
time zero. Earlier samples from the faster-starting source are discarded. It
does not derive position by independently counting callback frames.

Both inputs are placed on a shared sequence of 20 ms host-time windows:

1. Validate and convert source timestamps to the common macOS host-time domain.
2. Resample source PCM into the target window.
3. Trim overlap already assigned to an earlier window.
4. Insert zero only for the missing source portion of a window.
5. Interleave the completed left and right windows.

Coverage accounting is independent of failure reconstruction. For each source
and emitted 20 ms block, the mixer records whether converted source frames cover
the complete target window. If one or more target frames remain uncovered when
the window is emitted, the helper zero-fills only those frames and emits a
channel interruption covering that entire affected block. Contiguous affected
blocks with the same reason may be coalesced; they may never be omitted from
metadata. A valid callback whose samples are all zero still covers its windows
and does not create an interruption. The helper emits the opened interruption
frame before the first affected `pcm` block and emits its close after the last
affected block but before the next unaffected `pcm` block. If the reason changes
while a channel interruption is open, the helper retains the reason from the
open frame until timestamped source coverage resumes or recording terminates.
The newer condition may change runtime `state` and trigger stronger recovery
behavior, but it does not close, relabel, or nest another interruption for that
channel. This keeps one truthful continuous loss range without requiring a
reclassification or superseded protocol operation.

Channel interruption ranges are conservative at 20 ms block granularity, not
sample-accurate loss measurements. If even one of the 320 source frames in a
block is uncovered, metadata marks the whole block. `startBlock` identifies the
first affected emitted block and `endBlockExclusive` the first unaffected block;
the actual missing samples are contained within that reported range. The first
implementation does not carry within-block frame offsets.

A timestamp hole shorter than 200 ms is a `source-gap`: it changes the channel
to `connected-with-gap` but does not rebuild an otherwise healthy input. The
200 ms bound controls jitter expiry and whether a timestamp discontinuity
triggers source reconstruction; it is never a threshold for whether zero-filled
audio is reported. Thus a single affected 20 ms block prevents `complete`
status just as a longer gap does.

The helper assigns the reason exactly once, before it emits the affected window:

- If timestamps from already-buffered or newly arrived source data prove that a
  span contains no source frames, the uncovered emitted blocks are
  `source-gap`.
- If the 200 ms jitter deadline expires without data that could cover the
  window, the uncovered emitted block is `late-data`, even if a packet for that
  time arrives afterward.

Data received after its window was emitted is discarded as late and cannot
reclassify, close, or rewrite the already-emitted interruption. The protocol has
no update operation because classification is final at emission.

This makes drift correction timestamp-driven. A delayed source cannot move the
other channel or change the duration of an already emitted block. The helper
maintains a bounded jitter buffer of 200 ms; data arriving later than that window
is reported as a `late-data` source interruption rather than rewriting PCM
already persisted. One uncovered block produces one final interruption reason;
a discarded late packet does not produce a duplicate record.

Within one native-input generation, source timestamps must be strictly
monotonic. The expected start of the next buffer is the prior start plus the
prior buffer duration. A timestamp that regresses, is nonnumeric, or differs
from that expected start by more than the 200 ms jitter bound is a
`timestamp-discontinuity`. The helper opens the interruption at the first 20 ms
block not covered by the last valid source sample, zero-fills the affected
channel, rebuilds that native input, and closes the interruption only after it
establishes a new same-source anchor and accepts timestamped samples again.

## Helper Protocol

stdout uses a versioned binary frame rather than unbounded JSON or raw
unframed PCM. Each frame begins with this 16-byte header:

- four-byte `ICAP` magic;
- one-byte protocol version;
- one-byte frame type;
- two reserved zero bytes;
- four-byte unsigned little-endian payload length;
- four-byte unsigned little-endian sequence number, starting at zero and
  increasing by exactly one without wraparound.

`pcm` payloads are exactly 1,280 bytes: 320 frames × two channels × two bytes.
The other frame types use UTF-8 JSON payloads capped at 4 KiB and validated
against closed TypeScript interfaces before use.

Frame types are:

- `ready`: validated capture format and proof that both sources delivered an
  initial timestamped callback;
- `pcm`: exactly one 20 ms interleaved stereo block;
- `gap`: an exact capture-wide range of between 1 and 3,000 consecutive 20 ms
  blocks that output overflow prevented the helper from delivering; longer gaps
  use consecutive frames;
- `interruption`: a channel-specific interruption lifecycle event;
- `state`: typed channel transition or recent audio-presence summary;
- `stopped`: final helper counters;
- `error`: typed, safe failure information.

The protocol uses these conceptual numeric aliases in both Swift validators and
TypeScript trust-boundary validators. JSON numbers for these fields must be
finite integers, not strings: `UInt32` is 0 through 4,294,967,295;
`BlockIndex` is a timeline boundary from 0 through `MAX_BLOCKS = 3,355,443`
inclusive. At most `MAX_BLOCKS` timeline blocks may be persisted, where
`persistedBlocks = pcmBlocks + gapBlocks`: each `pcm` contributes one 1,280-byte
block and each block represented by `gap` contributes one synthesized 1,280-byte
all-zero block. Valid block starts are 0 through 3,355,442 and the final exclusive
boundary is 3,355,443. Their data and 36-byte RIFF overhead fit in unsigned
32-bit RIFF sizes. The limit is 67,108,860 ms, or 18:38:28.860.

Before emitting either frame type, the helper verifies that its contribution
keeps `persistedBlocks <= MAX_BLOCKS`. A pending output-overflow gap that reaches
or crosses the boundary is emitted as one or more frames of at most 3,000 blocks;
the final frame is clipped to the remaining positive capacity and ends at
`MAX_BLOCKS`. Audio after that boundary is outside the recording and is not
represented by another gap. When the next expected block equals `MAX_BLOCKS`,
the helper emits no more `pcm` or `gap`; the supervisor finalizes the recording
as `interrupted` with a capture-wide `format-limit` point event at that boundary.
The main process independently rejects any frame whose contribution would exceed
the cap. A frame is also rejected if it contains duplicate JSON keys, unknown
fields, missing required fields, explicit `null`, or a value outside its stated
closed set.

The previously named frame payloads have these normative version 1 schemas:

```ts
type UInt32 = number; // validated integer range above
type BlockIndex = number; // validated RIFF-limited integer range above
type SourceChannel = 'interviewer' | 'you';
type RecoverableReason =
  | 'stream-error'
  | 'callback-stall'
  | 'route-invalidated'
  | 'timestamp-invalid'
  | 'timestamp-discontinuity';
type GapReason =
  | 'source-gap'
  | 'late-data'
  | RecoverableReason;
type SourceInterruptionReason = GapReason;

interface ReadyPayload {
  type: 'ready';
  sampleRateHz: 16000;
  framesPerBlock: 320;
  encoding: 's16le';
  channelOrder: ['interviewer', 'you'];
  firstBlock: 0;
}

type StatePayload =
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

interface StoppedPayload {
  type: 'stopped';
  reason: 'stop' | 'format-limit';
  finalBlockExclusive: BlockIndex;
  pcmBlocks: BlockIndex;
  gapBlocks: BlockIndex;
  openInterruptionIds: [];
}

type ErrorPayload =
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

type InterruptionPayload =
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

interface GapPayload {
  type: 'gap';
  channel: 'capture';
  startBlock: BlockIndex;
  endBlockExclusive: BlockIndex;
  reason: 'buffer-overflow';
  recovered: true;
}
```

`ready` is emitted exactly once, is the first non-error semantic frame, and must
precede `pcm`, `gap`, `interruption`, `state`, or `stopped`. For
`no-audio-detected`, `silentBlocks >= 1500`. Every state `effectiveBlock` is no
greater than the next expected protocol timeline block and is nondecreasing for
that channel. `reconnecting.attempt >= 1`; `disconnected.attempt` is the number
of completed attempts. `stopped` is emitted at most once;
`openInterruptionIds` must be empty, and `finalBlockExclusive` must equal
`pcmBlocks + gapBlocks` and the end of the consumed PCM/gap timeline. Every
`stopped` frame with reason `format-limit` must have `finalBlockExclusive ==
MAX_BLOCKS`; that reason is invalid at any earlier boundary. Every
`error` is terminal, never contains a native message, errno, path, or arbitrary
string, and permits no later semantic frame. The Swift and TypeScript
implementations consume one shared corpus of valid and invalid version 1 frame
fixtures so the schemas cannot drift independently.

`InterruptionPayload` IDs are UInt32 values unique within the session and are
never reused, including after close. An open must be emitted immediately before
the first affected `pcm`, with `startBlock` equal to the next persisted timeline
block and less than `MAX_BLOCKS`. A helper-emitted close must match every field
from its open and use `startBlock < endBlockExclusive ==` the next persisted
timeline block. `recovered: true` means timestamped source coverage resumed at
that exclusive boundary; `false` means the recording stopped while the source
remained unavailable. Blocks are helper timeline block numbers, so the
conservative half-open range maps safely to milliseconds by multiplying by 20.
Capture-wide output loss uses `GapPayload` instead. Late data may emit an open
immediately before one or more affected `pcm` blocks and close immediately after
them without changing the source to `reconnecting`.

Every source interruption reason may close with either recovery outcome.
`recovered: true` is valid only when timestamped source coverage resumes at
`endBlockExclusive`. `recovered: false` is valid only when orderly Stop,
format-limit termination, or local unexpected-termination finalization closes
the range without resumed coverage. In-session reason escalation is not a valid
cause for close and never claims recovery.

The main process permits at most one open interruption per channel, rejects an
unknown, reused, or duplicate ID, and enforces the ordering and equality
invariants above. Interruption frames contribute no WAV blocks and may not move
the persisted timeline. Only a matched close is persisted. If the helper
terminates with an open interruption, the main process closes it locally at the
next expected timeline block with `recovered: false` before it adds the
capture-wide terminal point event. Consequently every persisted channel
interruption has a validated block range, reason, and recovery outcome even when
the helper exits during recovery.

For `GapPayload`, `startBlock` must equal the next persisted timeline block;
`1 <= endBlockExclusive - startBlock <= 3,000`; and `endBlockExclusive <=
MAX_BLOCKS`. The main process appends exactly that many all-zero stereo blocks,
increments `gapBlocks` and the persisted timeline by that count, and persists
the same capture-wide interruption range. A gap therefore cannot overlap PCM,
skip a timeline block, use an empty/reversed range, or make `pcmBlocks +
gapBlocks` exceed `MAX_BLOCKS`.

Control input on stdin is versioned newline-delimited JSON capped at 1 KiB per
line. The initial implementation supports only `stop`; reconnects are
helper-owned state transitions rather than arbitrary renderer commands.

The main process rejects invalid magic, unsupported versions, oversized
payloads, any sequence value other than the exact expected successor, PCM frames
of the wrong length, and any payload that violates its closed schema or
cross-frame invariant. A protocol violation is treated as helper failure and
enters the same preservation and finalization path as an unexpected helper exit.

## Buffering, Backpressure, and Persistence

The main process spawns the helper with stdin, stdout, and stderr as separate
pipes and attaches stderr `data` and `error` listeners synchronously before it
waits for `ready`. stderr is drained continuously even while stdout is paused
for WAV backpressure. It is never inherited by the renderer, left unread, or
combined with protocol bytes.

Helper diagnostics are newline-delimited JSON objects of at most 1 KiB with
exactly two fields. `level` is `debug`, `info`, `warn`, or `error`; `code` is
`helper-started`, `source-restart-attempt`, `source-restart-failed`, or
`helper-stopping`. They contain no free-form message or value fields. The main
process retains at most one partial line. If a line exceeds 1 KiB, it discards
bytes through the next newline while continuing to drain the pipe. Malformed,
oversized, or unknown diagnostics are dropped. At most 20 valid diagnostics per
minute are sent to the main-process logger, followed by one count of suppressed
lines; raw stderr and a raw tail are never retained. A stderr read error disables
diagnostics but does not stop capture. This keeps memory bounded and prevents a
chatty helper from filling its pipe and blocking audio output.

Native realtime callback threads never write to stdout, wait for Electron, or
perform file I/O. They copy bounded source data into the helper's serial mixer.
The mixer feeds a separate serial output queue capped at 100 PCM blocks, or two
seconds. The output worker may block on the stdout pipe without blocking native
audio callbacks.

If the output queue reaches its cap, the helper stops enqueuing PCM blocks and
accumulates their exact timeline span in a pending `buffer-overflow` gap. Once
stdout becomes writable, it emits one or more bounded `gap` frames before later
PCM. The main process writes the corresponding number of all-zero stereo blocks,
marks a capture-wide interruption for that exact range, and never labels the
recording complete. Queue overflow does not shorten or shift the WAV timeline.

The main process consumes one complete frame at a time. WAV persistence is
asynchronous and backpressure-aware: when the underlying writable stream returns
false, the supervisor pauses child stdout and resumes it only after `drain`.
After backpressure begins, no later protocol frame is dispatched until `drain`.
The parser retains only the unconsumed portion of the current stdout chunk in an
explicit 64 KiB maximum buffer; exceeding it is a protocol error. The helper's
pipe and bounded output queue absorb the remaining pressure.

The existing fire-and-forget `WavWriter.write(): void` contract is replaced.
Opening returns a promise that rejects on open or header failure; each write
reports whether backpressure began and counts bytes only after the stream accepts
that block; finalization is idempotent and rejects on flush, stream, reopen,
header-update, or close failure. The supervisor subscribes to stream errors from
construction through final close, so an asynchronous error cannot become an
unhandled event or a false success.

A WAV open, write, stream, flush, header-update, or close error is a terminal
`persistence-error`. The main process retains an internal safe failure category
of `capacity`, `access`, or `io-finalization` for accurate UI recovery guidance;
raw error details never cross the preload bridge. The main process immediately
pauses protocol input, asks
the helper to stop, terminates it after the normal five-second grace period, and
attempts best-effort closure without reporting success. It atomically writes
`capture.json` as `failed` when storage remains writable; failure to update the
metadata does not change the in-memory failed outcome. Any partial files remain
in the implementation-owned recovery location and are available only through
the explicit failed-recording recovery flow; they are not exposed as saved
recordings. The renderer leaves recording mode and states what failed, what was
not published, and the next safe action when the category is known.

## Recording Lifecycle

### Global mutation ownership

A main-process `RecordingMutationCoordinator` provides one exclusive,
non-reentrant lease for every recordings-root mutation. Capture holds the lease
from staging-directory creation through publication or failed-item placement.
Recover and Move to Trash each hold it from final item validation through their
terminal filesystem result. Read-only library and recovery enumeration may run
without the lease but cannot mutate or infer that an item is abandoned while a
lease is active.

Only one mutation can exist, so capture and recovery/Trash are never concurrent.
While capture owns the lease, recovery actions are disabled with `Available
after recording stops`. While a recovery action owns it, Record is disabled and
the affected item reads `Recovering partial recording…` or `Moving partial
recording to Trash…`. Disabled controls expose the same reason accessibly and do
not appear to accept input.
The coordinator exposes `closeAndDrain()`: it synchronously rejects new lease
requests and returns one promise that settles only after the current lease is
released. Lease release is in `finally` and follows publication, recovery
placement, or a surfaced terminal failure; callers cannot resolve it early.

### Start

1. The visible Record action checks the current screen/audio and microphone
   permission snapshot.
2. The renderer enters `Starting…`, exposes `Cancel`, and keeps the current
   recordings library available. It does not show `Recording` or the tray's
   active state yet.
3. The main process creates `.in-progress/<session-uuid>` beneath the recordings
   root, opens provisional WAV persistence there, and atomically writes
   provisional `capture.json` metadata. The staging directory is on the same
   filesystem as its eventual recording directory and never matches a public
   recording ID.
4. The main process resolves and spawns the helper and starts a 60-second
   initialization deadline.
5. The helper starts ScreenCaptureKit and AVAudioEngine.
6. The helper reports `ready` only after both sources are running and have
   delivered timestamped callbacks. The callbacks may contain silence. It emits
   `ready` before the first buffered `pcm` frame.
7. The main process validates `ready`, cancels the initialization deadline, and
   acknowledges recording start.
8. Only then does the renderer show `Recording` and the tray show the active
   state.

Cancel during `starting`, expiry of the 60-second deadline, helper exit, window
shutdown, and any initialization failure all invoke the same idempotent start
cleanup. Cleanup sends `stop` when possible, terminates the helper after five
seconds, closes provisional persistence, removes the header-only staging
directory, and returns the UI to `idle`. PCM before `ready` is a protocol
violation and is never written. A late `ready`, `pcm`, or exit event after
cleanup starts is ignored except for resource closure.

### Stop

1. Stop remains available from the control panel and tray.
2. The main process sends the helper a `stop` control message.
3. The helper stops accepting new callbacks, drains complete timeline windows,
   closes every open source interruption at `finalBlockExclusive` with its
   original reason and `recovered: false`, emits `stopped` with reason `stop`,
   closes stdout, and exits. Reaching `MAX_BLOCKS` follows the same orderly
   sequence with reason `format-limit` without waiting for a control message.
4. The main process records `exit` only as process status. It does not use that
   event as a finalization signal because child stdio may still be open.
5. The main process waits for the child's `close` event, stdout EOF, dispatch of
   every complete parsed frame, and an empty parser buffer. A partial frame at
   EOF is a protocol failure, never a clean stop.
6. After parser drain, the main process waits for every accepted WAV write and
   backpressure `drain` to settle, then ends the stream and waits for `finish`.
   It updates the WAV header only after those writes have settled.
7. The main process atomically replaces provisional `capture.json` with the
   terminal metadata and publishes a `complete` or `interrupted` recording by
   atomically renaming the staging directory to its timestamp recording ID.
   Only after rename succeeds does it refresh the recordings library and make a
   saved claim.

Stop has a five-second helper grace period. After that, the main process
terminates the helper, finalizes all received PCM, and records a helper timeout.
Repeated Stop, Cancel, helper-exit, and window-shutdown requests share the same
in-flight finalization promise and cannot close the WAV twice.

Clean finalization therefore requires, in order: `stopped`; child `close` and
stdout EOF; parser drain; settled WAV writes; stream `finish`; header update;
terminal metadata; and publication rename. An unexpected exit, missing
`stopped`, non-empty parser tail, timeout, or forced pipe closure enters the same
barrier but produces `interrupted` if the accepted PCM can still be finalized.
If `close` or EOF does not arrive within five seconds after termination, the
supervisor destroys its pipe, rejects any partial frame, marks the recording
interrupted, and continues the barrier using only fully validated frames. A WAV
or publication failure produces `failed` and never exposes the staging directory
as a saved recording.

This ordering follows Node's child-process contract: `exit` can precede the end
of stdio, while `close` is emitted only after the process has ended and its stdio
streams have closed.

### Quit choreography

A main-process `QuitCoordinator` installs a synchronous `before-quit` listener
before any window or tray can request exit. Tray Quit, Cmd-Q, Dock Quit, and the
non-macOS `window-all-closed` path all call `app.quit()` and converge on this
listener; no recording path calls `app.exit()`.

The coordinator owns `quitRequested`, `allowQuit`, and one shared quit promise.
On `before-quit`:

1. If `allowQuit` is true, it returns and Electron continues terminating.
2. If the mutation coordinator has no owner and capture is idle, it returns
   without preventing the event.
3. Otherwise it calls `event.preventDefault()` synchronously, sets
   `quitRequested`, calls `RecordingMutationCoordinator.closeAndDrain()`, and
   asks an active capture owner to stop through its existing idempotent
   finalization promise. A recovery/Trash owner is allowed to reach its terminal
   result. Because the mutation lease is global, these owners cannot coexist;
   the quit promise nevertheless awaits `Promise.allSettled` over both the
   capture stop request, when present, and the coordinator drain promise.
   Repeated quit requests remain prevented and reuse that exact promise.
4. The renderer and tray show `Finishing recording before quitting…`; the tray
   Quit item is disabled, while no success claim is shown.
5. After every promise in the quit barrier settles, including publication or
   movement to recovery after failure, the coordinator sets `allowQuit` and calls
   `app.quit()` exactly once. The second `before-quit` pass is allowed through.

Quit never bypasses the helper grace period, pipe-close deadline, parser drain,
WAV finalization, metadata write, or publication/recovery decision. A
persistence failure still permits exit after its failed outcome and recovery
artifact are handled; it does not leave the application open indefinitely.
Forced process termination, machine power loss, and operating-system shutdown
paths that do not deliver `before-quit` remain outside the guarantee stated in
Non-goals.

### Publication and library visibility

Provisional data is never written directly to a public recording directory.
Completed and interrupted recordings are published only by the same-filesystem
directory rename described above. The target ID is selected and collision-
checked before capture, then checked again immediately before rename. A
collision or rename failure is terminal `persistence-error`, not permission to
overwrite an existing recording.

If persistence or publication fails after useful PCM exists, the supervisor
best-effort writes `status: "failed"` and moves the staging directory to
`.recovery/<session-uuid>`. If even that move fails, it leaves the data under
`.in-progress`. Both locations remain excluded from normal library and
transcription flows. Start cancellation and initialization failure with no PCM
remove their staging data.

The recordings library enumerates only direct child directories whose names
match the recording ID grammar. A new-format item is returned only when
`audio.wav` is a regular file, `capture.json` parses and validates, and its status
is `complete` or `interrupted`. Directories with provisional, failed, unknown,
or malformed metadata are excluded with a bounded diagnostic. For backward
compatibility, a matching directory with a regular `audio.wav` and no
`capture.json` is treated as legacy. Hidden staging/recovery directories and
symlinked audio files are never library items.

### Failed-recording recovery

Failed partial audio is local user data. It does not expire and is never deleted
automatically. The retention policy is explicit: Interview Copilot retains it
until the user successfully recovers it or moves it to the macOS Trash. This
avoids silently destroying a potentially valuable interview while giving the
user control over storage.

On startup and after any failed finalization, a main-process `RecoveryService`
enumerates `.recovery` and inactive `.in-progress` session directories. The
currently active session UUID is always excluded. An inactive in-progress item
is best-effort normalized into `.recovery`; failure to move it does not hide it
from the recovery service. The service rejects symlinks and paths outside the
recordings root, and exposes only a narrow typed item to the preload bridge:

```ts
interface RecordingRecoveryItem {
  id: string; // validated session UUID, never a path
  createdAt: string; // ISO 8601
  bytes: number; // non-negative safe integer
  state: 'recoverable' | 'not-recoverable';
}
```

The recordings home shows a compact `Recording recovery` notice whenever at
least one item exists, including item count and total local storage. Its review
view lists date, size, and either `Partial audio can be recovered` or `Partial
audio could not be repaired`. This is an inline recordings-home state rather
than a modal or a normal recording card.

`Recover recording` is available only for `recoverable` items. The recovery
service exclusively locks the item, verifies a regular `audio.wav`, derives PCM
length after the writer's fixed 44-byte provisional header rather than trusting
its stale length fields, rejects short, misaligned, or empty stereo PCM, repairs
the WAV into a new temporary file, and validates the result through the normal
WAV reader. It then writes
`capture.json` as `interrupted` with the original known interruptions plus a
`persistence-error` point event when one is not already present, and atomically
publishes the directory under a collision-checked recording ID. The item appears
in the library only after that rename succeeds. Recovery never relabels the item
`complete` and never promises that the ending or both channels are intact.

Every item also offers `Move to Trash`. A confirmation reads: `Move this partial
recording to Trash? It will no longer appear in Recording recovery. You can
restore it from Trash until Trash is emptied.` The main process revalidates and
locks the item immediately before using the platform Trash API. Cancellation or
Trash failure leaves the item untouched and visible. The global recording
mutation lease serializes Recover, Move to Trash, capture, and all publication.
Renderer requests contain an item ID only and cannot supply a filesystem path.

## Health and Recovery

Each channel has one of these runtime states:

- `connected`;
- `connected-with-gap`;
- `no-audio-detected`;
- `reconnecting`;
- `disconnected`.

`no-audio-detected` is a neutral observation after 30 seconds of exact digital
silence. It clears when non-zero PCM returns. It does not trigger reconstruction,
stop the recording, or create a confirmed interruption because legitimate
participant silence is indistinguishable from a zero-producing capture defect.

The following are confirmed failures and create an interruption when the
channel has none open, or strengthen runtime recovery behavior while preserving
the existing open interruption's ID and reason:

- an SCStream or AVAudioEngine error;
- no callback from a running source for two seconds;
- a native route invalidation;
- invalid or discontinuous source timestamps;
- source data arriving outside the jitter window;
- helper output queue overflow;
- helper exit, protocol failure, persistence failure, or stop timeout.

For a recoverable native-input failure other than late data, output overflow, or
a terminal helper failure, the helper:

1. marks the channel `reconnecting`;
2. continues the shared timeline with zero for that channel;
3. tears down and recreates that native input;
4. retries after 500 ms, 1 second, and 2 seconds;
5. marks the interruption recovered when timestamped callbacks resume;
6. after the fast retries are exhausted, leaves the channel `disconnected` and
   retries every 10 seconds until it recovers or recording stops; a relevant
   macOS route-change notification triggers an immediate attempt without
   resetting or multiplying the periodic retry loop.

The UI reads `Disconnected — retrying automatically` between low-frequency
attempts and `Reconnecting` only while an attempt is active. The surviving
channel continues throughout. Recovery closes the original interruption with
`recovered: true`; stopping while still disconnected closes it at the final
timeline block with `recovered: false`. The implementation does not stop trying
after the initial approximately 3.5-second fast-retry window and does not require
a renderer-owned reconnect command.

Late source data that falls outside the jitter window does not rebuild an
otherwise healthy input. At deadline expiry the helper emits the conservative
affected `late-data` block range, zero-fills that channel, and changes its visible
state from `connected` to `connected-with-gap` for the remainder of the session.
A subsequently arriving packet is discarded without reclassification.
Additional late ranges are coalesced only when contiguous. The UI uses a
persistent warning treatment: the channel remains connected, but the recording
contains an audio gap.

If contiguous missing coverage first classified as `source-gap` or `late-data`
later meets callback-stall or another rebuild criterion, the channel state moves
to `reconnecting` with that newer runtime reason and reconstruction begins. The
open interruption retains its original ID and reason. Resumed timestamped
coverage closes it with `recovered: true`; Stop or termination closes it with
`recovered: false`. No second interruption is opened for the escalation.

Output queue overflow similarly changes both visible channel states to
`connected-with-gap` after protocol output resumes. The channel rows state that
capture is connected but both channels contain the recorded overflow range.

Both native inputs being disconnected while the helper remains alive is
recoverable. The UI presents a critical recording warning and leaves Stop
available while the helper runs the independent retry policies. The helper does
not automatically restart on zero-valued PCM alone.

Helper exit and protocol failure are terminal, not recoverable channel states.
The main process automatically finalizes received PCM and `capture.json`, leaves
recording mode, refreshes the library, and reports that recording stopped. Stop
is no longer shown after terminal finalization begins. A successfully finalized
partial file is `interrupted`; a persistence or finalization failure is `failed`.

## Capture Metadata

Each new recording directory contains a local `capture.json` alongside
`audio.wav`. Version 1 records only operational capture facts:

```json
{
  "version": 1,
  "startedAt": "2026-08-12T00:00:00.000Z",
  "endedAt": "2026-08-12T01:00:00.000Z",
  "status": "interrupted",
  "channels": {
    "interviewer": { "started": true },
    "you": { "started": true }
  },
  "interruptions": [
    {
      "channel": "interviewer",
      "startMs": 900000,
      "endMs": 902200,
      "recovered": true,
      "reason": "callback-stall"
    }
  ]
}
```

Allowed recording statuses are `provisional`, `complete`, `interrupted`, and
`failed`. `provisional` is valid only inside `.in-progress` and is never a
library item.
`complete` means WAV finalization succeeded with no confirmed interruption.
`interrupted` means WAV finalization succeeded but at least one confirmed gap or
helper failure occurred, or the orderly RIFF format limit stopped capture.
`failed` means the application cannot claim a finalized recording; the library
must not present that item as saved audio.

Allowed interruption channels are `interviewer`, `you`, and `capture`. Allowed
reasons are `stream-error`, `callback-stall`, `route-invalidated`,
`timestamp-invalid`, `timestamp-discontinuity`, `source-gap`, `late-data`,
`buffer-overflow`, `helper-exit`, `protocol-error`, `persistence-error`, and
`stop-timeout`, plus capture-wide `format-limit`.
Initialization timeout and start cancellation occur before time zero, remove
their provisional files, and therefore do not create interruption entries.
`late-data` is channel-specific; `buffer-overflow` is capture-wide because both
interleaved channels are omitted.
Audio-loss reasons record a half-open timeline range `[startMs, endMs)`. For
channel loss this is the conservative 20 ms block range containing every
uncovered source frame; for capture-wide `buffer-overflow` it is the exact set of
whole PCM blocks that could not be delivered. A terminal control failure with no
additional audio-loss range records a point event with equal start and end
offsets. Every conversion is validated as `blockIndex * 20 <= 67,108,860`, and
every range must lie within the emitted timeline. Arbitrary native error strings
are not persisted.

The `format-limit` point event has `startMs == endMs == 67,108,860` and
`recovered: false`. It represents the orderly terminal boundary rather than
missing samples beyond the file; the helper never emits or the writer silently
drops a block after that boundary.

Metadata writes are atomic. Device names, meeting application names, process
identifiers, permission database details, raw native errors, private paths, and
audio-derived content are excluded.

Recordings without `capture.json` are legacy recordings. They remain
transcribable and are not retroactively labeled complete or interrupted.

## User Experience

While recording, the control panel shows one compact status row for
`Interviewer audio` and one for `Microphone` beneath the active recording
control. Healthy rows read `Connected` without occupying alert space.

- `Connected — audio gap detected` uses a persistent warning treatment while
  confirming that the channel is currently receiving callbacks.
- `No audio detected` uses a neutral treatment because silence may be expected.
- `Reconnecting` uses a warning treatment and explains that recording continues.
- `Disconnected` uses an error treatment and names the affected channel.
- Stop remains the dominant safe action in every state.

Confirmed recovery shows a bounded notice: the channel reconnected, the
recording continued, and a short gap may exist. It does not claim the audio is
complete.

A saved recording whose metadata status is `interrupted` shows `Audio
interrupted` on its library card. Transcription remains available.
The transcript UI continues to label channels as `Interviewer` and `You`; it
does not infer missing speech or hide an interruption badge.

Initialization errors state what failed, what was retained, and the next useful
action. Raw helper messages, stack traces, native error codes, and internal
process terms are never shown in the renderer.

During initialization, the primary status reads `Starting…` and the only capture
action is `Cancel`. Cancel returns to the idle Record state after cleanup. An
initialization timeout reads: `Recording could not start. No audio was saved.
Check recording permissions and try again.`

Unexpected helper exit automatically replaces the recording controls with an
error: `Recording stopped unexpectedly. The audio captured so far was saved.`
That saved claim appears only after WAV and metadata finalization succeed. A
persistence failure never recommends disk cleanup unless the operating system
identified a capacity condition:

- `ENOSPC` or `EDQUOT`: `Recording stopped because your Mac ran out of available
  storage. No recording was added. Free up space, then try again.`
- `EACCES`, `EPERM`, or a read-only destination: `Recording stopped because
  Interview Copilot could not write to the recordings folder. No recording was
  added. Check folder access, then try again.`
- write, stream, flush, header, close, or publication failures without a known
  capacity/access cause: `Recording stopped because the audio file could not be
  saved. No recording was added. Try again. If it happens again, restart
  Interview Copilot.`

The UI uses the safe category, not a raw errno or helper message. When useful
partial PCM was retained, the error appends: `Partial audio is available under
Recording recovery.` Otherwise it appends: `No usable audio was retained.` The
partial item is not described as saved or available in the normal recordings
library.

Successful recovery reads: `Partial recording recovered. The ending or one
audio channel may be incomplete.` The published card keeps the `Audio
interrupted` badge and offers transcription under the existing rules. Successful
Trash movement removes the recovery item and reads: `Partial recording moved to
Trash.`

Reaching the classic RIFF duration limit stops and finalizes capture before an
integer overflow. After successful publication the UI reads: `Recording stopped
after reaching the 18 hour 38 minute file limit. The audio captured so far was
saved.` The saved card remains `Audio interrupted`; the app does not wrap the
header fields or continue writing an invalid WAV. The saved claim is shown only
after the publication barrier succeeds.

## Permissions and Packaging

The existing supported target remains macOS 13 or newer on Apple Silicon.
Starting capture remains tied to the user's visible Record action.

The repository adds a reproducible Swift Package build that produces
`build/audio-capture/darwin-arm64/interview-audio-capture`. electron-builder
copies it to
`Contents/Resources/audio-capture/bin/interview-audio-capture`. Development and
packaged path resolution follow the existing sidecar pattern but use a separate
resolver and typed availability error.

The parent app and nested helper are signed together for release with the
required microphone and screen/audio usage descriptions and hardened-runtime
entitlements. The release acceptance gate requires macOS permission prompts and
System Settings entries to identify Interview Copilot clearly. A package that
attributes capture only to an unexplained helper name fails acceptance.

Unsigned local packages may be used for functional development, but they do not
prove release permission attribution, signing, or notarization. The packaged
verification distinguishes those credential-gated claims explicitly.

## Privacy and Security

Native capture does not change the data boundary:

- PCM moves only from the app-owned helper to the Electron main process over
  inherited local pipes.
- Audio remains on the Mac until the user explicitly selects transcription.
- Groq receives prepared audio only when Groq transcription is explicitly
  selected.
- Local Whisper remains local.

The helper has no network client, accepts no filesystem path, and inherits only
the minimum environment needed to run. The main process validates every helper
frame before allocation or persistence. stderr diagnostics are bounded and must
not include device names, interview content, paths, or PCM.

## Migration and Removal

The WAV channel order, filename, sample rate, recording directory ID, and
transcription inputs do not change. No existing recording migration is needed.

After native capture passes the packaged acceptance tests, implementation
removes:

- renderer `AudioCapture` and AudioWorklet capture code;
- display-media and microphone acquisition from the renderer;
- the renderer-to-main `audio-data` IPC path;
- Electron's loopback display-media handler when it has no remaining caller;
- tests and bundling configuration used only by the removed worklet.

Architecture, development, privacy, and packaging documentation are updated in
the same implementation change. Dead fallback code is not retained.

## Verification

Implementation follows focused TDD at each boundary.

### Swift tests

- convert supported native formats to 16 kHz mono PCM;
- validate ScreenCaptureKit PTS and AVAudioTime host/sample representations;
- convert `SCStream.synchronizationClock` and AVAudioTime values to the common
  host clock and align them onto 20 ms windows;
- reject a missing ScreenCaptureKit synchronization clock, invalid PTS, missing
  microphone anchor, timestamp regression, and timestamp discontinuity;
- correct drift without moving the other channel;
- trim overlap, fill source-specific gaps with zero, and emit an interruption for
  every partially or fully uncovered 20 ms block;
- prove 20 ms, 40 ms, and 180 ms timestamp holes prevent `complete` without
  rebuilding the source, while a covered all-zero callback does not;
- classify a provable timestamp hole as `source-gap`, classify an uncovered
  jitter-deadline expiry as `late-data`, discard a later packet without an
  update or duplicate interruption, and preserve the final reason;
- stop during open `source-gap` and `late-data` ranges and close each at the
  final timeline boundary with its original reason and `recovered: false`;
- escalate an open `late-data` loss to runtime `callback-stall`, retain the
  original interruption ID/reason without nesting or closing it, then verify a
  true close on resumed coverage and a false close on Stop;
- report a one-frame hole as a conservative whole-block interruption and never
  claim sample-level range precision;
- bound the jitter buffer, report conservative late-data block ranges, and enter
  `connected-with-gap` without restarting a healthy input;
- bound the non-realtime output queue, replace overflow spans with `gap` frames,
  and preserve total timeline duration;
- count PCM and synthesized gap blocks against one RIFF cap; split a long gap
  into bounded frames, clip its final frame exactly at `MAX_BLOCKS`, then emit
  `stopped: format-limit` without another timeline frame;
- emit matched interruption open/close frames with conservative channel block
  ranges, reasons, and recovery outcomes;
- transition through callback stall, fast retries, periodic 10-second retries,
  route-triggered retry, recovery, and disconnection;
- frame protocol messages deterministically, run the shared valid/invalid
  payload fixture corpus, and reject invalid control input;
- drain complete blocks and report final counters on Stop.

### TypeScript tests

- resolve development and packaged helper paths safely;
- acquire the Electron single-instance lock before readiness or recordings-root
  access; make a losing instance quit without scanning recovery, and focus the
  primary window on `second-instance`;
- reject missing, non-executable, wrong-architecture, and malformed helpers;
- validate protocol magic, version, length, sequence, type, PCM block size, gap
  bounds, closed `GapPayload` and `InterruptionPayload` schemas, UInt32
  interruption ID uniqueness, interruption lifecycle invariants, exact counter
  relationships, unknown fields, indices above 3,355,443, ranges beyond the
  emitted timeline, and the 64 KiB parser limit;
- with `pcmBlocks + gapBlocks == MAX_BLOCKS - 2`, accept a two-block gap ending
  at the boundary, synthesize exactly two zero blocks, and reject a three-block
  gap without writing either block; reject empty, reversed, noncontiguous, and
  greater-than-3,000-block gaps;
- reject mismatched interruption closes, reused/overflowing IDs, opens away from
  the next persisted block, closes away from the next persisted boundary, and
  reason/recovery combinations that violate the closed contract;
- accept unrecovered Stop/termination closes for every source reason, reject an
  in-session unrecovered close, and reject any attempt to replace or nest an
  open `late-data` interruption when runtime state escalates to callback stall;
- serialize start, cancel, stop, and terminal finalization and prevent concurrent
  sessions;
- expose `Starting…`, allow Cancel, enforce the 60-second initialization
  deadline, and ignore late helper events after cleanup begins;
- pause helper stdout on WAV backpressure, resume only on `drain`, and preserve
  frame order;
- simulate `exit` before trailing stdout data and prove finalization waits for
  child `close`, stdout EOF, parser drain, pending writes, stream `finish`, and
  header update in that order;
- reject a partial protocol frame at EOF and close any still-open source
  interruption as unrecovered after unexpected helper termination;
- synchronously prevent `before-quit` during starting, recording, stopping, and
  failed finalization; close the global mutation coordinator, await the capture
  and drain promises with `allSettled`, reuse one quit promise across repeated
  Quit requests, and allow the second event through;
- serialize capture, publication, recovery, and Trash under one mutation lease;
  disable conflicting actions and release only after terminal cleanup;
- route tray, Cmd-Q, Dock, and `window-all-closed` quit requests through the same
  coordinator and prohibit `app.exit()` from bypassing it;
- continuously drain more than one pipe capacity of valid, malformed, and
  oversized stderr while stdout PCM continues; verify bounded memory, rate
  limiting, sanitization, and no raw-tail retention;
- finalize WAV and metadata after normal Stop, helper exit, protocol failure,
  single-channel failure, late data, output overflow, and stop timeout;
- inject open, disk-full, write, stream, flush, header-update, and close failures
  and verify no path claims that the recording was saved;
- stage provisional files outside the public ID namespace, atomically publish
  complete/interrupted recordings, and exclude provisional, failed, malformed,
  hidden, and symlinked items while retaining legacy recordings;
- enumerate failed and inactive provisional recovery items without exposing
  paths; exclude the active session and retain items across restart until the
  user acts;
- recover aligned partial PCM through a repaired temporary WAV and atomic
  interrupted publication; reject empty, misaligned, symlinked, and escaping
  artifacts without modifying them;
- confirm Move to Trash, preserve the item on cancellation or platform failure,
  and serialize recovery, Trash, and capture operations;
- map capacity, access, and generic persistence failures to distinct safe copy;
- expose typed renderer status without raw native details;
- read legacy recordings without `capture.json`;
- preserve transcription for interrupted recordings;
- render starting, cancellation, all channel health, terminal helper exit,
  persistence failure, recovery notice/list, confirmation, recovery outcome,
  Trash failure, and saved interruption states accessibly.

### Integration and packaged verification

- feed deterministic dual-rate fixtures through the real helper protocol and
  verify channel order, duration, and a maximum 20 ms drift after 60 minutes;
- record a synchronized impulse train through real ScreenCaptureKit system audio
  and the default microphone for 60 minutes, verify that inter-channel offset
  remains within 20 ms of its calibrated initial offset, then use the helper's
  test seam to force one timestamp discontinuity and confirm recovery;
- run `npm test`, `npx tsc --noEmit`, `npm run build`, and the Electron E2E smoke
  test;
- verify the Swift executable is arm64, executable, embedded at the resolved
  packaged path, and included in packaging checks;
- inspect the 400 x 600 Electron surface for starting, connected,
  connected-with-gap, silent, reconnecting, disconnected, terminal failure,
  recovered, failed-recording recovery, and saved-interruption states;
- verify keyboard order, accessible names, Stop availability, and long recording
  titles in each changed state;
- run a signed packaged recording for 60 minutes while muting and unmuting the
  meeting microphone at least 20 times;
- confirm both channels remain audible, channel drift stays within 20 ms, Stop
  produces a structurally valid finalized WAV, and permission ownership is
  presented as Interview Copilot;
- induce system and microphone callback failures independently and confirm
  surviving-channel continuity, recovery metadata, and truthful UI state;
- throttle stdout and inject a full-disk persistence failure in a disposable
  recording directory, then verify bounded memory, zero-filled overflow ranges,
  automatic terminal cleanup, the absence of saved-recording claims, and the
  explicit recovery/Trash flow after restart;
- flood helper stderr beyond operating-system pipe capacity during a dual-channel
  fixture and confirm PCM continuity and bounded main-process diagnostics;
- request Quit from the tray during active capture and confirm the process stays
  alive until WAV publication or recovery handling completes;
- run capture to the RIFF block cap, reject the next block without numeric
  overflow, and verify an interrupted valid WAV plus truthful limit copy;
- attempt a command-line second launch during active capture and confirm it
  cannot enumerate, recover, or move the primary instance's staging item.

Real ScreenCaptureKit, TCC, signing, and 60-minute audio behavior cannot be
claimed from mocks or an unsigned package. If credential-gated verification is
not available, the implementation report must identify those checks as
unverified rather than calling the feature production-ready.

## Evidence and References

- Local production evidence:
  `2026-08-11T02-30-23-541Z/audio.wav` and
  `2026-08-10T03-29-32-709Z/audio.wav`.
- [Apple ScreenCaptureKit documentation](https://developer.apple.com/documentation/screencapturekit)
- [Apple `SCStream.synchronizationClock` documentation](https://developer.apple.com/documentation/screencapturekit/scstream/synchronizationclock)
- [Apple `AVAudioTime` documentation](https://developer.apple.com/documentation/avfaudio/avaudiotime)
- [Apple `CMSampleBuffer.presentationTimeStamp` documentation](https://developer.apple.com/documentation/coremedia/cmsamplebuffer/presentationtimestamp)
- [Apple Core Media host-clock documentation](https://developer.apple.com/documentation/coremedia/cmclock-api)
- [Apple Core Audio Process Tap documentation](https://developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps)
- [Apple Developer Forums: Core Audio](https://developer.apple.com/forums/tags/core-audio)
  includes the macOS 26.5 report titled
  `AudioHardwareCreateProcessTap delivers all-zero buffers while system audio is audible`.
- [Electron `setDisplayMediaRequestHandler` documentation](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts)
- [Electron issue #47490: use ScreenCaptureKit for macOS loopback](https://github.com/electron/electron/issues/47490)
- [Electron app lifecycle documentation](https://www.electronjs.org/docs/latest/api/app#event-before-quit)
  defines synchronous `before-quit` cancellation with `preventDefault()`.
- [Electron single-instance documentation](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata)
  requires a process that loses the application lock to quit immediately.
- [Node.js child process events](https://nodejs.org/api/child_process.html#event-close)
  defines `close` after process termination and stdio closure and warns that
  stdio may still be open when `exit` fires.

## Risks

- ScreenCaptureKit can still encounter platform defects. Explicit native errors,
  callback stalls, capture metadata, and a supervised rebuild path limit the
  damage without pretending that sample silence is diagnosable.
- Separate native source clocks can drift. Host-time placement and a bounded
  jitter buffer are required; independent frame counting is not acceptable.
- A native helper expands packaging and signing work. The helper is intentionally
  narrow, app-owned, offline, and covered by development and packaged gates.
- Permission attribution can differ between development and signed packages.
  Only the signed packaged result can satisfy the user-facing permission
  acceptance criterion.
- Automatic restart can create short gaps. The shared timeline, zero fill,
  persisted interruption range, and visible recovery notice preserve temporal
  truth.
