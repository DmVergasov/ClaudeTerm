import { describe, expect, it } from 'vitest'
import { loginEnv } from '../../src/main/accounts'
import { ensureMcpRegistered, resolveClaude, resolveClaudePosix, runClaude, signInFoldersToRegister, type RunOptions, type RunResult, type Runner } from '../../src/main/mcp-registrar'

const EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\ClaudeTerm\\ClaudeTerm.exe'
const SCRIPT = 'C:\\Users\\me\\AppData\\Local\\Programs\\ClaudeTerm\\resources\\mcp\\show-image-server.js'
const CLAUDE = 'C:\\Users\\me\\.local\\bin\\claude.exe'

type Call = { file: string; args: string[]; verbatim: boolean }

function fakeRunner(responses: Array<(c: Call) => RunResult | null>): { run: Runner; calls: Call[] } {
  const calls: Call[] = []
  const run: Runner = async (file, args, opts) => {
    const c = { file, args, verbatim: opts?.verbatim ?? false }
    calls.push(c)
    for (const r of responses) {
      const out = r(c)
      if (out) return out
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr = 'x'): RunResult => ({ code: 1, stdout: '', stderr })
const whereFinds = (out: string) => (c: Call) => (c.file === 'where.exe' ? ok(out) : null)

describe('resolveClaude', () => {
  it('prefers the native exe', async () => {
    const { run } = fakeRunner([whereFinds(`C:\\npm\\claude\r\n${CLAUDE}\r\nC:\\npm\\claude.cmd\r\n`)])
    expect(await resolveClaude(run)).toEqual({ file: CLAUDE, viaCmd: false })
  })

  it('falls back to a .cmd shim and returns null when nothing is found', async () => {
    expect(await resolveClaude(fakeRunner([whereFinds('C:\\npm\\claude.cmd\r\n')]).run)).toEqual({ file: 'C:\\npm\\claude.cmd', viaCmd: true })
    expect(await resolveClaude(fakeRunner([(c) => (c.file === 'where.exe' ? fail() : null)]).run)).toBeNull()
  })
})

describe('runClaude', () => {
  it('runs a .cmd shim through cmd.exe with verbatim quoting', async () => {
    const { run, calls } = fakeRunner([])
    await runClaude(run, { file: 'C:\\npm\\claude.cmd', viaCmd: true }, ['mcp', 'get', 'claudeterm'])
    expect(calls[0]).toEqual({ file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', '""C:\\npm\\claude.cmd" "mcp" "get" "claudeterm""'], verbatim: true })
  })
})

describe('resolveClaudePosix', () => {
  const marked = (path: string): RunResult => ok(`Welcome!\n__CLAUDETERM_PATH__${path}__CLAUDETERM_PATH__`)

  it('finds claude on the login shell PATH, not the app PATH, and runs it with that PATH', async () => {
    const nvm = '/home/me/.nvm/versions/node/v22/bin'
    const { run, calls } = fakeRunner([(c) => (c.file === '/bin/bash' ? marked(`/usr/bin:${nvm}`) : null)])
    const cli = await resolveClaudePosix({ run, shell: '/bin/bash', env: { PATH: '/usr/bin', HOME: '/home/me' }, isExecutable: (p) => p === `${nvm}/claude` })
    expect(cli).toEqual({ file: `${nvm}/claude`, viaCmd: false, env: { PATH: `/usr/bin:${nvm}`, HOME: '/home/me' } })
    expect(calls[0].args.slice(0, 3)).toEqual(['-l', '-i', '-c'])
  })

  it('falls back to the app PATH when the login shell gives nothing; null when claude is nowhere', async () => {
    const { run } = fakeRunner([() => fail()])
    expect(await resolveClaudePosix({ run, shell: '/bin/zsh', env: { PATH: '/usr/local/bin' }, isExecutable: (p) => p === '/usr/local/bin/claude' }))
      .toEqual({ file: '/usr/local/bin/claude', viaCmd: false, env: { PATH: '/usr/local/bin' } })
    expect(await resolveClaudePosix({ run, shell: null, env: { PATH: '/usr/bin' }, isExecutable: () => false })).toBeNull()
  })
})

describe('runClaude with an environment', () => {
  it('passes the environment a Linux claude needs', async () => {
    const seen: (NodeJS.ProcessEnv | undefined)[] = []
    const run: Runner = async (_f, _a, opts) => {
      seen.push(opts?.env)
      return ok()
    }
    await runClaude(run, { file: '/x/claude', viaCmd: false, env: { PATH: '/x' } }, ['mcp', 'get', 'claudeterm'])
    expect(seen).toEqual([{ PATH: '/x' }])
  })
})

describe('ensureMcpRegistered', () => {
  it('does nothing when already registered for this install', async () => {
    const { run, calls } = fakeRunner([whereFinds(CLAUDE), (c) => (c.args[1] === 'get' ? ok(`claudeterm:\n  Command: ${EXE}\n  Args: ${SCRIPT}\n`) : null)])
    expect(await ensureMcpRegistered({ run, execPath: EXE, serverScript: SCRIPT, log: () => {} })).toBe('already')
    expect(calls.map((c) => c.args[1])).toEqual([undefined, 'get'])
  })

  it('re-registers when missing or pointing elsewhere', async () => {
    const { run, calls } = fakeRunner([whereFinds(CLAUDE), (c) => (c.args[1] === 'get' ? fail('not found') : null)])
    expect(await ensureMcpRegistered({ run, execPath: EXE, serverScript: SCRIPT, log: () => {} })).toBe('registered')
    expect(calls.slice(2)).toEqual([
      { file: CLAUDE, args: ['mcp', 'remove', '--scope', 'user', 'claudeterm'], verbatim: false },
      { file: CLAUDE, args: ['mcp', 'add', '--scope', 'user', 'claudeterm', '-e', 'ELECTRON_RUN_AS_NODE=1', '--', EXE, SCRIPT], verbatim: false }
    ])
  })

  it('uses the claude it is given instead of looking it up', async () => {
    const { run, calls } = fakeRunner([(c) => (c.args[1] === 'get' ? ok(`Command: ${EXE}\nArgs: ${SCRIPT}\n`) : null)])
    const resolve = async () => ({ file: '/x/claude', viaCmd: false })
    expect(await ensureMcpRegistered({ run, execPath: EXE, serverScript: SCRIPT, log: () => {}, resolve })).toBe('already')
    expect(calls.map((c) => c.file)).toEqual(['/x/claude'])
  })

  it('re-registers when the app moved, even if the server script path is the same', async () => {
    const { run, calls } = fakeRunner([whereFinds(CLAUDE), (c) => (c.args[1] === 'get' ? ok(`Command: C:\\old\\ClaudeTerm.exe\nArgs: ${SCRIPT}\n`) : null)])
    expect(await ensureMcpRegistered({ run, execPath: EXE, serverScript: SCRIPT, log: () => {} })).toBe('registered')
    expect(calls.at(-1)?.args[1]).toBe('add')
  })

  it('reports no-claude and failed', async () => {
    expect(await ensureMcpRegistered({ run: fakeRunner([(c) => (c.file === 'where.exe' ? fail() : null)]).run, execPath: EXE, serverScript: SCRIPT, log: () => {} })).toBe('no-claude')
    const logs: string[] = []
    const { run } = fakeRunner([whereFinds(CLAUDE), (c) => (c.args[1] === 'get' || c.args[1] === 'add' ? fail('boom') : null)])
    expect(await ensureMcpRegistered({ run, execPath: EXE, serverScript: SCRIPT, log: (m) => logs.push(m) })).toBe('failed')
    expect(logs[0]).toContain('boom')
  })
})

describe('runClaude with an account environment', () => {
  it("a .cmd shim gets the account's environment too", async () => {
    const before = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'invented-token'
    try {
      const seen: (RunOptions | undefined)[] = []
      const run: Runner = async (_file, _args, opts) => {
        seen.push(opts)
        return ok()
      }
      await runClaude(run, { file: 'C:\\x\\claude.cmd', viaCmd: true }, ['mcp', 'get', 'claudeterm'], loginEnv('C:\\acc\\work'))
      expect(seen[0]?.verbatim).toBe(true)
      expect(seen[0]?.env).toBeDefined()
      expect(seen[0]?.env?.CLAUDE_CONFIG_DIR).toBe('C:\\acc\\work')
      expect(seen[0]?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = before
    }
  })

  it('a native exe and a Linux claude get the patch over their environment', async () => {
    const seen: (NodeJS.ProcessEnv | undefined)[] = []
    const run: Runner = async (_file, _args, opts) => {
      seen.push(opts?.env)
      return ok()
    }
    await runClaude(run, { file: '/x/claude', viaCmd: false, env: { PATH: '/x', CLAUDE_CODE_OAUTH_TOKEN: 'invented-token' } }, ['mcp', 'get', 'claudeterm'], loginEnv('/acc/work'))
    expect(seen[0]).toEqual({ PATH: '/x', CLAUDE_CONFIG_DIR: '/acc/work' })
    await runClaude(run, { file: CLAUDE, viaCmd: false }, ['mcp', 'get', 'claudeterm'], loginEnv('C:\\acc\\work'))
    expect(seen[1]?.CLAUDE_CONFIG_DIR).toBe('C:\\acc\\work')
    expect(seen[1]?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })
})

describe('ensureMcpRegistered with an environment or exec', () => {
  it('gives every command the environment of the account', async () => {
    const seen: (RunOptions | undefined)[] = []
    const run: Runner = async (_file, _args, opts) => {
      seen.push(opts)
      return ok()
    }
    const resolve = async () => ({ file: 'C:\\x\\claude.cmd', viaCmd: true })
    expect(await ensureMcpRegistered({ run, execPath: EXE, serverScript: SCRIPT, log: () => {}, resolve, env: loginEnv('C:\\acc\\work') })).toBe('registered')
    expect(seen.length).toBe(3)
    for (const opts of seen) expect(opts?.env?.CLAUDE_CONFIG_DIR).toBe('C:\\acc\\work')
  })

  it('with exec runs every command through it and never looks claude up', async () => {
    const { run, calls } = fakeRunner([])
    const seen: string[][] = []
    const exec = async (args: string[]): Promise<RunResult> => {
      seen.push(args)
      return args[1] === 'get' ? fail('not found') : ok()
    }
    expect(await ensureMcpRegistered({ run, execPath: EXE, serverScript: SCRIPT, log: () => {}, exec })).toBe('registered')
    expect(seen.map((a) => a[1])).toEqual(['get', 'remove', 'add'])
    expect(calls).toEqual([])
  })
})

describe('signInFoldersToRegister', () => {
  it('lists the sign-in accounts whose folder is there: a token account, a folder that is gone and no folder are left out', async () => {
    const present = new Set(['C:\\Users\\me\\accounts\\work', 'C:\\Users\\me\\accounts\\studio'])
    const list = [
      { name: 'Work', kind: 'login', folder: 'C:\\Users\\me\\accounts\\work' },
      { name: 'Token', kind: 'token', folder: null },
      { name: 'Gone', kind: 'login', folder: 'C:\\Users\\me\\accounts\\gone' },
      { name: 'Studio', kind: 'login', folder: 'C:\\Users\\me\\accounts\\studio' },
      { name: 'Unset', kind: 'login', folder: null },
    ]
    expect(await signInFoldersToRegister(list, async (p) => present.has(p))).toEqual([
      { name: 'Work', folder: 'C:\\Users\\me\\accounts\\work' },
      { name: 'Studio', folder: 'C:\\Users\\me\\accounts\\studio' },
    ])
  })
})
