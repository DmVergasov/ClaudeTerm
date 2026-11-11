import { defineConfig } from '@playwright/test'

// the timing harness (npm run perf): one run of the app at a time, not part of the test suite
export default defineConfig({
  testDir: 'tests/perf',
  testMatch: '*.perf.ts',
  timeout: 30 * 60_000,
  workers: 1,
  retries: 0,
  // the run's own temp folder, deleted when it ends
  globalSetup: './tests/fixtures/temp-root-setup.ts',
  reporter: 'list'
})
