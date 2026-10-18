import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WIN } from '../fixtures/platform'

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'node-pty-helper.mjs')

describe.runIf(!WIN)('scripts/node-pty-helper.mjs', () => {
  it('makes the spawn-helper of node-pty for macOS executable, as npm unpacks it without the execute bit', () => {
    const modules = mkdtempSync(join(tmpdir(), 'ct-modules-'))
    const helpers = ['darwin-arm64', 'darwin-x64'].map((arch) => join(modules, 'node-pty', 'prebuilds', arch, 'spawn-helper'))
    for (const h of helpers) {
      mkdirSync(join(h, '..'), { recursive: true })
      writeFileSync(h, 'x', { mode: 0o644 })
    }
    execFileSync(process.execPath, [SCRIPT, modules])
    expect(helpers.map((h) => statSync(h).mode & 0o777)).toEqual([0o755, 0o755])
  })

  it('does nothing where node-pty has no macOS prebuilds', () => {
    const modules = mkdtempSync(join(tmpdir(), 'ct-modules-'))
    expect(() => execFileSync(process.execPath, [SCRIPT, modules])).not.toThrow()
  })
})
