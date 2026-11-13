import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveChatLaunch, type ChatLaunch } from '../../src/main/chat/claude-spawn'
import { CliError, LOGIN_TIMEOUT_MS, runClaudeCli } from '../../src/main/mcp/claude-cli'
import { installFakeClaude, type FakeScript } from '../fixtures/fake-claude/install'

// Claude Code's CLI through the stand-in (tests/fixtures/fake-claude): the stand-in logs each start and each CLI call
// in FAKE_CLAUDE_LOG, and keeps its configuration in CLAUDE_CONFIG_DIR, both in temp folders of this run

type Entry = Record<string, any>

let dir: string
let work: string
let config: string
let log = ''
let logs = 0
let launch: Exclude<ChatLaunch, { how: 'none' }>
let scripts = 0

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claude-cli-'))
  work = join(dir, 'work folder')
  config = join(dir, 'config')
  mkdirSync(work)
  const command = installFakeClaude(join(dir, 'bin'))
  const resolved = await resolveChatLaunch(command, {
    platform: process.platform,
    isFile: p => existsSync(p),
    isExecutable: p => existsSync(p),
    where: async () => [],
    loginShell: () => '/bin/sh'
  })
  if (resolved.how === 'none') throw new Error(resolved.reason)
  launch = resolved
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** the tab's environment as the tests give it: the stand-in's three variables point at temp folders; each call has a log of its own */
function env(script?: FakeScript): Record<string, string> {
  log = join(dir, `fake-claude-${++logs}.log`)
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('FAKE_CLAUDE_') && !key.startsWith('CLAUDE')) result[key] = value
  result.CLAUDE_CONFIG_DIR = config
  result.FAKE_CLAUDE_LOG = log
  if (script !== undefined) {
    const file = join(dir, `script-${++scripts}.json`)
    writeFileSync(file, JSON.stringify(script))
    result.FAKE_CLAUDE_SCRIPT = file
  }
  return result
}

/** every line the stand-in logged so far */
function logged(): Entry[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Entry)
}

/** the entry of the stand-in's start: its arguments and its process id */
function started(): Entry | undefined {
  return logged().find(entry => 'argv' in entry)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function until(test: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

describe('runClaudeCli', () => {
  it('runs the command with its arguments, folder and environment', async () => {
    const json = JSON.stringify({ type: 'stdio', command: 'fake-mcp', args: ['serve'] })
    const run = await runClaudeCli(launch, ['mcp', 'add-json', '--scope', 'local', '--', 'docs', json], { cwd: work, env: env() })
    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Added stdio MCP server docs to local config')
    // the stand-in wrote the server under the folder it was started in (its cwd) and the config folder it was given
    const file = JSON.parse(readFileSync(join(config, '.claude.json'), 'utf8')) as Entry
    expect(file.projects[realpathSync.native(work)].mcpServers.docs).toEqual({ type: 'stdio', command: 'fake-mcp', args: ['serve'] })
  })

  it('a JSON argument with quotes, %, ^, &, spaces and a backslash reaches Claude Code intact', async () => {
    const entry = {
      type: 'stdio',
      command: 'C:\\tools\\say "hi" %PATH% ^& x',
      args: ['a b', 'x&y|z', "it's", '(paren)', '!bang!', 'trail\\'],
      env: { TOKEN: 'a"b c%d' }
    }
    const json = JSON.stringify(entry)
    const args = ['mcp', 'add-json', '--scope', 'user', '--', 'quoted', json]
    const run = await runClaudeCli(launch, args, { cwd: work, env: env() })
    expect(run.code).toBe(0)
    expect(started()?.argv).toEqual(args)
    const file = JSON.parse(readFileSync(join(config, '.claude.json'), 'utf8')) as Entry
    expect(file.mcpServers.quoted).toEqual(entry)
  })

  it('stdin carries the values', async () => {
    const script: FakeScript = {
      turns: {},
      marketplaces: [{ name: 'acme-tools', source: 'acme/tools', plugins: [{ name: 'docs', description: 'Docs', version: '1.0.0', options: [{ key: 'token', title: 'Token', required: true, sensitive: true }] }] }]
    }
    const e = env(script)
    expect((await runClaudeCli(launch, ['plugin', 'marketplace', 'add', '--', 'acme/tools'], { cwd: work, env: e })).code).toBe(0)
    const run = await runClaudeCli(launch, ['plugin', 'configure', '--values-stdin', '--', 'docs@acme-tools'], {
      cwd: work,
      env: e,
      stdin: JSON.stringify({ token: 's3cret-value', region: 'eu' })
    })
    expect(run.code).toBe(0)
    // the stand-in logs the keys it was given, never their values
    const call = logged().find(entry => Array.isArray(entry.cli) && entry.cli.includes('configure'))
    expect(call?.stdinKeys).toEqual(['token', 'region'])
    expect(readFileSync(log, 'utf8')).not.toContain('s3cret-value')
  })

  it('a command that never ends is killed at its time limit', async () => {
    const script: FakeScript = { turns: {}, mcpLogin: { docs: { gate: 'never-written' } } }
    const begun = Date.now()
    const error = await runClaudeCli(launch, ['mcp', 'login', '--', 'docs'], { cwd: work, env: env(script), timeoutMs: 1500 }).catch((e: unknown) => e)
    expect(Date.now() - begun).toBeLessThan(5000)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).reason).toBe('timeout')
    expect((error as CliError).message).toBe('Claude Code did not answer in 1.5 s')
    // the stand-in may not have logged its start before the limit fired: if it did, its process must be gone; if it did not,
    // it must not start late either (an orphan no kill reached)
    const pid = started()?.pid as number | undefined
    if (pid !== undefined) {
      await until(() => !alive(pid), 'the stand-in to end', 3000)
    } else {
      await new Promise(resolve => setTimeout(resolve, 2000))
      expect(started()).toBeUndefined()
    }
  })

  it('an abort ends the command', async () => {
    const script: FakeScript = { turns: {}, mcpLogin: { docs: { gate: 'never-written' } } }
    const controller = new AbortController()
    const pending = runClaudeCli(launch, ['mcp', 'login', '--', 'docs'], { cwd: work, env: env(script), timeoutMs: LOGIN_TIMEOUT_MS, signal: controller.signal })
    await until(() => started() !== undefined, 'the stand-in start')
    controller.abort()
    const error = await pending.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).reason).toBe('cancelled')
    expect((error as CliError).message).toBe('Cancelled')
    const pid = started()?.pid as number
    await until(() => !alive(pid), 'the stand-in to end')
  })

  it('stdout past the cap ends the command', async () => {
    const error = await runClaudeCli({ how: 'direct', file: process.execPath }, ['-e', 'process.stdout.write("x".repeat(5e6))'], {
      cwd: work,
      env: env(),
      maxStdout: 1 << 20
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).reason).toBe('too-large')
    expect((error as CliError).message).toBe("Claude Code's answer is too large")
  })

  it('a failing command resolves with its exit code and its stderr', async () => {
    const script: FakeScript = { turns: {}, mcpLogin: { docs: { fail: 'Login refused' } } }
    const run = await runClaudeCli(launch, ['mcp', 'login', '--', 'docs'], { cwd: work, env: env(script) })
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('Login refused')
  })

  it('the command runs with NO_COLOR=1 set', async () => {
    const run = await runClaudeCli({ how: 'direct', file: process.execPath }, ['-e', 'process.stdout.write(String(process.env.NO_COLOR))'], { cwd: work, env: env() })
    expect(run.stdout).toBe('1')
  })

  it('a command that cannot start rejects with failed', async () => {
    const error = await runClaudeCli({ how: 'direct', file: join(dir, 'missing', 'claude') }, ['mcp'], { cwd: work, env: env() }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).reason).toBe('failed')
  })
})
