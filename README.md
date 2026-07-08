# Interview Copilot

A lightweight Mac menu bar app that records audio from video interviews (Google Meet, Zoom, MS Teams), transcribes them via Groq API, and provides readable transcripts with speaker labels for post-interview review.

## Features

- **Dual-channel audio capture** — Records system audio (interviewer) and microphone (you) separately
- **Menu bar app** — Lightweight, always accessible, doesn't interfere with screen sharing
- **Post-interview transcription** — Uses Groq's Whisper API for fast, accurate transcription
- **Speaker labeling** — Automatically labels speakers based on audio channel
- **Timestamped transcripts** — Easy to review and navigate
- **Export** — Save transcripts as plain text

## Installation

### Prerequisites

- macOS 13+ (required for system audio loopback)
- Node.js 18+
- [Groq API key](https://console.groq.com)

### Setup

1. Clone the repository:
```bash
git clone https://github.com/yourusername/interview-copilot.git
cd interview-copilot
```

2. Install dependencies:
```bash
npm install
```

3. Build the project:
```bash
npm run build
```

4. Start the app:
```bash
npm start
```

5. Add your Groq API key in Settings (click ⚙️ Settings in the app)

## Usage

### Recording an Interview

1. Click **● Start Recording** in the control panel
2. Grant screen recording and microphone permissions when prompted
3. Conduct your interview
4. Click **⏹ Stop Recording** when done

### Transcribing

1. Click **Transcribe** next to any recording
2. Wait for transcription to complete (~8-30 seconds depending on length)
3. Click on the recording to view the transcript

### Exporting

1. Open a transcript
2. Click **📥 Export**
3. A plain text file will be saved alongside the audio file

## File Structure

```
~/InterviewCopilot/
├── recordings/
│   ├── 2026-07-08T14-30-00-000Z/
│   │   ├── audio.wav              # Raw dual-channel recording
│   │   ├── transcript.json        # Transcript with metadata
│   │   └── transcript.txt         # Exported plain text
│   └── ...
├── config.json                    # User settings
└── secrets.enc                    # Encrypted API key
```

## Development

### Scripts

```bash
npm run dev      # Build with webpack in watch mode
npm run build    # Build for production
npm start        # Start the Electron app
npm test         # Run unit tests
npm run pack     # Package without building installer
npm run dist     # Build macOS .dmg installer
```

### Tech Stack

- **Framework:** Electron + TypeScript
- **UI:** React
- **Audio:** Web Audio API (AudioWorkletNode)
- **Transcription:** Groq API (Whisper Large V3 Turbo)
- **Audio Processing:** ffmpeg-static

### Architecture

```
┌─────────────────────────────────────────────────┐
│                  Electron App                    │
│                                                  │
│  ┌──────────────┐       ┌────────────────────┐  │
│  │  Menu Bar     │       │  Control Panel     │  │
│  │  (Tray Icon)  │◄─────►│  (Renderer Window) │  │
│  └──────┬───────┘       └────────┬───────────┘  │
│         │                        │               │
│  ┌──────▼────────────────────────▼───────────┐  │
│  │              Main Process                  │  │
│  │  - Recording lifecycle                     │  │
│  │  - File I/O                                │  │
│  │  - Transcription orchestration             │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

## Configuration

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Groq API Key | (empty) | Your Groq API key for transcription |
| Model | whisper-large-v3-turbo | Whisper model to use |
| Auto-transcribe | false | Automatically transcribe after recording stops |

### Environment Variables

None required. All configuration is stored in `~/InterviewCopilot/config.json`.

## Troubleshooting

### "Unable to load a worklet's module"

This error occurs if the AudioWorklet file isn't being served correctly. Ensure you've run `npm run build` before `npm start`.

### "No screen sources available"

Ensure you've granted screen recording permission to the app in System Settings → Privacy & Security → Screen Recording.

### "Groq API key not configured"

Add your API key in Settings (click ⚙️ Settings in the app).

### Invalid Date in recording titles

This is a known issue with date parsing. The app should still function correctly.

## Privacy

- Audio is recorded locally and stored on your machine
- Audio is only sent to Groq's servers when you explicitly click "Transcribe"
- API keys are encrypted using macOS Keychain via Electron's safeStorage
- No data is collected or shared without your consent

## License

MIT

## Acknowledgments

- [Groq](https://groq.com) for fast Whisper transcription
- [Electron](https://electronjs.org) for the desktop framework
- [React](https://react.dev) for the UI
