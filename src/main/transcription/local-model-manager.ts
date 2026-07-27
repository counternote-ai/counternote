import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { LocalModelStatus, TranscriptionErrorCode } from '../../types/transcription';
import { ModelArtifactSpec } from './model-artifact';
import { ModelDownloadTransport } from './model-download';

/**
 * Install-time failure carrying a transcription error code. Task 6 replaces
 * this with a shared TranscriptionError; the shape (an Error with a readonly
 * `code`) is intentionally compatible.
 */
export class ModelInstallError extends Error {
  constructor(
    readonly code: TranscriptionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ModelInstallError';
  }
}

export class LocalModelManager {
  private installation: Promise<string> | null = null;
  private readonly progressListeners = new Map<symbol, (percent: number) => void>();

  constructor(
    private readonly modelRoot: string,
    private readonly artifact: ModelArtifactSpec,
    readonly download: ModelDownloadTransport['download']
  ) {}

  async ensureModel(onProgress: (percent: number) => void): Promise<string> {
    const key = Symbol();
    this.progressListeners.set(key, onProgress);
    try {
      if (this.installation === null) {
        this.installation = this.install().finally(() => {
          this.installation = null;
        });
      }
      return await this.installation;
    } finally {
      this.progressListeners.delete(key);
    }
  }

  async getStatus(): Promise<LocalModelStatus> {
    const finalPath = this.finalPath();
    if (!fs.existsSync(finalPath)) {
      return { state: 'not-downloaded' };
    }
    return (await this.verifyFile(finalPath)) ? { state: 'ready' } : { state: 'invalid' };
  }

  private async install(): Promise<string> {
    const finalPath = this.finalPath();

    if (fs.existsSync(finalPath)) {
      if (await this.verifyFile(finalPath)) {
        return finalPath;
      }
      // Leave the corrupt file in place for explicit user recovery; never
      // silently redownload during the same attempt.
      throw new ModelInstallError(
        'MODEL_CHECKSUM_FAILED',
        `cached model ${this.artifact.fileName} failed integrity verification`
      );
    }

    await fs.promises.mkdir(this.modelRoot, { recursive: true });

    const partPath = `${finalPath}.part`;
    await fs.promises.rm(partPath, { force: true });

    try {
      await this.download(this.artifact.url, partPath, (receivedBytes, totalBytes) => {
        const percent = totalBytes > 0 ? Math.round((receivedBytes / totalBytes) * 100) : 0;
        this.broadcastProgress(percent);
      });
    } catch (error) {
      await fs.promises.rm(partPath, { force: true });
      throw new ModelInstallError(
        'MODEL_DOWNLOAD_FAILED',
        `model download failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (!(await this.verifyFile(partPath))) {
      await fs.promises.rm(partPath, { force: true });
      throw new ModelInstallError(
        'MODEL_CHECKSUM_FAILED',
        `downloaded model ${this.artifact.fileName} failed integrity verification`
      );
    }

    await fs.promises.rename(partPath, finalPath);
    return finalPath;
  }

  private finalPath(): string {
    return path.join(this.modelRoot, this.artifact.fileName);
  }

  private broadcastProgress(percent: number): void {
    for (const listener of this.progressListeners.values()) {
      try {
        listener(percent);
      } catch {
        // A throwing listener must not silence the broadcast for the rest.
      }
    }
  }

  private async verifyFile(filePath: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || stat.size !== this.artifact.byteSize) {
        return false;
      }
      return (await sha256File(filePath)) === this.artifact.sha256;
    } catch {
      return false;
    }
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
