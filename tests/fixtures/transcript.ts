export const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const image = (mediaType = 'image/png', data = PNG_B64): object => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })

export function toolUseLine(id: string, name: string, input: Record<string, unknown>, timestamp = '2026-10-05T10:00:00.000Z'): string {
  return JSON.stringify({ type: 'assistant', timestamp, isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
}

export function toolResultLine(toolUseId: string, opts: { mediaType?: string; data?: string; withText?: boolean; mirror?: boolean; timestamp?: string } = {}): string {
  const content = [...(opts.withText ? [{ type: 'text', text: 'done' }] : []), image(opts.mediaType, opts.data)]
  return JSON.stringify({
    type: 'user',
    timestamp: opts.timestamp ?? '2026-10-05T10:00:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
    ...(opts.mirror ? { toolUseResult: content } : {})
  })
}

export function pastedLine(data = PNG_B64): string {
  return JSON.stringify({ type: 'user', timestamp: '2026-10-05T10:00:02.000Z', imagePasteIds: [1], message: { role: 'user', content: [{ type: 'text', text: 'look at this' }, image('image/png', data)] } })
}

export const textLine = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })

export function assistantLine(model: string, effort?: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-05T10:00:03.000Z',
    ...(effort ? { effort, perTurnEffort: effort } : { perTurnEffort: null }),
    message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] }
  })
}

/** A user prompt as Claude Code writes it to the main transcript. */
export function promptLine(text: string, o: { timestamp?: string; uuid?: string; isMeta?: boolean; isSidechain?: boolean } = {}): string {
  return JSON.stringify({
    type: 'user',
    uuid: o.uuid ?? `u-${text.length}-${o.timestamp ?? ''}`,
    timestamp: o.timestamp ?? '2026-10-08T10:00:00.000Z',
    isSidechain: o.isSidechain ?? false,
    ...(o.isMeta ? { isMeta: true } : {}),
    message: { role: 'user', content: text }
  })
}

/** what Claude Code records as the origin of a message another root session sent */
export const PEER_ORIGIN = { kind: 'peer', from: 'uds:build-session', msg_id: 'msg-7', name: 'Build session', fromMode: 'prompting' }
/** the origin of a subagent's report to its parent: a peer entry, but not a message from another session */
export const HANDBACK_ORIGIN = { kind: 'peer', from: 'uds:agent-3', msg_id: 'msg-8', name: 'Review agent', fromMode: 'prompting', handback: true }

/**
 * A prompt Claude Code writes with its turn position (turnPosition, turnOrigin, origin); `origin` is what started the turn
 * (a human prompt when omitted, null or any other value as given).
 */
export function turnPromptLine(text: string, o: { turnIndex?: unknown; origin?: unknown; uuid?: string } = {}): string {
  const origin = o.origin === undefined ? { kind: 'human' } : o.origin
  const peer = typeof origin === 'object' && origin !== null && (origin as { kind?: unknown }).kind === 'peer'
  return JSON.stringify({
    type: 'user',
    uuid: o.uuid ?? `t-${text.length}-${String(o.turnIndex)}`,
    timestamp: '2026-10-08T10:00:00.000Z',
    isSidechain: false,
    turnPosition: { promptIndex: 0, turnIndex: o.turnIndex === undefined ? 0 : o.turnIndex },
    turnOrigin: peer ? 'peer' : 'human',
    origin,
    message: { role: 'user', content: text }
  })
}

/** The result of an Edit or Write, with Claude Code's toolUseResult. */
export function editResultLine(o: {
  toolUseId: string
  filePath: string
  patch?: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[]
  originalFile?: string | null
  created?: boolean
  timestamp?: string
}): string {
  return JSON.stringify({
    type: 'user',
    timestamp: o.timestamp ?? '2026-10-08T10:00:05.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: o.toolUseId, content: 'ok' }] },
    toolUseResult: {
      ...(o.created !== undefined ? { type: o.created ? 'create' : 'update' } : {}),
      filePath: o.filePath,
      structuredPatch: o.patch ?? [],
      originalFile: o.originalFile ?? null,
      userModified: false
    }
  })
}

/** The entry Claude Code writes when the user interrupts a turn: Esc, or a denied permission prompt (`forToolUse`). */
export function interruptLine(o: { forToolUse?: boolean; timestamp?: string } = {}): string {
  return JSON.stringify({
    type: 'user',
    timestamp: o.timestamp ?? '2026-10-08T10:00:07.000Z',
    message: { role: 'user', content: [{ type: 'text', text: o.forToolUse ? '[Request interrupted by user for tool use]' : '[Request interrupted by user]' }] }
  })
}

/** what Claude Code stores for the result of a Bash call */
export function bashResultLine(toolUseId: string, stdout: string, timestamp = '2026-10-05T10:00:01.000Z'): string {
  return JSON.stringify({
    type: 'user',
    timestamp,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: stdout, is_error: false }] },
    toolUseResult: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }
  })
}

/**
 * A SendMessage call to another session and its result, as Claude Code writes them: the result's text is a JSON object with
 * the message's id, which Claude Code also keeps in toolUseResult (`mirror`). No msgId: a result without one, as a resumed
 * subagent's.
 */
export function sendMessageLines(toolUseId: string, input: Record<string, unknown>, o: { msgId?: string; timestamp?: string; mirror?: boolean; isError?: boolean } = {}): string[] {
  const timestamp = o.timestamp ?? '2026-10-08T10:00:00.000Z'
  const result = { success: o.isError !== true, message: 'sent', ...(o.msgId === undefined ? {} : { msg_id: o.msgId }) }
  return [
    toolUseLine(toolUseId, 'SendMessage', input, timestamp),
    JSON.stringify({
      type: 'user',
      timestamp,
      isSidechain: false,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: JSON.stringify(result), is_error: o.isError === true }] },
      ...(o.mirror ? { toolUseResult: { ...result, display: 'sent' } } : {})
    })
  ]
}

/**
 * A message another session sent, as the receiving session's transcript holds it: a user prompt with its origin when it
 * starts a turn, or a queued_command attachment when the session was busy (`queued`).
 */
export function peerMessageLine(origin: Record<string, unknown>, o: { timestamp?: string; queued?: boolean; isSidechain?: boolean } = {}): string {
  const timestamp = o.timestamp ?? '2026-10-08T10:00:00.000Z'
  const text = `<cross-session-message from="${String(origin.from)}" name="${String(origin.name)}">\n${String(origin.body ?? '')}\n</cross-session-message>`
  if (o.queued) {
    return JSON.stringify({ type: 'attachment', timestamp, isSidechain: o.isSidechain ?? false, attachment: { type: 'queued_command', prompt: text, origin, timestamp, isMeta: false } })
  }
  return JSON.stringify({ type: 'user', timestamp, isSidechain: o.isSidechain ?? false, origin, message: { role: 'user', content: text } })
}
