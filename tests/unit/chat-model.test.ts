import { describe, expect, it } from 'vitest'
import { ChatModel, toolSubject } from '../../src/main/chat/chat-model'
import { typedMessages, type ChatItem, type ChatPatch, type ChatToolCall } from '../../src/shared/chat'
import { fixtureHistory, fixtureLines } from '../fixtures/chat-fixtures'

const MIB = 1024 * 1024

/** a model with a clock the test moves, sequential ids and the work folder /work/acme */
function model(): { m: ChatModel; clock: { t: number } } {
  const clock = { t: 0 }
  let n = 0
  const m = new ChatModel({ now: () => clock.t, newId: () => `id${++n}`, folder: () => '/work/acme' })
  return { m, clock }
}

/** applies every message of a list, returns all patches */
function run(m: ChatModel, messages: unknown[]): ChatPatch[] {
  return messages.flatMap(msg => m.apply(msg))
}

const isObjLine = (line: unknown): line is Record<string, unknown> => typeof line === 'object' && line !== null

/** the calls of the one tools item of a model */
function callsOf(m: ChatModel): ChatToolCall[] {
  const tools = m.items().filter(item => item.kind === 'tools')
  return tools.flatMap(item => (item.kind === 'tools' ? item.calls : []))
}

describe('ChatModel', () => {
  it('\'answer\' streams one text item and settles it', () => {
    const { m } = model()
    const patches = run(m, fixtureLines('answer', 'out'))
    const adds = patches.filter(p => p.op === 'add' && p.item.kind === 'text')
    expect(adds).toHaveLength(1)
    expect(adds[0]).toMatchObject({ op: 'add', item: { kind: 'text', streaming: true } })
    expect(patches.some(p => p.op === 'append')).toBe(true)

    const answer = fixtureLines('answer', 'out')
      .flatMap(line => (typeof line === 'object' && line !== null && (line as { type: string }).type === 'assistant'
        ? ((line as { message: { content: { type: string; text?: string }[] } }).message.content)
        : []))
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('')
    // the last change of the text is its settle; the idle state Claude Code sends after the result comes behind it
    const last = patches.filter(p => p.op !== 'state').at(-1)
    expect(last).toMatchObject({ op: 'set', item: { kind: 'text', markdown: answer, streaming: false } })

    const items = m.items()
    expect(items[items.length - 1]).toMatchObject({ kind: 'text', markdown: answer, streaming: false })
    expect(items.filter(item => item.kind === 'text')).toHaveLength(1)
  })

  it('\'read\' gives a step with a done Read call whose subject is notes.txt and detail counts its lines', () => {
    const { m } = model()
    run(m, fixtureLines('read', 'out'))
    const tools = m.items().filter(item => item.kind === 'tools')
    expect(tools).toHaveLength(1)
    const [call] = callsOf(m)
    expect(call).toMatchObject({ name: 'Read', subject: 'notes.txt', state: 'done' })
    expect(call.detail).toMatch(/^\d+ lines$/)
  })

  it('a failed call keeps its error', () => {
    const { m } = model()
    run(m, [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'false' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', is_error: true, content: 'boom' }] } },
    ])
    expect(callsOf(m)[0]).toMatchObject({ id: 'toolu_x', state: 'failed', error: 'boom', output: 'boom' })
  })

  it('a tool result sends its call only', () => {
    const { m, clock } = model()
    run(m, [
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'pwd' } },
      ] } },
    ])
    clock.t = 500
    const patches = m.apply({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'ok' }] } })
    const step = m.items().find(item => item.kind === 'tools')!
    expect(patches).toEqual([{ op: 'call', id: step.id, call: expect.objectContaining({ id: 'toolu_b', state: 'done', output: 'ok' }) }])
    expect(callsOf(m)[1]).toMatchObject({ id: 'toolu_b', state: 'done', output: 'ok' })
  })

  it('a call joining an open step is one call patch', () => {
    const { m } = model()
    run(m, [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'ls' } }] } }])
    const step = m.items().find(item => item.kind === 'tools')!
    const patches = m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'pwd' } }] } })
    expect(patches).toEqual([{ op: 'call', id: step.id, call: expect.objectContaining({ id: 'toolu_b', state: 'running' }) }])
    expect(callsOf(m).map(c => c.id)).toEqual(['toolu_a', 'toolu_b'])
  })

  it('the step\'s time is sent with the step when its last call ends', () => {
    const { m, clock } = model()
    run(m, [{ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_a', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'pwd' } },
    ] } }])
    clock.t = 400
    run(m, [{ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'a' }] } }])
    clock.t = 1000
    const patches = m.apply({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'b' }] } })
    expect(patches).toContainEqual({ op: 'set', item: expect.objectContaining({ kind: 'tools', ms: 1000 }) })
  })

  it('a tool name and id are capped at 500 characters', () => {
    const { m } = model()
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'i'.repeat(600), name: 'n'.repeat(600), input: {} }] } })
    expect(callsOf(m)[0]).toMatchObject({ id: 'i'.repeat(500), name: 'n'.repeat(500) })
  })

  it('an edited file path is capped at 4096 characters', () => {
    const { m } = model()
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_w', name: 'Write', input: { file_path: `/work/${'d'.repeat(5000)}.txt`, content: 'x' } }] } })
    expect(callsOf(m)[0].editPath?.length).toBe(4096)
  })

  it('an image path is capped at 4096 characters', () => {
    const { m } = model()
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: `/${'p'.repeat(5000)}.png` } }] } })
    const images = m.items().find(item => item.kind === 'images')
    expect(images?.kind === 'images' && images.images[0].path.length).toBe(4096)
  })

  it('a subagent type is capped at 500 characters', () => {
    const { m } = model()
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Task', input: { description: 'Find it' } }] } })
    m.apply({ type: 'system', subtype: 'task_started', tool_use_id: 't2', task_id: 'a3', description: 'Find it', subagent_type: 's'.repeat(600) })
    expect(callsOf(m)[0].agents[0].type.length).toBe(500)
  })

  it('a task id is capped', () => {
    const { m } = model()
    const id = 'k'.repeat(600)
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't4', name: 'Task', input: { description: 'Find it' } }] } })
    m.apply({ type: 'system', subtype: 'task_started', tool_use_id: 't4', task_id: id, description: 'Find it', task_type: 'local_agent' })
    expect(callsOf(m)[0].agents[0].id).toBe('k'.repeat(500))
    // the notification names the same long id: it still finds its subagent and ends it
    m.apply({ type: 'system', subtype: 'task_notification', task_id: id, tool_use_id: 't4', status: 'completed', usage: { duration_ms: 900 } })
    expect(callsOf(m)[0].agents[0]).toMatchObject({ id: 'k'.repeat(500), state: 'done', ms: 900 })
  })
  it('the model named by init is capped at 200 characters', () => {
    const { m } = model()
    m.apply({ type: 'system', subtype: 'init', model: 'm'.repeat(300) })
    expect(m.status().model?.length).toBe(200)
  })

  it('a typed command name is capped at 500 characters', () => {
    const { m } = model()
    m.userSent({ text: `/${'c'.repeat(600)} now`, attachments: [] })
    m.apply({ type: 'system', subtype: 'local_command_output', content: 'done' })
    const command = m.items().find(item => item.kind === 'command')
    expect(command?.kind === 'command' && command.command.length).toBe(500)
  })

  it('malformed messages give no patches', () => {
    const { m } = model()
    expect(m.apply(null)).toEqual([])
    expect(m.apply('x')).toEqual([])
    expect(m.apply({ type: 'assistant' })).toEqual([])
    expect(m.apply({ type: 'nope' })).toEqual([])
    expect(m.items()).toEqual([])
  })

  it('a 2 MiB delta stops at 1 MiB', () => {
    const { m } = model()
    m.apply({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
    const piece = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 32; i++) {
      m.apply({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } })
    }
    const [item] = m.items()
    expect(item.kind).toBe('text')
    if (item.kind !== 'text') return
    expect(item.markdown.length).toBeLessThanOrEqual(MIB + 1)
    expect(item.markdown.length).toBe(MIB)
  })

  it('Bash subject is the first line and detail its seconds', () => {
    const { m, clock } = model()
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: { command: 'npm test\nnpm run build' } }] } })
    clock.t = 1200
    m.apply({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b', content: 'ok' }] } })
    expect(callsOf(m)[0]).toMatchObject({ subject: 'npm test', detail: '1.2s', ms: 1200, state: 'done' })
  })

  it('history draws each message once', () => {
    const { m } = model()
    run(m, fixtureHistory())
    const items: ChatItem[] = m.items().slice()
    expect(items.every(item => item.kind === 'user' || item.kind === 'text' || item.kind === 'tools')).toBe(true)
    const prompts = fixtureHistory().filter(msg => {
      const message = (msg as { type?: string; message?: { content?: unknown } })
      return message.type === 'user' && typeof message.message?.content === 'string'
    })
    expect(items.filter(item => item.kind === 'user')).toHaveLength(prompts.length)
    const textOf = (item: ChatItem): string | null => (item.kind === 'user' ? item.text : item.kind === 'text' ? item.markdown : null)
    for (let i = 1; i < items.length; i++) {
      const [before, after] = [items[i - 1], items[i]]
      expect(before.kind === after.kind && textOf(before) === textOf(after)).toBe(false)
    }
  })

  it('a replayed message we sent is not drawn twice', () => {
    const { m } = model()
    m.userSent({ text: 'hi', attachments: [] })
    m.apply({ type: 'user', isReplay: true, message: { role: 'user', content: 'hi' } })
    m.apply({ type: 'user', message: { role: 'user', content: 'hi' } })
    const users = m.items().filter(item => item.kind === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ kind: 'user', text: 'hi', queued: false })
  })

  it('a turn with thinking before its text has one text item, settled', () => {
    const { m, clock } = model()
    for (const msg of fixtureLines('read', 'out')) {
      clock.t += 10
      m.apply(msg)
    }
    const texts = m.items().filter(item => item.kind === 'text')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatchObject({ kind: 'text', markdown: 'Patient river carries old', streaming: false })
  })

  it('a live thinking item has its milliseconds', () => {
    const { m, clock } = model()
    for (const msg of fixtureLines('read', 'out')) {
      clock.t += 10
      m.apply(msg)
    }
    const thinking = m.items().filter(item => item.kind === 'thinking')
    expect(thinking).toHaveLength(1)
    const ms = thinking[0].kind === 'thinking' ? thinking[0].ms : null
    expect(typeof ms).toBe('number')
    expect(ms).toBeGreaterThanOrEqual(0)
  })

  it('a clock that steps back gives no negative time: a call and its detail stay at zero or more', () => {
    const { m, clock } = model()
    clock.t = 5000
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_c', name: 'Bash', input: { command: 'ls' } }] } })
    clock.t = 2000
    m.apply({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c', content: 'ok' }] } })
    expect(callsOf(m)[0]).toMatchObject({ state: 'done', ms: 0, detail: '0.0s' })
  })

  it('a clock that steps back gives no negative time: a thinking block and a step keep zero or more', () => {
    const { m, clock } = model()
    clock.t = 5000
    m.apply({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } })
    clock.t = 2000
    m.apply({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } })
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm' }] } })
    const thinking = m.items().find(item => item.kind === 'thinking')
    expect(thinking).toMatchObject({ kind: 'thinking', ms: 0 })
  })

  it('a text item left streaming is settled when the next message starts', () => {
    const { m } = model()
    m.apply({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
    m.apply({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } } })
    const patches = m.apply({ type: 'stream_event', event: { type: 'message_start', message: {} } })
    expect(patches).toEqual([{ op: 'set', item: expect.objectContaining({ kind: 'text', markdown: 'half', streaming: false }) }])
    expect(m.items()).toEqual([expect.objectContaining({ kind: 'text', markdown: 'half', streaming: false })])
  })

  it('a message of a subagent adds no item to the main conversation', () => {
    const { m } = model()
    const patches = m.apply({
      type: 'assistant', parent_tool_use_id: 'toolu_x',
      message: { role: 'assistant', content: [{ type: 'text', text: 'from the subagent' }] },
    })
    expect(patches).toEqual([])
    expect(m.items()).toEqual([])
  })

  it('init sets model, mode and session id', () => {
    const { m } = model()
    run(m, fixtureLines('answer', 'out'))
    expect(m.state()).toMatchObject({
      model: 'claude-haiku-5-5', mode: 'default', sessionId: '00000000-0000-4000-8000-000000000001',
    })
  })

  it('a turn runs from the message to its result', () => {
    const { m } = model()
    const patches = [...m.userSent({ text: 'hi', attachments: [] }), ...run(m, fixtureLines('answer', 'out'))]
    const turns = patches.flatMap(p => (p.op === 'state' ? [p.state.turn] : []))
    expect([...new Set(turns)]).toEqual(['working', 'idle'])
    expect(m.state()).toMatchObject({ turn: 'idle', turnStartedAt: null })
  })

  it('a queued message keeps the turn working through its result', () => {
    const { m } = model()
    const done = { type: 'result', subtype: 'success', is_error: false, result: 'done' }
    m.userSent({ text: 'first', attachments: [] })
    m.userSent({ text: 'second', attachments: [] })

    // the first result ends its step; the queued prompt is still to run, so the turn goes on
    m.apply(done)
    expect(m.state()).toMatchObject({ turn: 'working' })

    // the queued turn starts: its init, then its first message (an assistant one here) takes its prompt off the queue
    m.apply({ type: 'system', subtype: 'init', model: 'claude-haiku-5-5' })
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
    m.apply(done)
    expect(m.state()).toMatchObject({ turn: 'idle' })
  })

  it('the init of the next turn sets working, and the result before it sets idle', () => {
    const { m, clock } = model()
    const done = { type: 'result', subtype: 'success', is_error: false, result: 'done' }
    clock.t = 100
    m.userSent({ text: 'first', attachments: [] })
    m.apply(done)
    expect(m.state()).toMatchObject({ turn: 'idle', turnStartedAt: null })

    // Claude Code starts every turn with an init: the next turn runs from it
    clock.t = 900
    m.apply({ type: 'system', subtype: 'init', model: 'claude-haiku-5-5' })
    expect(m.state()).toMatchObject({ turn: 'working', turnStartedAt: 900 })
  })

  it('a resumed history ends its running calls as interrupted', () => {
    const { m } = model()
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_h', name: 'Bash', input: { command: 'sleep 9' } }] } })
    expect(callsOf(m)[0]).toMatchObject({ state: 'running' })

    m.historyLoaded()
    expect(callsOf(m)[0]).toMatchObject({ state: 'failed', error: 'Interrupted' })
  })

  it('a history that ends mid-turn leaves the turn idle', () => {
    const { m } = model()
    run(m, [
      { type: 'system', subtype: 'session_state_changed', state: 'running' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_m', name: 'Bash', input: { command: 'sleep 9' } }] } },
    ])
    expect(m.state().turn).toBe('working')

    m.historyLoaded()
    expect(m.state()).toMatchObject({ turn: 'idle', turnStartedAt: null })
  })

  it('a message sent during a turn is queued until the result that ends that turn takes it into the next one', () => {
    const { m } = model()
    m.userSent({ text: 'first', attachments: [] })
    const second = m.userSent({ text: 'second', attachments: [] })
    expect(second).toEqual([{ op: 'add', item: expect.objectContaining({ kind: 'user', text: 'second', queued: true }) }])

    const lines = fixtureLines('compact', 'out')
    const end = lines.findIndex(l => (l as { type: string }).type === 'result') + 1
    const patches = run(m, lines.slice(0, end))
    // Claude Code takes the waiting message into the next turn at its result: it is no longer queued, and the turn goes on
    expect(patches).toContainEqual({ op: 'set', item: expect.objectContaining({ kind: 'user', text: 'second', queued: false }) })
    expect(m.state()).toMatchObject({ turn: 'working' })
  })

  it('a frame that names a send unqueues it, and a later frame names the rest', () => {
    const { m } = model()
    // the first send starts the turn; the two after it wait behind it
    m.userSent({ text: 'turn', attachments: [] }, 'u-turn')
    m.userSent({ text: 'first', attachments: [] }, 'u-first')
    m.userSent({ text: 'second', attachments: [] }, 'u-second')
    const queued = (text: string): boolean => m.items().some(item => item.kind === 'user' && item.text === text && item.queued)
    expect([queued('first'), queued('second')]).toEqual([true, true])

    // Claude Code folded 'first' into the running turn: the frame names it, and only it
    m.apply({ type: 'assistant', user_message_uuids: ['u-first'], message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
    expect([queued('first'), queued('second')]).toEqual([false, true])

    m.apply({ type: 'assistant', user_message_uuids: ['u-first', 'u-second'], message: { role: 'assistant', content: [{ type: 'text', text: 'more' }] } })
    expect([queued('first'), queued('second')]).toEqual([false, false])
  })

  it('a stream event that names a send unqueues it', () => {
    const { m } = model()
    m.userSent({ text: 'turn', attachments: [] }, 'u-turn')
    m.userSent({ text: 'first', attachments: [] }, 'u-first')
    m.userSent({ text: 'second', attachments: [] }, 'u-second')
    const queued = (text: string): boolean => m.items().some(item => item.kind === 'user' && item.text === text && item.queued)
    m.apply({ type: 'stream_event', user_message_uuid: 'u-second', event: { type: 'message_start' } })
    expect([queued('first'), queued('second')]).toEqual([true, false])
  })

  it('a turn whose first frame names a send leaves the next queued send queued', () => {
    const { m } = model()
    const done = { type: 'result', subtype: 'success', is_error: false, result: 'done' }
    const queued = (text: string): boolean => m.items().some(item => item.kind === 'user' && item.text === text && item.queued)
    m.userSent({ text: 'turn', attachments: [] }, 'u-turn')
    m.userSent({ text: 'first', attachments: [] }, 'u-first')
    m.userSent({ text: 'second', attachments: [] }, 'u-second')

    // the turn's result: 'first' is still to run, so the turn goes on
    m.apply(done)
    expect(m.state()).toMatchObject({ turn: 'working' })

    // the next turn's first frame names 'first' only: 'second' still waits, and no turn start takes it
    m.apply({ type: 'assistant', user_message_uuids: ['u-first'], message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
    expect([queued('first'), queued('second')]).toEqual([false, true])
  })

  it('a stream with no uuids unqueues the next send when its turn starts', () => {
    const { m } = model()
    const done = { type: 'result', subtype: 'success', is_error: false, result: 'done' }
    const queued = (text: string): boolean => m.items().some(item => item.kind === 'user' && item.text === text && item.queued)
    m.userSent({ text: 'turn', attachments: [] }, 'u-turn')
    m.userSent({ text: 'first', attachments: [] }, 'u-first')
    m.userSent({ text: 'second', attachments: [] }, 'u-second')
    m.apply(done)
    // an older Claude Code: the next turn's first message names nothing, and takes the first queued send
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'next' }] } })
    expect([queued('first'), queued('second')]).toEqual([false, true])
  })

  it('a list of uuids that is not an array of at most 64 strings is ignored', () => {
    const { m } = model()
    const queued = (text: string): boolean => m.items().some(item => item.kind === 'user' && item.text === text && item.queued)
    m.userSent({ text: 'turn', attachments: [] }, 'u-turn')
    m.userSent({ text: 'first', attachments: [] }, 'u-first')
    m.apply({ type: 'assistant', user_message_uuids: 'u-first', message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } })
    m.apply({ type: 'assistant', user_message_uuids: ['u-first', 3], message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] } })
    m.apply({ type: 'assistant', user_message_uuids: [...Array.from({ length: 64 }, (_, i) => `x${i}`), 'u-first'], message: { role: 'assistant', content: [{ type: 'text', text: 'c' }] } })
    expect(queued('first')).toBe(true)
  })

  it('an interrupted result takes the first waiting send into the next turn at once, and the turn goes on with a new clock', () => {
    const { m, clock } = model()
    const queued = (text: string): boolean => m.items().some(item => item.kind === 'user' && item.text === text && item.queued)
    clock.t = 100
    m.userSent({ text: 'turn', attachments: [] }, 'u-turn')
    clock.t = 200
    m.userSent({ text: 'first', attachments: [] }, 'u-first')
    clock.t = 300
    m.userSent({ text: 'second', attachments: [] }, 'u-second')
    expect([queued('first'), queued('second')]).toEqual([true, true])

    // Esc: Claude Code ends the turn with its interrupted result and takes 'first' into the next turn at once
    clock.t = 500
    m.markInterrupted()
    const patches = m.apply({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '' })
    expect([queued('first'), queued('second')]).toEqual([false, true])
    expect(m.state()).toMatchObject({ turn: 'working', turnStartedAt: 500 })
    expect(patches).toContainEqual(expect.objectContaining({ op: 'add', item: expect.objectContaining({ kind: 'notice', text: 'Interrupted' }) }))

    // the next turn's first frame does not shift the queue again: 'second' waits for a frame that names it
    m.apply({ type: 'stream_event', event: { type: 'message_start' } })
    expect([queued('first'), queued('second')]).toEqual([false, true])
    m.apply({ type: 'assistant', user_message_uuids: ['u-first'], message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })
    expect([queued('first'), queued('second')]).toEqual([false, true])
  })

  it('a normal result takes the first waiting send into the next turn at once', () => {
    const { m } = model()
    const queued = (text: string): boolean => m.items().some(item => item.kind === 'user' && item.text === text && item.queued)
    m.userSent({ text: 'turn', attachments: [] }, 'u-turn')
    m.userSent({ text: 'first', attachments: [] }, 'u-first')
    m.apply({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
    expect(queued('first')).toBe(false)
    expect(m.state()).toMatchObject({ turn: 'working' })
  })

  it('the turn ends idle when the one send that waited has its own result', () => {
    const { m } = model()
    const done = { type: 'result', subtype: 'success', is_error: false, result: 'done' }
    m.userSent({ text: 'turn', attachments: [] }, 'u-turn')
    m.userSent({ text: 'first', attachments: [] }, 'u-first')
    m.apply(done)
    expect(m.state()).toMatchObject({ turn: 'working' })
    m.apply(done)
    expect(m.state()).toMatchObject({ turn: 'idle', turnStartedAt: null })
  })

  it('the init says the effort in effect: a level sets it, null clears it, an absent or bad value keeps it', () => {
    const { m } = model()
    m.apply({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', effort: 'high' })
    expect(m.state()).toMatchObject({ effort: 'high' })
    m.apply({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', effort: null })
    expect(m.state()).toMatchObject({ effort: null })
    m.apply({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', effort: 'max' })
    m.apply({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' })
    expect(m.state()).toMatchObject({ effort: 'max' })
    m.apply({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', effort: 'turbo' })
    m.apply({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', effort: 3 })
    expect(m.state()).toMatchObject({ effort: 'max' })
  })

  it('/compact draws a divider that says what it did', () => {
    const { m } = model()
    run(m, fixtureLines('compact', 'out'))
    expect(m.items().filter(item => item.kind === 'divider')).toEqual([
      expect.objectContaining({ kind: 'divider', text: 'Conversation compacted · 27k → 3.9k tokens · 10 s' }),
    ])
  })

  it('an automatic compaction says so, and a boundary without numbers says only that it compacted', () => {
    const { m } = model()
    const boundary = fixtureLines('compact', 'out').find(l => isObjLine(l) && l.subtype === 'compact_boundary') as Record<string, unknown>
    run(m, [{ ...boundary, compact_metadata: { trigger: 'auto', pre_tokens: 27050, post_tokens: 3874, duration_ms: 9992 } }])
    run(m, [{ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual' } }])
    expect(m.items().filter(item => item.kind === 'divider').map(item => item.kind === 'divider' && item.text)).toEqual([
      'Conversation compacted automatically · 27k → 3.9k tokens · 10 s',
      'Conversation compacted',
    ])
  })

  it('the compaction is the activity of the chat from its start to its boundary, and its divider replaces it', () => {
    const { m, clock } = model()
    const lines = fixtureLines('compact', 'out')
    const compacting = lines.findIndex(l => isObjLine(l) && l.subtype === 'status' && l.status === 'compacting')
    const boundary = lines.findIndex(l => isObjLine(l) && l.subtype === 'compact_boundary')
    clock.t = 500
    run(m, lines.slice(0, compacting + 1))
    expect(m.state()).toMatchObject({ activity: { kind: 'compacting', since: 500 } })
    clock.t = 900
    run(m, lines.slice(compacting + 1, boundary + 1))
    expect(m.state().activity).toBeUndefined()
  })

  it('a failed compaction says why once, and its activity goes', () => {
    const { m } = model()
    run(m, [{ type: 'system', subtype: 'status', status: 'compacting' }])
    run(m, [{ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'Prompt is too long' }])
    expect(m.state().activity).toBeUndefined()
    expect(m.items().filter(item => item.kind === 'notice')).toEqual([
      expect.objectContaining({ kind: 'notice', tone: 'error', text: 'Compaction failed: Prompt is too long' }),
    ])
  })

  it('a result clears a compaction that got stuck', () => {
    const { m } = model()
    run(m, [{ type: 'system', subtype: 'status', status: 'compacting' }])
    run(m, [{ type: 'result', subtype: 'success', is_error: false, result: '' }])
    expect(m.state().activity).toBeUndefined()
  })

  it('/context output is a command item', () => {
    const { m } = model()
    m.userSent({ text: '/context', attachments: [] })
    run(m, fixtureLines('slash', 'out'))
    const commands = m.items().filter(item => item.kind === 'command')
    expect(commands[0]).toMatchObject({ kind: 'command', command: '/context' })
    expect(commands[0].kind === 'command' && commands[0].output.length > 0).toBe(true)
  })

  it('replayed interrupt and compact draw no user message of their own', () => {
    const { m } = model()
    run(m, [...fixtureLines('interrupt', 'out'), ...fixtureLines('compact', 'out')])
    expect(m.items().filter(item => item.kind === 'user')).toEqual([])
  })

  it('an interrupted turn says Interrupted, not an error', () => {
    const { m } = model()
    const lines = fixtureLines('interrupt', 'out')
    const isDelta = (l: unknown): boolean => {
      const ev = (l as { event?: { type?: string; delta?: { type?: string } } }).event
      return ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta'
    }
    const cut = lines.findIndex(isDelta) + 1
    m.userSent({ text: 'Count from 1 to 200, one number per line.', attachments: [] })
    run(m, lines.slice(0, cut))
    m.markInterrupted()
    run(m, lines.slice(cut))
    const notices = m.items().filter(item => item.kind === 'notice')
    expect(notices).toEqual([expect.objectContaining({ kind: 'notice', text: 'Interrupted', tone: 'info', action: null })])
    expect(m.items().some(item => item.kind === 'text' && item.streaming)).toBe(false)
    expect(m.state().turn).toBe('idle')
  })

  it('a result that aborted is an interruption without the mark, and fails its running calls', () => {
    const { m } = model()
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_r', name: 'Bash', input: { command: 'sleep 9' } }] } })
    m.apply({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', errors: ['[ede_diagnostic] x'] })
    const notices = m.items().filter(item => item.kind === 'notice')
    expect(notices).toEqual([expect.objectContaining({ kind: 'notice', text: 'Interrupted', tone: 'info' })])
    expect(callsOf(m)[0]).toMatchObject({ state: 'failed', error: 'Interrupted' })
  })

  it('an Agent call cut off by an interrupt ends its running agent too, so none is left animating', () => {
    const { m } = model()
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Find it', prompt: 'look' } }] } })
    m.apply({ type: 'system', subtype: 'task_started', tool_use_id: 't1', task_id: 'a1', description: 'Find it', task_type: 'local_agent' })
    m.markInterrupted()
    m.apply({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools' })
    expect(callsOf(m)[0]).toMatchObject({ state: 'failed', error: 'Interrupted' })
    expect(callsOf(m)[0].agents).toEqual([expect.objectContaining({ id: 'a1', state: 'failed' })])
  })

  it('a mark taken while idle does not make the next error result an interruption', () => {
    const { m } = model()
    m.markInterrupted()
    m.userSent({ text: 'hi', attachments: [] })
    m.apply({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] })
    const notices = m.items().filter(item => item.kind === 'notice')
    expect(notices).toEqual([expect.objectContaining({ kind: 'notice', tone: 'error', text: 'boom' })])
  })

  it('a command name does not outlast its turn', () => {
    const { m } = model()
    const lines = fixtureLines('compact', 'out')
    const results = lines.flatMap((l, i) => ((l as { type: string }).type === 'result' ? [i] : []))
    m.userSent({ text: '/compact', attachments: [] })
    run(m, lines.slice(results[results.length - 2] + 1))
    run(m, fixtureLines('slash', 'out'))
    const commands = m.items().filter(item => item.kind === 'command')
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.map(item => (item.kind === 'command' ? item.command : null))).not.toContain('/compact')
  })

  it('a send while idle waits behind the queue, and every queued prompt is un-queued when its turn starts', () => {
    const { m } = model()
    const reply = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }
    const done = { type: 'result', subtype: 'success', is_error: false }
    m.userSent({ text: 'first', attachments: [] })
    m.userSent({ text: 'second', attachments: [] })
    m.userSent({ text: 'third', attachments: [] })
    run(m, [reply, done])
    m.userSent({ text: 'fourth', attachments: [] })
    run(m, [reply, done])
    run(m, [reply, done])
    run(m, [reply, { type: 'user', message: { role: 'user', content: 'fourth' } }, done])
    const users = m.items().filter(item => item.kind === 'user')
    expect(users.map(item => (item.kind === 'user' ? item.text : null))).toEqual(['first', 'second', 'third', 'fourth'])
    expect(users.some(item => item.kind === 'user' && item.queued)).toBe(false)
  })

  it('limits and context fill status()', () => {
    const { m } = model()
    m.apply({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1767225600 } })
    m.setContext({ pct: 37, used: null, size: null })
    expect(m.status()).toMatchObject({ fiveHour: { usedPct: 42, resetsAt: 1767225600 }, contextPct: 37 })
  })

  it('the five-hour and the weekly limit come from unifiedWindows', () => {
    const { m } = model()
    m.apply({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning', resetsAt: 1893456000, rateLimitType: 'seven_day', utilization: 0.8,
        unifiedWindows: {
          five_hour: { utilization: 0.5, resetsAt: 1893456000, status: 'allowed' },
          seven_day: { utilization: 0.8, resetsAt: 1893456000, status: 'allowed_warning', surpassedThreshold: 0.75 }
        }
      }
    })
    expect(m.status()).toMatchObject({ fiveHour: { usedPct: 50, resetsAt: 1893456000 }, sevenDay: { usedPct: 80, resetsAt: 1893456000 } })
  })

  it('a malformed unifiedWindows window falls back to the top-level limit, or is ignored', () => {
    const { m } = model()
    m.apply({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed', rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 1767225600,
        unifiedWindows: { five_hour: 'high', seven_day: { utilization: 0.9 } }
      }
    })
    expect(m.status()).toMatchObject({ fiveHour: { usedPct: 42, resetsAt: 1767225600 }, sevenDay: null })
  })

  it('the context fill comes with its token counts when the answer has them', () => {
    const { m } = model()
    m.setContext({ pct: 74, used: 148000, size: 200000 })
    expect(m.status()).toMatchObject({ contextPct: 74, contextUsed: 148000, contextSize: 200000 })
  })

  it('a fill with no token counts has no counts', () => {
    const { m } = model()
    m.setContext({ pct: 74, used: null, size: null })
    expect(m.status()).toMatchObject({ contextPct: 74, contextUsed: null, contextSize: null })
  })

  it('setState with no change gives no patch', () => {
    const { m } = model()
    expect(m.setState({ mode: m.state().mode })).toEqual([])
  })

  it('a retry is a notice line', () => {
    const { m } = model()
    const patches = m.apply({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 3500, error_status: 429 })
    expect(patches).toEqual([{ op: 'add', item: expect.objectContaining({ kind: 'notice', tone: 'info', text: 'Retrying in 4s · attempt 2 of 10' }) }])
  })

  it('an error result is an error notice', () => {
    const { m } = model()
    m.apply({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'model_error', errors: ['boom', 'again'] })
    expect(m.items()).toEqual([expect.objectContaining({ kind: 'notice', tone: 'error', text: 'boom; again' })])
  })

  it('a rejected limit says when it resets, once', () => {
    const { m } = model()
    const info = { status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: 1767225600 }
    m.apply({ type: 'rate_limit_event', rate_limit_info: info })
    m.apply({ type: 'rate_limit_event', rate_limit_info: info })
    const at = new Date(1767225600 * 1000)
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
    expect(m.items()).toEqual([expect.objectContaining({ kind: 'notice', tone: 'info', text: `Usage limit reached · resets at ${hhmm}` })])
  })

  it('subagents of a Task call', () => {
    const { m } = model()
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Task', input: { description: 'Find the config', prompt: 'look' } }] } })
    m.apply({ type: 'system', subtype: 'task_started', tool_use_id: 't1', task_id: 'a1', description: 'Find the config', task_type: 'local_agent' })
    m.apply({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 't1', status: 'completed', usage: { duration_ms: 1500 } })
    expect(callsOf(m)[0].agents[0]).toMatchObject({ id: 'a1', type: 'local_agent', state: 'done', ms: 1500 })

    m.apply({ type: 'system', subtype: 'task_started', tool_use_id: 't1', task_id: 'a2', description: 'Second', subagent_type: 'Explore' })
    expect(callsOf(m)[0]).toMatchObject({ detail: '2 agents' })
    expect(callsOf(m)[0].agents[1]).toMatchObject({ id: 'a2', type: 'Explore', state: 'running' })
  })

  it('a finished subagent resumed by a SendMessage call is listed on that call, and ends there', () => {
    const { m } = model()
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Find the config', prompt: 'look' } }] } })
    m.apply({ type: 'system', subtype: 'task_started', tool_use_id: 't1', task_id: 'a1', description: 'Find the config', task_type: 'local_agent' })
    m.apply({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 't1', status: 'completed', usage: { duration_ms: 1500 } })

    // the person sends the finished agent a message: Claude Code resumes it under the same task id, and names the SendMessage call that did it
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'SendMessage', input: { to: 'a1', message: 'and the tests' } }] } })
    m.apply({ type: 'system', subtype: 'task_started', tool_use_id: 't9', task_id: 'a1', description: 'Find the config', task_type: 'local_agent', is_backgrounded: true })
    expect(callsOf(m).find(c => c.id === 't9')?.agents).toEqual([expect.objectContaining({ id: 'a1', state: 'running' })])

    m.apply({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 't9', status: 'completed', usage: { duration_ms: 900 } })
    expect(callsOf(m).find(c => c.id === 't9')?.agents).toEqual([expect.objectContaining({ id: 'a1', state: 'done', ms: 900 })])
  })

  it('a subagent shows the model and effort its Agent call asks for, then the model it runs on and its context, from its own messages', () => {
    const { m } = model()
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Find the config', prompt: 'look', model: 'haiku', effort: 'high' } }] } })
    m.apply({ type: 'system', subtype: 'task_started', tool_use_id: 't1', task_id: 'a1', description: 'Find the config', subagent_type: 'Explore' })
    expect(callsOf(m)[0].agents[0]).toMatchObject({ id: 'a1', model: 'haiku', effort: 'high' })
    expect(callsOf(m)[0].agents[0].context).toBeUndefined()

    // Claude Code passes a subagent's tool calls on, with parent_tool_use_id and agent_id: its model and its usage, its context
    const own = { type: 'assistant', parent_tool_use_id: 't1', agent_id: 'a1', message: { role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 's1', name: 'Grep', input: { pattern: 'config' } }], usage: { input_tokens: 12, cache_creation_input_tokens: 2000, cache_read_input_tokens: 30000, output_tokens: 188 } } }
    const count = m.items().length
    expect(m.apply(own)).toHaveLength(1)
    expect(m.items()).toHaveLength(count)
    expect(callsOf(m)).toHaveLength(1)
    expect(callsOf(m)[0].agents[0]).toMatchObject({ id: 'a1', model: 'claude-haiku-5-5', effort: 'high', context: 32200 })
    // the same numbers again change nothing, and the subagent's tool results are not the conversation's
    expect(m.apply(own)).toEqual([])
    expect(m.apply({ type: 'user', parent_tool_use_id: 't1', agent_id: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', content: 'found' }] } })).toEqual([])
    // its next call has grown its context
    m.apply({ ...own, message: { ...own.message, usage: { input_tokens: 5, cache_read_input_tokens: 41000, output_tokens: 95 } } })
    expect(callsOf(m)[0].agents[0]).toMatchObject({ model: 'claude-haiku-5-5', context: 41100 })
  })

  it('a subagent message with no agent_id is the one agent running for its call; one for no known agent, or with bad usage, changes nothing', () => {
    const { m } = model()
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Find it', prompt: 'look', effort: 'extreme' } }] } })
    m.apply({ type: 'system', subtype: 'task_started', tool_use_id: 't1', task_id: 'a1', description: 'Find it', subagent_type: 'Explore' })
    // an effort Claude Code does not have is not shown
    expect(callsOf(m)[0].agents[0].effort).toBeUndefined()
    const usage = { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 0 }
    m.apply({ type: 'assistant', parent_tool_use_id: 't1', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [], usage } })
    expect(callsOf(m)[0].agents[0]).toMatchObject({ model: 'claude-sonnet-5-5', context: 1000 })

    expect(m.apply({ type: 'assistant', parent_tool_use_id: 'nope', message: { role: 'assistant', model: 'claude-opus-5-5', content: [], usage } })).toEqual([])
    expect(m.apply({ type: 'assistant', parent_tool_use_id: 't1', agent_id: 'a1', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [], usage: { input_tokens: -1, output_tokens: 5 } } })).toEqual([])
    expect(m.apply({ type: 'assistant', parent_tool_use_id: 't1', agent_id: 'a1', message: { role: 'assistant', model: '<synthetic>', content: [], usage: 'many' } })).toEqual([])
    expect(callsOf(m)[0].agents[0]).toMatchObject({ model: 'claude-sonnet-5-5', context: 1000 })

    // two agents running for one call: a message that names neither is not guessed
    m.apply({ type: 'system', subtype: 'task_started', tool_use_id: 't1', task_id: 'a2', description: 'And this', subagent_type: 'Explore' })
    expect(m.apply({ type: 'assistant', parent_tool_use_id: 't1', message: { role: 'assistant', model: 'claude-opus-5-5', content: [], usage } })).toEqual([])
  })

  it('a Read of a png adds an images item', () => {
    const { m } = model()
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/work/acme/shot.PNG' } }] } })
    m.apply({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'image' }] } })
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/work/acme/shot.PNG' } }] } })
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r3', name: 'Read', input: { file_path: '/work/acme/notes.txt' } }] } })
    const images = m.items().filter(item => item.kind === 'images')
    expect(images).toEqual([expect.objectContaining({ kind: 'images', images: [{ path: '/work/acme/shot.PNG', cardId: null }] })])
  })

  it('page and older walk 450 items in pages of 200', () => {
    const { m } = model()
    for (let i = 0; i < 450; i++) m.notice(`n${i}`, 'info', null)
    const first = m.page()
    expect(first.items).toHaveLength(200)
    expect(first.hasOlder).toBe(true)
    const second = m.older(first.items[0].id)
    expect(second.items).toHaveLength(200)
    expect(second.hasOlder).toBe(true)
    const third = m.older(second.items[0].id)
    expect(third.items).toHaveLength(50)
    expect(third.hasOlder).toBe(false)
  })

  it('answering one of two open cards keeps the turn waiting; answering the last one runs it', () => {
    const { m } = model()
    const card = { type: 'question' as const, questions: [] }
    // the cards open in a turn: the prompt starts it
    m.userSent({ text: 'ask me two things', attachments: [] })
    m.cardOpened('card1', card)
    m.cardOpened('card2', card)
    expect(m.state().turn).toBe('waiting')
    m.cardAnswered('card1', 'You answered: a')
    expect(m.state().turn).toBe('waiting')
    m.cardAnswered('card2', 'You answered: b')
    expect(m.state().turn).toBe('working')
  })

  it('a command this environment has no answer for is a notice that carries the line typed, to open in the terminal', () => {
    const { m } = model()
    m.userSent({ text: '/review focus', attachments: [] })
    run(m, [{ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: "/review isn't available in this environment." }] } }])
    expect(m.items()).toContainEqual(expect.objectContaining({
      kind: 'notice', tone: 'info', text: "/review isn't available in this environment.", action: 'open-terminal', line: '/review focus'
    }))
    expect(m.items().some(item => item.kind === 'text')).toBe(false)
  })

  it('a typed message of several lines is not typed in the terminal: the notice keeps the name alone', () => {
    const { m } = model()
    m.userSent({ text: '/review\nfocus now', attachments: [] })
    run(m, [{ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: "/review isn't available in this environment." }] } }])
    expect(m.items()).toContainEqual(expect.objectContaining({ kind: 'notice', action: 'open-terminal', line: '/review' }))
  })

  it('a command name the terminal would not take gives a notice without the button', () => {
    const { m } = model()
    const name = 'x'.repeat(2001)
    m.userSent({ text: `/${name}`, attachments: [] })
    run(m, [{ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: `/${name} isn't available in this environment.` }] } }])
    expect(m.items()).toContainEqual(expect.objectContaining({ kind: 'notice', action: null }))
    expect(m.items().some(item => item.kind === 'notice' && item.action === 'open-terminal')).toBe(false)
  })

  it('a command typed in the terminal keeps its arguments in the notice line', () => {
    const { m } = model()
    run(m, [
      { type: 'user', message: { role: 'user', content: '/review focus' } },
      { type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: "/review isn't available in this environment." }] } }
    ])
    expect(m.items()).toContainEqual(expect.objectContaining({ kind: 'notice', action: 'open-terminal', line: '/review focus' }))
  })

  it('an answer that only mentions a command is text, not a notice', () => {
    const { m } = model()
    m.userSent({ text: 'what does it do', attachments: [] })
    run(m, [{ type: 'assistant', message: { content: [{ type: 'text', text: "/review isn't available in this environment. Try it in the terminal." }] } }])
    expect(m.items().some(item => item.kind === 'notice')).toBe(false)
    expect(m.items().some(item => item.kind === 'text')).toBe(true)
  })

  it("a plain text that says a command is not available is Claude's own reply: no notice, and the command is not remembered", () => {
    const { m } = model()
    m.userSent({ text: '/review focus', attachments: [] })
    run(m, [{ type: 'assistant', message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: "/review isn't available in this environment." }] } }])
    expect(m.items().some(item => item.kind === 'notice')).toBe(false)
    expect(m.items().some(item => item.kind === 'text')).toBe(true)
  })

  it('a synthetic answer to another command than the one typed is no notice', () => {
    const { m } = model()
    m.userSent({ text: '/review', attachments: [] })
    run(m, [{ type: 'assistant', message: { model: '<synthetic>', content: [{ type: 'text', text: "/doctor isn't available in this environment." }] } }])
    expect(m.items().some(item => item.kind === 'notice')).toBe(false)
  })

  it("a local command's answer in the shape Claude Code sends it raises the same notice: the sentence decides", () => {
    const { m } = model()
    m.userSent({ text: '/review focus', attachments: [] })
    run(m, [{ type: 'assistant', local_command_source: 'command', message: { model: '<synthetic>', content: [{ type: 'text', text: "/review isn't available in this environment." }] } }])
    expect(m.items()).toContainEqual(expect.objectContaining({ kind: 'notice', action: 'open-terminal', line: '/review focus' }))
  })

  it('toolSubject', () => {
    expect(toolSubject('Read', { file_path: '/work/acme/src/a.ts' }, '/work/acme')).toBe('src/a.ts')
    expect(toolSubject('Grep', { pattern: 'TODO' }, '/w')).toBe('TODO')
    expect(toolSubject('Nope', {}, '/w')).toBe('')
  })
})

/** a user-role message as Claude Code sends it: the text, and the origin the SDK names when it names one */
function userMessage(text: string, origin?: unknown): unknown {
  return { type: 'user', message: { role: 'user', content: text }, session_id: 's1', uuid: 'u1', ...(origin === undefined ? {} : { origin }) }
}

const TASK_NOTICE = [
  '<task-notification>',
  '<task-id>a1</task-id>',
  '<tool-use-id>t1</tool-use-id>',
  '<status>completed</status>',
  '<summary>Agent "Re-review Task 11 fix round" finished</summary>',
  '<result>Two findings, both fixed.</result>',
  '</task-notification>'
].join('\n')

describe('messages Claude Code puts in the conversation', () => {
  it('a background task notice is a system row with its summary and result, not the person\'s bubble', () => {
    const { m } = model()
    m.apply(userMessage(TASK_NOTICE, { kind: 'task-notification' }))
    expect(m.items().filter(item => item.kind === 'user')).toEqual([])
    expect(m.items()).toEqual([expect.objectContaining({
      kind: 'event', source: 'task', title: 'Agent "Re-review Task 11 fix round" finished', status: null, body: 'Two findings, both fixed.'
    })])
  })

  it('a task notice whose end the chat already drew from the system message adds no row', () => {
    const { m } = model()
    m.apply({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Task', input: { description: 'Re-review', prompt: 'look' } }] } })
    m.apply({ type: 'system', subtype: 'task_started', tool_use_id: 't1', task_id: 'a1', description: 'Re-review', task_type: 'local_agent' })
    m.apply({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 't1', status: 'completed', output_file: '', summary: 'Re-review' })
    m.apply(userMessage(TASK_NOTICE, { kind: 'task-notification' }))
    expect(m.items().filter(item => item.kind === 'user' || item.kind === 'event')).toEqual([])
  })

  it('the end of a background shell task, from its system message and its notice, is one event row with its summary', () => {
    const { m } = model()
    m.apply({ type: 'system', subtype: 'task_notification', task_id: 'a1', tool_use_id: 'toolu_b', status: 'completed', output_file: '', summary: 'Run tests' })
    m.apply(userMessage(TASK_NOTICE, { kind: 'task-notification' }))
    expect(m.items()).toEqual([expect.objectContaining({
      kind: 'event', source: 'task', title: 'Agent "Re-review Task 11 fix round" finished', status: null, body: 'Two findings, both fixed.'
    })])
  })

  it('a task notice that failed or was stopped says so in its status', () => {
    const { m } = model()
    m.apply(userMessage(TASK_NOTICE.replace('<status>completed</status>', '<status>failed</status>'), { kind: 'task-notification' }))
    expect(m.items()).toEqual([expect.objectContaining({ kind: 'event', status: 'failed' })])
  })

  it('a message from another session is a row with the sender\'s name and the body, not a bubble', () => {
    const { m } = model()
    m.apply(userMessage('<cross-session-message from="s-2" name="Reviewer">Ready for review</cross-session-message>',
      { kind: 'peer', from: 's-2', name: 'Reviewer', body: 'Ready for review' }))
    expect(m.items()).toEqual([expect.objectContaining({ kind: 'event', source: 'peer', title: 'Message from Reviewer', body: 'Ready for review' })])
  })

  it('a channel or coordinator message is a row with its first line, and its whole text folded under it', () => {
    const { m } = model()
    m.apply(userMessage('Deploy finished\nlog line 2', { kind: 'channel', server: 'ci' }))
    m.apply(userMessage('Plan updated', { kind: 'coordinator' }))
    expect(m.items()).toEqual([
      expect.objectContaining({ kind: 'event', source: 'message', title: 'Deploy finished', body: 'Deploy finished\nlog line 2' }),
      expect.objectContaining({ kind: 'event', source: 'message', title: 'Plan updated', body: 'Plan updated' })
    ])
  })

  it('the person\'s message is a bubble, and so is one with no origin', () => {
    const { m } = model()
    m.apply(userMessage('hello', { kind: 'human' }))
    m.apply(userMessage('plain'))
    expect(m.items()).toEqual([expect.objectContaining({ kind: 'user', text: 'hello' }), expect.objectContaining({ kind: 'user', text: 'plain' })])
  })

  it('a history line with the task envelope and no origin is the same row', () => {
    const { m } = model()
    m.apply(userMessage(TASK_NOTICE))
    expect(m.items()).toEqual([expect.objectContaining({
      kind: 'event', source: 'task', title: 'Agent "Re-review Task 11 fix round" finished', body: 'Two findings, both fixed.'
    })])
  })

  it('an origin-less message is a row only when it starts with a known envelope tag', () => {
    const { m } = model()
    m.apply(userMessage('Why did <task-notification> fail?'))
    m.apply(userMessage('<agent-message from="s-3">Hi</agent-message>'))
    expect(m.items()).toEqual([
      expect.objectContaining({ kind: 'user', text: 'Why did <task-notification> fail?' }),
      expect.objectContaining({ kind: 'event', source: 'peer', title: 'Message from s-3', body: 'Hi' })
    ])
  })

  it('a scheduled trigger, a task-notification origin whose text is no envelope, is a row with its first line as the title', () => {
    const { m } = model()
    m.apply(userMessage('Nightly check\nall three suites passed', { kind: 'task-notification', subkind: 'scheduled-trigger' }))
    expect(m.items()).toEqual([expect.objectContaining({ kind: 'event', source: 'message', title: 'Nightly check', body: 'Nightly check\nall three suites passed' })])
  })

  it('a channel envelope is titled by its stripped body, never by its opening tag', () => {
    const { m } = model()
    m.apply(userMessage('<channel source="ci">Deploy finished\nlog line 2</channel>'))
    expect(m.items()).toEqual([expect.objectContaining({ kind: 'event', source: 'message', title: 'Deploy finished', body: 'Deploy finished\nlog line 2' })])
  })

  it('an envelope with a megabyte of spaces in it parses in linear time, to the same body', () => {
    const { m } = model()
    const text = `<agent-message from="s-1">${' '.repeat(MIB - 64)}Hi</agent-message>`
    const started = performance.now()
    m.apply(userMessage(text))
    expect(performance.now() - started).toBeLessThan(200)
    expect(m.items()).toEqual([expect.objectContaining({ kind: 'event', source: 'peer', title: 'Message from s-1', body: 'Hi' })])
  })

  it('a task envelope with a megabyte of repeated opening tags parses in linear time, and finds no field in them', () => {
    const { m } = model()
    const text = `<task-notification>\n${'<summary>'.repeat(Math.floor(MIB / 9))}`
    const started = performance.now()
    m.apply(userMessage(text, { kind: 'task-notification' }))
    expect(performance.now() - started).toBeLessThan(200)
    expect(m.items()).toEqual([expect.objectContaining({ kind: 'event', source: 'task', title: 'A background task ended', body: '' })])
  })

  it('↑ recall gives only what the person typed', () => {
    const { m } = model()
    m.apply(userMessage('first'))
    m.apply(userMessage(TASK_NOTICE, { kind: 'task-notification' }))
    m.apply(userMessage('peer text', { kind: 'peer', from: 's-2', body: 'peer text' }))
    expect(typedMessages(m.items())).toEqual(['first'])
  })
})
