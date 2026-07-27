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
      })
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
      })
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
      })
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
      })
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
      })
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
      })
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
      })
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
      })
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
      })
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

  const baseInput = {
    cliPath: '/bin/whisper-cli',
    modelPath: '/models/model.bin',
    channelPath: '/audio/channel.wav',
    outputPrefix: '/out/attempt-1',
    channelDurationMs: 60_000,
  };

  beforeEach(() => {
    jest.useFakeTimers();
    fakeChild = createFakeChild();
    spawn = jest.fn().mockReturnValue(fakeChild);
    readFile = jest.fn();
    runner = new WhisperProcessRunner({
      spawn,
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clearTimeout: (id: unknown) => clearTimeout(id as number),
      readFile,
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
        '-np',
        '-l',
        'auto',
        '-sns',
        '-nth',
        '0.60',
      ],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
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

  it('sends SIGTERM after five silent minutes and SIGKILL five seconds later', async () => {
    const result = runner.run(baseInput);

    await jest.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');

    await jest.advanceTimersByTimeAsync(5_000);
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');

    fakeChild.emit('close', null);
    await expect(result).rejects.toMatchObject({
      code: 'LOCAL_TRANSCRIPTION_TIMEOUT',
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
