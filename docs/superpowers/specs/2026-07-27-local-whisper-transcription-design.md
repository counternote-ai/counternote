# Local-First Whisper Transcription Design

## Summary

Interview Copilot will support two explicit transcription providers:

- **Local Whisper** is the default and runs `whisper.cpp` entirely on the Mac.
- **Groq** remains available as an opt-in cloud provider.

The app will never fall back from Local Whisper to Groq automatically. Audio is
sent to Groq only when the user has selected Groq in Settings and starts a
transcription.

This change removes cloud rate limits from the default path, makes the product's
local-first promise literal, and hardens both providers so failed transcription
never endangers the original recording or leaves blocking temporary files.

## Relationship to Maintainability Remediation

This spec is the detailed implementation authority for the transcription work
identified in Phase 5 of
[`2026-07-26-maintainability-remediation-design.md`](2026-07-26-maintainability-remediation-design.md).
It supersedes that phase's transcription-reliability bullets by incorporating
and expanding them: `finally` cleanup, non-blocking ffmpeg retries, Groq response
validation, narrow error codes, and a dedicated transcription-orchestration
module. Phase 5 remains authoritative for unrelated shared contracts, IPC path
confinement, listener lifecycle, and main-process boundaries.

This work assumes these earlier remediation deliverables:

- **Phase 1:** Remove `autoTranscribe` from config, IPC, Settings, tests, and
  documentation. A recording stop must never trigger a silent 547 MiB model
  download.
- **Phase 2:** Provide the recordings-library service and one shared
  main-process activity state that prevents migration during recording or
  transcription.
- **Phase 3:** Establish the macOS-only electron-builder configuration, package
  and sign the `whisper-cli` sidecar, and verify it in the notarized app.

The implementation plan must sequence this feature after Phases 1–3 or include
their exact prerequisite tasks rather than creating competing implementations.

## Decision Brief

- **User and job:** A job candidate needs a dependable transcript of a saved
  interview without losing the recording or guessing whether work is still
  progressing.
- **Current problem:** Two full-length channel uploads can exhaust Groq's audio
  seconds per hour. Provider errors are poorly logged, UI progress has only one
  indefinite state, and failed runs leave ffmpeg outputs that can block retries.
- **Desired outcome:** Local transcription works without an API key or network,
  first-use model setup is understandable, cloud use is deliberate, progress is
  truthful, and every failure is recoverable.
- **Success signal:** A user can select Local Whisper, download the model once,
  transcribe both channels, and open the merged transcript. A failure leaves
  `audio.wav` intact, removes disposable artifacts, and presents the next useful
  action.
- **Non-goals:** Real-time transcription, inferred speaker diarization, model
  benchmarking UI, automatic cloud fallback, background job persistence across
  an app restart, and support for arbitrary user-supplied Whisper models.
- **Product objects:** Transcription provider, local model, recording,
  transcription progress, transcript, and recoverable transcription error.
- **Entry points:** Provider selection in Settings and `Transcribe audio` on a
  saved recording.
- **Privacy consequence:** Local Whisper keeps audio on the Mac. Groq uploads
  prepared audio only after explicit provider selection and transcription.
- **Evidence:** The accepted
  [Review Desk UI design](2026-07-09-ui-redesign-design.md), current
  dual-channel pipeline, the original transcription design, Groq's published
  audio rate limits, and `whisper.cpp`'s Apple Silicon/Metal and JSON-output
  support.

## Chosen Integration

The Electron main process will invoke a packaged `whisper-cli` child process.
This sidecar approach is preferred over a Node native addon or local HTTP server:

- a CLI crash does not crash Electron;
- stdout/stderr and exit codes provide a clear diagnostic boundary;
- Electron ABI changes do not require rebuilding a Node addon;
- the app can pin and upgrade the engine independently;
- no persistent local service is needed.

The first implementation targets the current macOS Apple Silicon application,
consistent with remediation Phase 3's macOS-only scope. The persisted default
remains platform-independent: `local` does not silently mutate to `groq` on an
unsupported platform. The packaged CLI must be built with Metal support. An
unsupported platform or architecture makes Local Whisper unavailable with a
clear Settings explanation while leaving Groq selectable; it must not attempt
cloud fallback.

The deterministic sidecar build script writes an architecture-specific
development artifact to:

```text
build/whisper/darwin-arm64/whisper-cli
```

Remediation Phase 3 owns the corresponding electron-builder configuration. It
must copy that executable with `extraResources` to:

```text
Contents/Resources/whisper/bin/whisper-cli
```

The production resolver uses `process.resourcesPath`; the development resolver
uses the repository artifact. Phase 3 must sign the nested executable as part of
the hardened-runtime app signing flow, notarize the containing app, and verify
the packaged sidecar with both `codesign --verify --deep --strict` and an
unpacked-package launch smoke test. The model is downloaded at runtime and is
not an `extraResource` or ASAR member.

## Provider Configuration

The persisted configuration will gain:

```ts
type TranscriptionProvider = 'local' | 'groq';
```

`transcriptionProvider` defaults to `local`. Existing installations that lack
the field therefore migrate to Local Whisper without rewriting their config.
The saved Groq API key remains encrypted with Electron `safeStorage`.

Settings will show a provider selector above provider-specific controls:

- **Local Whisper:** model name, installation state, download size, and a
  download/retry action when needed.
- **Groq:** API key and Groq model controls.

Hidden provider controls retain their saved values. Switching providers does not
delete the local model or Groq credentials.

The privacy copy changes with the selected provider:

- Local: `Transcription runs on this Mac. Audio is not uploaded.`
- Groq: `Transcription sends prepared audio to Groq for processing.`

## Local Model Lifecycle

The pinned default model is `large-v3-turbo-q5_0`, approximately 547 MiB. The
exact model URL, expected byte size, and SHA-256 digest are versioned constants
in the application.

The model is stored at:

```text
~/Library/Application Support/Interview Copilot/models/
```

The path is resolved as `path.join(app.getPath('userData'), 'models')`, not from
`outputDir` and not from the recordings-library service. Models are replaceable,
app-managed assets; recordings and transcripts are user-owned library data.
Consequently, changing the recordings folder in remediation Phase 2 neither
moves nor verifies model files. Keeping these roots separate preserves the
library migration's source/destination invariants. Tests inject the model root;
the E2E process's isolated `HOME` remains an additional containment boundary.

The first local transcription performs this lifecycle:

1. Check whether the final model file exists and matches the expected digest.
2. If absent or invalid, download to a sibling `.part` file.
3. Report byte-based download progress to the renderer.
4. Verify the completed `.part` file with SHA-256.
5. Atomically rename it to the final model filename.
6. Begin transcription only after verification succeeds.

An interrupted or failed download removes its `.part` file. A checksum mismatch
is reported as a model-download failure and never promoted to the final model.
Retry starts a clean download. A previously verified final model remains usable
offline.

The app will not silently redownload a corrupt or incompatible model during an
active transcription attempt. It reports the problem and exposes an explicit
retry action.

### Download Test Seam

`LocalModelManager` receives a `ModelArtifactSpec` and download transport through
constructor injection:

```ts
interface ModelArtifactSpec {
  url: URL;
  fileName: string;
  byteSize: number;
  sha256: string;
}

interface ModelDownloadTransport {
  download(
    source: URL,
    destination: string,
    onProgress: (receivedBytes: number, totalBytes: number) => void
  ): Promise<void>;
}
```

Production composition supplies pinned constants and the HTTPS transport. Unit
tests supply a temporary model root, deterministic bytes, and an in-memory or
local-server transport.

E2E may override the artifact manifest and CLI path only when
`app.isPackaged === false` and `INTERVIEW_COPILOT_E2E === '1'`. Its fixture uses
a local stub server and fake CLI; it never contacts the production model host or
downloads the 547 MiB model. Production code ignores those overrides otherwise.

## Transcription Pipeline

The provider-independent pipeline is:

1. Validate the original `audio.wav`.
2. Split stereo audio into system and microphone mono WAV files with ffmpeg.
3. Route the prepared channels to the selected provider.
4. Produce normalized `TranscriptionSegment[]` values for each channel.
5. Label system segments `Interviewer` and microphone segments `You`.
6. Merge and sort segments by start time.
7. Atomically write `transcript.json`.
8. Refresh the recording library.

Local Whisper processes the channels sequentially to avoid competing for GPU
and memory. `whisper-cli` receives 16 kHz, mono, 16-bit WAV input and writes JSON
with segment timestamps. CLI output is parsed into the existing
`TranscriptionSegment` contract.

Before inference, a lightweight ffmpeg silence check examines each complete
channel. A channel with no non-silent interval longer than 500 ms above -50 dB
produces an empty segment list and does not invoke Whisper. The CLI also uses its
no-speech threshold and non-speech-token suppression options. This guards muted
or near-empty microphone channels without claiming to eliminate all Whisper
hallucinations.

The timestamp values for both channel files share the same zero point, so their
segments can be merged directly without temporal chunk offsets.

Groq continues to use FLAC uploads. Its two channels also run sequentially.
Short 429 delays of at most 60 seconds use the response `retry-after` value and
retry once. Longer limits return immediately with the provider's safe retry
time instead of leaving the app busy for up to an hour. Network requests have a
finite timeout, and provider error bodies are parsed for diagnostics without
exposing raw payloads in the UI.

Temporal chunking is not required for Local Whisper. Groq file-size chunking
remains a separate compatibility requirement for files above the active
account's upload limit; chunking does not reduce billed audio seconds or solve
audio-seconds-per-hour limits.

## Process Supervision

The local provider invokes `whisper-cli` with progress printing enabled. Any
stdout, stderr, or parsed progress update refreshes a per-channel activity
watchdog.

- Five minutes without child output or progress is treated as a stalled child.
- A hard per-channel deadline of `max(15 minutes, 2 × channel duration)` prevents
  a noisy but non-terminating child from running forever.
- On either deadline, the supervisor sends `SIGTERM`, waits five seconds, then
  sends `SIGKILL` if necessary.
- The supervisor rejects with the narrow `LOCAL_TRANSCRIPTION_TIMEOUT` code and
  continues through normal `finally` cleanup.

The user-facing message is local-specific:

`Local transcription stopped responding. Your recording is still saved. Try again, or select Groq in Settings.`

The cloud-specific `Check your connection` guidance is reserved for Groq network
timeouts and model downloads.

## Main-Process Single Flight

A main-process `TranscriptionActivityCoordinator` owns the single-flight lock.
The IPC handler must acquire it before model download or audio preparation and
release it in `finally`. If another attempt owns the lock, the handler returns
the narrow `TRANSCRIPTION_BUSY` error without starting work.

The renderer's disabled button remains a usability guard, not the authority.
Concurrent IPC calls, reopened windows, or future entry points cannot bypass the
main-process coordinator.

The coordinator exposes `isTranscribing(): boolean`. Remediation Phase 2's
recordings-library migration consults the same instance alongside recording
activity; it must not maintain a second transcription flag that can drift.

## Temporary Files and Atomic Outputs

Every transcription attempt owns an explicit list of disposable artifacts,
including:

- channel WAV files;
- Groq FLAC files;
- whisper.cpp JSON output;
- transcript staging files;
- incomplete model `.part` files created by that attempt.

The pipeline removes attempt-owned artifacts in `finally`, whether preparation,
model setup, transcription, parsing, merging, or writing succeeds or fails.
Cleanup is best-effort and must not replace the primary error.

The original `audio.wav` is never in the cleanup set. A previously completed
`transcript.json` is not overwritten until the new transcript staging file has
been written successfully and atomically renamed.

All ffmpeg invocations are non-interactive and explicitly overwrite their
attempt-owned outputs. A retry can therefore never wait for an overwrite prompt.

## Progress and Error Experience

Progress remains localized to the active recording card. The stable action area
uses a spinner, `aria-busy`, and one of these literal stages:

- `Preparing audio`
- `Downloading model · 42%`
- `Transcribing interviewer`
- `Transcribing you`
- `Finishing transcript`

Only one recording can transcribe at a time. Completed transcripts remain
available while another recording is active.

Errors use the existing recoverable alert pattern near the top of the window.
Every transcription error states:

1. what failed;
2. that the original recording is still saved;
3. the next useful action.

Examples:

- `The local model download failed. Your recording is still saved. Check your connection and try again.`
- `Local transcription could not start. Your recording is still saved. Retry, or select Groq in Settings.`
- `Local transcription stopped responding. Your recording is still saved. Try again, or select Groq in Settings.`
- `Groq's rate limit was reached. Your recording is still saved. Try again in 18 minutes.`
- `Groq transcription timed out. Your recording is still saved. Check your connection and try again.`
- `Another recording is already being transcribed. Wait for it to finish, then try again.`

Raw provider responses, filesystem implementation details, stack traces, API
keys, and transcript/audio content are never shown in the UI.

There is no automatic Local-to-Groq fallback. The user must open Settings and
select Groq before any audio upload can occur.

## Diagnostics

The main process logs structured, timestamped lifecycle events:

```text
[transcription] start provider=local recording=<safe-id>
[transcription] prepare channel=system
[transcription] model-download progress=42
[transcription] transcribe channel=system
[transcription] transcribe channel=mic
[transcription] complete durationMs=<number>
```

Failures log the stage, safe error category, child exit code or HTTP status, and
elapsed time. Logs must not include API keys, authorization headers, raw
provider bodies, audio content, transcript content, or full user file paths.

The renderer receives typed progress events over preload IPC. It does not parse
main-process logs.

## Development Workflow

Documentation will distinguish one-shot and watch workflows:

```bash
# One-shot production build and launch
npm run build
npm start
```

```bash
# Terminal 1: continuously rebuild dist
npm run dev

# Terminal 2: launch Electron
npm start
```

Webpack watch rebuilds files but does not restart Electron. Renderer-only
changes can be reloaded with `Cmd+R`; main or preload changes require restarting
`npm start`.

The local CLI build/download process will be a separate deterministic script so
normal TypeScript watch mode does not rebuild whisper.cpp.

## Test Strategy

Focused unit tests will cover:

- default/migrated provider configuration;
- Local versus Groq routing with no automatic fallback;
- model cache hit, download progress, checksum verification, atomic promotion,
  interrupted download cleanup, and retry;
- production download constants versus injected unit/E2E artifact manifests;
- `whisper-cli` invocation and JSON segment normalization;
- local inactivity watchdog, hard deadline, TERM/KILL escalation, and timeout
  copy;
- sequential channel processing and speaker labels;
- complete-channel silence detection and skipped inference;
- main-process single-flight acquisition, busy result, and `finally` release;
- shared transcription activity state used by recordings-library migration;
- ffmpeg non-interactive overwrite arguments;
- cleanup after preparation, local inference, Groq, parsing, and write failures;
- preservation of `audio.wav` and an existing completed transcript;
- Groq `retry-after`, one short retry, long-limit error, and request timeout;
- safe stage logs with secret/path/content redaction;
- typed renderer progress and user-facing recovery copy.

Integration verification will use a short deterministic stereo fixture and a
small test model or injected fake CLI. Full-model inference is a manual
Apple-Silicon smoke test, not a normal unit-test dependency.

Renderer verification will run unit tests, `npm run build`, and the existing
400 × 600 Electron E2E smoke test. It will exercise model-not-installed,
download progress, local transcription stages, Groq selection, and recoverable
failure states without allowing controls or alerts to obscure the active
recording card.

## Acceptance Criteria

- New and migrated users default to Local Whisper.
- No Groq request occurs unless Groq is explicitly selected.
- First local use downloads, verifies, and atomically installs the pinned model.
- Later local transcription works without a network connection.
- A 60-minute dual-channel recording completes locally with no network request
  after the model is installed.
- Both channels preserve their existing labels and merged timestamps.
- A silent channel does not produce hallucinated transcript segments.
- Progress identifies the current stage and model-download percentage.
- A stalled or non-terminating local child is terminated and reported instead of
  leaving the UI busy indefinitely.
- A main-process lock prevents concurrent transcription and is shared with the
  recordings-library migration guard.
- Every failed attempt leaves `audio.wav` usable and removes disposable files.
- Retrying after any failure never blocks on an ffmpeg overwrite prompt.
- Groq remains usable as a manually selected provider with bounded rate-limit
  and timeout behavior.
- Main-process logs identify the failing stage without leaking secrets or
  transcript content.
- The documented build/watch commands match actual package scripts.
- The packaged, signed, and notarized macOS app can spawn its signed
  `whisper-cli` sidecar from `process.resourcesPath`.

## References

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- [whisper.cpp model files](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md)
- [Groq rate limits](https://console.groq.com/docs/rate-limits)
- [Groq speech-to-text](https://console.groq.com/docs/speech-to-text)
