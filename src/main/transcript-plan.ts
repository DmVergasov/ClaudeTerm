type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// the whole line is the path, spaces included (C:\Users\Jane Doe\…), optionally after `WS=` and in quotes, with a trailing slash
const WHOLE = /^(?:[A-Za-z_]\w*=)?["']?((?:[A-Za-z]:)?[\\/][^"']*[\\/]\.superpowers[\\/]sdd[\\/][^\\/"':]+)[\\/]?["']?$/
// otherwise the path ends the line after some other text: then it has no spaces
const WORKSPACE = /(?:^|[=\s"':])((?:[A-Za-z]:)?[\\/][^\s"']*[\\/]\.superpowers[\\/]sdd[\\/][^\\/\s"']+)[\\/]?["']?$/
const MAX_PENDING = 100

function resultText(block: Obj, line: Obj): string {
  const c = block.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.filter((b): b is Obj => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('\n')
  }
  const r = line.toolUseResult
  return isObj(r) && typeof r.stdout === 'string' ? r.stdout : ''
}

/**
 * Spots the workspace a superpowers `sdd-workspace` run printed: a Bash tool use whose command runs it, and the
 * result of that call. Feed it the lines of one transcript, in order. The path comes back as printed (an MSYS
 * path on Windows).
 */
export class PlanWorkspaceFinder {
  private readonly pending = new Set<string>()

  /** the workspace an sdd-workspace run printed, exactly as printed (an MSYS path on Windows), with the time of the result (0 when it has none), or null */
  parseLine(line: string): { printed: string; at: number } | null {
    if (!line.includes('sdd-workspace') && !(this.pending.size > 0 && line.includes('"tool_use_id"'))) return null
    let o: unknown
    try {
      o = JSON.parse(line)
    } catch {
      return null
    }
    if (!isObj(o) || !isObj(o.message) || !Array.isArray(o.message.content)) return null
    for (const b of o.message.content) {
      if (!isObj(b)) continue
      if (b.type === 'tool_use') {
        if (b.name !== 'Bash' || typeof b.id !== 'string' || !isObj(b.input)) continue
        if (typeof b.input.command === 'string' && b.input.command.includes('sdd-workspace')) {
          if (this.pending.size >= MAX_PENDING) this.pending.clear()
          this.pending.add(b.id)
        }
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string' && this.pending.delete(b.tool_use_id)) {
        for (const l of resultText(b, o).split(/\r?\n/)) {
          const t = l.trim()
          const m = WHOLE.exec(t) ?? WORKSPACE.exec(t)
          if (m) {
            const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
            return { printed: m[1], at: Number.isNaN(at) ? 0 : at }
          }
        }
      }
    }
    return null
  }
}
