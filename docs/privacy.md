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

## Audio capture helper

The Swift audio capture helper receives local audio only. It captures system
audio and microphone audio using CoreAudio, frames PCM with host-clock timestamps,
and writes binary protocol frames to inherited pipes (stdout). The helper has no
network access and receives a minimal sanitized environment that never includes
parent credentials, paths, Node options, or dynamic-loader overrides.

The helper never receives recording paths, transcript text, or credentials. It
writes framed PCM to stdout; the main process owns all file persistence.

## Recording artifacts

In-progress recordings use a `.in-progress` extension and are renamed to `.wav`
on clean finalization. Interrupted recordings use a `.recovery` extension and are
available for user-controlled recovery or Trash disposal.

No public recording appears before atomic publication. No failed artifact appears
in the normal recordings library.

## When audio leaves the Mac

Local Whisper keeps recording and prepared audio on the Mac. It runs the bundled
`whisper-cli` sidecar locally; it is not renderer code or a native Node addon.

Groq receives prepared system and microphone audio only when the user explicitly
selects Groq as the transcription provider and starts transcription. Groq's own
data handling is governed by the user's relationship with Groq.

The original `audio.wav` recording survives every transcription failure. Temporary
prepared-audio and partial-transcript artifacts are cleaned up separately.

## Credentials

The Groq API key is encrypted with Electron `safeStorage`. On macOS, `safeStorage` uses operating-system-backed encryption. The encrypted value is stored in `~/InterviewCopilot/secrets.enc`.

## Permissions

Interview Copilot uses macOS Screen Recording access for system audio capture and
Microphone access for the user's microphone. These permissions are attributed to
the audio capture helper binary. Permission recovery is available from the
recordings screen when macOS reports a blocked permission.
