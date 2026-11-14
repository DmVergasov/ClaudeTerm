import { posix, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FileLinks, openFileLink, resolveLinkPath, STAT_TIMEOUT_MS, type OpenFileDeps } from '../../src/main/chat/file-links'
import { pathKey } from '../../src/main/path-key'
import type { DocCheck } from '../../src/shared/doc-file'

describe('resolveLinkPath', () => {
  it('on Windows: relative with / or \\, ./ and ../, absolute, ~, and a line', () => {
    const r = (t: string) => resolveLinkPath('C:\\proj', t, 'C:\\Users\\me', win32)
    expect(r('src/a.ts:12')).toEqual({ file: 'C:\\proj\\src\\a.ts', line: 12 })
    expect(r('src\\a.ts')).toEqual({ file: 'C:\\proj\\src\\a.ts', line: null })
    expect(r('./x/y.md')).toEqual({ file: 'C:\\proj\\x\\y.md', line: null })
    expect(r('../up/x.md')).toEqual({ file: 'C:\\up\\x.md', line: null })
    expect(r('D:\\Work\\notes.md')).toEqual({ file: 'D:\\Work\\notes.md', line: null })
    expect(r('D:/Work/notes.md:3')).toEqual({ file: 'D:\\Work\\notes.md', line: 3 })
    expect(r('~/notes/a.md')).toEqual({ file: 'C:\\Users\\me\\notes\\a.md', line: null })
    expect(r('~\\a.md')).toEqual({ file: 'C:\\Users\\me\\a.md', line: null })
  })
  it('on Linux and macOS: relative, absolute and ~', () => {
    const r = (t: string) => resolveLinkPath('/proj', t, '/home/me', posix)
    expect(r('.superpowers/sdd/plan.md')).toEqual({ file: '/proj/.superpowers/sdd/plan.md', line: null })
    expect(r('/usr/lib/x.so:4:2')).toEqual({ file: '/usr/lib/x.so', line: 4 })
    expect(r('~/a.md')).toEqual({ file: '/home/me/a.md', line: null })
  })
  it('a network path and an empty one resolve to nothing', () => {
    expect(resolveLinkPath('C:\\proj', '\\\\server\\share\\n.md', 'C:\\Users\\me', win32)).toBeNull()
    expect(resolveLinkPath('/proj', '//server/share/n.md', '/home/me', posix)).toBeNull()
    expect(resolveLinkPath('/proj', '', '/home/me', posix)).toBeNull()
  })
})

describe('FileLinks', () => {
  const make = () => {
    const files = new Set(['C:\\proj\\docs\\spec.md', 'C:\\proj\\src\\a.ts'].map((f) => pathKey(f, win32)))
    const asked: string[] = []
    const links = new FileLinks({ isFile: async (p) => { asked.push(p); return files.has(pathKey(p, win32)) }, home: 'C:\\Users\\me' }, win32)
    return { links, asked }
  }
  it('answers the paths that are files, once each, in the order given, with their kind and line; a network path is never looked at', async () => {
    const { links, asked } = make()
    expect(await links.resolve('t', 'C:\\proj', ['docs/spec.md', 'src/a.ts:12', 'missing/x.md', 'src/a.ts:12', '\\\\server\\share\\n.md'])).toEqual([
      { path: 'docs/spec.md', file: 'C:\\proj\\docs\\spec.md', kind: 'doc', line: null },
      { path: 'src/a.ts:12', file: 'C:\\proj\\src\\a.ts', kind: 'file', line: 12 }
    ])
    expect(asked.some((p) => p.startsWith('\\\\'))).toBe(false)
  })
  it('linked: only a file an answer of the same tab named, compared as pathKey; removeTab forgets', async () => {
    const { links } = make()
    await links.resolve('t', 'C:\\proj', ['src/a.ts', 'missing/x.md'])
    expect(links.linked('t', 'c:\\PROJ\\SRC\\A.TS')).toBe(true)
    expect(links.linked('t', 'C:\\proj\\missing\\x.md')).toBe(false)
    expect(links.linked('t2', 'C:\\proj\\src\\a.ts')).toBe(false)
    links.removeTab('t')
    expect(links.linked('t', 'C:\\proj\\src\\a.ts')).toBe(false)
  })
  it('a path whose stat never answers is not a file after STAT_TIMEOUT_MS, and does not hold the others', async () => {
    vi.useFakeTimers()
    try {
      const links = new FileLinks({ isFile: (p) => (p.endsWith('slow.ts') ? new Promise<boolean>(() => {}) : Promise.resolve(true)), home: '/home/me' }, posix)
      const answer = links.resolve('t', '/proj', ['slow.ts', 'fast.ts'])
      await vi.advanceTimersByTimeAsync(STAT_TIMEOUT_MS)
      expect((await answer).map((l) => l.path)).toEqual(['fast.ts'])
      expect(links.linked('t', '/proj/slow.ts')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
  it('on Linux, linked keeps the case', async () => {
    const links = new FileLinks({ isFile: async () => true, home: '/home/me' }, posix)
    await links.resolve('t', '/proj', ['src/a.ts'])
    expect(links.linked('t', '/proj/src/a.ts')).toBe(true)
    expect(links.linked('t', '/PROJ/SRC/A.TS')).toBe(false)
  })
})

describe('openFileLink', () => {
  const deps = (o: { file?: boolean; doc?: DocCheck; refused?: boolean } = {}) => {
    const calls: string[] = []
    const d: OpenFileDeps = {
      isFile: async () => o.file ?? true,
      checkDoc: async () => o.doc ?? { ok: true, kind: 'markdown', size: 10 },
      htmlRefused: () => o.refused ?? false,
      showDoc: (tabId, file, kind) => { calls.push(`doc ${tabId} ${file} ${kind}`) },
      edit: (file, line) => { calls.push(`edit ${file} ${line}`) },
      toast: (m) => { calls.push(`toast ${m}`) }
    }
    return { d, calls }
  }
  it('a document opens in the Docs panel', async () => {
    const { d, calls } = deps()
    await openFileLink('t', '/p/docs/spec.md', 3, d)
    expect(calls).toEqual(['doc t /p/docs/spec.md markdown'])
  })
  it('another file opens in the editor at its line, at line 1 without one', async () => {
    const { d, calls } = deps()
    await openFileLink('t', '/p/src/a.ts', 12, d)
    await openFileLink('t', '/p/src/b.ts', null, d)
    expect(calls).toEqual(['edit /p/src/a.ts 12', 'edit /p/src/b.ts 1'])
  })
  it('a document the Docs panel refuses opens in the editor', async () => {
    const big = deps({ doc: { ok: false, error: 'the document is larger than 5 MB: /p/big.md' } })
    await openFileLink('t', '/p/big.md', null, big.d)
    expect(big.calls).toEqual(['edit /p/big.md 1'])
    const home = deps({ doc: { ok: true, kind: 'html', size: 1 }, refused: true })
    await openFileLink('t', '/p/index.html', null, home.d)
    expect(home.calls).toEqual(['edit /p/index.html 1'])
  })
  it('a file that is gone says so and opens nothing', async () => {
    const { d, calls } = deps({ file: false })
    await openFileLink('t', '/p/gone.md', null, d)
    expect(calls).toEqual(['toast File not found: /p/gone.md'])
  })
})
