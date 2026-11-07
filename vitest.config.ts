import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    // the run's own temp folder, deleted when it ends
    globalSetup: ['tests/fixtures/temp-root-setup.ts'],
    testTimeout: 20_000
  }
})
