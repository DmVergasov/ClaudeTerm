import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inAccountsRoot } from '../../src/main/account-login'

// the accounts folder decides what ClaudeTerm may delete: only a folder inside it, by its real path
describe('inAccountsRoot', () => {
  let base: string
  let root: string
  let outside: string

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'ct-root-'))
    root = join(base, 'accounts')
    outside = join(base, 'elsewhere', 'outside')
    mkdirSync(join(root, 'work'), { recursive: true })
    mkdirSync(outside, { recursive: true })
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('a folder inside the accounts root is inside, one that does not exist yet too', async () => {
    expect(await inAccountsRoot(join(root, 'work'), root)).toBe(true)
    expect(await inAccountsRoot(join(root, 'not-made-yet'), root)).toBe(true)
  })

  it('the root itself is not inside, nor a folder outside it', async () => {
    expect(await inAccountsRoot(root, root)).toBe(false)
    expect(await inAccountsRoot(outside, root)).toBe(false)
    expect(await inAccountsRoot(join(base, 'accounts-other'), root)).toBe(false)
  })

  it.runIf(process.platform === 'win32')('another spelling of the case of a folder inside is still inside', async () => {
    expect(await inAccountsRoot(join(root, 'WORK'), root.toUpperCase())).toBe(true)
  })

  it('a junction or symlink inside the root that points outside is not inside', async () => {
    const link = join(root, 'link')
    symlinkSync(outside, link, 'junction')
    expect(await inAccountsRoot(link, root)).toBe(false)
  })
})
