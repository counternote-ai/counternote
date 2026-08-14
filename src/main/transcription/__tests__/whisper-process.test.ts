import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveWhisperCliPath } from '../sidecar-path';
import { WhisperProcessRunner } from '../whisper-process';

describe('resolveWhisperCliPath', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const touchExecutable = (filePath: string, mode = 0o755): void => {
    fs.writeFileSync(filePath, '');
    fs.chmodSync(filePath, mode);
  };

  it('uses process.resourcesPath in a packaged app', () => {
    const resourcesPath = path.join(tmpDir, 'App', 'Contents', 'Resources');
    const expected = path.join(resourcesPath, 'whisper', 'bin', 'whisper-cli');
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    touchExecutable(expected);

    expect(
      resolveWhisperCliPath({
        isPackaged: true,
        resourcesPath,
        projectRoot: '/repo',
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe(expected);
  });

  it('uses the Phase 3 artifact during development', () => {
    const projectRoot = path.join(tmpDir, 'repo');
    const expected = path.join(projectRoot, 'build', 'whisper', 'darwin-arm64', 'whisper-cli');
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    touchExecutable(expected);

    expect(
      resolveWhisperCliPath({
        isPackaged: false,
        resourcesPath: '/unused',
        projectRoot,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toBe(expected);
  });

  it('rejects non-darwin platforms with LOCAL_UNAVAILABLE', () => {
    expect(() =>
      resolveWhisperCliPath({
        isPackaged: false,
        resourcesPath: '/unused',
        projectRoot: '/repo',
        platform: 'linux',
        arch: 'arm64',
      }),
    ).toThrow(expect.objectContaining({ code: 'LOCAL_UNAVAILABLE' }));
  });

  it('rejects non-arm64 darwin with LOCAL_UNAVAILABLE', () => {
    expect(() =>
      resolveWhisperCliPath({
        isPackaged: false,
        resourcesPath: '/unused',
        projectRoot: '/repo',
        platform: 'darwin',
        arch: 'x64',
      }),
    ).toThrow(expect.objectContaining({ code: 'LOCAL_UNAVAILABLE' }));
  });

  it('rejects a missing sidecar with LOCAL_UNAVAILABLE', () => {
    expect(() =>
      resolveWhisperCliPath({
        isPackaged: false,
        resourcesPath: '/unused',
        projectRoot: '/repo',
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toThrow(expect.objectContaining({ code: 'LOCAL_UNAVAILABLE' }));
  });

  it('rejects a non-executable sidecar with LOCAL_UNAVAILABLE', () => {
    const projectRoot = path.join(tmpDir, 'repo');
    const expected = path.join(projectRoot, 'build', 'whisper', 'darwin-arm64', 'whisper-cli');
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    touchExecutable(expected, 0o644);

    expect(() =>
      resolveWhisperCliPath({
        isPackaged: false,
        resourcesPath: '/unused',
        projectRoot,
        platform: 'darwin',
        arch: 'arm64',
      }),
    ).toThrow(expect.objectContaining({ code: 'LOCAL_UNAVAILABLE' }));
  });

  it('honors E2E CLI override when not packaged and E2E is enabled', () => {
    const override = path.join(tmpDir, 'override-cli');
    touchExecutable(override);

    expect(
      resolveWhisperCliPath({
        isPackaged: false,
        resourcesPath: '/unused',
        projectRoot: '/repo',
        platform: 'darwin',
        arch: 'arm64',
        env: {
          INTERVIEW_COPILOT_E2E: '1',
          INTERVIEW_COPILOT_WHISPER_CLI: override,
        },
      }),
    ).toBe(override);
  });

  it('ignores E2E CLI override when packaged', () => {
    const override = path.join(tmpDir, 'override-cli');
    touchExecutable(override);
    const resourcesPath = path.join(tmpDir, 'App', 'Contents', 'Resources');
    const expected = path.join(resourcesPath, 'whisper', 'bin', 'whisper-cli');
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    touchExecutable(expected);

    expect(
      resolveWhisperCliPath({
        isPackaged: true,
        resourcesPath,
        projectRoot: '/repo',
        platform: 'darwin',
        arch: 'arm64',
        env: {
          INTERVIEW_COPILOT_E2E: '1',
          INTERVIEW_COPILOT_WHISPER_CLI: override,
        },
      }),
    ).toBe(expected);
  });

  it('ignores E2E CLI override when E2E env is not set to 1', () => {
    const override = path.join(tmpDir, 'override-cli');
    touchExecutable(override);
    const projectRoot = path.join(tmpDir, 'repo');
    const expected = path.join(projectRoot, 'build', 'whisper', 'darwin-arm64', 'whisper-cli');
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    touchExecutable(expected);

    expect(
      resolveWhisperCliPath({
        isPackaged: false,
        resourcesPath: '/unused',
        projectRoot,
        platform: 'darwin',
        arch: 'arm64',
        env: {
          INTERVIEW_COPILOT_E2E: '0',
          INTERVIEW_COPILOT_WHISPER_CLI: override,
        },
      }),
    ).toBe(expected);
  });
});

interface FakeChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  kill: jest.Mock;
}

function createFakeChild(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 12345;
  child.kill = jest.fn().mockReturnValue(true);
  return child;
}

describe('WhisperProcessRunner', () => {
  let runner: WhisperProcessRunner;
  let fakeChild: FakeChildProcess;
  let spawn: jest.Mock;
  let readFile: jest.Mock;
  let logger: { log: jest.Mock };
  let nowMs: number;

  const baseInput = {
    cliPath: '/bin/whisper-cli',
    modelPath: '/models/model.bin',
    channelPath: '/audio/channel.wav',
    outputPrefix: '/out/attempt-1',
    channelDurationMs: 60_000,
  };

  beforeEach(() => {
    jest.useFakeTimers();
    nowMs = 1_000;
    fakeChild = createFakeChild();
    spawn = jest.fn().mockReturnValue(fakeChild);
    readFile = jest.fn();
    logger = { log: jest.fn() };
    runner = new WhisperProcessRunner({
      spawn,
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clearTimeout: (id: unknown) => clearTimeout(id as number),
      readFile,
      logger,
      now: () => nowMs,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects with a safe error when spawn throws synchronously', async () => {
    spawn.mockImplementation(() => {
      throw new Error('ENOENT: /bin/whisper-cli');
    });

    await expect(runner.run(baseInput)).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_FAILED',
      message: 'whisper-cli failed to start',
    });
  });

  it('rejects with a typed failure when a child output stream errors', async () => {
    const result = runner.run(baseInput);

    fakeChild.stderr.emit('error', new Error('EIO reading whisper stderr'));

    await expect(result).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_FAILED',
      message: 'whisper-cli output stream failed',
    });
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('spawns whisper-cli with the expected arguments', () => {
    runner.run(baseInput).catch(() => {});

    expect(spawn).toHaveBeenCalledWith(
      baseInput.cliPath,
      [
        '-m',
        baseInput.modelPath,
        '-f',
        baseInput.channelPath,
        '-of',
        baseInput.outputPrefix,
        '-ojf',
        '-pp',
        '-l',
        'auto',
        '-sns',
        '-nth',
        '0.60',
        '-ng',
      ],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('resolves with parsed JSON after a successful exit', async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({ segments: [] }));
    const result = runner.run(baseInput);
    fakeChild.stdout.emit('data', Buffer.from('progress'));
    fakeChild.emit('close', 0);

    await expect(result).resolves.toEqual({ segments: [] });
    expect(readFile).toHaveBeenCalledWith(`${baseInput.outputPrefix}.json`, 'utf-8');
  });

  it('rejects with LOCAL_TRANSCRIPTION_FAILED on a non-zero exit', async () => {
    const result = runner.run(baseInput);
    fakeChild.stdout.emit('data', Buffer.from('progress'));
    fakeChild.emit('close', 1);

    await expect(result).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_FAILED',
    });
  });

  it('rejects with a safe message on a non-zero exit', async () => {
    const result = runner.run(baseInput);
    fakeChild.emit('close', 1);

    await expect(result).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_FAILED',
      message: 'whisper-cli exited with code 1',
    });
  });

  it('rejects with a safe message on a signal exit', async () => {
    const result = runner.run(baseInput);
    fakeChild.emit('close', null, 'SIGSEGV');

    await expect(result).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_FAILED',
      message: 'whisper-cli exited with signal SIGSEGV',
    });
  });

  it('logs CPU start and successful JSON exit without stdout content', async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({ transcription: [] }));
    const result = runner.run(baseInput);
    fakeChild.stdout.emit('data', Buffer.from('private interview answer'));
    nowMs = 2_500;
    fakeChild.emit('close', 0, null);
    await result;

    expect(logger.log).toHaveBeenCalledWith({
      type: 'start',
      mode: 'cpu',
      pid: 12345,
      channelDurationMs: baseInput.channelDurationMs,
    });
    expect(logger.log).toHaveBeenCalledWith({
      type: 'exit',
      code: 0,
      signal: null,
      elapsedMs: 1_500,
      jsonRead: true,
    });
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('private interview answer');
  });

  it('logs a sanitized stderr tail for a failed process', async () => {
    const result = runner.run(baseInput);
    fakeChild.stderr.emit(
      'data',
      Buffer.from(
        'ggml_backend: failed to load /Users/example/private/model.bin\r' +
          '[00:00:00.000 --> 00:00:02.000] private answer\n',
      ),
    );
    nowMs = 2_000;
    fakeChild.emit('close', null, 'SIGSEGV');

    await expect(result).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_FAILED',
    });
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'failure',
        phase: 'runtime',
        diagnostic: expect.stringContaining('<redacted-path>'),
      }),
    );
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('private answer');
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('/Users/example');
  });

  it('logs output-read when JSON is unparseable', async () => {
    readFile.mockResolvedValueOnce('{not-json');
    const result = runner.run(baseInput);
    fakeChild.emit('close', 0, null);

    await expect(result).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_FAILED',
    });
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'failure',
        phase: 'output-read',
      }),
    );
  });

  it('sends SIGTERM after five silent minutes and SIGKILL five seconds later', async () => {
    const result = runner.run(baseInput);

    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
    expect(logger.log).toHaveBeenCalledWith({
      type: 'terminate',
      reason: 'inactivity',
      elapsedMs: expect.any(Number),
    });

    await jest.advanceTimersByTimeAsync(5_000);
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');

    fakeChild.emit('close', null);
    await expect(result).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_TIMEOUT',
    });
    expect(logger.log).toHaveBeenCalledWith({
      type: 'exit',
      code: null,
      signal: null,
      elapsedMs: expect.any(Number),
      jsonRead: false,
    });
    expect(logger.log).toHaveBeenCalledWith({
      type: 'failure',
      code: 'LOCAL_TRANSCRIPTION_TIMEOUT',
      phase: 'runtime',
    });
  });

  it('resets the inactivity timer on stdout/stderr output', async () => {
    const result = runner.run(baseInput);

    await jest.advanceTimersByTimeAsync(4 * 60 * 1000);
    fakeChild.stdout.emit('data', Buffer.from('progress'));

    await jest.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(fakeChild.kill).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(60 * 1000 + 1);
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');

    fakeChild.emit('close', null);
    await expect(result).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_TIMEOUT',
    });
  });

  it('enforces a hard deadline of max(15 minutes, 2x duration) for a noisy child', async () => {
    const result = runner.run({ ...baseInput, channelDurationMs: 20 * 60 * 1000 });

    const interval = setInterval(() => {
      fakeChild.stdout.emit('data', Buffer.from('progress'));
    }, 60 * 1000);

    try {
      await jest.advanceTimersByTimeAsync(40 * 60 * 1000);
      expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(logger.log).toHaveBeenCalledWith({
        type: 'terminate',
        reason: 'hard-deadline',
        elapsedMs: expect.any(Number),
      });
    } finally {
      clearInterval(interval);
    }

    fakeChild.emit('close', null);
    await expect(result).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_TIMEOUT',
    });
  });

  it('clears timers before the async JSON read so a slow read does not trigger timeout', async () => {
    let resolveReadFile: (value: string) => void = () => {};
    const readFilePromise = new Promise<string>((resolve) => {
      resolveReadFile = resolve;
    });
    readFile.mockReturnValueOnce(readFilePromise);

    const result = runner.run(baseInput);
    fakeChild.emit('close', 0);

    await jest.advanceTimersByTimeAsync(20 * 60 * 1000);
    expect(fakeChild.kill).not.toHaveBeenCalled();

    resolveReadFile(JSON.stringify({ segments: [] }));
    await expect(result).resolves.toEqual({ segments: [] });
  });

  it('clears timers and listeners on all exit paths', async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({ segments: [] }));
    const result = runner.run(baseInput);
    fakeChild.emit('close', 0);
    await result;

    expect(fakeChild.stdout.listenerCount('data')).toBe(0);
    expect(fakeChild.stderr.listenerCount('data')).toBe(0);
    expect(fakeChild.listenerCount('close')).toBe(0);
    expect(fakeChild.listenerCount('error')).toBe(0);
  });
});
