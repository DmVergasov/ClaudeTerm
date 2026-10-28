import { describe, expect, it } from 'vitest'
import { arrangeSessions, displayTitle, filterSessions, formatAge, projectKey } from '../../src/renderer/recent-sessions'
import type { RecentSession } from '../../src/shared/types'

const s = (over: Partial<RecentSession>): RecentSession => ({ id: 'x', cwd: 'D:\\Workspace\\Offroad', title: null, firstPrompt: null, lastPrompt: null, modifiedAt: 0, open: false, starred: false, ...over })

describe('formatAge', () => {
  const now = new Date(2026, 9, 6, 12, 0).getTime()
  const at = (d: number, h: number, m = 0, y = 2026, mo = 9): number => new Date(y, mo, d, h, m).getTime()
  it('minutes and hours today, then days, then a date', () => {
    expect(formatAge(now - 30_000, now)).toBe('just now')
    expect(formatAge(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(formatAge(at(5, 9), now)).toBe('yesterday')
    expect(formatAge(at(3, 9), now)).toBe('3 days ago')
    expect(formatAge(at(28, 9, 0, 2026, 8), now)).toBe('28 Sep')
    expect(formatAge(at(5, 9, 0, 2025, 9), now)).toBe('5 Oct 2025')
  })
})

describe('filterSessions', () => {
  const list = [
    s({ id: '1', title: 'Fix the login bug', lastPrompt: 'why does login fail' }),
    s({ id: '2', title: 'Payments', cwd: 'D:\\Workspace\\Shop', firstPrompt: 'add YooKassa' })
  ]
  it('every word must match the title, folder or messages, ignoring case', () => {
    expect(filterSessions(list, '').map((x) => x.id)).toEqual(['1', '2'])
    expect(filterSessions(list, 'LOGIN').map((x) => x.id)).toEqual(['1'])
    expect(filterSessions(list, 'shop yookassa').map((x) => x.id)).toEqual(['2'])
    expect(filterSessions(list, 'offroad').map((x) => x.id)).toEqual(['1'])
    expect(filterSessions(list, 'login payments')).toEqual([])
  })
})

describe('displayTitle', () => {
  it('title, else the first message, else (untitled)', () => {
    expect(displayTitle(s({ title: 'T', firstPrompt: 'f' }))).toBe('T')
    expect(displayTitle(s({ firstPrompt: 'f' }))).toBe('f')
    expect(displayTitle(s({}))).toBe('(untitled)')
  })
})

describe('arrangeSessions', () => {
  const list = [
    s({ id: '1', title: 'Fix the login bug', modifiedAt: 50 }),
    s({ id: '2', title: 'Payments', modifiedAt: 40, starred: true }),
    s({ id: '3', title: 'Login page', modifiedAt: 30 }),
    s({ id: '4', title: 'Old login idea', modifiedAt: 5, starred: true }),
    s({ id: '5', title: 'Docs', modifiedAt: 20, starred: true })
  ]
  it('starred sessions first, newest first in each group, the divider after the starred ones', () => {
    const a = arrangeSessions(list, '')
    expect(a.shown.map((x) => x.id)).toEqual(['2', '5', '4', '1', '3'])
    expect(a.dividerAt).toBe(3)
  })

  it('newest first inside a group even when the list comes in another order', () => {
    const a = arrangeSessions([list[3], list[1], list[2], list[0]], '')
    expect(a.shown.map((x) => x.id)).toEqual(['2', '4', '1', '3'])
  })

  it('the filter applies to both groups and starred matches stay on top', () => {
    const a = arrangeSessions(list, 'login')
    expect(a.shown.map((x) => x.id)).toEqual(['4', '1', '3'])
    expect(a.dividerAt).toBe(1)
  })

  it('no divider when only one group is left', () => {
    expect(arrangeSessions(list, 'payments')).toMatchObject({ dividerAt: null })
    expect(arrangeSessions(list, 'docs').dividerAt).toBeNull()
    expect(arrangeSessions(list.filter((x) => !x.starred), '').dividerAt).toBeNull()
    expect(arrangeSessions(list.filter((x) => x.starred), '').dividerAt).toBeNull()
    expect(arrangeSessions([], '')).toEqual({ shown: [], dividerAt: null, headings: [] })
  })
})

/** a heading's place and folder: what most tests care about */
const heads = (a: ReturnType<typeof arrangeSessions>): Array<{ at: number; cwd: string }> => a.headings.map(({ at, cwd }) => ({ at, cwd }))

describe('arrangeSessions by project', () => {
  const shop = 'D:\\Workspace\\Shop'
  const offroad = 'D:\\Workspace\\Offroad'
  const docs = 'D:\\Workspace\\Docs'
  const list = [
    s({ id: '1', cwd: offroad, modifiedAt: 10 }),
    s({ id: '2', cwd: shop, modifiedAt: 50 }),
    s({ id: '3', cwd: offroad, modifiedAt: 40 }),
    s({ id: '4', cwd: docs, modifiedAt: 30, starred: true }),
    s({ id: '5', cwd: shop, modifiedAt: 20 })
  ]

  it('the others go under one heading per folder: the folder with the newest session first, newest first inside', () => {
    const a = arrangeSessions(list, '')
    expect(a.shown.map((x) => x.id)).toEqual(['4', '2', '5', '3', '1'])
    expect(heads(a)).toEqual([{ at: 1, cwd: shop }, { at: 3, cwd: offroad }])
    expect(a.dividerAt).toBe(1)
  })

  it('starred sessions stay on top without a heading, even when their folder has other sessions', () => {
    const a = arrangeSessions(list.map((x) => (x.id === '2' ? { ...x, starred: true } : x)), '')
    expect(a.shown.map((x) => x.id)).toEqual(['2', '4', '3', '1', '5'])
    expect(heads(a)).toEqual([{ at: 2, cwd: offroad }, { at: 4, cwd: shop }])
  })

  it('a folder written with another case, slash or trailing separator is the same project on Windows', () => {
    const a = arrangeSessions([s({ id: '1', cwd: 'D:\\Workspace\\Shop', modifiedAt: 5 }), s({ id: '2', cwd: 'd:/workspace/shop/', modifiedAt: 9 })], '')
    expect(heads(a)).toEqual([{ at: 0, cwd: 'd:/workspace/shop/' }])
  })

  it('folders with the same name in different places are separate projects', () => {
    const a = arrangeSessions([s({ id: '1', cwd: 'D:\\One\\app', modifiedAt: 9 }), s({ id: '2', cwd: 'D:\\Two\\app', modifiedAt: 5 })], '')
    expect(a.headings.map((h) => h.cwd)).toEqual(['D:\\One\\app', 'D:\\Two\\app'])
  })

  it('the filter drops the headings of folders with no match left', () => {
    const a = arrangeSessions(list, 'offroad')
    expect(a.shown.map((x) => x.id)).toEqual(['3', '1'])
    expect(heads(a)).toEqual([{ at: 0, cwd: offroad }])
    expect(a.dividerAt).toBeNull()
  })

  it('a heading knows how many sessions its project has and when the newest was active', () => {
    const a = arrangeSessions(list, '')
    expect(a.headings.map((h) => [h.count, h.modifiedAt])).toEqual([[2, 50], [2, 40]])
  })

  it('the key is the same for every spelling of the folder', () => {
    expect(projectKey('D:\\Workspace\\Shop')).toBe(projectKey('d:/workspace/shop/'))
    expect(projectKey('D:\\One\\app')).not.toBe(projectKey('D:\\Two\\app'))
  })
})
