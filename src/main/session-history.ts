import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isUuid } from '../shared/protocol'
import type { SessionSummary } from '../shared/types'

export const HEAD_BYTES = 64 * 1024
export const TAIL_BYTES = 256 * 1024
export const WIDE_TAIL_BYTES = 2 * 1024 * 1024
const MAX_TEXT = 200

/** Claude Code keeps every conversation under <config>/projects; CLAUDE_CONFIG_DIR moves <config>. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects')
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Claude Code in a terminal, in VS Code, in the desktop app; `sdk-*` and `print` are scripted runs */
const INTERACTIVE = new Set(['cli', 'claude-vscode', 'claude-desktop'])
const isInteractive = (entrypoint: unknown): boolean => entrypoint === undefined || (typeof entrypoint === 'string' && INTERACTIVE.has(entrypoint))

/** One line, whitespace collapsed, at most 200 characters; null for nothing. */
export function oneLine(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, MAX_TEXT) : null
}

/** The JSON objects of a window of a transcript; a line cut by a window edge, or broken, is skipped. */
function entries(text: string, cutStart: boolean, cutEnd: boolean): Obj[] {
  const lines = text.split('\n')
  if (cutStart) lines.shift()
  if (cutEnd) lines.pop()
  const out: Obj[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const o: unknown = JSON.parse(line)
      if (isObj(o)) out.push(o)
    } catch {
      // a broken or half-written line
    }
  }
  return out
}

/** The text of a user entry: a string or text blocks; tool results have none. */
function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const parts = content.filter((b): b is Obj => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string)
  return parts.length > 0 ? parts.join(' ') : null
}

/** What the user typed; <command…> and caveat wrappers are not typing. */
function typedText(content: unknown): string | null {
  const text = contentText(content)
  return text === null || text.trimStart().startsWith('<') ? null : oneLine(text)
}

/** A slash command the user ran, as `/name args`. */
function commandText(content: unknown): string | null {
  const text = contentText(content)
  const name = text ? /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1] : undefined
  if (!text || !name) return null
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? ''
  return oneLine(`${name} ${args}`)
}

export interface SessionHead {
  /** null when no entry in the window carries one (a huge first message, e.g. a pasted screenshot) */
  cwd: string | null
  /** the first typed message, else the first slash command */
  firstPrompt: string | null
  /** a user entry of the main conversation is in the window */
  hasUser: boolean
}

/**
 * The start of a transcript. `whole` tells whether the window holds the entire file (otherwise its last line
 * may be cut). Null when the file is not a session for the list: a sidechain or a scripted (`claude -p`) run.
 */
export function parseSessionHead(text: string, whole: boolean): SessionHead | null {
  const list = entries(text, false, !whole)
  // user, attachment and system entries carry the folder; the first user entry can be far in
  const first = list.find((e) => typeof e.cwd === 'string' && e.cwd.length > 0)
  if (first && (first.isSidechain === true || !isInteractive(first.entrypoint))) return null
  let hasUser = false
  let typed: string | null = null
  let command: string | null = null
  for (const e of list) {
    if (e.type !== 'user' || e.isSidechain === true) continue
    hasUser = true
    if (e.isMeta === true) continue
    const content = isObj(e.message) ? e.message.content : undefined
    typed ??= typedText(content)
    command ??= commandText(content)
  }
  return { cwd: first ? (first.cwd as string) : null, firstPrompt: typed ?? command, hasUser }
}

export interface SessionTail {
  customTitle: string | null
  aiTitle: string | null
  lastPrompt: string | null
  /** the first main-conversation entry with a folder, for transcripts whose head has none */
  folder: { cwd: string; interactive: boolean } | null
}

/**
 * The end of a transcript. Claude Code appends its title and the last prompt again as the conversation goes
 * on, so the last occurrence is the current one. `fromStart` tells whether the window starts at the file's start.
 */
export function parseSessionTail(text: string, fromStart: boolean): SessionTail {
  const t: SessionTail = { customTitle: null, aiTitle: null, lastPrompt: null, folder: null }
  for (const e of entries(text, !fromStart, false)) {
    if (!t.folder && typeof e.cwd === 'string' && e.cwd.length > 0 && e.isSidechain !== true) t.folder = { cwd: e.cwd, interactive: isInteractive(e.entrypoint) }
    if (e.type === 'custom-title') t.customTitle = oneLine(e.customTitle) ?? t.customTitle
    else if (e.type === 'ai-title') t.aiTitle = oneLine(e.aiTitle) ?? t.aiTitle
    else if (e.type === 'last-prompt') t.lastPrompt = oneLine(e.lastPrompt) ?? t.lastPrompt
  }
  return t
}

/**
 * The folder a project's transcripts belong to: Claude Code names the project folder after it, with every
 * character other than a letter or digit turned into '-'. A later entry's cwd can be a subfolder the
 * conversation moved to, so walk up to the folder whose name matches; null when none does.
 */
export function projectFolder(cwd: string, projectName: string): string | null {
  for (let p = cwd; ; p = dirname(p)) {
    if (p.replace(/[^a-zA-Z0-9]/g, '-') === projectName) return p
    if (dirname(p) === p) return null
  }
}

export interface HistoryFs {
  readdir(dir: string): Promise<string[]>
  stat(path: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean }>
  /** `length` bytes from `start`, as UTF-8 (a character cut at an edge only spoils the line that gets dropped) */
  read(path: string, start: number, length: number): Promise<string>
}

export const nodeHistoryFs: HistoryFs = {
  readdir: (dir) => readdir(dir),
  stat: (path) => stat(path),
  read: async (path, start, length) => {
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await fh.read(buf, 0, length, start)
      return buf.toString('utf8', 0, bytesRead)
    } finally {
      await fh.close()
    }
  }
}

interface TranscriptFile {
  path: string
  id: string
  size: number
  mtimeMs: number
}

/** The most recently active Claude Code sessions, read from Claude Code's transcripts. */
export class SessionHistory {
  private readonly cache = new Map<string, { size: number; mtimeMs: number; summary: SessionSummary | null }>()

  constructor(private readonly projectsDir: string, private readonly fs: HistoryFs = nodeHistoryFs) {}

  /**
   * The latest `limit` sessions, newest first, plus every starred one however old. Starred sessions do not
   * count against the limit; the transcripts left out are not read.
   */
  async list(limit: number, starred: ReadonlySet<string> = new Set()): Promise<SessionSummary[]> {
    const files = await this.transcripts()
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const out: SessionSummary[] = []
    let others = 0
    for (const f of files) {
      const isStarred = starred.has(f.id)
      if (!isStarred && others >= limit) continue
      const s = await this.summary(f)
      if (!s) continue
      out.push(s)
      if (!isStarred) others++
    }
    return out
  }

  /** <uuid>.jsonl directly in each project folder; subagent transcripts live deeper */
  private async transcripts(): Promise<TranscriptFile[]> {
    let projects: string[]
    try {
      projects = await this.fs.readdir(this.projectsDir)
    } catch {
      return []
    }
    const files: TranscriptFile[] = []
    for (const project of projects) {
      let names: string[]
      try {
        names = await this.fs.readdir(join(this.projectsDir, project))
      } catch {
        continue // a file, or gone meanwhile
      }
      for (const name of names) {
        const id = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : ''
        if (!isUuid(id)) continue
        const path = join(this.projectsDir, project, name)
        try {
          const s = await this.fs.stat(path)
          if (s.isFile()) files.push({ path, id, size: s.size, mtimeMs: s.mtimeMs })
        } catch {
          // gone meanwhile
        }
      }
    }
    return files
  }

  private async summary(f: TranscriptFile): Promise<SessionSummary | null> {
    const cached = this.cache.get(f.path)
    if (cached && cached.size === f.size && cached.mtimeMs === f.mtimeMs) return cached.summary
    let summary: SessionSummary | null
    try {
      summary = await this.read(f)
    } catch {
      return null // locked or gone: try again next time
    }
    this.cache.set(f.path, { size: f.size, mtimeMs: f.mtimeMs, summary })
    return summary
  }

  private async read(f: TranscriptFile): Promise<SessionSummary | null> {
    const head = parseSessionHead(await this.fs.read(f.path, 0, Math.min(f.size, HEAD_BYTES)), f.size <= HEAD_BYTES)
    if (!head) return null
    let tail = await this.tail(f, TAIL_BYTES)
    if (!tail.customTitle && !tail.aiTitle && !tail.lastPrompt && f.size > TAIL_BYTES) tail = await this.tail(f, WIDE_TAIL_BYTES)
    if (!head.hasUser && !tail.lastPrompt) return null
    let cwd = head.cwd
    if (cwd === null) {
      if (!tail.folder?.interactive) return null
      // claude --resume finds the conversation only from the project's own folder
      cwd = projectFolder(tail.folder.cwd, basename(dirname(f.path))) ?? tail.folder.cwd
    }
    return { id: f.id, cwd, title: tail.customTitle ?? tail.aiTitle, firstPrompt: head.firstPrompt, lastPrompt: tail.lastPrompt, modifiedAt: f.mtimeMs }
  }

  private async tail(f: TranscriptFile, bytes: number): Promise<SessionTail> {
    const start = Math.max(0, f.size - bytes)
    return parseSessionTail(await this.fs.read(f.path, start, f.size - start), start === 0)
  }
}
