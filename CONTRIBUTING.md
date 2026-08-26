# Contributing to CounterNote

Thanks for contributing. Keep each pull request focused on one change and update documentation when user-facing behavior changes.

## Requirements

- macOS 13 or newer (Apple Silicon recommended)
- Node.js 22.12 or newer
- Xcode 15 or newer (for Swift audio capture helper)
- npm
- Git

## Setup

Use the repository's Node.js runtime and install the locked dependency set:

```bash
nvm use
npm ci
```

See [Development](docs/development.md) for build, watch-mode, and verification commands.

## Code and commits

- Use TypeScript strict mode; prefer interfaces for object shapes and avoid `any`.
- Keep React components focused and use functional components with hooks.
- Use Conventional Commits, clear commit messages, and focused commits.
- Do not include secrets, generated artifacts, or unrelated formatting changes.

## Before opening a pull request

- Add or update unit tests for behavior changes.
- Run the unit tests, typecheck, and production build.
- For audio capture changes, build and verify the Swift helper.
- For renderer changes, run the Electron E2E smoke test in a macOS GUI session.
- Run the full verification sequence documented in [Development](docs/development.md).
- Describe the user-facing effect and any manual verification in the pull request.

## Permissions

The audio capture helper requires macOS Screen Recording and Microphone access.
These permissions are attributed to the helper binary. For local development with
unsigned builds, macOS may prompt differently than for signed release builds.

## Reporting issues

For bugs, include reproduction steps, expected and actual behavior, and your macOS and Node.js versions. For feature requests, explain the problem, proposed solution, and alternatives considered.

## License

Contributions are licensed under [GNU GPLv3 only](LICENSE).
