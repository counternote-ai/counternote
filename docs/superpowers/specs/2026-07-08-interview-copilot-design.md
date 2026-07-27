# Interview Copilot — Design Spec

**Date:** 2026-07-08
**Status:** Implemented; retained as historical design context
**Author:** Albus + Claude

**Maintenance note:** The auto-transcribe setting described in this historical design was removed because it did not have an implemented behavior.

---

## Overview

Interview Copilot is a lightweight Mac desktop app that records audio from video interviews (Google Meet, Zoom, MS Teams), transcribes them post-interview, and provides readable transcripts with speaker labels for review and self-improvement.

### Problem

Job candidates conduct video interviews but have no easy way to review what was said, how they answered, or where they can improve. Existing tools are either general meeting recorders (Otter, Fireflies) or real-time AI assistance tools (Final Round AI) — none focus on post-interview review with clean speaker separation.

### Solution

A menu bar app that captures both sides of the conversation via dual-channel audio, transcribes after the interview ends, and presents a clean, searchable transcript with timestamps and speaker labels.

### Target User

Job candidates preparing for and reviewing video interviews.

---

## Architecture

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
│  │  ┌─────────────┐  ┌────────────────────┐  │  │
│  │  │ Audio       │  │ Recording          │  │  │
│  │  │ Capture     │  │ Manager            │  │  │
│  │  │ Service     │  │ (start/stop/buffer)│  │  │
│  │  └──────┬──────┘  └────────┬───────────┘  │  │
│  │         │                  │               │  │
│  │  ┌──────▼──────────────────▼───────────┐  │  │
│  │  │         Audio Buffer (WAV/PCM)       │  │  │
│  │  │         Written to local disk        │  │  │
│  │  └──────────────────┬──────────────────┘  │  │
│  └─────────────────────┼─────────────────────┘  │
│                        │                         │
│  ┌─────────────────────▼─────────────────────┐  │
│  │         Transcription Service              │  │
│  │   (post-interview, Groq Whisper API)       │  │
│  └─────────────────────┬─────────────────────┘  │
│                        │                         │
│  ┌─────────────────────▼─────────────────────┐  │
│  │         Transcript Storage                 │  │
│  │   (local files, JSON with metadata)        │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

### Key Layers

1. **Main Process** — owns recording lifecycle, transcription orchestration, file I/O, IPC hub
2. **Renderer Process** — owns audio capture (AudioContext, AudioWorkletNode), streams PCM to main via IPC
3. **Menu Bar (Tray)** — always visible, quick controls: record, play, transcript count
4. **Control Panel** — renderer window for viewing transcripts, managing recordings, settings
5. **Audio Capture** — system audio (loopback) + microphone, dual-channel, captured in renderer
6. **Transcription** — post-interview via Groq Whisper API, per-channel with speaker labels
7. **Storage** — local filesystem, one folder per interview with audio + transcript JSON

---

## Tech Stack

- **Framework:** Electron + TypeScript
- **UI:** React (renderer process)
- **Audio Processing:** Web Audio API (AudioContext, AudioWorkletNode)
- **Audio Format Conversion:** ffmpeg (channel splitting, WAV → FLAC) — bundled binary via `ffmpeg-static` npm package (no local install required)
- **Transcription:** Groq API (Whisper Large V3 Turbo)
- **Storage:** Local filesystem (JSON transcripts, WAV/FLAC audio)
- **Packaging:** electron-builder

---

## Feature: Audio Capture & Recording

### Dual-Channel Approach

- **Channel 1 (System Audio):** Captures interviewer's voice and any shared audio
- **Channel 2 (Microphone):** Captures user's voice via `navigator.mediaDevices.getUserMedia({ audio: true })` in the renderer process
- Both channels recorded simultaneously into a single dual-channel WAV file
- Sample rate: 16kHz (sufficient for speech recognition, Whisper downsamples to 16kHz anyway)

**System Audio Capture — The Hard Part:**

The W3C Screen Capture spec requires `getDisplayMedia()` to include exactly one video track — audio-only requests are rejected. The Electron-specific approach:

1. **Main process:** `session.setDisplayMediaRequestHandler()` configures the handler to provide `{ video: source, audio: 'loopback' }` when the renderer requests display media
2. **Renderer:** Call `getDisplayMedia({ video: true, audio: true })` — Electron intercepts and injects the loopback audio
3. Immediately stop/discard the video track (keep only the audio track)
4. Feed the audio track into `AudioContext` → `AudioWorkletNode` for processing

**Capture Lifecycle — User Activation Requirement:**

`getDisplayMedia()` requires transient user activation (focused document + recent user gesture). A hidden window or tray-triggered IPC does NOT satisfy this. The solution:

- **Visible start button:** When user clicks "Start Recording" in the control panel (a visible, focused window with a real button click), the renderer calls `getDisplayMedia()` directly
- This satisfies the user activation requirement naturally — no workarounds needed
- The tray menu can also trigger recording, but must open/focus the control panel first so the user clicks the button there

```
User clicks "Start Recording" button in control panel (visible, focused window)
       │
       ▼
Renderer calls getDisplayMedia({ video: true, audio: true })
  → Electron handler provides screen source + loopback audio
  → gets screen stream with system audio
  → stops video track, keeps audio track
       │
       ▼
Renderer calls getUserMedia({ audio: true })
  → gets microphone stream
       │
       ▼
Both tracks → AudioContext → AudioWorkletNode → IPC → WAV file (disk)
```

**Important:** Before building the full app, prototype this capture flow as a **spike** to verify Electron loopback + user activation works as expected on macOS.

**macOS Requirements:**
- macOS 13+ required for system audio loopback via Electron
- macOS 14.2+ requires `NSAudioCaptureUsageDescription` in Info.plist
- macOS 12.7.6 and lower cannot capture system audio through Electron without a virtual audio device (e.g., BlackHole)
- Screen recording permission will be requested by macOS (indicator appears in menu bar)

### Architecture Decision: Renderer-Side Capture

Audio capture APIs (`navigator.mediaDevices`, `AudioContext`, `AudioWorkletNode`) are renderer-side web APIs. The capture pipeline runs in the **control panel window** (renderer process) and streams PCM data to the **main process** via IPC for disk I/O.

```
Control Panel (Renderer)                  Main Process
┌─────────────────────────────┐          ┌──────────────────┐
│ System Audio ──┐            │          │                  │
│               ├──►AudioContext         │  Receive PCM     │
│ Microphone ────┘    │       │   IPC    │  chunks, write   │
│                     ▼       │ ───────► │  to WAV file     │
│              AudioWorkletNode          │  on disk         │
│              (PCM chunks)   │          │                  │
└─────────────────────────────┘          └──────────────────┘
```

### Audio Pipeline

```
System Audio ──┐
               ├──► AudioContext ──► AudioWorkletNode ──► IPC ──► WAV file (disk)
Microphone ────┘    (dual-channel)
```

### Recording Format

- **During recording:** WAV 16kHz dual-channel (~100MB for 30 minutes)
- **Why WAV during recording:** Near-zero CPU (just appending PCM data), no risk of encoding falling behind during the interview

### Recording Lifecycle

1. User clicks "Start Recording" button in control panel (visible, focused window with real user gesture)
2. App requests permissions (screen recording, microphone) if not granted
3. Audio capture begins, writing to `~/InterviewCopilot/recordings/<timestamp>/audio.wav`
4. User clicks "Stop" (control panel button, tray menu, or global shortcut) — file is finalized
5. If auto-transcribe is enabled, transcription begins immediately

**Note on tray/shortcut start:** The tray menu and global shortcut (`Cmd+Shift+R`) open/focus the control panel — they do NOT start recording directly. Recording must begin from a visible button click in the control panel to satisfy `getDisplayMedia()` user activation requirements. Stop recording can be triggered from any source (tray, shortcut, or control panel).

---

## Feature: Transcription

### Provider

**Groq API** (Whisper Large V3 Turbo)
- Cost: ~$0.04/hour of audio (~$0.04 per 30-min interview, since both channels are transcribed separately = ~60 min billed)
- Speed: Provider-dependent, will measure actual latency in MVP (Groq advertises 189-216x real-time, but two-channel upload/chunk/merge adds overhead)
- API: OpenAI-compatible (easy to swap providers later)
- Timestamps: Segment-level and word-level in `verbose_json` format
- Upload limits: 25MB (free tier), 100MB (dev tier) — 30-min mono WAV channel files (~50MB) may exceed free tier limits, so FLAC conversion before upload is standard practice, not just an error edge case

### Pipeline

```
audio.wav (dual-channel)
       │
       ▼
┌─────────────┐
│ Channel     │  Split dual-channel WAV into
│ Splitter    │  two separate mono WAV files
│ (ffmpeg)    │
└──────┬──────┘
       │
       ├──► Channel 1 (system.wav)
       │         │
       │         ▼
       │    Convert to 16kHz mono FLAC
       │    (ffmpeg: -ar 16000 -ac 1 -c:a flac)
       │         │
       │         ▼
       │    Chunk if >25MB (Groq free tier limit)
       │         │
       │         ▼
       │    Groq API ──► segments[]
       │
       └──► Channel 2 (mic.wav)
                 │
                 ▼
            Convert to 16kHz mono FLAC
                 │
                 ▼
            Chunk if >25MB
                 │
                 ▼
            Groq API ──► segments[]
                              │
                              ▼
                   ┌──────────────────┐
                   │ Merge & Sort     │
                   │ by timestamp,    │
                   │ assign speakers  │
                   └────────┬─────────┘
                            │
                            ▼
                   transcript.json
```

**FLAC conversion is mandatory for Groq uploads** — 30-min mono WAV files (~50MB) exceed the 25MB free tier limit. Converting to FLAC (~20MB per channel) keeps files under the limit without chunking in most cases.

### Speaker Labeling (Not True Diarization)

**What this is:** Channel-based labeling, not AI-powered diarization.
- Channel 1 (system audio) → labeled as "Interviewer"
- Channel 2 (microphone) → labeled as "You"

**Known limitations (acknowledged for MVP):**
- Multiple remote speakers (e.g., panel interview) will all be labeled "Interviewer"
- Audio leaking from speakers into the mic may cause duplicate segments
- System notifications captured on Channel 1 will be labeled "Interviewer"
- Overlapping speech across channels will appear as two separate segments

**Why this is acceptable for MVP:**
- Most interviews are 1:1, so "Interviewer" is usually one person
- The dual-channel separation is still cleaner than single-channel with AI diarization
- Users can manually correct speaker labels in the transcript (future feature)
- True diarization (e.g., pyannote-audio) can be added later as an enhancement

### Error Handling

| Error | Handling |
|-------|----------|
| No API key configured | Prompt to add in Settings before transcribing |
| API rate limited | Queue and retry with exponential backoff |
| File too large (>25MB) | Split into chunks, transcribe sequentially |
| Network error | Save audio locally, retry later with "Transcribe" button |
| API returns error | Show error message, keep audio file for retry |

---

## Feature: Storage & File Management

### Directory Structure

```
~/InterviewCopilot/
├── recordings/
│   ├── 2026-07-08T14-30-00/
│   │   ├── audio.wav              # Raw dual-channel recording
│   │   ├── channel-system.wav     # Split: system audio
│   │   ├── channel-mic.wav        # Split: microphone
│   │   └── transcript.json        # Final transcript with metadata
│   ├── 2026-07-09T10-00-00/
│   │   └── ...
│   └── ...
├── config.json                    # User settings
└── logs/
    └── app.log                    # Error/debug logs
```

### Transcript Format

```json
{
  "id": "2026-07-08T14-30-00",
  "title": "Interview — Jul 8, 2026, 2:30 PM",
  "duration": 1847,
  "audioFile": "audio.wav",
  "createdAt": "2026-07-08T14:30:00Z",
  "transcribedAt": "2026-07-08T15:05:12Z",
  "segments": [
    { "start": 0.0, "end": 4.2, "speaker": "Interviewer", "text": "Tell me about yourself." },
    { "start": 4.5, "end": 28.1, "speaker": "You", "text": "Sure, I'm a software engineer..." }
  ]
}
```

### Config Format

**`config.json`** (non-sensitive settings):
```json
{
  "groqModel": "whisper-large-v3-turbo",
  "autoTranscribe": false,
  "outputDir": "~/InterviewCopilot/recordings"
}
```

**Secret storage** (sensitive data via Electron `safeStorage`):
- `safeStorage.encryptStringAsync()` returns an encrypted `Buffer` — it does NOT store the value
- The encrypted buffer is written to `~/InterviewCopilot/secrets.enc`
- At runtime, read the file and call `safeStorage.decryptStringAsync(buffer)` to retrieve the key
- `decryptStringAsync()` returns an object `{ result: string, shouldReEncrypt: boolean }` — read `.result` for the key, and re-encrypt if `shouldReEncrypt` is true
- Use async APIs (`encryptStringAsync` / `decryptStringAsync`) for consistency with async file I/O
- Never written to plaintext config files

### Privacy & Consent

- **`autoTranscribe` defaults to `false`** — user must explicitly enable auto-transcription
- When auto-transcribe is off, user manually triggers transcription after reviewing the recording
- Audio sent to Groq API only when transcription is triggered (not during recording)
- Settings panel includes a disclosure: "Transcription sends audio to Groq's servers for processing"

---

## Feature: UI/UX

### Menu Bar (Tray Icon)

**States:**
- **Idle:** Monochrome/neutral icon
- **Recording:** Pulsing red icon, menu shows "Stop Recording" with elapsed time
- **Transcribing:** Spinner icon, menu shows "Transcribing..."

**Menu items:**
- Open Control Panel (to start recording)
- Stop Recording (only visible during recording)
- Transcript count (informational)
- Settings
- Quit

### Control Panel Window

**Main view — Recording list:**
- List of past interviews with date, duration, transcription status
- "Start Recording" button
- "Settings" button
- Transcription progress indicator

**Transcript view (click on an interview):**
- Full transcript with timestamps and speaker labels
- Search functionality
- Export button (plain text)

**Settings panel:**
- Groq API key input
- Model selection
- Auto-transcribe toggle
- Recording quality (16kHz)
- Storage location

### Keyboard Shortcuts

- `Cmd+Shift+R` — Open/focus control panel (then click button to start recording) or stop recording if already recording

### UX Decisions

- Small window, minimal chrome — feels lightweight
- Control panel is a normal interactive window (not click-through)
- **Overlay mode (future):** Optional always-on-top mini-overlay for quick status — uses `setIgnoreMouseEvents(true)` to be click-through, separate from the main control panel
- **Screen sharing protection:** `BrowserWindow.setContentProtection(true)` prevents the window from being captured by screen sharing — however, on newer macOS with ScreenCaptureKit, this may not be fully reliable. For MVP, the control panel should be minimized/hidden when screen sharing starts (user responsibility)

---

## Error Handling & Edge Cases

### Permission Failures

| Permission | What happens | Recovery |
|------------|--------------|----------|
| Screen Recording denied | Can't capture system audio | Show dialog with instructions to grant in System Settings |
| Microphone denied | Can't capture your voice | Show dialog with instructions to grant in System Settings |
| Both denied | Can't record at all | Disable record button, show setup guide |

### Recording Failures

| Error | Handling |
|-------|----------|
| Disk full | Stop recording, show warning, save what we have |
| Audio device disconnected | Show warning, attempt to continue with available device |
| App crashes mid-recording | On restart, detect incomplete recording, offer to keep or discard |

### Edge Cases

- **No audio detected:** After 30 seconds of silence, show warning "No audio detected — check your mic/system audio"
- **Very long interviews:** Handle 2+ hour recordings gracefully (larger file splits for API)
- **Multiple monitors:** Menu bar icon visible on all screens

---

## Competitive Landscape

### Closest Competitors

| Product | What It Does | Our Differentiation |
|---------|--------------|---------------------|
| Final Round AI | Real-time AI assistance during interviews | Post-interview review, not live cheating |
| MacWhisper | Local Whisper transcription, meeting capture | Dual-channel audio, interview-specific UI |
| Otter.ai / Fireflies | General meeting recorders | Purpose-built for interview review |
| Buzz (OSS) | Offline transcription with diarization | No meeting capture, no interview UI |

### Our Differentiators

1. **Dual-channel audio capture** — captures separate audio channels for cleaner speaker separation (most competitors rely on AI diarization on single-channel audio)
2. **Post-interview review focus** — not real-time assistance, not general meetings
3. **Menu bar UX** — lightweight, always accessible
4. **Local-first privacy** — audio stays on machine until transcription

---

## Future Features (Post-MVP)

### Near-term (high value, moderate effort)

- Real-time question detection and suggestions
- Pause/resume recording with audio merge support
- Full-text search across all transcripts
- Export to SRT (subtitles), PDF, Markdown

### Mid-term (good value, more effort)

- AI-powered post-interview summary and feedback
- Speaker labeling customization (rename "Interviewer")
- Recording trimming (mark sections to exclude)
- Multiple audio device support

### Long-term (nice to have)

- Browser extension for Meet/Zoom/Teams
- Interview prep mode (load job description, generate questions)
- Analytics (talk time ratio, filler word count, pacing)
- Cloud sync (optional backup)

---

## MVP Scope Summary

**In scope:**
- Electron app, Mac-first (macOS 13+ required for system audio loopback)
- Menu bar + control panel UI
- Dual-channel audio capture (system + mic) as WAV 16kHz
- Post-interview transcription via Groq API (Whisper V3 Turbo)
- Transcript view with timestamps + speaker labels
- Export as plain text
- Local file storage, JSON transcripts

**Out of scope (future):**
- Real-time suggestions
- Pause/resume
- AI-powered review/feedback
- Browser extension
- Cloud sync
