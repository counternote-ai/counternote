# CounterNote Agent Guidelines

## Product design routing

For any work that changes what a user sees, understands, chooses, or does in the renderer or tray, load and follow `.agents/skills/product-design/SKILL.md` before proposing or editing UI. This includes product shaping, UX/UI implementation, copy, accessibility, permissions, loading, empty, error, privacy, responsive, and visual review work, plus backend changes with user-visible outcomes.

Do not load the skill for backend-only work, telemetry-only changes, generated files, or tests with no shipped UI impact.

## Canonical project guidance

- Current architecture: `docs/architecture.md`
- Local development and verification: `docs/development.md`
- Privacy and data movement: `docs/privacy.md`
- Contributor workflow: `CONTRIBUTING.md`
- Security policy: `SECURITY.md`
- Historical design decisions: `docs/superpowers/specs/`

When documentation conflicts with executable configuration or tests, verify the implementation and update the canonical document in the same change.

## Working rules

- Inspect relevant files and tests before editing.
- Keep changes scoped and preserve unrelated user work.
- Follow TDD for behavior changes: failing focused test, minimal implementation, refactor, full verification.
- Use strict TypeScript, explicit public return types, `unknown` plus validation at trust boundaries, and interfaces for object shapes.
- Keep Electron context isolation enabled and renderer Node integration disabled.
- Define renderer access through the preload bridge; do not expose broad Electron or filesystem APIs.
- Use functional React components, existing shared UI components, CSS classes, and accessible names.
- Update canonical documentation when behavior, setup, privacy, permissions, or supported platforms change.

## Verification

- Run focused tests while developing.
- Run the checks documented in `docs/development.md` before completion.
- Run the Electron E2E smoke test for user-visible renderer or tray changes.
- State clearly when GUI, packaging, network, or platform-specific verification could not be run.

## Git

- Inspect `git status` and the diff before committing.
- Use focused Conventional Commits.
- Never bypass hooks with `--no-verify`.
