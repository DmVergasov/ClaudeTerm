import { describe, expect, it } from 'vitest'
import { claudeTitle, clockOf, folderName, windowsPtyOption } from '../../src/renderer/util'

describe('windowsPtyOption', () => {
  it('ConPTY handling on Windows only', () => {
    expect(windowsPtyOption(22631)).toEqual({ windowsPty: { backend: 'conpty', buildNumber: 22631 } })
    expect(windowsPtyOption(null)).toEqual({})
  })
})

describe('clockOf', () => {
  it('is the local clock time as HH:MM, zero-padded', () => {
    expect(clockOf(new Date(2026, 10, 14, 9, 5).getTime())).toBe('09:05')
  })
})

describe('folderName', () => {
  it('returns the last path segment', () => {
    expect(folderName('D:\\Workspace\\LocHub')).toBe('LocHub')
    expect(folderName('C:\\Users\\me\\')).toBe('me')
    expect(folderName('D:\\')).toBe('D:')
  })
})

describe('claudeTitle', () => {
  it('drops the mark Claude Code puts before its title: ✳ while idle, ◐ and ◑ while it works', () => {
    expect(claudeTitle('✳ Revenue CSV export')).toBe('Revenue CSV export')
    expect(claudeTitle('◐ Revenue CSV export')).toBe('Revenue CSV export')
    expect(claudeTitle('◑ Revenue CSV export')).toBe('Revenue CSV export')
  })

  it('keeps a title without the mark, and a mark that is the whole title or part of a word', () => {
    // /rename gives a title without the mark
    expect(claudeTitle('Revenue CSV export')).toBe('Revenue CSV export')
    expect(claudeTitle('✳')).toBe('✳')
    expect(claudeTitle('✳Revenue')).toBe('✳Revenue')
    expect(claudeTitle('Fix ✳ parser')).toBe('Fix ✳ parser')
  })
})
