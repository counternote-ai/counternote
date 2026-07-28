# Privacy and Local Data

## What stays on the Mac

- Raw recordings
- Generated transcripts and text exports
- Non-secret configuration
- The encrypted Groq API key
- Local Whisper model files cached under Electron `app.getPath('userData')`

Local sidecar lifecycle and failure diagnostics may be written to the terminal.
Transcript stdout is never logged. Stderr diagnostics are allow-listed, bounded,
and stripped of transcript-shaped lines, secrets, and absolute paths.

Interview Copilot does not include telemetry or analytics.

## When audio leaves the Mac

Local Whisper keeps recording and prepared audio on the Mac. It runs the signed
`whisper-cli` sidecar locally; it is not renderer code or a native Node addon.

Groq receives prepared system and microphone audio only when the user explicitly
selects Groq as the transcription provider and starts transcription. Groq's own
data handling is governed by the user's relationship with Groq.

The original `audio.wav` recording survives every transcription failure. Temporary
prepared-audio and partial-transcript artifacts are cleaned up separately.

## Credentials

The Groq API key is encrypted with Electron `safeStorage`. On macOS, `safeStorage` uses operating-system-backed encryption. The encrypted value is stored in `~/InterviewCopilot/secrets.enc`.

## Permissions

Interview Copilot uses macOS Screen Recording access for system audio capture and Microphone access for the user's microphone. Permission recovery is available from the recordings screen when macOS reports a blocked permission.
