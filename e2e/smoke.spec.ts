import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let electronApp: ElectronApplication | undefined;
let window: Page;
let testHome: string;
let fakeCliPath: string;
let modelManifestPath: string;

test.beforeAll(async () => {
  // Isolate the app from the developer's real home directory and user data so
  // personal recordings, config, and credentials are never loaded or captured.
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-copilot-e2e-'));
  fakeCliPath = path.join(testHome, 'fake-whisper-cli');
  modelManifestPath = path.join(testHome, 'model-manifest.json');
  fs.writeFileSync(fakeCliPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(modelManifestPath, JSON.stringify({
    url: 'https://models.example.test/ggml-test-model.bin',
    fileName: 'ggml-test-model.bin',
    byteSize: 1,
    sha256: '0000000000000000000000000000000000000000000000000000000000000000',
  }));
  electronApp = await electron.launch({
    args: ['.', `--user-data-dir=${testHome}`],
    env: {
      ...process.env,
      HOME: testHome,
      INTERVIEW_COPILOT_E2E: '1',
      INTERVIEW_COPILOT_WHISPER_CLI: fakeCliPath,
      INTERVIEW_COPILOT_MODEL_MANIFEST: modelManifestPath,
    },
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
  await expect(window.getByRole('combobox', { name: 'Transcription provider' })).toContainText('Local Whisper');
  await expect(window.getByText('Transcription runs on this Mac. Audio is not uploaded.')).toBeVisible();
  await expect(window.getByLabel('Groq API Key')).toHaveCount(0);
  await expect(
    window.getByText('Auto-transcribe after recording')
  ).toHaveCount(0);

  await window.getByRole('combobox', { name: 'Transcription provider' }).click();
  await window.getByRole('option', { name: 'Groq' }).click();
  await expect(window.getByLabel('Groq API Key')).toBeVisible();
  await expect(window.getByLabel('Model')).toBeVisible();
  await expect(window.getByText('Transcription sends prepared audio to Groq for processing.')).toBeVisible();
  await window.getByLabel('Groq API Key').fill('provider-secret-value');

  await window.getByRole('combobox', { name: 'Transcription provider' }).click();
  await window.getByRole('option', { name: 'Local Whisper' }).click();
  await expect(window.getByLabel('Groq API Key')).toHaveCount(0);
  await expect(window.getByText('Transcription runs on this Mac. Audio is not uploaded.')).toBeVisible();

  await window.getByRole('combobox', { name: 'Transcription provider' }).click();
  await window.getByRole('option', { name: 'Groq' }).click();
  await expect(window.getByLabel('Groq API Key')).toHaveValue('provider-secret-value');

  await window.screenshot({ path: 'test-results/settings.png' });

  await window.getByRole('button', { name: 'Back' }).click();
  await expect(window.getByRole('button', { name: 'Record', exact: true })).toBeVisible();
});
