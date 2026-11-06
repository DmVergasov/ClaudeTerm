import { describe, expect, it } from 'vitest'
import { assistantTime, interruptTime, parseEditEvents, turnReport } from '../../src/main/transcript-edits'
import { assistantLine, editResultLine, HANDBACK_ORIGIN, interruptLine, PEER_ORIGIN, promptLine, textLine, toolResultLine, turnPromptLine } from '../fixtures/transcript'

const HUNK = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }

describe('parseEditEvents', () => {
  it('reads a typed prompt in the main transcript as a turn start', () => {
    expect(parseEditEvents(promptLine('fix the bug', { timestamp: '2026-10-08T10:00:00.000Z', uuid: 'p1' }), { main: true }))
      .toEqual([{ kind: 'prompt', at: Date.parse('2026-10-08T10:00:00.000Z'), id: 'p1' }])
  })

  it('takes text blocks as a prompt, but not tool results, meta, sidechain or subagent entries', () => {
    const blocks = JSON.stringify({ type: 'user', uuid: 'p2', timestamp: '2026-10-08T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } })
    expect(parseEditEvents(blocks, { main: true })).toHaveLength(1)
    expect(parseEditEvents(toolResultLine('t1'), { main: true })).toEqual([])
    expect(parseEditEvents(promptLine('x', { isMeta: true }), { main: true })).toEqual([])
    expect(parseEditEvents(promptLine('x', { isSidechain: true }), { main: true })).toEqual([])
    expect(parseEditEvents(promptLine('x'), { main: false })).toEqual([])
    const compact = JSON.stringify({ type: 'user', uuid: 'c', isCompactSummary: true, message: { role: 'user', content: 'summary' } })
    expect(parseEditEvents(compact, { main: true })).toEqual([])
  })

  it('reads an Edit result with its patch and original file', () => {
    const line = editResultLine({ toolUseId: 'toolu_1', filePath: 'D:\\p\\a.ts', patch: [HUNK], originalFile: 'a\n', timestamp: '2026-10-08T10:00:05.000Z' })
    expect(parseEditEvents(line, { main: true })).toEqual([
      { kind: 'edit', at: Date.parse('2026-10-08T10:00:05.000Z'), toolUseId: 'toolu_1', path: 'D:\\p\\a.ts', created: false, originalFile: 'a\n', patch: [HUNK] }
    ])
  })

  it('reads a Write that creates a file, also in a subagent transcript', () => {
    const line = editResultLine({ toolUseId: 'toolu_2', filePath: '/p/new.ts', created: true })
    expect(parseEditEvents(line, { main: false })).toMatchObject([{ kind: 'edit', created: true, originalFile: null, patch: [] }])
  })

  it('drops malformed hunks and lines that are not JSON', () => {
    const line = editResultLine({ toolUseId: 't', filePath: '/p/a.ts', patch: [HUNK, { oldStart: 'x' } as never] })
    expect(parseEditEvents(line, { main: true })).toMatchObject([{ patch: [HUNK] }])
    expect(parseEditEvents('{"structuredPatch": ', { main: true })).toEqual([])
  })
})

describe('assistantTime', () => {
  it('gives the time of assistant entries and null for the rest', () => {
    expect(assistantTime(assistantLine('claude-opus-5-5'))).toBe(Date.parse('2026-10-05T10:00:03.000Z'))
    expect(assistantTime(promptLine('x'))).toBeNull()
    expect(assistantTime('not json "type":"assistant"')).toBeNull()
  })

  it('is 0 for an assistant entry without a usable timestamp', () => {
    expect(assistantTime(textLine)).toBe(0)
    expect(assistantTime(JSON.stringify({ type: 'assistant', timestamp: 'nope' }))).toBe(0)
  })
})

describe('interruptTime', () => {
  it('gives the time of the entry Claude Code writes when the user interrupts a turn', () => {
    expect(interruptTime(interruptLine())).toBe(Date.parse('2026-10-08T10:00:07.000Z'))
    expect(interruptTime(interruptLine({ forToolUse: true, timestamp: '2026-10-08T10:00:09.000Z' }))).toBe(Date.parse('2026-10-08T10:00:09.000Z'))
    const asText = JSON.stringify({ type: 'user', timestamp: '2026-10-08T10:00:08.000Z', message: { role: 'user', content: '[Request interrupted by user]' } })
    expect(interruptTime(asText)).toBe(Date.parse('2026-10-08T10:00:08.000Z'))
    expect(interruptTime(JSON.stringify({ type: 'user', message: { role: 'user', content: '[Request interrupted by user]' } }))).toBe(0)
  })

  it('is null for other lines, also ones that only mention the marker', () => {
    expect(interruptTime(promptLine('fix the bug'))).toBeNull()
    expect(interruptTime(promptLine('why do I see [Request interrupted by user] here?'))).toBeNull()
    const quoted = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '[Request interrupted by user]' }] } })
    expect(interruptTime(quoted)).toBeNull()
    const said = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })
    expect(interruptTime(said)).toBeNull()
    expect(interruptTime('[Request interrupted by user] not json')).toBeNull()
  })
})

describe('turnReport', () => {
  it('gives the turn index of a prompt, and whether a message from another session started it', () => {
    expect(turnReport(turnPromptLine('fix the bug', { turnIndex: 4 }), { main: true })).toEqual({ turnIndex: 4, peer: false })
    expect(turnReport(turnPromptLine('build is green', { turnIndex: 5, origin: PEER_ORIGIN }), { main: true })).toEqual({ turnIndex: 5, peer: true })
  })

  it('a subagent report to its parent is not a message from another session', () => {
    expect(turnReport(turnPromptLine('review done', { turnIndex: 6, origin: HANDBACK_ORIGIN }), { main: true })).toEqual({ turnIndex: 6, peer: false })
  })

  it('a turn without a valid position gives nothing: an older Claude Code, or a malformed entry', () => {
    expect(turnReport(promptLine('no position'), { main: true })).toBeNull()
    expect(turnReport(turnPromptLine('x', { turnIndex: '2' }), { main: true })).toBeNull()
    expect(turnReport(turnPromptLine('x', { turnIndex: -1 }), { main: true })).toBeNull()
    expect(turnReport(turnPromptLine('x', { turnIndex: 1.5 }), { main: true })).toBeNull()
    expect(turnReport(turnPromptLine('x', { turnIndex: null }), { main: true })).toBeNull()
    expect(turnReport('{"type":"user","turnPosition": ', { main: true })).toBeNull()
  })

  it('an origin that is missing or malformed is a human turn', () => {
    expect(turnReport(turnPromptLine('x', { turnIndex: 2, origin: null }), { main: true })).toEqual({ turnIndex: 2, peer: false })
    expect(turnReport(turnPromptLine('x', { turnIndex: 2, origin: 'peer' }), { main: true })).toEqual({ turnIndex: 2, peer: false })
  })

  it('reads only the main transcript\'s user entries, never a subagent\'s or a sidechain\'s', () => {
    expect(turnReport(turnPromptLine('x', { turnIndex: 3, origin: PEER_ORIGIN }), { main: false })).toBeNull()
    const sidechain = JSON.parse(turnPromptLine('x', { turnIndex: 3, origin: PEER_ORIGIN }))
    expect(turnReport(JSON.stringify({ ...sidechain, isSidechain: true }), { main: true })).toBeNull()
    const assistant = JSON.stringify({ type: 'assistant', turnPosition: { promptIndex: 0, turnIndex: 3 }, message: { role: 'assistant', content: 'x' } })
    expect(turnReport(assistant, { main: true })).toBeNull()
  })
})
