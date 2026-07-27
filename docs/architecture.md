# Architecture

Interview Copilot is a macOS Electron menu-bar app with an isolated React renderer.

## Process boundaries

- The renderer owns user interaction, display-media and microphone capture, Web Audio processing, and PCM conversion.
- The preload script exposes the narrow `window.electronAPI` bridge.
- The main process owns application lifecycle, the tray, IPC handlers, WAV persistence, local configuration, transcription orchestration, and exports.
- `contextIsolation` is enabled and renderer `nodeIntegration` is disabled.

## Recording flow

1. The visible Record action checks macOS screen/audio and microphone permissions.
2. The renderer requests display loopback audio and microphone audio.
3. An AudioWorklet interleaves system audio and microphone audio as stereo PCM.
4. PCM chunks cross the preload bridge and the main process writes `audio.wav`.
5. Stop closes capture, finalizes the WAV header, and refreshes the recordings library.

## Transcription flow

1. The user selects Transcribe audio for a saved recording.
2. The main process splits the stereo WAV into system and microphone channels.
3. Each channel is converted to FLAC and sent to Groq.
4. Returned segments are labeled Interviewer for system audio and You for microphone audio.
5. Segments are merged by timestamp and saved as `transcript.json`.

The labels describe audio channels; they are not inferred speaker identities or diarization.

## Local storage

The current library is stored under `~/InterviewCopilot/recordings`. Each timestamped directory contains `audio.wav`, optional `transcript.json`, and optional `transcript.txt`.

`~/InterviewCopilot/config.json` stores non-secret settings. `~/InterviewCopilot/secrets.enc` stores the Groq API key encrypted through Electron `safeStorage`.

The configured `outputDir` is reserved for the recordings-library migration work and is not yet user-selectable.
