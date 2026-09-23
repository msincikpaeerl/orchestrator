import { defineConfig, devices } from '@playwright/test';

// End-to-end tests (ADR 0021): run in the pinned Playwright image, locally with `pnpm test:e2e`
// and in CI. The server under test is apps/server/test/e2e-server.ts, with the built UI.
const port = Number(process.env.E2E_PORT ?? 8095);
const baseURL = `http://127.0.0.1:${String(port)}`;

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  // One server and one database for all tests: each test resets it (e2e/fixtures.ts).
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  // Every test runs on a computer screen and on a phone (02, section 1).
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: '../server/node_modules/.bin/tsx --conditions=source ../server/test/e2e-server.ts',
    url: `${baseURL}/health`,
    env: { E2E_PORT: String(port) },
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    stdout: 'pipe',
  },
});
