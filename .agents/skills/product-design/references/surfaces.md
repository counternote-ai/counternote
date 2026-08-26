# Product surfaces

## Recordings home

**Job:** start or stop capture, understand the library, transcribe saved audio, and open ready transcripts.

- Use a two-row compact header: app identity/settings, then title/count and record/stop action.
- While recording, the stop action and active state must remain obvious and reachable.
- Each recording shows title, duration, and explicit transcript status.
- Ready recordings open the transcript. Saved audio without a transcript exposes a local `Transcribe audio` action.
- Localize transcription progress to the active recording. Prevent duplicate transcription without making ready transcripts unavailable.
- Empty state explains what will appear and offers a non-dominant recording action.

Reachable states: loading recordings, empty, populated, recording active, start permission pending/denied, stop/finalize failure, saved-untranscribed, transcribing, transcript-ready, transcription failure.

## Transcript reader

**Job:** read the meeting in sequence and export the completed transcript.

- Keep Back and Export in a utility toolbar.
- Show title and compact metadata before the transcript.
- Distinguish `Meeting audio` and `You` with restrained badges or borders plus text.
- Align timestamps consistently and optimize body text for reading.
- Disable or omit export when no transcript content exists, and explain an empty transcript.
- Do not imply that channel labels are verified human identities.

Reachable states: populated transcript, empty segments, long title, long segment, unknown speaker label, export in progress/success/cancel/failure.

## Settings

**Job:** configure transcription deliberately and understand data handling.

- Keep Back and the screen title in a simple toolbar.
- Keep Local Whisper model status and download/retry in one transcription card.
- Keep the privacy explanation calm and precise; it is not an error alert.
- Keep Save at the bottom as the main commitment action.
- Preserve entered values through validation or save failure.

Reachable states: model status loading, not downloaded, downloading, ready, invalid, unavailable, and download failure/retry.

## Tray and system prompts

**Job:** reach the app and understand global recording status without breaking macOS capture requirements.

- Tray start commands must open/focus the control panel so the user can begin from a visible button gesture.
- Stopping may be available from the tray or shortcut because it does not require capture activation.
- Tray language and control-panel state must agree.
- Treat microphone and screen/audio permission prompts as part of the flow; explain recovery after denial without pretending the app can bypass macOS.

## App-wide overlays

- Place recoverable errors near the top without hiding the current task.
- Use action-specific messages and keep Dismiss available.
- Avoid nested overlays in the 400 px window. Prefer inline disclosure and focused cards.
