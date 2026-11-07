import { describe, expect, it } from 'vitest'
import { arrangeSections, arrangeSessions, displayTitle, filterSessions, firstMatch, formatAge, groupKey, layoutSections, projectKey } from '../../src/renderer/recent-sessions'
import type { DeviceAnswer } from '../../src/shared/remote'
import type { RecentSession } from '../../src/shared/types'

const s = (over: Partial<RecentSession>): RecentSession => ({ id: 'x', cwd: 'D:\\Workspace\\Offroad', title: null, firstPrompt: null, lastPrompt: null, modifiedAt: 0, open: false, starred: false, ...over })

const S1 = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const S2 = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
const S3 = '6e3d2c8b-9f50-4b4c-a2d3-e4f5a6b7c8d9'
const STUDIO = { id: 'a1000000-0000-4000-8000-000000000001', name: 'Studio' }
/** a session of this device, in /work */
const local = (id: string, over: Partial<RecentSession> = {}): RecentSession => s({ id, cwd: '/work', modifiedAt: 10, ...over })
/** a session another device lists, with the device it is on */
const remote = (id: string, device: { id: string; name: string }, over: Partial<RecentSession> = {}): RecentSession => ({ ...local(id, over), device })

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

describe('arrangeSections: the other devices after this one', () => {
  it("another device's sessions come after this device's, under its name, arranged the same way", () => {
    const r = arrangeSections([local(S1)], [{ device: STUDIO.id, name: 'Studio', value: [remote(S2, STUDIO), remote(S3, STUDIO, { starred: true })] }], '')
    expect(r.map((s) => s.device?.name ?? null)).toEqual([null, 'Studio'])
    expect(r[1].arranged.shown.map((s) => s.id)).toEqual([S3, S2])
    expect(r[1].arranged.dividerAt).toBe(1)
  })

  it('the same folder on two devices is two projects', () => {
    expect(groupKey(remote(S2, STUDIO))).not.toBe(groupKey(local(S1)))
    expect(groupKey(local(S1))).toBe(projectKey('/work'))
  })

  it('a device that has not answered yet shows as loading', () => {
    const r = arrangeSections([], [{ device: STUDIO.id, name: 'Studio', value: null }], '')
    expect(r[1]).toMatchObject({ loading: true, arranged: { shown: [] } })
  })

  it('a device that answered keeps its heading keys apart from this device\'s', () => {
    const answers: DeviceAnswer<RecentSession[]>[] = [{ device: STUDIO.id, name: 'Studio', value: [remote(S2, STUDIO)] }]
    const r = arrangeSections([local(S1)], answers, '')
    expect(r[0].arranged.headings.map((h) => h.key)).toEqual([groupKey(local(S1))])
    expect(r[1].arranged.headings.map((h) => h.key)).toEqual([groupKey(remote(S2, STUDIO))])
  })
})

describe('the rows a device draws: its name before its loading line (I1)', () => {
  it('a loading device draws its name, then the loading line, and no session', () => {
    const layout = layoutSections(arrangeSections([], [{ device: STUDIO.id, name: 'Studio', value: null }], ''), false, new Set())
    expect(layout.leads.get(0)).toEqual([{ device: 'Studio' }, { loading: true }])
    expect(layout.items).toEqual([])
  })

  it('an answered device draws its name before its first row, after this device\'s rows', () => {
    const layout = layoutSections(arrangeSections([local(S1)], [{ device: STUDIO.id, name: 'Studio', value: [remote(S2, STUDIO)] }], ''), false, new Set([groupKey(local(S1)), groupKey(remote(S2, STUDIO))]))
    // this device's heading and session are items 0 and 1: the device's name goes before its heading, item 2
    expect(layout.leads.get(2)).toEqual([{ device: 'Studio' }])
    expect('heading' in layout.items[2]!).toBe(true)
  })
})

describe('Enter after a search takes the first match of any device (I2)', () => {
  it('the first match is this device\'s when it has one, else the first of another device that answered', () => {
    expect(firstMatch(arrangeSections([local(S1, { title: 'Login' })], [{ device: STUDIO.id, name: 'Studio', value: [remote(S2, STUDIO, { title: 'Login again' })] }], 'login'))?.id).toBe(S1)
    expect(firstMatch(arrangeSections([local(S1, { title: 'Docs' })], [{ device: STUDIO.id, name: 'Studio', value: [remote(S2, STUDIO, { title: 'Payments' })] }], 'payments'))?.id).toBe(S2)
  })

  it('a device that is loading has no match, and no match anywhere gives none', () => {
    expect(firstMatch(arrangeSections([local(S1, { title: 'Docs' })], [{ device: STUDIO.id, name: 'Studio', value: null }], 'payments'))).toBeUndefined()
    expect(firstMatch(arrangeSections([local(S1)], [{ device: STUDIO.id, name: 'Studio', value: [remote(S2, STUDIO)] }], 'nothing-matches'))).toBeUndefined()
  })
})

