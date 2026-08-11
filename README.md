# Interview Copilot

Interview Copilot is a macOS Electron menu-bar app that records video-interview audio, transcribes it locally with Whisper or through Groq when selected, and presents timestamped channel-labeled transcripts for review.

## Features

- Separate system-audio and microphone capture
- Menu-bar recording controls and a local recordings library
- Local Whisper transcription by default, with optional Groq transcription
- Channel-based Interviewer and You labels
- Timestamped transcript review
- Plain-text transcript export

## Requirements

- macOS 13 or newer
- Node.js 22.12 or newer
- An Apple Silicon Mac for Local Whisper
- A [Groq API key](https://console.groq.com) only when using Groq

## Local setup

```bash
npm ci
npm run build:whisper
npm run build
npm start
```

Open **Settings** and download the Local Whisper model. To use Groq instead,
select Groq, enter your API key, then select **Save settings**.

## Use Interview Copilot

1. Select **Record** and allow Screen Recording and Microphone access when macOS asks.
2. Select **Stop** when the interview ends. The recording appears in Past Interviews.
3. Select **Transcribe audio** on a saved recording to create its transcript.
4. Select a transcribed recording to review timestamped segments, then select **Export** to write a plain-text export beside the recording.

Local Whisper keeps prepared audio on your Mac. Audio is sent to Groq only when
you explicitly select Groq as the provider and then select **Transcribe audio**.

## Local data

```text
~/InterviewCopilot/
├── recordings/
│   └── <timestamp>/
│       ├── audio.wav
│       ├── transcript.json       # Created after transcription
│       └── transcript.txt        # Created after export
├── config.json                   # Non-secret settings
└── secrets.enc                   # Encrypted Groq API key
```

## Documentation

- [Architecture](docs/architecture.md)
- [Development](docs/development.md)
- [Privacy and local data](docs/privacy.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [License](LICENSE)

## Troubleshooting

### Recording permissions

If recording is blocked, use **Open System Settings** on the recordings screen to grant Screen Recording or Microphone access, then restart the app if macOS requests it.

### Worklet build error

If the app cannot load the audio worklet, run `npm run build` before `npm start`.

### Missing Groq API key

If Groq is selected, open **Settings**, add a Groq API key, and select
**Save settings** before selecting **Transcribe audio**. Local Whisper does not
require a Groq API key.
