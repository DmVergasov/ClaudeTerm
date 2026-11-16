import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { keychainService, readClaudeCredentials, securityRunner, type CredentialSources } from '../../src/main/remote-control/claude-credentials'

// the reader of Claude Code's sign-in against real files in a temp home: no test touches the real ~/.claude or Keychain

const NOW = 1_763_300_000_000
const TOKEN = 'fake-access-token-0001'

let home: string
let defaultFolder: string
let work: string

const sources = (over: Partial<CredentialSources> = {}): CredentialSources => ({ platform: 'linux', home, username: 'tester', now: () => NOW, security: null, ...over })
const store = (folder: string, record: object): void => { mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, '.credentials.json'), JSON.stringify(record)) }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ct-creds-'))
  defaultFolder = join(home, '.claude')
  work = join(home, 'accounts', 'work')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('reading the claude.ai sign-in of an account', () => {
  it('a fresh token in .credentials.json, with no device token anywhere', async () => {
    store(work, { claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW + 60_000 } })
    expect(await readClaudeCredentials(work, {}, sources())).toEqual({ accessToken: TOKEN, deviceToken: null, state: 'fresh' })
  })

  it('an expiresAt in the past is expired: no token, and the state says so', async () => {
    store(work, { claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW - 1 } })
    expect(await readClaudeCredentials(work, {}, sources())).toEqual({ accessToken: null, deviceToken: null, state: 'expired' })
  })

  it('no file, or a file without claudeAiOauth, is no sign-in', async () => {
    expect((await readClaudeCredentials(work, {}, sources())).state).toBe('none')
    store(work, { mcpOAuth: {} })
    expect((await readClaudeCredentials(work, {}, sources())).state).toBe('none')
  })

  it('an accessToken that is no token, or a file that is not JSON, is unusable', async () => {
    store(work, { claudeAiOauth: { accessToken: 'has space' } })
    expect((await readClaudeCredentials(work, {}, sources())).state).toBe('unusable')
    writeFileSync(join(work, '.credentials.json'), '{not json')
    expect((await readClaudeCredentials(work, {}, sources())).state).toBe('unusable')
  })

  it('the device token comes from the environment first, then the record, then the account’s .claude.json', async () => {
    store(work, { claudeAiOauth: { accessToken: TOKEN }, trustedDeviceToken: 'dev-record' })
    writeFileSync(join(work, '.claude.json'), JSON.stringify({ trustedDeviceToken: 'dev-json' }))
    expect((await readClaudeCredentials(work, { CLAUDE_TRUSTED_DEVICE_TOKEN: 'dev-env' }, sources())).deviceToken).toBe('dev-env')
    expect((await readClaudeCredentials(work, {}, sources())).deviceToken).toBe('dev-record')
    store(work, { claudeAiOauth: { accessToken: TOKEN } })
    expect((await readClaudeCredentials(work, {}, sources())).deviceToken).toBe('dev-json')
  })

  it('the default folder’s .claude.json is beside it, in the home folder', async () => {
    store(defaultFolder, { claudeAiOauth: { accessToken: TOKEN } })
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ trustedDeviceToken: 'dev-home' }))
    expect((await readClaudeCredentials(defaultFolder, {}, sources())).deviceToken).toBe('dev-home')
  })

  it('macOS reads the Keychain with the folder’s service and the user, and falls back to the file when that fails', async () => {
    const asked: string[][] = []
    const keychain = async (args: string[]): Promise<string | null> => { asked.push(args); return JSON.stringify({ claudeAiOauth: { accessToken: 'from-keychain-0001' } }) }
    expect((await readClaudeCredentials(defaultFolder, {}, sources({ platform: 'darwin', security: keychain }))).accessToken).toBe('from-keychain-0001')
    expect(asked).toEqual([['find-generic-password', '-s', 'Claude Code-credentials', '-a', 'tester', '-w']])
    store(work, { claudeAiOauth: { accessToken: TOKEN } })
    expect((await readClaudeCredentials(work, {}, sources({ platform: 'darwin', security: async () => null }))).accessToken).toBe(TOKEN)
  })

  it('another folder’s Keychain service ends with the first 8 hex of the sha256 of its NFC path', () => {
    const hex = createHash('sha256').update(work.normalize('NFC')).digest('hex').slice(0, 8)
    expect(keychainService(work, home)).toBe(`Claude Code-credentials-${hex}`)
    expect(keychainService(join(home, '.claude'), home)).toBe('Claude Code-credentials')
  })

  it('no runner (a test run): macOS reads the file', async () => {
    store(work, { claudeAiOauth: { accessToken: TOKEN } })
    expect((await readClaudeCredentials(work, {}, sources({ platform: 'darwin' }))).accessToken).toBe(TOKEN)
  })

  it('the security runner answers a program’s output, and null for one that fails', async () => {
    expect(await securityRunner(process.execPath)(['-e', 'process.stdout.write("out")'])).toBe('out')
    expect(await securityRunner(process.execPath)(['-e', 'process.exit(3)'])).toBeNull()
  })
})
