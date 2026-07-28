# Local Whisper Reliability and Diagnostics Design

**Date:** 2026-07-28
**Status:** Revised; pending final review

## Context

Local Whisper is the preferred transcription provider because it keeps interview
audio on the Mac and avoids Groq upload limits. The current implementation starts
`whisper-cli` with Metal enabled and retries without GPU after a non-zero exit.
It also passes both progress printing and `--no-prints`, then discards all child
stdout and stderr.

The production recording `2026-07-28T02-28-22-392Z` exposed two reliability
problems:

- Metal failed while loading the pinned Large V3 Turbo Q5 model with exit 139
  after `ggml_metal_buffer_init` could not allocate a 7.33 MiB buffer.
- The same complete 34 minute 30 second interviewer channel succeeded on CPU,
  produced full JSON, and exited 0 in about 7 minutes 47 seconds.

The generic `LOCAL_TRANSCRIPTION_FAILED` log did not preserve enough safe
diagnostic information to distinguish model loading, Metal allocation, process
exit, timeout, or output parsing failures.

## Goal

A user can select Local Whisper, transcribe a long saved recording reliably on
the supported Apple Silicon target, and open a non-empty transcript without
using Groq.

When local transcription fails, the terminal log must identify the failed
process phase and safe sidecar reason without exposing interview text, API keys,
or private filesystem paths. The original `audio.wav` remains untouched and a
retry remains possible.

## Non-goals

- Re-enable or tune Metal acceleration.
- Add a CPU/GPU setting or benchmarking UI.
- Add temporal chunking to Local Whisper.
- Change the Groq upload pipeline.
- Persist transcription jobs across app restarts.
- Display raw sidecar diagnostics in the renderer.

## Runtime Decision

Local Whisper will be CPU-first on the currently supported macOS Apple Silicon
target. `LocalWhisperProvider` invokes `whisper-cli` once with GPU disabled.
There is no speculative Metal attempt and no second process retry.

This prioritizes a verified transcript over peak speed. It also avoids spending
time and memory on a Metal process that is known to fail on the target machine.
GPU acceleration can return only after a separately verified compatibility
change.

The CPU-only contract replaces the retry machinery rather than leaving an
unreachable fallback path. Implementation removes `useGpu` from
`WhisperProcessInput`, `retryWithoutGpu` from `WhisperProcessError`, and the
Metal-to-CPU retry block in `LocalWhisperProvider`. Existing GPU-retry tests are
rewritten to assert one CPU invocation.

The existing sequential channel order remains:

1. Split the recording into system and microphone mono WAV files.
2. Transcribe the system channel on CPU.
3. Transcribe the microphone channel on CPU.
4. Apply audible-coverage filtering to both normalized segment lists.
5. Merge by timestamp and atomically write `transcript.json`.

No audio leaves the Mac.

## Process Activity and Supervision

The CLI will keep progress printing enabled and will no longer pass `-np`.
Any stdout or stderr data refreshes the existing five-minute activity watchdog.
The hard deadline remains
`max(15 minutes, 2 × channel duration)`.

The successful 7 minute 47 second CPU reproduction was a direct CLI run without
`-np`; it does not prove the current supervised `-np` invocation remains active.
Removing `-np` is defense-in-depth: progress and diagnostics provide liveness
on slower machines and evidence on failure. It is not claimed as the cause of
the observed 119-second failure. Child output is not forwarded wholesale to the
application log.

Timeout handling remains `SIGTERM`, a five-second grace period, then `SIGKILL`.
The terminal log records whether inactivity or the hard deadline initiated
termination.

## Safe Debug Logging

`WhisperProcessRunner` will receive a separate narrow
`WhisperProcessLogger`. It is not an extension of the recording/stage-shaped
`TranscriptionLogger`. Its contract is one
`log(event: WhisperProcessLogEvent): void` method over a discriminated event
union:

- `start`: execution mode (`cpu`), child PID, and channel duration;
- `terminate`: `inactivity` or `hard-deadline`;
- `exit`: elapsed time, numeric exit code or signal, and whether JSON was read;
- `failure`: typed error code, process phase, and bounded diagnostic summary.

No event field accepts an arbitrary command line, environment object, audio
path, model path, output path, or transcript payload.

The two child streams have explicit privacy roles:

- stdout is a liveness signal only. It is never stored in the diagnostic
  collector and never logged because `whisper-cli` writes recognized transcript
  lines to stdout.
- stderr is both a liveness signal and the only input to the sanitized
  diagnostic collector.

The stderr collector treats both carriage return and newline as line
boundaries, so in-place progress updates cannot grow an unbounded partial line.
It truncates each retained line to 512 characters and keeps at most 4,096
characters across the diagnostic tail. Before a stderr line can be logged, it
must:

1. Drop transcript-shaped timestamp lines as defense-in-depth if a future CLI
   version changes stream behavior.
2. Redact absolute input, model, and output paths.
3. Drop empty lines and cap individual line and total diagnostic length.
4. Never include API keys, environment dumps, or JSON transcript content.

Known CPU-side diagnostics such as model-load errors, process signals, and
output-write failures remain visible after sanitization. Successful
transcription does not print recognized interview text.

The outer orchestration log continues to identify the recording ID and stage.
The process log supplies the missing child-process reason.

## Error Behavior

- A spawn failure returns `LOCAL_TRANSCRIPTION_FAILED`; the process log records
  the `spawn` phase.
- A non-zero exit or signal returns `LOCAL_TRANSCRIPTION_FAILED`; the process
  log records the safe exit reason and diagnostic tail.
- Inactivity and hard-deadline termination return
  `LOCAL_TRANSCRIPTION_TIMEOUT`; the terminal process log identifies the
  triggering watchdog. The watchdog name is not added to
  `TranscriptionError.details`.
- Exit 0 followed by a missing or unreadable JSON result returns
  `LOCAL_TRANSCRIPTION_FAILED`; the process log identifies `output-read`.
- Malformed parsed JSON returns `LOCAL_TRANSCRIPTION_FAILED`; the outer
  orchestration stage and typed code remain safe, with no transcript content
  added to logs.
- Cleanup preserves the original recording and any previously valid
  `transcript.json`.

The existing user-facing recovery message remains appropriate; raw debug
details stay in the terminal.

## Verification

Implementation follows focused TDD:

- assert the local provider invokes one CPU process and contains no GPU retry
  machinery;
- assert CLI arguments include `-ng` and omit `-np`;
- assert child output refreshes the inactivity watchdog;
- assert lifecycle logs contain mode, elapsed time, exit code or signal, and
  watchdog reason;
- assert stdout never enters logs, stderr transcript-shaped lines are excluded,
  `\r` and `\n` are normalized, paths are redacted, and diagnostics are bounded;
- assert spawn, signal, timeout, output-read, and successful JSON paths retain
  their typed outcomes;
- run the focused local-provider and process-runner suites;
- run `npm test`, `npx tsc --noEmit`, and `npm run build`;
- update `docs/architecture.md` to record CPU-first local execution and
  `docs/privacy.md` to record sanitized sidecar diagnostics;
- run the real recording `2026-07-28T02-28-22-392Z` through both local channels
  and verify the resulting `transcript.json` contains readable segments from
  both available channels and opens from the recordings list.

No renderer structure changes are planned, so visual layout changes and new E2E
screenshots are out of scope. The existing Electron smoke test remains a final
regression check if the main-process build changes affect app startup.
