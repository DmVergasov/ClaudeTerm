import { describe, expect, it } from 'vitest'
import { folderName } from '../../src/renderer/util'

describe('folderName', () => {
  it('returns the last path segment', () => {
    expect(folderName('D:\\Workspace\\LocHub')).toBe('LocHub')
    expect(folderName('C:\\Users\\me\\')).toBe('me')
    expect(folderName('D:\\')).toBe('D:')
  })
})
