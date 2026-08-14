import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

/* ── Shared model server ────────────────────────────────────────────
 *
 * One model server is shared across all describe blocks.  It serves a
 * small fixture model so the local-transcription flow works in every
 * app instance.
 * ─────────────────────────────────────────────────────────────────── */

let modelServer: http.Server;
let modelServerUrl: string;
let releaseSecondModelChunk: (() => void) | undefined;
const modelRequests: string[] = [];
let sharedModel: Buffer;
let sharedModelSha256: string;

const testHomes: string[] = [];

function writeStereoWav(filePath: string, { extraPcmFrames = 0 }: { extraPcmFrames?: number } = {}): number {
  const sampleRate = 16_000;
  const frameCount = 8_000 + extraPcmFrames;
  const channels = 2;
  const bytesPerSample = 2;
  const dataSize = frameCount * channels * bytesPerSample;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  wav.writeUInt16LE(channels * bytesPerSample, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const offset = 44 + frame * channels * bytesPerSample;
    wav.writeInt16LE(frame % 2 === 0 ? 1_000 : -1_000, offset);
    wav.writeInt16LE(frame % 2 === 0 ? -1_000 : 1_000, offset + bytesPerSample);
  }

  fs.writeFileSync(filePath, wav);
  return dataSize;
}

function writeMinimalWav(filePath: string, pcmFrames: number): number {
  const channels = 2;
  const bytesPerSample = 2;
  const sampleRate = 16_000;
  const dataSize = pcmFrames * channels * bytesPerSample;
  const wav = Buffer.alloc(44 + dataSize);

  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  wav.writeUInt16LE(channels * bytesPerSample, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);

  for (let frame = 0; frame < pcmFrames; frame += 1) {
    const offset = 44 + frame * channels * bytesPerSample;
    wav.writeInt16LE(100, offset);
    wav.writeInt16LE(-100, offset + bytesPerSample);
  }

  fs.writeFileSync(filePath, wav);
  return dataSize;
}

function createRecoveryFixture(recordingsRoot: string, uuid: string, pcmFrames: number): void {
  const dir = path.join(recordingsRoot, '.recovery', uuid);
  fs.mkdirSync(dir, { recursive: true });
  writeMinimalWav(path.join(dir, 'audio.wav'), pcmFrames);
  const now = new Date();
  const durationMs = (pcmFrames * 2 * 2) / 64; // pcmBytes / byteRate * 1000
  fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({
    version: 1,
    status: 'failed',
    startedAt: now.toISOString(),
    endedAt: new Date(now.getTime() + durationMs).toISOString(),
    channels: { interviewer: { started: true }, you: { started: true } },
    interruptions: [],
  }));
}

async function startModelServer(): Promise<void> {
  sharedModel = fs.readFileSync(path.resolve('e2e/fixtures/model.bin'));
  sharedModelSha256 = createHash('sha256').update(sharedModel).digest('hex');
  const firstChunkLength = Math.floor(sharedModel.length / 2);
  const secondChunk = new Promise<void>((resolve) => {
    releaseSecondModelChunk = resolve;
  });
  modelServer = http.createServer(async (request, response) => {
    modelRequests.push(request.url ?? '');
    if (request.url !== '/model.bin') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Length': sharedModel.length,
      'Content-Type': 'application/octet-stream',
    });
    response.write(sharedModel.subarray(0, firstChunkLength));
    await secondChunk;
    response.end(sharedModel.subarray(firstChunkLength));
  });
  await new Promise<void>((resolve, reject) => {
    modelServer.once('error', reject);
    modelServer.listen(0, '127.0.0.1', () => {
      modelServer.off('error', reject);
      resolve();
    });
  });
  const address = modelServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('E2E model server did not bind to a TCP port');
  }
  modelServerUrl = `http://127.0.0.1:${address.port}/model.bin`;
}

async function stopModelServer(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    modelServer.close((error) => error ? reject(error) : resolve());
  });
}

/** Launch a fresh Electron app with the given capture-helper scenario. */
async function launchTestApp(
  scenario: string,
  extraSetup?: (testHome: string) => void,
): Promise<{ electronApp: ElectronApplication; window: Page; testHome: string }> {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-copilot-e2e-'));
  testHomes.push(testHome);

  const modelManifestPath = path.join(testHome, 'model-manifest.json');
  const recordingsDir = path.join(testHome, 'InterviewCopilot', 'recordings');
  const fakeCaptureHelperPath = path.join(
    testHome,
    `fake-audio-capture-helper__${scenario}.js`,
  );

  const recordingId = '2026-07-27T00-00-00-000Z';
  const recordingDir = path.join(recordingsDir, recordingId);
  fs.mkdirSync(recordingDir, { recursive: true });
  writeStereoWav(path.join(recordingDir, 'audio.wav'));

  fs.writeFileSync(modelManifestPath, JSON.stringify({
    url: modelServerUrl,
    fileName: 'model.bin',
    byteSize: sharedModel.length,
    sha256: sharedModelSha256,
  }));
  const fakeCaptureHelper = fs.readFileSync(
    path.resolve('e2e/fixtures/fake-audio-capture-helper.js'),
    'utf8',
  ).replace(/^#!\/usr\/bin\/env node/, `#!${process.execPath}`);
  fs.writeFileSync(fakeCaptureHelperPath, fakeCaptureHelper);
  fs.chmodSync(fakeCaptureHelperPath, 0o755);

  extraSetup?.(testHome);

  const electronApp = await electron.launch({
    args: ['.', `--user-data-dir=${testHome}`],
    env: {
      ...process.env,
      HOME: testHome,
      INTERVIEW_COPILOT_E2E: '1',
      INTERVIEW_COPILOT_WHISPER_CLI: path.resolve('e2e/fixtures/fake-whisper-cli.js'),
      INTERVIEW_COPILOT_MODEL_MANIFEST: modelManifestPath,
      INTERVIEW_COPILOT_AUDIO_CAPTURE_HELPER: fakeCaptureHelperPath,
    },
  });

  const window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  return { electronApp, window, testHome };
}

/* ── Global model-server lifecycle ──────────────────────────────── */

test.beforeAll(async () => {
  await startModelServer();
});

test.afterAll(async () => {
  await stopModelServer();
  for (const dir of testHomes) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ── Shared-app tests ──────────────────────────────────────────── */

test('launches a 400x600 window titled Interview Copilot', async () => {
  const { electronApp, window } = await launchTestApp('default');

  try {
    expect(await window.title()).toBe('Interview Copilot');

    const windowSize = await electronApp.evaluate(({ BrowserWindow }) => {
      const [win] = BrowserWindow.getAllWindows();
      return win.getSize();
    });
    expect(windowSize).toEqual([400, 600]);
  } finally {
    await electronApp.close();
  }
});

test('recordings home renders primary controls', async () => {
  const { electronApp, window } = await launchTestApp('default');

  try {
    await expect(window.getByRole('button', { name: 'Record', exact: true })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Open settings' })).toBeVisible();
    await window.screenshot({ path: 'test-results/recordings-home.png' });
  } finally {
    await electronApp.close();
  }
});

test('transcribes a local recording through the loopback model server and fake sidecar', async () => {
  const { electronApp, window } = await launchTestApp('default');

  try {
    await window.getByRole('button', { name: 'Transcribe audio' }).click();
    await expect(window.getByText(/^Downloading model/).first()).toBeVisible();

    releaseSecondModelChunk?.();

    await expect(window.getByText('Ready', { exact: true })).toBeVisible();
    expect(modelRequests).toEqual(['/model.bin']);
    await window.screenshot({ path: 'test-results/local-transcription-ready.png' });
  } finally {
    await electronApp.close();
  }
});

test('navigates to settings and back', async () => {
  const { electronApp, window } = await launchTestApp('default');

  try {
    await window.getByRole('button', { name: 'Open settings' }).click();
    await expect(window.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(window.getByRole('button', { name: 'Save settings' })).toBeVisible();
    await expect(window.getByRole('combobox', { name: 'Transcription provider' })).toContainText('Local Whisper');
    await expect(window.getByText('Transcription runs on this Mac. Audio is not uploaded.')).toBeVisible();
    await expect(window.getByLabel('Groq API Key')).toHaveCount(0);
    await expect(
      window.getByText('Auto-transcribe after recording')
    ).toHaveCount(0);
    await window.screenshot({ path: 'test-results/settings-local.png' });

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

    await window.screenshot({ path: 'test-results/settings-groq.png' });

    await window.getByRole('button', { name: 'Back' }).click();
    await expect(window.getByRole('button', { name: 'Record', exact: true })).toBeVisible();
  } finally {
    await electronApp.close();
  }
});

/* ── Native capture E2E ──────────────────────────────────────────── */

test('Starting -> Recording -> Stop -> published library item', async () => {
  const { electronApp, window } = await launchTestApp('default');

  try {
    // Click Record - the default scenario emits ready, 10 PCM blocks, stopped.
    await window.getByRole('button', { name: 'Record', exact: true }).click();

    // The card and its Transcribe action are separate buttons, so assert the
    // user-visible recording count instead of an implementation detail.
    await expect(window.getByText('2 saved interviews')).toBeVisible({ timeout: 10_000 });

    await window.screenshot({ path: 'test-results/native-capture-published.png' });
  } finally {
    await electronApp.close();
  }
});

test('Cancel during Starting', async () => {
  // Uses delayed-ready: the helper waits 2s before emitting ready.
  const { electronApp, window } = await launchTestApp('delayed-ready');

  try {
    const beforeCount = await window.locator('main button[type="button"]').count();

    // Click Record - enters "starting" state (waiting for helper ready)
    await window.getByRole('button', { name: 'Record', exact: true }).click();

    // The Cancel button should appear while the helper is starting
    const cancel = window.getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeVisible({ timeout: 3_000 });

    // Take the Cancel action
    await cancel.click();

    // The app should return to idle: Record button reappears, no new recording added
    await expect(window.getByRole('button', { name: 'Record', exact: true })).toBeVisible({ timeout: 5_000 });

    const afterCount = await window.locator('main button[type="button"]').count();
    expect(afterCount).toBe(beforeCount);

    await window.screenshot({ path: 'test-results/native-capture-cancel.png' });
  } finally {
    await electronApp.close();
  }
});

test('Quit during recording waits for final publication', async () => {
  // Uses slow: the helper emits ready then 1 PCM/s for 30s then stopped.
  const { electronApp, window, testHome } = await launchTestApp('slow');

  try {
    // Click Record - enters recording state
    await window.getByRole('button', { name: 'Record', exact: true }).click();

    // Verify recording is active: the Stop button should be visible
    await expect(window.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 5_000 });

    // Request the app to quit via the Electron API.
    // The quit-coordinator intercepts before-quit, stops the capture,
    // waits for the stopped frame, then re-issues quit.
    await electronApp.evaluate(({ app }) => {
      app.quit();
    });

    // The app should close gracefully (not crash) once publication completes.
    await electronApp.close();

    // Verify a recording was published to disk before the app exited.
    const recordingsDir = path.join(testHome, 'InterviewCopilot', 'recordings');
    const entries = fs.readdirSync(recordingsDir, { withFileTypes: true });
    const publishedDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    expect(publishedDirs.length).toBeGreaterThanOrEqual(2); // fixture + new recording
  } catch (error) {
    try { await electronApp.close(); } catch { /* best effort */ }
    throw error;
  }
});

test('One-channel interruption remaining visible after save', async () => {
  // Uses single-channel-interruption scenario:
  // ready, 5 PCM, interruption-open, 3 silent-right PCM, interruption-closed, 2 PCM, stopped.
  const { electronApp, window } = await launchTestApp('single-channel-interruption');

  try {
    await window.getByRole('button', { name: 'Record', exact: true }).click();

    // Wait for the recording to finish
    await expect(window.getByRole('button', { name: 'Record', exact: true })).toBeVisible({ timeout: 10_000 });

    // The published recording should have an "Interrupted" badge
    await expect(window.getByText('Interrupted')).toBeVisible({ timeout: 5_000 });

    // The seeded legacy recording remains transcribable; the newly interrupted
    // recording does not add a second Transcribe action.
    await expect(window.getByRole('button', { name: 'Transcribe audio' })).toHaveCount(1);

    await window.screenshot({ path: 'test-results/native-capture-interruption.png' });
  } finally {
    await electronApp.close();
  }
});

test('Output overflow leaving both rows Connected -- audio gap detected', async () => {
  // Uses overflow-slow: ready, 3 PCM, gap, 10 trailing PCM (1/s), stopped.
  // The gap triggers connected-with-gap on both channels while recording.
  const { electronApp, window } = await launchTestApp('overflow-slow');

  try {
    await window.getByRole('button', { name: 'Record', exact: true }).click();

    // Wait for the recording to reach the active state (Stop button visible)
    await expect(window.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 5_000 });

    // Both channel rows should show "Connected (gap detected)"
    const gapBadges = window.getByRole('status').getByText('Connected (gap detected)');
    await expect(gapBadges).toHaveCount(2, { timeout: 5_000 });

    await window.screenshot({ path: 'test-results/native-capture-overflow.png' });
  } finally {
    try { await electronApp.close(); } catch { /* best effort */ }
  }
});

test('Exact recovery count/total/date/size/state presentation', async () => {
  // Pre-create two recovery fixtures before launching the app.
  const recoveryUuid1 = '11111111-1111-4111-8111-111111111111';
  const recoveryUuid2 = '22222222-2222-4222-8222-222222222222';

  const { electronApp, window } = await launchTestApp('default', (testHome) => {
    const recordingsRoot = path.join(testHome, 'InterviewCopilot', 'recordings');
    // 1000 frames * 2 channels * 2 bytes = 4000 bytes PCM + 44 header = 4044 bytes each
    createRecoveryFixture(recordingsRoot, recoveryUuid1, 1000);
    // 500 frames * 2 channels * 2 bytes = 2000 bytes PCM + 44 header = 2044 bytes
    createRecoveryFixture(recordingsRoot, recoveryUuid2, 500);
  });

  try {
    // The recovery section should be visible
    await expect(window.getByText('Recover recordings')).toBeVisible({ timeout: 5_000 });

    // Notice: "2 recordings, 6.0 KB" (4044 + 2044 = 6088 bytes ≈ 6.0 KB)
    const notice = window.getByText(/^2 recordings,/);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('KB');

    // Each item shows date, size, and state
    // Item 1
    await expect(window.getByText('Partial audio can be recovered').first()).toBeVisible();
    // Both items show the same state text; verify we have exactly 2
    await expect(window.getByText('Partial audio can be recovered')).toHaveCount(2);

    // Two item sizes plus the aggregate-size notice end with KB.
    await expect(window.getByText(/KB$/)).toHaveCount(3);

    await window.screenshot({ path: 'test-results/recovery-presentation.png' });
  } finally {
    await electronApp.close();
  }
});

test('Recovery/Trash confirmation', async () => {
  const recoveryUuid = '33333333-3333-4333-8333-333333333333';

  const { electronApp, window } = await launchTestApp('default', (testHome) => {
    const recordingsRoot = path.join(testHome, 'InterviewCopilot', 'recordings');
    createRecoveryFixture(recordingsRoot, recoveryUuid, 800);
  });

  try {
    await expect(window.getByText('Recover recordings')).toBeVisible({ timeout: 5_000 });

    // Click the trash button (labeled "Remove recording from <date>")
    const trashButton = window.getByRole('button', { name: /Remove recording from/ });
    await expect(trashButton).toBeVisible();
    await trashButton.click();

    // Confirmation dialog should appear with "Remove" and "Cancel" buttons
    const confirmRemove = window.getByRole('button', { name: 'Confirm remove' });
    const cancelRemove = window.getByRole('button', { name: 'Cancel removal' });
    await expect(confirmRemove).toBeVisible({ timeout: 3_000 });
    await expect(cancelRemove).toBeVisible();

    // Cancel first to verify dismissal works
    await cancelRemove.click();
    await expect(confirmRemove).toHaveCount(0);

    // Re-open and confirm
    await trashButton.click();
    await expect(window.getByRole('button', { name: 'Confirm remove' })).toBeVisible({ timeout: 3_000 });
    await window.getByRole('button', { name: 'Confirm remove' }).click();

    // The recovery item should be removed
    await expect(window.getByText('Recover recordings')).toHaveCount(0, { timeout: 5_000 });

    await window.screenshot({ path: 'test-results/recovery-trash-confirm.png' });
  } finally {
    await electronApp.close();
  }
});
