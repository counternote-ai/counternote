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
    expect(buildScript).toContain('-DGGML_BLAS=OFF');
    expect(buildScript).toContain('-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0');
    expect(buildScript).toContain('-DWHISPER_BUILD_EXAMPLES=ON');
    expect(buildScript).toContain('--target whisper-cli');
    expect(buildScript).toContain('build/whisper/darwin-arm64/whisper-cli');
  });

  it('verifies the produced sidecar is a standalone Mach-O arm64 binary', () => {
    const verifyScript = readRepoFile('scripts/verify-whisper-sidecar.sh');

    expect(verifyScript).toContain('otool -L');
    expect(verifyScript).toContain('nm -u');
    expect(verifyScript).toContain('cblas_');
    expect(verifyScript).toContain('libwhisper');
    expect(verifyScript).toContain('libggml');
    expect(verifyScript).toContain('expected 13.0');
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
    expect(packageJson.version).toBe('0.1.0-beta.1');
    expect(packageJson.license).toBe('GPL-3.0-only');
    expect(packageJson.scripts['build:whisper']).toBe('bash scripts/build-whisper-sidecar.sh');
    expect(packageJson.scripts['verify:whisper']).toBe(
      'bash scripts/verify-whisper-sidecar.sh build/whisper/darwin-arm64/whisper-cli',
    );
    expect(packageJson.devDependencies['@electron-forge/cli']).toBeUndefined();
    expect(builderYaml).toContain('output: release');
    expect(builderYaml).toContain('artifactName: CounterNote-${version}-${arch}.${ext}');
    expect(builderYaml).toContain("minimumSystemVersion: '13.0'");
    expect(builderYaml).toContain('publish: null');
    expect(builderYaml).toContain('target: dmg');
    expect(builderYaml).toContain('arch: arm64');
    expect(builderYaml).toContain('from: build/whisper/darwin-arm64/whisper-cli');
    expect(builderYaml).toContain('to: whisper/bin/whisper-cli');
    expect(builderYaml).toContain('NSMicrophoneUsageDescription:');
    expect(builderYaml).not.toMatch(/^win:/m);
    expect(builderYaml).not.toMatch(/^linux:/m);
  });

  it('cleans production output and excludes build-only artifacts from app.asar', () => {
    const packageJson = JSON.parse(readRepoFile('package.json'));
    const builderYaml = readRepoFile('electron-builder.yml');

    expect(packageJson.scripts.build).toBe('npm run clean && webpack --mode production');
    expect(builderYaml).toContain('!dist/**/*.d.ts');
    expect(builderYaml).toContain('!dist/**/*.d.ts.map');
    expect(builderYaml).toContain('!dist/**/*.map');
    expect(builderYaml).toContain('!dist/**/__tests__/**');
    expect(builderYaml).toContain('!node_modules/**/*');
  });

  it('orchestrates packaged verification and smoke without development overrides', () => {
    const packageJson = JSON.parse(readRepoFile('package.json'));
    const packagedSmoke = readRepoFile('e2e/packaged-smoke.spec.ts');
    const developmentPlaywrightConfig = readRepoFile('playwright.config.ts');

    expect(packageJson.scripts['test:packaged']).toBe(
      'playwright test --config playwright.packaged.config.ts',
    );
    expect(developmentPlaywrightConfig).toContain("testIgnore: 'packaged-smoke.spec.ts'");

    const checkPack = packageJson.scripts['check:pack'];
    expect(checkPack).toContain(
      'release/mac-arm64/CounterNote.app/Contents/Resources/whisper/bin/whisper-cli',
    );
    expect(checkPack.indexOf('verify-whisper-sidecar.sh')).toBeLessThan(
      checkPack.indexOf('npm run test:packaged'),
    );
    expect(checkPack).toContain('npm run verify:release-artifact');

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

  it('ships project and third-party license notices outside app.asar', () => {
    const builderYaml = readRepoFile('electron-builder.yml');
    const notices = readRepoFile('THIRD_PARTY_NOTICES.md');

    expect(builderYaml).toContain('from: LICENSE');
    expect(builderYaml).toContain('to: LICENSE.txt');
    expect(builderYaml).toContain('from: node_modules/electron/dist/LICENSE');
    expect(builderYaml).toContain('to: LICENSE.electron.txt');
    expect(builderYaml).toContain('from: node_modules/electron/dist/LICENSES.chromium.html');
    expect(builderYaml).toContain('from: THIRD_PARTY_NOTICES.md');
    expect(builderYaml).toContain('to: THIRD_PARTY_NOTICES.md');
    expect(notices).toContain('Electron 43.1.0');
    expect(notices).toContain('whisper.cpp');
    expect(notices).toContain('Whisper large-v3-turbo-q5_0 model');
  });

  it('adds build:capture and verify:capture scripts', () => {
    const packageJson = JSON.parse(readRepoFile('package.json'));

    expect(packageJson.scripts['build:capture']).toBe(
      'bash scripts/build-audio-capture-sidecar.sh',
    );
    expect(packageJson.scripts['verify:capture']).toBe(
      'bash scripts/verify-audio-capture-sidecar.sh build/audio-capture/darwin-arm64/counternote-audio-capture',
    );
    expect(readRepoFile('scripts/verify-audio-capture-sidecar.sh')).toContain('expected 13.0');
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

  it('builds the unsigned Apple Silicon beta as a DMG', () => {
    const packageJson = JSON.parse(readRepoFile('package.json'));

    const packScript = packageJson.scripts['pack'];
    expect(packScript).toContain('CSC_IDENTITY_AUTO_DISCOVERY=false');
    expect(packScript).toContain('electron-builder --mac dmg --arm64');
    expect(packageJson.scripts['pack:release']).toBeUndefined();
  });

  it('verifies release identity, platform, package contents, and license files', () => {
    const packageJson = JSON.parse(readRepoFile('package.json'));
    const verifyScript = readRepoFile('scripts/verify-release-artifact.sh');

    expect(packageJson.scripts['verify:release-artifact']).toContain(
      'CounterNote-0.1.0-beta.1-arm64.dmg',
    );
    expect(verifyScript).toContain('CFBundleShortVersionString');
    expect(verifyScript).toContain('LSMinimumSystemVersion');
    expect(verifyScript).toContain('Mach-O 64-bit executable arm64');
    expect(verifyScript).toContain('THIRD_PARTY_NOTICES.md');
    expect(verifyScript).toContain('LICENSES.chromium.html');
    expect(verifyScript).toContain('app-update.yml');
    expect(verifyScript).toContain('Groq integration');
  });

  it('does not reference FFmpeg in production dependencies or Jest configuration', () => {
    const packageJson = JSON.parse(readRepoFile('package.json'));
    const jestConfig = readRepoFile('jest.config.js');

    expect(packageJson.dependencies['ffmpeg-static']).toBeUndefined();
    expect(jestConfig).not.toContain('ffmpeg-static');
  });
});
