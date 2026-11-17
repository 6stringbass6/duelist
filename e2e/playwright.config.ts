import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', timeout: 90_000, retries: 0, reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: process.env.E2E_URL ?? 'http://localhost:5173', headless: true, viewport: { width: 1366, height: 800 },
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
    launchOptions: { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
});
