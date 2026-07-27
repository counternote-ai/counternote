import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

let electronApp: ElectronApplication | undefined;
let window: Page;
let testHome: string;
let fakeCliPath: string;
let modelManifestPath: string;
let modelServer: http.Server;
let modelServerUrl: string;
let releaseSecondModelChunk: (() => void) | undefined;
const modelRequests: string[] = [];

function writeStereoWav(filePath: string): void {
  const sampleRate = 16_000;
  const frameCount = 8_000;
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
}

test.beforeAll(async () => {
  // Isolate the app from the developer's real home directory and user data so
  // personal recordings, config, and credentials are never loaded or captured.
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-copilot-e2e-'));
  fakeCliPath = path.resolve('e2e/fixtures/fake-whisper-cli.js');
  modelManifestPath = path.join(testHome, 'model-manifest.json');

  const model = fs.readFileSync(path.resolve('e2e/fixtures/model.bin'));
  const firstChunkLength = Math.floor(model.length / 2);
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
      'Content-Length': model.length,
      'Content-Type': 'application/octet-stream',
    });
    response.write(model.subarray(0, firstChunkLength));
    await secondChunk;
    response.end(model.subarray(firstChunkLength));
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

  const recordingId = '2026-07-27T00-00-00-000Z';
  const recordingDir = path.join(testHome, 'InterviewCopilot', 'recordings', recordingId);
  fs.mkdirSync(recordingDir, { recursive: true });
  writeStereoWav(path.join(recordingDir, 'audio.wav'));
  fs.writeFileSync(modelManifestPath, JSON.stringify({
    url: modelServerUrl,
    fileName: 'model.bin',
    byteSize: model.length,
    sha256: createHash('sha256').update(model).digest('hex'),
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
    await new Promise<void>((resolve, reject) => {
      modelServer.close((error) => error ? reject(error) : resolve());
    });
    fs.rmSync(testHome, { recursive: true, force: true });
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

test('transcribes a local recording through the loopback model server and fake sidecar', async () => {
  await window.getByRole('button', { name: 'Transcribe audio' }).click();
  await expect(window.getByText(/^Downloading model/).first()).toBeVisible();

  releaseSecondModelChunk?.();

  await expect(window.getByText('Ready', { exact: true })).toBeVisible();
  expect(modelRequests).toEqual(['/model.bin']);
  await window.screenshot({ path: 'test-results/local-transcription-ready.png' });
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
});
