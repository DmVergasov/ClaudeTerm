// Runs the end-to-end tests in two passes: first the tests that may run side by side, three at a time locally, then the
// tests tagged @alone, one at a time with nothing else running, as they need the machine to themselves (its clipboard, a
// time limit). Both passes run even when the first fails; the arguments go to both: node scripts/e2e.mjs keys.spec.ts
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url))
let failed = false
for (const project of ['e2e', 'alone']) {
  const run = spawnSync(process.execPath, [cli, 'test', `--project=${project}`, '--pass-with-no-tests', ...process.argv.slice(2)], { stdio: 'inherit' })
  if (run.status !== 0) failed = true
}
process.exit(failed ? 1 : 0)
