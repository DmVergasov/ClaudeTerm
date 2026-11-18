import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COORD_TOOL_DESCRIPTIONS, coordTool, type CoordToolDeps } from '../../src/mcp/coordinator-tools'
import { PipeUnavailableError } from '../../src/shared/pipe-client'
import type { CoordMessage, PipeResponse } from '../../src/shared/protocol'
import { WIN } from '../fixtures/platform'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const CWD = WIN ? 'C:\\proj' : '/proj'
const deps = (send: CoordToolDeps['send'], tabId: string | null = TAB): CoordToolDeps => ({ tabId, pipeName: 'pipe', cwd: CWD, send })
const refuse = async (): Promise<PipeResponse> => {
  throw new Error('must not be called')
}

describe('coordTool', () => {
  it('each tool sends its op with the tab id and returns the info', async () => {
    const sent: CoordMessage[] = []
    const send: CoordToolDeps['send'] = async (_p, m) => {
      sent.push(m)
      return { ok: true, info: 'answer' }
    }
    const calls = [
      ['list_sessions', { op: 'list' }],
      ['attach_session', { op: 'attach', session: 'a10000' }],
      ['detach_session', { op: 'detach', session: 'a10000' }],
      ['read_session', { op: 'read', session: 'a10000' }],
      ['resolve_session', { op: 'resolve', session: 'a10000' }],
      ['message_session', { op: 'message', session: 'a10000', text: 'Fix the parser.' }]
    ] as const
    for (const [name, op] of calls) expect(await coordTool(name, op, deps(send))).toEqual({ text: 'answer', isError: false })
    expect(sent).toEqual(calls.map(([, op]) => ({ v: 1, type: 'coord', tabId: TAB, ...op })))
  })

  it('start_session resolves a relative folder against the folder Claude runs in, and waits 30 s for the answer', async () => {
    const sent: CoordMessage[] = []
    const timeouts: number[] = []
    const r = await coordTool('start_session', { op: 'start', task: 'T', name: null, folder: 'pkg', device: null, worktree: null }, deps(async (_p, m, ms) => {
      sent.push(m)
      timeouts.push(ms)
      return { ok: true, info: 'Started a10000.' }
    }))
    expect(sent[0]).toEqual({ v: 1, type: 'coord', tabId: TAB, op: 'start', task: 'T', name: null, folder: join(CWD, 'pkg'), device: null, worktree: null })
    expect(timeouts).toEqual([30000])
    expect(r).toEqual({ text: 'Started a10000.', isError: false })
  })

  it('start_session with a device passes the folder as it is: it is a path on that device', async () => {
    const sent: CoordMessage[] = []
    await coordTool('start_session', { op: 'start', task: 'T', name: null, folder: 'relative/acme', device: 'Laptop', worktree: null }, deps(async (_p, m) => {
      sent.push(m)
      return { ok: true, info: 'Started a10000.' }
    }))
    expect(sent[0]).toMatchObject({ folder: 'relative/acme', device: 'Laptop' })
  })

  it('attach_session waits 15 s for its answer', async () => {
    const timeouts: number[] = []
    await coordTool('attach_session', { op: 'attach', session: 'a10000' }, deps(async (_p, _m, ms) => {
      timeouts.push(ms)
      return { ok: true, info: 'Attaching.' }
    }))
    expect(timeouts).toEqual([15000])
  })

  it('the other tools wait 3 s for the answer', async () => {
    const timeouts: number[] = []
    await coordTool('list_sessions', { op: 'list' }, deps(async (_p, _m, ms) => {
      timeouts.push(ms)
      return { ok: true }
    }))
    expect(timeouts).toEqual([3000])
  })

  it("message_session with words sends them and waits 10 s for its answer: main reads the coordinator's transcript first", async () => {
    const sent: CoordMessage[] = []
    const timeouts: number[] = []
    await coordTool('message_session', { op: 'message', session: 'a10000', text: 'Merge feat/x.', words: 'Merge it.' }, deps(async (_p, m, ms) => {
      sent.push(m)
      timeouts.push(ms)
      return { ok: true, info: 'Given.' }
    }))
    expect(sent[0]).toEqual({ v: 1, type: 'coord', tabId: TAB, op: 'message', session: 'a10000', text: 'Merge feat/x.', words: 'Merge it.' })
    expect(timeouts).toEqual([10000])
  })

  it("answer_session sends the answer op with the questions and waits as long as words do", async () => {
    const sent: CoordMessage[] = []
    const timeouts: number[] = []
    const r = await coordTool('answer_session', { op: 'answer', session: 'a10000', questions: ['Where should the browser live?'] }, deps(async (_p, m, ms) => {
      sent.push(m)
      timeouts.push(ms)
      return { ok: true, info: 'Answered.' }
    }))
    expect(sent).toEqual([{ v: 1, type: 'coord', tabId: TAB, op: 'answer', session: 'a10000', questions: ['Where should the browser live?'] }])
    expect(timeouts).toEqual([10000])
    expect(r).toEqual({ text: 'Answered.', isError: false })
  })

  it('says Done. when ClaudeTerm sends no info', async () => {
    expect(await coordTool('resolve_session', { op: 'resolve', session: 'a10000' }, deps(async () => ({ ok: true }))))
      .toEqual({ text: 'Done.', isError: false })
  })

  it('returns a refusal of ClaudeTerm as an error', async () => {
    expect(await coordTool('attach_session', { op: 'attach', session: 'a10000' }, deps(async () => ({ ok: false, error: 'a10000 is attached to another coordinator.' }))))
      .toEqual({ text: 'a10000 is attached to another coordinator.', isError: true })
  })

  it('needs a ClaudeTerm Claude tab and sends nothing', async () => {
    expect(await coordTool('list_sessions', { op: 'list' }, deps(refuse, null)))
      .toEqual({ text: 'list_sessions works only in a ClaudeTerm Claude tab', isError: true })
  })

  it('says ClaudeTerm is not running when the pipe is unavailable', async () => {
    const r = await coordTool('list_sessions', { op: 'list' }, deps(async () => { throw new PipeUnavailableError('x') }))
    expect(r).toEqual({ text: 'ClaudeTerm is not running.', isError: true })
  })

  it('reports another failure of the request as an error', async () => {
    expect(await coordTool('list_sessions', { op: 'list' }, deps(async () => { throw new Error('boom') })))
      .toEqual({ text: 'ClaudeTerm request failed: boom', isError: true })
  })
})

const DELEGATE = 'As the coordinator, give the work to its sessions with message_session or start_session, and do it yourself only when the person asks you to; your own subagents (the Agent tool) are only for looking things up while you plan.'

const QUESTIONS = "A session's permission prompts are the person's to answer in that session: never answer one. A session's questions come to you as question notes: ask the person them with AskUserQuestion, then pass the answers with answer_session. When a report or a progress note ends with a question to the person, ask it with AskUserQuestion and give the answer with message_session."
const LANGUAGE = "Write to the person in the language of their own messages, even when reports, notes and tool results are in English, and write the tasks you give sessions in it too: the person reads them in the sessions' tabs."

describe('COORD_TOOL_DESCRIPTIONS', () => {
  it('the list_sessions description ends with the delegation sentence', () => {
    expect(COORD_TOOL_DESCRIPTIONS.list_sessions.slice(-DELEGATE.length)).toBe(DELEGATE)
  })

  it('list_sessions and message_session say what a progress note means; list_sessions still ends with the delegation sentence', () => {
    const PROGRESS = "A progress note means the task is still running."
    expect(COORD_TOOL_DESCRIPTIONS.list_sessions).toContain(PROGRESS)
    expect(COORD_TOOL_DESCRIPTIONS.message_session).toContain(PROGRESS)
    expect(COORD_TOOL_DESCRIPTIONS.list_sessions.slice(-DELEGATE.length)).toBe(DELEGATE)
  })

  it("message_session and start_session tell the coordinator when to pass the person's words", () => {
    const WORDS = "When the person's message tells a session what it may do (a go to merge, push, release or delete), pass that message as `words`, exactly as they wrote it. The session acts on the person's words. It does not act on your own."
    expect(COORD_TOOL_DESCRIPTIONS.message_session).toContain(WORDS)
    expect(COORD_TOOL_DESCRIPTIONS.start_session).toContain(WORDS)
  })

  it("the descriptions carry the questions' rule (list_sessions), the language (start_session, message_session), and read_session's question", () => {
    expect(COORD_TOOL_DESCRIPTIONS.list_sessions).toContain("A permission prompt waiting in a session is the user's to answer there: tell the user once where it waits, never answer it. " + QUESTIONS)
    expect(COORD_TOOL_DESCRIPTIONS.list_sessions).toContain(QUESTIONS)
    expect(COORD_TOOL_DESCRIPTIONS.start_session.endsWith(` ${LANGUAGE}`)).toBe(true)
    expect(COORD_TOOL_DESCRIPTIONS.message_session.endsWith(` ${LANGUAGE}`)).toBe(true)
    expect(COORD_TOOL_DESCRIPTIONS.read_session).toContain("a question waiting for the person's answer through you")
  })

  it('answer_session says the answers come from the coordinator\'s question form and are typed into the session as the person\'s words', () => {
    const description = COORD_TOOL_DESCRIPTIONS.answer_session
    expect(description.startsWith("Coordinator only: pass the person's answers to a session's question. ")).toBe(true)
    expect(description).toContain('ClaudeTerm takes the person\'s answers from your question form, checks that the person gave them, and types them into the session as the person\'s words; the session goes on with its task.')
  })

  it('start_session tells the coordinator that a session whose EnterWorktree fails stops and reports the error', () => {
    expect(COORD_TOOL_DESCRIPTIONS.start_session).toContain('If EnterWorktree fails, the session makes no worktree another way: it stops and reports the error as its result.')
  })
})
