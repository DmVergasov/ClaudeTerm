type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// the whole line is the path, spaces included (C:\Users\Jane Doe\…), optionally after `WS=` and in quotes, with a trailing slash
const WHOLE = /^(?:[A-Za-z_]\w*=)?["']?((?:[A-Za-z]:)?[\\/][^"']*[\\/]\.superpowers[\\/]sdd[\\/][^\\/"':]+)[\\/]?["']?$/
// otherwise the path ends the line after some other text: then it has no spaces
const WORKSPACE = /(?:^|[=\s"':])((?:[A-Za-z]:)?[\\/][^\s"']*[\\/]\.superpowers[\\/]sdd[\\/][^\\/\s"']+)[\\/]?["']?$/
// what task-brief and review-package print for the file they wrote: `wrote <file>: 42 lines`, `wrote <file>: 2 commit(s), 5120 bytes`
const WROTE = /^wrote (.+): \d+ (?:lines|commit\(s\), \d+ bytes)$/
// an absolute path of a file right in a workspace: <root>/.superpowers/sdd/<plan>/<name>
const IN_WORKSPACE = /^((?:[A-Za-z]:)?[\\/].*[\\/]\.superpowers[\\/]sdd[\\/][^\\/]+)[\\/]([^\\/]+)$/
// the first line of a ledger: `# SDD ledger — plan: <plan file>`
const LEDGER_HEADING = /^#\s*SDD ledger\b/
// the skill's scripts that print the workspace (sdd-workspace) or a file they wrote in it (the other two run sdd-workspace)
const SCRIPTS = ['sdd-workspace', 'task-brief', 'review-package']
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

/** the workspace a line of script output names: the one sdd-workspace printed, or the one holding the file task-brief or review-package wrote */
function printedWorkspace(line: string): string | null {
  const m = WHOLE.exec(line) ?? WORKSPACE.exec(line)
  if (m) return m[1]
  const w = WROTE.exec(line)
  return w ? (IN_WORKSPACE.exec(w[1])?.[1] ?? null) : null
}

/** the workspace of a ledger a Write tool use creates or replaces: `progress.md` right in a workspace, starting with the ledger heading */
function ledgerWorkspace(input: Obj): string | null {
  if (typeof input.file_path !== 'string' || typeof input.content !== 'string') return null
  const m = IN_WORKSPACE.exec(input.file_path)
  return m && m[2] === 'progress.md' && LEDGER_HEADING.test(input.content.trimStart()) ? m[1] : null
}

/**
 * Spots the workspace of the superpowers plan a session carries out, from a tool use and the result of that call:
 * a Bash run of `sdd-workspace` (it prints the workspace), of `task-brief` or `review-package` (they print the file
 * they wrote in it), or a Write of the plan's ledger (`<workspace>/progress.md` with its `# SDD ledger` heading).
 * Feed it the lines of one transcript, in order. The path comes back as the transcript spells it (an MSYS path on
 * Windows when a script printed it).
 */
export class PlanWorkspaceFinder {
  /** tool use id → the workspace a ledger write names, or null for a script run whose output names it */
  private readonly pending = new Map<string, string | null>()

  /** the workspace a tool call named, exactly as the transcript spells it, with the time of the result (0 when it has none), or null */
  parseLine(line: string): { printed: string; at: number } | null {
    if (!SCRIPTS.some((s) => line.includes(s)) && !line.includes('progress.md') && !(this.pending.size > 0 && line.includes('"tool_use_id"'))) return null
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
        if (typeof b.id !== 'string' || !isObj(b.input)) continue
        const command = b.name === 'Bash' ? b.input.command : null
        const ledger = b.name === 'Write' ? ledgerWorkspace(b.input) : null
        if ((typeof command === 'string' && SCRIPTS.some((s) => command.includes(s))) || ledger !== null) {
          if (this.pending.size >= MAX_PENDING) this.pending.clear()
          this.pending.set(b.id, ledger)
        }
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string' && this.pending.has(b.tool_use_id)) {
        const ledger = this.pending.get(b.tool_use_id)
        this.pending.delete(b.tool_use_id)
        let printed: string | null = null
        if (ledger) {
          if (b.is_error !== true) printed = ledger
        } else {
          for (const l of resultText(b, o).split(/\r?\n/)) {
            printed = printedWorkspace(l.trim())
            if (printed !== null) break
          }
        }
        if (printed !== null) {
          const at = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
          return { printed, at: Number.isNaN(at) ? 0 : at }
        }
      }
    }
    return null
  }
}
