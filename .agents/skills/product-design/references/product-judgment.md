# Product judgment

## Product frame

- **Primary user:** a job candidate conducting and reviewing remote interviews.
- **Primary job:** reliably capture both sides of an interview, turn the recording into a readable transcript, and revisit what was said.
- **Trust model:** local-first capture with explicit cloud transcription through Groq.
- **Core objects:** recording, transcript, transcript segment, speaker, transcription configuration.
- **Current surfaces:** recordings home, transcript reader, settings, tray/menu-bar entry points, and system permission prompts.
- **Hard platform constraint:** starting system-audio capture requires a visible, focused user gesture. Do not imply that a tray or background action can silently begin recording.

## Product principles

1. **Capture must feel dependable.** Recording state and stop access outrank visual novelty.
2. **Review is the destination.** Optimize completed transcripts for calm reading and scanning.
3. **System truth must remain visible.** Distinguish recording, saved audio, transcribing, ready transcript, and failure.
4. **Privacy claims must be literal.** Audio is local until transcription runs; transcription sends audio to Groq.
5. **Speaker labels describe channels, not identity inference.** “Interviewer” is system audio and “You” is microphone audio; do not present it as true diarization.
6. **Keep the utility lightweight.** Prefer strong defaults and direct actions over dashboard complexity or settings proliferation.
7. **Preserve recovery.** A failed transcription must not imply that the underlying recording is lost.

## Decision authority

Resolve conflicts in this order:

1. The user's explicit goal and constraints.
2. Verified product behavior, platform limits, and user evidence.
3. Repository guidance and accepted design specs.
4. This skill's accepted rules and patterns.
5. Verified adjacent patterns in the same surface.
6. General interface heuristics.

Canonical evidence locations:

- `docs/superpowers/specs/` — accepted design specs, date-prefixed. When specs conflict, the newer accepted spec wins.
- `src/renderer/App.tsx` and the active renderer components
- `src/main/index.ts`, `src/renderer/audio-capture.ts`, and preload contracts for behavior truth

Cite the specs directory, not individual spec files; new accepted specs become evidence without requiring a skill edit.

## Compact decision brief

Before a material decision, answer:

- User and job
- Current behavior or problem
- Desired outcome and success signal
- Non-goals
- Product object and scope
- Entry point and primary action
- Consequence and reversibility
- Permissions, privacy, or data movement
- Reachable states
- Evidence
- Assumptions and open decisions

Keep the brief compact. It may live in the work plan or reasoning unless the user requests an artifact.
