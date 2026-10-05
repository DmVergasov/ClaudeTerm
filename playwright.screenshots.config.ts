import { defineConfig } from '@playwright/test'

// README screenshots (docs/images) and the app icon (build/icon.png), not part of the test suite: `npm run screenshots`
export default defineConfig({
  testDir: 'tests/screenshots',
  testMatch: '*.shots.ts',
  timeout: 120_000,
  workers: 1,
  reporter: 'list'
})
