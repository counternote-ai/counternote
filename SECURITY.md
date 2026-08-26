# Security Policy

## Supported version

Security fixes currently target the latest public CounterNote beta.

## Report a vulnerability privately

Use GitHub's private vulnerability reporting for this repository:

[Report a vulnerability](https://github.com/counternote-ai/counternote/security/advisories/new)

Do not include vulnerability details, recordings, transcripts, credentials, or personal data in a public issue. If private vulnerability reporting is not yet enabled, open a public issue containing only the request for a private contact channel; this is a release-setup action the maintainer must complete before publication.

## Security and privacy boundaries

- Local transcription does not upload recording audio or transcript text.
- The Local Whisper model is downloaded from a pinned URL and verified by size and SHA-256.
- Recordings, transcripts, exports, configuration, and diagnostics are stored locally.
- CounterNote has no telemetry or analytics.
- Electron context isolation is enabled and renderer Node integration is disabled.
- The preload bridge exposes narrow IPC operations rather than raw filesystem or Electron APIs.
- macOS Screen Recording and Microphone permissions are required for capture.

See [PRIVACY.md](PRIVACY.md) for the complete data boundary.

## Beta distribution

The first beta is unsigned and unnotarized. Download it only from this repository's GitHub Releases page and verify the SHA-256 checksum published with the release.
