/** One hunk of Claude Code's structuredPatch (jsdiff's format): lines start with ' ', '-', '+' or '\'. */
export interface PatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export type TranscriptEditEvent =
  | { kind: 'prompt'; at: number; id: string }
  | { kind: 'edit'; at: number; toolUseId: string; path: string; created: boolean; originalFile: string | null; patch: PatchHunk[] }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function isHunk(v: unknown): v is PatchHunk {
  return (
    isObj(v) && typeof v.oldStart === 'number' && typeof v.oldLines === 'number' && typeof v.newStart === 'number' &&
    typeof v.newLines === 'number' && Array.isArray(v.lines) && v.lines.every((l) => typeof l === 'string')
  )
}

/** typed text: a string, or text blocks without tool results */
function isTyped(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some((b) => isObj(b) && b.type === 'text') && !content.some((b) => isObj(b) && b.type === 'tool_result')
}

/**
 * Turn starts and file edits in one transcript line. A turn starts with a prompt in the main transcript;
 * an edit is the toolUseResult Claude Code stores with an Edit or Write result, in any transcript.
 */
export function parseEditEvents(line: string, opts: { main: boolean }): TranscriptEditEvent[] {
  // most lines are neither: skip the JSON parse for them (a prompt never holds an unescaped "tool_use_id")
  const maybeEdit = line.includes('"structuredPatch"')
  const maybePrompt = opts.main && line.includes('"type":"user"') && !line.includes('"tool_use_id"')
  if (!maybeEdit && !maybePrompt) return []
  let o: unknown
  try {
    o = JSON.parse(line)
  } catch {
    return []
  }
  if (!isObj(o) || o.type !== 'user') return []
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : Number.NaN
  const at = Number.isNaN(ts) ? 0 : ts
  const content = isObj(o.message) ? o.message.content : undefined
  const r = o.toolUseResult
  if (isObj(r) && typeof r.filePath === 'string' && Array.isArray(r.structuredPatch)) {
    const result = Array.isArray(content) ? content.find((b) => isObj(b) && b.type === 'tool_result') : undefined
    const toolUseId = isObj(result) && typeof result.tool_use_id === 'string' ? result.tool_use_id : null
    if (!toolUseId) return []
    return [{
      kind: 'edit',
      at,
      toolUseId,
      path: r.filePath,
      created: r.type === 'create',
      originalFile: typeof r.originalFile === 'string' ? r.originalFile : null,
      patch: r.structuredPatch.filter(isHunk)
    }]
  }
  if (!opts.main || o.isMeta === true || o.isCompactSummary === true || o.isSidechain === true || o.isVisibleInTranscriptOnly === true) return []
  if (!isTyped(content)) return []
  return [{ kind: 'prompt', at, id: typeof o.uuid === 'string' ? o.uuid : `${at}` }]
}

/** "[Request interrupted by user]", "[Request interrupted by user for tool use]": Claude Code's own pattern for them */
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]/

/**
 * When the user interrupted the turn, in ms (0 when the entry has no time): Claude Code writes a user entry with that
 * marker on Esc and on a denied permission prompt. Null for any other line, also one that only quotes the marker.
 */
export function interruptTime(line: string): number | null {
  if (!line.includes('[Request interrupted by user')) return null
  try {
    const o: unknown = JSON.parse(line)
    if (!isObj(o) || o.type !== 'user' || !isObj(o.message)) return null
    const c = o.message.content
    const marked = typeof c === 'string'
      ? INTERRUPTED.test(c)
      : Array.isArray(c) && c.some((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string' && INTERRUPTED.test(b.text))
    if (!marked) return null
    const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    return Number.isNaN(at) ? 0 : at
  } catch {
    return null
  }
}

/** an assistant entry's time in ms (0 when it has none), or null when the line is not an assistant entry */
export function assistantTime(line: string): number | null {
  if (!line.includes('"type":"assistant"')) return null
  try {
    const o: unknown = JSON.parse(line)
    if (!isObj(o) || o.type !== 'assistant') return null
    const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
    return Number.isNaN(at) ? 0 : at
  } catch {
    return null
  }
}
