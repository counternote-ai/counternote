# Local Whisper Sidecar Packaging Design

## Decision

Phase 3 will make Local Whisper reproducibly usable in development and in an
unpacked macOS Apple Silicon application without requiring release credentials.
The user-facing first-use action remains model download; the `whisper-cli`
sidecar is an application-owned runtime component, never a user setup step.

## Scope

- Build a pinned `whisper.cpp` v1.9.1 `darwin-arm64` `whisper-cli` with Metal.
- Write it to `build/whisper/darwin-arm64/whisper-cli` for development.
- Add a macOS-only electron-builder configuration that copies it to
  `Contents/Resources/whisper/bin/whisper-cli` in an unpacked app.
- Add reproducible build and unpacked-package smoke scripts, tests, ignores,
  and truthful developer documentation.
- Verify the artifact is executable, arm64, and resolved from both development
  and packaged locations.

## Explicit Non-goals

- No model weights are bundled into the application.
- No user-visible sidecar installation or configuration workflow is added.
- No Windows or Linux target is retained.
- No signing, notarization, or distributable-release claim is made without
  Apple Developer credentials.

## Architecture

`scripts/build-whisper-sidecar.sh` fetches the pinned source revision into a
temporary build cache, builds only the Metal-enabled `whisper-cli`, and copies
the executable atomically into the repository artifact location. The script
does not place source, model weights, or generated output under tracked paths.

`electron-builder.yml` remains the single package configuration. It packages
only macOS arm64, places artifacts under `release/`, and declares the sidecar
as an `extraResources` entry under `whisper/bin`. The model stays in Electron
`userData` and is never an ASAR or extra resource.

The build scripts distinguish an unsigned local package from a release: local
`pack` validates resource inclusion and executable behavior; release signing
and notarization are blocked until environment-provided credentials exist.

## User Experience

In an installed, correctly packaged App, Local Whisper is available and shows
model status such as `Not downloaded` or `Ready`. A missing sidecar in a
packaged App is an installation-integrity failure and must not be framed as a
user configuration task. A development build may explain that the developer
must run `npm run build:whisper` and restart Electron.

## Verification

Automated checks validate the build script's pinned revision and Metal build
flags, electron-builder's macOS-arm64 resource mapping, and resolver paths.
The local package gate builds the sidecar, creates an unpacked App, verifies
the nested executable using `file` and `--help`, and runs the Electron smoke
test. Signing/notarization verification is a separate release gate requiring
Apple Developer credentials.

## Risks and Boundaries

The sidecar source download requires network access only while preparing a
developer or release build; end-user local transcription remains offline after
the model is installed. Build tooling must fail clearly on non-macOS or
non-arm64 hosts rather than producing a misleading package.
