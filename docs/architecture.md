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
3. Local Whisper verifies or downloads its model, then passes each channel to the
   `whisper-cli` sidecar on the Mac. Groq uploads prepared audio only when
   the user explicitly selects Groq as the provider.
4. Returned segments are labeled Interviewer for system audio and You for microphone audio.
5. Segments are merged by timestamp and saved as `transcript.json`; failures keep
   the original recording intact.

The labels describe audio channels; they are not inferred speaker identities or diarization.

The sidecar is a child-process executable owned by the main process. It is
not renderer code, a local HTTP service, or a Node native addon. Packaging
distributes it through two gates: an unsigned local package verifies the static
binary with `file`, `--help`, and `otool -L`; a release package adds nested code
signing, a hardened runtime, and Apple notarization once credentials are
configured.

## Local storage

The current library is stored under `~/InterviewCopilot/recordings`. Each timestamped directory contains `audio.wav`, optional `transcript.json`, and optional `transcript.txt`.

`~/InterviewCopilot/config.json` stores non-secret settings. `~/InterviewCopilot/secrets.enc` stores the Groq API key encrypted through Electron `safeStorage`.

Local Whisper models live under `app.getPath('userData')/models`, separate from
recordings. Changing or moving the recordings root does not automatically move
the model cache.

The configured `outputDir` is reserved for the recordings-library migration work and is not yet user-selectable.
