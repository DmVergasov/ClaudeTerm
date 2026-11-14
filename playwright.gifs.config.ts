import { defineConfig } from '@playwright/test'

// The animated README demos (docs/images/*.gif), not part of the test suite: `npm run gifs` (needs ffmpeg on the PATH)
export default defineConfig({
  testDir: 'tests/screenshots',
  testMatch: '*.gifs.ts',
  timeout: 300_000,
  workers: 1,
  // a recording that shows a hiccup of a busy machine (see keepGroups) is made again
  retries: 2,
  // the run's own temp folder, deleted when it ends
  globalSetup: './tests/fixtures/temp-root-setup.ts',
  reporter: 'list'
})
