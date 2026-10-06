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

/** a tool_result with text only, e.g. a finished Bash command */
export function toolTextResultLine(toolUseId: string, timestamp = '2026-10-05T10:00:01.000Z', text = 'done'): string {
  return JSON.stringify({ type: 'user', timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text }] }] } })
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
