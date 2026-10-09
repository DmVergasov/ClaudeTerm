import { describe, expect, it } from 'vitest'
import { arrangeSessions, displayTitle, filterSessions, formatAge } from '../../src/renderer/recent-sessions'
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
    expect(arrangeSessions([], '')).toEqual({ shown: [], dividerAt: null })
  })
})
