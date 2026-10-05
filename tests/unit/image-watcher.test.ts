import type { Stats } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { makeIgnored, sessionTempDir, shouldWatchDir } from '../../src/main/image-watcher'

const file = { isFile: () => true } as Stats
const dir = { isFile: () => false } as Stats
const cfg = { extensions: ['png', 'jpg'], ignore: ['.git', 'node_modules', 'Intermediate'], maxDepth: 8 }

describe('shouldWatchDir', () => {
  it('refuses drive roots and the home folder', () => {
    expect(shouldWatchDir('D:\\', 'C:\\Users\\me')).toBe(false)
    expect(shouldWatchDir('D:', 'C:\\Users\\me')).toBe(false)
    expect(shouldWatchDir('C:\\Users\\me', 'C:\\Users\\me')).toBe(false)
    expect(shouldWatchDir('c:\\users\\ME\\', 'C:\\Users\\me')).toBe(false)
  })

  it('accepts project folders', () => {
    expect(shouldWatchDir('D:\\Workspace\\LocHub', 'C:\\Users\\me')).toBe(true)
    expect(shouldWatchDir('C:\\Users\\me\\proj', 'C:\\Users\\me')).toBe(true)
  })
})

describe('makeIgnored', () => {
  const ignored = makeIgnored('D:\\proj', cfg)

  it('never ignores the root', () => {
    expect(ignored('D:\\proj', dir)).toBe(false)
  })

  it('ignores listed segments case-insensitively at any depth', () => {
    expect(ignored('D:\\proj\\node_modules', dir)).toBe(true)
    expect(ignored('D:\\proj\\Plugins\\X\\intermediate\\a.png', file)).toBe(true)
    expect(ignored('D:\\proj\\.git\\x', undefined)).toBe(true)
  })

  it('ignores non-image files only when stats say it is a file', () => {
    expect(ignored('D:\\proj\\notes.txt', file)).toBe(true)
    expect(ignored('D:\\proj\\shot.PNG', file)).toBe(false)
    expect(ignored('D:\\proj\\folder.v2', dir)).toBe(false)
    expect(ignored('D:\\proj\\notes.txt', undefined)).toBe(false)
  })
})

describe('sessionTempDir', () => {
  it('mirrors Claude Code temp layout: %TEMP%\\claude\\<project key>\\<session id>', () => {
    expect(sessionTempDir('C:\\Users\\me\\.claude\\projects\\D--Workspace\\5d2c.jsonl', '5d2c', 'C:\\Users\\me\\AppData\\Local\\Temp'))
      .toBe('C:\\Users\\me\\AppData\\Local\\Temp\\claude\\D--Workspace\\5d2c')
  })
})
