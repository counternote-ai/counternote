# CounterNote Landing Page Design

Date: 2026-08-29
Status: Implemented; revised after external review (mockup state, capability
claims, transcription flow, consent wording, version string)

## Goal

A single-page marketing site for CounterNote, served via GitHub Pages at
`https://counternote-ai.github.io/counternote/`. Its job is one thing: make a
job candidate feel the asymmetry — the company's AI notetaker produces a
detailed report after every interview round while the candidate walks out with
only their memory — and offer CounterNote as the candidate's side of that:
a counter-notetaker.

## Decisions made with the product owner

- Copy language: English (matches the repository and README).
- Primary CTA: download the beta, linking to the GitHub Releases "latest" URL
  so the button never goes stale. Secondary CTA: view on GitHub.
- Product UI is shown as a CSS-drawn interface preview (no screenshots needed),
  clearly labeled as a preview of the beta interface.
- Narrative register: sharp but restrained. The unfairness is the hook; the
  landing point is "a private tool for your own review and improvement," not
  adversarial framing. Consent and recording-law responsibility stay explicit.

## Non-goals

- No JavaScript, no build step, no npm dependencies for the site.
- No analytics, trackers, webfonts, or any third-party network requests — the
  page itself demonstrates the product's privacy promise, and the page says so.
- No language switcher, no custom domain, no blog/changelog section.

## Technical approach

Static files in a new `site/` directory, deployed by a new GitHub Actions
workflow (`.github/workflows/pages.yml`) that uploads `site/` with the official
Pages actions. Enabling Pages ("Source: GitHub Actions" in repo settings) is an
outward-facing change and happens only after the product owner confirms.

Files:

- `site/index.html` — semantic, accessible single page (no JS; FAQ uses
  native `details`/`summary`).
- `site/styles.css` — all styling, mobile-first responsive.
- `site/assets/icon.png` — copy of `build/icon.png` (og:image).
- `site/favicon.svg` — simplified inline-SVG mark derived from the app icon
  (cream tile, speech bubble, waveform bars).
- `.github/workflows/pages.yml` — deploy on pushes to `main` touching `site/`
  or the workflow itself, plus `workflow_dispatch`.
- `README.md` — one-line link to the site in the Download section.

## Page outline

1. **Nav** — icon mark + "CounterNote", anchor links (Why, How it works,
   Privacy, FAQ), Download button.
2. **Hero** — headline: "Their AI notetaker is in the room. Where's yours?"
   Subcopy names the asymmetry and positions CounterNote as the candidate's
   counter-notetaker: dual-channel recording, local transcription, a
   timestamped transcript of the conversation. CTAs + honest small print
   (free, beta, Apple Silicon, macOS 13+ — no version number, so the
   releases/latest CTA can never contradict the page).
   Right side: CSS mockup of a real shipped state — the post-recording
   transcript view: recording title, duration, two channels labeled
   `Meeting audio` / `You` as the product labels them, and timestamped
   channel-attributed segments. No REC state, live meters, question
   highlighting, or speaker identities the beta doesn't have. Caption labels
   it as a preview of the beta transcript view.
3. **"Interviews are being recorded. Just not for you."** — three cards:
   their side (auto-generated reports every round), your side (memory that
   blurs across a week of interviews), the fix (the questions they asked end
   up on your record too — timestamped, in your transcript).
4. **Features** — two channels captured separately; local Whisper
   transcription; timestamped transcript; export for review. Claims mirror the
   README exactly (channels are labeled `Meeting audio`/`You`, transcription
   is post-recording, models download on first use).
5. **How it works / after the interview** — four steps matching the shipped
   flow (Record, Stop, Transcribe, Review & export), including the two
   explicit user actions: downloading the Whisper model once in Settings
   (~548 MB) and selecting "Transcribe audio" on the saved recording.
   Framed as "turn every round into a study guide": reread how each question
   was phrased, note the better answer, walk into the next round prepared.
6. **Privacy** — inverted dark section: "Nothing leaves your Mac." Local
   Whisper, no uploads, no telemetry, recordings under `~/CounterNote/recordings`.
   Explicit consent note: recording/consent laws and company policy are the
   user's responsibility; the page never suggests obscuring that audio is
   recorded — where consent is required, it shows a plain request that names
   recording, local storage, and purpose. Links to `PRIVACY.md`.
7. **Beta status** — honest limitations (Apple Silicon only, macOS 13+,
   ad-hoc signed / not notarized with a pointer to the "Open Anyway" steps in
   the README, ~548 MB first-use model download, no auto-update yet).
8. **FAQ** — `details`/`summary`: upload question (no), tell the interviewer?
   (no legal advice; follow local law and company policy), Windows/Intel
   (not yet), live transcription (no — post-recording by design), deleting
   data (delete folders under `~/CounterNote/recordings`).
9. **Footer** — tagline "Your side of the conversation.", links to GitHub,
   Releases, Privacy, Security, Support, GPLv3, and the zero-third-party-
   requests note.

## Visual system

- Palette from the app icon: cream background `#F6EFE3`, card `#FFFDF8`,
  ink `#372A20`, muted ink `#6B5B4C`, rose `#C47066`, rose-deep `#A8514B`,
  tan `#C39B6B`, hairline `#E4D7C2`; dark sections on `#2E241B`.
- Type: system stacks only — serif display (Georgia stack) for headlines,
  system sans for body. No webfonts.
- Rhythm: rounded cards, hairline borders, soft shadows, waveform-bar motif
  as section dividers; prefers-reduced-motion respected (transitions only).

## Accessibility and honesty constraints

- Landmarks and heading order (`h1` → `h2`), focus-visible styles, alt text,
  `lang="en"`, meta description and Open Graph tags.
- Body text in dark ink on cream (AA contrast); rose used for accents and
  large text only.
- The interface mockup is labeled as a preview and depicts only states the
  beta ships (channel labels, timestamps, local-only chip); all product
  claims come from the README/PRIVACY.md; no version number is displayed so
  the releases/latest CTA cannot go stale.

## Verification

- `npm run lint` stays green (prettier formats `styles.css` and the workflow
  YAML; HTML is out of prettier's scope).
- Local render screenshots at desktop and mobile widths, reviewed visually.
- All links resolve (anchors locally; GitHub URLs checked against the repo).
- No Electron renderer/tray change, so the E2E smoke test is not required;
  app build/tests are unaffected (site is static and dependency-free).

## Deployment

1. Merge to `main` and push (product owner confirms).
2. Enable Pages with "Source: GitHub Actions" (product owner confirms; one
   settings change or `gh api` call).
3. Confirm the first `pages.yml` run publishes
   `https://counternote-ai.github.io/counternote/`.
