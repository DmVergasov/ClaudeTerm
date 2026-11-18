import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { closeTempRoot, openTempRoot, STALE_ROOT_MS, TEMP_ROOT_PREFIX } from '../fixtures/temp-root'

const DAY = 24 * 3_600_000

describe('the temp root of a test run', () => {
  it('this run writes its temp files into a root of its own, which its global setup made', () => {
    expect(basename(tmpdir()).startsWith(TEMP_ROOT_PREFIX)).toBe(true)
    expect(process.env.TEMP).toBe(tmpdir())
    expect(process.env.TMPDIR).toBe(tmpdir())
  })

  it('this run sees nothing of the machine\'s Claude Code and ClaudeTerm: none of their variables, and a home folder in its root', () => {
    expect(Object.keys(process.env).filter((key) => /^(CLAUDE|ANTHROPIC_)/i.test(key))).toEqual([])
    expect(homedir()).toBe(join(tmpdir(), 'home'))
    expect(existsSync(homedir())).toBe(true)
  })

  it('opens a root in the system temp folder and points TEMP, TMP, TMPDIR and the home folder of the environment at it', () => {
    const system = mkdtempSync(join(tmpdir(), 'system-'))
    const env: NodeJS.ProcessEnv = { TEMP: system, PATH: 'kept' }
    const root = openTempRoot(env, system)
    expect(dirname(root)).toBe(system)
    expect(basename(root).startsWith(TEMP_ROOT_PREFIX)).toBe(true)
    expect(existsSync(root)).toBe(true)
    const home = join(root, 'home')
    expect(existsSync(home)).toBe(true)
    expect(env).toEqual({ TEMP: root, TMP: root, TMPDIR: root, HOME: home, USERPROFILE: home, PATH: 'kept' })
  })

  it('takes away every variable of the machine\'s Claude Code, Anthropic sign-in and ClaudeTerm, and its home folder', () => {
    // the shell a person runs the tests from: Claude Code's config folder and sign-in, the ClaudeTerm tab it runs in
    const system = mkdtempSync(join(tmpdir(), 'system-'))
    const machineHome = mkdtempSync(join(tmpdir(), 'machine-home-'))
    const env: NodeJS.ProcessEnv = {
      PATH: 'kept',
      CLAUDE_CONFIG_DIR: join(machineHome, '.claude-accounts', 'work'),
      CLAUDECODE: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'machine-oauth-token-0001',
      CLAUDE_CODE_SESSION_ID: '1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9',
      claude_code_use_bedrock: '1',
      ANTHROPIC_API_KEY: 'sk-ant-machine-key-0001',
      ANTHROPIC_BASE_URL: 'https://llm.example.com',
      CLAUDETERM_PIPE: 'claudeterm-machine-pipe',
      CLAUDETERM_TAB_ID: '0f1e2d3c-4b5a-4968-8776-655443322110',
      HOME: machineHome,
      USERPROFILE: machineHome
    }
    const root = openTempRoot(env, system)
    const home = join(root, 'home')
    expect(env).toEqual({ PATH: 'kept', TEMP: root, TMP: root, TMPDIR: root, HOME: home, USERPROFILE: home })
  })

  it('an X display found through the old home folder\'s .Xauthority stays reachable', () => {
    const system = mkdtempSync(join(tmpdir(), 'system-'))
    const machineHome = mkdtempSync(join(tmpdir(), 'machine-home-'))
    writeFileSync(join(machineHome, '.Xauthority'), '')
    const env: NodeJS.ProcessEnv = { HOME: machineHome }
    openTempRoot(env, system)
    expect(env.XAUTHORITY).toBe(join(machineHome, '.Xauthority'))
    // one the environment names already is kept, and without the file nothing is added
    const named: NodeJS.ProcessEnv = { HOME: machineHome, XAUTHORITY: '/run/user/1000/gdm/Xauthority' }
    openTempRoot(named, system)
    expect(named.XAUTHORITY).toBe('/run/user/1000/gdm/Xauthority')
    const none: NodeJS.ProcessEnv = { HOME: mkdtempSync(join(tmpdir(), 'machine-home-')) }
    openTempRoot(none, system)
    expect(none.XAUTHORITY).toBeUndefined()
  })

  it('closing the root deletes it with everything in it', () => {
    const system = mkdtempSync(join(tmpdir(), 'system-'))
    const root = openTempRoot({}, system)
    mkdirSync(join(root, 'ct-e2e-a1', 'GPUCache'), { recursive: true })
    writeFileSync(join(root, 'ct-e2e-a1', 'GPUCache', 'data_0'), 'x')
    closeTempRoot(root)
    expect(existsSync(root)).toBe(false)
  })

  it('a new root deletes the roots of runs that died over a day ago, and leaves fresh roots and other folders alone', () => {
    const system = mkdtempSync(join(tmpdir(), 'system-'))
    const now = Date.now()
    const dead = join(system, `${TEMP_ROOT_PREFIX}dead01`)
    const running = join(system, `${TEMP_ROOT_PREFIX}live01`)
    const other = join(system, 'ClaudeTerm')
    for (const d of [dead, running, other]) mkdirSync(join(d, 'inner'), { recursive: true })
    const old = new Date(now - STALE_ROOT_MS - 60_000)
    utimesSync(dead, old, old)
    utimesSync(other, old, old)
    const recent = new Date(now - DAY / 2)
    utimesSync(running, recent, recent)

    openTempRoot({}, system, now)
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(running)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })
})
