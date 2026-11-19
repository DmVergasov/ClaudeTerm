import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { access, open, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { isAgentId } from '../shared/chat'
import { isRunId, RUN_LABEL_CAP, workflowTask } from '../shared/workflow'
import { isWithin } from './path-key'
import { readRunFile, type RunFile } from './workflow-files'
import { assistantInfo, type AgentModelInfo } from './transcript-agent-info'
import { assistantTime, interruptTime, parseEditEvents, turnReport, type TranscriptEditEvent } from './transcript-edits'
import { PeerMailParser, type PeerMail } from './transcript-mail'
import { PlanWorkspaceFinder } from './transcript-plan'
import { extForMediaType, TranscriptParser, type ExtractedImage, type ExtractedKind } from './transcript-images'
import { oneLine } from './session-history'
import { wordsLine, type WordsLine } from './coordinator/person-words'
import { EnterWorktreeWatch } from './worktree-hook'

const CHUNK_BYTES = 4 * 1024 * 1024

export class LineTailer {
  private offset: number
  private rest = ''
  private decoder = new StringDecoder('utf8')

  /** `offset`: the byte the first read starts from (0: the file's start) */
  constructor(
    readonly file: string,
    private readonly chunkBytes = CHUNK_BYTES,
    offset = 0
  ) {
    this.offset = offset
  }

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
  /** the conversation's title in the main transcript (the last custom title, else the last AI one), reported each time it changes */
  onTitle?(title: string): void
  /** a message the session sent or received with Claude Code's own messaging (SendMessage), from the main transcript, in order */
  onPeerMail?(mail: PeerMail): void
  /** a prompt or an answer of the main transcript, as the person's-words check reads it (person-words.ts), in order */
  onWords?(line: WordsLine): void
  /** an EnterWorktree call a WorktreeCreate hook broke, in any of the session's transcripts: the hook's error, and the time of the result (null when it has none) */
  onWorktreeHookFailure?(error: string, at: number | null): void
  /** a Workflow call's result in the main transcript: the run it launched, its name and its task id (once per run) */
  onWorkflowRun?(run: { runId: string; name: string; taskId: string }): void
  /** new lines of a run's journal, parsed, in order; a line that is not JSON is left out */
  onWorkflowJournal?(runId: string, lines: unknown[]): void
  /** a run agent's task: the text of its first prompt, once per agent */
  onWorkflowTask?(runId: string, agentId: string, task: string): void
  /** a run's run file, once, when the run has ended */
  onWorkflowEnd?(runId: string, file: RunFile): void
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
  /** content older than this (ms since epoch) is history: its Workflow runs are not reported; default: the time the feed was made */
  since?: number
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

/** what is read on a schedule of its own */
interface Scheduled {
  /** a transcript nothing is written to any more is read rarely: a session keeps every agent's transcript it ever ran */
  schedule: Backoff
}

interface Source extends Scheduled {
  tailer: LineTailer
  parser: TranscriptParser
  /** null for the main transcript */
  agentId: string | null
  /** the Workflow run whose folder holds the agent's transcript; null for the session's own agents */
  runId: string | null
  /** a run agent's task was reported (its first prompt) */
  tasked: boolean
  lastInfo: string | null
  plan: PlanWorkspaceFinder
  worktree: EnterWorktreeWatch
}

/**
 * a Workflow run's folder: its journal is read on a schedule of its own, and its run file once, when it is there. A history
 * run's folder was last written before the feed started: its journal, its run file and its agents' tasks are not reported
 */
interface RunWatch extends Scheduled {
  runId: string
  dir: string
  journal: LineTailer
  ended: boolean
  history: boolean
}

/** the newest run folders of the subagents' workflows folder that are read */
const MAX_RUN_FOLDERS = 8

/** the text blocks of a message's content, joined; null when there is none */
function textBlocks(content: unknown[]): string | null {
  const texts: string[] = []
  for (const b of content) {
    if (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
      texts.push((b as { text: string }).text)
    }
  }
  return texts.length > 0 ? texts.join('\n') : null
}

export class TranscriptFeed {
  private readonly main: Source
  /** keyed by the file's name for a session's own agents, by `workflows/<runId>/<file name>` for a run's */
  private readonly subagents = new Map<string, Source>()
  private readonly runs = new Map<string, RunWatch>()
  /** the runs whose Workflow result was reported */
  private readonly reportedRuns = new Set<string>()
  /** what was written before this time (ms since epoch) is history */
  private readonly since: number
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
  /** the main transcript's SendMessage traffic: its calls wait there for their results */
  private readonly peerMail = new PeerMailParser()
  private customTitle: string | null = null
  private aiTitle: string | null = null
  private reportedTitle: string | null = null

  constructor(private readonly o: TranscriptFeedOptions) {
    this.main = this.source(o.transcriptPath, null)
    this.scan = new Backoff(this.inTicks(o.subagentScanMs ?? 2000), this.inTicks(o.subagentScanMaxMs ?? 30_000))
    this.since = o.since ?? Date.now()
  }

  /** the session's folder, next to its transcript */
  private get sessionDir(): string {
    return join(dirname(this.main.tailer.file), this.o.sessionId)
  }

  get subagentDir(): string {
    return join(this.sessionDir, 'subagents')
  }

  get workflowsDir(): string {
    return join(this.subagentDir, 'workflows')
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
    if (names.includes('workflows') && (await this.scanRuns())) found = true
    return found
  }

  /**
   * Watches the newest run folders of the workflows folder (by modification time, MAX_RUN_FOLDERS of them) and the agents
   * in the folders watched; a folder whose name is not a run id, or that leads outside the subagents folder, is none. True when
   * there were new folders or agents
   */
  private async scanRuns(): Promise<boolean> {
    let names: string[]
    let realRoot: string
    try {
      names = await readdir(this.workflowsDir)
      realRoot = await realpath(this.subagentDir)
    } catch {
      return false
    }
    const folders: { runId: string; mtime: number }[] = []
    for (const name of names) {
      if (!isRunId(name)) continue
      try {
        const info = await stat(join(this.workflowsDir, name))
        if (info.isDirectory()) folders.push({ runId: name, mtime: info.mtimeMs })
      } catch {
        // a folder that cannot be read is none
      }
    }
    folders.sort((a, b) => b.mtime - a.mtime)
    // the newest real folders: the real places decide, so a folder that is a link out of the subagents folder is refused and the next one is taken
    const newest = new Map<string, number>()
    for (const f of folders) {
      if (newest.size >= MAX_RUN_FOLDERS) break
      try {
        if (isWithin(realRoot, await realpath(join(this.workflowsDir, f.runId)))) newest.set(f.runId, f.mtime)
      } catch {
        // a folder that cannot be resolved is none
      }
    }
    // a run that fell out of the newest folders is no longer read: its journal and its agents' transcripts go with it
    for (const runId of [...this.runs.keys()]) {
      if (!newest.has(runId)) this.dropRun(runId)
    }
    let found = false
    for (const [runId, mtime] of newest) {
      if (this.runs.has(runId)) continue
      const dir = join(this.workflowsDir, runId)
      this.runs.set(runId, {
        runId, dir, journal: new LineTailer(join(dir, 'journal.jsonl')), ended: false, history: mtime < this.since,
        schedule: new Backoff(1, this.inTicks(this.o.subagentPollMaxMs ?? 30_000))
      })
      found = true
    }
    for (const run of this.runs.values()) {
      if (await this.scanRunAgents(run, realRoot)) found = true
    }
    return found
  }

  /** Stops reading a run: its watch and the transcripts of its agents are removed */
  private dropRun(runId: string): void {
    this.runs.delete(runId)
    for (const key of [...this.subagents.keys()]) {
      if (key.startsWith(`workflows/${runId}/`)) this.subagents.delete(key)
    }
  }

  /** Adds the transcripts of the agents new in a run's folder; true when there were any. An agent file that is a link out of the subagents folder is none */
  private async scanRunAgents(run: RunWatch, realRoot: string): Promise<boolean> {
    let names: string[]
    try {
      names = await readdir(run.dir)
    } catch {
      return false
    }
    let found = false
    for (const n of names) {
      const agentId = /^agent-(.+)\.jsonl$/.exec(n)?.[1]
      if (agentId === undefined || !isAgentId(agentId)) continue
      const key = `workflows/${run.runId}/${n}`
      if (this.subagents.has(key)) continue
      const file = join(run.dir, n)
      const real = await realpath(file).then((p) => p, () => null)
      if (real === null || !isWithin(realRoot, real)) continue
      this.subagents.set(key, this.source(file, agentId, run.runId))
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
  private async readNow(due: (s: Scheduled) => boolean): Promise<void> {
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
        for (const r of this.runs.values()) {
          if (r.schedule.changedWithin(now, recent)) r.schedule.reset()
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

  /** Reads the main transcript, then the subagents' ones and the runs' journals, each that `due` picks */
  private async read(due: (s: Scheduled) => boolean, now: number): Promise<void> {
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
    for (const run of this.runs.values()) {
      if (this.stopped) return
      if (due(run)) await this.readRun(run, now)
    }
  }

  /** New lines of a run's journal, parsed, and its run file once it is there */
  private async readRun(run: RunWatch, now: number): Promise<void> {
    // a history run is none of the status bar's: its journal and its run file are not read
    if (run.history) {
      run.schedule.looked(now, false)
      return
    }
    let got = false
    try {
      const lines = await run.journal.readNew()
      if (lines) {
        const entries: unknown[] = []
        for (const l of lines) {
          try {
            entries.push(JSON.parse(l))
          } catch {
            // a line that is not JSON is none
          }
        }
        if (entries.length > 0) {
          got = true
          this.o.onWorkflowJournal?.(run.runId, entries)
        }
      }
    } catch (e) {
      this.report(e)
    }
    run.schedule.looked(now, got)
    if (run.ended) return
    try {
      const file = await readRunFile(this.sessionDir, run.runId)
      if (file === null) return
      run.ended = true
      this.o.onWorkflowEnd?.(run.runId, file)
    } catch (e) {
      this.report(e)
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

  private source(file: string, agentId: string | null, runId: string | null = null): Source {
    const maxMs = agentId === null ? (this.o.pollMaxMs ?? 5000) : (this.o.subagentPollMaxMs ?? 30_000)
    return {
      tailer: new LineTailer(file), parser: new TranscriptParser({ subagent: agentId !== null }), agentId, runId, tasked: false, lastInfo: null,
      plan: new PlanWorkspaceFinder(), worktree: new EnterWorktreeWatch(), schedule: new Backoff(1, this.inTicks(maxMs))
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
      this.reportTitle(src, line)
      this.reportMail(src, line)
      this.reportWords(src, line)
      this.reportWorktree(src, line)
      this.reportWorkflowRun(src, line)
      this.reportWorkflowTask(src, line)
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

  private reportMail(src: Source, line: string): void {
    if (!this.o.onPeerMail || src.agentId !== null) return
    try {
      const mail = this.peerMail.parseLine(line)
      if (mail !== null) this.o.onPeerMail(mail)
    } catch (e) {
      this.report(e)
    }
  }

  private reportWords(src: Source, line: string): void {
    if (!this.o.onWords || src.agentId !== null) return
    try {
      const words = wordsLine(line)
      if (words !== null) this.o.onWords(words)
    } catch (e) {
      this.report(e)
    }
  }

  /** an EnterWorktree call and its result: only a line that names the tool or the hook's error is parsed */
  private reportWorktree(src: Source, line: string): void {
    if (!this.o.onWorktreeHookFailure || (!line.includes('EnterWorktree') && !line.includes('WorktreeCreate hook'))) return
    try {
      const entry: unknown = JSON.parse(line)
      const error = src.worktree.entry(entry)
      if (error === null) return
      const at = Date.parse(String((entry as { timestamp?: unknown }).timestamp))
      this.o.onWorktreeHookFailure(error, Number.isFinite(at) ? at : null)
    } catch (e) {
      // a malformed line is none
      if (!(e instanceof SyntaxError)) this.report(e)
    }
  }

  /** the Workflow call's result in the main transcript: the run it launched, once per run id; a result with an invalid id is none */
  private reportWorkflowRun(src: Source, line: string): void {
    if (!this.o.onWorkflowRun || src.agentId !== null || !line.includes('"runId"')) return
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }
    try {
      const result = typeof entry === 'object' && entry !== null ? (entry as { toolUseResult?: unknown }).toolUseResult : undefined
      if (typeof result !== 'object' || result === null) return
      const { runId, taskId, workflowName } = result as { runId?: unknown; taskId?: unknown; workflowName?: unknown }
      if (!isRunId(runId) || !isAgentId(taskId) || this.reportedRuns.has(runId)) return
      this.reportedRuns.add(runId)
      // a launch written before the feed started, or a run whose folder is history, is history: no run there can still be live
      const at = Date.parse(String((entry as { timestamp?: unknown }).timestamp))
      if ((Number.isFinite(at) && at < this.since) || this.runs.get(runId)?.history) return
      this.o.onWorkflowRun({ runId, name: oneLine(workflowName)?.slice(0, RUN_LABEL_CAP) ?? 'workflow', taskId })
    } catch (e) {
      this.report(e)
    }
  }

  /** a run agent's task: the text of its first prompt, once per agent; a prompt without text is none */
  private reportWorkflowTask(src: Source, line: string): void {
    if (!this.o.onWorkflowTask || src.runId === null || src.agentId === null || src.tasked || !line.includes('"user"')) return
    // a history run's agents are not tasked: their transcripts are read for their edits and images only
    if (this.runs.get(src.runId)?.history) return
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }
    try {
      if (typeof entry !== 'object' || entry === null || (entry as { type?: unknown }).type !== 'user') return
      const content = (entry as { message?: { content?: unknown } }).message?.content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? textBlocks(content) : null
      const task = text === null ? null : workflowTask(text)
      if (task === null) return
      src.tasked = true
      this.o.onWorkflowTask(src.runId, src.agentId, task)
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

  /** The main conversation's title: a custom title wins over the AI one; a sidechain or malformed entry is left out */
  private reportTitle(src: Source, line: string): void {
    if (!this.o.onTitle || src.agentId !== null || !line.includes('-title"')) return
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      return
    }
    if (typeof entry !== 'object' || entry === null || (entry as { isSidechain?: unknown }).isSidechain === true) return
    const { type, aiTitle, customTitle } = entry as { type?: unknown; aiTitle?: unknown; customTitle?: unknown }
    if (type === 'custom-title') this.customTitle = oneLine(customTitle) ?? this.customTitle
    else if (type === 'ai-title') this.aiTitle = oneLine(aiTitle) ?? this.aiTitle
    else return
    const current = this.customTitle ?? this.aiTitle
    if (current === null || current === this.reportedTitle) return
    this.reportedTitle = current
    try {
      this.o.onTitle(current)
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
