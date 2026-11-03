import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 412, height: 915 }, trace: 'retain-on-failure' },
  webServer: [
    { command: 'npm run mock', url: 'http://127.0.0.1:4174/api/mobile/capabilities', reuseExistingServer: false },
    { command: 'npm run dev -- --port 5173 --strictPort', url: 'http://127.0.0.1:5173', reuseExistingServer: false },
  ],
});
