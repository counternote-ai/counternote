# Changelog

All notable changes to CounterNote will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-08

### Added

- Dual-channel audio capture (system audio + microphone)
- Menu bar tray with dynamic context menu
- Control panel UI with recording list
- Transcript view with timestamps and speaker labels
- Settings panel with Groq API key configuration
- Post-interview transcription via Groq Whisper API
- Channel-based speaker labeling ("Meeting audio" / "You")
- Export transcripts as plain text
- WAV recording at 16kHz sample rate
- Automatic FLAC conversion for transcription uploads
- Secure API key storage via macOS Keychain
- Unit tests for core modules
- Comprehensive documentation

### Technical

- Electron + TypeScript + React architecture
- Web Audio API with AudioWorkletNode for PCM capture
- ChannelMergerNode for proper dual-channel routing
- ffmpeg-static for audio processing
- webpack for bundling (separate entries for main, renderer, preload, worklet)

## [Unreleased]

### Changed

- Standardized the supported development runtime on Node.js 22.
- Reorganized repository documentation around current architecture, development, and privacy guidance.
- Removed the nonfunctional auto-transcribe setting; transcription remains explicitly user initiated.

### Removed

- Removed generated agent execution artifacts and an unrelated workflow proposal from version control.

### Planned

- Real-time transcription display
- Speaker diarization for multiple speakers
- Search across transcripts
- Export to SRT, PDF, Markdown
- AI-powered interview feedback
- Browser extension for Meet/Zoom/Teams
- Interview prep mode with question generation
- Analytics (talk time ratio, filler words, pacing)
