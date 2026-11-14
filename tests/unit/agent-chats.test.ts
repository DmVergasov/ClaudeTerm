import { describe, expect, it } from 'vitest'
import { AgentChats, AgentModel, MAX_AGENT_ITEMS, MAX_AGENT_RECORDS, frameKeys, isSubagentFrame, type AgentChange } from '../../src/main/chat/agent-chats'
import { OUTPUT_CAP } from '../../src/main/chat/chat-fold'
import type { ChatItem } from '../../src/shared/chat'

type Obj = Record<string, unknown>

const MIB = 1024 * 1024

/** the chats of one chat tab: a clock the test moves, sequential ids, and every agent's count starts at firstRev */
function chats(firstRev = 0): { c: AgentChats; clock: { t: number } } {
  const clock = { t: 0 }
  let n = 0
  const c = new AgentChats({ now: () => clock.t, newId: () => `id${++n}`, folder: () => '/work/acme', firstRev })
  return { c, clock }
}

/** a frame as Claude Code sends it: its agent_id (null: none) and the Agent call it runs under (parent_tool_use_id, null: none) */
function frame(type: 'assistant' | 'user', agent: string | null, content: unknown[], call: string | null = null): Obj {
  return {
    type,
    message: { role: type, content },
    ...(agent === null ? {} : { agent_id: agent }),
    ...(call === null ? {} : { parent_tool_use_id: call }),
    session_id: 'session-1',
  }
}

const text = (t: string): Obj => ({ type: 'text', text: t })
/** one text reply of an agent */
const says = (agent: string | null, t: string, call: string | null = null): Obj => frame('assistant', agent, [text(t)], call)
/** a message an agent receives: a user text frame */
const asks = (agent: string, t: string): Obj => frame('user', agent, [text(t)])

/** the task_started Claude Code sends for an agent, naming the call it runs under */
function started(task: string, call: string | null, description = 'Look', type = 'Explore'): Obj {
  return {
    type: 'system', subtype: 'task_started', task_id: task, ...(call === null ? {} : { tool_use_id: call }),
    description, subagent_type: type, task_type: 'local_agent', run_id: `run_${task}`,
  }
}

/** the task_notification of an agent that ended, its duration in usage.duration_ms when given */
function ended(task: string, status: string, duration?: number): Obj {
  return {
    type: 'system', subtype: 'task_notification', task_id: task, status, output_file: '',
    summary: 'Look', ...(duration === undefined ? {} : { usage: { total_tokens: 0, tool_uses: 0, duration_ms: duration } }),
  }
}

/** the items of an agent's page, none when it has no page */
function itemsOf(c: AgentChats, agent: string): ChatItem[] {
  return c.page(agent)?.items ?? []
}

/** the texts of the dividers on an agent's page */
function dividersOf(c: AgentChats, agent: string): string[] {
  return itemsOf(c, agent).flatMap(item => (item.kind === 'divider' ? [item.text] : []))
}

describe('AgentChats', () => {
  it('a frame reaches its agent by agent_id', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'), 'session-1')
    const changes = c.apply(says('task_a', 'Hello'), 'session-1')
    expect(changes).toEqual([{
      agentId: 'task_a', fromRev: 0, toRev: 1,
      patches: [{ op: 'add', item: expect.objectContaining({ kind: 'text', markdown: 'Hello' }) }],
    }])
    expect(itemsOf(c, 'task_a')).toEqual([expect.objectContaining({ kind: 'text', markdown: 'Hello' })])
    expect(c.sessionOf('task_a')).toBe('session-1')
    expect(c.info('task_a')).toMatchObject({ type: 'Explore', description: 'Look', state: 'running', parentId: null })
  })

  it('a frame without agent_id reaches its agent through parent_tool_use_id', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'))
    const changes = c.apply(says(null, 'By call', 'toolu_a'))
    expect(changes.map(change => change.agentId)).toEqual(['task_a'])
    expect(itemsOf(c, 'task_a')).toEqual([expect.objectContaining({ kind: 'text', markdown: 'By call' })])
  })

  it('frames before task_started wait in the buffer and arrive when it names them', () => {
    const { c } = chats()
    expect(c.apply(says(null, 'early', 'toolu_a'), 'session-1')).toEqual([])
    expect(c.page('task_a')).toBeNull()
    const changes = c.apply(started('task_a', 'toolu_a'), 'session-1')
    expect(changes).toEqual([{
      agentId: 'task_a', fromRev: 0, toRev: 1,
      patches: [{ op: 'add', item: expect.objectContaining({ kind: 'text', markdown: 'early' }) }],
    }])
    expect(itemsOf(c, 'task_a')).toHaveLength(1)
  })

  it('the buffer keeps at most 200 frames', () => {
    const { c } = chats()
    for (let i = 0; i < 205; i++) c.apply(says(null, `t${i}`, 'toolu_a'))
    c.apply(started('task_a', 'toolu_a'))
    const items = itemsOf(c, 'task_a')
    expect(items).toHaveLength(200)
    expect(items[0]).toMatchObject({ kind: 'text', markdown: 't5' })
    expect(items.at(-1)).toMatchObject({ kind: 'text', markdown: 't204' })
  })

  it('a frame with agent_id before task_started makes its agent at once, and task_started names it', () => {
    const { c } = chats()
    c.apply(says('task_a', 'first'), 'session-1')
    expect(c.info('task_a')).toEqual({ id: 'task_a', type: 'agent', description: '', state: 'running', startedAt: 0, ms: null, parentId: null })
    c.apply(started('task_a', 'toolu_a', 'Find files', 'Explore'), 'session-1')
    expect(c.info('task_a')).toMatchObject({ type: 'Explore', description: 'Find files', state: 'running', parentId: null })
    expect(itemsOf(c, 'task_a')).toHaveLength(1)
  })

  it('a frame whose agent_id fails the pattern is dropped', () => {
    const { c } = chats()
    expect(c.apply(says('bad id!', 'x'), 'session-1')).toEqual([])
    expect(c.apply(says('../escape', 'x', 'toolu_a'), 'session-1')).toEqual([])
    expect(c.apply({ ...says(null, 'x'), agent_id: 7 }, 'session-1')).toEqual([])
    expect(c.info('bad id!')).toBeNull()
    expect(c.info('../escape')).toBeNull()
    expect(c.maxRev()).toBe(0)
  })

  it('the first user text is Claude asked, later ones From Claude', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'))
    c.apply(asks('task_a', 'Find the bug'))
    c.apply(asks('task_a', 'And the test'))
    expect(itemsOf(c, 'task_a')).toEqual([
      expect.objectContaining({ kind: 'prompt', text: 'Find the bug', first: true }),
      expect.objectContaining({ kind: 'prompt', text: 'And the test', first: false }),
    ])
  })

  it('a new agent\'s page starts with Claude asked from its task_started prompt', () => {
    const { c } = chats()
    c.apply({ ...started('task_a', 'toolu_a'), prompt: 'Find the bug' })
    expect(itemsOf(c, 'task_a')).toEqual([expect.objectContaining({ kind: 'prompt', text: 'Find the bug', first: true })])
    c.apply(asks('task_a', 'And the test'))
    expect(itemsOf(c, 'task_a')).toEqual([
      expect.objectContaining({ kind: 'prompt', text: 'Find the bug', first: true }),
      expect.objectContaining({ kind: 'prompt', text: 'And the test', first: false }),
    ])
  })

  it('a resume\'s task_started prompt adds no Claude asked', () => {
    const { c } = chats()
    c.apply({ ...started('task_a', 'toolu_a'), prompt: 'Find the bug' })
    c.apply(ended('task_a', 'completed'))
    c.apply({ ...started('task_a', 'toolu_a'), prompt: 'Forwarded message' })
    expect(itemsOf(c, 'task_a').flatMap(item => (item.kind === 'prompt' ? [item.text] : []))).toEqual(['Find the bug'])
    expect(dividersOf(c, 'task_a')).toContain('Resumed')
  })

  it('the transcript\'s prompt line is not added again after a task_started prompt', () => {
    const { c } = chats()
    c.apply({ ...started('task_a', 'toolu_a'), prompt: 'Find the bug' })
    c.history('task_a', {
      lines: [
        { type: 'user', uuid: 'u0', message: { role: 'user', content: 'Find the bug' } },
        { type: 'assistant', uuid: 'u1', message: { id: 'msg_1', role: 'assistant', content: [text('Found it')] } },
      ],
      start: 0,
    })
    expect(itemsOf(c, 'task_a')).toEqual([
      expect.objectContaining({ kind: 'prompt', text: 'Find the bug', first: true }),
      expect.objectContaining({ kind: 'text', markdown: 'Found it' }),
    ])
  })

  it('frames before task_started come after the prompt', () => {
    const { c } = chats()
    c.apply(says(null, 'early words', 'toolu_a'))
    c.apply({ ...started('task_a', 'toolu_a'), prompt: 'Find the bug' })
    expect(itemsOf(c, 'task_a').map(item => (item.kind === 'text' ? item.markdown : item.kind === 'prompt' ? item.text : item.kind))).toEqual(['Find the bug', 'early words'])
  })

  it('an agent that its frames made before task_started gets the prompt first too', () => {
    const { c } = chats()
    c.apply(says('task_a', 'early words'))
    c.apply({ ...started('task_a', 'toolu_a'), prompt: 'Find the bug' })
    expect(itemsOf(c, 'task_a').map(item => (item.kind === 'text' ? item.markdown : item.kind === 'prompt' ? item.text : item.kind))).toEqual(['Find the bug', 'early words'])
    expect(itemsOf(c, 'task_a')[0]).toEqual(expect.objectContaining({ kind: 'prompt', first: true }))
  })

  it('a resume adds Resumed and sets the agent running', () => {
    const { c, clock } = chats()
    c.apply(started('task_a', 'toolu_a'))
    clock.t = 1000
    c.apply(ended('task_a', 'completed', 5000))
    clock.t = 9000
    const changes = c.apply(started('task_a', 'toolu_a'))
    expect(c.info('task_a')).toMatchObject({ state: 'running', startedAt: 9000, ms: null })
    expect(changes).toHaveLength(1)
    expect(changes[0]!.patches.map(p => p.op)).toEqual(['add', 'agent'])
    expect(itemsOf(c, 'task_a').at(-1)).toMatchObject({ kind: 'divider', text: 'Resumed' })
  })

  it('an end adds its divider: Agent finished · 1m 12s, Agent failed, Agent stopped', () => {
    const { c } = chats()
    c.apply(started('task_done', 'toolu_1'))
    c.apply(started('task_failed', 'toolu_2'))
    c.apply(started('task_stopped', 'toolu_3'))
    c.apply(ended('task_done', 'completed', 72000))
    c.apply(ended('task_failed', 'failed'))
    c.apply(ended('task_stopped', 'stopped'))
    expect(dividersOf(c, 'task_done')).toEqual(['Agent finished · 1m 12s'])
    expect(c.info('task_done')).toMatchObject({ state: 'done', ms: 72000 })
    expect(dividersOf(c, 'task_failed')).toEqual(['Agent failed'])
    expect(c.info('task_failed')).toMatchObject({ state: 'failed' })
    expect(dividersOf(c, 'task_stopped')).toEqual(['Agent stopped'])
    expect(c.info('task_stopped')).toMatchObject({ state: 'stopped' })
  })

  it('an agent started by an agent has its own model, its parent, and a row in the parent\'s step', () => {
    const { c } = chats()
    c.apply(started('task_parent', 'toolu_main'))
    c.apply(frame('assistant', 'task_parent', [{ type: 'tool_use', id: 'toolu_child', name: 'Agent', input: { description: 'Sub', subagent_type: 'Explore' } }], 'toolu_main'))
    const changes = c.apply(started('task_child', 'toolu_child', 'Sub'))
    expect(c.info('task_child')).toMatchObject({ parentId: 'task_parent', description: 'Sub' })
    expect(changes.map(change => change.agentId)).toEqual(['task_parent'])
    c.apply(says('task_child', 'child says', 'toolu_child'))
    expect(itemsOf(c, 'task_child')).toEqual([expect.objectContaining({ kind: 'text', markdown: 'child says' })])
    const step = itemsOf(c, 'task_parent').find(item => item.kind === 'tools')
    expect(step).toMatchObject({ kind: 'tools', calls: [expect.objectContaining({ id: 'toolu_child', agents: [expect.objectContaining({ id: 'task_child' })] })] })
  })

  it('an agent holds at most 1,000 items, and says it has older ones', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'))
    for (let i = 0; i < MAX_AGENT_ITEMS + 5; i++) c.apply(says('task_a', `t${i}`))
    const page = c.page('task_a')
    expect(page?.hasOlder).toBe(true)
    expect(page?.items).toHaveLength(200)
    expect(page?.items.at(-1)).toMatchObject({ kind: 'text', markdown: `t${MAX_AGENT_ITEMS + 4}` })

    const model = new AgentModel({ now: () => 0, newId: (() => { let n = 0; return () => `m${++n}` })(), folder: () => '/work/acme' })
    for (let i = 0; i < MAX_AGENT_ITEMS + 5; i++) model.apply(says(null, `t${i}`))
    expect(model.items()).toHaveLength(MAX_AGENT_ITEMS)
    expect(model.items()[0]).toMatchObject({ kind: 'text', markdown: 't5' })
  })

  it('text over 1 MiB and outputs over 64 KiB are capped', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'))
    c.apply(says('task_a', 'x'.repeat(MIB + 10)))
    c.apply(frame('assistant', 'task_a', [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'ls' } }]))
    c.apply(frame('user', 'task_a', [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'y'.repeat(70 * 1024) }]))
    const [reply, step] = itemsOf(c, 'task_a')
    expect(reply).toMatchObject({ kind: 'text' })
    expect(reply?.kind === 'text' ? reply.markdown.length : -1).toBe(MIB)
    const call = step?.kind === 'tools' ? step.calls[0] : undefined
    expect(call).toMatchObject({ state: 'done' })
    expect(call?.output?.length).toBe(64 * 1024)
  })

  it('past 50 models the ended unwatched agent touched least recently is evicted, never a running or a watched one', () => {
    const { c } = chats()
    // the watched agent is ended and the least recently touched of all: a watch that is not honoured would take it first
    c.apply(started('w', 'toolu_w'))
    c.apply(says('w', 'watched'))
    c.apply(ended('w', 'completed', 1000))
    c.watch('w', true)
    c.apply(started('e1', 'toolu_e1'))
    c.apply(says('e1', 'first'))
    c.apply(ended('e1', 'completed', 1000))
    c.apply(started('e2', 'toolu_e2'))
    c.apply(says('e2', 'second'))
    c.apply(ended('e2', 'completed', 1000))
    // 47 running agents: 50 models hold items
    for (let i = 0; i < 47; i++) {
      c.apply(started(`fill${i}`, `toolu_fill${i}`))
      c.apply(says(`fill${i}`, 'working'))
    }
    // a 51st model: e1, the next least recently touched ended one, goes; its record stays and it needs its history
    c.apply(says('new', 'hello'))
    expect(itemsOf(c, 'e1')).toEqual([])
    expect(c.needsHistory('e1')).toBe(true)
    expect(c.info('e1')).toMatchObject({ state: 'done', ms: 1000 })
    expect(itemsOf(c, 'e2')).not.toEqual([])
    expect(itemsOf(c, 'w')).not.toEqual([])
    expect(c.needsHistory('w')).toBe(false)
    expect(itemsOf(c, 'fill0')).not.toEqual([])
  })

  it('an agent unwatched is evictable again', () => {
    const { c } = chats()
    c.apply(started('w', 'toolu_w'))
    c.apply(says('w', 'kept'))
    c.apply(ended('w', 'completed', 1000))
    c.watch('w', true)
    c.watch('w', false)
    // w and 49 running agents hold items: the 51st model takes w, the only ended one
    for (let i = 0; i < 49; i++) {
      c.apply(started(`fill${i}`, `toolu_fill${i}`))
      c.apply(says(`fill${i}`, 'working'))
    }
    c.apply(says('new', 'hello'))
    expect(itemsOf(c, 'w')).toEqual([])
    expect(c.needsHistory('w')).toBe(true)
  })

  it('past 100 models holding items with all running, the least recently touched unwatched one loses its items', () => {
    const { c } = chats()
    for (let i = 0; i < 110; i++) {
      c.apply(started(`run${i}`, `toolu_${i}`))
      c.apply(says(`run${i}`, 'working'))
    }
    expect(itemsOf(c, 'run0')).toEqual([])
    expect(c.needsHistory('run0')).toBe(true)
    expect(c.info('run0')).toMatchObject({ state: 'running' })
    expect(itemsOf(c, 'run109')).not.toEqual([])
  })

  it('an evicted agent that is asked again gets a later prompt, not a first one, and says it has older items', () => {
    const { c } = chats()
    c.apply(started('run0', 'toolu_0'))
    c.apply(asks('run0', 'Find the bug'))
    for (let i = 1; i < 110; i++) {
      c.apply(started(`run${i}`, `toolu_${i}`))
      c.apply(says(`run${i}`, 'working'))
    }
    expect(itemsOf(c, 'run0')).toEqual([])
    expect(c.page('run0')?.hasOlder).toBe(true)
    c.apply(asks('run0', 'And now'))
    expect(itemsOf(c, 'run0')).toEqual([expect.objectContaining({ kind: 'prompt', text: 'And now', first: false })])
  })

  it('past 500 agents the least recently touched unwatched one is forgotten whole', () => {
    const { c } = chats()
    for (let i = 0; i <= MAX_AGENT_RECORDS; i++) c.apply(says(`task_${i}`, 'x'))
    expect(c.info('task_0')).toBeNull()
    expect(c.page('task_0')).toBeNull()
    expect(c.info('task_1')).not.toBeNull()
    expect(c.info(`task_${MAX_AGENT_RECORDS}`)).not.toBeNull()
  })

  it('a forgotten agent that comes back counts its revisions on from the highest one handed out', () => {
    const { c } = chats()
    for (let i = 0; i < 3; i++) c.apply(says('task_a', `a${i}`))
    for (let i = 0; i < MAX_AGENT_RECORDS; i++) c.apply(says(`task_${i}`, 'x'))
    expect(c.info('task_a')).toBeNull()
    const back = c.apply(says('task_a', 'back'))
    expect(back).toHaveLength(1)
    expect(back[0]!.fromRev).toBeGreaterThanOrEqual(3)
    expect(back[0]!.toRev).toBeGreaterThan(back[0]!.fromRev)
    expect(c.maxRev()).toBeGreaterThanOrEqual(back[0]!.toRev)
  })

  it('a frame naming an agent of any type is a subagent\'s, and a malformed agent_id is dropped', () => {
    const { c } = chats()
    expect(isSubagentFrame({ type: 'assistant', agent_id: 7, message: {} })).toBe(true)
    expect(isSubagentFrame({ type: 'user', agent_id: '', message: {} })).toBe(true)
    expect(c.apply({ type: 'assistant', agent_id: 7, message: { content: [text('leak')] } }, 'session-1')).toEqual([])
    expect(c.maxRev()).toBe(0)
  })

  it('a stream event gives no agent, no record and no buffered frame', () => {
    const { c } = chats()
    const event = { type: 'stream_event', event: { type: 'message_start' }, session_id: 'session-1' }
    expect(c.apply({ ...event, agent_id: 'task_s' }, 'session-1')).toEqual([])
    expect(c.info('task_s')).toBeNull()
    expect(c.page('task_s')).toBeNull()
    for (let i = 0; i < 200; i++) c.apply({ type: 'assistant', message: { content: [text(`t${i}`)] }, parent_tool_use_id: 'toolu_a' })
    for (let i = 0; i < 300; i++) c.apply({ ...event, parent_tool_use_id: 'toolu_a' })
    c.apply(started('task_a', 'toolu_a'))
    const items = itemsOf(c, 'task_a')
    expect(items).toHaveLength(200)
    expect(items[0]).toMatchObject({ kind: 'text', markdown: 't0' })
  })

  it('a hostile parent_tool_use_id is a plain key: __proto__ and ../x route like any other call', () => {
    const { c } = chats()
    c.apply(says(null, 'early', '__proto__'))
    c.apply(says(null, 'early two', '../x'))
    c.apply(started('task_p', '__proto__'))
    c.apply(started('task_x', '../x'))
    expect(itemsOf(c, 'task_p')).toEqual([expect.objectContaining({ kind: 'text', markdown: 'early' })])
    expect(itemsOf(c, 'task_x')).toEqual([expect.objectContaining({ kind: 'text', markdown: 'early two' })])
    expect(c.info('__proto__')).toBeNull()
  })

  it('a late tool result for a call the item cap dropped gives no change and does not throw', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'))
    c.apply(frame('assistant', 'task_a', [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'ls' } }]))
    for (let i = 0; i < MAX_AGENT_ITEMS; i++) c.apply(says('task_a', `t${i}`))
    expect(itemsOf(c, 'task_a').some(item => item.kind === 'tools')).toBe(false)
    const late = frame('user', 'task_a', [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'out' }])
    expect(() => c.apply(late, 'session-1')).not.toThrow()
    expect(c.apply(late, 'session-1')).toEqual([])
  })

  it('an agent counts its revisions from firstRev, and one made later from the highest revision handed out', () => {
    const { c } = chats(100)
    c.apply(started('task_a', 'toolu_a'))
    const first = c.apply(says('task_a', 'one'))
    const second = c.apply(says('task_a', 'two'))
    const other = c.apply(says('task_b', 'other'))
    const revisions = (changes: AgentChange[]): [number, number][] => changes.map(ch => [ch.fromRev, ch.toRev])
    expect(revisions(first)).toEqual([[100, 101]])
    expect(revisions(second)).toEqual([[101, 102]])
    expect(revisions(other)).toEqual([[102, 103]])
    expect(c.page('task_a')?.rev).toBe(102)
    expect(c.page('task_b')?.rev).toBe(103)
    expect(c.maxRev()).toBe(103)
  })

  it('anything that is not a subagent frame, task_started or task_notification gives no change', () => {
    const { c } = chats()
    expect(c.apply({ type: 'assistant', message: { id: 'm', content: [text('main')] } }, 'session-1')).toEqual([])
    expect(c.apply({ type: 'user', message: { role: 'user', content: 'hi' } }, 'session-1')).toEqual([])
    expect(c.apply({ type: 'system', subtype: 'init' }, 'session-1')).toEqual([])
    expect(c.apply(null, 'session-1')).toEqual([])
    expect(isSubagentFrame({ type: 'assistant', agent_id: 'task_a' })).toBe(true)
    expect(isSubagentFrame({ type: 'result', agent_id: 'task_a' })).toBe(false)
    expect(isSubagentFrame({ type: 'assistant', message: {} })).toBe(false)
  })

  it('frameKeys names a frame by its uuid, its blocks, its tool calls and its results', () => {
    expect(frameKeys({ type: 'user', uuid: 'u1', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }] } }))
      .toEqual(['uuid:u1', 'result:toolu_1'])
    expect(frameKeys({
      type: 'assistant', uuid: 'u2', message: { id: 'msg_1', content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: {} }] },
    })).toEqual(['uuid:u2', 'block:msg_1:0:text', 'tool:toolu_2'])
    expect(frameKeys('not a frame')).toEqual([])
  })

  it('frameKeys takes a uuid only when it is a non-empty string of at most 200 characters', () => {
    expect(frameKeys({ type: 'user', uuid: 'x'.repeat(200), message: { content: [] } })).toEqual([`uuid:${'x'.repeat(200)}`])
    expect(frameKeys({ type: 'user', uuid: 'x'.repeat(201), message: { content: [] } })).toEqual([])
    expect(frameKeys({ type: 'user', uuid: '', message: { content: [] } })).toEqual([])
    expect(frameKeys({ type: 'user', uuid: 7, message: { content: [] } })).toEqual([])
  })

  it('a transcript line held live is not added again: by uuid, by tool_use id, by message id and block index', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'), 'session-1')
    c.apply({ type: 'assistant', uuid: 'u1', agent_id: 'task_a', message: { id: 'msg_1', role: 'assistant', content: [text('live text')] } })
    c.apply({ type: 'assistant', uuid: 'u2', agent_id: 'task_a', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls' } }] } })
    c.history('task_a', {
      lines: [
        { type: 'assistant', uuid: 'u1', message: { id: 'msg_9', role: 'assistant', content: [text('same uuid')] } },
        { type: 'assistant', uuid: 'u9', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: {} }] } },
        { type: 'assistant', uuid: 'u8', message: { id: 'msg_1', role: 'assistant', content: [text('same block')] } },
        { type: 'assistant', uuid: 'u7', message: { id: 'msg_3', role: 'assistant', content: [text('fresh')] } },
      ],
      start: 0,
    })
    expect(itemsOf(c, 'task_a').map(item => (item.kind === 'text' ? item.markdown : item.kind))).toEqual(['fresh', 'live text', 'tools'])
  })

  it('transcript items come before the live ones', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'), 'session-1')
    c.apply(says('task_a', 'live one'), 'session-1')
    c.history('task_a', { lines: [frame('assistant', null, [text('history one')]), frame('assistant', null, [text('history two')])], start: 0 })
    expect(itemsOf(c, 'task_a').map(item => (item.kind === 'text' ? item.markdown : item.kind))).toEqual(['history one', 'history two', 'live one'])
  })

  it('older pages come from the held items, then from the transcript before the cursor', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'), 'session-1')
    c.history('task_a', { lines: [frame('assistant', null, [text('msg 3')]), frame('assistant', null, [text('msg 4')])], start: 100 })
    c.apply(says('task_a', 'live 5'), 'session-1')
    const [msg3, msg4, live5] = itemsOf(c, 'task_a')
    // the held items before live 5 come first; the first held item has a transcript cursor before it
    expect(c.older('task_a', live5.id)).toEqual({ items: [msg3, msg4], hasOlder: true })
    expect(c.older('task_a', msg3.id)).toEqual({ cursor: 100 })
    expect(c.olderPage('task_a', { lines: [frame('assistant', null, [text('msg 1')]), frame('assistant', null, [text('msg 2')])], start: 0 }))
      .toEqual({ items: [expect.objectContaining({ markdown: 'msg 1' }), expect.objectContaining({ markdown: 'msg 2' })], hasOlder: false })
    expect(c.older('task_a', msg3.id)).toEqual({ items: [expect.objectContaining({ markdown: 'msg 1' }), expect.objectContaining({ markdown: 'msg 2' })], hasOlder: false })
    // an id the agent does not hold (its page left memory) gives nothing: the page asked for is gone, not the newest one
    expect(c.older('task_a', 'missing-id')).toEqual({ items: [], hasOlder: false })
    expect(itemsOf(c, 'task_a').map(item => (item.kind === 'text' ? item.markdown : item.kind))).toEqual(['msg 1', 'msg 2', 'msg 3', 'msg 4', 'live 5'])
  })

  it('an older page that does not begin the transcript starts no prompt', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'), 'session-1')
    c.history('task_a', { lines: [frame('assistant', null, [text('msg 2')])], start: 50 })
    const older = c.olderPage('task_a', { lines: [frame('user', null, [text('Earlier question')]), frame('assistant', null, [text('msg 1')])], start: 10 })
    expect(older.items).toEqual([
      expect.objectContaining({ kind: 'prompt', text: 'Earlier question', first: false }),
      expect.objectContaining({ markdown: 'msg 1' }),
    ])
  })

  it('an older page that begins the transcript starts its prompt', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'), 'session-1')
    c.history('task_a', { lines: [frame('assistant', null, [text('msg 2')])], start: 50 })
    const older = c.olderPage('task_a', { lines: [frame('user', null, [text('First question')]), frame('assistant', null, [text('msg 1')])], start: 0 })
    expect(older.items).toEqual([
      expect.objectContaining({ kind: 'prompt', text: 'First question', first: true }),
      expect.objectContaining({ markdown: 'msg 1' }),
    ])
  })

  it('an unknown beforeId of a long agent answers no items, not its newest page', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'), 'session-1')
    for (let i = 0; i < 300; i++) c.apply({ type: 'assistant', uuid: `u${i}`, agent_id: 'task_a', message: { id: `m${i}`, role: 'assistant', content: [text(`m${i}`)] } }, 'session-1')
    expect(c.older('task_a', 'gone-id')).toEqual({ items: [], hasOlder: false })
  })

  it('a tool result in a newer page settles its call in an older page', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'), 'session-1')
    // the newer page holds the result only: its call is in the older page
    c.history('task_a', { lines: [{ type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'ok' }] } }], start: 50 })
    const older = c.olderPage('task_a', {
      lines: [{ type: 'assistant', uuid: 'c1', message: { id: 'msg_c', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } }] } }],
      start: 0,
    })
    expect(older.items).toEqual([expect.objectContaining({ kind: 'tools', calls: [expect.objectContaining({ id: 'toolu_9', state: 'done', output: 'ok' })] })])
  })

  it('an agent that trimmed its oldest live items pages back to them from the transcript, not to the held ones', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'), 'session-1')
    // 1,005 live messages, each with its uuid and message id: the five oldest go out of memory
    const live = (i: number): Obj => ({ type: 'assistant', uuid: `u${i}`, agent_id: 'task_a', message: { id: `m${i}`, role: 'assistant', content: [text(`m${i}`)] } })
    for (let i = 0; i < 1005; i++) c.apply(live(i), 'session-1')
    let cursor: number | null = null
    let at = c.page('task_a')!.items[0].id
    for (let step = 0; step < 10 && cursor === null; step++) {
      const found = c.older('task_a', at)
      if (found === null) throw new Error('the agent is unknown')
      if ('cursor' in found) cursor = found.cursor
      else at = found.items[0]?.id ?? at
    }
    // the first held item asks for the transcript: from its end, as no page was read yet
    expect(cursor).not.toBeNull()
    expect(c.older('task_a', at)).toEqual({ cursor: expect.any(Number) })
    // the transcript holds the trimmed messages and the held ones; only the trimmed ones come back
    const transcript = Array.from({ length: 1005 }, (_, i) => ({ type: 'assistant', uuid: `u${i}`, message: { id: `m${i}`, role: 'assistant', content: [text(`m${i}`)] } }))
    const answer = c.olderPage('task_a', { lines: transcript, start: 0 })
    expect(answer.items.map(item => (item.kind === 'text' ? item.markdown : item.kind))).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
    expect(answer.hasOlder).toBe(false)
    expect(itemsOf(c, 'task_a').map(item => (item.kind === 'text' ? item.markdown : item.kind))).toHaveLength(200)
    expect(c.older('task_a', answer.items[0].id)).toEqual({ items: [], hasOlder: false })
  })

  it('a live agent keeps no tool result whose call it does not hold, and a transcript result is kept capped', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'), 'session-1')
    c.apply({ type: 'user', agent_id: 'task_a', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: 'ok' }] } }, 'session-1')
    c.apply({ type: 'assistant', agent_id: 'task_a', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } }] } }, 'session-1')
    // the call comes after its result in the live stream: nothing held settles it, so it stays running
    expect(itemsOf(c, 'task_a')).toEqual([expect.objectContaining({ kind: 'tools', calls: [expect.objectContaining({ id: 'toolu_9', state: 'running', output: null })] })])
    // a transcript page keeps the result it cannot settle, capped as tool output is
    const kept = new AgentModel({ now: () => 0, newId: () => 'x', folder: () => '/work/acme' }, false, Infinity, true)
    kept.apply({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_8', content: 'y'.repeat(OUTPUT_CAP + 500) }] } })
    const waiting = kept.leftover().get('toolu_8')
    expect(waiting).toBeDefined()
    expect(JSON.stringify(waiting!.block).length).toBeLessThanOrEqual(OUTPUT_CAP + 200)
  })

  it('the transcript items of an agent nobody watches stay until four others are kept', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'), 'session-1')
    c.history('task_a', { lines: [frame('assistant', null, [text('old one')])], start: 0 })
    expect(c.needsHistory('task_a')).toBe(false)
    c.watch('task_a', true)
    expect(itemsOf(c, 'task_a')).toEqual([expect.objectContaining({ markdown: 'old one' })])
    c.watch('task_a', false)
    expect(itemsOf(c, 'task_a')).toEqual([expect.objectContaining({ markdown: 'old one' })])
    expect(c.needsHistory('task_a')).toBe(false)
  })

  it('a fifth unwatched transcript head drops the least recently used one, and a kept one is reused', () => {
    const { c } = chats()
    for (let n = 1; n <= 5; n++) {
      const agent = `task_${n}`
      c.apply(started(agent, `toolu_${n}`), 'session-1')
      c.history(agent, { lines: [frame('assistant', null, [text(`old ${n}`)])], start: 0 })
      c.watch(agent, true)
      c.watch(agent, false)
    }
    expect(c.needsHistory('task_1')).toBe(true)
    for (let n = 2; n <= 5; n++) expect(c.needsHistory(`task_${n}`)).toBe(false)
    // a re-watch of a kept head makes it the most recently used: the next fifth one drops another
    c.watch('task_2', true)
    c.watch('task_2', false)
    c.apply(started('task_6', 'toolu_6'), 'session-1')
    c.history('task_6', { lines: [frame('assistant', null, [text('old 6')])], start: 0 })
    c.watch('task_6', true)
    c.watch('task_6', false)
    expect(c.needsHistory('task_3')).toBe(true)
    expect(c.needsHistory('task_2')).toBe(false)
  })

  it('an unwatched agent whose live items trim drops its kept head, so the next open reads the transcript again', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'), 'session-1')
    c.history('task_a', { lines: [frame('assistant', null, [text('old one')])], start: 0 })
    c.watch('task_a', true)
    c.watch('task_a', false)
    for (let i = 0; i < 1005; i++) c.apply({ type: 'assistant', uuid: `u${i}`, agent_id: 'task_a', message: { id: `m${i}`, role: 'assistant', content: [text(`m${i}`)] } }, 'session-1')
    expect(c.needsHistory('task_a')).toBe(true)
  })
})

describe('a forward on an agent page', () => {
  const forward = (text: string): Extract<ChatItem, { kind: 'forward' }> => ({
    kind: 'forward', id: 'fw1', agentId: 'task_a', label: 'Explore agent · Look', text, state: 'sending', reason: null,
  })
  /** the coordinator's line a resumed agent's transcript holds for a message it was sent */
  const coordinator = (uuid: string, msg: string): Obj => ({
    type: 'user', uuid, isMeta: true, origin: { kind: 'coordinator' },
    message: { role: 'user', content: `The coordinator sent a message while you were working:\n${msg}\n\nAddress this before completing your current task.` },
  })

  /** the same coordinator line, as a frame of the agent */
  const coordinatorFrame = (uuid: string, msg: string): Obj => ({ ...coordinator(uuid, msg), agent_id: 'task_a' })

  it("a coordinator's line that carries a forward's text is the forward's bubble, and adds no prompt", () => {
    const { c } = chats()
    c.apply(started('task_a', 'call_a'))
    c.forward(forward('Look in src/charts too.'))
    c.apply(coordinatorFrame('c1', 'Look in src/charts too.'))
    expect(itemsOf(c, 'task_a')).toEqual([expect.objectContaining({ kind: 'forward', id: 'fw1' })])
  })

  it("a prompt that only contains a forward's text is From Claude, and other text is too", () => {
    const { c } = chats()
    c.apply(started('task_a', 'call_a'))
    c.forward(forward('Look in src/charts too.'))
    c.apply(asks('task_a', 'Look in src/charts too.'))
    c.apply(asks('task_a', 'Other words'))
    expect(itemsOf(c, 'task_a')).toEqual([
      expect.objectContaining({ kind: 'forward', id: 'fw1' }),
      expect.objectContaining({ kind: 'prompt', text: 'Look in src/charts too.', first: true }),
      expect.objectContaining({ kind: 'prompt', text: 'Other words', first: false }),
    ])
  })

  it("a later coordinator line of Claude's own SendMessage, after the forward's line, is From Claude and not dropped", () => {
    const { c } = chats()
    c.apply(started('task_a', 'call_a'))
    c.forward(forward('Look in src/charts too.'))
    c.apply(coordinatorFrame('c1', 'Look in src/charts too.'))
    c.apply(coordinatorFrame('c2', 'Look in src/charts too.'))
    expect(itemsOf(c, 'task_a')).toEqual([
      expect.objectContaining({ kind: 'forward', id: 'fw1' }),
      expect.objectContaining({ kind: 'prompt', text: expect.stringContaining('Look in src/charts too.') }),
    ])
  })

  it("two forwards with the same text each place their own line, in order", () => {
    const { c } = chats()
    c.forward(forward('Look in src/charts too.'))
    c.forward({ ...forward('Look in src/charts too.'), id: 'fw2' })
    c.known({ id: 'task_a', description: 'Look', type: 'Explore', state: 'done', ms: 5 }, 'session-1')
    c.history('task_a', { lines: [coordinator('c1', 'Look in src/charts too.'), says('task_a', 'Got it'), coordinator('c2', 'Look in src/charts too.')], start: 0 })
    expect(itemsOf(c, 'task_a')).toEqual([
      expect.objectContaining({ kind: 'forward', id: 'fw1' }),
      expect.objectContaining({ kind: 'text', markdown: 'Got it' }),
      expect.objectContaining({ kind: 'forward', id: 'fw2' }),
    ])
  })

  it("a queued_command attachment of the coordinator with a forward's text places its bubble in place", () => {
    const { c } = chats()
    c.forward(forward('Look in src/charts too.'))
    c.known({ id: 'task_a', description: 'Look', type: 'Explore', state: 'done', ms: 5 }, 'session-1')
    const queued = { type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', prompt: 'Look in src/charts too.', origin: { kind: 'coordinator' } } }
    c.history('task_a', { lines: [{ type: 'user', uuid: 'p1', message: { role: 'user', content: 'Find it' } }, queued, says('task_a', 'Got it')], start: 0 })
    expect(itemsOf(c, 'task_a')).toEqual([
      expect.objectContaining({ kind: 'prompt', text: 'Find it', first: true }),
      expect.objectContaining({ kind: 'forward', id: 'fw1', text: 'Look in src/charts too.' }),
      expect.objectContaining({ kind: 'text', markdown: 'Got it' }),
    ])
  })

  it('a forward the transcript head holds is set there, and the live page adds no second bubble', () => {
    const { c } = chats()
    c.forward(forward('Look in src/charts too.'))
    c.known({ id: 'task_a', description: 'Look', type: 'Explore', state: 'done', ms: 5 }, 'session-1')
    c.history('task_a', { lines: [{ type: 'user', uuid: 'p1', message: { role: 'user', content: 'Find it' } }, coordinator('c1', 'Look in src/charts too.')], start: 0 })
    const changes = c.forward({ ...forward('Look in src/charts too.'), state: 'delivered', reason: null })
    expect(changes.flatMap(change => change.patches.map(p => p.op))).toEqual(['set'])
    expect(itemsOf(c, 'task_a').filter(item => item.kind === 'forward')).toEqual([expect.objectContaining({ id: 'fw1', state: 'delivered' })])
  })

  it("after a history, a forward's text in the transcript is its bubble in place", () => {
    const { c } = chats()
    // the forward comes before the history names its agent, as the chat's history load does it
    c.forward(forward('Look in src/charts too.'))
    c.known({ id: 'task_a', description: 'Look', type: 'Explore', state: 'done', ms: 5 }, 'session-1')
    c.history('task_a', { lines: [{ type: 'user', uuid: 'p1', message: { role: 'user', content: 'Find it' } }, coordinator('c1', 'Look in src/charts too.'), says('task_a', 'Got it')], start: 0 })
    expect(itemsOf(c, 'task_a')).toEqual([
      expect.objectContaining({ kind: 'prompt', text: 'Find it', first: true }),
      expect.objectContaining({ kind: 'forward', id: 'fw1', text: 'Look in src/charts too.' }),
      expect.objectContaining({ kind: 'text', markdown: 'Got it' }),
    ])

    // a bubble the agent already holds stays where it is: the transcript's line adds none
    const held = chats()
    held.c.apply(started('task_a', 'call_a'))
    held.c.forward(forward('Look in src/charts too.'))
    held.c.history('task_a', { lines: [coordinator('c1', 'Look in src/charts too.')], start: 0 })
    expect(itemsOf(held.c, 'task_a').filter(item => item.kind === 'forward')).toHaveLength(1)
    expect(itemsOf(held.c, 'task_a').some(item => item.kind === 'prompt')).toBe(false)
  })
})

describe("the lines Claude Code writes itself on an agent page", () => {
  it('the interrupt notice of a stopped agent adds no item', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'), 'session-1')
    c.apply(asks('task_a', '[Request interrupted by user for tool use]'))
    expect(itemsOf(c, 'task_a')).toEqual([])
  })

  it('a meta line that is not the coordinator\'s (a skill body, a reminder) adds no item', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'), 'session-1')
    c.apply({ type: 'user', agent_id: 'task_a', isMeta: true, message: { role: 'user', content: 'Base directory for this skill: /skills/review' } })
    expect(itemsOf(c, 'task_a')).toEqual([])
  })

  it('a task notice of a background task of the agent adds no item', () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'), 'session-1')
    c.apply(asks('task_a', '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>'))
    expect(itemsOf(c, 'task_a')).toEqual([])
  })

  it("a coordinator's line from Claude's own SendMessage is From Claude with only the message", () => {
    const { c } = chats()
    c.apply(started('task_a', 'toolu_a'), 'session-1')
    c.apply({
      type: 'user', uuid: 'c1', agent_id: 'task_a', isMeta: true, origin: { kind: 'coordinator' },
      message: { role: 'user', content: 'The coordinator sent a message while you were working:\nPlease check the parser.\n\nAddress this before completing your current task.' },
    })
    expect(itemsOf(c, 'task_a')).toEqual([expect.objectContaining({ kind: 'prompt', text: 'Please check the parser.', first: true })])
  })
})
