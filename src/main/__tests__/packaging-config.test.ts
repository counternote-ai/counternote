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

  it('consolidates macOS-only packaging configuration', () => {
    const packageJson = JSON.parse(readRepoFile('package.json'));
    const builderYaml = readRepoFile('electron-builder.yml');

    expect(packageJson.build).toBeUndefined();
    expect(packageJson.scripts['build:whisper']).toBe(
      'bash scripts/build-whisper-sidecar.sh'
    );
    expect(packageJson.scripts['verify:whisper']).toBe(
      'bash scripts/verify-whisper-sidecar.sh build/whisper/darwin-arm64/whisper-cli'
    );
    expect(packageJson.devDependencies['@electron-forge/cli']).toBeUndefined();
    expect(builderYaml).toContain('output: release');
    expect(builderYaml).toContain('from: build/whisper/darwin-arm64/whisper-cli');
    expect(builderYaml).toContain('to: whisper/bin/whisper-cli');
    expect(builderYaml).toContain('NSMicrophoneUsageDescription:');
    expect(builderYaml).not.toMatch(/^win:/m);
    expect(builderYaml).not.toMatch(/^linux:/m);
  });

  it('orchestrates packaged verification and smoke without development overrides', () => {
    const packageJson = JSON.parse(readRepoFile('package.json'));
    const packagedSmoke = readRepoFile('e2e/packaged-smoke.spec.ts');

    expect(packageJson.scripts['test:packaged']).toBe(
      'playwright test --config playwright.packaged.config.ts'
    );

    const checkPack = packageJson.scripts['check:pack'];
    expect(checkPack).toContain(
      'release/mac-arm64/Interview Copilot.app/Contents/Resources/whisper/bin/whisper-cli'
    );
    expect(checkPack.indexOf('verify-whisper-sidecar.sh')).toBeLessThan(
      checkPack.indexOf('npm run test:packaged')
    );

    expect(packagedSmoke).toContain('delete env.INTERVIEW_COPILOT_E2E;');
    expect(packagedSmoke).toContain('delete env.INTERVIEW_COPILOT_WHISPER_CLI;');
    expect(packagedSmoke).toContain('delete env.INTERVIEW_COPILOT_MODEL_MANIFEST;');
  });
});
