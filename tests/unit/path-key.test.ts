import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isWindowsPath, isWithin, pathKey } from '../../src/main/path-key'

describe('pathKey', () => {
  it('Windows paths compare without case and separator style', () => {
    expect(pathKey('D:\\Proj\\Plot.PNG', win32)).toBe(pathKey('d:/proj/plot.png', win32))
  })

  it('Linux paths keep their case and are normalized', () => {
    expect(pathKey('/proj/Plot.png', posix)).not.toBe(pathKey('/proj/plot.png', posix))
    expect(pathKey('/proj//out/../plot.png', posix)).toBe('/proj/plot.png')
  })
})

describe('isWithin', () => {
  it('a path is inside its folder or is the folder, compared like pathKey', () => {
    expect(isWithin('C:\\a', 'c:/A/b.md', win32)).toBe(true)
    expect(isWithin('C:\\a', 'C:\\ab\\x', win32)).toBe(false)
    expect(isWithin('/a', '/a', posix)).toBe(true)
    expect(isWithin('/a', '/A/x', posix)).toBe(false)
  })
})

describe('isWindowsPath', () => {
  it('drive and UNC paths, not Linux ones', () => {
    expect(isWindowsPath('C:\\a')).toBe(true)
    expect(isWindowsPath('c:/a')).toBe(true)
    expect(isWindowsPath('\\\\server\\share\\a')).toBe(true)
    expect(isWindowsPath('/home/a\\b')).toBe(false)
  })
})
