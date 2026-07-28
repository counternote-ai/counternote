import { test, expect, _electron as electron, ElectronApplication } from '@playwright/test';
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
    await electronApp?.close();
    fs.rmSync(testHome, { recursive: true, force: true });
  }
});
