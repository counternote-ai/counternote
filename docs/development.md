# Development

## Requirements

- macOS 13 or newer (Apple Silicon recommended)
- Node.js 22.12 or newer
- Xcode 15 or newer (for Swift audio capture helper)
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

## Audio capture helper

Build and verify the Swift audio capture helper:

```bash
npm run build:capture
npm run verify:capture
```

The helper is a standalone macOS binary that captures system audio and microphone
using CoreAudio. It requires Screen Recording and Microphone permissions.

## Local Whisper sidecar

Prepare the macOS Apple Silicon sidecar before running local transcription:

```bash
npm run build:whisper
npm run verify:whisper
```

Normal TypeScript watch does not rebuild whisper.cpp. Run the sidecar preparation
command again after changing its build inputs.

## Verification

Run the focused tests while developing, then the full suite before committing:

```bash
npm test
npx tsc --noEmit
npm run build
```

The Electron smoke test requires a macOS GUI session:

```bash
npm run test:e2e
```

It launches an isolated 400 × 600 app window and enforces the renderer design
guardrails: every settled state asserts no horizontal overflow and passes an
axe accessibility scan, and deterministic states compare against committed
visual baselines in `e2e/smoke.spec.ts-snapshots/`. States with wall-clock
content (live timers, new-recording titles) keep manual screenshots under the
ignored `test-results/` instead. After an intentional visual change, review the
diff, then regenerate baselines with `npx playwright test --update-snapshots`.
The jest suite also includes a token guard (`src/renderer/token-guard.test.ts`)
that fails when product components hardcode color values instead of resolving
through the tokens in `src/renderer/styles.css` or the `components/ui`
primitives.

A version-controlled pre-push hook in `scripts/git-hooks/` runs this smoke test
on every `git push`, since CI does not. The npm `prepare` script wires
`core.hooksPath` to that directory automatically on `npm install`.

## Full verification sequence

Run the complete verification sequence before requesting review:

```bash
swift test --package-path native/audio-capture
npx jest src/main/native-capture/__tests__/real-helper-integration.test.ts --runInBand
npm test
npx tsc --noEmit
npm run build
npm run build:capture
npm run verify:capture
npm run build:whisper
npm run verify:whisper
npm run test:e2e
npm run check:pack
```

## Packaging

Build and verify both sidecars, then create and check an unsigned local package:

```bash
npm run build:capture
npm run verify:capture
npm run build:whisper
npm run verify:whisper
npm run check:pack
```

`check:pack` creates an unsigned local arm64 app, verifies the nested sidecars,
and runs the packaged smoke test. It is not a signed or notarized release package.

## Permissions

The audio capture helper requires macOS Screen Recording access for system audio
and Microphone access for the user's microphone. These permissions are attributed
to the helper binary, not the Electron app. Permission recovery is available from
the recordings screen when macOS reports a blocked permission.
