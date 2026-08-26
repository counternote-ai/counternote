---
name: releasing-counternote-beta
description: Use when preparing, publishing, retrying, or verifying a CounterNote macOS beta release, GitHub prerelease, release tag, or DMG.
---

# Releasing a CounterNote Beta

## Overview

Prepare or verify safely, and publish one Apple Silicon macOS prerelease only when explicitly authorized. The tag, commit, metadata, notes, DMG, and checksum must agree.

## Select the operating mode

- **Prepare:** inspect and change local release metadata, run checks, and commit only when requested. Do not push, create/push tags, upload assets, or create/edit releases.
- **Verify:** inspect local and remote evidence without changing files, refs, assets, or release metadata.
- **Publish or repair:** perform only the external mutations the user explicitly authorized for the named repository and version. Confirm that authorization immediately before the first external write if either target is unclear. A new target or destructive repair needs new authorization.

## Release invariants

- Derive `VERSION` from `package.json`, `TAG` as `v$VERSION`, and the DMG as `release/CounterNote-$VERSION-arm64.dmg`. Never copy a prior version's values.
- Preserve unrelated and untracked files. Stage release files explicitly.
- Create new CounterNote beta tags as lightweight tags with `git tag "$TAG" "$COMMIT"`. Existing history contains both lightweight and annotated tags; resolve either to its peeled commit before reuse. Never change, delete, force, or replace an existing local or remote tag.
- A remote tag or release that points somewhere unexpected is a stop condition.
- Bind every git and GitHub operation to `REMOTE=origin` and `REPO=counternote-ai/counternote`. Before any external write, require `origin` to normalize to that exact GitHub repository; stop if it is a fork or any other URL.
- All pushes happen before the final package build. The pre-push hook runs `npm run test:e2e`; its build step deletes `release/`.
- Always generate the uploadable DMG with a fresh, successful `npm run check:pack` after the last push. Never upload a DMG merely because it already existed.
- Compute the release checksum only after that final build. Release notes must contain that exact checksum.

## Workflow

1. Select Prepare, Verify, or Publish/repair mode. Inspect `git status`, current branch/HEAD, recent tags, `package.json`, `CHANGELOG.md`, `docs/development.md`, the configured remote, and the version-controlled hooks. Confirm the intended version with the user if it is not already explicit.
2. Query both git and GitHub before mutating anything:
   - `origin` URL, remote `main`, and `refs/tags/$TAG` plus its optional peeled `refs/tags/$TAG^{}`;
   - `gh api --include "repos/$REPO/releases/tags/$TAG"`.
   A successful, empty `git ls-remote` result confirms that the tag is absent. For the release API, HTTP 404 confirms absence and HTTP 200 confirms existence; authentication, network, and every other response are unknown state and require stopping.
3. Prepare the release metadata. Update the package and lockfile versions, `package.json` artifact path, `src/main/__tests__/packaging-config.test.ts` expectations, README/current-release references, privacy/development docs when their current-version text applies, and `CHANGELOG.md`. Search for the prior active version to catch other current references. Preserve historical release entries and describe only changes actually present since the prior tag.
4. Run the repository gates appropriate to the diff, inspect the diff, and commit only if requested. Stop here in Prepare mode. In Publish mode, revalidate the bound repository and authorization, then push `main` without bypassing hooks or force-pushing. Verify remote `main` equals `COMMIT`; unexpected divergence is a stop condition.
5. Query CI by exact `COMMIT`. Wait while it is queued or in progress and require a completed `success`. Failed, cancelled, skipped, timed-out, or action-required results stop the release. If no run exists, report that CI is unverified; proceed only when repository policy permits it or, after seeing the missing-run evidence, the user explicitly accepts the local verification evidence. Do not modify CI merely to create a run.
6. Recheck tag/release absence. Create the lightweight tag at `COMMIT`, push it, and verify the remote tag resolves to `COMMIT`. For an existing tag, resolve its peeled commit whether it is lightweight or annotated; reuse it only when that commit matches, without rewriting it. The tag push also invokes the pre-push hook and can delete any existing DMG.
7. After the final push finishes, run `npm run check:pack`. Stop on any failure. Then compute the DMG SHA-256 and byte size and create release notes in a temporary file. Include supported hardware/macOS, ad-hoc and unnotarized installation guidance, first-use model-download networking, local-only transcription, no automatic updates, and the exact checksum.
8. Reconfirm Publish authorization, then create the GitHub prerelease with `gh release create "$TAG" "$DMG" --repo "$REPO" --title "CounterNote $TAG" --notes-file "$NOTES_FILE" --prerelease --verify-tag`. If creation or upload fails, inspect remote state before retrying; never blindly rerun a partially successful mutation. Uploading to an existing matching release is a separate repair mutation and requires explicit authorization.
9. Verify the remote tag's peeled SHA separately with `git ls-remote "$REMOTE"` or the Git refs API and require it to equal `COMMIT`; `targetCommitish` may be a branch name and is informational only. Use `gh release view --json name,body,tagName,targetCommitish,isPrerelease,assets,url` to require the expected title, tag, prerelease status, required notes, exact checksum text, and asset name/state/size/digest. If GitHub does not expose a digest, download to a temporary directory and compare SHA-256. Confirm the working tree still contains only pre-existing unrelated changes. Verify mode ends after reporting this evidence and never repairs mismatches automatically.

## Failure recovery

| Symptom | Required response |
|---|---|
| DMG missing after push | Expected hook side effect; run the final `npm run check:pack` now. |
| Release exists but asset is absent | Inspect release/tag/commit and notes, then use `gh release upload` only if they match the intended release. |
| Release contains an unexpected or mismatched asset | Stop and ask the user; do not delete it or use `--clobber`. |
| Existing release has stale notes, title, or prerelease status | Stop and ask the user before editing published metadata. |
| Tag exists at another commit | Stop and ask the user; never move it. |
| Remote `main` diverges from the release commit | Stop and reconcile explicitly; never force-push. |
| Checksum changed after rebuilding | Use only the newest verified DMG and update notes before upload. |
| `gh` or git cannot reach GitHub | Stop; do not infer that remote resources are absent. |

## Completion report

Return the release URL, direct DMG URL, tag and commit, byte size, SHA-256, prerelease status, verification results, and any untouched pre-existing working-tree changes.
