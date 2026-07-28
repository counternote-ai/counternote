import {
  ConsoleWhisperProcessLogger,
  WhisperDiagnosticBuffer,
  type WhisperProcessLogEvent,
} from '../whisper-process-logger';

describe('WhisperDiagnosticBuffer', () => {
  it('keeps allow-listed stderr diagnostics but drops transcript and environment lines', () => {
    const buffer = new WhisperDiagnosticBuffer();
    buffer.append('whisper_model_load: loading model\n');
    buffer.append('[00:00:00.000 --> 00:00:02.000] sensitive transcript text\n');
    buffer.append('PATH=/private/bin API_KEY=provider-secret-value\n');
    buffer.finish();

    expect(buffer.summary()).toContain('whisper_model_load: loading model');
    expect(buffer.summary()).not.toContain('sensitive transcript text');
    expect(buffer.summary()).not.toContain('PATH=');
    expect(buffer.summary()).not.toContain('provider-secret-value');
  });

  it('treats carriage return and newline as boundaries and redacts paths', () => {
    const buffer = new WhisperDiagnosticBuffer();
    buffer.append(
      'whisper_print_progress_callback: progress = 5%\r' +
      'output_json: saving output to /Users/example/private/transcript.json\n'
    );
    buffer.finish();

    expect(buffer.summary()).toContain('progress = 5%');
    expect(buffer.summary()).toContain('<redacted-path>');
    expect(buffer.summary()).not.toContain('/Users/example');
  });

  it('caps each line at 512 characters and the tail at 4096 characters', () => {
    const buffer = new WhisperDiagnosticBuffer();
    for (let index = 0; index < 20; index += 1) {
      buffer.append(`whisper_error: ${'x'.repeat(700)}-${index}\n`);
    }
    buffer.finish();

    expect(buffer.summary().length).toBeLessThanOrEqual(4096);
    expect(buffer.summary()).not.toContain('x'.repeat(513));
  });
});

describe('ConsoleWhisperProcessLogger', () => {
  it('prints only the fields in a process event', () => {
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const logger = new ConsoleWhisperProcessLogger();

    try {
      logger.log({
        type: 'failure',
        code: 'LOCAL_TRANSCRIPTION_FAILED',
        phase: 'runtime',
        diagnostic: 'ggml_backend: failed safely',
      } as WhisperProcessLogEvent);
      expect(consoleLog).toHaveBeenCalledWith(
        '[whisper-process] failure code=LOCAL_TRANSCRIPTION_FAILED ' +
        'phase=runtime diagnostic="ggml_backend: failed safely"'
      );
    } finally {
      consoleLog.mockRestore();
    }
  });
});
