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
- A helper or single-channel failure leaves a finalized, playable WAV containing
  all PCM delivered before and during the surviving-channel period.
- Existing recordings remain readable without migration.

## Non-goals

- Windows or Linux capture support.
- Speaker diarization or identity inference. The labels continue to describe
  channels only.
- Capturing video or screen pixels.
- Installing BlackHole, Loopback, or another virtual audio driver.
- Eliminating legitimate acoustic leakage from speakers into the microphone.
- Automatically treating sample-level silence as proof of capture failure.
- Changing playback, transcription providers, export formats, or the existing
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
window shutdown converge on one idempotent finalization path.

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
audio on channel 1/right. This preserves the existing WAV, playback,
channel-splitting, and transcription contracts.

## Synchronization

The helper chooses the first host-time boundary after both native inputs have
started as recording time zero. It does not derive position by independently
counting callback frames.

Both inputs are placed on a shared sequence of 20 ms host-time windows:

1. Convert source timestamps to the common macOS host-time domain.
2. Resample source PCM into the target window.
3. Trim overlap already assigned to an earlier window.
4. Insert zero only for the missing source portion of a window.
5. Interleave the completed left and right windows.

This makes drift correction timestamp-driven. A delayed source cannot move the
other channel or change the duration of an already emitted block. The helper
maintains a bounded jitter buffer of 200 ms; data arriving later than that window
is reported as a source gap rather than rewriting PCM already persisted.

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
- `state`: typed channel transition or recent audio-presence summary;
- `stopped`: final helper counters;
- `error`: typed, safe failure information.

Control input on stdin is versioned newline-delimited JSON capped at 1 KiB per
line. The initial implementation supports only `stop`; reconnects are
helper-owned state transitions rather than arbitrary renderer commands.

The main process rejects invalid magic, unsupported versions, oversized
payloads, sequence regressions, PCM frames of the wrong length, and unknown
state values. A protocol violation is treated as helper failure and enters the
same preservation and finalization path as an unexpected helper exit.

## Recording Lifecycle

### Start

1. The visible Record action checks the current screen/audio and microphone
   permission snapshot.
2. The main process creates the recording directory, opens provisional WAV
   persistence, and writes provisional `capture.json` metadata.
3. The main process resolves and spawns the helper.
4. The helper starts ScreenCaptureKit and AVAudioEngine.
5. The helper reports `ready` only after both sources are running and have
   delivered timestamped callbacks. The callbacks may contain silence. It emits
   `ready` before the first buffered `pcm` frame.
6. The main process validates `ready` and acknowledges recording start.
7. Only then does the renderer show `Recording` and the tray show the active
   state.

If any step fails, all partially created native resources are stopped. An empty
or header-only recording is removed from the library; a recording containing
PCM is finalized and retained as interrupted.

### Stop

1. Stop remains available from the control panel and tray.
2. The main process sends the helper a `stop` control message.
3. The helper stops accepting new callbacks, drains complete timeline windows,
   emits `stopped`, and exits.
4. The main process closes the WAV writer, updates the WAV header, finalizes
   `capture.json`, and refreshes the recordings library.

Stop has a five-second helper grace period. After that, the main process
terminates the helper, finalizes all received PCM, and records a helper timeout.

## Health and Recovery

Each channel has one of these runtime states:

- `connected`;
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
- helper exit, protocol failure, or stop timeout.

For a single-source confirmed failure, the helper:

1. marks the channel `reconnecting`;
2. continues the shared timeline with zero for that channel;
3. tears down and recreates that native input;
4. retries after 500 ms, 1 second, and 2 seconds;
5. marks the interruption recovered when timestamped callbacks resume;
6. otherwise leaves the channel `disconnected` while the surviving channel
   continues.

Both channels failing does not discard the file. The UI presents a critical
recording warning and leaves Stop available. The helper does not automatically
restart on zero-valued PCM alone.

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

Allowed recording statuses are `complete`, `interrupted`, and `failed`.
`complete` means WAV finalization succeeded with no confirmed interruption.
`interrupted` means WAV finalization succeeded but at least one confirmed gap or
helper failure occurred. `failed` means the application cannot claim a playable
finalized recording; the library must not present that item as saved audio.

Allowed interruption channels are `interviewer`, `you`, and `capture`. Allowed
reasons are `stream-error`, `callback-stall`, `route-invalidated`, `helper-exit`,
`protocol-error`, and `stop-timeout`. Arbitrary native error strings are not
persisted.

Metadata writes are atomic. Device names, meeting application names, process
identifiers, permission database details, raw native errors, private paths, and
audio-derived content are excluded.

Recordings without `capture.json` are legacy recordings. They remain playable
and transcribable and are not retroactively labeled complete or interrupted.

## User Experience

While recording, the control panel shows one compact status row for
`Interviewer audio` and one for `Microphone` beneath the active recording
control. Healthy rows read `Connected` without occupying alert space.

- `No audio detected` uses a neutral treatment because silence may be expected.
- `Reconnecting` uses a warning treatment and explains that recording continues.
- `Disconnected` uses an error treatment and names the affected channel.
- Stop remains the dominant safe action in every state.

Confirmed recovery shows a bounded notice: the channel reconnected, the
recording continued, and a short gap may exist. It does not claim the audio is
complete.

A saved recording whose metadata status is `interrupted` shows `Audio
interrupted` on its library card. Playback and transcription remain available.
The transcript UI continues to label channels as `Interviewer` and `You`; it
does not infer missing speech or hide an interruption badge.

Initialization errors state what failed, what was retained, and the next useful
action. Raw helper messages, stack traces, native error codes, and internal
process terms are never shown in the renderer.

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
- align timestamped sources onto 20 ms host-time windows;
- correct drift without moving the other channel;
- trim overlap and fill source-specific gaps with zero;
- bound the jitter buffer and report late data;
- transition through callback stall, retry, recovery, and disconnection;
- frame protocol messages deterministically and reject invalid control input;
- drain complete blocks and report final counters on Stop.

### TypeScript tests

- resolve development and packaged helper paths safely;
- reject missing, non-executable, wrong-architecture, and malformed helpers;
- validate protocol magic, version, length, sequence, type, and PCM block size;
- serialize start and stop and prevent concurrent sessions;
- finalize WAV and metadata after normal Stop, helper exit, protocol failure,
  single-channel failure, and stop timeout;
- expose typed renderer status without raw native details;
- read legacy recordings without `capture.json`;
- preserve playback and transcription for interrupted recordings;
- render all channel health and saved interruption states accessibly.

### Integration and packaged verification

- feed deterministic dual-rate fixtures through the real helper protocol and
  verify channel order, duration, and a maximum 20 ms drift after 60 minutes;
- run `npm test`, `npx tsc --noEmit`, `npm run build`, and the Electron E2E smoke
  test;
- verify the Swift executable is arm64, executable, embedded at the resolved
  packaged path, and included in packaging checks;
- inspect the 400 x 600 Electron surface for connected, silent, reconnecting,
  disconnected, recovered, and saved-interruption states;
- verify keyboard order, accessible names, Stop availability, and long recording
  titles in each changed state;
- run a signed packaged recording for 60 minutes while muting and unmuting the
  meeting microphone at least 20 times;
- confirm both channels remain audible, channel drift stays within 20 ms, Stop
  produces a playable WAV, and permission ownership is presented as Interview
  Copilot;
- induce system and microphone callback failures independently and confirm
  surviving-channel continuity, recovery metadata, and truthful UI state.

Real ScreenCaptureKit, TCC, signing, and 60-minute audio behavior cannot be
claimed from mocks or an unsigned package. If credential-gated verification is
not available, the implementation report must identify those checks as
unverified rather than calling the feature production-ready.

## Evidence and References

- Local production evidence:
  `2026-08-11T02-30-23-541Z/audio.wav` and
  `2026-08-10T03-29-32-709Z/audio.wav`.
- [Apple ScreenCaptureKit documentation](https://developer.apple.com/documentation/screencapturekit)
- [Apple Core Audio Process Tap documentation](https://developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps)
- [Apple Developer Forums: Core Audio](https://developer.apple.com/forums/tags/core-audio)
  includes the macOS 26.5 report titled
  `AudioHardwareCreateProcessTap delivers all-zero buffers while system audio is audible`.
- [Electron `setDisplayMediaRequestHandler` documentation](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts)
- [Electron issue #47490: use ScreenCaptureKit for macOS loopback](https://github.com/electron/electron/issues/47490)

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
