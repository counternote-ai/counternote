# Product design rules

Rules here are accepted standards. Proposals remain in `coverage-gaps.md` until reviewed.

## `rule/action-names-object`

- **Scope:** user-facing controls.
- **Rule:** Important or destructive actions use a specific Verb + Object label where space allows.
- **Rationale:** the consequence must be clear in a compact utility.
- **Source:** accepted UI redesign spec and product-design review.
- **Bad:** `Confirm`, `OK`, `Stop` in an ambiguous context.
- **Good:** `Stop recording`, `Save settings`, `Export transcript`.

## `rule/icon-button-has-name`

- **Scope:** icon-only interactive controls.
- **Rule:** Provide a programmatic accessible name describing the action.
- **Rationale:** the icon alone is not a reliable label.
- **Source:** accepted UI redesign accessibility requirements.
- **Bad:** settings gear button without `aria-label`.
- **Good:** settings gear button with `aria-label="Open settings"`.

## `rule/status-not-color-only`

- **Scope:** recording, transcription, readiness, and error states.
- **Rule:** Pair color or animation with explicit text.
- **Rationale:** state must remain understandable without color perception.
- **Source:** accepted UI redesign accessibility requirements.
- **Bad:** green dot only.
- **Good:** sage badge labeled `Ready`.

## `rule/no-nested-interactions`

- **Scope:** cards, rows, and controls.
- **Rule:** Never place a button or link inside another interactive element.
- **Rationale:** nested controls break semantics, focus, and event behavior.
- **Source:** renderer card pattern and general accessibility requirements.
- **Bad:** `Transcribe` button inside a clickable recording button.
- **Good:** separate card body action and footer action.

## `rule/use-semantic-tokens`

- **Scope:** renderer styling.
- **Rule:** Use shared semantic theme tokens and component variants for repeated color, radius, focus, and state treatments.
- **Rationale:** the Review Desk direction must remain coherent and theme-aware.
- **Source:** accepted UI redesign theme and component foundation.
- **Bad:** repeated arbitrary hex colors for ready state.
- **Good:** shared `ready` badge variant backed by semantic status tokens.

## `rule/privacy-names-boundary`

- **Scope:** settings, transcription, onboarding, and errors involving data transfer.
- **Rule:** State that recording audio and transcript text remain on the Mac; identify the separate speech-model download when network use matters.
- **Rationale:** users need an accurate data boundary to make an informed choice.
- **Source:** product privacy model and accepted settings design.
- **Bad:** `Your interviews stay private.`
- **Good:** `Transcription runs on this Mac. Audio is not uploaded.`

## Adding a rule

Require current evidence and human acceptance. Add a stable ID, scope, normative rule, rationale, source, exceptions when needed, and bad/good examples. Create a linter only when the rule is syntactic and false positives are acceptably low.
