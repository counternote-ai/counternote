# Security Policy

## Reporting a vulnerability

CounterNote is not yet publicly released, and a private security-reporting address has not been published.

Do not include sensitive vulnerability details in a public issue. The maintainer will add a private reporting email here before public release.

## Security measures

For the detailed local-data and upload boundary, see [Privacy and Local Data](docs/privacy.md).

### Data storage

- The Groq API key is encrypted with Electron `safeStorage`.
- Audio recordings, transcripts, and text exports are stored locally under `~/CounterNote`.
- Non-secret settings are stored locally in `~/CounterNote/config.json`.

### Network communication

- Audio is sent to Groq only when the user selects Groq as the transcription
  provider and then explicitly selects **Transcribe audio**. Local Whisper keeps
  prepared audio on the Mac.
- Groq API requests use HTTPS.
- CounterNote does not include telemetry or analytics.

### Electron security

- Context isolation is enabled.
- Renderer Node integration is disabled.
- IPC communication is exposed through the preload bridge.
- The app does not use Electron's remote module.

### Permissions

The app uses macOS Screen Recording access for system audio and Microphone access for the user's microphone. These permissions support recording and can be reopened from the recordings screen when macOS reports that access is blocked.

## User guidance

- Keep your Groq API key private.
- Review transcripts before sharing them.
- Delete recordings you no longer need.

## Developer guidance

- Do not commit API keys or other secrets.
- Use Electron `safeStorage` for sensitive values.
- Keep dependencies updated and apply least-privilege design.

## Security auditing

Run dependency audits regularly:

```bash
npm audit
```

## License

This project is licensed under the [MIT License](LICENSE).
