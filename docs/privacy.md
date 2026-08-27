# Privacy and Local Data

This document describes the implementation-level data flow for CounterNote `v0.1.0-beta.4`. The public summary is [PRIVACY.md](../PRIVACY.md).

## Local storage

- `~/CounterNote/recordings/<recording-id>/audio.wav` stores finalized stereo PCM audio.
- `transcript.json` and exported `transcript.txt` are stored beside the recording.
- In-progress and recovery artifacts remain under the recordings root until finalized, recovered, or removed by the user.
- Capture diagnostics are stored under `~/CounterNote/recordings/.diagnostics/`.
- The Local Whisper model is cached under Electron's `app.getPath('userData')/models` directory.
- `~/CounterNote/config.json` may store the recordings directory. Legacy cloud-provider fields are ignored.

An obsolete encrypted `~/CounterNote/secrets.enc` file may remain from a private development build. The beta does not read, decrypt, or transmit it.

## Capture process

The bundled Swift helper receives local system and microphone audio through macOS APIs. It frames PCM with host-clock timestamps and writes protocol frames to inherited local pipes. The helper receives a minimal sanitized environment and has no network feature.

The main Electron process owns WAV persistence. In-progress recordings use `.in-progress`; clean finalization publishes `audio.wav` atomically. Interrupted data uses a `.recovery` artifact so a failed capture does not appear as a completed recording.

## Transcription process

1. The user explicitly selects **Transcribe audio**.
2. The main process streams the stereo 16 kHz, 16-bit PCM WAV and creates two temporary mono WAV channel files using Node file APIs.
3. Silence analysis reads PCM samples locally.
4. The bundled `whisper-cli` sidecar filters speech with a locally verified Silero voice-activity-detection model, then processes audible intervals sequentially on the Mac.
5. The main process merges channel-labeled segments and atomically publishes `transcript.json`.
6. Temporary channel and partial transcript files are removed. The original `audio.wav` survives every transcription failure.

No supported transcription path uploads audio or transcript text.

## Network activity

When the user selects **Download model**, CounterNote downloads both the pinned `ggml-large-v3-turbo-q5_0.bin` model from the `ggerganov/whisper.cpp` Hugging Face repository and the pinned `ggml-silero-v5.1.2.bin` Silero voice-activity-detection model from the `ggml-org/whisper-vad` repository. CounterNote verifies each file's expected byte size and SHA-256 digest before publishing it locally. Settings reports the local models as ready only when both files pass verification, so speech filtering stays local and reliable on mostly silent channels.

CounterNote contains no telemetry or analytics.

## Diagnostics

Local capture and sidecar diagnostics are shape-validated, rate-limited, and written locally. They exclude audio, transcript text, credentials, absolute paths, and unstructured sidecar stdout.
