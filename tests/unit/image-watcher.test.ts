import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isRootGoneEvent, sessionTempDir, shouldWatchDir, watchedImagePath } from '../../src/main/image-watcher'

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

describe('watchedImagePath', () => {
  const root = join(tmpdir(), 'proj')

  it('maps an image file name from the watcher to its full path', () => {
    expect(watchedImagePath(root, join('out', 'plot.png'), cfg)).toBe(join(root, 'out', 'plot.png'))
    expect(watchedImagePath(root, 'shot.PNG', cfg)).toBe(join(root, 'shot.PNG'))
  })

  it('skips listed folders case-insensitively at any depth', () => {
    expect(watchedImagePath(root, join('node_modules', 'x.png'), cfg)).toBeNull()
    expect(watchedImagePath(root, join('Plugins', 'X', 'intermediate', 'a.png'), cfg)).toBeNull()
    expect(watchedImagePath(root, join('.git', 'x.png'), cfg)).toBeNull()
  })

  it('skips other file types and events without a file name', () => {
    expect(watchedImagePath(root, 'notes.txt', cfg)).toBeNull()
    expect(watchedImagePath(root, 'out', cfg)).toBeNull()
    expect(watchedImagePath(root, null, cfg)).toBeNull()
  })

  it('skips files below maxDepth folders', () => {
    const shallow = { ...cfg, maxDepth: 2 }
    expect(watchedImagePath(root, join('a', 'b', 'c.png'), shallow)).toBe(join(root, 'a', 'b', 'c.png'))
    expect(watchedImagePath(root, join('a', 'b', 'c', 'd.png'), shallow)).toBeNull()
  })
})

describe('isRootGoneEvent', () => {
  it('an absolute path from a recursive watcher means the watched folder itself was deleted', () => {
    expect(isRootGoneEvent('\\\\?\\D:\\proj')).toBe(true)
    expect(isRootGoneEvent(join(tmpdir(), 'proj'))).toBe(true)
    expect(isRootGoneEvent(join('out', 'a.png'))).toBe(false)
    expect(isRootGoneEvent(null)).toBe(false)
  })
})

describe('sessionTempDir', () => {
  it('mirrors Claude Code temp layout: %TEMP%\\claude\\<project key>\\<session id>', () => {
    expect(sessionTempDir('C:\\Users\\me\\.claude\\projects\\D--Workspace\\5d2c.jsonl', '5d2c', 'C:\\Users\\me\\AppData\\Local\\Temp'))
      .toBe('C:\\Users\\me\\AppData\\Local\\Temp\\claude\\D--Workspace\\5d2c')
  })
})
