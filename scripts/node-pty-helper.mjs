// node-pty's npm package ships its macOS spawn-helper without the execute bit, and without it no terminal starts on
// macOS ("posix_spawnp failed"), in the tests or in the packaged app: npm runs this after every install.
// node scripts/node-pty-helper.mjs [node_modules folder]
import { chmodSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const modules = process.argv[2] ?? fileURLToPath(new URL('../node_modules', import.meta.url))
for (const arch of ['darwin-arm64', 'darwin-x64']) {
  const helper = join(modules, 'node-pty', 'prebuilds', arch, 'spawn-helper')
  if (existsSync(helper)) chmodSync(helper, 0o755)
}
