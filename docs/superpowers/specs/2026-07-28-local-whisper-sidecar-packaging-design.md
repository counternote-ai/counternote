# Local Whisper Sidecar Packaging Design

## Decision

Phase 3 will make Local Whisper reproducibly buildable for development and in an
unpacked macOS Apple Silicon application without requiring release credentials.
The user-facing first-use action remains model download; the `whisper-cli`
sidecar is an application-owned runtime component, never a user setup step.

## Scope

- Build `whisper.cpp` v1.9.1 at commit
  `f049fff95a089aa9969deb009cdd4892b3e74916` as a statically linked
  `darwin-arm64` `whisper-cli` with Metal.
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
- No Windows or Linux packaging support is offered.
- No signing, notarization, or distributable-release claim is made without
  Apple Developer credentials.

## Relationship to Prior Specifications

This specification narrows the packaging portion of
`2026-07-27-local-whisper-transcription-design.md` to the credential-independent
deliverable approved for the current phase: a reproducible unsigned local
package. The prior specification's signed and notarized acceptance criterion is
moved to a credential-gated release phase; it is not considered satisfied here.

Documentation that currently describes the sidecar as signed must distinguish
the verified unsigned development/package artifact from the future signed
release artifact.

## Architecture

`scripts/build-whisper-sidecar.sh` fetches the pinned source revision into a
temporary build cache, configures CMake with `-DBUILD_SHARED_LIBS=OFF` and Metal
enabled, builds only `whisper-cli`, and copies the executable atomically into
the repository artifact location. Static linking is required so the copied
binary does not depend on unshipped `libwhisper` or `libggml` dylibs. The
embedded Metal library remains enabled, so no separate `.metallib` resource is
required. The script does not place source, model weights, or generated output
under tracked paths.

`electron-builder.yml` remains the single package configuration. It packages
only macOS arm64, places artifacts under `release/`, and declares the sidecar
as an `extraResources` entry under `whisper/bin`. The model stays in Electron
`userData` and is never an ASAR or extra resource.

The dead `package.json` `build` block is removed so it cannot diverge from the
YAML configuration. The existing Windows and Linux stanzas are removed from
the YAML, and `directories.output` changes from `dist` to `release`.
Electron Forge tooling is removed because electron-builder is the chosen
packager.

The unpacked package includes `NSMicrophoneUsageDescription` through
`mac.extendInfo` so microphone capture is not terminated by the operating
system. ScreenCaptureKit uses the macOS Screen Recording TCC prompt and has no
parallel required usage-description key. A valid application icon and release
entitlements remain part of the credential-gated release phase because no
suitable application icon is currently present.

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

Automated checks validate the build script's full 40-character pinned revision,
static and Metal build flags, electron-builder's macOS-arm64 resource mapping,
the absence of a package.json `build` block and non-macOS targets, and resolver
paths.
The local package gate builds the sidecar, creates an unpacked App, verifies
the development and nested executables using `file`, `--help`, and `otool -L`,
and asserts that neither has `libwhisper` nor `libggml` dylib references. It
then launches the unpacked application and verifies packaged-mode sidecar
resolution through `process.resourcesPath` plus the Settings `Not downloaded`
state. Full transcription with the fake CLI and loopback model server remains a
development-mode E2E test because packaged builds intentionally ignore those
overrides. Signing/notarization verification is a separate release gate
requiring Apple Developer credentials.

## Risks and Boundaries

The sidecar source download requires network access only while preparing a
developer or release build; end-user local transcription remains offline after
the model is installed. Build tooling must fail clearly on non-macOS or
non-arm64 hosts rather than producing a misleading package.

Only `/build/whisper/` is ignored. The parent `/build/` remains available for
tracked electron-builder resources such as future icons and entitlements.
