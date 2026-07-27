import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const readRepoFile = (relativePath: string): string => {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
};

describe('packaging configuration', () => {
  it('pins a static Metal whisper.cpp build for darwin-arm64', () => {
    const buildScript = readRepoFile('scripts/build-whisper-sidecar.sh');

    expect(buildScript).toContain(
      "WHISPER_COMMIT='f049fff95a089aa9969deb009cdd4892b3e74916'"
    );
    expect(buildScript).toContain('-DBUILD_SHARED_LIBS=OFF');
    expect(buildScript).toContain('-DGGML_METAL=ON');
    expect(buildScript).toContain('-DGGML_METAL_EMBED_LIBRARY=ON');
    expect(buildScript).toContain('-DWHISPER_BUILD_EXAMPLES=ON');
    expect(buildScript).toContain('--target whisper-cli');
    expect(buildScript).toContain('build/whisper/darwin-arm64/whisper-cli');
  });

  it('verifies the produced sidecar is a standalone Mach-O arm64 binary', () => {
    const verifyScript = readRepoFile('scripts/verify-whisper-sidecar.sh');

    expect(verifyScript).toContain('otool -L');
    expect(verifyScript).toContain('libwhisper');
    expect(verifyScript).toContain('libggml');
  });

  it('ignores the build output and release directories', () => {
    const gitignore = readRepoFile('.gitignore');
    const lines = gitignore.split('\n');

    expect(lines).toContain('/build/whisper/');
    expect(lines).toContain('/release/');
    expect(lines).not.toContain('/build/');
  });
});
