# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do NOT open a public issue.**

Instead, please email: [INSERT EMAIL]

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- Acknowledgment: within 48 hours
- Initial assessment: within 1 week
- Fix or mitigation: depends on severity

## Security Measures

### Data Storage

- API keys are encrypted using macOS Keychain via Electron's `safeStorage`
- Audio recordings are stored locally on the user's machine
- No data is sent to external servers without explicit user action

### Network Communication

- Audio is only sent to Groq's servers when the user clicks "Transcribe"
- All API calls use HTTPS
- No telemetry or analytics are collected

### Electron Security

- Context isolation is enabled
- Node integration is disabled in renderer
- All IPC communication goes through the preload script
- No remote module usage

### Permissions

The app requests:
- **Screen Recording** - To capture system audio (interviewer's voice)
- **Microphone** - To capture the user's voice

These permissions are required for the core functionality and are not used for any other purpose.

## Best Practices

### For Users

- Keep your Groq API key secure
- Don't share your API key with others
- Review transcripts before sharing
- Delete recordings you no longer need

### For Developers

- Don't commit API keys or secrets
- Use safeStorage for sensitive data
- Keep dependencies updated
- Follow the principle of least privilege

## Dependencies

### Production

- `electron` - Desktop framework (actively maintained)
- `react` / `react-dom` - UI library (actively maintained)
- `ffmpeg-static` - Audio processing binary

### Security Auditing

Run security audits regularly:
```bash
npm audit
```

## License

This project is licensed under the MIT License.
