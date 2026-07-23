# Accepted patterns

These patterns are supported by the current product design and shipped UI. Re-check them against behavior before reusing them in a materially different context.

## Compact two-row header

Use when app identity, a screen title, metadata, and two actions would crowd the 400 px width. Keep text in a `min-width: 0` region and actions non-shrinking.

## Recording status card

Use a card-wide action only when the transcript is ready and the whole card has one destination. Put `Transcribe audio` in a separate footer so controls are never nested.

## Localized asynchronous action

Track transcription by recording ID. Show progress in that card, block duplicate submissions, and keep unrelated ready content available.

## Focused transcript block

Use a consistent speaker badge, timestamp, and restrained side accent. Keep transcript text as the strongest content, not the chrome around it.

## Calm privacy disclosure

Place factual privacy copy beside the setting or operation that changes data movement. Use an informational card, not warning color, unless there is a current risk or error.

## Recoverable error alert

Use the shared alert near the top, name the failed action, preserve context behind it, and offer Dismiss or a concrete recovery action. Avoid modal errors.
