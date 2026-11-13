import { describe, expect, it, vi } from 'vitest'
import { capItems, capSnapshot, ChatMirror, MAX_CHAT_ITEMS, parseChatPush } from '../../src/main/chat/chat-mirror'
import { SUBJECT_CAP } from '../../src/main/chat/chat-model'
import type { ChatItem, ChatPatch, ChatSnapshot, ChatState, ChatToolCall } from '../../src/shared/chat'
import { MAX_CHAT_PUSH_BYTES } from '../../src/shared/remote'

const TAB = '0a1b2c3d-0000-4000-8000-000000000001'
const STATE: ChatState = { turn: 'idle', turnStartedAt: null, mode: 'default', model: null, effort: null, sessionId: null, exited: false }

const notice = (id: string, text = 'Note'): ChatItem => ({ kind: 'notice', id, tone: 'info', text, action: null })
const text = (id: string, markdown = 'Hello'): ChatItem => ({ kind: 'text', id, markdown, streaming: false })
const tools = (id: string): ChatItem => ({ kind: 'tools', id, calls: [], ms: null })
/** a tool call as the wire carries it; `over` may hold a value the check must refuse */
const call = (id: string, over: Record<string, unknown> = {}): ChatToolCall => ({
  id, name: 'Bash', subject: 'ls', detail: null, state: 'running', output: null, error: null, editPath: null, agents: [], ms: null, ...over
} as ChatToolCall)

const snapshot = (items: ChatItem[], rev = 0, over: Partial<ChatSnapshot> = {}): ChatSnapshot => ({ tabId: TAB, rev, items, hasOlder: false, state: STATE, ...over })
const userItem = (from: unknown): ChatItem => ({ kind: 'user', id: 'u1', text: 'hi', attachments: [], queued: false, ...(from === undefined ? {} : { from }) } as unknown as ChatItem)

describe("a user item's origin is absent, 'auto' or 'review', and nothing else", () => {
  it('the mirror takes each of the three and refuses any other value', () => {
    expect(parseChatPush(snapshot([userItem(undefined)]))).not.toBeNull()
    expect(parseChatPush(snapshot([userItem('auto')]))).not.toBeNull()
    expect(parseChatPush(snapshot([userItem('review')]))).not.toBeNull()
    expect(parseChatPush(snapshot([userItem('somewhere')]))).toBeNull()
    expect(parseChatPush(snapshot([userItem(null)]))).toBeNull()
  })
})

describe("a subagent's model, effort and context are optional, and checked when given", () => {
  const agent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'a1', description: 'Find it', type: 'Explore', state: 'running', ms: null, ...over })
  const withAgent = (over: Record<string, unknown>): ChatSnapshot => snapshot([{ kind: 'tools', id: 't', calls: [call('c1', { name: 'Agent', agents: [agent(over)] })], ms: null }])

  it('the mirror takes an agent with none of them, or with all of them', () => {
    expect(parseChatPush(withAgent({}))).not.toBeNull()
    expect(parseChatPush(withAgent({ model: 'claude-haiku-5-5', effort: 'high', context: 32200 }))).not.toBeNull()
  })

  it('the mirror refuses a model or effort that is not a name, and a context that is not a count', () => {
    expect(parseChatPush(withAgent({ model: 5 }))).toBeNull()
    expect(parseChatPush(withAgent({ model: 'm'.repeat(5000) }))).toBeNull()
    expect(parseChatPush(withAgent({ effort: null }))).toBeNull()
    expect(parseChatPush(withAgent({ context: -1 }))).toBeNull()
    expect(parseChatPush(withAgent({ context: '32k' }))).toBeNull()
  })

  it('the time an agent started is taken when it is a time, and refused otherwise', () => {
    expect(parseChatPush(withAgent({ startedAt: 1_791_194_400_000 }))).not.toBeNull()
    expect(parseChatPush(withAgent({ startedAt: '10:00' }))).toBeNull()
    expect(parseChatPush(withAgent({ startedAt: -5 }))).toBeNull()
    expect(parseChatPush(withAgent({ startedAt: Number.NaN }))).toBeNull()
  })
})

describe('capSnapshot', () => {
  it('a 5 000 notice conversation is cut to what fits in 2 MiB: the newest items, and hasOlder set', () => {
    const items = Array.from({ length: 5000 }, (_, i) => notice(`n${i}`, `Line ${i} `.padEnd(400, 'x')))
    const out = capSnapshot(snapshot(items, 9), 2 * 1024 * 1024)
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(out.items.length).toBeLessThan(5000)
    expect(out.items.at(-1)).toEqual(items[4999])
    expect(out.items[0]).toEqual(items[5000 - out.items.length])
    expect(out.hasOlder).toBe(true)
    expect(out.rev).toBe(9)
  })

  it('a small notice conversation keeps every item and its hasOlder', () => {
    const items = Array.from({ length: 100 }, (_, i) => notice(`n${i}`))
    expect(capSnapshot(snapshot(items, 1, { hasOlder: false }), 2 * 1024 * 1024)).toEqual(snapshot(items, 1, { hasOlder: false }))
  })

  it('a conversation of many short items keeps at most MAX_CHAT_ITEMS, so the member accepts it', () => {
    const items = Array.from({ length: 5000 }, (_, i) => notice(`n${i}`, 'x'))
    const out = capSnapshot(snapshot(items), 2 * 1024 * 1024)
    expect(out.items).toHaveLength(MAX_CHAT_ITEMS)
    expect(out.items.at(-1)).toEqual(items[4999])
    expect(out.hasOlder).toBe(true)
    expect(parseChatPush(out)).not.toBeNull()
  })
})

const MIB_BYTES = 1024 * 1024
/** a tool call that carries a 50 KiB output */
const bigCall = (i: number): ChatToolCall => call(`c${i}`, { subject: `cmd ${i}`, detail: `detail ${i}`, state: 'done', output: `${i}:` + 'o'.repeat(50 * 1024) })

describe('a cut never leaves zero items', () => {
  it('a newest tool step of 3 MiB keeps its newest call whole, the older outputs and details null, and the cut fits', () => {
    const calls = Array.from({ length: 60 }, (_, i) => bigCall(i))
    const step: ChatItem = { kind: 'tools', id: 'step', calls, ms: null }
    const out = capSnapshot(snapshot([notice('older'), step]), 2 * MIB_BYTES)
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(2 * MIB_BYTES)
    expect(out.hasOlder).toBe(true)
    expect(out.items).toHaveLength(1)
    const [kept] = out.items
    if (kept.kind !== 'tools') throw new Error('the newest item is the tool step')
    expect(kept.calls).toHaveLength(60)
    expect(kept.calls[59]).toEqual(calls[59])
    expect(kept.calls[0]).toMatchObject({ id: 'c0', output: null, detail: null, error: null, subject: 'cmd 0' })
    expect(parseChatPush(out)).not.toBeNull()
  })

  it('a newest text item of 3 MiB keeps the tail of its markdown, under the cap and the member\'s text cap', () => {
    // a text the host can make (under the 1 MiB text cap, 3 MiB as JSON): its tail keeps under the cap in characters as well
    const markdown = '→'.repeat(999_000) + 'END'
    const out = capSnapshot(snapshot([{ kind: 'text', id: 't', markdown, streaming: false }]), 2 * MIB_BYTES)
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(2 * MIB_BYTES)
    const [kept] = out.items
    if (kept.kind !== 'text') throw new Error('a text item')
    expect(kept.markdown.length).toBeLessThanOrEqual(MIB_BYTES)
    expect(kept.markdown.length).toBeGreaterThan(0)
    expect(markdown.endsWith(kept.markdown)).toBe(true)
    expect(parseChatPush(out)).not.toBeNull()
  })

  it('a newest event item of 6 MiB of escapes keeps its kind, its body cut to the tail, and the cut fits the push', () => {
    // a body the host can make (under the 1 MiB text cap), heavy with control characters that take six bytes each as JSON
    const body = '\u0001'.repeat(999_000) + 'END'
    const event: ChatItem = { kind: 'event', id: 'e', source: 'task', title: 'Agent finished', status: null, body }
    const out = capSnapshot(snapshot([notice('older'), event]), MAX_CHAT_PUSH_BYTES)
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(MAX_CHAT_PUSH_BYTES)
    expect(out.hasOlder).toBe(true)
    const [kept] = out.items
    if (kept.kind !== 'event') throw new Error('the newest item is the event')
    expect(kept).toMatchObject({ source: 'task', title: 'Agent finished', status: null })
    expect(body.endsWith(kept.body)).toBe(true)
    expect(parseChatPush(out)).not.toBeNull()
  })

  it('an event whose title is past the title cap is cut to the cap, and its body keeps the rest of the budget', () => {
    const body = 'b'.repeat(4000) + 'END'
    const event: ChatItem = { kind: 'event', id: 'e', source: 'task', title: 'T'.repeat(SUBJECT_CAP * 3), status: null, body }
    const [kept] = capItems([event], 1200).items
    if (kept.kind !== 'event') throw new Error('the item is an event')
    expect(kept.title).toBe('T'.repeat(SUBJECT_CAP))
    expect(kept.body.length).toBeGreaterThan(0)
    expect(body.endsWith(kept.body)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(1200)
  })

  it('the walk stringifies the items it keeps and the one that does not fit, never the whole page', () => {
    const items = Array.from({ length: 2000 }, (_, i) => notice(`n${i}`, 'x'.repeat(10 * 1024)))
    const spy = vi.spyOn(JSON, 'stringify')
    try {
      const out = capSnapshot(snapshot(items), 2 * MIB_BYTES)
      const stringified = spy.mock.results.reduce((n, r) => n + (typeof r.value === 'string' ? r.value.length : 0), 0)
      expect(stringified).toBeLessThan(2 * MIB_BYTES + 64 * 1024)
      expect(out.items.at(-1)).toEqual(items[1999])
      expect(out.hasOlder).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe("a member's mirror keeps the newest page of the chat", () => {
  it('5 000 adds leave at most 200 items, the newest kept, hasOlder set; a set for an item trimmed away changes nothing', () => {
    const mirror = new ChatMirror()
    mirror.load(snapshot([], 0))
    for (let i = 0; i < 5000; i++) expect(mirror.apply(i, i + 1, [{ op: 'add', item: notice(`n${i}`) }])).toBe(true)
    const s = mirror.snapshot()
    expect(s?.items.length).toBeLessThanOrEqual(200)
    expect(s?.hasOlder).toBe(true)
    expect(s?.items.at(-1)).toEqual(notice('n4999'))
    expect(s?.items[0]).toEqual(notice(`n${5000 - (s?.items.length ?? 0)}`))
    expect(mirror.apply(5000, 5001, [{ op: 'set', item: notice('n0', 'changed') }])).toBe(true)
    expect(mirror.snapshot()?.items).toEqual(s?.items)
  })
})

describe('parseChatPush', () => {
  it('accepts a snapshot of valid items and a patch batch', () => {
    expect(parseChatPush(snapshot([notice('a'), text('b'), tools('c')], 3))).toEqual({ snapshot: snapshot([notice('a'), text('b'), tools('c')], 3) })
    const batch = { fromRev: 3, toRev: 5, patches: [{ op: 'remove', id: 'a' }, { op: 'state', state: STATE }] }
    expect(parseChatPush(batch)).toEqual(batch)
  })

  it('a notice carries the line it opens in the terminal: a text of the output cap, or none', () => {
    const open = (line: unknown): ChatItem => ({ ...notice('a'), action: 'open-terminal', line } as unknown as ChatItem)
    expect(parseChatPush(snapshot([open('/review focus')]))).not.toBeNull()
    expect(parseChatPush(snapshot([open(null)]))).not.toBeNull()
    expect(parseChatPush(snapshot([notice('a')]))).not.toBeNull()
    expect(parseChatPush(snapshot([open('x'.repeat(64 * 1024 + 1))]))).toBeNull()
    expect(parseChatPush(snapshot([open(42)]))).toBeNull()
  })

  it('refuses a patch batch whose revisions do not count its patches', () => {
    expect(parseChatPush({ fromRev: 3, toRev: 6, patches: [{ op: 'remove', id: 'a' }] })).toBeNull()
  })

  it('drops a batch with a patch of an unknown op', () => {
    expect(parseChatPush({ fromRev: 0, toRev: 2, patches: [{ op: 'remove', id: 'a' }, { op: 'older', items: [] }] })).toBeNull()
  })

  it('drops a batch of more than 500 patches', () => {
    const patches = Array.from({ length: 501 }, (_, i) => ({ op: 'remove', id: `a${i}` }))
    expect(parseChatPush({ fromRev: 0, toRev: 501, patches })).toBeNull()
    expect(parseChatPush({ fromRev: 0, toRev: 500, patches: patches.slice(0, 500) })).not.toBeNull()
  })

  it('drops an item with a text of 2 MiB', () => {
    expect(parseChatPush(snapshot([text('a', 'x'.repeat(2 * 1024 * 1024))]))).toBeNull()
    expect(parseChatPush(snapshot([text('a', 'x'.repeat(1024 * 1024))]))).not.toBeNull()
  })

  it('drops a snapshot of 2 001 items and keeps one of 2 000', () => {
    const items = (n: number): ChatItem[] => Array.from({ length: n }, (_, i) => notice(`n${i}`))
    expect(parseChatPush(snapshot(items(2001)))).toBeNull()
    expect(parseChatPush(snapshot(items(2000)))).not.toBeNull()
  })

  it('drops a tool output over 64 KiB, a subject over 500 characters and a model over 200', () => {
    const withCall = (over: Record<string, unknown>): unknown => snapshot([{ kind: 'tools', id: 't', calls: [call('c', over)], ms: null }])
    expect(parseChatPush(withCall({ output: 'x'.repeat(64 * 1024 + 1) }))).toBeNull()
    expect(parseChatPush(withCall({ output: 'x'.repeat(64 * 1024) }))).not.toBeNull()
    expect(parseChatPush(withCall({ subject: 'x'.repeat(501) }))).toBeNull()
    expect(parseChatPush({ ...snapshot([]), state: { ...STATE, model: 'x'.repeat(201) } })).toBeNull()
  })

  it('a state with a compaction or restart activity passes; an unknown kind or no time is dropped; a state without the field passes', () => {
    const withActivity = (activity: unknown): unknown => ({ ...snapshot([]), state: { ...STATE, activity } })
    expect(parseChatPush(withActivity({ kind: 'compacting', since: 1000 }))).not.toBeNull()
    expect(parseChatPush(withActivity({ kind: 'restarting', since: 1000 }))).not.toBeNull()
    expect(parseChatPush(withActivity({ kind: 'napping', since: 1000 }))).toBeNull()
    expect(parseChatPush(withActivity({ kind: 'compacting' }))).toBeNull()
    expect(parseChatPush(snapshot([]))).not.toBeNull()
  })

  it('drops a card whose string is over 64 KiB', () => {
    const card = (plan: string): unknown => snapshot([{ kind: 'card', id: 'k', card: { type: 'plan', plan }, answered: null }])
    expect(parseChatPush(card('x'.repeat(64 * 1024 + 1)))).toBeNull()
    expect(parseChatPush(card('x'.repeat(1000)))).not.toBeNull()
  })

  it('a call patch is checked like the other ops: a bad state drops the batch, a good one passes', () => {
    expect(parseChatPush({ fromRev: 0, toRev: 1, patches: [{ op: 'call', id: 't', call: call('c', { state: 'queued' }) }] })).toBeNull()
    expect(parseChatPush({ fromRev: 0, toRev: 1, patches: [{ op: 'call', id: 't', call: call('c') }] })).not.toBeNull()
  })

  it('a value that is not a push, or a field of the wrong type, is null and never throws', () => {
    for (const bad of [null, 5, 'x', [], {}, { ...snapshot([]), rev: -1 }, { ...snapshot([]), items: 'x' }, { ...snapshot([]), hasOlder: 'no' }, { fromRev: 'a', toRev: 1, patches: [] }]) {
      expect(parseChatPush(bad)).toBeNull()
    }
  })
})

describe('ChatMirror', () => {
  it('has no snapshot until one is loaded, and a patch batch before that is refused', () => {
    const m = new ChatMirror()
    expect(m.snapshot()).toBeNull()
    expect(m.apply(0, 1, [{ op: 'remove', id: 'a' }])).toBe(false)
  })

  it('applies the patches of each batch in order and moves the revision to toRev', () => {
    const m = new ChatMirror()
    m.load(snapshot([notice('a')], 1))
    const patches: ChatPatch[] = [
      { op: 'add', item: text('t', 'Hi') }, { op: 'append', id: 't', text: ' there' }, { op: 'remove', id: 'a' },
      { op: 'state', state: { ...STATE, turn: 'working' } }
    ]
    expect(m.apply(1, 5, patches)).toBe(true)
    expect(m.snapshot()).toEqual(snapshot([text('t', 'Hi there')], 5, { state: { ...STATE, turn: 'working' } }))
  })

  it('set, call and reset take their patches', () => {
    const m = new ChatMirror()
    m.load(snapshot([tools('t')], 0))
    expect(m.apply(0, 3, [
      { op: 'call', id: 't', call: call('c1') }, { op: 'call', id: 't', call: call('c1', { state: 'done' }) }, { op: 'set', item: tools('t2') }
    ])).toBe(true)
    expect(m.snapshot()?.items).toEqual([{ kind: 'tools', id: 't', calls: [call('c1', { state: 'done' })], ms: null }])
    expect(m.apply(3, 4, [{ op: 'reset', items: [notice('r')], hasOlder: true }])).toBe(true)
    expect(m.snapshot()).toEqual(snapshot([notice('r')], 4, { hasOlder: true }))
  })

  it('a gap is refused and leaves the mirror as it was', () => {
    const m = new ChatMirror()
    m.load(snapshot([notice('a')], 2))
    expect(m.apply(5, 7, [{ op: 'remove', id: 'a' }, { op: 'remove', id: 'a' }])).toBe(false)
    expect(m.snapshot()).toEqual(snapshot([notice('a')], 2))
  })

  it('a batch the mirror already has is ignored', () => {
    const m = new ChatMirror()
    m.load(snapshot([notice('a')], 5))
    expect(m.apply(3, 5, [{ op: 'remove', id: 'a' }, { op: 'remove', id: 'a' }])).toBe(true)
    expect(m.snapshot()).toEqual(snapshot([notice('a')], 5))
  })

  it('a batch straddling the mirror revision (rev 5, batch 3 to 8 with 5 patches) applies only its last 3 patches', () => {
    const m = new ChatMirror()
    m.load(snapshot([], 5))
    const patches: ChatPatch[] = ['p0', 'p1', 'p2', 'p3', 'p4'].map((id) => ({ op: 'add', item: notice(id) }))
    expect(m.apply(3, 8, patches)).toBe(true)
    expect(m.snapshot()?.items.map((i) => i.id)).toEqual(['p2', 'p3', 'p4'])
    expect(m.snapshot()?.rev).toBe(8)
  })

  it('a mirror that held the old conversation takes a new chat\'s reset, which starts at its revision', () => {
    const m = new ChatMirror()
    m.load(snapshot([notice('old-1'), text('old-2')], 9))
    expect(m.apply(9, 10, [{ op: 'reset', items: [notice('starting')], hasOlder: false }])).toBe(true)
    expect(m.snapshot()).toEqual(snapshot([notice('starting')], 10))
  })

  it('a load replaces what the mirror held', () => {
    const m = new ChatMirror()
    m.load(snapshot([notice('a')], 1))
    m.load(snapshot([notice('b')], 7))
    expect(m.snapshot()).toEqual(snapshot([notice('b')], 7))
  })

  it('snapshot() is a copy: changing what it returns leaves the mirror, and what a later apply makes of it, as they were', () => {
    const m = new ChatMirror()
    m.load(snapshot([text('t', 'Hi')], 2))
    const first = m.snapshot()!
    first.items.push(notice('extra'))
    first.state.turn = 'working'
    ;(first.items[0] as { markdown: string }).markdown = 'changed'
    expect(m.snapshot()).toEqual(snapshot([text('t', 'Hi')], 2))
    expect(m.apply(2, 3, [{ op: 'append', id: 't', text: '!' }])).toBe(true)
    expect(first.items).toHaveLength(2)
    expect(first.rev).toBe(2)
    expect(m.snapshot()).toEqual(snapshot([text('t', 'Hi!')], 3))
  })

  it('load keeps no link to the snapshot it was given', () => {
    const m = new ChatMirror()
    const given = snapshot([notice('a')], 1)
    m.load(given)
    given.items.push(notice('b'))
    expect(m.snapshot()).toEqual(snapshot([notice('a')], 1))
  })

  it('append to a non-text item, and set or remove of a missing id, leave the mirror unchanged', () => {
    const m = new ChatMirror()
    m.load(snapshot([tools('t'), notice('n')], 0))
    expect(m.apply(0, 3, [
      { op: 'append', id: 't', text: 'x' }, { op: 'set', item: notice('ghost') }, { op: 'remove', id: 'ghost' }
    ])).toBe(true)
    expect(m.snapshot()).toEqual(snapshot([tools('t'), notice('n')], 3))
  })
})

describe('the snapshot of a chat with every kind of item', () => {
  it('a snapshot with user attachments, images, thinking, command, divider and one card of each kind is accepted', () => {
    const items: ChatItem[] = [
      { kind: 'user', id: 'u1', text: 'Look', attachments: [{ kind: 'image', path: 'C:\\a\\s.png', name: 's.png', size: 9, cardId: 'c1' }], queued: false },
      { kind: 'images', id: 'i1', images: [{ path: 'C:\\a\\s.png', cardId: null }] },
      { kind: 'thinking', id: 'th1', ms: 12, summary: null },
      { kind: 'command', id: 'cm1', command: '/context', output: 'ok' },
      { kind: 'divider', id: 'dv1', text: 'New conversation' },
      { kind: 'card', id: 'k1', answered: null, card: { type: 'permission', tool: 'Edit', title: 'Claude wants to edit', subject: 'a.ts', description: null,
        diff: { path: 'a.ts', before: 'x', after: 'y' }, suggestions: [{ index: 0, label: 'Always' }], defaultToNo: false } },
      { kind: 'card', id: 'k2', answered: 'You answered: A', card: { type: 'question', questions: [{ question: 'Which?', header: 'H', multiSelect: false, options: [{ label: 'A', description: '' }] }] } },
      { kind: 'card', id: 'k3', answered: null, card: { type: 'plan', plan: 'Step 1' } },
      { kind: 'card', id: 'k4', answered: null, card: { type: 'dialog', kind: 'k', title: 'T', text: 'x', choices: [{ id: 'c', label: 'OK' }] } }
    ]
    expect(parseChatPush(snapshot(items, 9))).toEqual({ snapshot: snapshot(items, 9) })
  })
})

describe('parseChatPush never throws', () => {
  it('a value with a __proto__ key from JSON, a 10 000-deep object and a 501-patch array are refused, not thrown on', () => {
    const proto = JSON.parse('{"__proto__":{"x":1}}') as unknown
    expect(() => parseChatPush(proto)).not.toThrow()
    expect(parseChatPush(proto)).toBeNull()
    let deep: Record<string, unknown> = {}
    for (let i = 0; i < 10_000; i++) deep = { a: deep }
    expect(() => parseChatPush(deep)).not.toThrow()
    expect(parseChatPush(deep)).toBeNull()
    expect(() => parseChatPush({ fromRev: 0, toRev: 501, patches: Array.from({ length: 501 }, () => ({ op: 'remove', id: 'a' })) })).not.toThrow()
    expect(parseChatPush({ fromRev: 0, toRev: 501, patches: Array.from({ length: 501 }, () => ({ op: 'remove', id: 'a' })) })).toBeNull()
  })
})

describe('the field caps match the host, which produces the values', () => {
  it('an attachment name of 600 characters is accepted, as the host allows a name of up to 4096', () => {
    const item: ChatItem = { kind: 'user', id: 'u', text: 'x', attachments: [{ kind: 'file', path: '/a/b', name: 'n'.repeat(600), size: 1, cardId: null }], queued: false }
    expect(parseChatPush(snapshot([item]))).not.toBeNull()
  })

  it('an attachment card id of 65 characters is refused, as the host allows 64', () => {
    const att = (cardId: string): ChatItem => ({ kind: 'user', id: 'u', text: 'x', attachments: [{ kind: 'file', path: '/a/b', name: 'b', size: 1, cardId }], queued: false })
    expect(parseChatPush(snapshot([att('c'.repeat(64))]))).not.toBeNull()
    expect(parseChatPush(snapshot([att('c'.repeat(65))]))).toBeNull()
  })

  it('a command of 500 characters is accepted (the host keeps its first word, at most 500), one of 501 refused', () => {
    const item = (command: string): ChatItem => ({ kind: 'command', id: 'c', command, output: '' })
    expect(parseChatPush(snapshot([item('/' + 'x'.repeat(499))]))).not.toBeNull()
    expect(parseChatPush(snapshot([item('/' + 'x'.repeat(500))]))).toBeNull()
  })

  it('a suggestion label of 500 characters is accepted, 501 refused (the host cuts a label to 500)', () => {
    const card = (label: string): ChatItem => ({ kind: 'card', id: 'k', answered: null, card: { type: 'permission', tool: 'Bash', title: 't', subject: 's',
      description: null, diff: null, suggestions: [{ index: 0, label }], defaultToNo: false } })
    expect(parseChatPush(snapshot([card('x'.repeat(500))]))).not.toBeNull()
    expect(parseChatPush(snapshot([card('x'.repeat(501))]))).toBeNull()
  })

  it('a diff path of 5 000 characters is accepted (the host cuts a card string to 64 KiB)', () => {
    const card: ChatItem = { kind: 'card', id: 'k', answered: null, card: { type: 'permission', tool: 'Edit', title: 't', subject: 's',
      description: null, diff: { path: 'p'.repeat(5000), before: '', after: '' }, suggestions: [], defaultToNo: false } }
    expect(parseChatPush(snapshot([card]))).not.toBeNull()
  })
})
