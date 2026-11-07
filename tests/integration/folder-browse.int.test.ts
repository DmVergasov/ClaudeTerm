import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, sep, win32 } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { changeFolderOf, checkFolder, folderListingOf, listFolder, recentFolders, type FolderFs, type TabFolderDeps } from '../../src/main/folder-browse'
import { pathKey } from '../../src/main/path-key'
import { MAX_FOLDER_ENTRIES, MAX_PATH_TEXT, RECENT_FOLDER_COUNT, REMOTE_COPY, type FolderListing, type FolderResult } from '../../src/shared/remote'
import type { SessionSummary } from '../../src/shared/types'

// The folder listing and the folder check of "Change folder…", on real folders in temp folders (a junction on Windows),
// and on fake file systems where a case needs a link that does not exist on every system.

const WIN = process.platform === 'win32'
const roots: string[] = []

/** a new temp folder with the given subfolders and files in it */
function tree(folders: string[], files: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'ct-folders-'))
  roots.push(root)
  for (const f of folders) mkdirSync(join(root, f), { recursive: true })
  for (const f of files) writeFileSync(join(root, f), 'x')
  return root
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function listing(r: FolderResult): FolderListing {
  if (!r.ok) throw new Error(r.error)
  return r.listing
}

/** a fake fs: its folder holds `entries` (names with their kind); every stat answers a folder, and `onStat` sees each one */
function fakeFs(entries: { name: string; kind: 'dir' | 'link' | 'file' }[], onStat?: () => void): FolderFs {
  return {
    stat: async () => {
      onStat?.()
      return { isDirectory: () => true }
    },
    readdir: async () => entries.map((e) => ({ name: e.name, isDirectory: () => e.kind === 'dir', isSymbolicLink: () => e.kind === 'link', isFile: () => e.kind === 'file' })) as unknown as Dirent[]
  }
}

/** a fake fs whose folder holds the given entries, and whose stat is `statOf` (a folder when it is not given) */
function scriptedFs(entries: { name: string; kind: 'dir' | 'link' }[], statOf: (p: string) => Promise<{ isDirectory(): boolean }>): FolderFs {
  return {
    stat: statOf,
    readdir: async () => entries.map((e) => ({ name: e.name, isDirectory: () => e.kind === 'dir', isSymbolicLink: () => e.kind === 'link' })) as unknown as Dirent[]
  }
}

/** an error the file system gives, with its code */
function fsError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

describe('folder listing and check', () => {
  it('lists the subfolders only, by name', async () => {
    const home = tree(['src', 'docs'], ['a.txt'])
    const o = { home, device: 'Studio', recent: [] }
    expect(listing(await listFolder(home, o)).folders).toEqual(['docs', 'src'])
  })

  it('reads folders as people type them', async () => {
    const home = tree(['sub'])
    const o = { home, device: 'Studio', recent: [] }
    for (const typed of ['~', ` ${home} `, `${home}${sep}`, ...(WIN ? [home.replace(/\\/g, '/')] : [])]) {
      expect(pathKey(listing(await listFolder(typed, o)).path)).toBe(pathKey(home))
    }
    expect(pathKey(listing(await listFolder('~/sub', o)).path)).toBe(pathKey(join(home, 'sub')))
  })

  it("a missing folder, a file and a relative path give the dialog's messages", async () => {
    const home = tree([], ['a.txt'])
    const o = { home, device: 'Studio', recent: [] }
    expect(await listFolder(join(home, 'nope'), o)).toEqual({ ok: false, error: REMOTE_COPY.folderMissing })
    expect(await listFolder(join(home, 'a.txt'), o)).toEqual({ ok: false, error: REMOTE_COPY.folderMissing })
    expect(await listFolder('src', o)).toEqual({ ok: false, error: REMOTE_COPY.folderNotAbsolute })
  })

  it('a link to a folder (a junction on Windows) is listed as a folder', async () => {
    const home = tree(['src'])
    symlinkSync(join(home, 'src'), join(home, 'linked'), 'junction')
    const o = { home, device: 'Studio', recent: [] }
    expect(listing(await listFolder(home, o)).folders).toEqual(['linked', 'src'])
  })

  it('checkFolder answers the folder it resolves to, or the dialog message', async () => {
    const home = tree(['src'], ['a.txt'])
    expect(await checkFolder(`${join(home, 'src')}${sep}`, { home })).toEqual({ ok: true, path: join(home, 'src') })
    expect(await checkFolder('~', { home })).toEqual({ ok: true, path: home })
    expect(await checkFolder(join(home, 'a.txt'), { home })).toEqual({ ok: false, error: REMOTE_COPY.folderMissing })
    expect(await checkFolder('src', { home })).toEqual({ ok: false, error: REMOTE_COPY.folderNotAbsolute })
  })

  it('the listing gives the parent of a folder; a root has none (fake file systems: posix / and win32 C:\\)', async () => {
    const home = tree(['src'])
    expect(listing(await listFolder(join(home, 'src'), { home, device: 'Studio', recent: [] })).parent).toBe(home)
    const posixRoot = listing(await listFolder('/', { home: '/h', device: 'Studio', recent: [], fs: fakeFs([]), path: posix }))
    expect(posixRoot).toMatchObject({ path: '/', sep: '/', parent: null })
    const winRoot = listing(await listFolder('C:\\', { home: 'C:\\h', device: 'Studio', recent: [], fs: fakeFs([]), path: win32 }))
    expect(winRoot).toMatchObject({ path: 'C:\\', sep: '\\', parent: null })
  })

  it('recentFolders gives each folder once, newest first, at most ten', () => {
    // twelve sessions in eleven folders, the second spelling of the newest folder among them; given oldest first
    const sessions: SessionSummary[] = []
    for (let k = 0; k < 12; k++) {
      const cwd = k === 0 ? 'D:\\w\\f0' : k === 1 ? 'd:\\W\\F0' : `D:\\w\\f${k - 1}`
      sessions.push({ id: `s${k}`, cwd, title: null, firstPrompt: null, lastPrompt: null, modifiedAt: 1000 - k })
    }
    const got = recentFolders([...sessions].reverse(), win32)
    expect(got).toEqual(['D:\\w\\f0', 'D:\\w\\f1', 'D:\\w\\f2', 'D:\\w\\f3', 'D:\\w\\f4', 'D:\\w\\f5', 'D:\\w\\f6', 'D:\\w\\f7', 'D:\\w\\f8', 'D:\\w\\f9'])
    expect(got).toHaveLength(RECENT_FOLDER_COUNT)
  })

  it('a recent folder with a NUL is left out, by the listing and by recentFolders; the rest stay', async () => {
    const got = listing(await listFolder('/h', { home: '/h', device: 'Studio', recent: ['/a\u0000b', '/ok'], fs: fakeFs([]) }))
    expect(got.recent).toEqual(['/ok'])
    const sessions: SessionSummary[] = [
      { id: 's1', cwd: '/a\u0000b', title: null, firstPrompt: null, lastPrompt: null, modifiedAt: 2 },
      { id: 's2', cwd: '/ok', title: null, firstPrompt: null, lastPrompt: null, modifiedAt: 1 }
    ]
    expect(recentFolders(sessions, posix)).toEqual(['/ok'])
  })

  it('a folder name with a separator or NUL, or over 255 characters, is left out; the rest stay', async () => {
    const fs = fakeFs([
      { name: 'x'.repeat(300), kind: 'dir' },
      { name: 'back\\slash', kind: 'dir' },
      { name: 'nul\u0000name', kind: 'dir' },
      { name: 'kept', kind: 'dir' },
      { name: 'file.txt', kind: 'file' }
    ])
    const got = listing(await listFolder('/h', { home: '/h', device: 'Studio', recent: [], fs }))
    expect(got.folders).toEqual(['kept'])
  })

  it('the device name is cut to 64 characters, never through a surrogate pair, and falls back to "device" when empty', async () => {
    const home = tree([])
    const long = listing(await listFolder(home, { home, device: 'd'.repeat(100), recent: ['', 'x'.repeat(MAX_PATH_TEXT + 1), '/ok'] }))
    expect(long.device).toHaveLength(64)
    expect(long.recent).toEqual(['/ok'])
    expect(listing(await listFolder(home, { home, device: '', recent: [] })).device).toBe('device')
    // a pair of surrogates that would be cut in its middle: the name ends one unit earlier
    const pair = listing(await listFolder(home, { home, device: 'a'.repeat(63) + '\u{1F600}', recent: [] }))
    expect(pair.device).toBe('a'.repeat(63))
  })

  it('a big folder gives its first 500 names by the sort, and stats no folder', async () => {
    const names = Array.from({ length: 2000 }, (_, i) => `f${String(i).padStart(4, '0')}`)
    let stats = 0
    const fs = fakeFs([...names].reverse().map((name) => ({ name, kind: 'dir' as const })), () => {
      stats++
    })
    const got = listing(await listFolder('/h', { home: '/h', device: 'Studio', recent: [], fs }))
    expect(got.folders).toEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })).slice(0, MAX_FOLDER_ENTRIES))
    expect(got.folders).toHaveLength(500)
    // the stat of the home folder itself is the only one
    expect(stats).toBe(1)
  })

  it('links are checked with at most eight stats at a time', async () => {
    let running = 0
    let most = 0
    const fs: FolderFs = {
      stat: async () => {
        running++
        most = Math.max(most, running)
        await new Promise((r) => setImmediate(r))
        running--
        return { isDirectory: () => true }
      },
      readdir: async () => Array.from({ length: 20 }, (_, i) => ({ name: `l${i}`, isDirectory: () => false, isSymbolicLink: () => true })) as unknown as Dirent[]
    }
    const got = listing(await listFolder('/h', { home: '/h', device: 'Studio', recent: [], fs }))
    expect(got.folders).toHaveLength(20)
    expect(most).toBeGreaterThan(1)
    expect(most).toBeLessThanOrEqual(8)
  })

  it('a folder that cannot be read gives the message for an unreadable folder', async () => {
    const fs: FolderFs = {
      stat: async () => ({ isDirectory: () => true }),
      readdir: async () => {
        throw fsError('EACCES')
      }
    }
    expect(await listFolder('/h', { home: '/h', device: 'Studio', recent: [], fs })).toEqual({ ok: false, error: REMOTE_COPY.folderUnreadable })
  })

  it('links to a file, a dangling link and a link loop are left out; a link to a folder stays', async () => {
    const fs = scriptedFs(
      [
        { name: 'dir1', kind: 'dir' },
        { name: 'tofile', kind: 'link' },
        { name: 'dangling', kind: 'link' },
        { name: 'loop', kind: 'link' },
        { name: 'good', kind: 'link' }
      ],
      async (p) => {
        if (p.endsWith('tofile')) return { isDirectory: () => false }
        if (p.endsWith('dangling')) throw fsError('ENOENT')
        if (p.endsWith('loop')) throw fsError('ELOOP')
        return { isDirectory: () => true }
      }
    )
    const got = listing(await listFolder('/h', { home: '/h', device: 'Studio', recent: [], fs, path: posix }))
    expect(got.folders).toEqual(['dir1', 'good'])
  })

  it('a stat that says EACCES or EPERM is an unreadable folder; any other failure is a missing one', async () => {
    for (const code of ['EACCES', 'EPERM']) {
      const fs = scriptedFs([], async () => {
        throw fsError(code)
      })
      expect(await checkFolder('/h', { home: '/h', fs, path: posix })).toEqual({ ok: false, error: REMOTE_COPY.folderUnreadable })
      expect(await listFolder('/h', { home: '/h', device: 'Studio', recent: [], fs, path: posix })).toEqual({ ok: false, error: REMOTE_COPY.folderUnreadable })
    }
    const missing = scriptedFs([], async () => {
      throw fsError('ENOENT')
    })
    expect(await checkFolder('/h', { home: '/h', fs: missing, path: posix })).toEqual({ ok: false, error: REMOTE_COPY.folderMissing })
  })

  it('on Windows a rooted path with no drive resolves against the home folder\'s drive (path.win32 on any system)', async () => {
    const seen: string[] = []
    const fs = scriptedFs([], async (p) => {
      seen.push(p)
      return { isDirectory: () => true }
    })
    expect(listing(await listFolder('\\work', { home: 'D:\\h', device: 'Studio', recent: [], fs, path: win32 })).path).toBe('D:\\work')
    expect(listing(await listFolder('/Users/x', { home: 'D:\\h', device: 'Studio', recent: [], fs, path: win32 })).path).toBe('D:\\Users\\x')
    expect(seen).toEqual(['D:\\work', 'D:\\Users\\x'])
  })

  it('a resolved path over MAX_PATH_TEXT characters is refused as not absolute', async () => {
    const fs = scriptedFs([], async () => ({ isDirectory: () => true }))
    expect(await checkFolder('~/' + 'x'.repeat(MAX_PATH_TEXT), { home: 'D:\\h', fs, path: win32 })).toEqual({ ok: false, error: REMOTE_COPY.folderNotAbsolute })
  })

  it('a local listing that does not finish in 8 seconds (before the 10 s call timeout) is an unreadable folder', async () => {
    vi.useFakeTimers()
    try {
      const fs = scriptedFs([], () => new Promise<never>(() => {}))
      const pending = listFolder('/h', { home: '/h', device: 'Studio', recent: [], fs, path: posix })
      await vi.advanceTimersByTimeAsync(8_000)
      expect(await pending).toEqual({ ok: false, error: REMOTE_COPY.folderUnreadable })
    } finally {
      vi.useRealTimers()
    }
  })

  it('the tab-facing listing: an unknown tab is refused; recent folders come with the first listing only', async () => {
    const sessions: SessionSummary[] = [{ id: 's', cwd: '/w/app', title: null, firstPrompt: null, lastPrompt: null, modifiedAt: 1 }]
    const deps = (): TabFolderDeps => ({
      home: '/h',
      tabFolder: (id) => (id === 'tab' ? '/h' : null),
      device: () => 'Studio',
      sessions: async () => sessions,
      changeFolder: async () => true,
      fs: fakeFs([]),
      path: posix
    })
    expect(await folderListingOf('nope', null, deps())).toEqual({ ok: false, error: REMOTE_COPY.unknownTab })
    expect(listing(await folderListingOf('tab', null, deps())).recent).toEqual(['/w/app'])
    expect(listing(await folderListingOf('tab', '/h', deps())).recent).toEqual([])
  })

  it('changing a tab to a typed folder: the check first, then the tab manager; a refused move is the dialog\'s "could not be changed"', async () => {
    const moved: [string, string][] = []
    const answer = { ok: true }
    const deps = (): TabFolderDeps => ({
      home: '/h',
      tabFolder: () => '/h',
      device: () => 'Studio',
      sessions: async () => [],
      changeFolder: async (id, path) => {
        moved.push([id, path])
        return answer.ok
      },
      fs: fakeFs([]),
      path: posix
    })
    expect(await changeFolderOf('tab', '/h/nope', deps())).toEqual({ ok: true })
    expect(moved).toEqual([['tab', '/h/nope']])
    answer.ok = false
    expect(await changeFolderOf('tab', '/h', deps())).toEqual({ ok: false, error: REMOTE_COPY.folderChangeFailed })
  })
})
