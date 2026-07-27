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
npm run build
npm start
```

For watch mode, run `npm run dev` and `npm start` in separate terminals.

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
