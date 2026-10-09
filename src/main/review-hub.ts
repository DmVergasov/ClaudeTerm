import { sep } from 'node:path'
import type { PipeResponse } from '../shared/protocol'
import { IN_DIALOG, NOT_RUNNING, SCOPE_LABELS, type ReviewCounter, type ReviewFile, type ReviewScope, type ReviewSendState, type ReviewUpdate } from '../shared/review'
import type { EditLedger } from './edit-ledger'
import { pathKey } from './path-key'
import { buildFiles, type DiffInput } from './review-diff'
import { testMatcher } from '../shared/test-files'
import { EMPTY_LEDGER, relPathFor, type Inputs, type ReviewSources, type Totals, type TranscriptLog } from './review-sources'
import type { TranscriptEditEvent } from './transcript-edits'

/** a diff Claude asked for with show_diff */
export interface ReviewRequest {
  cwd: string
  scope: ReviewScope | null
  from: string | null
  to: string | null
  paths: string[]
  title: string | null
}

export interface ReviewHubDeps {
  sources: ReviewSources
  ledgerFor(sessionId: string): EditLedger
  activeTabId(): string | null
  publish(update: ReviewUpdate): void
  onError(message: string): void
  /** review.hideIgnored: Last turn and Session leave out the files git ignores */
  hideIgnored(): boolean
  /** review.hideTests: the patterns of the files every view leaves out; null while the setting is off */
  testPatterns(): string[] | null
  debounceMs?: number
  /** the clock of a view's diff time limit; Date.now when absent */
  now?(): number
}

export const TOO_MANY_NOTICE = 'Too many changes to show at once — narrow the view with a smaller scope or paths'
/** how many outside paths the panel's tooltip lists */
const OUTSIDE_SAMPLE = 10
/** how many hidden test paths the panel's tooltip lists */
const TESTS_SAMPLE = 10

interface TabState {
  tabId: string
  /** Claude's current folder: follows the hook, finds the git root */
  cwd: string
  /** the folder the tab was opened in: Last turn and Session show the files inside it, and it never moves */
  folder: string
  claude: boolean
  sessionId: string | null
  ledger: EditLedger | null
  log: TranscriptLog
  /** transcript events already taken (a feed may read a transcript again) */
  logIds: Set<string>
  /** "<pathKey>@<turn start>": the first edit of a file in a turn keeps its originalFile */
  keptOriginal: Set<string>
  scope: ReviewScope | null
  request: ReviewRequest | null
  forced: Set<string>
  /** pathKey → the hash the file had when it was marked viewed */
  viewed: Map<string, string>
  running: boolean
  /** the agents with a dialog open in the terminal (null = the main conversation) → when it opened; Send waits while any is open */
  dialogs: Map<string | null, number>
  /** bumped whenever what the view is changes: a compute that started before is stale */
  gen: number
  computing: boolean
  rerun: boolean
  /** how to count the status bar counter when the view is not its scope (null: the view's own files give it) */
  countJob: (() => Promise<ReviewCounter | null>) | null
  /** one count at a time; `recount` asks for another when it ends */
  counting: boolean
  recount: boolean
  timer: ReturnType<typeof setTimeout> | null
  last: ReviewUpdate | null
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const total = (files: ReviewFile[], key: 'additions' | 'deletions'): number => files.reduce((n, f) => n + f[key], 0)
const totalsOf = (files: ReviewFile[]): Totals => ({ files: files.length, additions: total(files, 'additions'), deletions: total(files, 'deletions') })

function within(dir: string, path: string): boolean {
  const d = pathKey(dir)
  const p = pathKey(path)
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep)
}

function requestLabel(r: ReviewRequest, base: string): string {
  if (r.title) return r.title
  const what = r.from !== null ? `${r.from} → ${r.to ?? 'working tree'}` : SCOPE_LABELS[r.scope ?? 'uncommitted']
  return r.paths.length > 0 ? `${what} · ${r.paths.map((p) => relPathFor(base, p)).join(', ')}` : what
}

/** Each Claude tab's review: what the Changes panel shows, when it is computed, and whether Send may write now. */
export class ReviewHub {
  private readonly tabs = new Map<string, TabState>()

  constructor(private readonly d: ReviewHubDeps) {}

  addTab(tabId: string, cwd: string, claude: boolean): void {
    if (this.tabs.has(tabId)) return
    this.tabs.set(tabId, {
      tabId, cwd, folder: cwd, claude, sessionId: null, ledger: null, log: { prompts: [], edits: [] }, logIds: new Set(), keptOriginal: new Set(),
      scope: null, request: null, forced: new Set(), viewed: new Map(), running: false,
      dialogs: new Map(), gen: 0, computing: false, rerun: false, countJob: null, counting: false, recount: false, timer: null, last: null
    })
  }

  removeTab(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (t?.timer) clearTimeout(t.timer)
    this.tabs.delete(tabId)
  }

  dispose(): void {
    for (const id of [...this.tabs.keys()]) this.removeTab(id)
  }

  // ---- Claude's session

  /** `source` is the SessionStart source: a compaction happens mid-turn, a subagent's dialog may still be open then */
  sessionStarted(tabId: string, sessionId: string, source: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    this.useSession(t, sessionId)
    t.running = true
    if (source !== 'compact') t.dialogs.clear()
    this.publishState(t)
    this.trigger(tabId)
  }

  /** the end of a session the tab has left (a late SessionEnd after /clear) changes nothing */
  sessionEnded(tabId: string, sessionId: string): void {
    const t = this.tabs.get(tabId)
    if (!t || t.sessionId !== sessionId) return
    t.running = false
    t.dialogs.clear()
    this.publishState(t)
  }

  turn(tabId: string, sessionId: string, cwd: string | null): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    this.useSession(t, sessionId)
    if (cwd) t.cwd = cwd
    t.running = true
    t.dialogs.delete(null)
    t.ledger!.startTurn()
    this.publishState(t)
  }

  /** Claude is about to change `path`: keep the file as it is now */
  recordBefore(tabId: string, sessionId: string, toolUseId: string, path: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    this.useSession(t, sessionId)
    t.ledger!.recordBefore(toolUseId, path, () => this.d.sources.read(path))
  }

  transcriptEvent(tabId: string, ev: TranscriptEditEvent): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    const id = ev.kind === 'prompt' ? `p:${ev.id}` : `e:${ev.toolUseId}`
    if (t.logIds.has(id)) return
    t.logIds.add(id)
    if (ev.kind === 'prompt') {
      t.log.prompts.push(ev.at)
      return
    }
    // only a file's first edit in a turn needs its original content; the rest would only take memory.
    // The turn is the edit's own (the latest prompt at or before it): a subagent's transcript may be read after later prompts
    const turnStart = t.log.prompts.reduce((m, p) => (p <= ev.at && p > m ? p : m), Number.NEGATIVE_INFINITY)
    const turnKey = `${pathKey(ev.path)}@${turnStart}`
    const keep = !t.keptOriginal.has(turnKey)
    t.keptOriginal.add(turnKey)
    t.log.edits.push({ at: ev.at, toolUseId: ev.toolUseId, path: ev.path, created: ev.created, originalFile: keep ? ev.originalFile : null, patch: ev.patch })
    this.trigger(tabId)
  }

  /**
   * an assistant entry (written at `at`, ms) of the main conversation (null) or of a subagent: a dialog that agent raised is answered.
   * Only an entry newer than the dialog counts: the entry holding the tool_use that raised it is written before the hook fires and may be read after
   */
  assistantEntry(tabId: string, agentId: string | null, at: number): void {
    this.answered(tabId, agentId, at)
  }

  /**
   * the user interrupted that agent's turn (Esc on a question, a denied permission prompt; written at `at`, ms): the dialog
   * is gone, though no assistant entry follows and no Stop fires. Only an interrupt newer than the dialog counts
   */
  interrupted(tabId: string, agentId: string | null, at: number): void {
    this.answered(tabId, agentId, at)
  }

  /** SubagentStop: a dialog the subagent raised is gone with it */
  subagentStopped(tabId: string, agentId: string): void {
    const t = this.tabs.get(tabId)
    if (!t?.dialogs.delete(agentId)) return
    this.publishState(t)
  }

  dialogOpened(tabId: string, agentId: string | null): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    t.dialogs.set(agentId, Date.now())
    this.publishState(t)
  }

  /** Stop: the turn is over, files Claude changed through Bash are in place now; a subagent's dialog may still be open */
  turnEnded(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    t.dialogs.delete(null)
    this.publishState(t)
    this.trigger(tabId)
  }

  canSend(tabId: string): ReviewSendState {
    const t = this.tabs.get(tabId)
    return t ? this.sendState(t) : { ok: false, reason: NOT_RUNNING }
  }

  /** "Open in editor" takes only a file the tab's view shows (the last one published, a show_diff view too) */
  hasFile(tabId: string, path: string): boolean {
    const key = pathKey(path)
    return this.tabs.get(tabId)?.last?.files.some((f) => pathKey(f.path) === key) ?? false
  }

  // ---- what the view shows

  setScope(tabId: string, scope: ReviewScope): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    t.scope = scope
    t.request = null
    t.forced.clear()
    t.gen++
    this.refresh(tabId)
  }

  clearRequest(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    t.request = null
    t.forced.clear()
    t.gen++
    this.refresh(tabId)
  }

  /** "show anyway" for a too large file */
  showFile(tabId: string, path: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    t.forced.add(pathKey(path))
    t.gen++
    this.refresh(tabId)
  }

  setViewed(tabId: string, path: string, hash: string, viewed: boolean): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    if (viewed) t.viewed.set(pathKey(path), hash)
    else t.viewed.delete(pathKey(path))
    this.publishState(t)
  }

  // ---- when to compute

  /** something changed for the tab: compute it soon if it is in front; a tab behind computes when it comes to the front */
  trigger(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t?.claude || this.d.activeTabId() !== tabId) return
    this.schedule(t, this.d.debounceMs ?? 300)
  }

  /** the tab came to the front: files may have changed outside Claude meanwhile, so it always computes */
  activated(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (t?.claude) this.schedule(t, 0)
  }

  refresh(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (t?.claude) this.schedule(t, 0)
  }

  async showRequest(tabId: string | null, req: ReviewRequest): Promise<PipeResponse> {
    const t = tabId ? this.tabs.get(tabId) : undefined
    if (!t?.claude) return { ok: false, error: 'show_diff works only in a ClaudeTerm Claude tab' }
    if (req.from !== null || (req.scope ?? 'uncommitted') === 'uncommitted') {
      const r = await this.d.sources.root(req.cwd)
      if (r.root === null) return { ok: false, error: r.problem === 'Not a git repository' ? `not a git repository: ${req.cwd}` : r.problem }
      for (const ref of [req.from, req.to]) {
        if (ref === null) continue
        try {
          await this.d.sources.verify(r.root, ref)
        } catch (e) {
          return { ok: false, error: message(e) }
        }
      }
    }
    const { update, counting } = await this.build(t, req, new Set())
    if (this.tabs.get(t.tabId) !== t) return { ok: false, error: 'the tab was closed' }
    if (update.files.length === 0 && update.notice) return { ok: false, error: update.notice }
    // Claude must not take a hidden file for an unchanged one
    const n0 = update.ignored
    const n1 = update.outside
    const n2 = update.testsHidden
    const hidden = (n0 > 0 ? ` (${n0} file${n0 === 1 ? '' : 's'} git ignores ${n0 === 1 ? 'is' : 'are'} hidden: review.hideIgnored)` : '')
      + (n1 > 0 ? ` (${n1} file${n1 === 1 ? '' : 's'} outside the session folder ${n1 === 1 ? 'is' : 'are'} not shown)` : '')
      + (n2 > 0 ? ` (${n2} test file${n2 === 1 ? '' : 's'} ${n2 === 1 ? 'is' : 'are'} hidden: review.hideTests)` : '')
    if (update.files.length === 0 && req.paths.length > 0) return { ok: false, error: `nothing in the view for paths: ${req.paths.join(', ')}${hidden}` }
    t.request = req
    t.forced.clear()
    t.gen++
    t.last = update
    this.d.publish({ ...this.withState(t, update), reveal: true })
    this.countLater(t, counting)
    const n = update.files.length
    return { ok: true, info: n === 0 ? `No changes in this view.${hidden}` : `Opened ${n} file${n === 1 ? '' : 's'} (+${update.additions} −${update.deletions}) in the Changes panel.${hidden}` }
  }

  // ---- inside

  /** the agent went on after its dialog (written at `at`): the dialog is answered; an entry written before it opened is not */
  private answered(tabId: string, agentId: string | null, at: number): void {
    const t = this.tabs.get(tabId)
    const openedAt = t?.dialogs.get(agentId)
    if (!t || openedAt === undefined || at <= openedAt) return
    t.dialogs.delete(agentId)
    this.publishState(t)
  }

  private useSession(t: TabState, sessionId: string): void {
    if (t.sessionId === sessionId && t.ledger) return
    t.sessionId = sessionId
    t.ledger = this.d.ledgerFor(sessionId)
    t.log = { prompts: [], edits: [] }
    t.logIds.clear()
    t.keptOriginal.clear()
    t.gen++
  }

  private schedule(t: TabState, ms: number): void {
    if (t.timer) clearTimeout(t.timer)
    t.timer = setTimeout(() => {
      t.timer = null
      this.compute(t).catch((e) => this.d.onError(`review: ${message(e)}`))
    }, ms)
  }

  private async compute(t: TabState): Promise<void> {
    if (t.computing) {
      t.rerun = true
      return
    }
    t.computing = true
    try {
      do {
        t.rerun = false
        const gen = t.gen
        const { update, counting } = await this.build(t, t.request, t.forced)
        if (this.tabs.get(t.tabId) !== t) return
        if (gen !== t.gen) {
          t.rerun = true
          continue
        }
        t.last = update
        this.d.publish(this.withState(t, update))
        this.countLater(t, counting)
      } while (t.rerun)
    } finally {
      t.computing = false
    }
  }

  /**
   * the view is taken as it is when the compute starts (`request` and `t.scope`): a change while it runs makes the result stale, never mixed.
   * A counter that needs git work of its own does not hold the view back: the view carries the last known counter, and `counting` yields the new one.
   */
  private async build(
    t: TabState, request: ReviewRequest | null, forcedKeys: ReadonlySet<string>
  ): Promise<{ update: ReviewUpdate; counting: (() => Promise<ReviewCounter | null>) | null }> {
    const chosen = t.scope
    const cwd = request?.cwd ?? t.cwd
    const r = await this.d.sources.root(cwd)
    const root = r.root
    const problem = r.root === null ? r.problem : ''
    const scope: ReviewScope = chosen ?? (root ? 'uncommitted' : 'session')
    if (t.scope === null) t.scope = scope
    const base = root ?? cwd
    const forced = (p: string): boolean => forcedKeys.has(pathKey(p))
    // the setting is read once: the view and what it says about the setting agree
    const patterns = this.d.testPatterns()
    const view = await this.inputs(t, request, scope, root, problem, base, forced, patterns)
    const { files, tooMany } = await buildFiles(view.inputs, this.d.now)
    // the status bar counts all the changes: a view that left test files out cannot give the counter
    const own = !request && scope === (root ? 'uncommitted' : 'session') && view.tests.length === 0
    const update: ReviewUpdate = {
      tabId: t.tabId,
      view: request ? { kind: 'request' } : { kind: 'scope', scope },
      label: request ? requestLabel(request, base) : SCOPE_LABELS[scope],
      uncommitted: root ? { available: true } : { available: false, reason: problem },
      files,
      additions: total(files, 'additions'),
      deletions: total(files, 'deletions'),
      unviewed: files.length,
      ignored: view.ignored,
      hideTests: patterns !== null,
      testsHidden: view.tests.length,
      testsSample: [...view.tests].sort().slice(0, TESTS_SAMPLE),
      outside: view.outside,
      outsideSample: view.outsideSample,
      folder: t.folder,
      notice: view.notice ?? (tooMany ? TOO_MANY_NOTICE : null),
      send: this.sendState(t),
      counter: own ? this.counterOf(root, totalsOf(files)) : (t.last?.counter ?? null),
      reveal: false
    }
    return { update, counting: own ? null : () => this.otherCounter(t, root, base) }
  }

  /**
   * The counter for a view that is not its scope. One count runs per tab at a time and a newer view asks for one more after it;
   * a count lands on the tab's current view (it does not depend on the view's files), published only if it differs.
   */
  private countLater(t: TabState, job: (() => Promise<ReviewCounter | null>) | null): void {
    t.countJob = job
    if (!job) return
    if (t.counting) {
      t.recount = true
      return
    }
    void this.runCount(t)
  }

  private async runCount(t: TabState): Promise<void> {
    t.counting = true
    try {
      do {
        t.recount = false
        const job = t.countJob
        if (!job) return
        let counter: ReviewCounter | null
        try {
          counter = await job()
        } catch (e) {
          this.d.onError(`review: ${message(e)}`)
          continue
        }
        // a view with its own counter came meanwhile: this count is not wanted
        if (this.tabs.get(t.tabId) !== t) return
        if (!t.countJob || !t.last || JSON.stringify(counter) === JSON.stringify(t.last.counter)) continue
        t.last = { ...t.last, counter }
        this.d.publish(this.withState(t, t.last))
      } while (t.recount)
    } finally {
      t.counting = false
    }
  }

  private async inputs(
    t: TabState, request: ReviewRequest | null, scope: ReviewScope, root: string | null, problem: string, base: string, forced: (p: string) => boolean,
    patterns: string[] | null
  ): Promise<{ inputs: DiffInput[]; notice: string | null; ignored: number; outside: number; outsideSample: string[]; tests: string[] }> {
    const s = this.d.sources
    const wanted: ReviewScope | null = request ? (request.from !== null ? null : request.scope ?? 'uncommitted') : scope
    const paths = request?.paths ?? []
    let ignored = 0
    let outside: string[] = []
    let tests: string[] = []
    const isTest = patterns ? testMatcher(patterns) : null
    try {
      let r: Inputs
      if (wanted === 'last_turn' || wanted === 'session') {
        const ledger = t.ledger ?? EMPTY_LEDGER
        const candidates = s.ledgerPaths(ledger, t.log, wanted).filter((p) => paths.length === 0 || paths.some((q) => within(q, p)))
        // only the session folder is reviewed; the outside files are neither sent to git nor read
        outside = candidates.filter((p) => !within(t.folder, p))
        const outsideKeys = new Set(outside.map((p) => pathKey(p)))
        const inside = candidates.filter((p) => !outsideKeys.has(pathKey(p)))
        const hidden = root && this.d.hideIgnored() ? await this.ignoredFiles(root, inside) : new Set<string>()
        ignored = hidden.size
        // test files are told by their names alone, before anything is read; a file git ignores is counted as ignored. Every file is
        // inside the tab folder, and the folder is what the patterns are relative to (the folder Claude is in now may be a different one)
        const testPaths = isTest ? inside.filter((p) => !hidden.has(pathKey(p)) && isTest(relPathFor(t.folder, p))) : []
        tests = testPaths.map((p) => relPathFor(t.folder, p))
        const testKeys = new Set(testPaths.map((p) => pathKey(p)))
        r = s.ledger(ledger, t.log, wanted, base, forced, (p) => hidden.has(pathKey(p)) || outsideKeys.has(pathKey(p)) || testKeys.has(pathKey(p)))
        if (paths.length > 0) r = { ...r, inputs: r.inputs.filter((i) => paths.some((p) => within(p, i.path))) }
      } else {
        if (!root) return { inputs: [], notice: problem, ignored, outside: 0, outsideSample: [], tests: [] }
        const from = request?.from ?? (await s.head(root))
        r = await s.git(root, from, request?.to ?? null, paths, forced, isTest ?? (() => false))
        tests = (r.excluded ?? []).map((p) => relPathFor(root, p))
      }
      return { inputs: r.inputs, notice: r.tooMany ? TOO_MANY_NOTICE : null, ignored, outside: outside.length, outsideSample: [...outside].sort().slice(0, OUTSIDE_SAMPLE), tests }
    } catch (e) {
      return { inputs: [], notice: message(e), ignored: 0, outside: 0, outsideSample: [], tests: [] }
    }
  }

  /** pathKeys of the files git ignores; a failed check hides nothing, it is only logged */
  private async ignoredFiles(root: string, paths: string[]): Promise<Set<string>> {
    if (paths.length === 0) return new Set()
    try {
      return new Set((await this.d.sources.ignored(root, paths)).map((p) => pathKey(p)))
    } catch (e) {
      this.d.onError(`review: ${message(e)}`)
      return new Set()
    }
  }

  /** the status bar counter for these totals: Uncommitted in a repository, else the session */
  private counterOf(root: string | null, n: Totals | null): ReviewCounter | null {
    if (n === null || n.files === 0) return null
    return { ...n, title: root ? `Uncommitted changes in ${root}` : "Claude's edits in this session" }
  }

  /** the counter when the panel shows another scope: git counts Uncommitted without a diff, and outside git the session is built */
  private async otherCounter(t: TabState, root: string | null, base: string): Promise<ReviewCounter | null> {
    if (root) return this.counterOf(root, await this.d.sources.totals(root))
    const session = await this.inputs(t, null, 'session', null, '', base, () => false, null)
    return this.counterOf(root, totalsOf((await buildFiles(session.inputs, this.d.now)).files))
  }

  private withState(t: TabState, u: ReviewUpdate): ReviewUpdate {
    const files = u.files.map((f) => ({ ...f, viewed: t.viewed.get(pathKey(f.path)) === f.hash }))
    return { ...u, files, unviewed: files.filter((f) => !f.viewed).length, send: this.sendState(t) }
  }

  private sendState(t: TabState): ReviewSendState {
    if (!t.running) return { ok: false, reason: NOT_RUNNING }
    if (t.dialogs.size > 0) return { ok: false, reason: IN_DIALOG }
    return { ok: true }
  }

  private publishState(t: TabState): void {
    if (t.last) this.d.publish(this.withState(t, t.last))
  }
}
