import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
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
  pollMs?: number
  subagentScanMs?: number
}

interface Source {
  tailer: LineTailer
  parser: TranscriptParser
}

export class TranscriptFeed {
  private readonly main: Source
  private readonly subagents = new Map<string, Source>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private scanTimer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private stopped = false
  private missingReported = false

  constructor(private readonly o: TranscriptFeedOptions) {
    this.main = { tailer: new LineTailer(o.transcriptPath), parser: new TranscriptParser({ subagent: false }) }
  }

  get subagentDir(): string {
    return join(dirname(this.o.transcriptPath), this.o.sessionId, 'subagents')
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
      this.subagents.set(n, { tailer: new LineTailer(join(this.subagentDir, n)), parser: new TranscriptParser({ subagent: true }) })
    }
  }

  async poll(): Promise<void> {
    if (this.busy || this.stopped) return
    this.busy = true
    try {
      try {
        const lines = await this.main.tailer.readNew()
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
