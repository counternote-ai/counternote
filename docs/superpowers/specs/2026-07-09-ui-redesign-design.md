# Interview Copilot UI Redesign - Design Spec

**Date:** 2026-07-09
**Status:** Ready for user review
**Scope:** Renderer UI redesign for recordings, transcript, and settings screens

## Overview

Interview Copilot has working MVP functionality, but the current renderer UI still looks like a prototype: dark global styling, emoji-based controls, limited hierarchy, and recordings that are difficult to scan quickly.

This redesign moves the app toward a compact "Review Desk" experience: warm, calm, elegant, and review-first. The app should feel like a polished Mac menu-bar utility for reviewing interviews, not a generic dashboard or marketing page.

## Design Direction

The approved direction is **Consistent Review Desk Polish**:

- Warm neutral shell with low-saturation cream/taupe surfaces.
- White cards with soft rounded corners and thin borders.
- Quiet toolbar actions that do not compete with interview content.
- Subtle but clear status labels for recording and transcription state.
- Compact density appropriate for the existing 400 x 600 Electron window.
- Small UX improvements across all screens, without adding major new product features.

The `+ Record` action should be a small outline pill in the top toolbar. It should be easy to find, but it should not dominate the recordings list.

## UI Foundation

Use **shadcn/ui + Tailwind CSS** as the UI foundation.

### Rationale

shadcn/ui is the best fit because it is Tailwind-first, uses editable component source rather than opaque packaged components, and supports semantic CSS variable theming. This gives the project a maintainable component layer while preserving enough control to create the warm Review Desk style.

### Alternatives Considered

- **Radix Themes:** Strong runner-up. Its `sand` gray scale and radius system fit the desired style, but it is not Tailwind-first and would be less convenient for detailed custom styling in this project.
- **Mantine:** Mature and capable, but its default visual language is more library-shaped and would require more overrides to achieve the desired restrained desktop utility feel.
- **Chakra UI:** Productive and accessible, but introduces its own styling system and runtime styling model. Less aligned with the Tailwind direction.
- **Material UI:** Comprehensive, but the Material Design language is too recognizable and not a natural fit for this compact macOS utility.
- **Ant Design:** Robust and Electron-compatible, but too enterprise-dashboard oriented for this small personal productivity app.

## Dependencies And Tooling

Add Tailwind and shadcn/ui support to the existing React + Webpack renderer.

Expected package additions:

- `tailwindcss`
- `@tailwindcss/postcss` or the Tailwind integration required by the current Tailwind version
- `postcss`
- `class-variance-authority`
- `clsx`
- `tailwind-merge`
- `lucide-react`
- shadcn component dependencies as needed, likely Radix primitives for select, switch, tooltip, and scroll area

Expected config additions or changes:

- Tailwind global CSS setup in the renderer stylesheet path.
- PostCSS loader support in the Webpack CSS pipeline.
- A `components.json` compatible with shadcn/ui.
- A `cn` helper under `src/renderer/lib/utils.ts`.
- Reusable UI components under `src/renderer/components/ui/`.

## Theme Tokens

Use shadcn semantic tokens and tune them toward the Review Desk palette.

Recommended token intent:

- `background`: warm app shell, close to cream/taupe rather than pure white.
- `foreground`: dark ink, softer than pure black.
- `card`: clean white or near-white surfaces for recordings, transcript panels, and settings groups.
- `card-foreground`: same dark ink family.
- `muted`: warm subdued surface for helper text and empty states.
- `muted-foreground`: taupe gray text for metadata.
- `primary`: dark ink for the few high-commitment actions, such as saving settings.
- `primary-foreground`: warm off-white.
- `secondary`: soft warm fill for low-emphasis actions.
- `accent`: subtle hover and active row surface.
- `border`: warm beige/taupe border.
- `input`: warm border for form controls.
- `ring`: restrained focus ring, visible but not neon.
- `destructive`: muted red for errors and stop-recording state.
- `radius`: larger than the default shadcn radius, tuned for soft cards and pill toolbar buttons.

Avoid a one-note beige UI by using small accents:

- Green-sage for transcript-ready status.
- Amber-taupe for needs-transcript status.
- Muted red only for recording/stop/error.
- Slate/ink for primary text and committed actions.

## Component Inventory

Start with a small component set:

- `Button`
- `Card`
- `Badge`
- `Input`
- `Label`
- `Select`
- `Switch` or checkbox replacement
- `ScrollArea`
- `Separator`
- `Tooltip`
- `Alert` or app-level error banner

Use `lucide-react` icons instead of emoji. Likely icons:

- `Plus` for new recording
- `Square` or `CircleStop` for stop recording
- `Settings`
- `Download`
- `ChevronLeft`
- `FileText`
- `LoaderCircle`
- `Mic`

## Screen Designs

### Recordings Screen

The recordings screen becomes the home surface.

Structure:

- Compact top toolbar with app label, screen title, settings icon button, and `+ Record` outline pill.
- If recording is active, replace `+ Record` with a stop action that uses destructive styling but remains clean.
- Recordings list rendered as soft cards.
- Each recording card shows title, duration, date/time metadata, and transcription status.
- Ready recordings are clickable and open the transcript.
- Untranscribed recordings show a quiet `Transcribe` action inside the card.
- While transcription is running, show a spinner state and disable duplicate transcribe actions.

Empty state:

- Use a quiet centered card or empty component.
- Copy should explain that recordings will appear after the first interview.
- The empty state should include a non-dominant `Start recording` action.

### Transcript Screen

The transcript screen should feel like a focused reading view.

Structure:

- Toolbar with `Back` and `Export` icon/text buttons.
- Header card with recording title and compact metadata: duration, segment count, transcript-ready state.
- Transcript segments as stacked reading blocks.
- Speaker distinction through a subtle left border or small badge, not emoji.
- `Interviewer` and `You` should use different restrained accent colors.
- Timestamps align consistently and stay legible.

Empty transcript state:

- If a selected recording has no segments, show a quiet empty state instead of a blank list.

### Settings Screen

Settings should feel grouped and deliberate.

Structure:

- Toolbar with back action and title.
- Card/group for transcription configuration:
  - Groq API key input.
  - Model select.
  - Auto-transcribe switch.
- Card/group for privacy note:
  - Clarify that audio is sent to Groq only when transcription runs or auto-transcribe is enabled.
- Save action is allowed to be a stronger primary button because it is the main commitment action on this screen.

The settings screen should avoid warning-style decoration unless there is an actual error. Privacy guidance should be calm and clear.

## Error And Loading States

Replace the current bright red full-width error banner with a shadcn-style alert using the Review Desk theme.

Rules:

- Errors should be visible near the top of the window.
- Dismiss remains available.
- Destructive color is reserved for real errors and stop-recording state.
- Transcription loading should be localized to the relevant recording card.
- The app should prevent duplicate transcribe clicks while a transcription is running.

## Accessibility And Interaction

- All buttons and icon buttons need accessible labels.
- Focus states must be visible on warm backgrounds.
- Do not rely on color alone for statuses; include text labels.
- Buttons must keep stable dimensions when labels change between idle and loading.
- Text must fit within the 400 px window width without overlap.
- Maintain scrollable content where recordings or transcript segments exceed the window height.

## Implementation Boundaries

In scope:

- Add Tailwind + shadcn/ui foundation.
- Replace hand-styled controls with reusable UI components.
- Redesign the three existing renderer screens.
- Add small UX improvements for empty, loading, status, and metadata states.
- Replace emoji with lucide icons.
- Keep current IPC contracts and recording/transcription behavior.

Out of scope:

- Search across transcripts.
- Filtering or sorting controls beyond current list order.
- Editing transcript content.
- True speaker diarization.
- New export formats.
- Window resizing changes unless required by layout correctness.

## Testing And Verification

Because this is mainly a renderer/UI change, verification should include:

- `npm run build`
- `npm test`
- Manual run with Electron if practical:
  - Recordings screen with zero recordings.
  - Recordings screen with mixed ready and untranscribed recordings.
  - Recording active state.
  - Transcription loading state.
  - Transcript screen with segments.
  - Transcript empty state.
  - Settings screen form controls and save.
- Visual inspection at the existing 400 x 600 window size.

If a browser-based preview is practical during implementation, use screenshots to verify that text does not overflow and controls remain aligned.
