import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { access, open, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { assistantInfo, type AgentModelInfo } from './transcript-agent-info'
import { extForMediaType, TranscriptParser, type ExtractedImage, type ExtractedKind } from './transcript-images'

const CHUNK_BYTES = 4 * 1024 * 1024

export class LineTailer {
  private offset = 0
  private rest = ''
  private decoder = new StringDecoder('utf8')

  constructor(
    readonly file: string,
    private readonly chunkBytes = CHUNK_BYTES
  ) {}

  /** New complete lines since the previous call; null when the file cannot be opened. */
  async readNew(): Promise<string[] | null> {
    let fh
    try {
      fh = await open(this.file, 'r')
    } catch {
      return null
    }
    try {
      const { size } = await fh.stat()
      if (size < this.offset) {
        this.offset = 0
        this.rest = ''
        this.decoder = new StringDecoder('utf8')
      }
      const lines: string[] = []
      try {
        while (this.offset < size) {
          const buf = Buffer.alloc(Math.min(this.chunkBytes, size - this.offset))
          const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset)
          if (bytesRead === 0) break
          this.offset += bytesRead
          const parts = (this.rest + this.decoder.write(buf.subarray(0, bytesRead))).split('\n')
          this.rest = parts.pop() ?? ''
          for (const l of parts) {
            const t = l.replace(/\r$/, '')
            if (t.trim().length > 0) lines.push(t)
          }
        }
      } catch (e) {
        // Keep what was consumed so far (offset already advanced); report on the next call otherwise.
        if (lines.length === 0) throw e
      }
      return lines
    } finally {
      await fh.close()
    }
  }
}

/** Claude Code's projects folder holding the reported transcript (<projects>/<project>/<session>.jsonl), or null */
function projectsDirOf(reportedPath: string): string | null {
  const dir = dirname(dirname(reportedPath))
  return basename(dir) === 'projects' ? dir : null
}

/**
 * Where a session's transcript is now: Claude Code reports it at startup under the project of the folder the
 * session started in, but files it under the project of a folder the session moved to. Null before the first message.
 */
export function locateTranscript(reportedPath: string, sessionId: string): string | null {
  if (existsSync(reportedPath)) return reportedPath
  const projects = projectsDirOf(reportedPath)
  if (!projects) return null
  let dirs: Dirent[]
  try {
    dirs = readdirSync(projects, { withFileTypes: true })
  } catch {
    return null
  }
  for (const d of dirs) {
    const p = join(projects, d.name, `${sessionId}.jsonl`)
    if (d.isDirectory() && existsSync(p)) return p
  }
  return null
}

/** locateTranscript without blocking: for looking again and again while a transcript is missing */
export async function findTranscript(reportedPath: string, sessionId: string): Promise<string | null> {
  const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false)
  if (await exists(reportedPath)) return reportedPath
  const projects = projectsDirOf(reportedPath)
  if (!projects) return null
  let dirs: Dirent[]
  try {
    dirs = await readdir(projects, { withFileTypes: true })
  } catch {
    return null
  }
  for (const d of dirs) {
    const p = join(projects, d.name, `${sessionId}.jsonl`)
    if (d.isDirectory() && (await exists(p))) return p
  }
  return null
}

export interface FeedImage {
  path: string
  source: ExtractedKind
  caption: string | null
  at: number | null
}

export interface TranscriptFeedOptions {
  transcriptPath: string
  sessionId: string
  cacheRoot: string
  fileExists(path: string): boolean
  onImage(img: FeedImage): void
  onError?(message: string): void
  /** model·effort of a subagent (from subagents/agent-<agentId>.jsonl), reported when it changes */
  onSubagentInfo?(agentId: string, info: AgentModelInfo): void
  /** where the transcript is now, when it cannot be opened where it was (the session moved to another folder) */
  locate?(): Promise<string | null>
  /** how often locate() may run while the transcript cannot be opened */
  locateMs?: number
  pollMs?: number
  subagentScanMs?: number
}

interface Source {
  tailer: LineTailer
  parser: TranscriptParser
  /** null for the main transcript */
  agentId: string | null
  lastInfo: string | null
}

export class TranscriptFeed {
  private readonly main: Source
  private readonly subagents = new Map<string, Source>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private scanTimer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private stopped = false
  private missingReported = false
  private lastLocate = -Infinity

  constructor(private readonly o: TranscriptFeedOptions) {
    this.main = { tailer: new LineTailer(o.transcriptPath), parser: new TranscriptParser({ subagent: false }), agentId: null, lastInfo: null }
  }

  get subagentDir(): string {
    return join(dirname(this.main.tailer.file), this.o.sessionId, 'subagents')
  }

  start(): void {
    this.scanSubagents()
    this.poll().catch((e) => this.report(e))
    this.pollTimer = setInterval(() => this.poll().catch((e) => this.report(e)), this.o.pollMs ?? 500)
    this.scanTimer = setInterval(() => this.scanSubagents(), this.o.subagentScanMs ?? 2000)
  }

  stop(): void {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.scanTimer) clearInterval(this.scanTimer)
  }

  scanSubagents(): void {
    let names: string[]
    try {
      names = readdirSync(this.subagentDir)
    } catch {
      return
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl') || this.subagents.has(n)) continue
      const agentId = n.startsWith('agent-') ? n.slice('agent-'.length, -'.jsonl'.length) : n.slice(0, -'.jsonl'.length)
      this.subagents.set(n, { tailer: new LineTailer(join(this.subagentDir, n)), parser: new TranscriptParser({ subagent: true }), agentId, lastInfo: null })
    }
  }

  async poll(): Promise<void> {
    if (this.busy || this.stopped) return
    this.busy = true
    try {
      try {
        let lines = await this.main.tailer.readNew()
        if (lines === null && (await this.relocate())) lines = await this.main.tailer.readNew()
        if (lines === null) {
          if (!this.missingReported) {
            this.missingReported = true
            this.o.onError?.(`transcript not readable yet: ${this.o.transcriptPath}`)
          }
        } else {
          this.consume(this.main, lines)
        }
      } catch (e) {
        this.report(e)
      }
      for (const s of this.subagents.values()) {
        try {
          const subLines = await s.tailer.readNew()
          if (subLines) this.consume(s, subLines)
        } catch (e) {
          this.report(e)
        }
      }
    } finally {
      this.busy = false
    }
  }

  /** Switches to where the transcript is now; true when it was found somewhere else */
  private async relocate(): Promise<boolean> {
    if (!this.o.locate) return false
    const now = Date.now()
    if (now - this.lastLocate < (this.o.locateMs ?? 5000)) return false
    this.lastLocate = now
    const p = await this.o.locate()
    if (p === null || p === this.main.tailer.file || this.stopped) return false
    this.main.tailer = new LineTailer(p)
    return true
  }

  private report(e: unknown): void {
    try {
      this.o.onError?.(`transcript feed error: ${e instanceof Error ? e.message : String(e)}`)
    } catch {
      // ignore
    }
  }

  private consume(src: Source, lines: string[]): void {
    for (const line of lines) {
      if (this.stopped) return
      this.reportInfo(src, line)
      try {
        for (const img of src.parser.parseLine(line)) {
          if (this.stopped) return
          const out = this.materialize(img)
          if (out) this.o.onImage(out)
        }
      } catch (e) {
        this.report(e)
      }
    }
  }

  private reportInfo(src: Source, line: string): void {
    if (src.agentId === null || !this.o.onSubagentInfo) return
    const info = assistantInfo(line)
    if (!info) return
    const key = `${info.model}|${info.effort ?? ''}`
    if (key === src.lastInfo) return
    src.lastInfo = key
    try {
      this.o.onSubagentInfo(src.agentId, info)
    } catch (e) {
      this.report(e)
    }
  }

  private materialize(img: ExtractedImage): FeedImage | null {
    if (img.kind === 'read' && img.filePath && this.o.fileExists(img.filePath)) {
      return { path: img.filePath, source: 'read', caption: img.caption, at: img.timestamp }
    }
    const ext = extForMediaType(img.mediaType)
    if (!ext) return null
    const dir = join(this.o.cacheRoot, this.o.sessionId)
    const file = join(dir, `${createHash('sha1').update(img.data).digest('hex').slice(0, 16)}.${ext}`)
    try {
      if (!existsSync(file)) {
        mkdirSync(dir, { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        writeFileSync(tmp, Buffer.from(img.data, 'base64'))
        try {
          renameSync(tmp, file)
        } catch (e) {
          rmSync(tmp, { force: true })
          if (!existsSync(file)) throw e
        }
      }
    } catch (e) {
      this.o.onError?.(`cannot cache image: ${(e as Error).message}`)
      return null
    }
    return { path: file, source: img.kind, caption: img.caption, at: img.timestamp }
  }
}

export function cleanupImageCache(cacheRoot: string, maxAgeMs: number, now = Date.now()): void {
  let entries: string[]
  try {
    entries = readdirSync(cacheRoot)
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(cacheRoot, e)
    try {
      if (now - statSync(p).mtimeMs > maxAgeMs) rmSync(p, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}
