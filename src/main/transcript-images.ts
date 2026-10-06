import { ToolActivity } from './tool-activity'

export type ExtractedKind = 'read' | 'tool' | 'pasted'

export interface ExtractedImage {
  kind: ExtractedKind
  filePath: string | null
  data: string
  mediaType: string
  caption: string | null
  timestamp: number | null
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

export function extForMediaType(mediaType: string): string | null {
  return EXT[mediaType.toLowerCase()] ?? null
}

export function toolLabel(name: string, input: Obj): string {
  const base = name.startsWith('mcp__') ? name.slice(5).split('__').join(' · ') : name
  return typeof input.action === 'string' ? `${base} (${input.action})` : base
}

interface ToolUse {
  name: string
  input: Obj
}

export class TranscriptParser {
  private readonly tools = new Map<string, ToolUse>()
  /** when this transcript's tools ran */
  readonly activity = new ToolActivity()

  constructor(private readonly opts: { subagent: boolean }) {}

  parseLine(line: string): ExtractedImage[] {
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      return []
    }
    if (!isObj(obj)) return []
    // Search conversation content only: Claude Code mirrors tool output in `toolUseResult`, which would duplicate images.
    const root: unknown = isObj(obj.message) && 'content' in obj.message ? obj.message.content : obj
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : Number.NaN
    const timestamp = Number.isNaN(ts) ? null : ts
    this.collectToolUses(root, timestamp ?? Date.now())
    const out: ExtractedImage[] = []
    this.collectImages(root, null, timestamp, out)
    return out
  }

  private collectToolUses(node: unknown, at: number): void {
    if (Array.isArray(node)) {
      for (const n of node) this.collectToolUses(n, at)
      return
    }
    if (!isObj(node)) return
    if (node.type === 'tool_use' && typeof node.id === 'string' && typeof node.name === 'string') {
      this.tools.set(node.id, { name: node.name, input: isObj(node.input) ? node.input : {} })
      this.activity.start(node.id, at)
    }
    if (node.type === 'tool_result' && typeof node.tool_use_id === 'string') this.activity.end(node.tool_use_id, at)
    for (const v of Object.values(node)) if (typeof v === 'object' && v !== null) this.collectToolUses(v, at)
  }

  private collectImages(node: unknown, toolUseId: string | null, timestamp: number | null, out: ExtractedImage[]): void {
    if (Array.isArray(node)) {
      for (const n of node) this.collectImages(n, toolUseId, timestamp, out)
      return
    }
    if (!isObj(node)) return
    if (node.type === 'image' && isObj(node.source)) {
      const s = node.source
      if (s.type === 'base64' && typeof s.data === 'string' && s.data.length > 0 && typeof s.media_type === 'string') {
        out.push(this.describe(toolUseId, s.data, s.media_type, timestamp))
      }
      return
    }
    const ctx = node.type === 'tool_result' && typeof node.tool_use_id === 'string' ? node.tool_use_id : toolUseId
    for (const v of Object.values(node)) if (typeof v === 'object' && v !== null) this.collectImages(v, ctx, timestamp, out)
  }

  private describe(toolUseId: string | null, data: string, mediaType: string, timestamp: number | null): ExtractedImage {
    const sub = this.opts.subagent
    if (toolUseId === null) {
      return { kind: 'pasted', filePath: null, data, mediaType, caption: sub ? 'subagent · input image' : 'pasted by you', timestamp }
    }
    const tool = this.tools.get(toolUseId)
    if (tool?.name === 'Read' && typeof tool.input.file_path === 'string') {
      return { kind: 'read', filePath: tool.input.file_path, data, mediaType, caption: sub ? 'subagent · Read' : null, timestamp }
    }
    const label = tool ? toolLabel(tool.name, tool.input) : null
    const caption = label ? (sub ? `subagent · ${label}` : label) : sub ? 'subagent' : null
    return { kind: 'tool', filePath: null, data, mediaType, caption, timestamp }
  }
}
