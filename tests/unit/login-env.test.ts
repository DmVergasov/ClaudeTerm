import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findExecutable, isExecutableFile, loginShellPath, parseMarkedPath } from '../../src/main/login-env'
import type { Runner } from '../../src/main/mcp-registrar'
import { WIN } from '../fixtures/platform'

describe('parseMarkedPath', () => {
  it('takes the PATH between the markers, whatever the startup files print around it', () => {
    expect(parseMarkedPath('Welcome!\n__CLAUDETERM_PATH__/a:/b__CLAUDETERM_PATH__\nbye')).toBe('/a:/b')
    expect(parseMarkedPath('no markers here')).toBeNull()
    expect(parseMarkedPath('__CLAUDETERM_PATH____CLAUDETERM_PATH__')).toBeNull()
  })
})

describe('loginShellPath', () => {
  it('asks bash and zsh as interactive login shells, fish as a login shell, within 10 s, away from any terminal', async () => {
    const calls: [string, string[], number | undefined, boolean | undefined][] = []
    const run: Runner = async (file, args, opts) => {
      calls.push([file, args.slice(0, -1), opts?.timeoutMs, opts?.detached])
      return { code: 0, stdout: '__CLAUDETERM_PATH__/p__CLAUDETERM_PATH__', stderr: '' }
    }
    expect(await loginShellPath(run, '/usr/bin/zsh')).toBe('/p')
    await loginShellPath(run, '/usr/bin/fish')
    expect(calls).toEqual([['/usr/bin/zsh', ['-l', '-i', '-c'], 10_000, true], ['/usr/bin/fish', ['-l', '-c'], 10_000, true]])
  })
})

describe('findExecutable', () => {
  it('returns the first executable of that name on the PATH, skipping empty and relative entries', () => {
    const ok = new Set(['/b/claude', '/c/claude'])
    expect(findExecutable('claude', ':rel:/a:/b:/c', (p) => ok.has(p))).toBe('/b/claude')
    expect(findExecutable('claude', '/a', (p) => ok.has(p))).toBeNull()
  })
})

describe.runIf(!WIN)('isExecutableFile', () => {
  it('needs a file with the execute bit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-exe-'))
    const f = join(dir, 'claude')
    writeFileSync(f, '#!/bin/sh\n')
    chmodSync(f, 0o644)
    expect(isExecutableFile(f)).toBe(false)
    chmodSync(f, 0o755)
    expect(isExecutableFile(f)).toBe(true)
    mkdirSync(join(dir, 'sub'))
    expect(isExecutableFile(join(dir, 'sub'))).toBe(false)
    expect(isExecutableFile(join(dir, 'missing'))).toBe(false)
  })
})
