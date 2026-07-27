# Product copy

## Voice

Use calm, direct, literal language. Write for a candidate who may already be under interview pressure.

- Prefer short sentences and familiar verbs.
- Name the object and consequence: `Stop recording`, `Transcribe audio`, `Save settings`, `Export transcript`.
- Use sentence case in controls and headings.
- Avoid hype, cuteness, blame, and anthropomorphic claims.
- Do not claim “AI speaker detection” or “diarization”; labels come from audio channels.
- Do not say data is private or local without stating the Groq transcription boundary.

## Canonical product language

- Product: `Interview Copilot`
- Library item: `recording`
- Generated text: `transcript`
- Remote/system channel: `Interviewer`
- Microphone channel: `You`
- Provider: `Groq`

## Status language

- `Ready` — transcript exists and can be opened.
- `Needs transcript` — audio is saved but no transcript exists.
- `Transcribing` — cloud transcription is active.
- `Recording` — audio capture is active.

Do not use success language until the underlying operation has completed.

## Errors

An error should state what failed, what was preserved, and the next useful action when known.

- Weak: `Something went wrong.`
- Better: `Transcription failed. Your recording is still saved. Check your Groq API key and try again.`
- Weak: `Permission error.`
- Better: `Microphone access is off. Allow Interview Copilot in System Settings, then start recording again.`

Do not expose stack traces, internal IPC names, file implementation details, or raw provider payloads in the UI.

## Accessible names

- Name icon-only buttons by action, not icon: `Open settings`, `Dismiss error`, `Go back`.
- Keep visible text and accessible names aligned unless extra context is necessary.
- Loading labels remain stable where possible; use busy state and a spinner rather than replacing the action with vague copy.
