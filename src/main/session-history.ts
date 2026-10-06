import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
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

/** The text the user typed: a string or text blocks; tool results and <command…>/caveat wrappers are not. */
function typedText(content: unknown): string | null {
  let text: string | null = null
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    const parts = content.filter((b): b is Obj => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string)
    if (parts.length > 0) text = parts.join(' ')
  }
  if (text === null || text.trimStart().startsWith('<')) return null
  return oneLine(text)
}

export interface SessionHead {
  cwd: string
  firstPrompt: string | null
  /** a user entry of the main conversation is in the window */
  hasUser: boolean
}

/**
 * The start of a transcript. `whole` tells whether the window holds the entire file (otherwise its last line
 * may be cut). Null when the file is not a session for the list: no folder, a sidechain, a `claude -p` run.
 */
export function parseSessionHead(text: string, whole: boolean): SessionHead | null {
  const list = entries(text, false, !whole)
  // user, attachment and system entries carry the folder; the first user entry can be far in
  const first = list.find((e) => typeof e.cwd === 'string' && e.cwd.length > 0)
  if (!first || first.isSidechain === true) return null
  if (first.entrypoint !== undefined && first.entrypoint !== 'cli') return null
  let hasUser = false
  let firstPrompt: string | null = null
  for (const e of list) {
    if (e.type !== 'user' || e.isSidechain === true) continue
    hasUser = true
    if (firstPrompt === null && e.isMeta !== true) firstPrompt = typedText(isObj(e.message) ? e.message.content : undefined)
  }
  return { cwd: first.cwd as string, firstPrompt, hasUser }
}

export interface SessionTail {
  customTitle: string | null
  aiTitle: string | null
  lastPrompt: string | null
}

/**
 * The end of a transcript. Claude Code appends its title and the last prompt again as the conversation goes
 * on, so the last occurrence is the current one. `fromStart` tells whether the window starts at the file's start.
 */
export function parseSessionTail(text: string, fromStart: boolean): SessionTail {
  const t: SessionTail = { customTitle: null, aiTitle: null, lastPrompt: null }
  for (const e of entries(text, !fromStart, false)) {
    if (e.type === 'custom-title') t.customTitle = oneLine(e.customTitle) ?? t.customTitle
    else if (e.type === 'ai-title') t.aiTitle = oneLine(e.aiTitle) ?? t.aiTitle
    else if (e.type === 'last-prompt') t.lastPrompt = oneLine(e.lastPrompt) ?? t.lastPrompt
  }
  return t
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

  async list(limit: number): Promise<SessionSummary[]> {
    const files = await this.transcripts()
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const out: SessionSummary[] = []
    for (const f of files) {
      if (out.length >= limit) break
      const s = await this.summary(f)
      if (s) out.push(s)
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
    return { id: f.id, cwd: head.cwd, title: tail.customTitle ?? tail.aiTitle, firstPrompt: head.firstPrompt, lastPrompt: tail.lastPrompt, modifiedAt: f.mtimeMs }
  }

  private async tail(f: TranscriptFile, bytes: number): Promise<SessionTail> {
    const start = Math.max(0, f.size - bytes)
    return parseSessionTail(await this.fs.read(f.path, start, f.size - start), start === 0)
  }
}
