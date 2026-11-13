import { isUuid } from '../shared/protocol'

/**
 * A message of Claude Code's own messaging between sessions (SendMessage) that a session's main transcript shows: one it
 * sent or one it received. `id` is Claude Code's id of the message, the same in the sender's transcript and the receiver's;
 * `peer` is the other session's name as Claude Code gives it; `at` is the entry's time, null when it has none.
 */
export interface PeerMail {
  kind: 'sent' | 'received'
  id: string
  peer: string
  text: string
  at: number | null
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

/** the SendMessage calls whose result has not come yet are kept up to this many, the oldest dropped first */
const PENDING_MAX = 64
/** a name given with its reference, as ListAgents prints it: `review-1 [3fa9c1]` */
const WITH_REF = /^(.*\S)\s+\[[0-9a-z]+\]$/i
/** the body of the envelope Claude Code wraps another session's message in */
const ENVELOPE = /<cross-session-message\b[^>]*>([\s\S]*?)<\/cross-session-message>/

function timeOf(o: Obj): number | null {
  const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
  return Number.isNaN(at) ? null : at
}

/** the other session's name without the reference ListAgents prints after it */
function peerName(to: string): string {
  const name = to.trim()
  return WITH_REF.exec(name)?.[1] ?? name
}

/** the message id a SendMessage result names, from toolUseResult or from the result's JSON text; null for a failed send */
function sentId(entry: Obj, block: Obj): string | null {
  if (block.is_error === true) return null
  const candidates: unknown[] = [entry.toolUseResult]
  const content = block.content
  const raw = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (isObj(b) && typeof b.text === 'string' ? b.text : '')).join('') : ''
  if (raw.trimStart().startsWith('{')) {
    try {
      candidates.push(JSON.parse(raw))
    } catch {
      // not the JSON a send answers with
    }
  }
  for (const c of candidates) {
    if (isObj(c) && c.success !== false && isUuid(c.msg_id)) return c.msg_id
  }
  return null
}

/** the text of a received message: its origin's body, else the body of the envelope in the entry's text */
function receivedText(origin: Obj, prompt: unknown): string | null {
  const body = text(origin.body)
  if (body !== null) return body.trim()
  const raw = typeof prompt === 'string' ? prompt : Array.isArray(prompt) ? prompt.map((b) => (isObj(b) && typeof b.text === 'string' ? b.text : '')).join('\n') : ''
  return text(ENVELOPE.exec(raw)?.[1])?.trim() ?? null
}

/**
 * Reads the messages a session sent and received with SendMessage from the lines of its main transcript, in order. A sent
 * message is a SendMessage call whose result names the message's id (a call that resumes the session's own subagent names
 * none); a received one is an entry whose origin is another root session's (a subagent's handback is not one), as a prompt,
 * or as a queued_command attachment when it came while the session was busy.
 */
export class PeerMailParser {
  /** SendMessage calls waiting for their result: the call's id, to whom and the text */
  private readonly pending = new Map<string, { peer: string; text: string }>()

  parseLine(line: string): PeerMail | null {
    if (!line.includes('SendMessage') && !line.includes('"peer"') && !(this.pending.size > 0 && line.includes('tool_result'))) return null
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      return null
    }
    if (!isObj(o) || o.isSidechain === true) return null
    if (o.type === 'assistant') {
      this.takeCalls(o)
      return null
    }
    if (o.type === 'attachment' && isObj(o.attachment) && o.attachment.type === 'queued_command') {
      return this.received(o.attachment.origin, o.attachment.prompt, timeOf(o))
    }
    if (o.type !== 'user') return null
    if (isObj(o.origin)) return this.received(o.origin, isObj(o.message) ? o.message.content : null, timeOf(o))
    return this.sent(o)
  }

  private takeCalls(o: Obj): void {
    const content = isObj(o.message) ? o.message.content : null
    if (!Array.isArray(content)) return
    for (const b of content) {
      if (!isObj(b) || b.type !== 'tool_use' || b.name !== 'SendMessage' || typeof b.id !== 'string' || !isObj(b.input)) continue
      const to = text(b.input.to) ?? text(b.input.recipient)
      const message = text(b.input.message) ?? text(b.input.content)
      if (to === null || message === null) continue
      this.pending.set(b.id, { peer: peerName(to), text: message })
      if (this.pending.size > PENDING_MAX) this.pending.delete(this.pending.keys().next().value!)
    }
  }

  private sent(o: Obj): PeerMail | null {
    const content = isObj(o.message) ? o.message.content : null
    if (!Array.isArray(content)) return null
    for (const b of content) {
      if (!isObj(b) || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
      const call = this.pending.get(b.tool_use_id)
      if (call === undefined) continue
      this.pending.delete(b.tool_use_id)
      const id = sentId(o, b)
      if (id !== null) return { kind: 'sent', id, peer: call.peer, text: call.text, at: timeOf(o) }
    }
    return null
  }

  private received(origin: unknown, prompt: unknown, at: number | null): PeerMail | null {
    if (!isObj(origin) || origin.kind !== 'peer' || origin.handback === true || !isUuid(origin.msg_id)) return null
    const name = text(origin.name)
    const body = receivedText(origin, prompt)
    if (name === null || body === null) return null
    return { kind: 'received', id: origin.msg_id, peer: name.trim(), text: body, at }
  }
}
