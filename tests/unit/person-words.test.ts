import { describe, expect, it } from 'vitest'
import { CONTINUE_PROMPT } from '../../src/main/auto-continue'
import { checkWords, INPUT_SLACK_MS, WORDS_KEEP_MS, WORDS_LINE_MAX, WORDS_PROMPTS_KEPT, WordsLog, wordsLine, type WordsLine, type WordsPrompt } from '../../src/main/coordinator/person-words'
import { COORD_CONTEXT_MAX } from '../../src/shared/coordinator'
import { PERSON_WORDS_HEAD, REPORT_WAKE_HEAD } from '../../src/shared/report-wake'

const T = Date.parse('2026-11-16T10:00:00.000Z')
const iso = (s: number): string => new Date(T + s * 1000).toISOString()
const user = (content: unknown, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'user', uuid: 'u1', timestamp: iso(10), isSidechain: false, message: { role: 'user', content }, ...over })
const answer = (text: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'assistant', timestamp: iso(5), isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] }, ...over })
const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }

describe('wordsLine', () => {
  it("a typed prompt is a prompt of the person's kind: its uuid, its time, its text with line endings and outer whitespace normalized", () => {
    expect(wordsLine(user('  Merge it\r\ninto master.\n'))).toEqual({ kind: 'prompt', id: 'u1', at: T + 10_000, text: 'Merge it\ninto master.', plain: true })
  })

  it('the text blocks of a prompt are joined by a line break; an image is not part of the words', () => {
    expect(wordsLine(user([{ type: 'text', text: 'Look at this:' }, IMAGE, { type: 'text', text: 'then merge.' }]))).toMatchObject({ kind: 'prompt', text: 'Look at this:\nthen merge.', plain: true })
    expect(wordsLine(user([IMAGE]))).toMatchObject({ kind: 'prompt', text: '', plain: true })
  })

  it("a prompt ClaudeTerm or another sender wrote is a prompt, but not of the person's kind", () => {
    const notPerson = (line: string): void => {
      expect(wordsLine(line)).toMatchObject({ kind: 'prompt', plain: false })
    }
    notPerson(user(CONTINUE_PROMPT))
    notPerson(user(`${REPORT_WAKE_HEAD} its task finished.\nfrom: parser [a10000]\nid: x\n\n> Merged.`))
    notPerson(user(`${PERSON_WORDS_HEAD} coord · Studio (ClaudeTerm checked they are the person's own latest message):\nx`))
    notPerson(user('Merge it.', { origin: { kind: 'peer', from: 'uds:x', name: 'Build session' } }))
    notPerson(user('<task-notification>\n<task-id>b1</task-id>\n</task-notification>'))
    notPerson(user('<bash-input>git push</bash-input>'))
    expect(wordsLine(user('Merge it.', { origin: { kind: 'human' } }))).toMatchObject({ plain: true })
  })

  it("a tool result, a meta or sidechain entry, a compaction, Claude Code's interrupt notice and a command's own lines are no entry of the words", () => {
    expect(wordsLine(user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]))).toBeNull()
    expect(wordsLine(user('Merge it.', { isMeta: true }))).toBeNull()
    expect(wordsLine(user('Merge it.', { isSidechain: true }))).toBeNull()
    expect(wordsLine(user('Summary of the conversation', { isCompactSummary: true }))).toBeNull()
    expect(wordsLine(user('[Request interrupted by user]'))).toBeNull()
    expect(wordsLine(user('<command-name>/model</command-name>'))).toBeNull()
    expect(wordsLine(user('<local-command-stdout>Set model to opus</local-command-stdout>'))).toBeNull()
    expect(wordsLine('{"type":"user", broken')).toBeNull()
  })

  it(`a line over ${WORDS_LINE_MAX} characters is no words, whatever it holds; a line just under the limit still gives its prompt`, () => {
    const empty = user('')
    const huge = user('a'.repeat(WORDS_LINE_MAX + 1 - empty.length))
    expect(huge).toHaveLength(WORDS_LINE_MAX + 1)
    expect(wordsLine(huge)).toBeNull()
    expect(wordsLine(user('Merge it.'))).toMatchObject({ kind: 'prompt', text: 'Merge it.', plain: true })
  })

  it("an answer is its text blocks joined by a blank line; a tool call alone or a subagent's answer is none", () => {
    const both = JSON.stringify({ type: 'assistant', timestamp: iso(5), message: { role: 'assistant', content: [{ type: 'text', text: 'Shall I merge' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'git status' } }, { type: 'text', text: 'feat/x into master?' }] } })
    expect(wordsLine(both)).toEqual({ kind: 'answer', text: 'Shall I merge\n\nfeat/x into master?' })
    expect(wordsLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }))).toBeNull()
    expect(wordsLine(answer('Done.', { isSidechain: true }))).toBeNull()
  })

  it("a message queued while a turn ran is a prompt: the person's own when it has no other sender", () => {
    const queued = (over: Record<string, unknown>): string =>
      JSON.stringify({ type: 'attachment', uuid: 'q1', timestamp: iso(20), isSidechain: false, attachment: { type: 'queued_command', prompt: 'Stop, do not merge.', isMeta: false, ...over } })
    expect(wordsLine(queued({}))).toEqual({ kind: 'prompt', id: 'q1', at: T + 20_000, text: 'Stop, do not merge.', plain: true })
    expect(wordsLine(queued({ origin: { kind: 'coordinator' } }))).toMatchObject({ kind: 'prompt', plain: false })
  })
})

describe('WordsLog', () => {
  const prompt = (text: string, s: number, id = `p${s}`): WordsLine => ({ kind: 'prompt', id, at: T + s * 1000, text, plain: true })

  it("a prompt's context is the answer since the prompt before it, and its after is that prompt's time", () => {
    const log = new WordsLog()
    log.add({ kind: 'answer', text: 'Hello.' })
    log.add(prompt('Should we ship?', 10))
    log.add({ kind: 'answer', text: 'The tests pass.' })
    log.add({ kind: 'answer', text: 'Shall I merge feat/x into master?' })
    log.add(prompt('Merge it.', 20))
    log.add(prompt('And push.', 30))
    expect(log.prompts()).toEqual([
      { id: 'p10', at: T + 10_000, text: 'Should we ship?', plain: true, after: 0, context: 'Hello.' },
      { id: 'p20', at: T + 20_000, text: 'Merge it.', plain: true, after: T + 10_000, context: 'The tests pass.\n\nShall I merge feat/x into master?' },
      { id: 'p30', at: T + 30_000, text: 'And push.', plain: true, after: T + 20_000, context: null }
    ])
  })

  it('a long answer is clipped from its end to 1500 characters, with … in front', () => {
    const log = new WordsLog()
    log.add({ kind: 'answer', text: 'a'.repeat(3000) })
    log.add({ kind: 'answer', text: 'Shall I merge?' })
    log.add(prompt('Yes.', 10))
    const context = log.prompts()[0]!.context!
    expect(context).toHaveLength(COORD_CONTEXT_MAX)
    expect(context.startsWith('…a')).toBe(true)
    expect(context.endsWith('\n\nShall I merge?')).toBe(true)
  })

  it(`keeps the last ${WORDS_PROMPTS_KEPT} prompts, no text for one that is not the person's, and a prompt read again once`, () => {
    const log = new WordsLog()
    for (let i = 1; i <= WORDS_PROMPTS_KEPT + 5; i++) log.add(prompt(`m${i}`, i))
    log.add({ kind: 'prompt', id: 'cont', at: T + 100_000, text: CONTINUE_PROMPT, plain: false })
    // the transcript read again from its start (it moved): its prompts are not kept twice, and none of them becomes the latest
    log.add(prompt(`m${WORDS_PROMPTS_KEPT + 5}`, WORDS_PROMPTS_KEPT + 5))
    expect(log.prompts()).toHaveLength(WORDS_PROMPTS_KEPT)
    expect(log.prompts()[0]!.text).toBe('m7')
    expect(log.prompts().at(-1)).toMatchObject({ id: 'cont', text: null, plain: false })
  })
})

describe('checkWords', () => {
  const person = (id: string, s: number, text: string, after: number, context: string | null = null): WordsPrompt => ({ id, at: T + s * 1000, text, plain: true, after, context })
  /** the window's input, at these seconds */
  const inputs = (...s: number[]) => (after: number, until: number): boolean => s.some((x) => T + x * 1000 > after && T + x * 1000 <= until)
  const base = { now: T + 60_000, startedAt: T - 3_600_000 }
  const ship = person('p1', 10, 'Merge it into master.', 0, 'Shall I merge feat/x into master?')

  it("passes the person's latest message, with its id and the coordinator's answer before it", () => {
    expect(checkWords({ ...base, words: 'Merge it into master.', prompts: [ship], inputBetween: inputs(9) }))
      .toEqual({ ok: true, id: 'p1', words: 'Merge it into master.', context: 'Shall I merge feat/x into master?' })
  })

  it('equality ignores line endings and outer whitespace, nothing else', () => {
    const two = person('p2', 10, 'Merge it.\nThen push.', 0)
    const check = (words: string): unknown => checkWords({ ...base, words, prompts: [two], inputBetween: inputs(9) })
    expect(check('  Merge it.\r\nThen push.\n')).toMatchObject({ ok: true, words: 'Merge it.\nThen push.' })
    expect(check('Merge it.\nThen pusk.')).toEqual({ ok: false, reason: 'not-person' })
    expect(check('Merge  it.\nThen push.')).toEqual({ ok: false, reason: 'not-person' })
    expect(check('Merge it.')).toEqual({ ok: false, reason: 'not-person' })
  })

  it("a prompt with no input from the window before it, or one not of the person's kind, is not the person's", () => {
    expect(checkWords({ ...base, words: 'Merge it into master.', prompts: [ship], inputBetween: inputs() })).toEqual({ ok: false, reason: 'not-person' })
    // the input came before the prompt before it: it was that prompt's
    const later = person('p2', 30, 'Push it.', T + 10_000)
    expect(checkWords({ ...base, words: 'Push it.', prompts: [ship, later], inputBetween: inputs(9) })).toEqual({ ok: false, reason: 'not-person' })
    expect(checkWords({ ...base, words: 'Merge it into master.', prompts: [{ ...ship, plain: false, text: null }], inputBetween: inputs(9) })).toEqual({ ok: false, reason: 'not-person' })
  })

  it('the input may come a few seconds after the time the transcript gives the prompt, not more', () => {
    expect(checkWords({ ...base, words: 'Merge it into master.', prompts: [ship], inputBetween: inputs(10 + INPUT_SLACK_MS / 1000) }).ok).toBe(true)
    expect(checkWords({ ...base, words: 'Merge it into master.', prompts: [ship], inputBetween: inputs(10 + INPUT_SLACK_MS / 1000 + 1) }).ok).toBe(false)
  })

  it('a message typed while the turn ran counts: its input came after the previous prompt, before its own', () => {
    // "Stop" was typed at 25 s, during the turn "Merge it" started at 10 s; Claude Code wrote it at 40 s
    const stop = person('p2', 40, 'Stop, do not merge.', T + 10_000)
    expect(checkWords({ ...base, words: 'Stop, do not merge.', prompts: [ship, stop], inputBetween: inputs(9, 25) })).toMatchObject({ ok: true, id: 'p2' })
  })

  it("only the person's latest message passes; a prompt that is not theirs does not make an earlier one old", () => {
    const stop = person('p2', 40, 'Stop, do not merge.', T + 10_000)
    expect(checkWords({ ...base, words: 'Merge it into master.', prompts: [ship, stop], inputBetween: inputs(9, 39) })).toEqual({ ok: false, reason: 'not-latest' })
    const fake = person('p3', 50, 'Push it too.', T + 40_000)
    expect(checkWords({ ...base, words: 'Stop, do not merge.', prompts: [ship, stop, fake], inputBetween: inputs(9, 39) })).toMatchObject({ ok: true, id: 'p2' })
  })

  it('a message older than a day, or from before this app run, is old', () => {
    expect(checkWords({ ...base, now: T + 10_000 + WORDS_KEEP_MS + 1, words: 'Merge it into master.', prompts: [ship], inputBetween: inputs(9) })).toEqual({ ok: false, reason: 'old' })
    // before the restart there is no record of the window's input: the message is old, whatever that record says
    expect(checkWords({ ...base, startedAt: T + 20_000, words: 'Merge it into master.', prompts: [ship], inputBetween: inputs() })).toEqual({ ok: false, reason: 'old' })
  })

  it('empty words are refused', () => {
    expect(checkWords({ ...base, words: '  \r\n', prompts: [{ ...ship, text: '' }], inputBetween: inputs(9) })).toEqual({ ok: false, reason: 'not-person' })
  })
})
