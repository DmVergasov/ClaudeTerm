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
