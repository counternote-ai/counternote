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
- **Evidence:** The accepted Review Desk product direction, current dual-channel
  pipeline, the original transcription design, Groq's published audio rate
  limits, and `whisper.cpp`'s Apple Silicon/Metal and JSON-output support.

## Chosen Integration

The Electron main process will invoke a packaged `whisper-cli` child process.
This sidecar approach is preferred over a Node native addon or local HTTP server:

- a CLI crash does not crash Electron;
- stdout/stderr and exit codes provide a clear diagnostic boundary;
- Electron ABI changes do not require rebuilding a Node addon;
- the app can pin and upgrade the engine independently;
- no persistent local service is needed.

The first implementation targets the current macOS Apple Silicon application.
The packaged CLI must be built with Metal support. An unsupported architecture
must make Local Whisper unavailable with a clear Settings explanation while
leaving Groq selectable; it must not attempt cloud fallback.

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
- `Groq's rate limit was reached. Your recording is still saved. Try again in 18 minutes.`
- `Transcription timed out. Your recording is still saved. Check your connection and try again.`

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
- `whisper-cli` invocation and JSON segment normalization;
- sequential channel processing and speaker labels;
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
- A 60-minute dual-channel recording is not subject to Groq limits in Local
  mode.
- Both channels preserve their existing labels and merged timestamps.
- Progress identifies the current stage and model-download percentage.
- Every failed attempt leaves `audio.wav` usable and removes disposable files.
- Retrying after any failure never blocks on an ffmpeg overwrite prompt.
- Groq remains usable as a manually selected provider with bounded rate-limit
  and timeout behavior.
- Main-process logs identify the failing stage without leaking secrets or
  transcript content.
- The documented build/watch commands match actual package scripts.

## References

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
- [whisper.cpp model files](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md)
- [Groq rate limits](https://console.groq.com/docs/rate-limits)
- [Groq speech-to-text](https://console.groq.com/docs/speech-to-text)
