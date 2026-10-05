import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startPipeServer, type PipeHandlers, type PipeServerHandle } from '../../src/main/pipe-server'
import { PipeUnavailableError, sendPipeMessage } from '../../src/shared/pipe-client'
import type { SessionMessage, ShowImageMessage } from '../../src/shared/protocol'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const newPipe = (): string => `\\\\.\\pipe\\claudeterm-test-${randomUUID()}`
const okHandlers: PipeHandlers = {
  showImage: async () => ({ ok: true }),
  session: () => ({ ok: true }),
  status: () => ({ ok: true }),
  subagent: () => ({ ok: true }),
  sessionEnd: () => ({ ok: true }),
  attention: () => ({ ok: true })
}

let server: PipeServerHandle | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

function rawLines(pipe: string, payload: string, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const s = connect(pipe)
    let buf = ''
    s.setEncoding('utf8')
    s.on('connect', () => s.write(payload))
    s.on('data', (c: string) => {
      buf += c
      const lines = buf.split('\n').filter(Boolean)
      if (lines.length >= count) {
        s.destroy()
        resolve(lines.slice(0, count))
      }
    })
    s.on('error', reject)
  })
}

describe('pipe server + client', () => {
  it('routes show_image to the handler and returns its response', async () => {
    const pipe = newPipe()
    const got: ShowImageMessage[] = []
    server = await startPipeServer(pipe, { ...okHandlers, showImage: async (m) => { got.push(m); return { ok: true } } })
    const res = await sendPipeMessage(pipe, { v: 1, type: 'show_image', tabId: TAB, path: 'C:\\x\\a.png', caption: null })
    expect(res).toEqual({ ok: true })
    expect(got).toEqual([{ v: 1, type: 'show_image', tabId: TAB, path: 'C:\\x\\a.png', caption: null }])
  })

  it('routes session messages', async () => {
    const pipe = newPipe()
    const got: SessionMessage[] = []
    server = await startPipeServer(pipe, { ...okHandlers, session: (m) => { got.push(m); return { ok: false, error: 'not a claude tab' } } })
    const msg: SessionMessage = { v: 1, type: 'session', tabId: TAB, sessionId: SID, source: 'startup', transcriptPath: null }
    expect(await sendPipeMessage(pipe, msg)).toEqual({ ok: false, error: 'not a claude tab' })
    expect(got).toEqual([msg])
  })

  it('routes status, subagent and session_end messages', async () => {
    const pipe = newPipe()
    const got: string[] = []
    server = await startPipeServer(pipe, {
      ...okHandlers,
      status: (m) => { got.push(m.type); return { ok: true } },
      subagent: (m) => { got.push(`${m.type}:${m.event}`); return { ok: true } },
      sessionEnd: (m) => { got.push(m.type); return { ok: false, error: 'unknown claude tab' } }
    })
    expect(await sendPipeMessage(pipe, { v: 1, type: 'status', tabId: TAB, sessionId: SID, model: { id: 'm', displayName: 'M' }, effort: null, context: null, fiveHour: null })).toEqual({ ok: true })
    expect(await sendPipeMessage(pipe, { v: 1, type: 'subagent', tabId: TAB, sessionId: SID, event: 'start', agentId: 'a1', agentType: 'Explore' })).toEqual({ ok: true })
    expect(await sendPipeMessage(pipe, { v: 1, type: 'session_end', tabId: TAB, sessionId: SID })).toEqual({ ok: false, error: 'unknown claude tab' })
    expect(got).toEqual(['status', 'subagent:start', 'session_end'])
  })

  it('returns validation errors for malformed lines', async () => {
    const pipe = newPipe()
    server = await startPipeServer(pipe, okHandlers)
    const [line] = await rawLines(pipe, '{"v":1,"type":"show_image","path":"rel.png"}\n', 1)
    expect(JSON.parse(line)).toEqual({ ok: false, error: 'path must be an absolute path' })
  })

  it('turns handler exceptions into ok:false', async () => {
    const pipe = newPipe()
    server = await startPipeServer(pipe, { ...okHandlers, showImage: async () => { throw new Error('boom') } })
    expect(await sendPipeMessage(pipe, { v: 1, type: 'show_image', tabId: null, path: 'C:\\a.png', caption: null })).toEqual({ ok: false, error: 'boom' })
  })

  it('answers several messages on one connection in order', async () => {
    const pipe = newPipe()
    let n = 0
    server = await startPipeServer(pipe, { ...okHandlers, showImage: async () => (++n === 1 ? { ok: true } : { ok: false, error: 'second' }) })
    const one = JSON.stringify({ v: 1, type: 'show_image', path: 'C:\\a.png' })
    const lines = await rawLines(pipe, `${one}\n${one}\n`, 2)
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ ok: true }, { ok: false, error: 'second' }])
  })

  it('client rejects with PipeUnavailableError when nobody listens', async () => {
    await expect(sendPipeMessage(newPipe(), { v: 1, type: 'show_image', tabId: null, path: 'C:\\a.png', caption: null }, 500)).rejects.toBeInstanceOf(PipeUnavailableError)
  })
  function collectUntilClose(pipe: string, chunks: string[], gapMs: number): Promise<string[]> {
    return new Promise((resolve) => {
      const s = connect(pipe)
      let buf = ''
      s.setEncoding('utf8')
      s.on('connect', async () => {
        for (const c of chunks) {
          s.write(c)
          await new Promise((r) => setTimeout(r, gapMs))
        }
        setTimeout(() => s.destroy(), 200)
      })
      s.on('data', (c: string) => { buf += c })
      s.on('error', () => { /* server may hang up first */ })
      s.on('close', () => resolve(buf.split('\n').filter(Boolean)))
    })
  }

  it('rejects an oversize line delivered across several chunks, without calling the handler', async () => {
    const pipe = newPipe()
    let calls = 0
    server = await startPipeServer(pipe, { ...okHandlers, showImage: async () => { calls++; return { ok: true } } })
    const big = 'a'.repeat(50 * 1024)
    const lines = await collectUntilClose(pipe, [big, big + '\n'], 50)
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ ok: false, error: 'message too large' }])
    expect(calls).toBe(0)
  })

  it('stops processing the connection after message too large', async () => {
    const pipe = newPipe()
    let calls = 0
    server = await startPipeServer(pipe, { ...okHandlers, showImage: async () => { calls++; return { ok: true } } })
    const valid = JSON.stringify({ v: 1, type: 'show_image', path: 'C:/a.png' }) + '\n'
    const lines = await collectUntilClose(pipe, ['a'.repeat(70 * 1024) + '\n' + valid + valid], 80)
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ ok: false, error: 'message too large' }])
    expect(calls).toBe(0)
  })
})
