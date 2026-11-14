import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canonical, clashes } from '../../src/main/account-login'

// the folders of the real disk: a junction (Windows) or a directory symlink (elsewhere) to a folder of the test

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'account-login-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('canonical and clashes on disk', () => {
  it('a folder inside another through a junction or a symlink clashes; a sibling does not', async () => {
    const target = join(dir, 'target')
    const link = join(dir, 'link')
    const sibling = join(dir, 'sibling')
    mkdirSync(target)
    mkdirSync(sibling)
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')

    const others = [await canonical(target)]
    expect(clashes(await canonical(join(link, 'work')), others)).toBe(true)
    expect(clashes(await canonical(join(sibling, 'work')), others)).toBe(false)
  })

  it("a folder that does not exist yet is its parent's real path joined with its name", async () => {
    const real = realpathSync.native(dir)
    expect(await canonical(join(dir, 'new', 'deeper'))).toBe(join(real, 'new', 'deeper'))
  })
})
