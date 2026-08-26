# Architecture

CounterNote is a macOS Electron menu-bar app with an isolated React renderer and two local native sidecars.

## Process boundaries

- The renderer owns user interaction and status presentation.
- The preload script exposes the narrow `window.electronAPI` bridge.
- The main process owns app lifecycle, tray, IPC validation, capture supervision, WAV persistence, local transcription orchestration, and exports.
- The Swift audio-capture helper owns real-time system and microphone capture, timestamp framing, and protocol encoding.
- The `whisper-cli` sidecar owns local speech inference.
- Electron context isolation is enabled and renderer Node integration is disabled.

## Recording flow

1. The visible Record action checks macOS Screen Recording and Microphone permissions.
2. The main process spawns the Swift helper with inherited pipes and a sanitized environment.
3. The helper captures both channels and writes framed PCM to stdout.
4. The main process decodes frames, tracks gaps and interruptions, and writes a stereo 16 kHz, 16-bit PCM WAV.
5. Stop finalizes the WAV and refreshes the recordings library.

## Transcription flow

1. The user selects **Transcribe audio** for a saved recording.
2. The main process streams the stereo WAV into temporary mono system and microphone WAV files without FFmpeg or another media subprocess.
3. Local silence analysis identifies audible intervals.
4. The pinned Local Whisper sidecar processes audible intervals sequentially on the Mac.
5. Returned segments are labeled `Meeting audio` and `You`, sorted by timestamp, and atomically saved as `transcript.json`.
6. Temporary channel and partial transcript files are removed; failures preserve the original recording and any previously published transcript.

The labels describe audio channels, not inferred human identities or diarization. The public beta has no cloud-transcription production path. Dormant cloud-provider source is not imported by the production entry point or included in the packaged application.

## Packaging

The release is an Apple Silicon DMG targeting macOS 13. The app bundle contains the three webpack runtime bundles, the Swift capture helper, and a pinned statically built `whisper-cli`. Tests, declarations, source maps, and build tooling are excluded from `app.asar`.

The beta is structurally ad-hoc signed but not Developer ID signed or notarized. Developer ID signing, notarization, automatic updates, and Intel builds are intentionally out of scope.

## Local storage

The recordings library is under `~/CounterNote/recordings`. The Local Whisper model is under Electron's CounterNote user-data directory. See [privacy.md](privacy.md) for the exact data boundary.
