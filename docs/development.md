# Development

## Requirements

- macOS 13 or newer
- Node.js 22.12 or newer
- npm
- Git

Use `nvm use` to select the repository's Node.js 22 runtime.

## Setup

```bash
npm ci
```

## Run once

```bash
# One-shot
npm run build
npm start
```

## Watch mode

```bash
# Terminal 1
npm run dev
```

```bash
# Terminal 2
npm start
```

Webpack watch rebuilds `dist` but does not automatically restart Electron. Use
`Cmd+R` for renderer-only changes; stop and restart `npm start` after changing
main-process or preload code.

## Local Whisper sidecar

Prepare the macOS Apple Silicon sidecar before running local transcription:

```bash
npm run build:whisper
```

Normal TypeScript watch does not rebuild whisper.cpp. Run the sidecar preparation
command again after changing its build inputs.

## Verification

```bash
npm test
npx tsc --noEmit
npm run build
```

The Electron smoke test requires a macOS GUI session:

```bash
npm run test:e2e
```

It launches an isolated 400 × 600 app window and stores ignored screenshots under `test-results/`.

## Packaging status

Packaging configuration is being consolidated in a separate maintenance phase. The current supported product is macOS-only; do not treat Windows or Linux targets as supported.
