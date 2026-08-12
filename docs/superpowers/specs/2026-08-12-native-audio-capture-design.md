# Native macOS Audio Capture Design

**Date:** 2026-08-12
**Status:** Draft for written review

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

The existing context-isolated preload bridge remains narrow. It carries recording
commands and typed status snapshots only; it does not expose child-process,
filesystem, ScreenCaptureKit, or AVAudioEngine APIs.

### Electron main process

The main process owns a `NativeCaptureSession` supervisor. It:

1. resolves and validates the helper executable;
2. creates the recording directory and provisional capture metadata;
3. starts the helper after the visible Record action;
4. validates framed helper output;
5. writes PCM through the existing WAV persistence boundary;
6. persists confirmed interruptions;
7. broadcasts bounded health snapshots to the renderer;
8. stops the helper and finalizes the WAV header.

Only one capture session may exist at a time. Start, stop, helper exit, and
window shutdown converge on one idempotent finalization path. Session state is
an explicit `idle` → `starting` → `recording` → `stopping` → `idle` machine;
terminal failures may move from `starting` or `recording` directly through
finalization to `idle`.

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

This makes drift correction timestamp-driven. A delayed source cannot move the
other channel or change the duration of an already emitted block. The helper
maintains a bounded jitter buffer of 200 ms; data arriving later than that window
is reported as a `late-data` source interruption rather than rewriting PCM
already persisted.

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
- four-byte unsigned little-endian, monotonically increasing sequence number.

`pcm` payloads are exactly 1,280 bytes: 320 frames × two channels × two bytes.
The other frame types use UTF-8 JSON payloads capped at 4 KiB and validated
against closed TypeScript interfaces before use.

Frame types are:

- `ready`: validated capture format and initial channel states;
- `pcm`: exactly one 20 ms interleaved stereo block;
- `gap`: an exact capture-wide range of between 1 and 3,000 consecutive 20 ms
  blocks that output overflow prevented the helper from delivering; longer gaps
  use consecutive frames;
- `interruption`: a channel-specific interruption lifecycle event;
- `state`: typed channel transition or recent audio-presence summary;
- `stopped`: final helper counters;
- `error`: typed, safe failure information.

`interruption` is a closed tagged union. An opened event contains `phase:
"opened"`, a session-unique unsigned `id`, `channel`, `startBlock`, and `reason`.
A closed event repeats the same `id`, `channel`, `startBlock`, and `reason`, and
adds `phase: "closed"`, `endBlockExclusive`, and `recovered`. Blocks are helper
timeline block numbers, so the half-open range maps exactly to milliseconds by
multiplying by 20. `channel` is `interviewer` or `you`; capture-wide output loss
uses `gap` instead. Late data may emit an opened event immediately followed by
its closed event without changing the source to `reconnecting`.

The main process permits at most one open interruption per channel, rejects an
unknown or duplicate ID, requires the fields repeated by a close to match its
open, and requires `endBlockExclusive >= startBlock`. Only a matched close is
persisted. If the helper terminates with an open interruption, the main process
closes it at the next expected timeline block with `recovered: false` before it
adds the capture-wide terminal point event. Consequently every persisted
channel interruption has an exact range, reason, and recovery outcome even when
the helper exits during recovery.

A `gap` payload contains `channel: "capture"`, `startBlock`,
`endBlockExclusive`, `reason: "buffer-overflow"`, and `recovered: true`. It both
instructs the main process to append the corresponding all-zero stereo blocks
and supplies the complete capture-wide interruption record. Gap ranges must be
contiguous with the protocol timeline and must not overlap PCM.

Control input on stdin is versioned newline-delimited JSON capped at 1 KiB per
line. The initial implementation supports only `stop`; reconnects are
helper-owned state transitions rather than arbitrary renderer commands.

The main process rejects invalid magic, unsupported versions, oversized
payloads, sequence regressions, PCM frames of the wrong length, and unknown
state values. A protocol violation is treated as helper failure and enters the
same preservation and finalization path as an unexpected helper exit.

## Buffering, Backpressure, and Persistence

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
in the hidden recovery location for possible manual recovery but are not exposed
as saved recordings. The renderer leaves recording mode and states what failed,
what was not published, and the next safe action when the category is known.

## Recording Lifecycle

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
   closes any open interruption, emits `stopped`, closes stdout, and exits.
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
`.in-progress`. Both locations are hidden implementation-owned recovery areas,
are excluded from normal library and transcription flows, and are not deleted
automatically. Start cancellation and initialization failure with only a WAV
header remove their staging data.

The recordings library enumerates only direct child directories whose names
match the recording ID grammar. A new-format item is returned only when
`audio.wav` is a regular file, `capture.json` parses and validates, and its status
is `complete` or `interrupted`. Directories with provisional, failed, unknown,
or malformed metadata are excluded with a bounded diagnostic. For backward
compatibility, a matching directory with a regular `audio.wav` and no
`capture.json` is treated as legacy. Hidden staging/recovery directories and
symlinked audio files are never library items.

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

The following are confirmed failures and do create interruptions:

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
otherwise healthy input. The helper emits the exact affected `late-data` range,
zero-fills that channel, and changes its visible state from `connected` to
`connected-with-gap` for the remainder of the session. Additional late ranges
are coalesced only when contiguous. The UI uses a persistent warning treatment:
the channel remains connected, but the recording contains an audio gap.

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
helper failure occurred. `failed` means the application cannot claim a finalized
recording; the library must not present that item as saved audio.

Allowed interruption channels are `interviewer`, `you`, and `capture`. Allowed
reasons are `stream-error`, `callback-stall`, `route-invalidated`,
`timestamp-invalid`, `timestamp-discontinuity`, `late-data`, `buffer-overflow`,
`helper-exit`, `protocol-error`, `persistence-error`, and `stop-timeout`.
Initialization timeout and start cancellation occur before time zero, remove
their provisional files, and therefore do not create interruption entries.
`late-data` is channel-specific; `buffer-overflow` is capture-wide because both
interleaved channels are omitted.
Audio-loss reasons record the exact half-open timeline range `[startMs, endMs)`
that was replaced by zero or could not be persisted. A terminal control failure
with no additional audio-loss range records a point event with equal start and
end offsets. Arbitrary native error strings are not persisted.

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

The UI uses the safe category, not a raw errno or helper message. If a partial
file remains in the hidden recovery area, the app does not imply that the user
can open it from the recordings library.

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
- trim overlap and fill source-specific gaps with zero;
- bound the jitter buffer, report exact late-data ranges, and enter
  `connected-with-gap` without restarting a healthy input;
- bound the non-realtime output queue, replace overflow spans with `gap` frames,
  and preserve total timeline duration;
- emit matched interruption open/close frames with exact channel block ranges,
  reasons, and recovery outcomes;
- transition through callback stall, fast retries, periodic 10-second retries,
  route-triggered retry, recovery, and disconnection;
- frame protocol messages deterministically and reject invalid control input;
- drain complete blocks and report final counters on Stop.

### TypeScript tests

- resolve development and packaged helper paths safely;
- reject missing, non-executable, wrong-architecture, and malformed helpers;
- validate protocol magic, version, length, sequence, type, PCM block size, gap
  bounds, interruption lifecycle invariants, and the 64 KiB parser limit;
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
- finalize WAV and metadata after normal Stop, helper exit, protocol failure,
  single-channel failure, late data, output overflow, and stop timeout;
- inject open, disk-full, write, stream, flush, header-update, and close failures
  and verify no path claims that the recording was saved;
- stage provisional files outside the public ID namespace, atomically publish
  complete/interrupted recordings, and exclude provisional, failed, malformed,
  hidden, and symlinked items while retaining legacy recordings;
- map capacity, access, and generic persistence failures to distinct safe copy;
- expose typed renderer status without raw native details;
- read legacy recordings without `capture.json`;
- preserve transcription for interrupted recordings;
- render starting, cancellation, all channel health, terminal helper exit,
  persistence failure, and saved interruption states accessibly.

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
  recovered, and saved-interruption states;
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
  automatic terminal cleanup, and the absence of saved-recording claims.

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
