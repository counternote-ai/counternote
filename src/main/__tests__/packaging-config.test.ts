import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const readRepoFile = (relativePath: string): string => {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
};

describe('packaging configuration', () => {
  it('pins a static Metal whisper.cpp build for darwin-arm64', () => {
    const buildScript = readRepoFile('scripts/build-whisper-sidecar.sh');

    expect(buildScript).toContain("WHISPER_COMMIT='f049fff95a089aa9969deb009cdd4892b3e74916'");
    expect(buildScript).toContain(
      "WHISPER_ARCHIVE_SHA256='279af4ce60dbf397362868f3bacc75b56a4332ac2541cae155070093f6aaf0e3'",
    );
    expect(buildScript).toContain('shasum -a 256');
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
    expect(packageJson.directories).toBeUndefined();
    expect(packageJson.dependencies.electron).toBeUndefined();
    expect(packageJson.devDependencies.electron).toBe('43.1.0');
    expect(packageJson.scripts.dist).toBeUndefined();
    expect(packageJson.scripts['build:whisper']).toBe('bash scripts/build-whisper-sidecar.sh');
    expect(packageJson.scripts['verify:whisper']).toBe(
      'bash scripts/verify-whisper-sidecar.sh build/whisper/darwin-arm64/whisper-cli',
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
      'playwright test --config playwright.packaged.config.ts',
    );

    const checkPack = packageJson.scripts['check:pack'];
    expect(checkPack).toContain(
      'release/mac-arm64/CounterNote.app/Contents/Resources/whisper/bin/whisper-cli',
    );
    expect(checkPack.indexOf('verify-whisper-sidecar.sh')).toBeLessThan(
      checkPack.indexOf('npm run test:packaged'),
    );

    expect(packagedSmoke).toContain('delete env.COUNTERNOTE_E2E;');
    expect(packagedSmoke).toContain('delete env.COUNTERNOTE_WHISPER_CLI;');
    expect(packagedSmoke).toContain('delete env.COUNTERNOTE_MODEL_MANIFEST;');
  });

  it('configures hardened runtime and entitlements for audio capture helper', () => {
    const builderYaml = readRepoFile('electron-builder.yml');
    const entitlementsMac = readRepoFile('build/entitlements.mac.plist');
    const entitlementsInherit = readRepoFile('build/entitlements.inherit.plist');

    expect(builderYaml).toContain('hardenedRuntime: true');
    expect(builderYaml).toContain('entitlements: build/entitlements.mac.plist');
    expect(builderYaml).toContain('entitlementsInherit: build/entitlements.inherit.plist');

    expect(entitlementsMac).toContain('com.apple.security.cs.allow-jit');
    expect(entitlementsMac).toContain('com.apple.security.device.audio-input');
    expect(entitlementsMac).toContain('com.apple.security.device.screen-capture');

    expect(entitlementsInherit).toContain('com.apple.security.cs.allow-jit');
    expect(entitlementsInherit).toContain('com.apple.security.cs.allow-unsigned-executable-memory');
    expect(entitlementsInherit).toContain('com.apple.security.device.audio-input');
  });

  it('configures nested helper signing under mac.binaries', () => {
    const builderYaml = readRepoFile('electron-builder.yml');

    expect(builderYaml).toContain('binaries:');
    expect(builderYaml).toContain('audio-capture/bin/counternote-audio-capture');
  });

  it('includes both usage descriptions naming CounterNote', () => {
    const builderYaml = readRepoFile('electron-builder.yml');

    expect(builderYaml).toContain('NSMicrophoneUsageDescription:');
    expect(builderYaml).toContain('NSScreenCaptureUsageDescription:');

    // Usage description values should name the app, not the helper executable
    const micMatch = builderYaml.match(/NSMicrophoneUsageDescription:\s*(.+)/);
    expect(micMatch).not.toBeNull();
    expect(micMatch![1]).toContain('CounterNote');
    expect(micMatch![1]).not.toContain('counternote-audio-capture');

    // screen capture line may be in extendInfo, check the full value
    const screenLine = builderYaml
      .split('\n')
      .find((l) => l.includes('NSScreenCaptureUsageDescription'));
    if (screenLine) {
      expect(screenLine).toContain('CounterNote');
      expect(screenLine).not.toContain('counternote-audio-capture');
    }
  });

  it('configures both sidecars as extraResources', () => {
    const builderYaml = readRepoFile('electron-builder.yml');

    expect(builderYaml).toContain('from: build/whisper/darwin-arm64/whisper-cli');
    expect(builderYaml).toContain('to: whisper/bin/whisper-cli');
    expect(builderYaml).toContain(
      'from: build/audio-capture/darwin-arm64/counternote-audio-capture',
    );
    expect(builderYaml).toContain('to: audio-capture/bin/counternote-audio-capture');
  });

  it('adds build:capture and verify:capture scripts', () => {
    const packageJson = JSON.parse(readRepoFile('package.json'));

    expect(packageJson.scripts['build:capture']).toBe(
      'bash scripts/build-audio-capture-sidecar.sh',
    );
    expect(packageJson.scripts['verify:capture']).toBe(
      'bash scripts/verify-audio-capture-sidecar.sh build/audio-capture/darwin-arm64/counternote-audio-capture',
    );
  });

  it('adds verify:capture:release script that invokes signing verifier', () => {
    const packageJson = JSON.parse(readRepoFile('package.json'));

    expect(packageJson.scripts['verify:capture:release']).toContain(
      'verify-audio-capture-signing.sh',
    );
    expect(packageJson.scripts['verify:capture:release']).toContain('signed-release');
  });

  it('does not hard-code identity: null in release configuration', () => {
    const builderYaml = readRepoFile('electron-builder.yml');

    // identity: null means unsigned; release should not have this
    expect(builderYaml).not.toMatch(/identity:\s*null/);
  });

  it('sets CSC_IDENTITY_AUTO_DISCOVERY=false only in the local pack script', () => {
    const packageJson = JSON.parse(readRepoFile('package.json'));

    const packScript = packageJson.scripts['pack'];
    expect(packScript).toContain('CSC_IDENTITY_AUTO_DISCOVERY=false');

    const packReleaseScript = packageJson.scripts['pack:release'];
    expect(packReleaseScript).not.toContain('CSC_IDENTITY_AUTO_DISCOVERY=false');
  });
});
