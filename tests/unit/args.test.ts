import { describe, expect, it } from 'vitest'
import { normalizeDirArg, parseArgs, resolveLaunchDir } from '../../src/main/args'

const EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\ClaudeTerm\\ClaudeTerm.exe'

describe('parseArgs', () => {
  it('no flags → default', () => {
    expect(parseArgs([EXE])).toEqual({ kind: 'default' })
  })

  it('--claude with a path containing spaces', () => {
    expect(parseArgs([EXE, '--claude', 'D:\\My Projects\\game'])).toEqual({ kind: 'claude', dir: 'D:\\My Projects\\game' })
  })

  it('--shell with and without --profile', () => {
    expect(parseArgs([EXE, '--shell', 'D:\\x'])).toEqual({ kind: 'shell', dir: 'D:\\x', profile: null })
    expect(parseArgs([EXE, '--shell', 'D:\\x', '--profile', 'Git Bash'])).toEqual({ kind: 'shell', dir: 'D:\\x', profile: 'Git Bash' })
  })

  it('ignores chromium/electron flags and a dev app path', () => {
    expect(parseArgs(['electron.exe', '.', '--allow-file-access-from-files', '--claude', 'D:\\x'])).toEqual({ kind: 'claude', dir: 'D:\\x' })
  })

  it('a flag without a value is ignored', () => {
    expect(parseArgs([EXE, '--claude'])).toEqual({ kind: 'default' })
    expect(parseArgs([EXE, '--claude', '--shell', 'D:\\x'])).toEqual({ kind: 'shell', dir: 'D:\\x', profile: null })
  })

  it('Explorer drive root: %V = D:\\ arrives as D:" and is repaired', () => {
    expect(parseArgs([EXE, '--claude', 'D:"'])).toEqual({ kind: 'claude', dir: 'D:\\' })
  })
})

describe('normalizeDirArg', () => {
  it('trims quotes and whitespace and completes a bare drive', () => {
    expect(normalizeDirArg(' D:\\x" ')).toBe('D:\\x')
    expect(normalizeDirArg('C:')).toBe('C:\\')
  })
})

describe('resolveLaunchDir', () => {
  it('uses the directory when it exists', () => {
    expect(resolveLaunchDir('D:\\x', 'C:\\Users\\me', () => true)).toEqual({ cwd: 'D:\\x', warning: null })
  })

  it('falls back to home with a warning', () => {
    const r = resolveLaunchDir('D:\\gone', 'C:\\Users\\me', () => false)
    expect(r.cwd).toBe('C:\\Users\\me')
    expect(r.warning).toContain('D:\\gone')
  })
})
