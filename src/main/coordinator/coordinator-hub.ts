import type { CoordGroup, CoordMarks, CoordOp, CoordResult, CoordSessionRow, CoordTaskInfo, CoordinatorView } from '../../shared/coordinator'
import { COORD_TASK_MAX } from '../../shared/coordinator'
import { isSignal, kindOf, type MailAddress, type MailRecord } from '../../shared/mail'
import type { PipeResponse } from '../../shared/protocol'
import type { TabView } from '../../shared/chat'
import type { TaskList } from '../../shared/task-list'
import type { OpenTabRequest, PlanStatus } from '../../shared/types'
import type { Logger } from '../log'
import { refOf, replaceControls, resolveAgent, type Agent } from '../mail/agent-directory'
import { checkMailRecord } from '../mail/mail-record'
import type { HandOver } from '../mail/mail-hub'
import type { MailStore } from '../mail/mail-store'
import type { TabWaitsState } from '../tab-waits'
import { findRow, rowState } from './session-state'
import { listText, readText } from './session-text'
import {
  MAX_ATTACHMENTS,
  MAX_COORDINATORS,
  MAX_HOSTED,
  MAX_TASKS_PER_SESSION,
  type CoordinatorStore,
  type StoredAttachment,
  type StoredCoordinator,
  type StoredHosted
} from './coordinator-store'
import { currentTask, nextTask } from './task-machine'

/** a Claude tab of this device, as the hub needs it */
export interface HubTab {
  tabId: string
  session: string | null
  account: string | null
  folder: string
  exited: boolean
  working: boolean // TabInfo.activity === 'working'
  view: TabView | null
  project: { key: string; name: string } | null // TabPlace.project; null outside git or not known yet
  branch: string | null
}

export interface CoordinatorHubDeps {
  store: CoordinatorStore
  mail: MailStore
  self(): string | null // this device's id; null on a device never paired
  selfName(): string
  problem(): string | null // coordinatorProblem(...) now
  tabs(): HubTab[] // this device's Claude tabs
  agents(): Agent[] // agentsNow(): names and refs of every agent
  waits(tabId: string): TabWaitsState
  progress(tabId: string): PlanStatus | null // TaskListHub.status
  taskList(tabId: string): TaskList | null // TaskListHub.get
  restingNow(tabId: string): boolean // Task 7
  isDirectory(path: string): Promise<boolean> // Task 8
  accountLabel(account: string | null): string // Task 8
  openTab(req: OpenTabRequest): string | null // Task 8: the new tab's id, opened behind the tab in front
  recheckMail(): void // MailHub.tabsChanged
  poke(tabId: string): void // PromptDelivery.poke
  alias(oldSession: string, newSession: string): void // MailHub.alias: queued records to the old id still reach the session
  changed(): void // views and marks may have changed
  clock(ms: number): string // HH:MM
  now(): number
  later(ms: number, fn: () => void): () => void // a timer; the function cancels it
  newId(): string
  log: Pick<Logger, 'info' | 'warn'>
}

/** the project name as a record or the store keeps it: one line, at most 200 UTF-16 units */
const PROJECT_NAME_MAX = 200

/** a record the hub writes: its version, id, time and flags are set by write() */
type RecordInput = Omit<MailRecord, 'v' | 'id' | 'sentAt' | 'delivered' | 'read'> & { delivered?: boolean; read?: boolean }

export const HUB_TEXT = {
  notCoordinator: "This tab is not a coordinator. The person makes a Claude tab the coordinator of its project from the tab's context menu: Make project coordinator.",
  notClaude: 'Only a Claude tab with a session can coordinate.',
  noProject: 'Only a tab in a git project can coordinate.',
  made: (project: string) => `This tab is now the coordinator of ${project}.`,
  already: (project: string) => `This tab is already the coordinator of ${project}.`,
  taken: (project: string, name: string) => `The ${project} project already has a coordinator: ${name}.`,
  replaced: (project: string, old: string, n: number) => `This tab is now the coordinator of ${project}; ${n} session${n === 1 ? '' : 's'} moved from ${old}.`,
  stopped: (project: string, n: number) => `Stopped coordinating ${project}; ${n} session${n === 1 ? '' : 's'} detached.`,
  self: 'A coordinator cannot attach itself.',
  remote: (name: string) => `${name} runs on another device; sessions on other devices cannot be attached yet.`,
  isCoordinator: (name: string) => `${name} is a coordinator itself.`,
  elsewhere: (name: string, project: string, coordinator: string) =>
    `${name} is attached to the ${project} coordinator (${coordinator}); it must be detached there first.`,
  alreadyAttached: (name: string) => `${name} is already attached.`,
  attached: (name: string, ref: string) => `Attached ${name} [${ref}]. It is not told and goes on as it is; give it a task with message_session.`,
  detached: (name: string, dropped: boolean) => (dropped ? `Detached ${name}; its open task was dropped.` : `Detached ${name}.`),
  noText: 'A task needs a text.',
  tooLong: `A task is at most ${COORD_TASK_MAX} characters.`,
  tooMany: (name: string) => `${name} holds ${MAX_TASKS_PER_SESSION} tasks already; wait for its reports.`,
  starting: (name: string) => `${name} is still starting; its first task is already waiting.`,
  queued: (name: string, ref: string) =>
    `Task given to ${name} [${ref}]. It reaches the session when the session is idle, as the user's instruction through you; its report comes to you by itself when its turn on it ends.`,
  resolved: (name: string) => `Marked ${name} resolved.`,
  attachText: (project: string) => `Attached to the ${project} coordinator.`,
  detachText: (project: string) => `Detached from the ${project} coordinator.`,
  fullCoordinators: `This device has ${MAX_COORDINATORS} coordinators already, the most it keeps; stop one first.`,
  fullAttached: `This coordinator has ${MAX_ATTACHMENTS} sessions attached already, the most it keeps; detach one first.`,
  fullHosted: `This device has ${MAX_HOSTED} attached sessions already, the most it keeps; detach one first.`,
  notSaved: 'ClaudeTerm could not save this; nothing was changed.'
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

/** the project name as records and the store keep it: control characters become spaces, at most 200 UTF-16 units */
function projectText(name: string): string {
  let text = replaceControls(name).slice(0, PROJECT_NAME_MAX)
  // a cut between the two halves of a surrogate pair leaves a lone high surrogate: drop it too
  const last = text.charCodeAt(text.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1)
  return text
}

/**
 * The coordinators of this device: a Claude tab that coordinates its project, the sessions attached to it, the tasks
 * they give those sessions over agent mail, and the coordinator's view of them. Event-driven: no timers of its own.
 */
export class CoordinatorHub {
  /** the last session each tab of this device had, also after the tab closed */
  private readonly sessions = new Map<string, string | null>()
  /** a tab's session before its last change to another id, until sessionStarted takes it */
  private readonly renamedFrom = new Map<string, string>()
  /** each row's group and line, and when they last changed, per coordinator and row key */
  private readonly seen = new Map<string, { group: CoordGroup; line: string; changedAt: number }>()
  private readonly unsubscribe: () => void

  constructor(private readonly d: CoordinatorHubDeps) {
    this.unsubscribe = d.mail.onChange((changed) => this.mailChanged(changed))
  }

  isCoordinator(tabId: string): boolean {
    return this.own(tabId) !== null
  }

  make(tabId: string, replace: boolean): CoordResult {
    const tab = this.d.tabs().find((t) => t.tabId === tabId)
    if (!tab || tab.session === null) return fail(HUB_TEXT.notClaude)
    if (!tab.project) return fail(HUB_TEXT.noProject)
    const session = tab.session
    const project = { key: tab.project.key, name: projectText(tab.project.name) }
    if (this.d.store.coordinator(session)) return { ok: true, info: HUB_TEXT.already(project.name) }

    const other = this.d.store.coordinatorOf(project.key)
    const otherName = other ? this.nameOf(other.session) : ''
    if (other && !replace) return { ok: false, error: HUB_TEXT.taken(project.name, otherName), replaces: otherName }
    if (!other && this.d.store.coordinators().length >= MAX_COORDINATORS) return fail(HUB_TEXT.fullCoordinators)

    // a session attached to another coordinator is detached from it first
    const hostedHere = this.d.store.hosted(session)
    if (hostedHere) {
      this.write(this.detachRecord(hostedHere.coordinator.session, session, hostedHere.project))
      this.unhost(session)
      this.unattach(hostedHere.coordinator.session, session)
    }

    // the replaced coordinator's sessions and hosted entries move to the new one; its tasks keep their senders
    const moved = other ? (this.d.store.coordinator(other.session)?.attachments ?? []).filter((a) => a.session !== session) : []
    if (other) {
      this.d.store.removeCoordinator(other.session)
      for (const h of this.d.store.allHosted()) {
        if (h.coordinator.device === null && h.coordinator.session === other.session) {
          this.d.store.putHosted({ ...h, coordinator: this.stored(this.address(null, session)) })
        }
      }
    }
    this.d.store.putCoordinator({ session, project, since: this.d.now(), attachments: moved })
    for (const a of moved) {
      this.write({ kind: 'attach', from: this.address(null, session), to: this.address(null, a.session), replyTo: null, text: HUB_TEXT.attachText(project.name), project: project.name, delivered: true, read: true })
    }
    this.d.changed()
    return other ? { ok: true, info: HUB_TEXT.replaced(project.name, otherName, moved.length) } : { ok: true, info: HUB_TEXT.made(project.name) }
  }

  stop(tabId: string): CoordResult {
    const c = this.own(tabId)
    if (!c) return fail(HUB_TEXT.notCoordinator)
    this.end(c)
    return { ok: true, info: HUB_TEXT.stopped(c.project.name, c.attachments.length) }
  }

  async tool(tabId: string, op: CoordOp): Promise<PipeResponse> {
    if (!this.isCoordinator(tabId)) return fail(HUB_TEXT.notCoordinator)
    switch (op.op) {
      case 'list':
        return this.list(tabId)
      case 'read':
        return this.read(tabId, op.session)
      case 'attach':
        return this.attach(tabId, op.session)
      case 'detach':
        return this.detach(tabId, op.session)
      case 'message':
        return this.message(tabId, op.session, op.text)
      case 'resolve':
        return this.resolve(tabId, op.session)
      default:
        return fail('unknown operation')
    }
  }

  list(tabId: string): PipeResponse {
    const c = this.own(tabId)
    if (!c) return fail(HUB_TEXT.notCoordinator)
    return { ok: true, info: listText(this.viewOf(c, tabId), (ms) => this.d.clock(ms)) }
  }

  read(tabId: string, target: string): PipeResponse {
    const c = this.own(tabId)
    if (!c) return fail(HUB_TEXT.notCoordinator)
    const v = this.viewOf(c, tabId)
    const found = findRow([...v.sessions, ...v.notAttached], target)
    if ('error' in found) return fail(found.error)
    const row = found.row
    const reportText = row.lastReport ? (this.d.mail.get(row.lastReport.id)?.text ?? null) : null
    return {
      ok: true,
      info: readText(
        row,
        { prompt: row.tabId ? this.d.waits(row.tabId).prompt : null, report: reportText, taskList: row.tabId ? this.d.taskList(row.tabId) : null },
        (ms) => this.d.clock(ms)
      )
    }
  }

  attach(tabId: string, target: string): PipeResponse {
    const c = this.own(tabId)
    if (!c) return fail(HUB_TEXT.notCoordinator)
    const problem = this.d.problem()
    if (problem !== null) return fail(problem)
    const resolved = resolveAgent(target, this.d.agents(), [])
    if (!resolved.ok) return fail(resolved.error)
    return this.attachTo(c, resolved.to)
  }

  /** attaches the session a tab of this device runs */
  attachTab(tabId: string, sessionTabId: string): PipeResponse {
    const c = this.own(tabId)
    if (!c) return fail(HUB_TEXT.notCoordinator)
    const problem = this.d.problem()
    if (problem !== null) return fail(problem)
    const agent = this.d.agents().find((a) => a.tabId === sessionTabId)
    if (!agent) return fail(HUB_TEXT.notClaude)
    return this.attachTo(c, { device: agent.device, session: agent.session, name: agent.name })
  }

  detach(tabId: string, target: string): PipeResponse {
    const c = this.own(tabId)
    if (!c) return fail(HUB_TEXT.notCoordinator)
    const found = this.attachedFind(c, target)
    if ('error' in found) return fail(found.error)
    const { att, row } = found
    if (this.write(this.detachRecord(c.session, att.session, c.project.name)) === null) return fail(HUB_TEXT.notSaved)
    const dropped = this.unhost(att.session) > 0
    this.unattach(c.session, att.session)
    this.d.changed()
    return { ok: true, info: HUB_TEXT.detached(row.name, dropped) }
  }

  message(tabId: string, target: string, text: string): PipeResponse {
    const c = this.own(tabId)
    if (!c) return fail(HUB_TEXT.notCoordinator)
    const problem = this.d.problem()
    if (problem !== null) return fail(problem)
    if (text.trim() === '') return fail(HUB_TEXT.noText)
    if (text.length > COORD_TASK_MAX) return fail(HUB_TEXT.tooLong)
    const found = this.attachedFind(c, target)
    if ('error' in found) return fail(found.error)
    const { att, row } = found
    if (row.marker === 'starting') return fail(HUB_TEXT.starting(row.name))
    const hosted = this.d.store.hosted(att.session)
    if (!hosted) {
      this.d.log.warn(`coordinator: ${row.name} is attached without its hosted entry; the task is not given`)
      return fail(HUB_TEXT.notSaved)
    }
    if (hosted.tasks.length >= MAX_TASKS_PER_SESSION) return fail(HUB_TEXT.tooMany(row.name))
    // the record goes first: the mail listener takes the task into the hosted entry
    const written = this.write({
      kind: 'task',
      from: this.address(null, c.session),
      to: this.address(null, att.session),
      replyTo: null,
      text,
      project: c.project.name,
      delivered: false,
      read: false
    })
    if (written === null) return fail(HUB_TEXT.notSaved)
    this.patchAttachment(c, att.session, { resolved: false, failed: false })
    this.d.changed()
    return { ok: true, info: HUB_TEXT.queued(row.name, refOf(att.session)) }
  }

  resolve(tabId: string, target: string): PipeResponse {
    const c = this.own(tabId)
    if (!c) return fail(HUB_TEXT.notCoordinator)
    const found = this.attachedFind(c, target)
    if ('error' in found) return fail(found.error)
    this.patchAttachment(c, found.att.session, { resolved: true, failed: false })
    this.d.changed()
    return { ok: true, info: HUB_TEXT.resolved(found.row.name) }
  }

  /** whether a mail record may be handed to the tab over this hand-over */
  accepts(r: MailRecord, tabId: string, into: HandOver): boolean {
    if (isSignal(r)) return false
    const kind = kindOf(r)
    if (kind === 'task') {
      if (into !== 'idle' && into !== 'prompt') return false
      const session = this.sessionOfTab(tabId)
      const hosted = session === null ? null : this.d.store.hosted(session)
      if (!hosted) return false
      const held = hosted.tasks.find((t) => t.id === r.id)
      return held?.state === 'queued' && nextTask(hosted)?.id === r.id
    }
    if (kind === 'report' && r.outcome === 'stopped') return into === 'running'
    // a prompt carries a report, never a plain message
    if (into === 'prompt') return kind === 'report'
    return true
  }

  /** the session a tab of this device runs now; the hub follows the tab's changes through tabSession and sessionStarted */
  tabSession(tabId: string, session: string | null): void {
    const before = this.sessions.get(tabId) ?? null
    if (before !== null && session !== null && before !== session) this.renamedFrom.set(tabId, before)
    this.sessions.set(tabId, session)
  }

  /** a tab's conversation started under a session id; clear, compact and resume move the coordinator and its sessions to it */
  sessionStarted(tabId: string, before: string | null, after: string, source: string): void {
    const remembered = this.renamedFrom.get(tabId) ?? null
    this.renamedFrom.delete(tabId)
    this.sessions.set(tabId, after)
    // the design names clear and compact; resume is needed too, for a restored tab that resumes under a new id
    if (source !== 'clear' && source !== 'compact' && source !== 'resume') return
    const old = before !== null && before !== after ? before : remembered
    if (old === null || old === after) return
    this.d.store.renameSession(old, after)
    this.d.alias(old, after)
    this.d.changed()
  }

  /** the tab was closed on purpose: a coordinator's tab stops its coordinator */
  tabClosed(tabId: string): void {
    this.renamedFrom.delete(tabId)
    const session = this.sessionOfTab(tabId)
    const c = session === null ? null : this.d.store.coordinator(session)
    if (c) this.end(c)
  }

  view(tabId: string): CoordinatorView | null {
    const c = this.own(tabId)
    return c ? this.viewOf(c, tabId) : null
  }

  marks(): CoordMarks {
    const marks: CoordMarks = {}
    for (const c of this.d.store.coordinators()) {
      const tab = this.tabOfSession(c.session)
      if (!tab) continue
      const v = this.viewOf(c, tab.tabId)
      marks[tab.tabId] = { role: 'coordinator', project: c.project.name, sessions: v.sessions.length, waiting: v.waiting }
    }
    for (const h of this.d.store.allHosted()) {
      const tab = this.tabOfSession(h.session)
      if (!tab) continue
      const coordinator = h.coordinator.device === null ? this.tabOfSession(h.coordinator.session) : null
      marks[tab.tabId] = { role: 'attached', project: h.project, coordinator: h.coordinator.name, coordinatorTabId: coordinator?.tabId ?? null }
    }
    return marks
  }

  dispose(): void {
    this.unsubscribe()
  }

  /** the coordinator a tab runs, or null */
  private own(tabId: string): StoredCoordinator | null {
    const session = this.sessionOfTab(tabId)
    return session === null ? null : this.d.store.coordinator(session)
  }

  /** a session is attached to this coordinator: the hosted entry, the attachment and the tasks given go; a detach record says so */
  private attachTo(c: StoredCoordinator, to: MailAddress): PipeResponse {
    const session = to.session
    const name = to.name
    if (session === c.session) return fail(HUB_TEXT.self)
    if (this.norm(to.device) !== null) return fail(HUB_TEXT.remote(name))
    if (this.d.store.coordinator(session)) return fail(HUB_TEXT.isCoordinator(name))
    const hosted = this.d.store.hosted(session)
    if (c.attachments.some((a) => a.session === session) || (hosted?.coordinator.device === null && hosted.coordinator.session === c.session)) {
      return { ok: true, info: HUB_TEXT.alreadyAttached(name) }
    }
    if (hosted) return fail(HUB_TEXT.elsewhere(name, hosted.project, hosted.coordinator.name))
    if (c.attachments.length >= MAX_ATTACHMENTS) return fail(HUB_TEXT.fullAttached)
    if (this.d.store.allHosted().length >= MAX_HOSTED) return fail(HUB_TEXT.fullHosted)

    const project = c.project.name
    const written = this.write({
      kind: 'attach',
      from: this.address(null, c.session),
      to: this.address(null, session),
      replyTo: null,
      text: HUB_TEXT.attachText(project),
      project,
      delivered: true,
      read: true
    })
    if (written === null) return fail(HUB_TEXT.notSaved)
    const attachment: StoredAttachment = { device: null, session, name, attachedAt: this.d.now(), resolved: false, failed: false, lastReport: null }
    this.d.store.putCoordinator({ ...c, attachments: [...c.attachments, attachment] })
    this.d.store.putHosted({ session, coordinator: this.stored(this.address(null, c.session)), project, tasks: [] })
    this.d.changed()
    return { ok: true, info: HUB_TEXT.attached(name, refOf(session)) }
  }

  /** the coordinator is gone: each session is detached as detach does it, and the coordinator is removed */
  private end(c: StoredCoordinator): void {
    for (const a of c.attachments) {
      this.write(this.detachRecord(c.session, a.session, c.project.name))
      this.unhost(a.session)
    }
    for (const h of this.d.store.allHosted()) {
      if (h.coordinator.device === null && h.coordinator.session === c.session) this.unhost(h.session)
    }
    this.d.store.removeCoordinator(c.session)
    this.d.changed()
  }

  /** the hosted entry of a session goes, with its tasks; a task never handed over is marked delivered and read, so it stays no unread mark */
  private unhost(session: string): number {
    const hosted = this.d.store.hosted(session)
    if (!hosted) return 0
    this.d.store.removeHosted(session)
    const queued = hosted.tasks.filter((t) => t.state === 'queued').map((t) => t.id)
    if (queued.length > 0) {
      this.d.mail.mark(queued, 'delivered')
      this.d.mail.mark(queued, 'read')
    }
    return hosted.tasks.length
  }

  /** the attachment of a session goes from its coordinator */
  private unattach(coordinator: string, session: string): void {
    const c = this.d.store.coordinator(coordinator)
    if (!c) return
    this.d.store.putCoordinator({ ...c, attachments: c.attachments.filter((a) => a.session !== session) })
  }

  private patchAttachment(c: StoredCoordinator, session: string, patch: Partial<StoredAttachment>): void {
    this.d.store.putCoordinator({ ...c, attachments: c.attachments.map((a) => (a.session === session ? { ...a, ...patch } : a)) })
  }

  private detachRecord(from: string, to: string, project: string): RecordInput {
    return {
      kind: 'detach',
      from: this.address(null, from),
      to: this.address(null, to),
      replyTo: null,
      text: HUB_TEXT.detachText(project),
      delivered: true,
      read: true
    }
  }

  /** the rows of a coordinator's attachments, in the order it has them */
  private attachedRows(c: StoredCoordinator): CoordSessionRow[] {
    return c.attachments.map((a) => this.rowOf(a.session, this.agentName(a.session) ?? a.name, this.tabOfSession(a.session), this.d.store.hosted(a.session), a))
  }

  /** the attached row a target names, with its attachment */
  private attachedFind(c: StoredCoordinator, target: string): { att: StoredAttachment; row: CoordSessionRow } | { error: string } {
    const rows = this.attachedRows(c)
    const found = findRow(rows, target)
    if ('error' in found) return found
    return { att: c.attachments[rows.indexOf(found.row)], row: found.row }
  }

  /** a row of a session: its tab's facts, its hosted entry's task, and its attachment's report and marks */
  private rowOf(session: string, name: string, tab: HubTab | null, hosted: StoredHosted | null, att: StoredAttachment | null): CoordSessionRow {
    const tabId = tab?.tabId ?? null
    const waits: TabWaitsState = tabId === null ? { prompt: null, limit: null } : this.d.waits(tabId)
    const task: CoordTaskInfo | null = hosted ? this.taskInfo(hosted) : null
    const state = rowState(
      {
        marker: null,
        closed: tab === null,
        exited: tab?.exited ?? false,
        working: tab?.working ?? false,
        prompt: waits.prompt,
        limit: waits.limit,
        progress: tabId === null ? null : this.d.progress(tabId),
        task,
        resolved: att?.resolved ?? false,
        failed: att?.failed ?? false,
        lastReport: att?.lastReport ?? null
      },
      this.d.clock
    )
    return {
      key: `local:${session}`,
      tabId,
      device: null,
      deviceName: null,
      session,
      ref: refOf(session),
      name,
      folder: tab?.folder ?? null,
      branch: tab?.branch ?? null,
      group: state.group,
      why: state.why,
      marker: null,
      line: state.line,
      progress: state.progress,
      changedAt: this.d.now(),
      task,
      lastReport: att?.lastReport ?? null,
      attachedTo: null
    }
  }

  private viewOf(c: StoredCoordinator, tabId: string): CoordinatorView {
    const sessions = this.attachedRows(c)
    const attached = new Set(c.attachments.map((a) => a.session))
    const tabs = this.d.tabs()
    const notAttached: CoordSessionRow[] = []
    for (const agent of this.d.agents()) {
      if (this.norm(agent.device) !== null || agent.session === c.session || attached.has(agent.session)) continue
      const tab = tabs.find((t) => t.tabId === agent.tabId)
      if (!tab || tab.project?.key !== c.project.key) continue
      const hosted = this.d.store.hosted(agent.session)
      const row = this.rowOf(agent.session, agent.name, tab, hosted, null)
      row.attachedTo = hosted ? replaceControls(hosted.coordinator.name) : null
      notAttached.push(row)
    }
    this.stamp(c.session, [...sessions, ...notAttached])
    return {
      tabId,
      session: c.session,
      project: c.project,
      problem: this.d.problem(),
      sessions,
      notAttached,
      waiting: sessions.filter((r) => r.group === 'waiting').length
    }
  }

  /** each row's change time: now when its group or line differs from the last view's, else that view's */
  private stamp(coordinator: string, rows: CoordSessionRow[]): void {
    const now = this.d.now()
    for (const r of rows) {
      const key = `${coordinator}\n${r.key}`
      const prev = this.seen.get(key)
      const changedAt = prev && prev.group === r.group && prev.line === r.line ? prev.changedAt : now
      this.seen.set(key, { group: r.group, line: r.line, changedAt })
      r.changedAt = changedAt
    }
  }

  private taskInfo(h: StoredHosted): CoordTaskInfo | null {
    const t = currentTask(h) ?? nextTask(h)
    return t ? { id: t.id, state: t.state, since: t.deliveredAt ?? t.queuedAt } : null
  }

  /** the mail that arrived: a task given to a session of this device by its hosted coordinator is taken into the hosted entry */
  private mailChanged(changed: MailRecord[]): void {
    let taken = false
    for (const r of changed) {
      if (kindOf(r) !== 'task' || r.delivered || this.norm(r.to.device) !== null) continue
      const hosted = this.d.store.hosted(r.to.session)
      if (!hosted || hosted.tasks.some((t) => t.id === r.id)) continue
      if (this.norm(r.from.device) !== hosted.coordinator.device || r.from.session !== hosted.coordinator.session) continue
      if (hosted.tasks.length >= MAX_TASKS_PER_SESSION) continue
      const from: MailAddress = { device: this.norm(r.from.device), session: r.from.session, name: r.from.name }
      this.d.store.putHosted({ ...hosted, tasks: [...hosted.tasks, { id: r.id, from, state: 'queued', queuedAt: r.sentAt, deliveredAt: null }] })
      taken = true
      const tab = this.tabOfSession(hosted.session)
      if (tab) this.d.poke(tab.tabId)
    }
    if (taken) {
      this.d.recheckMail()
      this.d.changed()
    }
  }

  /** writes a record the hub makes: null when the mail check refuses it, and the reason is logged */
  private write(r: RecordInput): string | null {
    const record = checkMailRecord({ v: 1, id: this.d.newId(), sentAt: this.d.now(), delivered: false, read: false, ...r })
    if (record === null) {
      this.d.log.warn(`coordinator: a ${kindOf(r)} record for ${r.to.session} was refused by the mail check`)
      return null
    }
    this.d.mail.add(record)
    return record.id
  }

  /** the session a tab ran last, also after the tab closed */
  private sessionOfTab(tabId: string): string | null {
    return this.sessions.get(tabId) ?? null
  }

  /** the tab of this device that runs a session: a running one before one that has exited */
  private tabOfSession(session: string): HubTab | null {
    const tabs = this.d.tabs().filter((t) => t.session === session)
    return tabs.find((t) => !t.exited) ?? tabs[0] ?? null
  }

  /** the local agent's name of a session, when a tab of this device runs it */
  private agentName(session: string): string | null {
    return this.d.agents().find((a) => a.session === session && this.norm(a.device) === null)?.name ?? null
  }

  /** a session's name: its agent's name, else the name the store keeps for it, else its ref */
  private nameOf(session: string): string {
    const name = this.agentName(session) ?? this.storedName(session)
    return name ?? `session ${refOf(session)}`
  }

  private storedName(session: string): string | null {
    for (const h of this.d.store.allHosted()) if (h.coordinator.session === session) return h.coordinator.name
    for (const c of this.d.store.coordinators()) {
      const a = c.attachments.find((x) => x.session === session)
      if (a) return a.name
    }
    return null
  }

  /** the address of a session on a device: device null is this device, which the record carries as its own id */
  private address(device: string | null, session: string): MailAddress {
    return { device: device ?? this.d.self(), session, name: this.nameOf(session) }
  }

  private isThisDevice(device: string | null): boolean {
    return device === null || device === this.d.self()
  }

  /** the device of an address as the store keeps it: this device is null */
  private norm(device: string | null): string | null {
    return this.isThisDevice(device) ? null : device
  }

  private stored(a: MailAddress): MailAddress {
    return { device: this.norm(a.device), session: a.session, name: a.name }
  }
}
