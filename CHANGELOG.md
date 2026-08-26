# Changelog

All notable CounterNote changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-beta.3] - 2026-08-27

### Fixed

- Request missing Screen Recording and Microphone permissions once on first launch
- Restore window dragging through the hidden macOS title-bar area
- Match the Screen & System Audio Recording label used by macOS System Settings
- Resolve the native audio-capture helper correctly in development worktrees

### Known limitations

- Not Developer ID signed or notarized; first launch may require **Open Anyway** in macOS Privacy & Security
- Apple Silicon only
- No automatic updates

## [0.1.0-beta.2] - 2026-08-26

### Fixed

- Ad-hoc sign the complete macOS app bundle so Gatekeeper no longer reports a malformed or damaged signature
- Verify the app embedded in the DMG, its hardened-runtime entitlements, and both native sidecars before release

### Known limitations

- Not Developer ID signed or notarized; first launch requires **Open Anyway** in macOS Privacy & Security
- Apple Silicon only
- No automatic updates

## [0.1.0-beta.1] - 2026-08-26

### Added

- First public macOS beta for Apple Silicon and macOS 13+
- Separate meeting-audio and microphone capture
- Local Whisper transcription with timestamped channel labels
- Local recordings library, transcript review, and plain-text export
- Recovery handling for interrupted recordings

### Security and privacy

- Local-only audio processing and transcription
- No telemetry or analytics
- Narrow Electron preload bridge with context isolation

### Known limitations

- Unsigned and unnotarized distribution
- Apple Silicon only
- No automatic updates
- Local speech model requires a separate first-use download

[Unreleased]: https://github.com/counternote-ai/counternote/compare/v0.1.0-beta.3...HEAD
[0.1.0-beta.3]: https://github.com/counternote-ai/counternote/releases/tag/v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/counternote-ai/counternote/releases/tag/v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/counternote-ai/counternote/releases/tag/v0.1.0-beta.1
