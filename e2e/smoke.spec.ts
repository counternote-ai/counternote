import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

let electronApp: ElectronApplication;
let window: Page;

test.beforeAll(async () => {
  electronApp = await electron.launch({ args: ['.'] });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp.close();
});

test('launches a 400x600 window titled Interview Copilot', async () => {
  expect(await window.title()).toBe('Interview Copilot');

  const windowSize = await electronApp.evaluate(({ BrowserWindow }) => {
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
