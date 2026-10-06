import { describe, expect, it } from 'vitest'
import { folderName, windowsPtyOption } from '../../src/renderer/util'

describe('windowsPtyOption', () => {
  it('ConPTY handling on Windows only', () => {
    expect(windowsPtyOption(22631)).toEqual({ windowsPty: { backend: 'conpty', buildNumber: 22631 } })
    expect(windowsPtyOption(null)).toEqual({})
  })
})

describe('folderName', () => {
  it('returns the last path segment', () => {
    expect(folderName('D:\\Workspace\\LocHub')).toBe('LocHub')
    expect(folderName('C:\\Users\\me\\')).toBe('me')
    expect(folderName('D:\\')).toBe('D:')
  })
})
