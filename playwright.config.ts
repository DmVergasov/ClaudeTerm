import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  // locally three tests run at once: each starts its own app, with its own data folder, pipe and ports. A CI job keeps
  // to one, as its runner has few cores, and the jobs split the tests between them instead (--shard)
  workers: process.env.CI ? 1 : 3,
  // on CI a test that fails once runs again: a busy runner's one-off stall does not fail the run, a broken test still
  // fails twice, and the report lists the test as flaky
  retries: process.env.CI ? 1 : 0,
  // the run's own temp folder, deleted when it ends
  globalSetup: './tests/fixtures/temp-root-setup.ts',
  reporter: 'list',
  // the tests tagged @alone need the machine to themselves: the system clipboard is one for every app on it, and a time
  // limit does not hold while other tests load it. They run one at a time, and npm run test:e2e runs them after the
  // others (scripts/e2e.mjs)
  projects: [
    { name: 'e2e', grepInvert: /@alone/ },
    { name: 'alone', grep: /@alone/, workers: 1 }
  ]
})
