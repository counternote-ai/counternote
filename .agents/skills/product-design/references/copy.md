# Product copy

## Voice

Use calm, direct, literal language. Write for someone who needs a dependable record of an important conversation.

- Prefer short sentences and familiar verbs.
- Name the object and consequence: `Stop recording`, `Transcribe audio`, `Save settings`, `Export transcript`.
- Use sentence case in controls and headings.
- Avoid hype, cuteness, blame, and anthropomorphic claims.
- Do not claim “AI speaker detection” or “diarization”; labels come from audio channels.
- State local processing literally; distinguish the speech-model download from recording and transcript data.

## Canonical product language

- Product: `CounterNote`
- Library item: `recording`
- Generated text: `transcript`
- Remote/system channel: `Meeting audio`
- Microphone channel: `You`

## Status language

- `Ready` — transcript exists and can be opened.
- `Needs transcript` — audio is saved but no transcript exists.
- `Transcribing` — local transcription is active.
- `Recording` — audio capture is active.

Do not use success language until the underlying operation has completed.

## Errors

An error should state what failed, what was preserved, and the next useful action when known.

- Weak: `Something went wrong.`
- Better: `Local transcription failed. Your recording is still saved. Try again.`
- Weak: `Permission error.`
- Better: `Microphone access is off. Allow CounterNote in System Settings, then start recording again.`

Do not expose stack traces, internal IPC names, file implementation details, or raw provider payloads in the UI.

## Accessible names

- Name icon-only buttons by action, not icon: `Open settings`, `Dismiss error`, `Go back`.
- Keep visible text and accessible names aligned unless extra context is necessary.
- Loading labels remain stable where possible; use busy state and a spinner rather than replacing the action with vague copy.
