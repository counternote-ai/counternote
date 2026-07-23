# Interview Copilot - Agent Guidelines

This document provides guidelines for AI agents working on the Interview Copilot project.

## Project Overview

Interview Copilot is a Mac menu bar app that records audio from video interviews, transcribes them via Groq API, and provides readable transcripts with speaker labels.

## Product Design Skill

For any work that changes what a user sees, understands, chooses, or does in the renderer or tray, load and follow `.agents/skills/product-design/SKILL.md` before proposing or editing UI. This includes product shaping, UX/UI implementation, copy, accessibility, permissions, loading, empty, error, privacy, responsive, and visual review work, plus backend changes with user-visible outcomes.

Do not load the skill for backend-only work, telemetry-only changes, generated files, or tests with no shipped UI impact.

## Architecture

### Key Components

1. **Main Process** (`src/main/`)
   - `index.ts` - Electron main process, IPC handlers, app lifecycle
   - `tray.ts` - macOS menu bar tray management
   - `wav-writer.ts` - WAV file writer with proper headers
   - `config.ts` - Configuration management with safeStorage
   - `groq-client.ts` - Groq API client for transcription
   - `audio-processor.ts` - Channel splitting and FLAC conversion
   - `transcription.ts` - Transcription pipeline orchestration
   - `export.ts` - Transcript export functionality

2. **Renderer Process** (`src/renderer/`)
   - `App.tsx` - Main React component with view routing
   - `audio-capture.ts` - Audio capture using Web Audio API
   - `audio-processor.worklet.ts` - AudioWorklet for PCM processing
   - `components/ControlPanel.tsx` - Recording controls and list
   - `components/TranscriptView.tsx` - Transcript display
   - `components/Settings.tsx` - Settings UI

### Data Flow

```
User clicks Start
    ↓
Renderer calls getDisplayMedia() + getUserMedia()
    ↓
AudioContext → AudioWorkletNode → PCM chunks
    ↓
IPC: audio-data → Main process
    ↓
WavWriter writes to disk
    ↓
User clicks Stop → WAV file finalized
    ↓
User clicks Transcribe
    ↓
ffmpeg splits channels → FLAC conversion
    ↓
Groq API transcribes each channel
    ↓
Merge segments → transcript.json
```

## Coding Standards

### TypeScript

- Use strict mode
- Prefer interfaces over types for object shapes
- Use explicit return types for public functions
- Avoid `any` type - use `unknown` and type guards

### React

- Use functional components with hooks
- Keep components small and focused
- Use TypeScript interfaces for props
- Avoid inline styles - use CSS classes

### Electron

- Use `contextIsolation: true` and `nodeIntegration: false`
- All IPC communication through preload script
- Use `ipcMain.handle()` for request/response patterns
- Use `ipcMain.on()` for fire-and-forget messages

### File Naming

- Components: PascalCase (`ControlPanel.tsx`)
- Utilities: camelCase (`audio-processor.ts`)
- Tests: `*.test.ts` or `*.spec.ts`
- CSS: kebab-case (`styles.css`)

## Testing

### Unit Tests

Located in `src/main/__tests__/` and `src/renderer/__tests__/`.

Run tests:
```bash
npm test
```

### E2E Smoke Test

Located in `e2e/`. Launches the real Electron app via Playwright, checks the 400 x 600 window, home, and settings navigation, and saves screenshots to `test-results/`. Requires a macOS GUI session.

```bash
npm run test:e2e
```

### Test Coverage

Current coverage focuses on:
- WAV writer (header format, PCM writing)
- Config manager (default values, structure)
- Export utility (plain text format)
- Audio processor (duration calculation)

### Writing Tests

- Use Jest with TypeScript
- Mock external dependencies (electron, ffmpeg-static)
- Test edge cases and error conditions
- Keep tests independent and isolated

## Common Tasks

### Adding a New IPC Handler

1. Add handler in `src/main/index.ts`:
```typescript
ipcMain.handle('handler-name', async (event, arg1, arg2) => {
  try {
    // Implementation
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});
```

2. Add to preload script (`src/main/preload.ts`):
```typescript
contextBridge.exposeInMainWorld('electronAPI', {
  handlerName: (arg1, arg2) => ipcRenderer.invoke('handler-name', arg1, arg2),
});
```

3. Add TypeScript types (`src/renderer/electron-api.d.ts`):
```typescript
interface ElectronAPI {
  handlerName: (arg1: string, arg2: string) => Promise<{ success: boolean; data?: any; error?: string }>;
}
```

### Adding a New React Component

1. Create component file in `src/renderer/components/`
2. Define TypeScript interface for props
3. Implement component with proper error handling
4. Add CSS styles in `src/renderer/styles.css`
5. Import and use in parent component

### Modifying Audio Pipeline

1. Audio capture in `src/renderer/audio-capture.ts`
2. AudioWorklet processing in `src/renderer/audio-processor.worklet.ts`
3. Channel routing via `ChannelMergerNode`
4. PCM conversion in `pcmToBuffer()` method

## Known Issues

1. **Date parsing** - Recording directory names use dashes instead of colons
2. **Worklet loading** - Must be bundled separately for Electron
3. **ffmpeg-static** - Must be externalized in webpack config

## Dependencies

### Production

- `electron` - Desktop framework
- `react` / `react-dom` - UI library
- `ffmpeg-static` - Audio processing binary

### Development

- `typescript` - Type checking
- `webpack` - Bundling
- `jest` / `ts-jest` - Testing
- `electron-builder` - Packaging

## Build Process

1. TypeScript compilation
2. Webpack bundles:
   - Renderer (React app)
   - Main process
   - Preload script
   - AudioWorklet
3. Electron-builder packages for distribution

## Security Considerations

- API keys stored in macOS Keychain via safeStorage
- Context isolation enabled
- Node integration disabled
- No remote module usage
- All IPC through preload script

## Performance Notes

- Audio recording uses 16kHz sample rate (sufficient for speech)
- WAV format during recording (low CPU)
- FLAC conversion only for transcription uploads
- Dual-channel capture for speaker separation

## Future Improvements

- [ ] Real-time transcription display
- [ ] Speaker diarization (multiple speakers)
- [ ] Search across transcripts
- [ ] Export to SRT/PDF
- [ ] AI-powered interview feedback
- [ ] Browser extension for Meet/Zoom/Teams
