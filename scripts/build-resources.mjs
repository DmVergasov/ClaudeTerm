import { build } from 'esbuild'
import { existsSync } from 'node:fs'

const entries = [
  { in: 'src/mcp/show-image-server.ts', out: 'resources/mcp/show-image-server.js' },
  { in: 'src/hook/main.ts', out: 'resources/hook/session-hook.js' }
]

for (const e of entries) {
  if (!existsSync(e.in)) {
    console.log(`skip ${e.in} (not created yet)`)
    continue
  }
  await build({
    entryPoints: [e.in],
    outfile: e.out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'info'
  })
}
