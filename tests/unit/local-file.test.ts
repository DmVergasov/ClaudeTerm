import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32, type PlatformPath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { fileInside, filePathOf, tabFolderFor } from '../../src/main/browser/local-file'
import { pathKey } from '../../src/main/path-key'

/**
 * A disk for realpath: `existing` paths are real; `links` maps a directory to the directory it leads to, so a path under the link
 * resolves there. A path that is neither throws, as realpath does for a path that does not exist. Paths compare as pathKey does.
 */
function fakeDisk(existing: string[], links: Record<string, string>, path: PlatformPath): (p: string) => string {
  const keyed = existing.map((e) => pathKey(e, path))
  return (p: string): string => {
    const norm = path.normalize(p)
    const key = pathKey(norm, path)
    for (const link of Object.keys(links)) {
      const linkKey = pathKey(link, path)
      if (key === linkKey) return links[link]
      if (key.startsWith(linkKey + path.sep)) return path.join(links[link], norm.slice(path.normalize(link).length + 1))
    }
    if (keyed.includes(key)) return norm
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
  }
}

describe('fileInside (Windows paths)', () => {
  const folder = 'C:\\Work\\proj'
  const real = fakeDisk(['C:\\Work\\proj', 'C:\\Work\\proj\\page.html', 'C:\\Work\\proj\\sub', 'C:\\Work\\proj\\sub\\deep.html', 'C:\\Work\\other.html'], {}, win32)

  it('a file in the folder, or in a folder under it, is inside, with \\ or /', () => {
    expect(fileInside('C:\\Work\\proj\\page.html', folder, real, win32)).toBe(true)
    expect(fileInside('C:\\Work\\proj\\sub\\deep.html', folder, real, win32)).toBe(true)
    expect(fileInside('C:/Work/proj/sub/deep.html', folder, real, win32)).toBe(true)
    expect(fileInside('C:\\Work\\proj/page.html', folder, real, win32)).toBe(true)
  })

  it('compares case-insensitively', () => {
    expect(fileInside('c:\\work\\PROJ\\Page.html', folder, real, win32)).toBe(true)
  })

  it('a neighbour folder with the same start, and a file outside, are outside', () => {
    expect(fileInside('C:\\Work\\proj2\\x.html', folder, real, win32)).toBe(false)
    expect(fileInside('C:\\Work\\other.html', folder, real, win32)).toBe(false)
  })

  it('a .. segment that leaves the folder is outside', () => {
    expect(fileInside('C:\\Work\\proj\\..\\other.html', folder, real, win32)).toBe(false)
    expect(fileInside('C:\\Work\\proj\\sub\\..\\page.html', folder, real, win32)).toBe(true)
  })

  it('an 8.3 short name is compared as the long name it stands for', () => {
    const shortReal = fakeDisk(['C:\\Users\\runneradmin\\Work\\page.html', 'C:\\Users\\runneradmin\\Work'], { 'C:\\Users\\RUNNER~1': 'C:\\Users\\runneradmin' }, win32)
    expect(fileInside('C:\\Users\\RUNNER~1\\Work\\page.html', 'C:\\Users\\RUNNER~1\\Work', shortReal, win32)).toBe(true)
    expect(fileInside('C:\\Users\\runneradmin\\Work\\page.html', 'C:\\Users\\RUNNER~1\\Work', shortReal, win32)).toBe(true)
  })

  it('a link inside the folder that leads outside makes its files outside, also a file that does not exist yet', () => {
    const linked = fakeDisk(['C:\\Work\\proj', 'D:\\Elsewhere', 'D:\\Elsewhere\\secret.html'], { 'C:\\Work\\proj\\out': 'D:\\Elsewhere' }, win32)
    expect(fileInside('C:\\Work\\proj\\out\\secret.html', folder, linked, win32)).toBe(false)
    expect(fileInside('C:\\Work\\proj\\out\\new.html', folder, linked, win32)).toBe(false)
  })

  it('a folder that does not exist has no file inside it', () => {
    const none = fakeDisk([], {}, win32)
    expect(fileInside('C:\\Work\\proj\\page.html', folder, none, win32)).toBe(false)
  })
})

describe('fileInside (POSIX paths)', () => {
  const folder = '/work/proj'
  const real = fakeDisk(['/work/proj', '/work/proj/page.html', '/work/proj/sub', '/work/proj/sub/deep.html', '/work/proj2/x.html'], { '/work/link': '/elsewhere' }, posix)

  it('a file in the folder is inside; a neighbour folder and a .. segment out of it are outside', () => {
    expect(fileInside('/work/proj/page.html', folder, real, posix)).toBe(true)
    expect(fileInside('/work/proj/sub/deep.html', folder, real, posix)).toBe(true)
    expect(fileInside('/work/proj2/x.html', folder, real, posix)).toBe(false)
    expect(fileInside('/work/proj/../proj2/x.html', folder, real, posix)).toBe(false)
  })

  it('compares case-sensitively', () => {
    expect(fileInside('/work/PROJ/page.html', folder, real, posix)).toBe(false)
  })

  it('a symlink inside the folder that leads outside makes its files outside', () => {
    const linked = fakeDisk(['/work/proj', '/elsewhere/secret.html'], { '/work/proj/out': '/elsewhere' }, posix)
    expect(fileInside('/work/proj/out/secret.html', folder, linked, posix)).toBe(false)
  })
})

describe('filePathOf', () => {
  it('is the OS path of a file URL, with the escapes decoded', () => {
    const file = join(tmpdir(), 'My Folder', 'a.html')
    expect(filePathOf(pathToFileURL(file).href)).toBe(file)
  })

  it('is null for text that is no file URL', () => {
    expect(filePathOf('http://localhost:3000/')).toBeNull()
    expect(filePathOf('not a url')).toBeNull()
  })
})

describe('tabFolderFor: a folder whose files are free', () => {
  it('is the tab folder, but none when it is the home folder or a filesystem root', () => {
    const real = fakeDisk(['C:\\Users\\me', 'C:\\Users\\me\\proj', 'D:\\'], {}, win32)
    expect(tabFolderFor('C:\\Users\\me\\proj', 'C:\\Users\\me', real, win32)).toBe('C:\\Users\\me\\proj')
    expect(tabFolderFor('C:\\Users\\me', 'C:\\Users\\me', real, win32)).toBeNull()
    expect(tabFolderFor('D:\\', 'C:\\Users\\me', real, win32)).toBeNull()
    expect(tabFolderFor(null, 'C:\\Users\\me', real, win32)).toBeNull()
  })

  it('compares the home folder by its real path and without case, on Windows', () => {
    const real = fakeDisk(['C:\\Users\\runneradmin', 'C:\\Users\\runneradmin\\proj'], { 'C:\\Users\\RUNNER~1': 'C:\\Users\\runneradmin' }, win32)
    expect(tabFolderFor('c:\\users\\runneradmin', 'C:\\Users\\RUNNER~1', real, win32)).toBeNull()
    expect(tabFolderFor('C:\\Users\\RUNNER~1\\proj', 'C:\\Users\\runneradmin', real, win32)).toBe('C:\\Users\\runneradmin\\proj')
  })

  it('is none for a POSIX root and for the home folder, and none for a folder that does not exist', () => {
    const real = fakeDisk(['/', '/home/me', '/home/me/proj'], {}, posix)
    expect(tabFolderFor('/', '/home/me', real, posix)).toBeNull()
    expect(tabFolderFor('/home/me', '/home/me', real, posix)).toBeNull()
    expect(tabFolderFor('/home/me/proj', '/home/me', real, posix)).toBe('/home/me/proj')
    expect(tabFolderFor('/home/me/missing', '/home/me', real, posix)).toBeNull()
  })
})

describe('fileInside on the disk', () => {
  let root: string | null = null

  afterEach(() => {
    if (root !== null) rmSync(root, { recursive: true, force: true })
    root = null
  })

  it('a junction or symlink out of the folder makes its files outside, and a real file inside is inside', () => {
    root = mkdtempSync(join(tmpdir(), 'ct-local-file-'))
    const folder = join(root, 'project')
    const outside = join(root, 'outside')
    mkdirSync(join(folder, 'sub'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(folder, 'sub', 'page.html'), '<p>inside</p>')
    writeFileSync(join(outside, 'secret.html'), '<p>outside</p>')
    symlinkSync(outside, join(folder, 'out'), 'junction')
    expect(fileInside(join(folder, 'sub', 'page.html'), folder, realpathSync.native)).toBe(true)
    expect(fileInside(join(folder, 'out', 'secret.html'), folder, realpathSync.native)).toBe(false)
    expect(fileInside(join(folder, 'out', 'new.html'), folder, realpathSync.native)).toBe(false)
  })
})
