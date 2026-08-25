import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  resolveAudioCaptureHelper,
  AudioCaptureHelperError,
  type AudioCaptureHelperOptions,
} from '../helper-path';

function makeOptions(
  overrides: Partial<AudioCaptureHelperOptions> = {},
): AudioCaptureHelperOptions {
  return {
    isPackaged: false,
    resourcesPath: '/Applications/CounterNote.app/Contents/Resources',
    projectRoot: '/repo',
    platform: 'darwin',
    arch: 'arm64',
    ...overrides,
  };
}

describe('resolveAudioCaptureHelper', () => {
  it('rejects unsupported architecture', () => {
    expect(() => resolveAudioCaptureHelper(makeOptions({ arch: 'x64' }))).toThrow(
      AudioCaptureHelperError,
    );
    expect(() => resolveAudioCaptureHelper(makeOptions({ arch: 'x64' }))).toThrow(
      /only supported on macOS Apple Silicon/,
    );
  });

  it('rejects unsupported platform', () => {
    expect(() => resolveAudioCaptureHelper(makeOptions({ platform: 'linux' }))).toThrow(
      AudioCaptureHelperError,
    );
  });

  it('resolves from COUNTERNOTE_AUDIO_CAPTURE_HELPER in development', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-path-'));
    const helperPath = path.join(dir, 'counternote-audio-capture');
    await fs.writeFile(helperPath, 'fake binary');
    await fs.chmod(helperPath, 0o755);

    const resolved = resolveAudioCaptureHelper(
      makeOptions({
        env: { COUNTERNOTE_AUDIO_CAPTURE_HELPER: helperPath },
      }),
    );
    expect(resolved).toBe(helperPath);

    await fs.rm(dir, { recursive: true });
  });

  it('rejects the env override in packaged production', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-path-'));
    const helperPath = path.join(dir, 'counternote-audio-capture');
    await fs.writeFile(helperPath, 'fake binary');
    await fs.chmod(helperPath, 0o755);

    expect(() =>
      resolveAudioCaptureHelper(
        makeOptions({
          isPackaged: true,
          env: { COUNTERNOTE_AUDIO_CAPTURE_HELPER: helperPath },
        }),
      ),
    ).toThrow(AudioCaptureHelperError);
    expect(() =>
      resolveAudioCaptureHelper(
        makeOptions({
          isPackaged: true,
          env: { COUNTERNOTE_AUDIO_CAPTURE_HELPER: helperPath },
        }),
      ),
    ).toThrow(/not available in packaged production/);

    await fs.rm(dir, { recursive: true });
  });

  it('rejects the env override when path is not executable', () => {
    expect(() =>
      resolveAudioCaptureHelper(
        makeOptions({
          env: {
            COUNTERNOTE_AUDIO_CAPTURE_HELPER: '/nonexistent/binary',
          },
        }),
      ),
    ).toThrow(AudioCaptureHelperError);
    expect(() =>
      resolveAudioCaptureHelper(
        makeOptions({
          env: {
            COUNTERNOTE_AUDIO_CAPTURE_HELPER: '/nonexistent/binary',
          },
        }),
      ),
    ).toThrow(/not executable/);
  });

  it('resolves from development build output when not packaged', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-path-'));
    const buildDir = path.join(dir, 'build', 'audio-capture', 'darwin-arm64');
    await fs.mkdir(buildDir, { recursive: true });
    const helperPath = path.join(buildDir, 'counternote-audio-capture');
    await fs.writeFile(helperPath, 'fake binary');
    await fs.chmod(helperPath, 0o755);

    const resolved = resolveAudioCaptureHelper(makeOptions({ projectRoot: dir }));
    expect(resolved).toBe(helperPath);

    await fs.rm(dir, { recursive: true });
  });

  it('resolves from packaged resources path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-path-'));
    const resourceDir = path.join(dir, 'audio-capture', 'bin');
    await fs.mkdir(resourceDir, { recursive: true });
    const helperPath = path.join(resourceDir, 'counternote-audio-capture');
    await fs.writeFile(helperPath, 'fake binary');
    await fs.chmod(helperPath, 0o755);

    const resolved = resolveAudioCaptureHelper(
      makeOptions({ isPackaged: true, resourcesPath: dir }),
    );
    expect(resolved).toBe(helperPath);

    await fs.rm(dir, { recursive: true });
  });

  it('throws when helper is missing', () => {
    expect(() => resolveAudioCaptureHelper(makeOptions({ projectRoot: '/nonexistent' }))).toThrow(
      AudioCaptureHelperError,
    );
    expect(() => resolveAudioCaptureHelper(makeOptions({ projectRoot: '/nonexistent' }))).toThrow(
      /missing or not executable/,
    );
  });

  it('throws when helper exists but is not executable', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-path-'));
    const buildDir = path.join(dir, 'build', 'audio-capture', 'darwin-arm64');
    await fs.mkdir(buildDir, { recursive: true });
    const helperPath = path.join(buildDir, 'counternote-audio-capture');
    await fs.writeFile(helperPath, 'fake binary');
    // Not chmod +x

    expect(() => resolveAudioCaptureHelper(makeOptions({ projectRoot: dir }))).toThrow(
      /missing or not executable/,
    );

    await fs.rm(dir, { recursive: true });
  });

  it('throws when helper is not a regular file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'helper-path-'));
    const buildDir = path.join(dir, 'build', 'audio-capture', 'darwin-arm64');
    await fs.mkdir(buildDir, { recursive: true });
    // Create a directory instead of a file
    const helperPath = path.join(buildDir, 'counternote-audio-capture');
    await fs.mkdir(helperPath);

    expect(() => resolveAudioCaptureHelper(makeOptions({ projectRoot: dir }))).toThrow(
      /missing or not executable/,
    );

    await fs.rm(dir, { recursive: true });
  });
});
