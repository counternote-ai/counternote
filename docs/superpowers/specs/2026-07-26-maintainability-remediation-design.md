# Interview Copilot Maintainability Remediation

**Date:** 2026-07-26
**Status:** Approved for planning
**Scope:** Documentation truth, recordings-library migration, packaging, quality gates, critical-path tests, and maintainable process boundaries

## Overview

Interview Copilot has a healthy prototype baseline, but its documentation, configuration, packaging, tests, and implementation no longer describe one coherent product. This remediation will resolve those contradictions in small, independently verified phases rather than one broad rewrite.

The order is intentional:

1. Make repository policy and documentation truthful.
2. Make the configured recordings directory real and safely migratable.
3. Establish one supported macOS packaging path.
4. Add deterministic quality gates and CI.
5. Strengthen critical runtime boundaries and tests.

Each phase should be reviewable and leave the repository in a working state.

## Product Decision Brief

- **User and job:** A job candidate needs recordings and transcripts to remain dependable while changing where local interview data is stored.
- **Current problem:** `outputDir` is persisted but ignored; auto-transcribe is exposed but not implemented; repository instructions and packaging metadata conflict with shipped behavior.
- **Desired outcome:** Documentation matches reality, changing the recordings folder migrates the complete library safely, and automated checks prevent renewed drift.
- **Success signal:** A contributor can follow the documented setup on Node.js 22, all required checks pass, a macOS package can be produced from one configuration, and a user can move the recordings library without losing access to existing recordings.
- **Non-goals:** Windows or Linux support, automatic transcription, merging two recordings libraries, cloud storage, background migration, or a broad renderer redesign.
- **Primary product object:** The recordings library containing recording directories, audio, transcripts, and exports.
- **Entry point:** Settings → Recordings folder → Choose folder.
- **Consequence and reversibility:** Changing the folder moves local interview data. The configured library changes only after a verified copy succeeds. Before that point, the original library remains authoritative.
- **Privacy and data movement:** Migration is local filesystem activity. No recording or transcript is uploaded. Groq remains involved only when the user explicitly starts transcription.
- **Assumptions:** Folder selection is available only on macOS, the destination must be empty and writable, and migration is allowed only while no recording or transcription is active.

## Phase 1: Documentation Truth and Repository Policy

### License and repository identity

- Adopt the MIT License.
- Add a root `LICENSE` file containing the standard MIT text.
- Set `package.json` and the lockfile metadata to `MIT`.
- Keep the clone command out of the README until a canonical public repository URL exists.
- Keep `SECURITY.md`, but state clearly that the private reporting email will be added before public release. Do not promise an active response channel or response timeline before then.

### Supported development environment

- Standardize development on Node.js 22 LTS with a minimum version of `22.12.0`.
- Add `.nvmrc` and a `package.json` `engines.node` constraint.
- Use `npm ci` as the documented reproducible install command for contributors and CI.

### Behavior corrections

- Remove the nonfunctional auto-transcribe switch, config field, IPC field, types, tests, and documentation.
- Continue to require an explicit `Transcribe audio` action before audio is sent to Groq.
- Retain `outputDir`, but stop presenting it as implemented until Phase 2 lands.
- Replace stale troubleshooting and known-issue statements with verified current behavior.

### Documentation ownership

Use the following stable structure:

```text
README.md
CONTRIBUTING.md
SECURITY.md
CHANGELOG.md
docs/
  architecture.md
  development.md
  privacy.md
  decisions/
  archive/
```

- Keep README focused on product use and the shortest successful setup.
- Keep CONTRIBUTING focused on the exact local workflow and required checks.
- Keep current architecture, development, and privacy facts in one document each.
- Treat dated design specs as historical evidence, not current operational documentation.
- Mark implemented product specs as implemented and move superseded material to `docs/archive/` when useful.
- Delete the unrelated Linear/Claude/Codex workflow spec.
- Remove tracked `.superpowers/sdd` generated task briefs and reports; the directory remains ignored.
- Reduce `AGENTS.md` to durable repository instructions and links rather than duplicating architecture, dependencies, known issues, and roadmap material.

## Phase 2: Recordings Library Migration

### Settings interaction

Add a `Recordings folder` section to the existing Settings surface.

- Show the current absolute path as read-only, wrapping or truncating safely within the 400 × 600 window while preserving the full accessible value.
- Provide a `Choose folder` button that opens Electron's native directory picker.
- Explain the consequence beside the control: choosing a folder moves existing recordings on this Mac.
- Keep `Save settings` as the explicit commitment action.
- If the chosen path differs from the current path, saving begins migration.
- Disable duplicate Save actions during migration and use stable progress copy such as `Moving recordings…`.
- Preserve the selected path if validation or migration fails.

Removing auto-transcribe creates enough space for this setting without adding another screen.

### Destination rules

The destination must:

- Be a directory selected through the native picker.
- Differ from the current library after canonical path resolution.
- Be empty.
- Be writable.
- Not be inside the current library or contain the current library.

Canceling the picker makes no change.

### Migration algorithm

The user-visible operation is a move, but the implementation prioritizes data preservation:

1. Confirm there is no active recording or transcription.
2. Resolve and validate source and destination paths.
3. Confirm the destination is empty and writable.
4. Copy every source entry into the destination.
5. Verify the copied library against the source using relative paths, file types, and byte sizes.
6. Persist the new configured library path atomically.
7. Refresh the renderer from the new library.
8. Remove the old library contents.

Until step 6 succeeds, the source remains authoritative. If copying or verification fails, remove only the partial destination copies and keep the original configuration and library unchanged.

If configuration switches successfully but old-file cleanup fails, the new library remains authoritative and usable. The app reports that the move completed but old copies could not be removed, naming the old location so the user can clean it up manually. It must never switch back automatically after the new library is active.

An empty source library is valid and results in a configuration-only switch after destination validation.

### Main-process boundary

- The main process owns folder selection, validation, migration, config persistence, and library refresh.
- The renderer receives a narrow typed result and never performs filesystem operations.
- Recording creation and listing both resolve the active directory through the same recordings-library service.
- IPC arguments and persisted config are validated at runtime.
- Config writes use a temporary file and rename so interruption cannot leave partial JSON.
- The config schema gains an explicit version to support later migrations.

### Reachable states and copy

- **Unchanged:** The selected folder is the current folder; saving makes no migration.
- **Picker canceled:** Keep the current value without an error.
- **Non-empty destination:** `Choose an empty folder for your recordings.`
- **Not writable:** `Interview Copilot can’t write to that folder. Choose another folder.`
- **Insufficient space or copy failure:** `Recordings couldn’t be moved. Your original library is unchanged.`
- **Verification failure:** Use the same preservation message and retain the source.
- **Old cleanup failure:** `Recordings moved, but old copies remain in <path>.`
- **Busy:** Prevent migration while recording or transcribing and explain which activity must finish first.

Errors remain recoverable, do not expose raw IPC or filesystem details, and do not imply success before verification.

### Tests

Cover:

- Default and persisted paths.
- Malformed or unsupported config versions.
- Picker cancellation.
- Same, nested, non-empty, and unwritable destinations.
- Empty-library switching.
- Successful migration and library refresh.
- Copy, verification, config-write, and source-cleanup failures.
- Partial-destination cleanup.
- Preservation of the original source and config before commit.
- Duplicate-copy warning after a post-commit cleanup failure.
- Settings loading, selection, saving, progress, validation, and failure copy.
- A rendered 400 × 600 Settings check with long paths and keyboard navigation.

## Phase 3: macOS Packaging

- Use one electron-builder configuration file.
- Support macOS only until other platforms have implementations and tests.
- Keep webpack output in `dist/` and package artifacts in `release/`.
- Add a valid application icon and required macOS privacy usage descriptions.
- Keep Electron and packaging/build tooling in `devDependencies`; keep only runtime requirements in `dependencies`.
- Remove unused Electron Forge tooling if electron-builder remains the chosen packager.
- Add distinct scripts for bundle build, unpacked package smoke check, and distributable creation.
- Document signing and notarization as release prerequisites without embedding credentials.

## Phase 4: Quality Gates and CI

Add deterministic scripts:

```text
typecheck
lint
format:check
test
test:coverage
build
check
pack
```

`check` should run the fast pull-request gates in a stable order. CI should use Node.js 22 and `npm ci`.

- Run typecheck, lint, format check, unit tests with coverage, and production build on every pull request.
- Run the Electron smoke test and packaging check on a macOS runner.
- Configure `collectCoverageFrom` so unimported production modules count as uncovered.
- Introduce realistic coverage thresholds based on the measured full-source baseline, then raise them as critical paths gain tests.
- Treat build warnings intentionally: resolve avoidable declaration/test artifacts and document any accepted bundle-size warning.

## Phase 5: Runtime Boundaries and Critical Tests

### Shared contracts

- Define recording, transcript, configuration, and IPC result types in shared modules.
- Import those contracts from main, preload, and renderer instead of duplicating them.
- Replace `any` at provider and IPC boundaries with `unknown` plus validation.
- Return narrow error codes from the main process and map them to calm user copy in the renderer.

### Reliability

- Put transcription temporary-file cleanup in `finally`.
- Ensure retrying conversion cannot hang on existing temporary files.
- Validate Groq response structure before reading segments.
- Constrain transcript/export IPC paths to the configured recordings library.
- Remove unused event APIs or implement and test their lifecycle.
- Ensure IPC and renderer listeners return unsubscribe functions and are not duplicated when windows reopen.

### Module boundaries

Split the main-process entry point only where responsibility is clear:

- Application/window lifecycle.
- IPC registration.
- Recording lifecycle.
- Recordings-library storage.
- Transcription orchestration.

The entry point should compose these services rather than own their implementations.

## Verification and Delivery

Each phase gets its own focused commit or small commit series. Before claiming a phase complete:

- Run the phase's focused tests.
- Run typecheck and the full unit suite.
- Run the production build for source or configuration changes.
- Run the Electron E2E smoke test for renderer changes.
- Run the unpacked-package check for packaging changes.
- Inspect the git diff and confirm unrelated user work is untouched.

Documentation-only changes may skip Electron execution but must still be checked for placeholders, contradictions, broken links, and consistency with source.
