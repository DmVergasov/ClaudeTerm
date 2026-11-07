import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  // the run's own temp folder, deleted when it ends
  globalSetup: './tests/fixtures/temp-root-setup.ts',
  reporter: 'list'
})
