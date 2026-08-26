import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testIgnore: 'packaged-smoke.spec.ts',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  outputDir: 'test-results',
  reporter: [['list']],
});
