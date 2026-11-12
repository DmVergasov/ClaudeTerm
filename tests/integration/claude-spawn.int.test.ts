import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, accessSync, chmodSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { quoteForPosixShell, resolveChatLaunch, spawnChatProcess, type ChatLaunchDeps } from '../../src/main/chat/claude-spawn'
import { loginShell } from '../../src/main/profiles'

// the program: prints its arguments as JSON and records them in spawn-args.json in its folder
const PROGRAM = [
  "const { writeFileSync } = require('node:fs')",
  "const args = JSON.stringify(process.argv.slice(2))",
  "writeFileSync('spawn-args.json', args)",
  'process.stdout.write(args)'
].join('\n')

// the arguments the program must receive unchanged
const ARGS = ['plain', 'with space', 'quote"inside', '{"json":["a b"]}', '%PATH%', 'a^b&c|d', '', 'a<b>c', '(x)', '!bang!', 'trail\\', 'a;b,c']

let dir: string
let program: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-spawn-'))
  program = join(dir, 'program.cjs')
  writeFileSync(program, PROGRAM)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** the real file system and platform, for resolveChatLaunch */
const realDeps: ChatLaunchDeps = {
  platform: process.platform,
  isFile: (p) => existsSync(p) && statSync(p).isFile(),
  isExecutable: (p) => {
    try {
      accessSync(p, constants.X_OK)
      return true
    } catch {
      return false
    }
  },
  where: async () => [],
  loginShell
}

/** runs the child to its end: its exit code and what it wrote to stdout */
function run(child: ChildProcess): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    let out = ''
    child.stdout?.setEncoding('utf8').on('data', (d: string) => (out += d))
    child.on('error', (e) => {
      child.kill()
      reject(e)
    })
    child.on('close', (code) => resolve({ code, out }))
  })
}

describe('spawnChatProcess with a direct executable', () => {
  it('passes every argument to the program unchanged', async () => {
    const launch = await resolveChatLaunch(process.execPath, realDeps)
    expect(launch.how).toBe('direct')
    const child = spawnChatProcess(launch as Exclude<typeof launch, { how: 'none' }>, [program, ...ARGS], dir, process.env)
    const { code, out } = await run(child)
    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual(ARGS)
    expect(JSON.parse(readFileSync(join(dir, 'spawn-args.json'), 'utf8'))).toEqual(ARGS)
  })
})

describe.runIf(process.platform === 'win32')('spawnChatProcess with a .cmd shim on Windows', () => {
  it('passes every argument through cmd.exe unchanged', async () => {
    // a shim in a folder with a space, as the npm and installer shims are written
    const shimDir = join(dir, 'shim dir')
    mkdirSync(shimDir)
    const shim = join(shimDir, 'claude.cmd')
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" %*\r\n`)

    const launch = await resolveChatLaunch(shim, realDeps)
    expect(launch).toEqual({ how: 'cmd', file: shim })
    const child = spawnChatProcess(launch as Exclude<typeof launch, { how: 'none' }>, [program, ...ARGS], dir, process.env)
    const { code, out } = await run(child)
    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual(ARGS)
    expect(JSON.parse(readFileSync(join(dir, 'spawn-args.json'), 'utf8'))).toEqual(ARGS)
  })
})

describe.runIf(process.platform !== 'win32')('spawnChatProcess through the login shell', () => {
  it('runs node by its bare name and passes every argument unchanged', async () => {
    // node is found through PATH, the way a user's `claude` command would be
    const env = { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}` }
    const child = spawnChatProcess({ how: 'shell', shell: '/bin/sh', command: 'node' }, [program, ...ARGS], dir, env)
    const { code, out } = await run(child)
    expect(code).toBe(0)
    expect(JSON.parse(out)).toEqual(ARGS)
    expect(JSON.parse(readFileSync(join(dir, 'spawn-args.json'), 'utf8'))).toEqual(ARGS)
  })
})

describe.runIf(process.platform !== 'win32')('spawnChatProcess through an interactive login shell', () => {
  const bash = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p))
  const zsh = ['/bin/zsh', '/usr/bin/zsh'].find((p) => existsSync(p))

  /**
   * A temp home whose only `claude` is put on PATH by its rc file. The login profile reads that file only in an
   * interactive shell, as many do (`[[ $- == *i* ]] && . ~/.bashrc`), so a shell that is not interactive cannot find it.
   * The environment has a PATH without the claude folder: it is what a login shell gets from the app.
   */
  function rcHome(profile: string, guard: string, rc: string): { home: string; ran: string; env: Record<string, string> } {
    const home = mkdtempSync(join(tmpdir(), 'claude-home-'))
    const bin = join(home, 'tools', 'bin')
    mkdirSync(bin, { recursive: true })
    const ran = join(home, 'ran.txt')
    const claude = join(bin, 'claude')
    writeFileSync(claude, `#!/bin/sh\nprintf 'claude ran: %s\\n' "$*" > ${quoteForPosixShell(ran)}\n`)
    chmodSync(claude, 0o755)
    writeFileSync(join(home, rc), `PATH=${quoteForPosixShell(bin)}:$PATH\nexport PATH\n`)
    writeFileSync(join(home, profile), `${guard} . "${join(home, rc)}"\n`)
    return { home, ran, env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } }
  }

  it.runIf(bash !== undefined)('the chat finds claude where only the interactive rc file puts it', async () => {
    const { home, ran, env } = rcHome('.bash_profile', '[[ $- == *i* ]] &&', '.bashrc')
    try {
      const launch = await resolveChatLaunch('claude', { ...realDeps, loginShell: () => bash ?? null })
      expect(launch).toEqual({ how: 'shell', shell: bash, command: 'claude' })
      const { code } = await run(spawnChatProcess(launch as Exclude<typeof launch, { how: 'none' }>, ['--marker', 'x y'], home, env))
      expect(code).toBe(0)
      expect(readFileSync(ran, 'utf8')).toBe('claude ran: --marker x y\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.runIf(zsh !== undefined)('the chat finds claude where only the interactive rc file puts it', async () => {
    const { home, ran, env } = rcHome('.zprofile', '[[ -o interactive ]] &&', '.zshrc')
    try {
      const launch = await resolveChatLaunch('claude', { ...realDeps, loginShell: () => zsh ?? null })
      expect(launch).toEqual({ how: 'shell', shell: zsh, command: 'claude' })
      const { code } = await run(spawnChatProcess(launch as Exclude<typeof launch, { how: 'none' }>, ['--marker', 'x y'], home, env))
      expect(code).toBe(0)
      expect(readFileSync(ran, 'utf8')).toBe('claude ran: --marker x y\n')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
