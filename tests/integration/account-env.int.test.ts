import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accountLaunchEnv, settingsEnv } from '../../src/main/remote-control/account-env'
import { remoteUnavailable } from '../../src/main/remote-control/account-rules'
import { REMOTE_REASONS } from '../../src/shared/remote-control'

// the settings.json of an account's folder, read from a real temp folder: no test touches the real ~/.claude

let root: string
let folder: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ct-account-env-'))
  folder = join(root, 'accounts', 'work')
  mkdirSync(folder, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the environment an account’s settings.json gives its Claude Code', () => {
  it('its env object, string values only: a number or an object in it is not taken', async () => {
    writeFileSync(join(folder, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example.invalid', RETRIES: 3, NESTED: { a: 1 } } }))
    expect(await settingsEnv(folder)).toEqual({ ANTHROPIC_BASE_URL: 'https://proxy.example.invalid' })
  })

  it('a missing file, a file that is not JSON, or one without an env object gives none', async () => {
    expect(await settingsEnv(folder)).toEqual({})
    writeFileSync(join(folder, 'settings.json'), '{ not json')
    expect(await settingsEnv(folder)).toEqual({})
    writeFileSync(join(folder, 'settings.json'), JSON.stringify({ env: ['ANTHROPIC_BASE_URL'] }))
    expect(await settingsEnv(folder)).toEqual({})
  })

  it('a base URL the settings.json env sets makes Remote Control unavailable, as one set in the launch environment does', async () => {
    writeFileSync(join(folder, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example.invalid' } }))
    const env = accountLaunchEnv(await settingsEnv(folder), {})
    expect(remoteUnavailable('login', env)).toBe(REMOTE_REASONS.baseUrl)
  })
})
