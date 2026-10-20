import { open, stat } from 'node:fs/promises'
import type { PlatformPath } from 'node:path'
import type { PlanUpdate } from '../shared/ipc'
import type { PlanStatus } from '../shared/types'
import { nativePath, pathKey } from './path-key'
import { asFinished, fromGitBashPath, parseLedger, parsePlan, planFileOf, planStatus } from './plan-files'

export type PlanRead = string | 'missing' | 'error'

export const PLAN_FILE_MAX_BYTES = 4 * 1024 * 1024

/** a file's text; 'missing' for ENOENT/ENOTDIR, 'error' for any other failure or a file over the cap */
export async function readPlanFile(file: string): Promise<PlanRead> {
  try {
    // never open a device or a pipe: reading one has no end, or blocks a thread of the pool
    const before = await stat(file)
    if (!before.isFile() || before.size > PLAN_FILE_MAX_BYTES) return 'error'
    const handle = await open(file, 'r')
    try {
      const st = await handle.stat()
      if (!st.isFile() || st.size > PLAN_FILE_MAX_BYTES) return 'error'
      const buf = Buffer.alloc(Math.min(st.size + 1, PLAN_FILE_MAX_BYTES + 1))
      let n = 0
      for (;;) {
        const { bytesRead } = await handle.read(buf, n, buf.length - n, null)
        if (bytesRead === 0) break
        n += bytesRead
        if (n > PLAN_FILE_MAX_BYTES) return 'error'
      }
      return buf.toString('utf8', 0, n)
    } finally {
      await handle.close()
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'error'
  }
}

export interface PlanHubDeps {
  read(file: string): Promise<PlanRead>
  onChange(tabId: string): void
  path?: PlatformPath
}

interface TabPlan {
  sessionId: string | null
  ended: boolean
  /** the ledger workspace folder, as first reported */
  dir: string | null
  /** the time of the newest report taken in this session */
  reportAt: number
  status: PlanStatus | null
  /** what the last onChange carried */
  sent: string
  running: Promise<void> | null
  again: boolean
}

/**
 * The superpowers plan a tab's Claude is carrying out, from the ledger workspace the transcript reported.
 * Everything read is untrusted and may be half written: a read that fails keeps the last state, and only a
 * missing `plan-path` file means the workspace is gone (the work is over).
 */
export class PlanHub {
  private readonly tabs = new Map<string, TabPlan>()
  private readonly path: PlatformPath

  constructor(private readonly deps: PlanHubDeps) {
    this.path = deps.path ?? nativePath
  }

  get(tabId: string): PlanUpdate {
    const t = this.tabs.get(tabId)
    return { tabId, plan: t && !t.ended ? t.status : null }
  }

  session(tabId: string, sessionId: string): void {
    const t = this.tab(tabId)
    if (t.sessionId !== null && t.sessionId !== sessionId) {
      t.dir = null
      t.status = null
      t.reportAt = 0
    }
    t.sessionId = sessionId
    t.ended = false
    this.notify(tabId, t)
    if (t.dir) void this.request(tabId, t)
  }

  sessionEnd(tabId: string, sessionId: string): void {
    const t = this.tabs.get(tabId)
    if (!t || t.sessionId !== sessionId) return
    t.ended = true
    this.notify(tabId, t)
  }

  /** a ledger workspace the transcript printed; resolves once the read it started has finished */
  workspace(tabId: string, printed: string, at = 0): Promise<void> {
    const dir = fromGitBashPath(printed.trim(), this.path)
    if (!this.path.isAbsolute(dir)) return Promise.resolve()
    const t = this.tab(tabId)
    // a replay reads the transcripts in file order, not in time order: an older report must not beat a newer one
    if (at !== 0 && at < t.reportAt) return Promise.resolve()
    t.reportAt = Math.max(t.reportAt, at)
    if (!t.dir || pathKey(t.dir, this.path) !== pathKey(dir, this.path)) {
      t.dir = dir
      t.status = null
      this.notify(tabId, t)
    }
    return this.request(tabId, t)
  }

  async refresh(): Promise<void> {
    const reads: Promise<void>[] = []
    for (const [tabId, t] of this.tabs) if (t.dir && !t.ended) reads.push(this.request(tabId, t))
    await Promise.all(reads)
  }

  removeTab(tabId: string): void {
    this.tabs.delete(tabId)
  }

  private tab(tabId: string): TabPlan {
    let t = this.tabs.get(tabId)
    if (!t) {
      t = { sessionId: null, ended: false, dir: null, reportAt: 0, status: null, sent: JSON.stringify({ tabId, plan: null }), running: null, again: false }
      this.tabs.set(tabId, t)
    }
    return t
  }

  private notify(tabId: string, t: TabPlan): void {
    const now = JSON.stringify(this.get(tabId))
    if (now === t.sent) return
    t.sent = now
    this.deps.onChange(tabId)
  }

  /** Reads of one tab never overlap: a request during a read marks one more read after it. */
  private request(tabId: string, t: TabPlan): Promise<void> {
    if (t.running) {
      t.again = true
      return t.running
    }
    t.running = (async () => {
      try {
        do {
          t.again = false
          await this.readOnce(tabId, t)
        } while (t.again)
      } finally {
        t.running = null
      }
    })()
    return t.running
  }

  private async readOnce(tabId: string, t: TabPlan): Promise<void> {
    const dir = t.dir
    if (!dir) return
    const key = pathKey(dir, this.path)
    // the workspace was replaced, or the tab dropped, while this read ran
    const stale = (): boolean => this.tabs.get(tabId) !== t || !t.dir || pathKey(t.dir, this.path) !== key
    try {
      const pointer = await this.deps.read(this.path.join(dir, 'plan-path'))
      if (stale()) return
      if (pointer === 'missing') {
        if (t.status && !t.status.finished) {
          t.status = asFinished(t.status)
          this.notify(tabId, t)
        }
        return
      }
      if (pointer === 'error') return
      const planFile = planFileOf(dir, pointer, this.path)
      if (!planFile) return
      const [planText, ledgerText] = await Promise.all([this.deps.read(planFile), this.deps.read(this.path.join(dir, 'progress.md'))])
      if (stale()) return
      if (planText === 'missing' || planText === 'error' || ledgerText === 'error') return
      const plan = parsePlan(planText)
      if (!plan) return
      const status = planStatus(plan, parseLedger(ledgerText === 'missing' ? '' : ledgerText), this.path.basename(planFile, '.md'))
      if (JSON.stringify(status) === JSON.stringify(t.status)) return
      t.status = status
      this.notify(tabId, t)
    } catch {
      // keep the last state
    }
  }
}
