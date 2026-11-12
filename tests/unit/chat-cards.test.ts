import { describe, expect, it } from 'vitest'
import { toolSubject } from '../../src/main/chat/chat-model'
import { answeredLine, cardFor, resultFor, suggestionLabel, type PermissionAsk } from '../../src/main/chat/chat-cards'
import { isChatAnswer, isChatSend, isPermissionMode } from '../../src/main/chat/chat-guards'
import type { ChatAnswer, ChatCard } from '../../src/shared/chat'
import { fixtureLines } from '../fixtures/chat-fixtures'

const FOLDER = '/work/acme'

/** the can_use_tool request of a fixture, as the PermissionAsk the chat model hands the cards */
function ask(fixture: string, toolName: string): PermissionAsk {
  const msg = fixtureLines(fixture, 'out', { cwd: FOLDER }).find(line => {
    const m = line as { type?: string; request?: { subtype?: string; tool_name?: string } }
    return m.type === 'control_request' && m.request?.subtype === 'can_use_tool' && m.request.tool_name === toolName
  }) as { request: Record<string, unknown> }
  const r = msg.request
  return {
    toolName: r.tool_name as string,
    input: r.input as Record<string, unknown>,
    displayName: r.display_name as string,
    description: r.description as string | undefined,
    suggestions: r.permission_suggestions as unknown[] | undefined,
    folder: FOLDER,
  }
}

/** a card from a fixture's ask, with the card's type checked */
function cardOf(a: PermissionAsk): ChatCard {
  return cardFor(a)
}

describe('cardFor', () => {
  it('a Write ask is a permission card: title, subject, description, diff and the acceptEdits suggestion', () => {
    const a = ask('permission-allow', 'Write')
    const card = cardOf(a)
    expect(card).toEqual({
      type: 'permission',
      tool: 'Write',
      title: 'Claude wants to edit out.txt',
      subject: 'out.txt',
      description: 'out.txt',
      diff: { path: '/work/acme\\out.txt', before: '', after: 'fixture' },
      suggestions: [{ index: 0, label: 'Allow edits for this session' }],
      defaultToNo: false,
    })
  })

  it('a Bash ask has the subject of its command, its description and the worded suggestions with their indexes', () => {
    const a: PermissionAsk = {
      toolName: 'Bash',
      input: { command: 'echo fixture\necho more', description: 'Print the fixture' },
      folder: FOLDER,
      suggestions: [
        { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'echo fixture' }], behavior: 'allow', destination: 'session' },
        { type: 'setMode', mode: 'plan', destination: 'session' },
        { type: 'addDirectories', directories: ['/work/other'], destination: 'session' },
        { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'echo fixture' }], behavior: 'allow', destination: 'localSettings' },
      ],
    }
    const card = cardOf(a)
    expect(card.type).toBe('permission')
    if (card.type !== 'permission') return
    expect(card.title).toBe('Claude wants to run a command')
    expect(card.subject).toBe('echo fixture')
    expect(card.description).toBe('Print the fixture')
    expect(card.suggestions).toEqual([
      { index: 0, label: 'Allow Bash(echo fixture) for this session' },
      { index: 2, label: 'Allow access to /work/other for this session' },
      { index: 3, label: 'Always allow Bash(echo fixture)' },
    ])
  })

  it('an explicit title wins, and an MCP tool is named by its server and tool', () => {
    const titled = cardOf({ toolName: 'Bash', input: { command: 'ls' }, title: 'Run the listing?', folder: FOLDER })
    expect(titled.type === 'permission' && titled.title).toBe('Run the listing?')
    const mcp = cardOf({ toolName: 'mcp__github__create_issue', input: { title: 'x' }, folder: FOLDER })
    expect(mcp.type === 'permission' && mcp.title).toBe('Claude wants to use github · create_issue')
    const other = cardOf({ toolName: 'TodoThing', input: {}, folder: FOLDER })
    expect(other.type === 'permission' && other.title).toBe('Claude wants to use TodoThing')
  })

  it('an Edit ask carries its diff; a Write without its content has no diff', () => {
    const edit = cardOf({
      toolName: 'Edit', input: { file_path: '/work/acme/notes.txt', old_string: 'a', new_string: 'b' }, folder: FOLDER,
    })
    expect(edit.type === 'permission' && edit.diff).toEqual({ path: '/work/acme/notes.txt', before: 'a', after: 'b' })
    expect(edit.type === 'permission' && edit.title).toBe('Claude wants to edit notes.txt')
    const bare = cardOf({ toolName: 'Write', input: { file_path: '/work/acme/x.txt' }, folder: FOLDER })
    expect(bare.type === 'permission' && bare.diff).toBeNull()
  })

  it('an ask with no optional fields is still a complete card', () => {
    const card = cardOf({ toolName: 'WebFetch', input: { url: 'https://example.com/a' }, folder: FOLDER })
    expect(card).toEqual({
      type: 'permission',
      tool: 'WebFetch',
      title: 'Claude wants to fetch https://example.com/a',
      subject: 'https://example.com/a',
      description: null,
      diff: null,
      suggestions: [],
      defaultToNo: false,
    })
  })

  it('a suggestion label is capped at 500 characters', () => {
    const rule = { toolName: 'Bash', ruleContent: 'x'.repeat(5000) }
    const card = cardOf({
      toolName: 'Bash', input: { command: 'ls' }, folder: FOLDER,
      suggestions: [{ type: 'addRules', rules: [rule], behavior: 'allow', destination: 'session' }],
    })
    expect(card.type === 'permission' && card.suggestions[0].label.length).toBe(500)
  })

  it('a card offers at most 20 suggestions, each with its index in the ask', () => {
    const suggestions = Array.from({ length: 30 }, () => ({ type: 'setMode', mode: 'acceptEdits' }))
    const card = cardOf({ toolName: 'Bash', input: { command: 'ls' }, folder: FOLDER, suggestions })
    expect(card.type === 'permission' && card.suggestions).toHaveLength(20)
    expect(card.type === 'permission' && card.suggestions[19].index).toBe(19)
  })

  it('a deny or ask addRules suggestion is not worded and not offered', () => {
    const rule = { toolName: 'Bash', ruleContent: 'rm -rf build' }
    expect(suggestionLabel({ type: 'addRules', rules: [rule], behavior: 'deny', destination: 'session' })).toBeNull()
    expect(suggestionLabel({ type: 'addRules', rules: [rule], behavior: 'ask', destination: 'localSettings' })).toBeNull()
    const card = cardOf({
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
      folder: FOLDER,
      suggestions: [{ type: 'addRules', rules: [rule], behavior: 'deny', destination: 'session' }],
    })
    expect(card.type === 'permission' && card.suggestions).toEqual([])
  })

  it('an ask with only the required fields still gives a complete permission card, and defaultToNo reaches it', () => {
    const bare = cardOf({ toolName: 'WebFetch', input: { url: 'https://example.com/b' }, folder: FOLDER })
    expect(bare).toEqual({
      type: 'permission',
      tool: 'WebFetch',
      title: 'Claude wants to fetch https://example.com/b',
      subject: 'https://example.com/b',
      description: null,
      diff: null,
      suggestions: [],
      defaultToNo: false,
    })
    const flagged = cardOf({ toolName: 'Bash', input: { command: 'ls' }, folder: FOLDER, defaultToNo: true })
    expect(flagged.type === 'permission' && flagged.defaultToNo).toBe(true)
  })

  it('suppressAlwaysAllowRule drops the suggestions', () => {
    const a = ask('permission-allow', 'Write')
    const card = cardOf({ ...a, suppressAlwaysAllowRule: true })
    expect(card.type === 'permission' && card.suggestions).toEqual([])
  })

  it('the subject of a Write card is toolSubject of its input and folder', () => {
    const a = ask('permission-allow', 'Write')
    const card = cardOf(a)
    expect(card.type === 'permission' && card.subject).toBe(toolSubject('Write', a.input, a.folder))
  })

  it('an AskUserQuestion ask is a question card with its questions and options', () => {
    const a = ask('question', 'AskUserQuestion')
    expect(cardOf(a)).toEqual({
      type: 'question',
      questions: [{
        question: 'Which format do you want?',
        header: 'Format',
        multiSelect: false,
        options: [
          { label: 'PDF report', description: 'A PDF report document.' },
          { label: 'HTML page', description: 'A single HTML page.' },
        ],
      }],
    })
  })

  it('a malformed AskUserQuestion input is a permission card', () => {
    const card = cardOf({ toolName: 'AskUserQuestion', input: { questions: 'nope' }, folder: FOLDER })
    expect(card.type).toBe('permission')
    if (card.type === 'permission') expect(card.tool).toBe('AskUserQuestion')
    const five = { questions: Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}`, header: 'H', multiSelect: false, options: [{ label: 'a', description: '' }] })) }
    expect(cardOf({ toolName: 'AskUserQuestion', input: five, folder: FOLDER }).type).toBe('permission')
  })

  it('an ExitPlanMode ask is a plan card with the plan text', () => {
    const a = ask('plan', 'ExitPlanMode')
    expect(cardOf(a)).toEqual({ type: 'plan', plan: a.input.plan })
  })
})

describe('suggestionLabel', () => {
  it('words the suggestions this version knows and gives null for the rest', () => {
    expect(suggestionLabel({ type: 'setMode', mode: 'acceptEdits', destination: 'session' })).toBe('Allow edits for this session')
    expect(suggestionLabel({ type: 'setMode', mode: 'plan', destination: 'session' })).toBeNull()
    expect(suggestionLabel({ type: 'addRules', rules: [{ toolName: 'Read' }], behavior: 'allow', destination: 'projectSettings' })).toBe('Always allow Read')
    expect(suggestionLabel({ type: 'something-new' })).toBeNull()
    expect(suggestionLabel('not an object')).toBeNull()
  })
})

describe('resultFor', () => {
  it('a permission once allows with the input, and with a suggestion also its permission update', () => {
    const a = ask('permission-allow', 'Write')
    const card = cardOf(a)
    const once: ChatAnswer = { type: 'permission', choice: 'once', suggestion: null, message: null }
    expect(resultFor(a, card, once)).toEqual({ behavior: 'allow', updatedInput: a.input })
    const withRule: ChatAnswer = { type: 'permission', choice: 'once', suggestion: 0, message: null }
    expect(resultFor(a, card, withRule)).toEqual({
      behavior: 'allow',
      updatedInput: a.input,
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })
  })

  it('a suggestion the card does not offer does not fit the card', () => {
    const a = ask('permission-allow', 'Write')
    const card = cardOf(a)
    expect(resultFor(a, card, { type: 'permission', choice: 'once', suggestion: 3, message: null })).toBeNull()
  })

  it('a permission deny is a deny with the message, or the default one', () => {
    const a = ask('permission-allow', 'Write')
    const card = cardOf(a)
    expect(resultFor(a, card, { type: 'permission', choice: 'deny', suggestion: null, message: 'Not that file' }))
      .toEqual({ behavior: 'deny', message: 'Not that file' })
    expect(resultFor(a, card, { type: 'permission', choice: 'deny', suggestion: null, message: null }))
      .toEqual({ behavior: 'deny', message: 'The user denied this.' })
  })

  it('a question answer goes as updatedInput with the answers keyed by question, the shape of the question fixture', () => {
    const a = ask('question', 'AskUserQuestion')
    const card = cardOf(a)
    const result = resultFor(a, card, { type: 'question', answers: { 'Which format do you want?': 'PDF report' } })
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { ...a.input, answers: { 'Which format do you want?': 'PDF report' } },
    })
  })

  it('a list answer to a question that is not multi-select does not fit the card', () => {
    const a = ask('question', 'AskUserQuestion')
    const card = cardOf(a)
    expect(resultFor(a, card, { type: 'question', answers: { 'Which format do you want?': ['PDF report'] } })).toBeNull()
  })

  it('a multi-select answer goes as its labels joined with a comma', () => {
    const a: PermissionAsk = {
      toolName: 'AskUserQuestion',
      folder: FOLDER,
      input: {
        questions: [{
          question: 'Which parts?',
          header: 'Parts',
          multiSelect: true,
          options: [{ label: 'Chart', description: '' }, { label: 'Export', description: '' }],
        }],
      },
    }
    const card = cardOf(a)
    expect(resultFor(a, card, { type: 'question', answers: { 'Which parts?': ['Chart', 'Export'] } })).toEqual({
      behavior: 'allow',
      updatedInput: { ...a.input, answers: { 'Which parts?': 'Chart, Export' } },
    })
  })

  it('declining a question is a deny; an answer for a question the card does not have does not fit', () => {
    const a = ask('question', 'AskUserQuestion')
    const card = cardOf(a)
    expect(resultFor(a, card, { type: 'question', answers: null })).toEqual({ behavior: 'deny', message: 'The user declined to answer.' })
    expect(resultFor(a, card, { type: 'question', answers: { 'Another question?': 'x' } })).toBeNull()
  })

  it('a plan answer: accept-edits and ask-edits allow with the permission mode, keep-planning denies', () => {
    const a = ask('plan', 'ExitPlanMode')
    const card = cardOf(a)
    expect(resultFor(a, card, { type: 'plan', choice: 'accept-edits', message: null })).toEqual({
      behavior: 'allow',
      updatedInput: a.input,
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    })
    expect(resultFor(a, card, { type: 'plan', choice: 'ask-edits', message: null })).toEqual({
      behavior: 'allow',
      updatedInput: a.input,
      updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
    })
    expect(resultFor(a, card, { type: 'plan', choice: 'keep-planning', message: null })).toEqual({
      behavior: 'deny',
      message: 'Keep planning.',
    })
  })

  it('an answer of another kind does not fit the card', () => {
    const a = ask('plan', 'ExitPlanMode')
    expect(resultFor(a, cardOf(a), { type: 'permission', choice: 'once', suggestion: null, message: null })).toBeNull()
  })
})

describe('answeredLine', () => {
  it('words each kind of answer for the transcript', () => {
    const q = ask('question', 'AskUserQuestion')
    const qCard = cardOf(q)
    expect(answeredLine(qCard, { type: 'question', answers: { 'Which format do you want?': 'PDF report' } }))
      .toBe('You answered: PDF report')
    expect(answeredLine(qCard, { type: 'question', answers: null })).toBe('You declined to answer')

    const w = ask('permission-allow', 'Write')
    const wCard = cardOf(w)
    expect(answeredLine(wCard, { type: 'permission', choice: 'once', suggestion: null, message: null }))
      .toBe('Allowed: edit out.txt')
    expect(answeredLine(wCard, { type: 'permission', choice: 'once', suggestion: 0, message: null }))
      .toBe('Allowed for this session: edit out.txt')
    expect(answeredLine(wCard, { type: 'permission', choice: 'deny', suggestion: null, message: null }))
      .toBe('Denied: edit out.txt')

    const p = cardOf(ask('plan', 'ExitPlanMode'))
    expect(answeredLine(p, { type: 'plan', choice: 'accept-edits', message: null })).toBe('Plan approved')
    expect(answeredLine(p, { type: 'plan', choice: 'keep-planning', message: null })).toBe('Kept planning')
  })

  it('a line too long for a card is cut to the card cap, so the member keeps the card push', () => {
    const q = cardOf(ask('question', 'AskUserQuestion'))
    const long = 'x'.repeat(200 * 1024)
    const line = answeredLine(q, { type: 'question', answers: { 'Which format do you want?': long } })
    expect(line.length).toBeLessThanOrEqual(64 * 1024)
    expect(line.startsWith('You answered: xxx')).toBe(true)
  })
})

describe('chat guards', () => {
  it('isChatAnswer accepts each valid shape and rejects everything else', () => {
    expect(isChatAnswer({ type: 'permission', choice: 'once', suggestion: null, message: null })).toBe(true)
    expect(isChatAnswer({ type: 'permission', choice: 'deny', suggestion: 2, message: 'no' })).toBe(true)
    expect(isChatAnswer({ type: 'question', answers: null })).toBe(true)
    expect(isChatAnswer({ type: 'question', answers: { 'Which parts?': ['Chart', 'Export'], 'Which format?': 'PDF' } })).toBe(true)
    expect(isChatAnswer({ type: 'plan', choice: 'keep-planning', message: null })).toBe(true)
    expect(isChatAnswer({ type: 'dialog', choice: null })).toBe(true)

    expect(isChatAnswer({ type: 'permission', choice: 'always', suggestion: null, message: null })).toBe(false)
    expect(isChatAnswer({ type: 'permission', choice: 'once', suggestion: 1.5, message: null })).toBe(false)
    expect(isChatAnswer({ type: 'permission', choice: 'once', suggestion: -1, message: null })).toBe(false)
    expect(isChatAnswer({ type: 'permission', choice: 'deny', suggestion: null, message: 'x'.repeat(64 * 1024 + 1) })).toBe(false)
    expect(isChatAnswer({ type: 'question', answers: { 'Which parts?': 4 } })).toBe(false)
    expect(isChatAnswer({ type: 'question', answers: { 'Which parts?': [1, 2] } })).toBe(false)
    expect(isChatAnswer({ type: 'plan', choice: 'accept', message: null })).toBe(false)
    expect(isChatAnswer({ type: 'permission', choice: 'once' })).toBe(false)
    expect(isChatAnswer(null)).toBe(false)
    expect(isChatAnswer('once')).toBe(false)
  })

  it("isChatSend takes the origin of a message as absent, 'auto' or 'review', and nothing else", () => {
    expect(isChatSend({ text: 'hi', attachments: [] })).toBe(true)
    expect(isChatSend({ text: 'hi', attachments: [], from: 'auto' })).toBe(true)
    expect(isChatSend({ text: 'hi', attachments: [], from: 'review' })).toBe(true)
    expect(isChatSend({ text: 'hi', attachments: [], from: 'somewhere' })).toBe(false)
    expect(isChatSend({ text: 'hi', attachments: [], from: null })).toBe(false)
  })

  it('isChatSend accepts a message with attachments and rejects bad fields', () => {
    const file = { kind: 'file', path: 'C:\\Work\\notes.txt', name: 'notes.txt', size: 12, cardId: null }
    const image = { kind: 'image', path: '/home/user/shot.png', name: 'shot.png', size: 0, cardId: 'card-1' }
    expect(isChatSend({ text: 'hello', attachments: [] })).toBe(true)
    expect(isChatSend({ text: 'hello', attachments: [file, image] })).toBe(true)

    expect(isChatSend({ text: 'x'.repeat(1024 * 1024 + 1), attachments: [] })).toBe(false)
    expect(isChatSend({ text: 'hi', attachments: Array.from({ length: 21 }, () => file) })).toBe(false)
    expect(isChatSend({ text: 'hi', attachments: [{ ...file, kind: 'video' }] })).toBe(false)
    expect(isChatSend({ text: 'hi', attachments: [{ ...file, path: 'notes.txt' }] })).toBe(false)
    expect(isChatSend({ text: 'hi', attachments: [{ ...file, size: -1 }] })).toBe(false)
    expect(isChatSend({ text: 'hi', attachments: [{ ...file, size: 1.5 }] })).toBe(false)
    expect(isChatSend({ text: 'hi', attachments: [{ ...file, cardId: 7 }] })).toBe(false)
    expect(isChatSend({ text: 'hi', attachments: [{ ...file, cardId: 'c'.repeat(65) }] })).toBe(false)
    expect(isChatSend({ text: 42, attachments: [] })).toBe(false)
    expect(isChatSend({ text: 'hi' })).toBe(false)
  })

  it('isPermissionMode accepts the six modes only', () => {
    for (const m of ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk']) expect(isPermissionMode(m)).toBe(true)
    expect(isPermissionMode('yolo')).toBe(false)
    expect(isPermissionMode(undefined)).toBe(false)
  })
})
