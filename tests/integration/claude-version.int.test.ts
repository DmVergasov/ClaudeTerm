import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { probeClaudeVersion, readVersionCache } from '../../src/main/claude-version'

// stand-ins for the claude command: a script run by this Node, never the real claude
let dir: string
let dataDir: string
let fake: string
let failing: string

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
    const command = `"${process.execPath}" "${fake}"`
    expect(await probeClaudeVersion(dataDir, command)).toBe('2.1.400')
    expect(readVersionCache(dataDir)).toEqual({ command, version: '2.1.400' })
  })

  it('a command that fails gives null and caches null', async () => {
    const command = `"${process.execPath}" "${failing}"`
    expect(await probeClaudeVersion(dataDir, command)).toBeNull()
    expect(readVersionCache(dataDir)).toEqual({ command, version: null })
  })

  it('a command that exits 0 but prints no version gives null and caches null', async () => {
    const hello = join(dir, 'hello-claude.js')
    writeFileSync(hello, "console.log('hello')\n")
    const command = `"${process.execPath}" "${hello}"`
    expect(await probeClaudeVersion(dataDir, command)).toBeNull()
    expect(readVersionCache(dataDir)).toEqual({ command, version: null })
  })

  it('a command that does not exist gives null and never rejects', async () => {
    const command = `"${join(dir, 'no-such-claude.exe')}"`
    await expect(probeClaudeVersion(dataDir, command)).resolves.toBeNull()
    expect(readVersionCache(dataDir)).toEqual({ command, version: null })
  })
})

describe('probeClaudeVersion with the PATH of a shell', () => {
  // a claude that only a PATH with its folder finds, as one in ~/.local/bin is found by a terminal and not by a GUI app
  it.runIf(process.platform !== 'win32')('finds the command on the PATH it is given, and not on one that misses its folder', async () => {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const claude = join(bin, 'claude')
    writeFileSync(claude, "#!/bin/sh\necho '2.1.400 (Claude Code)'\n")
    chmodSync(claude, 0o755)

    const withFolder = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }
    expect(await probeClaudeVersion(dataDir, 'claude', process.platform, withFolder)).toBe('2.1.400')
    const withoutFolder = { ...process.env, PATH: '/usr/bin:/bin' }
    expect(await probeClaudeVersion(dataDir, 'claude', process.platform, withoutFolder)).toBeNull()
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
    await probeClaudeVersion(dataDir, `"${process.execPath}" "${fake}"`)
    const file = join(dataDir, 'claude-version.json')
    writeFileSync(file, JSON.stringify({ command: 7, version: '2.1.400' }))
    expect(readVersionCache(dataDir)).toBeNull()
    writeFileSync(file, JSON.stringify({ command: 'claude', version: 2 }))
    expect(readVersionCache(dataDir)).toBeNull()
  })
})
