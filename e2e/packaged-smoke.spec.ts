import { test, expect, _electron as electron, ElectronApplication } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

test('launches a 400x600 window titled Interview Copilot and shows Local Whisper settings', async () => {
  const testHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'interview-copilot-packaged-e2e-')
  );
  const appPath = path.resolve(
    'release/mac-arm64/Interview Copilot.app/Contents/MacOS/Interview Copilot'
  );

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: testHome };
  delete env.INTERVIEW_COPILOT_E2E;
  delete env.INTERVIEW_COPILOT_WHISPER_CLI;
  delete env.INTERVIEW_COPILOT_MODEL_MANIFEST;

  let electronApp: ElectronApplication | undefined;

  try {
    electronApp = await electron.launch({
      executablePath: appPath,
      args: [`--user-data-dir=${testHome}`],
      env,
    });

    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');

    expect(await window.title()).toBe('Interview Copilot');

    const windowSize = await electronApp.evaluate(({ BrowserWindow }) => {
      const [win] = BrowserWindow.getAllWindows();
      return win.getSize();
    });
    expect(windowSize).toEqual([400, 600]);

    await window.getByRole('button', { name: 'Open settings' }).click();
    await expect(window.getByRole('heading', { name: 'Settings' })).toBeVisible();

    await expect(
      window.getByRole('combobox', { name: 'Transcription provider' })
    ).toContainText('Local Whisper');

    await expect(window.getByText('Not downloaded', { exact: true })).toBeVisible();

    await expect(
      window.getByText('Transcription runs on this Mac. Audio is not uploaded.')
    ).toBeVisible();

    await expect(window.getByText('Unavailable', { exact: true })).toHaveCount(0);
    await expect(
      window.getByText(
        'Local Whisper is unavailable because its sidecar is not installed.'
      )
    ).toHaveCount(0);
  } finally {
    try {
      await electronApp?.close();
    } catch {
      // best effort cleanup
    }
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});

test('packaged audio capture helper exists, is executable, and exchanges a valid protocol frame', async () => {
  const helperPath = path.resolve(
    'release/mac-arm64/Interview Copilot.app/Contents/Resources/audio-capture/bin/interview-audio-capture'
  );

  // Assert the helper exists at the resolved packaged resource path
  expect(fs.existsSync(helperPath)).toBe(true);

  // Assert it is a file and is executable
  const stat = fs.statSync(helperPath);
  expect(stat.isFile()).toBe(true);
  expect(() => fs.accessSync(helperPath, fs.constants.X_OK)).not.toThrow();

  // Verify no development override is set
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.INTERVIEW_COPILOT_AUDIO_CAPTURE_HELPER;
  delete env.INTERVIEW_COPILOT_E2E;
  delete env.INTERVIEW_COPILOT_WHISPER_CLI;
  delete env.INTERVIEW_COPILOT_MODEL_MANIFEST;

  // Launch the helper and exchange a valid protocol frame within bounded timeout.
  // Send an invalid control command to trigger an error frame (valid protocol response).
  const framePromise = new Promise<boolean>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Helper did not produce a protocol frame within 10 seconds'));
    }, 10_000);

    const child = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: os.tmpdir() },
    });

    let received = false;
    child.stdout.on('data', (chunk: Buffer) => {
      // Check for ICAP magic bytes (protocol frame header)
      if (!received && chunk.length >= 16 &&
          chunk[0] === 0x49 && chunk[1] === 0x43 &&
          chunk[2] === 0x41 && chunk[3] === 0x50 &&
          chunk[4] === 0x01) { // version 1
        received = true;
        clearTimeout(timeout);
        child.kill();
        resolve(true);
      }
    });

    child.stderr.on('data', () => {}); // drain stderr

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', () => {
      clearTimeout(timeout);
      if (!received) {
        reject(new Error('Helper exited without producing a protocol frame'));
      }
    });

    // Send an invalid control command to trigger an error frame
    // This tests that the helper can produce valid protocol output
    child.stdin.write('{"version":1,"type":"invalid"}\n');
  });

  const receivedFrame = await framePromise;
  expect(receivedFrame).toBe(true);
});
