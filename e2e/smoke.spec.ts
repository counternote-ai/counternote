import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let electronApp: ElectronApplication | undefined;
let window: Page;
let testHome: string;

test.beforeAll(async () => {
  // Isolate the app from the developer's real home directory and user data so
  // personal recordings, config, and credentials are never loaded or captured.
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-copilot-e2e-'));
  electronApp = await electron.launch({
    args: ['.', `--user-data-dir=${testHome}`],
    env: { ...process.env, HOME: testHome },
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  try {
    await electronApp?.close();
  } finally {
    if (testHome) {
      fs.rmSync(testHome, { recursive: true, force: true });
    }
  }
});

test('launches a 400x600 window titled Interview Copilot', async () => {
  expect(await window.title()).toBe('Interview Copilot');

  const windowSize = await electronApp!.evaluate(({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows();
    return win.getSize();
  });
  expect(windowSize).toEqual([400, 600]);
});

test('recordings home renders primary controls', async () => {
  await expect(window.getByRole('button', { name: 'Record', exact: true })).toBeVisible();
  await expect(window.getByRole('button', { name: 'Open settings' })).toBeVisible();

  await window.screenshot({ path: 'test-results/recordings-home.png' });
});

test('navigates to settings and back', async () => {
  await window.getByRole('button', { name: 'Open settings' }).click();
  await expect(window.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(window.getByRole('button', { name: 'Save settings' })).toBeVisible();

  await window.screenshot({ path: 'test-results/settings.png' });

  await window.getByRole('button', { name: 'Back' }).click();
  await expect(window.getByRole('button', { name: 'Record', exact: true })).toBeVisible();
});
