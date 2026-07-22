# Recording Permissions Design

**Date:** 2026-07-22
**Status:** Ready for user review
**Scope:** macOS recording-permission discovery, recovery, and development identity

## Overview

Interview Copilot currently discovers missing capture permissions only after the user tries to record. When screen-source discovery fails, Electron's raw error reaches the app and the display-media handler attempts to satisfy a video request without a video source. During `npm start`, macOS also identifies the development executable as `Electron`, even though the application UI calls itself Interview Copilot.

The app will check recording permissions whenever it starts, keep the recordings library usable when capture is unavailable, and provide a direct recovery action. Permission prompts remain tied to the user's Record action because macOS capture requires a focused user gesture and does not allow an application to bypass a prior denial.

## Desired Outcome

A candidate can immediately see whether Interview Copilot is ready to record and can recover from missing permissions without interpreting Electron errors.

Success means:

- Screen/System Audio and Microphone permission states are checked at startup.
- Missing permissions are named in calm, user-facing language.
- A denied or restricted permission offers an `Open System Settings` action.
- Undetermined permissions are requested from the visible Record action.
- Permission state refreshes after the user returns from System Settings.
- Existing recordings and transcripts remain usable while capture permissions are unavailable.
- Development recovery instructions correctly refer to `Electron`; packaged builds refer to `Interview Copilot`.

## Non-goals

- Renaming or maintaining a custom Electron development bundle.
- Bypassing macOS privacy controls.
- Starting capture automatically at launch.
- Blocking transcript review until recording permissions are granted.
- Adding a separate permissions screen or permanent settings section.

## Alternatives Considered

### 1. Startup check with inline recovery — selected

Check permission state at startup and show a recoverable alert on the recordings surface only when action is needed. This keeps the prerequisite visible without blocking unrelated work.

### 2. Dedicated permissions screen

A dedicated screen could explain permissions in more detail, but it adds navigation and makes two platform prerequisites feel like product configuration.

### 3. Blocking startup gate

A blocking gate would be difficult to miss, but it would prevent users from reviewing already-saved recordings and transcripts even though those tasks require no capture permission.

## Permission Model

The main process owns macOS permission inspection and system-settings navigation. It exposes a narrow renderer contract rather than exposing Electron APIs directly.

Each permission has one of these states:

- `not-determined`: macOS has not recorded a choice.
- `granted`: capture may proceed.
- `denied`: the user must change the setting manually.
- `restricted`: device policy prevents approval.
- `unknown`: the operating system did not provide a reliable result.

The permission snapshot contains:

- Screen/System Audio status.
- Microphone status.
- The permission-owner name used in recovery copy: `Electron` during `npm start`, otherwise `Interview Copilot`.
- Whether recording can be attempted immediately.

The startup check is read-only. It must not open a prompt or System Settings by itself.

## User Flow

### Startup

1. The renderer loads the recordings library as usual.
2. It asks the main process for the current Screen/System Audio and Microphone permission states.
3. If both are granted, no permission UI appears.
4. If either is denied or restricted, a recoverable alert appears near the top of the recordings surface.
5. If either is undetermined, the app explains that macOS will ask when the user selects Record. The library remains interactive.

### Record

1. The user selects Record from the visible, focused control panel.
2. The app refreshes permission state to avoid using a stale startup result.
3. If a permission is denied or restricted, capture does not start. The existing recovery alert identifies the missing permission and offers `Open System Settings`.
4. If Microphone is undetermined, the recording action requests microphone access.
5. If Screen/System Audio is undetermined, the display-media request triggers the macOS capture consent flow.
6. Recording becomes active only after both streams and the WAV writer are ready.

### Recovery

1. The user selects `Open System Settings` from the permission alert.
2. The main process opens the appropriate macOS Privacy & Security pane. If both permissions need attention, Screen/System Audio is opened first because it blocks source discovery; the alert continues to name both.
3. The app remains usable in the background.
4. When its window regains focus, the renderer fetches a fresh permission snapshot.
5. The alert updates or disappears. Copy tells the user to restart the application when macOS requires it.

## Interface And Copy

Use the existing shared `Alert` and `Button` components. The alert is inline near the top of the recordings surface, not a modal and not a fixed overlay that obscures content.

Denied Screen/System Audio example:

> Screen and system audio access is off. Allow Electron in System Settings, then restart the app.

Denied Microphone example:

> Microphone access is off. Allow Interview Copilot in System Settings, then restart the app.

Undetermined example:

> Recording needs screen, system audio, and microphone access. macOS will ask when you start recording.

Actions:

- `Open System Settings` for denied or restricted permissions.
- `Dismiss` remains available, but the warning may return on the next startup or failed Record attempt while permission is missing.

Raw Electron errors, IPC names, permission enum values, and stack traces must not appear in the renderer.

## Development And Packaged Identity

`app.name` controls Electron-facing application naming but does not rename the executable bundle that macOS records in Privacy & Security.

- `npm start` launches the bundled `Electron.app`, so recovery copy and macOS settings identify it as `Electron`.
- `npm run build && npm run pack` creates `Interview Copilot.app`; its permission owner is `Interview Copilot`.
- The app derives the recovery label from `app.isPackaged`, not from renderer assumptions.

The project will not copy, rename, or mutate `node_modules/electron/dist/Electron.app` as part of development.

## Error Handling

- A permission-query failure maps to `unknown` and produces a generic recording-readiness message rather than blocking the library.
- Failure to open System Settings leaves the alert visible and provides the manual path: System Settings → Privacy & Security.
- The display-media handler must settle each request exactly once.
- It must not call the callback with an empty response when video was requested; source-enumeration failure must become a controlled capture failure.
- Partial capture initialization stops every acquired media track and closes any created audio context.
- Permission copy is selected from structured permission state, not by matching arbitrary error-message strings.

## Architecture

### Main process

- Add a permission-status service around `systemPreferences.getMediaAccessStatus`.
- Add IPC handlers for reading the permission snapshot and opening the relevant System Settings pane.
- Keep development-versus-packaged permission-owner naming in the main process.
- Make display-source failure handling explicit and single-settlement.

### Preload contract

- Expose `getRecordingPermissions()`.
- Expose `openRecordingPermissionSettings(permission)`.
- Use explicit interfaces and permission-state unions; do not use `any`.

### Renderer

- Store the current permission snapshot independently from general operation errors.
- Check on mount, before Record, and when the window regains focus.
- Render permission guidance on the recordings surface while preserving recording-list interactions.
- Continue using the existing operation-error alert for transcription, export, save, and finalization failures.

## Testing

### Main-process tests

- Map each Electron media-access status into the permission snapshot.
- Report `Electron` for development and `Interview Copilot` for packaged builds.
- Open the correct System Settings target for Screen/System Audio and Microphone.
- Return a controlled error if System Settings cannot be opened.

### Renderer tests

- Show nothing when both permissions are granted.
- Show undetermined guidance without opening System Settings automatically.
- Name each denied permission and the correct permission owner.
- Keep recordings accessible while the alert is present.
- Recheck on Record and window focus.
- Open settings only from the explicit action.
- Do not attempt capture when permission is denied or restricted.

### Integration and visual verification

- Run the focused Jest tests and the full test suite.
- Run `npm run build`.
- Inspect the recordings surface at 400 × 600 for granted, undetermined, one-denied, and both-denied states.
- Verify keyboard focus reaches `Open System Settings` and `Dismiss`.
- Exercise `npm start` and a packaged build to confirm the recovery label matches the macOS Privacy & Security identity.

## Acceptance Criteria

- Every application startup performs a read-only recording-permission check.
- The app never initiates capture or opens System Settings during startup.
- Denied permissions have a concrete recovery action and do not expose raw errors.
- Permission status refreshes after returning to the app and before recording.
- Reviewing existing content is never blocked by capture permissions.
- The development permission name is accurate without modifying Electron's bundled executable.
