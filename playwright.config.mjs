// Playwright smoke tests (tests/e2e/). Mobile viewport, real Chromium, static server of web/ only:
// no worker and no network. Every request off the static origin is mocked or blocked (tests/e2e/mock.mjs).
import { defineConfig } from '@playwright/test';

const PORT = 4173;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.mjs',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  timeout: 20_000,
  globalTimeout: 120_000, // the whole suite stays under 2 minutes
  expect: { timeout: 7_000 },
  reporter: CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    browserName: 'chromium',
    viewport: { width: 360, height: 780 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'el-GR',
    timezoneId: 'Europe/Athens',
    serviceWorkers: 'block', // the offline spec opts back in
    trace: 'retain-on-failure',
  },
  webServer: {
    // localhost: api.js then points at http://localhost:8787, which the specs mock (nothing listens there).
    command: `node node_modules/http-server/bin/http-server web -p ${PORT} -c-1 --silent`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !CI,
    timeout: 30_000,
  },
});
