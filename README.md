# CounterNote

**Your side of the conversation.**

CounterNote is a local-first macOS meeting recorder and transcription app. It captures meeting audio and your microphone as separate channels, creates a timestamped transcript with Local Whisper, and keeps the supported workflow on your Mac.

> CounterNote is beta software. The current build is ad-hoc signed but not Developer ID signed or notarized, supports Apple Silicon only, and may contain bugs. Keep a backup of important recordings.

## Download

Download the latest beta from [GitHub Releases](https://github.com/counternote-ai/counternote/releases). The current release is `v0.1.0-beta.3`:

`CounterNote-0.1.0-beta.3-arm64.dmg`

Requirements:

- Apple Silicon Mac
- macOS 13 or newer
- About 547 MB of additional disk space for the Local Whisper model

## Install the unnotarized beta

1. Download and open the DMG.
2. Drag CounterNote to Applications.
3. Try to open CounterNote from Applications.
4. If macOS blocks it, open **System Settings → Privacy & Security**, find the CounterNote message, then select **Open Anyway**.
5. Return to Applications and open CounterNote again.

This beta is ad-hoc signed but is not Developer ID signed or notarized. Only download it from this repository's GitHub Releases page and compare its SHA-256 checksum with the release notes.

## Record and transcribe

1. Open CounterNote and select **Record**.
2. Allow Screen Recording and Microphone access when macOS asks. Restart CounterNote if macOS requests it.
3. Select **Stop** when the meeting ends. The finalized recording appears in Recordings.
4. Open **Settings** and download the Local Whisper model the first time you use transcription.
5. Select **Transcribe audio** on a saved recording.
6. Open the completed transcript to review or export it.

`Meeting audio` and `You` identify the two recorded audio channels. They are not inferred speaker identities or diarization.

## Local data and privacy

Recordings and transcripts remain on your Mac in `~/CounterNote/recordings`. Local Whisper runs on the Mac; CounterNote does not upload recording audio or transcript text. Downloading the speech model requires an internet connection.

See [Privacy](PRIVACY.md) for the exact data flow and storage locations.

## Recording consent

You are responsible for following applicable recording and consent laws, workplace rules, and meeting policies. CounterNote does not provide legal advice.

## Known limitations

- Apple Silicon only; Intel Macs are not supported.
- macOS 13 or newer is required.
- The beta is ad-hoc signed but not Developer ID signed or notarized.
- Transcription is post-recording and local only.
- The Local Whisper model is a separate first-use download.
- There is no automatic update mechanism yet.

## Build from source

Development requires Node.js 22.12+, npm, Xcode 15+, CMake, and an Apple Silicon Mac. Start with [Development](docs/development.md) and [Contributing](CONTRIBUTING.md).

## Help and security

- [Support and issue reporting](SUPPORT.md)
- [Security policy](SECURITY.md)
- [Architecture](docs/architecture.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

CounterNote is licensed under [GNU GPLv3 only](LICENSE).
