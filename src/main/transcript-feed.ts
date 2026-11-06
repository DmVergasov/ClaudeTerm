import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { access, open, readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { assistantInfo, type AgentModelInfo } from './transcript-agent-info'
import { assistantTime, interruptTime, parseEditEvents, turnReport, type TranscriptEditEvent } from './transcript-edits'
import { PlanWorkspaceFinder } from './transcript-plan'
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
  /** turn starts (main transcript) and file edits (all transcripts), for the Changes panel */
  onEditEvent?(ev: TranscriptEditEvent): void
  /** an assistant entry: null for the main conversation, else the subagent's id; `at` is its transcript timestamp (0 when it has none) */
  onAssistant?(agentId: string | null, at: number): void
  /** the user interrupted that agent's turn (Esc, a denied permission prompt); `agentId` and `at` as for onAssistant */
  onInterrupt?(agentId: string | null, at: number): void
  /** a prompt of the main transcript: its turn's index, and whether a message from another session started the turn (see turnReport) */
  onTurn?(turnIndex: number, peer: boolean): void
  /** a tool call in any of the session's transcripts named this plan workspace (see PlanWorkspaceFinder); `at` is the time of its result (0 when it has none) */
  onPlanWorkspace?(printed: string, at: number): void
  /** where the transcript is now, when it cannot be opened where it was (the session moved to another folder) */
  locate?(): Promise<string | null>
  /** how often locate() may run while the transcript cannot be opened */
  locateMs?: number
  /** the timer's tick: a transcript that grows is read on every tick, one that brought nothing waits twice as long each time */
  pollMs?: number
  /** the longest wait between reads of the main transcript */
  pollMaxMs?: number
  /** the longest wait between reads of a subagent's transcript */
  subagentPollMaxMs?: number
  /** wake() reads again the subagents' transcripts that brought lines within this time; older ones keep their wait */
  subagentRecentMs?: number
  /** how often the subagents folder is listed while the session moves; its wait doubles the same way while nothing does */
  subagentScanMs?: number
  /** the longest wait between listings of the subagents folder */
  subagentScanMaxMs?: number
}

/** When something is looked at next, in ticks: after the base wait while it changes, then after waits that double up to a cap */
class Backoff {
  private wait: number
  private next = 0
  private changedAt = -Infinity

  constructor(private readonly base: number, private readonly max: number) {
    this.wait = base
  }

  due(tick: number): boolean {
    return tick >= this.next
  }

  /** whether a look found something new within the last `ticks` ticks before `tick` */
  changedWithin(tick: number, ticks: number): boolean {
    return tick - this.changedAt <= ticks
  }

  /** a look on that tick found something new (back to the base wait) or nothing (the wait doubles) */
  looked(tick: number, changed: boolean): void {
    if (changed) this.changedAt = tick
    this.wait = changed ? this.base : Math.max(this.base, Math.min(this.wait * 2, this.max))
    this.next = tick + this.wait
  }

  /** due on the next tick, then waiting the base again */
  reset(): void {
    this.wait = this.base
    this.next = 0
  }
}

interface Source {
  tailer: LineTailer
  parser: TranscriptParser
  /** null for the main transcript */
  agentId: string | null
  lastInfo: string | null
  plan: PlanWorkspaceFinder
  /** a transcript nothing is written to any more is read rarely: a session keeps every agent's transcript it ever ran */
  schedule: Backoff
}

export class TranscriptFeed {
  private readonly main: Source
  private readonly subagents = new Map<string, Source>()
  private readonly scan: Backoff
  private timer: ReturnType<typeof setInterval> | null = null
  private ticks = 0
  private woken = false
  private readonly wokenAgents = new Set<string>()
  /** a transcript brought new lines since the subagents folder was listed */
  private moved = false
  private busy = false
  /** the read in progress, if any */
  private running: Promise<void> | null = null
  private stopped = false
  private missingReported = false
  private lastLocate = -Infinity

  constructor(private readonly o: TranscriptFeedOptions) {
    this.main = this.source(o.transcriptPath, null)
    this.scan = new Backoff(this.inTicks(o.subagentScanMs ?? 2000), this.inTicks(o.subagentScanMaxMs ?? 30_000))
  }

  get subagentDir(): string {
    return join(dirname(this.main.tailer.file), this.o.sessionId, 'subagents')
  }

  start(): void {
    this.timer = setInterval(() => this.tick().catch((e) => this.report(e)), this.o.pollMs ?? 500)
    this.tick().catch((e) => this.report(e))
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
  }

  /**
   * Something happens in the tab: the next tick lists the subagents folder and reads the main transcript, the subagents'
   * transcripts that brought lines lately and the one of `agentId`, and each of them waits the base again. The
   * transcripts of agents long finished keep their wait
   */
  wake(agentId?: string): void {
    if (this.stopped) return
    this.woken = true
    if (agentId !== undefined) this.wokenAgents.add(agentId)
  }

  /** Adds the transcripts of agents new in the subagents folder; true when there were any */
  async scanSubagents(): Promise<boolean> {
    const dir = this.subagentDir
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return false
    }
    let found = false
    for (const n of names) {
      if (!n.endsWith('.jsonl') || this.subagents.has(n)) continue
      const agentId = n.startsWith('agent-') ? n.slice('agent-'.length, -'.jsonl'.length) : n.slice(0, -'.jsonl'.length)
      this.subagents.set(n, this.source(join(dir, n), agentId))
      found = true
    }
    return found
  }

  /** Reads every transcript now */
  poll(): Promise<void> {
    return this.readNow(() => true)
  }

  /**
   * Reads the main transcript now, for the end of a turn, whose origin is in the main transcript only: the subagents'
   * transcripts are not opened and keep the waits they have
   */
  pollMain(): Promise<void> {
    return this.readNow((s) => s === this.main)
  }

  /**
   * A read that starts after this call and has finished when the promise resolves. A read in progress may have looked at
   * a file before the lines asked for were written, so this waits for it; callers that waited together take turns, each
   * after the read before it (the check is made again after every wait).
   */
  private async readNow(due: (s: Source) => boolean): Promise<void> {
    while (this.running) await this.running.catch(() => undefined)
    return this.exclusive(() => this.read(due, this.ticks))
  }

  /** The timer: lists the subagents folder and reads the transcripts when it is their turn */
  private tick(): Promise<void> {
    const now = ++this.ticks
    return this.exclusive(async () => {
      if (this.woken) {
        this.woken = false
        this.scan.reset()
        this.main.schedule.reset()
        const recent = this.inTicks(this.o.subagentRecentMs ?? 60_000)
        // a named agent without a transcript yet is found by the listing
        for (const s of this.subagents.values()) {
          if (s.schedule.changedWithin(now, recent) || (s.agentId !== null && this.wokenAgents.has(s.agentId))) s.schedule.reset()
        }
        this.wokenAgents.clear()
      }
      const scanning = this.scan.due(now)
      const found = scanning && (await this.scanSubagents())
      await this.read((s) => s.schedule.due(now), now)
      if (!scanning) return
      // agents start while the session works: while nothing moves, the folder is listed more and more rarely, until wake()
      this.scan.looked(now, found || this.moved)
      this.moved = false
    })
  }

  /** one read at a time, none after stop() */
  private exclusive(work: () => Promise<void>): Promise<void> {
    if (this.busy || this.stopped) return Promise.resolve()
    this.busy = true
    const run = work().finally(() => {
      this.busy = false
      this.running = null
    })
    this.running = run
    return run
  }

  /** Reads the main transcript, then the subagents' ones, each that `due` picks */
  private async read(due: (s: Source) => boolean, now: number): Promise<void> {
    for (const s of [this.main, ...this.subagents.values()]) {
      if (this.stopped) return
      if (!due(s)) continue
      let got = false
      try {
        const lines = s === this.main ? await this.readMain() : await s.tailer.readNew()
        if (lines) {
          got = lines.length > 0
          this.consume(s, lines)
        }
      } catch (e) {
        this.report(e)
      }
      s.schedule.looked(now, got)
      if (got) this.moved = true
    }
  }

  /** New lines of the main transcript, wherever it is now; null while it cannot be opened */
  private async readMain(): Promise<string[] | null> {
    let lines = await this.main.tailer.readNew()
    if (lines === null && (await this.relocate())) lines = await this.main.tailer.readNew()
    if (lines === null && !this.missingReported) {
      this.missingReported = true
      this.o.onError?.(`transcript not readable yet: ${this.o.transcriptPath}`)
    }
    return lines
  }

  private source(file: string, agentId: string | null): Source {
    const maxMs = agentId === null ? (this.o.pollMaxMs ?? 5000) : (this.o.subagentPollMaxMs ?? 30_000)
    return {
      tailer: new LineTailer(file), parser: new TranscriptParser({ subagent: agentId !== null }), agentId, lastInfo: null,
      plan: new PlanWorkspaceFinder(), schedule: new Backoff(1, this.inTicks(maxMs))
    }
  }

  /** a time in ticks of the timer, at least one */
  private inTicks(ms: number): number {
    return Math.max(1, Math.round(ms / (this.o.pollMs ?? 500)))
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
      this.reportReview(src, line)
      this.reportPlan(src, line)
      this.reportTurn(src, line)
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

  private reportReview(src: Source, line: string): void {
    try {
      if (this.o.onEditEvent) for (const ev of parseEditEvents(line, { main: src.agentId === null })) this.o.onEditEvent(ev)
      const at = this.o.onAssistant ? assistantTime(line) : null
      if (at !== null) this.o.onAssistant?.(src.agentId, at)
      const stopped = this.o.onInterrupt ? interruptTime(line) : null
      if (stopped !== null) this.o.onInterrupt?.(src.agentId, stopped)
    } catch (e) {
      this.report(e)
    }
  }

  private reportPlan(src: Source, line: string): void {
    if (!this.o.onPlanWorkspace) return
    try {
      const found = src.plan.parseLine(line)
      if (found !== null) this.o.onPlanWorkspace(found.printed, found.at)
    } catch (e) {
      this.report(e)
    }
  }

  private reportTurn(src: Source, line: string): void {
    if (!this.o.onTurn) return
    try {
      const turn = turnReport(line, { main: src.agentId === null })
      if (turn !== null) this.o.onTurn(turn.turnIndex, turn.peer)
    } catch (e) {
      this.report(e)
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
