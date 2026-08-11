import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ModelArtifactSpec } from '../model-artifact';
import { ModelDownloadTransport } from '../model-download';
import { LocalModelManager } from '../local-model-manager';

describe('LocalModelManager', () => {
  const fileName = 'ggml-test-model.bin';

  let modelRoot: string;
  let finalPath: string;

  beforeEach(() => {
    modelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'model-manager-test-'));
    finalPath = path.join(modelRoot, fileName);
  });

  afterEach(() => {
    fs.rmSync(modelRoot, { recursive: true, force: true });
  });

  const artifactFor = (bytes: Buffer): ModelArtifactSpec => ({
    url: new URL('https://models.example.com/ggml-test-model.bin'),
    fileName,
    byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });

  const writeModel = (bytes: Buffer): void => {
    fs.writeFileSync(finalPath, bytes);
  };

  const createManager = (options: {
    artifact: ModelArtifactSpec;
    download: ModelDownloadTransport['download'];
  }): LocalModelManager =>
    new LocalModelManager(modelRoot, options.artifact, options.download);

  it('returns a verified cached model without downloading', async () => {
    const bytes = Buffer.from('verified-model');
    writeModel(bytes);
    const manager = createManager({
      artifact: artifactFor(bytes),
      download: jest.fn(),
    });

    await expect(manager.ensureModel(jest.fn())).resolves.toBe(finalPath);
    expect(manager.download).not.toHaveBeenCalled();
  });

  it('reports bytes, verifies SHA-256, and atomically installs a download', async () => {
    const bytes = Buffer.from('downloaded-model');
    const progress: number[] = [];
    const manager = createManager({
      artifact: artifactFor(bytes),
      download: async (_url, destination, onProgress) => {
        fs.writeFileSync(destination, bytes);
        onProgress(bytes.length, bytes.length);
      },
    });

    await manager.ensureModel((percent) => progress.push(percent));

    expect(progress).toEqual([100]);
    expect(fs.readFileSync(finalPath)).toEqual(bytes);
    expect(fs.existsSync(`${finalPath}.part`)).toBe(false);
  });

  it('removes the part file when the checksum is wrong', async () => {
    const manager = createManager({
      artifact: artifactFor(Buffer.from('expected')),
      download: async (_url, destination) => {
        fs.writeFileSync(destination, Buffer.from('corrupt'));
      },
    });

    await expect(manager.ensureModel(jest.fn())).rejects.toMatchObject({
      code: 'MODEL_CHECKSUM_FAILED',
    });
    expect(fs.existsSync(`${finalPath}.part`)).toBe(false);
    expect(fs.existsSync(finalPath)).toBe(false);
  });

  it('removes the part file when the transport is interrupted', async () => {
    const manager = createManager({
      artifact: artifactFor(Buffer.from('expected-model')),
      download: async (_url, destination) => {
        fs.writeFileSync(destination, Buffer.from('partial-bytes'));
        throw new Error('connection reset');
      },
    });

    await expect(manager.ensureModel(jest.fn())).rejects.toMatchObject({
      code: 'MODEL_DOWNLOAD_FAILED',
    });
    expect(fs.existsSync(`${finalPath}.part`)).toBe(false);
    expect(fs.existsSync(finalPath)).toBe(false);
  });

  it('rejects an invalid cached model without redownloading in the same attempt', async () => {
    writeModel(Buffer.from('tampered-model'));
    const download = jest.fn();
    const manager = createManager({
      artifact: artifactFor(Buffer.from('expected-model')),
      download,
    });

    await expect(manager.ensureModel(jest.fn())).rejects.toMatchObject({
      code: 'MODEL_CHECKSUM_FAILED',
    });
    expect(download).not.toHaveBeenCalled();
    // The corrupt file is left in place for explicit user recovery.
    expect(fs.readFileSync(finalPath)).toEqual(Buffer.from('tampered-model'));
  });

  it('replaces an invalid cached model when the user explicitly retries', async () => {
    const expectedBytes = Buffer.from('verified-retry-model');
    writeModel(Buffer.from('tampered-model'));
    const download = jest.fn(async (_url: URL, destination: string) => {
      fs.writeFileSync(destination, expectedBytes);
    });
    const manager = createManager({
      artifact: artifactFor(expectedBytes),
      download,
    });

    await expect(manager.ensureModel(jest.fn())).rejects.toMatchObject({
      code: 'MODEL_CHECKSUM_FAILED',
    });

    const retryResult = await manager.ensureModel(jest.fn(), { recoverInvalidModel: true }).then(
      (modelPath) => ({ modelPath }),
      (error: unknown) => ({ error })
    );

    expect(download).toHaveBeenCalledTimes(1);
    expect(retryResult).toEqual({ modelPath: finalPath });
    expect(fs.readFileSync(finalPath)).toEqual(expectedBytes);
  });

  it('returns a typed failure without filesystem details when invalid-model cleanup fails', async () => {
    writeModel(Buffer.from('tampered-model'));
    const rm = jest.spyOn(fs.promises, 'rm').mockImplementation(async (filePath) => {
      if (filePath === finalPath) {
        throw new Error(`EACCES: permission denied, unlink '${finalPath}'`);
      }
    });
    const download = jest.fn();
    const manager = createManager({
      artifact: artifactFor(Buffer.from('expected-model')),
      download,
    });

    try {
      await expect(manager.ensureModel(jest.fn(), { recoverInvalidModel: true })).rejects.toMatchObject({
        code: 'MODEL_DOWNLOAD_FAILED',
        message: 'could not remove invalid cached model for recovery',
      });
      expect(download).not.toHaveBeenCalled();
      expect(fs.readFileSync(finalPath)).toEqual(Buffer.from('tampered-model'));
    } finally {
      rm.mockRestore();
    }
  });

  it('coalesces concurrent model installation requests', async () => {
    const bytes = Buffer.from('downloaded-model');
    const download = jest.fn(
      async (
        _url: URL,
        destination: string,
        onProgress: (receivedBytes: number, totalBytes: number) => void
      ) => {
        fs.writeFileSync(destination, bytes);
        onProgress(bytes.length, bytes.length);
      }
    );
    const manager = createManager({
      artifact: artifactFor(bytes),
      download,
    });

    const firstProgress: number[] = [];
    const secondProgress: number[] = [];
    const first = manager.ensureModel((percent) => firstProgress.push(percent));
    const second = manager.ensureModel((percent) => secondProgress.push(percent));

    await expect(Promise.all([first, second])).resolves.toEqual([finalPath, finalPath]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(firstProgress).toEqual([100]);
    expect(secondProgress).toEqual([100]);
  });

  it('reports cache status without initiating a download', async () => {
    const bytes = Buffer.from('status-model');
    const download = jest.fn();
    const manager = createManager({
      artifact: artifactFor(bytes),
      download,
    });

    await expect(manager.getStatus()).resolves.toEqual({ state: 'not-downloaded' });

    writeModel(bytes);
    await expect(manager.getStatus()).resolves.toEqual({ state: 'ready' });

    writeModel(Buffer.from('tampered'));
    await expect(manager.getStatus()).resolves.toEqual({ state: 'invalid' });

    expect(download).not.toHaveBeenCalled();
  });

  it('broadcasts progress to every concurrent caller even when they share the same callback', async () => {
    const bytes = Buffer.from('downloaded-model');
    const progress: number[] = [];
    const sharedCallback = (percent: number): void => {
      progress.push(percent);
    };

    const manager = createManager({
      artifact: artifactFor(bytes),
      download: async (_url, destination, onProgress) => {
        fs.writeFileSync(destination, bytes);
        onProgress(bytes.length, bytes.length);
      },
    });

    const first = manager.ensureModel(sharedCallback);
    const second = manager.ensureModel(sharedCallback);

    await expect(Promise.all([first, second])).resolves.toEqual([finalPath, finalPath]);
    expect(progress.filter((p) => p === 100).length).toBe(2);
  });

  it('does not let a throwing listener silence the remaining listeners', async () => {
    const bytes = Buffer.from('downloaded-model');
    const safeProgress: number[] = [];
    const throwingCallback = (percent: number): void => {
      if (percent === 50) throw new Error('listener boom');
    };
    const safeCallback = (percent: number): void => {
      safeProgress.push(percent);
    };

    const manager = createManager({
      artifact: artifactFor(bytes),
      download: async (_url, destination, onProgress) => {
        fs.writeFileSync(destination, bytes);
        onProgress(bytes.length / 2, bytes.length);
        onProgress(bytes.length, bytes.length);
      },
    });

    const first = manager.ensureModel(throwingCallback);
    const second = manager.ensureModel(safeCallback);

    await expect(Promise.all([first, second])).resolves.toEqual([finalPath, finalPath]);
    expect(safeProgress).toContain(100);
  });
});
