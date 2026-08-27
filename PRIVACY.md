# CounterNote Privacy

CounterNote `v0.1.0-beta.4` supports local transcription only.

## Data stored on your Mac

- Recordings: `~/CounterNote/recordings/<recording-id>/audio.wav`
- Transcripts: `~/CounterNote/recordings/<recording-id>/transcript.json`
- Text exports: `~/CounterNote/recordings/<recording-id>/transcript.txt`
- Capture diagnostics: `~/CounterNote/recordings/.diagnostics/`
- Local Whisper and speech detection models: Electron's CounterNote user-data directory under `models/`

Capture diagnostics contain local lifecycle and allow-listed error information. They do not contain audio, transcript text, credentials, or telemetry.

## Network activity

CounterNote downloads pinned Local Whisper and Silero speech detection models from Hugging Face when you explicitly select **Download model**. Each download is checked for its expected size and SHA-256 digest.

The supported beta does not upload recordings, prepared audio, transcripts, or exports. It contains no telemetry or analytics.

## Previous private builds

An obsolete encrypted `~/CounterNote/secrets.enc` file may remain if you previously configured Groq in a private development build. This beta does not read or transmit that file. You may delete it if you no longer use an older build.

## Permissions

CounterNote requests macOS Screen Recording access for meeting audio and Microphone access for your microphone. The bundled local capture helper performs capture and writes PCM data through local pipes to the main app process; it has no network feature.

## Deleting data

You can delete individual recording directories under `~/CounterNote/recordings`. Removing CounterNote does not automatically remove recordings, transcripts, exports, diagnostics, or the downloaded models.

For implementation-level detail, see [docs/privacy.md](docs/privacy.md).
