import { describe, expect, it } from 'vitest'
import { parseMessage } from '../../src/main/sync/wire'
import { MAX_REMOTE_COLS, MAX_REMOTE_ROWS, parseRemoteMessage, parseRemoteTab } from '../../src/main/sync/remote-wire'
import { DEVICE_COLORS, deviceColor, MAX_CHAT_PUSH_BYTES, MAX_INPUT_CHARS, MAX_REMOTE_TABS, PUSH_KINDS } from '../../src/shared/remote'

const T1 = '0a1b2c3d-0000-4000-8000-000000000001'
const T2 = '0a1b2c3d-0000-4000-8000-000000000002'
const S1 = 'a0000000-0000-4000-8000-000000000001'

/** a valid remote tab, as a device describes it; `over` changes some of its fields */
const tab = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: T1,
  kind: 'claude',
  profile: 'Claude',
  cwd: 'D:\\Workspace\\app',
  folder: 'D:\\Workspace\\app',
  customTitle: null,
  title: 'Working',
  claudeSessionId: null,
  account: null,
  accountName: null,
  muted: false,
  exited: false,
  working: true,
  attention: null,
  attentionSeq: 0,
  images: 0,
  note: false,
  counter: null,
  status: null,
  size: { cols: 120, rows: 30, by: null },
  place: null,
  placeKnown: true,
  forkOf: null,
  fork: false,
  ...over
})

describe('part 2 messages', () => {
  it('accepts each part 2 message and refuses wrong shapes', () => {
    expect(parseMessage({ t: 'out', id: T1, seq: 1, d: 'hi' })).toEqual({ t: 'out', id: T1, seq: 1, d: 'hi' })
    for (const bad of [{ t: 'out', id: 'x', seq: 1, d: '' }, { t: 'out', id: T1, seq: 0, d: '' }, { t: 'in', id: T1, d: 'x'.repeat(MAX_INPUT_CHARS + 1) },
      { t: 'claim', id: T1, cols: 0, rows: 30 }, { t: 'call', id: 1, m: 'Bad Name', a: {} }, { t: 'push', id: T1, k: 'weather', v: 1 },
      { t: 'tabs', tabs: Array(MAX_REMOTE_TABS + 1).fill(tab()) }]) {
      expect(parseRemoteMessage(bad)).toBeNull()
      expect(parseMessage(bad)).toBe('unknown')
    }
    expect(parseMessage({ t: 'front', id: null })).toEqual({ t: 'front', id: null, present: false, focused: false })
    expect(parseMessage({ t: 'reply', id: 3, ok: false, e: 'no' })).toEqual({ t: 'reply', id: 3, ok: false, e: 'no' })
  })

  it('front says whether the member is present: true, false or absent (not present); any other value drops the message', () => {
    expect(parseMessage({ t: 'front', id: T1, present: true, focused: true })).toEqual({ t: 'front', id: T1, present: true, focused: true })
    expect(parseMessage({ t: 'front', id: T1, present: false, focused: false })).toEqual({ t: 'front', id: T1, present: false, focused: false })
    expect(parseMessage({ t: 'front', id: T1 })).toEqual({ t: 'front', id: T1, present: false, focused: false })
    expect(parseMessage({ t: 'front', id: T1, present: 'x' })).toBe('unknown')
    expect(parseMessage({ t: 'front', id: null, present: 1 })).toBe('unknown')
  })

  it('ring carries a tab and one of the notification cases; any other id or case is malformed', () => {
    expect(parseMessage({ t: 'ring', id: T1, reason: 'permission' })).toEqual({ t: 'ring', id: T1, reason: 'permission' })
    expect(parseMessage({ t: 'ring', id: 'nope', reason: 'permission' })).toBe('unknown')
    expect(parseMessage({ t: 'ring', id: T1, reason: 'nope' })).toBe('unknown')
    expect(parseMessage({ t: 'ring', id: T1 })).toBe('unknown')
  })

  it('an older member sends focused and no present: that front is not present, and its focus is kept for the clearing of its mark', () => {
    expect(parseMessage({ t: 'front', id: T1, focused: true })).toEqual({ t: 'front', id: T1, present: false, focused: true })
    expect(parseMessage({ t: 'front', id: T1, focused: 'x' })).toBe('unknown')
  })

  it("a member's size claim is bounded by MAX_REMOTE_COLS and MAX_REMOTE_ROWS; a larger one is dropped", () => {
    expect(parseMessage({ t: 'claim', id: T1, cols: MAX_REMOTE_COLS, rows: MAX_REMOTE_ROWS })).toEqual({ t: 'claim', id: T1, cols: MAX_REMOTE_COLS, rows: MAX_REMOTE_ROWS })
    expect(parseMessage({ t: 'claim', id: T1, cols: MAX_REMOTE_COLS + 1, rows: 24 })).toBe('unknown')
    expect(parseMessage({ t: 'claim', id: T1, cols: 80, rows: MAX_REMOTE_ROWS + 1 })).toBe('unknown')
    expect(parseMessage({ t: 'claim', id: T1, cols: 4000, rows: 4000 })).toBe('unknown')
  })

  it("a tab's own size keeps the local limit: a tab of another device up to 4000 by 4000 is kept", () => {
    expect(parseRemoteTab(tab({ size: { cols: 4000, rows: 4000, by: null } }))).toEqual(tab({ size: { cols: 4000, rows: 4000, by: null } }))
  })

  it('calls, replies and tab messages take their shapes', () => {
    expect(parseMessage({ t: 'call', id: 1, m: 'attach', a: { tab: T1 } })).toEqual({ t: 'call', id: 1, m: 'attach', a: { tab: T1 } })
    expect(parseMessage({ t: 'call', id: 1, m: 'attach' })).toBe('unknown')
    expect(parseMessage({ t: 'reply', id: 1, ok: true, v: null })).toEqual({ t: 'reply', id: 1, ok: true, v: null })
    expect(parseMessage({ t: 'reply', id: 1, ok: true })).toBe('unknown')
    expect(parseMessage({ t: 'reply', id: 1, ok: false, e: '' })).toBe('unknown')
    expect(parseMessage({ t: 'reply', id: 1, ok: false, e: 'x'.repeat(1001) })).toBe('unknown')
    expect(parseMessage({ t: 'tab', tab: tab() })).toEqual({ t: 'tab', tab: tab() })
    expect(parseMessage({ t: 'tab-closed', id: T1 })).toEqual({ t: 'tab-closed', id: T1 })
    expect(parseMessage({ t: 'detached', id: T1 })).toEqual({ t: 'detached', id: T1 })
    expect(parseMessage({ t: 'reset', id: T1, seq: 0 })).toBe('unknown')
    expect(parseMessage({ t: 'exit', id: T1, seq: 3, code: 1.5 })).toBe('unknown')
    expect(parseMessage({ t: 'exit', id: T1, seq: 3, code: -1 })).toEqual({ t: 'exit', id: T1, seq: 3, code: -1 })
    expect(parseMessage({ t: 'push', id: T1, k: 'plan', v: [] })).toEqual({ t: 'push', id: T1, k: 'plan', v: [] })
    expect(parseMessage({ t: 'in', id: T1, d: '' })).toBe('unknown')
    expect(parseMessage({ t: 'claim', id: T1, cols: 80, rows: 24 })).toEqual({ t: 'claim', id: T1, cols: 80, rows: 24 })
    expect(parseMessage({ t: 'front', id: 'nope' })).toBe('unknown')
  })

  it('a tab list keeps only the known fields of each tab', () => {
    expect(parseMessage({ t: 'tabs', tabs: [{ ...tab(), extra: 1 }] })).toEqual({ t: 'tabs', tabs: [tab()] })
  })

  it('a tab list of exactly MAX_REMOTE_TABS entries passes', () => {
    expect(parseMessage({ t: 'tabs', tabs: Array(MAX_REMOTE_TABS).fill(tab()) })).toEqual({ t: 'tabs', tabs: Array(MAX_REMOTE_TABS).fill(tab()) })
  })

  it('a tabs message with one good and one bad entry keeps the good one alone', () => {
    expect(parseMessage({ t: 'tabs', tabs: [tab(), tab({ kind: 'other' })] })).toEqual({ t: 'tabs', tabs: [tab()] })
    expect(parseMessage({ t: 'tabs', tabs: [tab({ kind: 'other' }), tab({ title: 'x'.repeat(1001) })] })).toEqual({ t: 'tabs', tabs: [] })
  })

  it('a part 2 message that fails its check is dropped as unknown, and part 1 keeps its strict rule', () => {
    expect(parseMessage({ t: 'tab', tab: tab({ kind: 'other' }) })).toBe('unknown')
    expect(parseMessage({ t: 'sync', seen: 5 })).toBeNull()
  })

  it('refused shapes read from JSON: an array where an object is due, a bad sequence number, a missing value, a bad id', () => {
    const json = (text: string): unknown => JSON.parse(text)
    const shapes: Array<[string, unknown]> = [
      ['a tab that is an array', json('{"t":"tab","tab":[]}')],
      ['a size that is an array', json(`{"t":"tab","tab":${JSON.stringify({ ...tab(), size: [] })}}`)],
      ['a counter that is an array', json(`{"t":"tab","tab":${JSON.stringify({ ...tab(), counter: [] })}}`)],
      ['a sequence number of 1e999', json(`{"t":"out","id":"${T1}","seq":1e999,"d":""}`)],
      ['a sequence number of 2 ** 53', json(`{"t":"out","id":"${T1}","seq":9007199254740992,"d":""}`)],
      ['an exit with seq 0', json(`{"t":"exit","id":"${T1}","seq":0,"code":0}`)],
      ['a push without a value', json(`{"t":"push","id":"${T1}","k":"plan"}`)],
      ['a tab-closed with an id that is not a UUID', json('{"t":"tab-closed","id":"nope"}')],
      ['a profile holding NUL', json(`{"t":"tab","tab":${JSON.stringify(tab({ profile: 'Cl\u0000aude' }))}}`)],
      ['a cwd holding NUL', json(`{"t":"tab","tab":${JSON.stringify(tab({ cwd: 'D:\\\u0000app' }))}}`)]
    ]
    for (const [name, v] of shapes) {
      expect(parseRemoteMessage(v as Record<string, unknown>), name).toBeNull()
      expect(parseMessage(v), name).toBe('unknown')
    }
  })

  it('a tab with its own __proto__ key from JSON is not copied into the result', () => {
    const v = JSON.parse(JSON.stringify(tab()).replace('{', '{"__proto__":{"polluted":1},'))
    const parsed = parseRemoteTab(v)
    expect(parsed).toEqual(tab())
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('part 2 tabs and colours', () => {
  it('parseRemoteTab keeps a good entry and refuses a bad one', () => {
    expect(parseRemoteTab(tab())).toEqual(tab())
    for (const over of [{ kind: 'other' }, { cwd: 'x'.repeat(4097) }, { size: { cols: 0, rows: 30, by: null } }, { attention: 'nap' }, { attentionSeq: -1 }])
      expect(parseRemoteTab({ ...tab(), ...over })).toBeNull()
  })

  it('a tab waiting with the peer case (another session\'s turn) keeps it, as the other cases', () => {
    expect(parseRemoteTab(tab({ attention: 'peer', attentionSeq: 3 }))).toEqual(tab({ attention: 'peer', attentionSeq: 3 }))
  })

  it('a tab keeps its counter, its session and the device its size is for; a bad counter or session is refused', () => {
    const full = tab({ counter: { files: 2, additions: 5, deletions: 1, title: '2 files changed' }, claudeSessionId: S1, size: { cols: 80, rows: 24, by: T2 } })
    expect(parseRemoteTab(full)).toEqual(full)
    expect(parseRemoteTab(tab({ counter: { files: -1, additions: 0, deletions: 0, title: '' } }))).toBeNull()
    expect(parseRemoteTab(tab({ claudeSessionId: 'nope' }))).toBeNull()
    expect(parseRemoteTab(tab({ size: { cols: 80, rows: 24, by: 'nope' } }))).toBeNull()
  })

  it('an entry of an older device, with no place, fork head or fork, reads as no place, no head and no fork; the tab is kept', () => {
    const older: Record<string, unknown> = tab()
    delete older.place
    delete older.placeKnown
    delete older.folder
    delete older.forkOf
    delete older.fork
    expect(parseRemoteTab(older)).toEqual(tab())
  })

  it('a repository directly under a root keeps its place: an empty parent is a place', () => {
    const place = { project: { key: 'c:\\acme', name: 'acme', parent: '' }, worktree: null, branch: 'main' }
    expect(parseRemoteTab(tab({ place }))?.place).toEqual(place)
    expect(parseRemoteTab(tab({ place: { ...place, project: { ...place.project, key: '' } } }))?.place).toBeNull()
  })

  it('the place says whether its device has published it: missing reads as known, false as not yet', () => {
    expect(parseRemoteTab(tab({ placeKnown: false }))?.placeKnown).toBe(false)
    const older: Record<string, unknown> = tab()
    delete older.placeKnown
    expect(parseRemoteTab(older)?.placeKnown).toBe(true)
  })

  it('the folder is checked like the cwd: a missing or invalid folder reads as the cwd, a valid one is kept', () => {
    const older: Record<string, unknown> = tab({ cwd: 'D:\\work\\app' })
    delete older.folder
    expect(parseRemoteTab(older)?.folder).toBe('D:\\work\\app')
    expect(parseRemoteTab(tab({ cwd: 'D:\\work\\app', folder: '' }))?.folder).toBe('D:\\work\\app')
    expect(parseRemoteTab(tab({ cwd: 'D:\\work\\app', folder: 7 }))?.folder).toBe('D:\\work\\app')
    expect(parseRemoteTab(tab({ cwd: 'D:\\work\\app', folder: 'D:\\work\\app-wt' }))?.folder).toBe('D:\\work\\app-wt')
  })

  it('a place that does not fit reads as no place, and the tab is kept', () => {
    const place = { project: { key: 'd:/work/app', name: 'app', parent: 'work' }, worktree: { path: 'd:/work/app-wt', color: 2 }, branch: 'main' }
    const bad = [
      { ...place, worktree: { path: 'd:/work/app-wt', color: 6 } },
      { ...place, worktree: { path: 'd:/work/app-wt', color: 1.5 } },
      { ...place, branch: 'b'.repeat(257) },
      { ...place, branch: 'ma\u0007in' },
      { ...place, project: { key: 'k'.repeat(4097), name: 'app', parent: 'work' } },
      { ...place, project: { key: 'd:/work/app', name: 'n'.repeat(257), parent: 'work' } },
      { project: place.project, worktree: null },
      'main',
      { ...place, project: { key: 'd:/work\u0000/app', name: 'app', parent: 'work' } },
      { ...place, project: { key: 'd:/work/app', name: 'ap\u0000p', parent: 'work' } },
      { ...place, project: { key: 'd:/work/app', name: 'app', parent: 'wo\u0000rk' } },
      { ...place, worktree: { path: 'd:/work/app\u0000-wt', color: 1 } }
    ]
    for (const p of bad) {
      const parsed = parseRemoteTab(tab({ place: p }))
      expect(parsed).toEqual({ ...tab(), place: null, forkOf: null, fork: false })
    }
  })

  it('a full valid place round-trips, with the fork fields', () => {
    const place = { project: { key: 'd:/work/app', name: 'app', parent: 'work' }, worktree: { path: 'd:/work/app-wt', color: 5 }, branch: 'feat/x' }
    const full = tab({ place, forkOf: T2, fork: true })
    expect(parseRemoteTab(JSON.parse(JSON.stringify(full)))).toEqual(full)
    expect(parseRemoteTab(tab({ place: { ...place, worktree: null } }))?.place).toEqual({ ...place, worktree: null })
  })

  it('a forkOf that is not a uuid reads as no head, and a fork that is not a boolean as no fork', () => {
    expect(parseRemoteTab(tab({ forkOf: 'the-head', fork: true }))).toMatchObject({ forkOf: null, fork: true })
    // a head is kept only for a fork: a head of a non-fork is no head
    expect(parseRemoteTab(tab({ forkOf: T2, fork: 'yes' }))).toMatchObject({ forkOf: null, fork: false })
    expect(parseRemoteTab(tab({ forkOf: T2, fork: false }))).toMatchObject({ forkOf: null, fork: false })
    expect(parseRemoteTab(tab({ forkOf: T2, fork: true }))).toMatchObject({ forkOf: T2, fork: true })
  })

  // C5: terminal data carries NUL, so an output and an input chunk holding one pass
  it('output and input chunks may hold a NUL', () => {
    expect(parseMessage({ t: 'out', id: T1, seq: 1, d: '\u0000' })).toEqual({ t: 'out', id: T1, seq: 1, d: '\u0000' })
    expect(parseMessage({ t: 'in', id: T1, d: '\u0000' })).toEqual({ t: 'in', id: T1, d: '\u0000' })
  })

  it('a message type a newer device sends is unknown, not malformed', () => expect(parseMessage({ t: 'tab-thumbnail', id: T1 })).toBe('unknown'))

  it('deviceColor gives the same colour of the palette for a device every time', () => {
    expect(DEVICE_COLORS).toContain(deviceColor(T1))
    expect(deviceColor(T1)).toBe(deviceColor(T1))
    expect(deviceColor('not-hex')).toBe(DEVICE_COLORS[0])
    expect(deviceColor('00000001-0000-4000-8000-000000000001')).toBe(DEVICE_COLORS[1])
  })
})

describe('chat on the wire', () => {
  it('a remote tab keeps its view when it is a view; when it is absent or not one, the tab has no view and is kept', () => {
    expect(parseRemoteTab(tab({ view: 'chat' }))?.view).toBe('chat')
    expect(parseRemoteTab(tab({ view: 'terminal' }))?.view).toBe('terminal')
    expect(parseRemoteTab(tab())?.view).toBeUndefined()
    expect(parseRemoteTab(tab({ view: 'grid' }))).not.toBeNull()
    expect(parseRemoteTab(tab({ view: 'grid' }))?.view).toBeUndefined()
  })

  it('the chat pushes are part 2 push kinds, so a device of this version takes them; an older device drops them as unknown kinds', () => {
    expect(PUSH_KINDS).toContain('chat')
    expect(PUSH_KINDS).toContain('chat-patch')
    expect(parseMessage({ t: 'push', id: T1, k: 'chat', v: { items: [] } })).toEqual({ t: 'push', id: T1, k: 'chat', v: { items: [] } })
    expect(parseMessage({ t: 'push', id: T1, k: 'chat-patch', v: { patches: [] } })).toEqual({ t: 'push', id: T1, k: 'chat-patch', v: { patches: [] } })
  })

  it('a chat push is capped at 2 MiB of JSON', () => expect(MAX_CHAT_PUSH_BYTES).toBe(2 * 1024 * 1024))
})
