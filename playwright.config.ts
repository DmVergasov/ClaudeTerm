import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  // on CI a test that fails once runs again: a busy runner's one-off stall does not fail the run, a broken test still
  // fails twice, and the report lists the test as flaky
  retries: process.env.CI ? 1 : 0,
  // the run's own temp folder, deleted when it ends
  globalSetup: './tests/fixtures/temp-root-setup.ts',
  reporter: 'list'
})
