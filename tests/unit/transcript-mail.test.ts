import { describe, expect, it } from 'vitest'
import { PeerMailParser } from '../../src/main/transcript-mail'
import { HANDBACK_ORIGIN, peerMessageLine, promptLine, sendMessageLines, toolResultLine, toolUseLine } from '../fixtures/transcript'

const MSG = '3b9f6a52-7c1d-4e8a-9f20-5d6e7a8b9c0d'
const AT = '2026-10-08T10:00:00.000Z'
const peer = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'peer', from: 'uds:build-session', msg_id: MSG, name: 'Build session', fromMode: 'prompting', body: 'The build is green', ...o
})

function parse(lines: string[]): ReturnType<PeerMailParser['parseLine']>[] {
  const p = new PeerMailParser()
  return lines.map((line) => p.parseLine(line)).filter((m) => m !== null)
}

describe('PeerMailParser', () => {
  it('a SendMessage call with a result that names its message is a message sent: to whom, its text, its id and time', () => {
    expect(parse(sendMessageLines('t1', { to: 'Review agent', summary: 'Ready', message: 'Ready for review' }, { msgId: MSG }))).toEqual([
      { kind: 'sent', id: MSG, peer: 'Review agent', text: 'Ready for review', at: Date.parse(AT) }
    ])
  })

  it('takes the id from toolUseResult too, the newer recipient and content fields, and a name without its [ref]', () => {
    const lines = sendMessageLines('t1', { recipient: 'review-1 [3fa9c1]', content: 'Ready' }, { msgId: MSG, mirror: true })
    expect(parse(lines)).toEqual([{ kind: 'sent', id: MSG, peer: 'review-1', text: 'Ready', at: Date.parse(AT) }])
  })

  it('a send that failed, or one with no message id (a subagent of the session resumed), is no message', () => {
    expect(parse(sendMessageLines('t1', { to: 'a1', message: 'and the tests' }))).toEqual([])
    expect(parse(sendMessageLines('t2', { to: 'Review agent', message: 'x' }, { msgId: MSG, isError: true }))).toEqual([])
    // a result that is not the call's, and a call that is not SendMessage
    expect(parse([toolResultLine('t9')])).toEqual([])
    expect(parse([toolUseLine('t3', 'Bash', { command: 'ls' }), JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: JSON.stringify({ msg_id: MSG }) }] } })])).toEqual([])
  })

  it('a message from another session is a message received, as a prompt or as a queued command', () => {
    const want = { kind: 'received', id: MSG, peer: 'Build session', text: 'The build is green', at: Date.parse(AT) }
    expect(parse([peerMessageLine(peer())])).toEqual([want])
    expect(parse([peerMessageLine(peer(), { queued: true })])).toEqual([want])
  })

  it('without a body in its origin, the text is the envelope\'s', () => {
    expect(parse([peerMessageLine(peer({ body: undefined }))])).toEqual([])
    const line = JSON.stringify({ type: 'user', timestamp: AT, origin: peer({ body: undefined }), message: { role: 'user', content: 'Another session says:\n<cross-session-message from="uds:x" name="Build session">\nAll green\n</cross-session-message>' } })
    expect(parse([line])).toEqual([{ kind: 'received', id: MSG, peer: 'Build session', text: 'All green', at: Date.parse(AT) }])
  })

  it("a subagent's handback, a person's prompt, a sidechain entry, an id that is no uuid and broken JSON are no message", () => {
    expect(parse([
      peerMessageLine({ ...HANDBACK_ORIGIN, msg_id: MSG, body: 'done' }),
      promptLine('hello'),
      peerMessageLine(peer(), { isSidechain: true }),
      peerMessageLine(peer({ msg_id: 'msg-7' })),
      peerMessageLine(peer({ name: '' })),
      '{"type":"user","origin":{"kind":"peer"'
    ])).toEqual([])
  })

  it('a line without a time has none', () => {
    const line = JSON.stringify({ type: 'user', origin: peer(), message: { role: 'user', content: 'x' } })
    expect(parse([line])).toEqual([{ kind: 'received', id: MSG, peer: 'Build session', text: 'The build is green', at: null }])
  })
})
