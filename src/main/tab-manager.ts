import { randomUUID } from 'node:crypto'
import type { OpenTabRequest, SessionSnapshotTab, TabInfo } from '../shared/types'
import type { LaunchSpec } from './profiles'
import type { PtyHandle, SpawnPty } from './pty-host'

export interface ResolvedLaunch {
  profileName: string
  spec: LaunchSpec
}

export interface TabEvents {
  opened(tab: TabInfo): void
  updated(tab: TabInfo): void
  closed(tabId: string): void
  activated(tabId: string): void
  order(ids: string[]): void
  data(tabId: string, data: string): void
  exit(tabId: string, code: number): void
}

export interface TabManagerDeps {
  spawn: SpawnPty
  resolveLaunch(req: OpenTabRequest): ResolvedLaunch
  baseEnv(): Record<string, string>
  pipeName: string
  events: TabEvents
  onTabStarted?(tab: TabInfo): void
  onTabClosed?(tabId: string): void
  onStateChanged?(): void
  flushMs?: number
}

interface TabRecord {
  info: TabInfo
  launch: ResolvedLaunch
  pty: PtyHandle | null
  buffer: string
  timer: ReturnType<typeof setTimeout> | null
  cols: number
  rows: number
}

export class TabManager {
  private readonly tabs = new Map<string, TabRecord>()
  private order: string[] = []
  private activeId: string | null = null
  private disposed = false

  constructor(private readonly deps: TabManagerDeps) {}

  open(req: OpenTabRequest, opts: { activate?: boolean } = {}): TabInfo {
    const launch = this.deps.resolveLaunch(req)
    const info: TabInfo = {
      id: randomUUID(),
      kind: req.kind,
      profile: launch.profileName,
      cwd: req.cwd,
      customTitle: req.title ?? null,
      claudeSessionId: req.kind === 'claude' ? req.resumeSessionId ?? null : null,
      exited: false
    }
    const rec: TabRecord = { info, launch, pty: null, buffer: '', timer: null, cols: 120, rows: 30 }
    this.tabs.set(info.id, rec)
    this.order.push(info.id)
    this.deps.events.opened({ ...info })
    this.deps.onTabStarted?.({ ...info })
    this.start(rec)
    if (opts.activate ?? true) this.activate(info.id)
    this.changed()
    return { ...info }
  }

  close(tabId: string): void {
    const rec = this.tabs.get(tabId)
    if (!rec) return
    const idx = this.order.indexOf(tabId)
    this.tabs.delete(tabId)
    this.order.splice(idx, 1)
    if (rec.timer) clearTimeout(rec.timer)
    rec.pty?.kill()
    this.deps.events.closed(tabId)
    this.deps.onTabClosed?.(tabId)
    if (this.activeId === tabId) {
      this.activeId = null
      const next = this.order[Math.min(idx, this.order.length - 1)]
      if (next) this.activate(next)
    }
    this.changed()
  }

  activate(tabId: string): void {
    if (!this.tabs.has(tabId)) return
    this.activeId = tabId
    this.deps.events.activated(tabId)
  }

  activeTabId(): string | null {
    return this.activeId
  }

  rename(tabId: string, title: string | null): void {
    const rec = this.tabs.get(tabId)
    if (!rec) return
    const t = title?.trim()
    rec.info.customTitle = t ? t : null
    this.deps.events.updated({ ...rec.info })
    this.changed()
  }

  reorder(ids: string[]): void {
    const valid = ids.length === this.order.length && new Set(ids).size === ids.length && ids.every((id) => this.tabs.has(id))
    if (!valid) return
    this.order = [...ids]
    this.deps.events.order([...ids])
    this.changed()
  }

  restart(tabId: string): void {
    const rec = this.tabs.get(tabId)
    if (!rec || !rec.info.exited) return
    if (rec.info.kind === 'claude') {
      // the conversation may have changed since open (/clear), so resume the CURRENT one
      try {
        rec.launch = this.deps.resolveLaunch({ kind: 'claude', cwd: rec.info.cwd, resumeSessionId: rec.info.claudeSessionId })
      } catch {
        // keep the previous launch
      }
    }
    rec.info.exited = false
    this.deps.events.updated({ ...rec.info })
    this.start(rec)
  }

  write(tabId: string, data: string): void {
    this.tabs.get(tabId)?.pty?.write(data)
  }

  resize(tabId: string, cols: number, rows: number): void {
    const rec = this.tabs.get(tabId)
    if (!rec || cols < 1 || rows < 1) return
    rec.cols = cols
    rec.rows = rows
    rec.pty?.resize(cols, rows)
  }

  setClaudeSession(tabId: string, sessionId: string): boolean {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.info.kind !== 'claude') return false
    if (rec.info.claudeSessionId !== sessionId) {
      rec.info.claudeSessionId = sessionId
      this.deps.events.updated({ ...rec.info })
      this.changed()
    }
    return true
  }

  list(): TabInfo[] {
    return this.order.map((id) => ({ ...this.tabs.get(id)!.info }))
  }

  get(tabId: string): TabInfo | null {
    const rec = this.tabs.get(tabId)
    return rec ? { ...rec.info } : null
  }

  snapshot(): SessionSnapshotTab[] {
    return this.order.map((id) => {
      const i = this.tabs.get(id)!.info
      return { kind: i.kind, profile: i.profile, cwd: i.cwd, title: i.customTitle, claudeSessionId: i.claudeSessionId }
    })
  }

  disposeAll(): void {
    this.disposed = true
    for (const rec of this.tabs.values()) {
      if (rec.timer) clearTimeout(rec.timer)
      rec.pty?.kill()
    }
    this.tabs.clear()
    this.order = []
    this.activeId = null
  }

  private changed(): void {
    if (!this.disposed) this.deps.onStateChanged?.()
  }

  private start(rec: TabRecord): void {
    const env = { ...this.deps.baseEnv(), CLAUDETERM_TAB_ID: rec.info.id, CLAUDETERM_PIPE: this.deps.pipeName }
    try {
      rec.pty = this.deps.spawn({
        file: rec.launch.spec.file,
        args: rec.launch.spec.args,
        cwd: rec.info.cwd,
        env,
        cols: rec.cols,
        rows: rec.rows,
        onData: (d) => this.queue(rec, d),
        onExit: (code) => this.exited(rec, code)
      })
    } catch (e) {
      rec.pty = null
      this.queue(rec, `\r\n[failed to start ${rec.launch.spec.file}: ${(e as Error).message}]\r\n`)
      this.exited(rec, -1)
    }
  }

  private isLive(rec: TabRecord): boolean {
    return this.tabs.get(rec.info.id) === rec
  }

  private queue(rec: TabRecord, data: string): void {
    if (!this.isLive(rec)) return
    rec.buffer += data
    if (!rec.timer) rec.timer = setTimeout(() => this.flush(rec), this.deps.flushMs ?? 5)
  }

  private flush(rec: TabRecord): void {
    if (rec.timer) {
      clearTimeout(rec.timer)
      rec.timer = null
    }
    if (!rec.buffer || !this.isLive(rec)) return
    const d = rec.buffer
    rec.buffer = ''
    this.deps.events.data(rec.info.id, d)
  }

  private exited(rec: TabRecord, code: number): void {
    if (!this.isLive(rec)) return
    this.flush(rec)
    rec.pty = null
    rec.info.exited = true
    this.deps.events.exit(rec.info.id, code)
    this.deps.events.updated({ ...rec.info })
  }
}
