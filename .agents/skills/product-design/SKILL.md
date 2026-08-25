---
name: product-design
description: >-
  Single entry point for CounterNote product design and user-facing implementation.
  Use whenever work changes what a user sees, understands, chooses, or does in the
  Electron renderer or tray: shaping flows; building or redesigning screens and
  components; reviewing screenshots, diffs, or UI; improving copy, hierarchy,
  interaction, accessibility, responsive behavior, permissions, loading, empty,
  error, privacy, or destructive states. Trigger on design, UX, UI, usability,
  flow, recordings, transcript, settings, tray, polish, simplify, review, or
  production-ready requests, including backend changes with a user-visible result.
  Do not use for backend-only work, telemetry-only work, generated files, tests
  without shipped UI impact, or general project documentation.
---

# CounterNote Product Design

Make the interface correct for someone capturing and reviewing an important meeting. Working code is not sufficient: clarify the task and consequences, cover reachable states, preserve trust, and verify the rendered 400 x 600 macOS surface.

## Operating contract

- Start with the user's job, not the pixels.
- Define the desired behavior and success signal before selecting a component.
- Use repository evidence and accepted decisions; treat shipped code as evidence, not automatic precedent.
- Separate verified facts, design decisions, assumptions, and unresolved choices.
- Choose the smallest coherent intervention. Prefer a better default or clearer behavior before adding controls.
- Resolve information architecture, semantics, states, and copy before decoration.
- Design every reachable state, including permissions and recoverable failures.
- Preserve local-first trust: say when audio leaves the device and why.
- Verify the real Electron surface. Source inspection alone is not visual verification.

## Resolve the request mode

Use the narrowest mode supported by the user's verb:

| Mode | Typical request | Required behavior |
| --- | --- | --- |
| Shape | “Design this flow” or an unsettled feature | Define the problem, alternatives, flow, states, acceptance criteria, risks, and open decisions. Do not edit product code unless asked. |
| Implement | “Build,” “improve,” or “redesign” | Resolve material decisions, then implement the smallest coherent end-to-end change. |
| Review | “Audit,” “critique,” or review a screenshot/diff | Inspect source and rendered evidence, then report prioritized findings. Do not edit unless asked. |
| Copy | “Rewrite this error” or “fix the copy” | Change user-facing language and directly required accessible labels only. |
| Harden | “Polish” or “production-ready” | Preserve the settled direction while fixing state, resilience, accessibility, and finish defects. |

A URL, screenshot, route, or component narrows scope; it does not authorize edits by itself.

## Workflow

1. Name the target surface and mode.
2. Read the applicable `AGENTS.md` chain, relevant product logic, and supplied brief or design.
3. For Shape, Implement, Harden, full Review, or a material flow change, read [product-judgment.md](references/product-judgment.md) and form the compact decision brief it defines.
4. Inventory entry points, visible regions, transitions, exits, return paths, and only the states the product can actually enter.
5. Load focused references:
   - Any implementation, visual change, or full review: [interface-quality.md](references/interface-quality.md).
   - Recordings, transcript, settings, tray, or app-wide flow: [surfaces.md](references/surfaces.md).
   - User-facing language or accessible names: [copy.md](references/copy.md).
   - Permissions, recording/transcription lifecycle, long content, failure, or privacy: [resilience.md](references/resilience.md).
   - Reusing an established interaction: [patterns.md](references/patterns.md).
   - Compliance or a proposed new standard: [rules.md](references/rules.md).
   - Unsettled areas: [coverage-gaps.md](references/coverage-gaps.md); do not invent a universal rule.
6. Decide, then implement. For each non-mechanical change, be able to state the user problem, why the interaction fits, its consequence, supporting evidence, and why the scope is sufficient.
7. Verify proportionally:
   - Run relevant tests and `npm run build` for renderer changes.
   - Inspect the actual Electron UI at 400 x 600 for structural visual changes.
   - Exercise every materially changed reachable state.
   - Check keyboard order, focus, loading, permission behavior, and pointer targets.
   - Check long titles, long transcript text, empty data, and constrained width.

If Electron cannot be rendered in the environment, say so explicitly and distinguish code verification from visual verification.

## Review output

Lead with findings ordered by impact:

- P0: blocks the primary task, causes severe accessibility failure, or risks unrecoverable harm.
- P1: likely task failure, misleading consequence, missing critical state, or major accessibility defect.
- P2: meaningful friction, inconsistency, weak hierarchy, or recoverability issue.
- P3: minor craft or consistency improvement.

For each finding, include the rendered location or file/line, verification status, governing reference or evidence, user consequence, and smallest concrete fix. State when there are no findings.

## Governance

- Add or change a rule only after current-source verification and human acceptance.
- Record its stable ID, scope, rationale, source, exceptions, and bad/good example in `references/rules.md`.
- Keep mechanical checks deterministic. Keep contextual judgment in prose.
- Never turn one screenshot, shipped file, or reviewer comment into a universal rule by itself.
- Record unresolved design territory in `references/coverage-gaps.md`.
