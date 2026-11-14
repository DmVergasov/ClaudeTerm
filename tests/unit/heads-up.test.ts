import { describe, expect, it } from 'vitest'
import type { ChatItem, HeadsUpCard } from '../../src/shared/chat'
import { CHECK_SYSTEM, EXPLAIN_SYSTEM, HEADS_UP_EVERY, HeadsUp, askMessage, excerpt, parseFinding } from '../../src/main/chat/heads-up'
import { BACKGROUND_PROMPT } from '../../src/main/auto-continue'

const FINDING = [
  'topic: The test database is the production one, so the cleanup step deletes real orders.',
  'tag: Heads up',
  'title: The tests run against production',
  'The `.env` the tests read points at the **production** database.',
  '',
  '- Point `DATABASE_URL` at a test database before the next run.'
].join('\n')

const init = { type: 'system', subtype: 'init', session_id: 's' }
const toolUse = (n = 1, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content: Array.from({ length: n }, (_, i) => ({ type: 'tool_use', id: `t${i}`, name: 'Bash', input: {} })) }
})

interface Asked { system: string; prompt: string; resolve(answer: string): void; reject(e: Error): void }

function setup(o: { enabled?: boolean; items?: readonly ChatItem[] | null; sendError?: string } = {}) {
  const asked: Asked[] = []
  const shown: (HeadsUpCard | null)[] = []
  const sent: { tabId: string; text: string }[] = []
  let ids = 0
  const enabled = { on: o.enabled ?? true }
  const items: readonly ChatItem[] | null = o.items === undefined ? [{ kind: 'user', id: 'u', text: 'Clean up the old orders', attachments: [], queued: false }] : o.items
  const h = new HeadsUp({
    enabled: () => enabled.on,
    items: () => items,
    ask: (_tabId, system, prompt) => new Promise<string>((resolve, reject) => { asked.push({ system, prompt, resolve, reject }) }),
    send: (tabId, text) => { sent.push({ tabId, text }); return Promise.resolve(o.sendError ?? null) },
    show: (_tabId, card) => { shown.push(card) },
    newId: () => `card-${++ids}`,
    log: { info: () => undefined, warn: () => undefined }
  })
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  return { h, asked, shown, sent, enabled, settle }
}

describe('parseFinding', () => {
  it('reads the topic, the tag, the title and the explanation', () => {
    expect(parseFinding(FINDING)).toEqual({
      topic: 'The test database is the production one, so the cleanup step deletes real orders.',
      tag: 'heads-up',
      title: 'The tests run against production',
      text: 'The `.env` the tests read points at the **production** database.\n\n- Point `DATABASE_URL` at a test database before the next run.'
    })
  })

  it('takes You should know, bold fields, blank lines between them and a title with an ending period', () => {
    const found = parseFinding('**topic:** How the cache is keyed.\n\n**tag:** You should know\n**title:** Keys are per user.\nEach user gets a cache of their own.')
    expect(found).toMatchObject({ tag: 'should-know', title: 'Keys are per user', text: 'Each user gets a cache of their own.' })
  })

  it('a finding in the language the person writes in, with the fields and the tag as given, is read whole', () => {
    const found = parseFinding('topic: Тесты чистят боевую базу заказов.\ntag: Heads up\ntitle: Тесты идут по боевой базе.\nФайл `.env` указывает на **боевую** базу.')
    expect(found).toEqual({ topic: 'Тесты чистят боевую базу заказов.', tag: 'heads-up', title: 'Тесты идут по боевой базе', text: 'Файл `.env` указывает на **боевую** базу.' })
  })

  it("the side agent writes in the person's language, and keeps the answer's fields and tag as they are named", () => {
    for (const system of [CHECK_SYSTEM, EXPLAIN_SYSTEM]) {
      expect(system).toContain('in the language the person writes in')
      expect(system).not.toMatch(/write in english/i)
    }
    expect(CHECK_SYSTEM).toContain('Keep the field names topic, tag and title, and the tag itself, in English')
  })

  it('none, or an answer that keeps to neither form, is no finding', () => {
    expect(parseFinding('topic: none')).toBeNull()
    expect(parseFinding('topic: none.\n')).toBeNull()
    expect(parseFinding('Nothing important here.')).toBeNull()
    expect(parseFinding('topic: x.\ntag: Warning\ntitle: t\ntext')).toBeNull()
    expect(parseFinding('topic: x.\ntag: Heads up\ntitle: t')).toBeNull()
    expect(parseFinding('')).toBeNull()
  })
})

describe('excerpt', () => {
  const items: ChatItem[] = [
    { kind: 'user', id: '1', text: 'Fix the build', attachments: [], queued: false },
    { kind: 'thinking', id: '2', ms: 10, summary: 'hm' },
    { kind: 'tools', id: '3', ms: null, calls: [
      { id: 'c', name: 'Bash', subject: 'npm test', detail: null, state: 'done', output: '3 failed', error: null, editPath: null, agents: [], ms: null },
      { id: 'd', name: 'Edit', subject: 'src/a.ts', detail: null, state: 'failed', output: null, error: 'no such file', editPath: null, agents: [], ms: null }
    ] },
    { kind: 'text', id: '4', markdown: 'The build is fixed.', streaming: false }
  ]

  it('gives the person, Claude and the tool calls in order, without thinking', () => {
    expect(excerpt(items)).toBe('Person: Fix the build\n[tool] Bash npm test -> 3 failed\n[tool] Edit src/a.ts -> failed: no such file\nClaude: The build is fixed.')
  })

  it('keeps the latest part when the conversation is longer than the limit', () => {
    expect(excerpt(items, 40)).toBe('Claude: The build is fixed.')
  })

  it("ClaudeTerm's own nudges are not the person's words, whether sent now or read back from the history", () => {
    const sent: ChatItem[] = [
      { kind: 'user', id: '1', text: 'Почини сборку', attachments: [], queued: false },
      { kind: 'user', id: '2', text: BACKGROUND_PROMPT, attachments: [], queued: false },
      { kind: 'user', id: '3', text: 'The usage limit has reset.', attachments: [], queued: false, from: 'auto' }
    ]
    expect(excerpt(sent)).toBe(`Person: Почини сборку\nClaudeTerm: ${BACKGROUND_PROMPT}\nClaudeTerm: The usage limit has reset.`)
  })
})

describe('HeadsUp', () => {
  it(`checks after every ${HEADS_UP_EVERY}th tool call of a turn, not before`, () => {
    const { h, asked } = setup()
    h.message('t', init)
    h.message('t', toolUse(HEADS_UP_EVERY - 1))
    expect(asked).toHaveLength(0)
    h.message('t', toolUse(1))
    expect(asked).toHaveLength(1)
    expect(asked[0]!.system).toBe(CHECK_SYSTEM)
    expect(asked[0]!.prompt).toContain('<session>\nPerson: Clean up the old orders\n</session>')
  })

  it("a subagent's tool calls do not count, and each turn counts from 0", () => {
    const { h, asked } = setup()
    h.message('t', init)
    h.message('t', toolUse(HEADS_UP_EVERY, 'agent-call'))
    h.message('t', toolUse(HEADS_UP_EVERY - 1))
    h.message('t', init)
    h.message('t', toolUse(HEADS_UP_EVERY - 1))
    expect(asked).toHaveLength(0)
  })

  it('a finding shows as a card; one check at a time, and none while a card shows or in the turn that got one', async () => {
    const { h, asked, shown, settle } = setup()
    h.message('t', init)
    h.message('t', toolUse(HEADS_UP_EVERY))
    h.message('t', toolUse(HEADS_UP_EVERY))
    expect(asked).toHaveLength(1)
    asked[0]!.resolve(FINDING)
    await settle()
    expect(shown).toEqual([{ id: 'card-1', tag: 'heads-up', title: 'The tests run against production', text: expect.stringContaining('production'), more: null, explaining: false, explainError: null }])
    expect(h.card('t')?.id).toBe('card-1')
    h.message('t', toolUse(HEADS_UP_EVERY))
    expect(asked).toHaveLength(1)
    // closed, the same turn still gets no second card; the next turn does, and the topic offered is named to be skipped
    expect(h.act('t', 'card-1', 'got-it')).toBe(true)
    expect(shown.at(-1)).toBeNull()
    h.message('t', toolUse(HEADS_UP_EVERY))
    expect(asked).toHaveLength(1)
    h.message('t', init)
    h.message('t', toolUse(HEADS_UP_EVERY))
    expect(asked).toHaveLength(2)
    expect(asked[1]!.prompt).toContain('Offered already, do not offer again:\n- The test database is the production one')
  })

  it('an answer of none, or a failed check, shows nothing and lets the next check run', async () => {
    const { h, asked, shown, settle } = setup()
    h.message('t', init)
    h.message('t', toolUse(HEADS_UP_EVERY))
    asked[0]!.resolve('topic: none')
    await settle()
    h.message('t', toolUse(HEADS_UP_EVERY))
    asked[1]!.reject(new Error('Claude Code ended without an answer'))
    await settle()
    h.message('t', toolUse(HEADS_UP_EVERY))
    expect(asked).toHaveLength(3)
    expect(shown).toEqual([])
  })

  it('with claude.headsUp off, or no chat running, nothing is asked', () => {
    const off = setup({ enabled: false })
    off.h.message('t', init)
    off.h.message('t', toolUse(HEADS_UP_EVERY))
    expect(off.asked).toHaveLength(0)
    const gone = setup({ items: null })
    gone.h.message('t', init)
    gone.h.message('t', toolUse(HEADS_UP_EVERY))
    expect(gone.asked).toHaveLength(0)
  })

  it('Not relevant closes the card, and its topic is named as not needed in the next checks', async () => {
    const { h, asked, shown, settle } = setup()
    h.message('t', init)
    h.message('t', toolUse(HEADS_UP_EVERY))
    asked[0]!.resolve(FINDING)
    await settle()
    expect(h.act('t', 'card-1', 'not-relevant')).toBe(true)
    expect(shown.at(-1)).toBeNull()
    expect(h.card('t')).toBeNull()
    h.message('t', init)
    h.message('t', toolUse(HEADS_UP_EVERY))
    expect(asked[1]!.prompt).toContain('do not need them, do not offer them:\n- The test database is the production one')
  })

  it('Explain more asks once, shows that it is on its way, then the longer explanation', async () => {
    const { h, asked, shown, settle } = setup()
    h.message('t', init)
    h.message('t', toolUse(HEADS_UP_EVERY))
    asked[0]!.resolve(FINDING)
    await settle()
    expect(h.act('t', 'card-1', 'explain')).toBe(true)
    expect(h.act('t', 'card-1', 'explain')).toBe(true)
    expect(asked).toHaveLength(2)
    expect(asked[1]!.system).toBe(EXPLAIN_SYSTEM)
    expect(asked[1]!.prompt).toContain('The card said (Heads up): The tests run against production')
    expect(shown.at(-1)).toMatchObject({ id: 'card-1', explaining: true, more: null })
    asked[1]!.resolve('Your `.env` holds the production URL.')
    await settle()
    expect(shown.at(-1)).toMatchObject({ id: 'card-1', explaining: false, more: 'Your `.env` holds the production URL.', explainError: null })
    // explained, it is not asked again
    h.act('t', 'card-1', 'explain')
    expect(asked).toHaveLength(2)
  })

  it('an explanation that fails says so on the card', async () => {
    const { h, asked, shown, settle } = setup()
    h.message('t', init)
    h.message('t', toolUse(HEADS_UP_EVERY))
    asked[0]!.resolve(FINDING)
    await settle()
    h.act('t', 'card-1', 'explain')
    asked[1]!.reject(new Error('timeout'))
    await settle()
    expect(shown.at(-1)).toMatchObject({ explaining: false, more: null, explainError: 'The explanation could not be fetched.' })
  })

  it("the side agent gets the person's own latest messages for their language, also when the session's latest part has none", async () => {
    const said = (id: string, text: string, from?: 'auto' | 'review'): ChatItem => ({ kind: 'user', id, text, attachments: [], queued: false, ...(from ? { from } : {}) })
    const items: ChatItem[] = [
      said('u1', 'Перенеси замеры\nв отчёт'),
      said('u2', 'че там долго еще?'),
      said('u3', BACKGROUND_PROMPT),
      said('u4', 'Go on.', 'auto'),
      said('u5', 'Review comments on src/a.ts: rename it', 'review'),
      // Claude's long English work after them: the excerpt's window no longer reaches the person's messages
      ...Array.from({ length: 200 }, (_, i): ChatItem => ({ kind: 'text', id: `c${i}`, markdown: 'The collector now sorts long freezes into sustained drops. '.repeat(3), streaming: false }))
    ]
    const { h, asked, settle } = setup({ items })
    h.message('t', init)
    h.message('t', toolUse(HEADS_UP_EVERY))
    const block = '<person>\nПеренеси замеры в отчёт\nче там долго еще?\n</person>'
    expect(asked[0]!.prompt).not.toContain('Person: Перенеси')
    expect(asked[0]!.prompt).toContain(block)
    asked[0]!.resolve(FINDING)
    await settle()
    h.act('t', 'card-1', 'explain')
    expect(asked[1]!.prompt).toContain(block)
  })

  it('an answer to a card the tab does not show is refused, and a closed tab draws nothing', async () => {
    const { h, asked, shown, settle } = setup()
    expect(h.act('t', 'card-1', 'got-it')).toBe(false)
    h.message('t', init)
    h.message('t', toolUse(HEADS_UP_EVERY))
    h.forget('t')
    asked[0]!.resolve(FINDING)
    await settle()
    expect(shown).toEqual([])
    expect(h.card('t')).toBeNull()
  })

  const QUOTED = '> Heads up: The tests run against production\n>\n> The `.env` the tests read points at the **production** database.\n>\n> - Point `DATABASE_URL` at a test database before the next run.'

  it('Ask Claude sends the words with the card quoted to the conversation, and closes the card', async () => {
    const { h, asked, shown, sent, settle } = setup()
    h.message('t', init)
    h.message('t', toolUse(HEADS_UP_EVERY))
    asked[0]!.resolve(FINDING)
    await settle()
    expect(await h.ask('t', 'card-1', '  Fix it now  ')).toBeNull()
    expect(sent).toEqual([{ tabId: 't', text: `Fix it now\n\n${QUOTED}` }])
    expect(shown.at(-1)).toBeNull()
    expect(h.card('t')).toBeNull()
  })

  it('the message quotes the longer explanation too once Explain more brought it', async () => {
    const { h, asked, sent, settle } = setup()
    h.message('t', init)
    h.message('t', toolUse(HEADS_UP_EVERY))
    asked[0]!.resolve(FINDING)
    await settle()
    h.act('t', 'card-1', 'explain')
    asked[1]!.resolve('Your `.env` holds the production URL.')
    await settle()
    expect(await h.ask('t', 'card-1', 'Why?')).toBeNull()
    expect(sent[0]!.text).toBe(`Why?\n\n${QUOTED}\n>\n> Your \`.env\` holds the production URL.`)
  })

  it('a You should know card is quoted with its own tag', () => {
    const card: HeadsUpCard = { id: 'card-1', tag: 'should-know', title: 'Keys are per user', text: 'Each user gets a cache.\n\n- Clear it per user.', more: null, explaining: false, explainError: null }
    expect(askMessage(card, 'Why?')).toBe('Why?\n\n> You should know: Keys are per user\n>\n> Each user gets a cache.\n>\n> - Clear it per user.')
  })

  it('Ask Claude on a card the tab does not show sends nothing, and a failed send keeps the card', async () => {
    const gone = setup()
    expect(await gone.h.ask('t', 'card-9', 'x')).toBe('The card is gone.')
    expect(gone.sent).toEqual([])

    const failing = setup({ sendError: 'The chat has ended.' })
    failing.h.message('t', init)
    failing.h.message('t', toolUse(HEADS_UP_EVERY))
    failing.asked[0]!.resolve(FINDING)
    await failing.settle()
    expect(await failing.h.ask('t', 'card-1', 'x')).toBe('The chat has ended.')
    expect(failing.h.card('t')).not.toBeNull()
    expect(failing.shown.at(-1)).not.toBeNull()
  })
})
