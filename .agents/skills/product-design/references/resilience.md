# Resilience and trust

## Recording lifecycle

- Starting capture requires a focused, visible button gesture and may trigger macOS screen/audio and microphone permissions.
- Do not show recording as active until capture and WAV creation both succeed.
- If initialization partially succeeds, clean it up and explain the recoverable failure.
- Stopping must end capture, finalize the file, refresh the library, and surface finalization failure honestly.
- Never imply an interview was saved if finalization did not complete.

## Transcription lifecycle

- Audio must remain usable when transcription fails.
- Localize progress and retry to the relevant recording.
- Prevent duplicate requests while preserving access to other completed transcripts.
- Distinguish missing API configuration, provider rejection, conversion failure, upload/network failure, and an empty transcript when the product can identify them safely.
- Keep user-facing labels stable and expose `aria-busy` or equivalent state when practical.

## Permissions and privacy

- Explain which permission is required and where the user can recover after denial.
- Never imply the app can bypass macOS permission controls.
- State the data boundary literally: recording audio and transcript text stay on the Mac; the speech model is downloaded separately.
- Transcription begins only from the explicit `Transcribe audio` action; documentation and copy must describe that upload boundary.

## Content extremes

- Recording titles may be long or malformed; truncate visually without losing the full accessible name.
- Transcript segments may contain long unbroken text, multiple languages, or unexpected speaker values.
- Lists and transcripts must scroll within the fixed window while headers and critical actions remain reachable.
- Empty and sparse data should look intentional, not broken.

## Recovery principles

- Preserve user input through validation and recoverable errors.
- Prefer retry in context over resetting the whole screen.
- Do not use optimistic success for recording finalization, transcription, settings save, or export.
- If an action can be safely repeated, make retry clear. If it cannot, explain the next safe step.
