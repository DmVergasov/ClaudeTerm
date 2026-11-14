import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AccountStore, nodeAccountFile, type Vault } from '../../src/main/accounts'

const plain: Vault = { available: () => false, encrypt: (t) => t, decrypt: (d) => d }
const newPath = (): string => join(mkdtempSync(join(tmpdir(), 'ct-accounts-')), 'accounts.json')

describe('accounts.json version 2', () => {
  it('accounts.json version 2 is replaced in one step and readable only by the user', () => {
    const path = newPath()
    writeFileSync(path, JSON.stringify({ version: 1, accounts: [{ id: 'old', name: 'Work', addedAt: '2026-10-01T00:00:00.000Z', token: 'test-token-work-0000000001', encrypted: false }] }))
    const store = new AccountStore(nodeAccountFile(path), plain)
    expect(store.addLogin({ id: 'login-1', name: 'Home', folder: join(tmpdir(), 'ct-home-account'), created: true })).toEqual({ ok: true })
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved.version).toBe(2)
    expect(saved.accounts.map((a: { kind: string }) => a.kind)).toEqual(['token', 'login'])
    expect(readdirSync(join(path, '..'))).toEqual(['accounts.json'])
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('nodeAccountFile', () => {
  it('reads null before the file exists, then what was written; the write leaves no temporary file', () => {
    const path = newPath()
    const file = nodeAccountFile(path)
    expect(file.read()).toBeNull()
    file.write('{"version":1,"accounts":[]}\n')
    file.write('{"version":1,"accounts":[{}]}\n')
    expect(file.read()).toBe('{"version":1,"accounts":[{}]}\n')
    expect(readdirSync(join(path, '..'))).toEqual(['accounts.json'])
  })

  it.skipIf(process.platform === 'win32')('is readable only by the user', () => {
    const path = newPath()
    nodeAccountFile(path).write('{}')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('moves a broken file aside, and does not mind when there is none', () => {
    const path = newPath()
    const file = nodeAccountFile(path)
    file.moveAside()
    writeFileSync(path, 'not json')
    file.moveAside()
    expect(existsSync(path)).toBe(false)
    expect(readFileSync(`${path}.broken`, 'utf8')).toBe('not json')
  })

  it('a store on a broken file keeps it as accounts.json.broken when the first account is added', () => {
    const path = newPath()
    writeFileSync(path, 'not json')
    const store = new AccountStore(nodeAccountFile(path), plain)
    expect(store.add('Work', 'test-token-work-0000000001')).toEqual({ ok: true })
    expect(readFileSync(`${path}.broken`, 'utf8')).toBe('not json')
    expect(JSON.parse(readFileSync(path, 'utf8')).accounts[0]).toMatchObject({ name: 'Work', encrypted: false })
  })
})
