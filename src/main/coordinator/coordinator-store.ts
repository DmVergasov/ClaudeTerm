import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { CoordReport, TaskState } from '../../shared/coordinator'
import { MAIL_REASON_MAX, REPORT_OUTCOMES, type MailAddress, type ReportOutcome } from '../../shared/mail'
import { isProjectKey } from '../../shared/note'
import { isUuid } from '../../shared/protocol'

/** The most tasks kept for one hosted session; the rest of a file are skipped. */
export const MAX_TASKS_PER_SESSION = 20

const MAX_COORDINATORS = 50
const MAX_ATTACHMENTS = 200
const MAX_HOSTED = 500
const NAME_MAX = 200
const TASK_STATES: readonly TaskState[] = ['queued', 'delivered', 'open']

/**
 * A session of a coordinator's project, attached to that coordinator. `device` null is this device: the store does not
 * rewrite addresses, so callers store this device as null.
 */
export interface StoredAttachment {
  device: string | null
  session: string
  name: string
  attachedAt: number
  resolved: boolean
  failed: boolean
  lastReport: CoordReport | null
}

/** A coordinator on this device: the Claude session that coordinates one project. */
export interface StoredCoordinator {
  session: string
  project: { key: string; name: string }
  since: number
  attachments: StoredAttachment[]
}

/**
 * A task given to a hosted session. `from.device` null is this device: the store does not rewrite addresses, so callers
 * store this device as null.
 */
export interface StoredTask {
  id: string
  from: MailAddress
  state: TaskState
  queuedAt: number
  deliveredAt: number | null
}

/**
 * A session of this device attached to a coordinator: whom it takes tasks from, and its tasks. `device` null in
 * `coordinator` is this device: the store does not rewrite addresses, so callers store this device as null.
 */
export interface StoredHosted {
  session: string
  coordinator: MailAddress
  project: string
  tasks: StoredTask[]
}

export interface CoordinatorData {
  coordinators: StoredCoordinator[]
  hosted: StoredHosted[]
}

export interface CoordinatorStoreOptions {
  debounceMs?: number
  onError?(message: string): void
  /** what the user is told: the file could not be read */
  warn?(message: string): void
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isDevice = (v: unknown): v is string | null => v === null || isUuid(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** a name: 1 to max characters (NAME_MAX by default), none of them a control character */
function isName(v: unknown, max = NAME_MAX): v is string {
  if (typeof v !== 'string' || v.length < 1 || v.length > max) return false
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i)
    if (c < 32 || c === 127) return false
  }
  return true
}

function parseAddress(v: unknown): MailAddress | null {
  if (!isObject(v) || !isDevice(v.device) || !isUuid(v.session) || !isName(v.name)) return null
  return { device: v.device, session: v.session, name: v.name }
}

function parseReport(v: unknown): CoordReport | null {
  if (!isObject(v) || !isUuid(v.id) || !isTime(v.at)) return null
  const outcome = v.outcome
  if (!REPORT_OUTCOMES.includes(outcome as ReportOutcome)) return null
  if (v.reason !== null && !isName(v.reason, MAIL_REASON_MAX)) return null
  return { id: v.id, outcome: outcome as ReportOutcome, reason: v.reason as string | null, at: v.at }
}

function parseAttachment(v: unknown): StoredAttachment | null {
  if (!isObject(v) || !isDevice(v.device) || !isUuid(v.session) || !isName(v.name) || !isTime(v.attachedAt)) return null
  if (typeof v.resolved !== 'boolean' || typeof v.failed !== 'boolean') return null
  const lastReport = v.lastReport === null ? null : parseReport(v.lastReport)
  if (v.lastReport !== null && !lastReport) return null
  return {
    device: v.device,
    session: v.session,
    name: v.name,
    attachedAt: v.attachedAt,
    resolved: v.resolved,
    failed: v.failed,
    lastReport
  }
}

function parseTask(v: unknown): StoredTask | null {
  if (!isObject(v) || !isUuid(v.id) || !isTime(v.queuedAt)) return null
  const from = parseAddress(v.from)
  if (!from || !TASK_STATES.includes(v.state as TaskState)) return null
  if (v.deliveredAt !== null && !isTime(v.deliveredAt)) return null
  return { id: v.id, from, state: v.state as TaskState, queuedAt: v.queuedAt, deliveredAt: v.deliveredAt as number | null }
}

function parseCoordinator(v: unknown): StoredCoordinator | null {
  if (!isObject(v) || !isUuid(v.session) || !isTime(v.since) || !Array.isArray(v.attachments)) return null
  const project = v.project
  if (!isObject(project) || !isProjectKey(project.key) || !isName(project.name)) return null
  const attachments: StoredAttachment[] = []
  for (const x of v.attachments) {
    if (attachments.length >= MAX_ATTACHMENTS) break
    const a = parseAttachment(x)
    if (a) attachments.push(a)
  }
  return { session: v.session, project: { key: project.key, name: project.name }, since: v.since, attachments }
}

function parseHosted(v: unknown): StoredHosted | null {
  if (!isObject(v) || !isUuid(v.session) || !isName(v.project) || !Array.isArray(v.tasks)) return null
  const coordinator = parseAddress(v.coordinator)
  if (!coordinator) return null
  const tasks: StoredTask[] = []
  for (const x of v.tasks) {
    if (tasks.length >= MAX_TASKS_PER_SESSION) break
    const t = parseTask(x)
    if (t) tasks.push(t)
  }
  return { session: v.session, coordinator, project: v.project, tasks }
}

/**
 * Reads the coordinators file: the valid entries, one coordinator per session and per project, one hosted entry per
 * session; null when the text is not a JSON object with version 1.
 */
export function parseCoordinators(text: string): CoordinatorData | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.coordinators) || !Array.isArray(raw.hosted)) return null

  const coordinators: StoredCoordinator[] = []
  const sessions = new Set<string>()
  const keys = new Set<string>()
  for (const x of raw.coordinators) {
    if (coordinators.length >= MAX_COORDINATORS) break
    const c = parseCoordinator(x)
    if (!c || sessions.has(c.session) || keys.has(c.project.key)) continue
    sessions.add(c.session)
    keys.add(c.project.key)
    coordinators.push(c)
  }

  const hosted: StoredHosted[] = []
  const hostedSessions = new Set<string>()
  for (const x of raw.hosted) {
    if (hosted.length >= MAX_HOSTED) break
    const h = parseHosted(x)
    if (!h || hostedSessions.has(h.session)) continue
    hostedSessions.add(h.session)
    hosted.push(h)
  }
  return { coordinators, hosted }
}

/** The coordinators on this device, the sessions attached to them, and the tasks this device's sessions were given. */
export class CoordinatorStore {
  readonly path: string
  private readonly coords = new Map<string, StoredCoordinator>()
  private readonly hostedBySession = new Map<string, StoredHosted>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  /** false when a file that could not be read could not be moved aside either: it is never written over */
  private writable = true

  constructor(dir: string, private readonly opts: CoordinatorStoreOptions = {}) {
    this.path = join(dir, 'coordinators.json')
    this.load()
  }

  coordinators(): StoredCoordinator[] {
    return [...this.coords.values()].map((c) => structuredClone(c))
  }

  coordinator(session: string): StoredCoordinator | null {
    const c = this.coords.get(session)
    return c ? structuredClone(c) : null
  }

  coordinatorOf(projectKey: string): StoredCoordinator | null {
    for (const c of this.coords.values()) if (c.project.key === projectKey) return structuredClone(c)
    return null
  }

  hosted(session: string): StoredHosted | null {
    const h = this.hostedBySession.get(session)
    return h ? structuredClone(h) : null
  }

  allHosted(): StoredHosted[] {
    return [...this.hostedBySession.values()].map((h) => structuredClone(h))
  }

  /** stores a copy of the coordinator, in place of the one with the same session */
  putCoordinator(c: StoredCoordinator): void {
    this.coords.set(c.session, structuredClone(c))
    this.changed()
  }

  removeCoordinator(session: string): void {
    this.coords.delete(session)
    this.changed()
  }

  /** stores a copy of the hosted session, in place of the one with the same session */
  putHosted(h: StoredHosted): void {
    this.hostedBySession.set(h.session, structuredClone(h))
    this.changed()
  }

  removeHosted(session: string): void {
    this.hostedBySession.delete(session)
    this.changed()
  }

  /** a tab's conversation took a new id: every place it is named on this device follows (see Step 3) */
  renameSession(from: string, to: string): boolean {
    if (from === to) return false
    let changed = false
    const coords = [...this.coords.values()]
    this.coords.clear()
    for (const c of coords) {
      if (c.session === from) {
        c.session = to
        changed = true
      }
      for (const a of c.attachments) {
        if (a.device === null && a.session === from) {
          a.session = to
          changed = true
        }
      }
      this.coords.set(c.session, c)
    }
    const hosted = [...this.hostedBySession.values()]
    this.hostedBySession.clear()
    for (const h of hosted) {
      if (h.session === from) {
        h.session = to
        changed = true
      }
      if (h.coordinator.device === null && h.coordinator.session === from) {
        h.coordinator.session = to
        changed = true
      }
      for (const t of h.tasks) {
        if (t.from.device === null && t.from.session === from) {
          t.from.session = to
          changed = true
        }
      }
      this.hostedBySession.set(h.session, h)
    }
    if (changed) this.changed()
    return changed
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty || !this.writable) return
    this.dirty = false
    const data: CoordinatorData = { coordinators: [...this.coords.values()], hosted: [...this.hostedBySession.values()] }
    const tmp = `${this.path}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, ...data }, null, 2), 'utf8')
      renameSync(tmp, this.path)
    } catch (e) {
      this.opts.onError?.(`cannot save ${this.path}: ${(e as Error).message}`)
    }
  }

  private changed(): void {
    this.dirty = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.opts.debounceMs ?? 500)
  }

  private load(): void {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      this.opts.onError?.(`cannot read ${this.path}: ${(e as Error).message}`)
      this.moveAside()
      return
    }
    const parsed = parseCoordinators(text)
    if (!parsed) {
      this.moveAside()
      return
    }
    for (const c of parsed.coordinators) this.coords.set(c.session, c)
    for (const h of parsed.hosted) this.hostedBySession.set(h.session, h)
  }

  /** a file that is not coordinators is kept beside the new one, never written over; the store starts empty */
  private moveAside(): void {
    const aside = `${this.path}.corrupt-${Date.now()}`
    try {
      renameSync(this.path, aside)
      this.opts.warn?.(`Coordinators could not be read; the file was kept as ${basename(aside)}`)
    } catch (e) {
      this.writable = false
      this.opts.onError?.(`cannot move ${this.path} aside: ${(e as Error).message}`)
      this.opts.warn?.(`Coordinators could not be read and are not being saved this run: ${this.path}`)
    }
  }
}
