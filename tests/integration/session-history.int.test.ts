import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionHistory } from '../../src/main/session-history'

const OLD = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const RECENT = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
const NOW = Date.parse('2026-11-19T12:00:00.000Z')
const DAY = 24 * 3600 * 1000

const at = (ms: number): string => new Date(ms).toISOString()
const ask = (text: string, ms: number): object => ({ type: 'user', cwd: 'D:\\work', entrypoint: 'cli', isSidechain: false, timestamp: at(ms), message: { role: 'user', content: text } })
const answer = (text: string, ms: number): object => ({ type: 'assistant', cwd: 'D:\\work', entrypoint: 'cli', isSidechain: false, timestamp: at(ms), message: { role: 'assistant', content: [{ type: 'text', text }] } })
/** what Claude Code appends with no new work: bookkeeping lines with no message, some with a time of their own */
const bookkeeping = (ms: number): object[] => [
  { type: 'system', subtype: 'turn_duration', cwd: 'D:\\work', entrypoint: 'cli', isSidechain: false, timestamp: at(ms) },
  { type: 'last-prompt', lastPrompt: 'Where is the log?' },
  { type: 'ai-title', aiTitle: 'Find the log' },
  { type: 'file-history-snapshot', messageId: 'm1', snapshot: { timestamp: at(ms) } },
  { type: 'cost-state' }
]

// a transcript Claude Code wrote at `lines`' times and something touched later, at `mtime`
describe('Recent sessions date a session by its last message, as Claude Code /resume does', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  function projects(sessions: { id: string; lines: object[]; mtime: number }[]): string {
    const root = mkdtempSync(join(tmpdir(), 'ct-session-history-'))
    roots.push(root)
    const dir = join(root, 'projects', 'D--work')
    mkdirSync(dir, { recursive: true })
    for (const s of sessions) {
      const file = join(dir, `${s.id}.jsonl`)
      writeFileSync(file, s.lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
      utimesSync(file, new Date(s.mtime), new Date(s.mtime))
    }
    return join(root, 'projects')
  }

  it('a session worked on three weeks ago and touched today is dated three weeks ago, and is listed after one worked on three days ago', async () => {
    const weeksAgo = NOW - 21 * DAY
    const daysAgo = NOW - 3 * DAY
    const dir = projects([
      { id: OLD, lines: [ask('Where is the log?', weeksAgo - 60_000), answer('In the logs folder.', weeksAgo), ...bookkeeping(weeksAgo + 30 * DAY)], mtime: NOW },
      { id: RECENT, lines: [ask('Ship it', daysAgo - 60_000), answer('Shipped.', daysAgo)], mtime: daysAgo }
    ])
    const list = await new SessionHistory(() => [{ account: null, projects: dir }]).list(10)
    expect(list.map((s) => [s.id, s.modifiedAt])).toEqual([[RECENT, daysAgo], [OLD, weeksAgo]])
  })

  it('the limit keeps the session worked on last, not the transcript touched last', async () => {
    const dir = projects([
      { id: OLD, lines: [ask('Where is the log?', NOW - 21 * DAY)], mtime: NOW },
      { id: RECENT, lines: [ask('Ship it', NOW - 3 * DAY)], mtime: NOW - 3 * DAY }
    ])
    const list = await new SessionHistory(() => [{ account: null, projects: dir }]).list(1)
    expect(list.map((s) => s.id)).toEqual([RECENT])
  })

  it('a transcript with no message time, or a broken one, is dated by its file; a time past the file is cut to it', async () => {
    const third = '6e3d2c8b-9f50-4b4c-a2d3-e4f5a6b7c8d9'
    const dir = projects([
      { id: OLD, lines: [{ ...ask('no time', 0), timestamp: undefined }], mtime: NOW - 5 * DAY },
      { id: RECENT, lines: [{ ...ask('broken time', 0), timestamp: 'yesterday-ish' }], mtime: NOW - 6 * DAY },
      { id: third, lines: [ask('from the future', NOW + 400 * DAY)], mtime: NOW - 7 * DAY }
    ])
    const list = await new SessionHistory(() => [{ account: null, projects: dir }]).list(10)
    expect(list.map((s) => [s.id, s.modifiedAt])).toEqual([[OLD, NOW - 5 * DAY], [RECENT, NOW - 6 * DAY], [third, NOW - 7 * DAY]])
  })
})
