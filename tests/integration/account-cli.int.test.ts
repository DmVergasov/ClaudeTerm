import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CliError, runClaudeCli } from '../../src/main/mcp/claude-cli'
import { resolveChatLaunch, type ChatLaunch } from '../../src/main/chat/claude-spawn'
import { installFakeClaude } from '../fixtures/fake-claude/install'

// runs `claude` through runClaudeCli: the stand-in (tests/fixtures/fake-claude) as the installed command, and plain Node
// processes where the test needs their output

let dir: string
let work: string
let config: string
let log: string
let launch: Exclude<ChatLaunch, { how: 'none' }>
let node: Exclude<ChatLaunch, { how: 'none' }>

// the environment of the test process, without the values Node leaves undefined: a Windows command needs its own PATH
function base(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))
}

function loggedArgv(): string[] {
  const first = readFileSync(log, 'utf8').split('\n')[0]
  return (JSON.parse(first) as { argv: string[] }).argv
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'account-cli-'))
  work = join(dir, 'work')
  config = join(dir, 'config')
  log = join(dir, 'claude.log')
  mkdirSync(work, { recursive: true })
  mkdirSync(config, { recursive: true })
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
  node = { how: 'direct', file: process.execPath }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('runClaudeCli', () => {
  it('runs the command with its arguments, folder and environment', async () => {
    // not a CLI subcommand of the stand-in: it runs its terminal path, which logs its argv and exits 0 when stdin ends
    const run = await runClaudeCli(launch, ['hello', 'world'], {
      cwd: work,
      env: { ...base(), FAKE_CLAUDE_LOG: log, CLAUDE_CONFIG_DIR: config }
    })
    expect(run.code).toBe(0)
    expect(loggedArgv()).toEqual(['hello', 'world'])
  })

  it('a JSON argument with quotes, %, ^, &, spaces and a backslash reaches Claude Code intact', async () => {
    const args = [
      JSON.stringify({ text: 'He said "hi" & \'bye\' 50% ^x! a\\b', list: ['a b', 'c|d;e'] }),
      'a path with spaces\\trail\\'
    ]
    const run = await runClaudeCli(launch, args, {
      cwd: work,
      env: { ...base(), FAKE_CLAUDE_LOG: log, CLAUDE_CONFIG_DIR: config }
    })
    expect(run.code).toBe(0)
    expect(loggedArgv()).toEqual(args)
  })

  it('NO_COLOR is set for the command', async () => {
    const run = await runClaudeCli(node, ['-e', 'process.stdout.write(String(process.env.NO_COLOR))'], { cwd: work, env: base() })
    expect(run.stdout).toBe('1')
  })

  it('the command runs in the given folder with the given environment', async () => {
    const script = 'process.stdout.write(JSON.stringify({ cwd: process.cwd(), config: process.env.CLAUDE_CONFIG_DIR }))'
    const run = await runClaudeCli(node, ['-e', script], { cwd: work, env: { ...base(), CLAUDE_CONFIG_DIR: config } })
    const got = JSON.parse(run.stdout) as { cwd: string; config: string }
    // the folder as the command sees it is the real one (/private/var on macOS for /var)
    expect({ ...got, cwd: realpathSync(got.cwd) }).toEqual({ cwd: realpathSync(work), config })
  })

  it('a command that never ends is killed at its time limit', async () => {
    const started = Date.now()
    const run = runClaudeCli(node, ['-e', 'setInterval(() => {}, 1000)'], { cwd: work, env: base(), timeoutMs: 1500 })
    await expect(run).rejects.toMatchObject({ reason: 'timeout' })
    await expect(run).rejects.toBeInstanceOf(CliError)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('stdout past the cap ends the command', async () => {
    const run = runClaudeCli(node, ['-e', 'process.stdout.write("x".repeat(5e6))'], { cwd: work, env: base(), maxStdout: 1 << 20 })
    await expect(run).rejects.toMatchObject({ reason: 'too-large' })
  })

  it('a file that cannot start fails', async () => {
    const run = runClaudeCli({ how: 'direct', file: join(dir, 'missing-claude') }, [], { cwd: work, env: base() })
    await expect(run).rejects.toMatchObject({ reason: 'failed' })
  })
})
