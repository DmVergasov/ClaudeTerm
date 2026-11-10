import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { probeClaudeVersion, readVersionCache, type ProbeRun } from '../../src/main/claude-version'
import { buildProbe } from '../../src/main/profiles'
import type { ProfileDef } from '../../src/shared/types'

// stand-ins for the claude command: a script run by this Node, never the real claude
let dir: string
let dataDir: string
let fake: string
let failing: string

const WIN = process.platform === 'win32'
// the shell a Claude tab runs the command in: PowerShell on Windows, bash elsewhere
const SHELL: ProfileDef = WIN
  ? { name: 'Windows PowerShell', command: join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: [] }
  : { name: 'bash', command: '/bin/bash', args: [] }

/** the command line that runs a file with this Node, as the user would type it in the tab's shell */
function nodeCommand(script: string): string {
  return WIN ? `& "${process.execPath}" "${script}"` : `"${process.execPath}" "${script}"`
}

/** the probe as main runs it; on Unix with a home of the test's own, so the login shell reads no real profile */
function run(command: string, env?: NodeJS.ProcessEnv): ProbeRun {
  return { ...buildProbe(SHELL, command), env: env ?? (WIN ? undefined : { ...process.env, HOME: dir }) }
}

function probe(command: string): Promise<string | null> {
  return probeClaudeVersion(dataDir, command, run(command))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ct-claude-version-'))
  dataDir = join(dir, 'data')
  fake = join(dir, 'fake-claude.js')
  failing = join(dir, 'failing-claude.js')
  writeFileSync(fake, "if (process.argv.includes('--version')) console.log('2.1.400 (Claude Code)')\n")
  writeFileSync(failing, 'process.exit(1)\n')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('probeClaudeVersion', () => {
  it('runs the command with --version and caches the result', async () => {
    const command = nodeCommand(fake)
    expect(await probe(command)).toBe('2.1.400')
    expect(readVersionCache(dataDir)).toEqual({ command, version: '2.1.400' })
  })

  it('a command that fails gives null and caches null', async () => {
    const command = nodeCommand(failing)
    expect(await probe(command)).toBeNull()
    expect(readVersionCache(dataDir)).toEqual({ command, version: null })
  })

  it('a command that exits 0 but prints no version gives null and caches null', async () => {
    const hello = join(dir, 'hello-claude.js')
    writeFileSync(hello, "console.log('hello')\n")
    const command = nodeCommand(hello)
    expect(await probe(command)).toBeNull()
    expect(readVersionCache(dataDir)).toEqual({ command, version: null })
  })

  it('a command that does not exist gives null and never rejects', async () => {
    const command = WIN ? `& "${join(dir, 'no-such-claude.exe')}"` : `"${join(dir, 'no-such-claude')}"`
    await expect(probe(command)).resolves.toBeNull()
    expect(readVersionCache(dataDir)).toEqual({ command, version: null })
  })

  it('a shell that cannot start gives null and never rejects', async () => {
    const command = nodeCommand(fake)
    await expect(probeClaudeVersion(dataDir, command, { file: join(dir, 'no-such-shell'), args: [] })).resolves.toBeNull()
    expect(readVersionCache(dataDir)).toEqual({ command, version: null })
  })
})

describe('probeClaudeVersion reads the command as the tab shell does', () => {
  // the bug: the probe ran the line through cmd.exe, whatever shell the tabs use; cmd took the > inside PowerShell's
  // single quotes for a redirect and wrote a file into the app's folder
  it('a > inside quotes is text, and the command line writes no file', async () => {
    const command = "echo '2.1.400 > x'"
    expect(await probe(command)).toBe('2.1.400')
    expect(readdirSync(dataDir)).toEqual(['claude-version.json'])
    expect(existsSync(join(process.cwd(), 'x'))).toBe(false)
    expect(existsSync(join(process.cwd(), "x'"))).toBe(false)
  })

  it('runs in the data folder: a file the command line writes lands there', async () => {
    // the probe adds --version, which the last echo prints
    const command = WIN ? 'echo 2.1.400 > probe-out.txt; Get-Content probe-out.txt; echo' : 'echo 2.1.400 > probe-out.txt; cat probe-out.txt; echo'
    expect(await probe(command)).toBe('2.1.400')
    expect(existsSync(join(dataDir, 'probe-out.txt'))).toBe(true)
    expect(existsSync(join(process.cwd(), 'probe-out.txt'))).toBe(false)
  })

  // a claude that only the login shell's PATH finds, as one in ~/.local/bin is found by a terminal and not by a GUI app
  it.runIf(!WIN)('finds the command on the PATH the login profile sets', async () => {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const claude = join(bin, 'claude')
    writeFileSync(claude, "#!/bin/sh\necho '2.1.400 (Claude Code)'\n")
    chmodSync(claude, 0o755)
    const env = { ...process.env, HOME: dir, PATH: '/usr/bin:/bin' }

    expect(await probeClaudeVersion(dataDir, 'claude', run('claude', env))).toBeNull()
    writeFileSync(join(dir, '.bash_profile'), `export PATH="${bin}:$PATH"\n`)
    expect(await probeClaudeVersion(dataDir, 'claude', run('claude', env))).toBe('2.1.400')
  })
})

describe('readVersionCache', () => {
  it('is null when no probe has run', () => {
    expect(readVersionCache(dataDir)).toBeNull()
  })

  it('is null when the file is not valid', () => {
    mkdirSync(dataDir)
    writeFileSync(join(dataDir, 'claude-version.json'), '{ not json')
    expect(readVersionCache(dataDir)).toBeNull()
  })

  it('is null when a field has the wrong type', async () => {
    await probe(nodeCommand(fake))
    const file = join(dataDir, 'claude-version.json')
    writeFileSync(file, JSON.stringify({ command: 7, version: '2.1.400' }))
    expect(readVersionCache(dataDir)).toBeNull()
    writeFileSync(file, JSON.stringify({ command: 'claude', version: 2 }))
    expect(readVersionCache(dataDir)).toBeNull()
  })
})
