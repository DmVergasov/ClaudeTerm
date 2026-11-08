import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    // the run's own temp folder, deleted when it ends
    globalSetup: ['tests/fixtures/temp-root-setup.ts'],
    testTimeout: 20_000,
    // on CI a test that fails once runs again: a busy runner's one-off stall does not fail the run, a broken test still
    // fails twice
    retry: process.env.CI ? 1 : 0
  }
})
