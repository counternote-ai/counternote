# Privacy and Local Data

## What stays on the Mac

- Raw recordings
- Generated transcripts and text exports
- Non-secret configuration
- The encrypted Groq API key

Interview Copilot does not include telemetry or analytics.

## When audio leaves the Mac

Audio remains local while recording and reviewing saved recordings. It is sent to Groq only after the user explicitly selects `Transcribe audio`.

For transcription, Interview Copilot creates temporary single-channel FLAC files for system audio and microphone audio and uploads both to Groq. Groq's own data handling is governed by the user's relationship with Groq.

## Credentials

The Groq API key is encrypted with Electron `safeStorage`. On macOS, `safeStorage` uses operating-system-backed encryption. The encrypted value is stored in `~/InterviewCopilot/secrets.enc`.

## Permissions

Interview Copilot uses macOS Screen Recording access for system audio capture and Microphone access for the user's microphone. Permission recovery is available from the recordings screen when macOS reports a blocked permission.
