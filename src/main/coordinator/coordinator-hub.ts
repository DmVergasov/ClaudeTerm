import type { CoordGroup, CoordMarker, CoordMarks, CoordOp, CoordResult, CoordSessionRow, CoordStartRequest, CoordTaskInfo, CoordinatorView } from '../../shared/coordinator'
import { COORD_TASK_MAX } from '../../shared/coordinator'
import { isSignal, kindOf, MAIL_MIN_CLAUDE, type MailAddress, type MailRecord, type ReportOutcome } from '../../shared/mail'
import { isUuid, oneLineText, PROMPT_TEXT_MAX, type PipeResponse } from '../../shared/protocol'
import { COORD_FACT_TEXT_MAX, type RemoteCoordFacts } from '../../shared/remote'
import type { TabView } from '../../shared/chat'
import type { TaskList } from '../../shared/task-list'
import type { OpenTabRequest, PlanStatus } from '../../shared/types'
import type { Logger } from '../log'
import { refOf, replaceControls, resolveAgent, type Agent } from '../mail/agent-directory'
import { checkMailRecord } from '../mail/mail-record'
import type { HandOver } from '../mail/mail-hub'
import type { MailStore } from '../mail/mail-store'
import type { TabWaitsState } from '../tab-waits'
import { LIMIT_ERROR } from '../auto-continue'
import { findRow, rowState } from './session-state'
import { listText, readText, roleBlock, roleNoteText, turnNoteText } from './session-text'
import {
  MAX_ATTACHMENTS,
  MAX_COORDINATORS,
  MAX_FORMER,
  MAX_HOSTED,
  MAX_TASKS_PER_SESSION,
  type CoordinatorStore,
  type StoredAttachment,
  type StoredCoordinator,
  type StoredHosted,
  type StoredTask
} from './coordinator-store'
import { remoteFolderText } from './remote-start'
import { progressText, REASONS, reportText } from './report-text'
import { currentTask, nextTask, stepTask, type TaskEvent } from './task-machine'

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

/** a paired device as the coordinator needs it */
export interface HubPeer {
  id: string
  name: string
  online: boolean // linked now
  listed: boolean // its tab list has come on the current link
  coord: boolean // its hello says it knows coordinator records
  mail: boolean // it takes agent mail and its mail watcher wakes a session
}

/** a tab of a paired device, as this window knows it (an offline device's last list included) */
export interface HubRemoteTab {
  device: string
  tabId: string
  claude: boolean
  session: string | null
  name: string | null // its agent name, as list_agents shows it; null without a session
  folder: string
  branch: string | null
  project: string | null // its place's project name
  working: boolean
  exited: boolean
  coord: RemoteCoordFacts | null
}

/** the paired devices and their tabs as one view or the marks reads them: peers by id, and each session's tab (a live one before an exited one) */
interface RemoteSnapshot {
  peers: Map<string, HubPeer>
  tabs: HubRemoteTab[]
  tabByKey: Map<string, HubRemoteTab>
}

/** what a paired device answers to open-tab: the new tab, and where and on which account it opened; or the device's refusal */
export type RemoteOpened = { ok: true; tabId: string; cwd: string; accountName: string; defaulted: boolean } | { ok: false; error: string }

export interface CoordinatorHubDeps {
  store: CoordinatorStore
  mail: MailStore
  self(): string | null // this device's id; null on a device never paired
  selfName(): string
  problem(): string | null // coordinatorProblem(...) now
  tabs(): HubTab[] // this device's Claude tabs
  peers(): HubPeer[] // the paired devices
  remoteTabs(): HubRemoteTab[] // the tabs of the paired devices
  agents(): Agent[] // agentsNow(): names and refs of every agent
  waits(tabId: string): TabWaitsState
  progress(tabId: string): PlanStatus | null // TaskListHub.status
  taskList(tabId: string): TaskList | null // TaskListHub.get
  restingNow(tabId: string): boolean // Task 7
  isDirectory(path: string): Promise<boolean> // Task 8
  isAbsolute(path: string): boolean // node's isAbsolute on this device: a folder asked for here is a path here
  accountLabel(account: string | null): string // Task 8
  openTab(req: OpenTabRequest): string | null // Task 8: the new tab's id, opened behind the tab in front
  openRemoteTab(device: string, req: { cwd: string | null; email: string | null; title: string | null }): Promise<RemoteOpened> // open-tab on a paired device (its id)
  mainFolder(folder: string): Promise<string | null> // the folder of a project's main worktree (mainWorktreeFolder); null: none
  projectName(projectKey: string): string | null // the name a tab's place of this device gives the project, of any kind of tab; null: no tab of it
  openCoordinatorTab(cwd: string, projectKey: string): string | null // opens a Claude tab for the chip's coordinator: its id, or null when it does not open
  activate(tabId: string): void // brings a tab of this device to the front
  accountEmail(account: string | null): string | null // the email of an account of this device (null: Main account); null when not known
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

/** a Stop that comes to rest ends the task this long after it, unless a turn starts meanwhile */
export const REST_SETTLE_MS = 2000

/** how long start_session waits for the new tab's session id before it answers without one */
export const START_WAIT_MS = 20_000

/** how long attach_session waits for the answer of another device: past it, the attachment is still waiting for that device */
export const REMOTE_ATTACH_WAIT_MS = 8000

export const worktreeInstruction = (name: string): string =>
  `First enter a new git worktree named "${name}" with your EnterWorktree tool, and do the task below there.\n\n`

/** a record the hub writes: its version, id, time and flags are set by write() */
type RecordInput = Omit<MailRecord, 'v' | 'id' | 'sentAt' | 'delivered' | 'read'> & { delivered?: boolean; read?: boolean; sentAt?: number }

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
  folderGone: (project: string) => `${project}'s folder is gone, so no coordinator can start there.`,
  fullAttached: `This coordinator has ${MAX_ATTACHMENTS} sessions attached already, the most it keeps; detach one first.`,
  fullHosted: `This device has ${MAX_HOSTED} attached sessions already, the most it keeps; detach one first.`,
  fullHostedThere: (device: string) => `${device} has ${MAX_HOSTED} attached sessions already, the most it keeps; detach one there first.`,
  notSaved: 'ClaudeTerm could not save this; nothing was changed.',
  noDevice: (device: string) => `No paired device named "${device}".`,
  noFolder: (folder: string) => `No folder ${folder} on this device.`,
  openedNoTab: (device: string) => `${device} did not open a new tab; the start is refused.`,
  notOpened: 'The new tab could not be opened.',
  closedEarly: 'The new tab closed before its session started.',
  startCancelled: 'The new session was detached before its session started; it gets no task.',
  stillStarting: (name: string) => `${name} is still starting.`,
  started: (name: string, ref: string, folder: string, account: string) =>
    `Started ${name} [${ref}] in ${folder} on ${account}, attached to you. Its task is its first message; its report comes to you by itself when the task ends.`,
  opening: (name: string, folder: string, account: string) =>
    `Opening ${name} in ${folder} on ${account}. It shows as Starting… until its session starts; its task is sent then.`,
  startedThere: (name: string, ref: string, device: string, place: string, account: string) =>
    `Started ${name} [${ref}] on ${device} ${place}, on ${account}; it is attached to you once ${device} confirms. Its task is its first message; its report comes to you by itself when its task ends.`,
  openingThere: (name: string, device: string, place: string, account: string) =>
    `Opening ${name} on ${device} ${place}, on ${account}. It shows as Starting… until its session starts; its task is sent then.`,
  deviceOffline: (device: string) => `${device} is not connected; its sessions can be attached or started while it is.`,
  oldDevice: (device: string) => `${device} runs a ClaudeTerm that does not know coordinators; update ClaudeTerm there to coordinate its sessions.`,
  noMail: (device: string) => `${device} does not take agent messages now, which coordinating its sessions needs: they are turned off there, or its Claude Code is older than ${MAIL_MIN_CLAUDE}.`,
  attaching: (name: string, ref: string, device: string) =>
    `Attaching ${name} [${ref}]: ${device} has not confirmed it yet, and list_sessions shows it as Attaching… until it does. It is not told and goes on as it is.`,
  notConfirmed: (name: string) => `${name} is not attached yet: its device has not confirmed it.`,
  queuedOffline: (name: string, ref: string, device: string) =>
    `Task given to ${name} [${ref}]. ${device} is not connected: the task goes out when it connects and reaches the session when it is idle; its report comes to you by itself.`,
  detachedPending: (name: string) => `${name} was detached before its device confirmed it.`,
  closedThere: (name: string) => `${name} is not open under this session id on its device: it was closed, or cleared to a new session id.`,
  problemThere: (device: string, problem: string) => `${device} cannot take coordinated sessions now: ${problem}`,
  noProjectGiven: 'The attach request named no project.',
  notAttached: 'This tab is not attached to a coordinator.'
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

/** a session start the hub waits on: its tab is open, and its session id has not come yet */
interface PendingStart {
  tabId: string
  coordinator: string // the coordinator's session
  name: string // the name asked for, else the folder's last part
  folder: string
  account: string | null // a start here: the account its tab opens on
  text: string // the worktree instruction, if one was asked for, and the task
  startedAt: number
  remote: RemoteStart | null // a start on a paired device; null for one on this device
  answer: ((r: PipeResponse) => void) | null // null once answered
  cancelWait: () => void // the START_WAIT_MS timer
}

/** a start on a paired device: where and on which account its tab opened, and whether the device has listed the tab yet */
interface RemoteStart {
  device: string // the device's id
  deviceName: string
  place: string // remoteFolderText: where the session opened
  account: string // the account's name, as the device gives it
  listed: boolean
}

/** a remote attach a tool waits on: answered once, by the outcome of its attach record, or by the attaching answer when the wait is over */
interface AttachWait {
  answer: (r: PipeResponse) => void
  cancelWait: () => void // the REMOTE_ATTACH_WAIT_MS timer
}

/** what an attach answers, and the attach record a remote attach is pending on (null for every other answer) */
interface AttachStep {
  response: PipeResponse
  pending: string | null
}

/** what a row of a coordinator names: an attached session (att) or a Starting… tab (start), never both */
type FoundRow = { row: CoordSessionRow; att: StoredAttachment; start: null } | { row: CoordSessionRow; att: null; start: PendingStart }

/** a folder's last part, the name of a session started without one */
function folderName(folder: string): string {
  return folder.split(/[\\/]/).filter((p) => p !== '').pop() ?? folder
}

/** a row's key for a session of another device */
const remoteKey = (device: string, session: string): string => `${device}:${session}`

/** two names are the same name: trimmed, without case */
const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/** a remote session's task list as a PlanStatus: its counts, and its current task as the one current step */
function planOf(coord: RemoteCoordFacts | null): PlanStatus | null {
  const p = coord?.progress
  if (!p) return null
  return {
    title: '',
    done: p.done,
    total: p.total,
    finished: p.finished,
    tasks: p.current === null ? [] : [{ n: p.done + 1, title: p.current, state: 'current' }]
  }
}

/** the project name as records and the store keep it: control characters become spaces, at most 200 UTF-16 units */
function projectText(name: string): string {
  let text = replaceControls(name).slice(0, PROJECT_NAME_MAX)
  // a cut between the two halves of a surrogate pair leaves a lone high surrogate: drop it too
  const last = text.charCodeAt(text.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1)
  return text
}

/** a chip's coordinator start: the tab it opened, and the answer its caller waits for */
interface PendingMake {
  tabId: string | null // null while the project's main folder is being looked up
  answer: ((r: CoordResult | null) => void) | null // null until the promise exists
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
  /** the tabs that are in a turn now */
  private readonly inTurn = new Set<string>()
  /** the settle timer of each tab whose Stop came to rest: the function cancels it */
  private readonly settle = new Map<string, () => void>()
  /** the last answer of a task's session, by task id: the text of its report */
  private readonly answers = new Map<string, string>()
  /** the sessions being started, by the id of the tab that opened each: a Starting… row until its session id comes */
  private readonly starts = new Map<string, PendingStart>()
  /** the tools waiting for a remote attach to be confirmed, refused or detached, by the id of its attach record */
  private readonly attachWaits = new Map<string, AttachWait>()
  /** the tabs whose role note is due: made a coordinator, or cleared or compacted as one, and not yet handed to it (in memory) */
  private readonly briefDue = new Set<string>()
  /** the chip's coordinator starts, by project key: a tab that becomes the project's coordinator once it has a session and a project */
  private readonly makes = new Map<string, PendingMake>()
  private readonly unsubscribe: () => void

  constructor(private readonly d: CoordinatorHubDeps) {
    this.unsubscribe = d.mail.onChange((changed) => this.mailChanged(changed))
  }

  isCoordinator(tabId: string): boolean {
    return this.own(tabId) !== null
  }

  /**
   * The chip's + Coordinator: a project with a coordinator brings that coordinator's tab to the front; a project with a start
   * brings the starting tab to the front. Otherwise a Claude tab opens in the project's main folder and becomes the coordinator
   * once its session and its project are known; the answer waits for that. `folders` are this device's tab folders in the
   * project, the chip's tab first: the main folder is the first of them git can name, else the first that still exists. When
   * none exists the start is refused and no tab opens. Null: nothing to tell (a tab was brought to the front, or the new tab
   * closed, exited or did not open).
   */
  async startCoordinator(projectKey: string, folders: readonly string[]): Promise<CoordResult | null> {
    const c = this.d.store.coordinatorOf(projectKey)
    if (c) {
      const tab = this.tabOfSession(c.session)
      if (!tab) return fail(HUB_TEXT.taken(c.project.name, this.nameOf(c.session)))
      this.d.activate(tab.tabId)
      return null
    }
    const making = this.makes.get(projectKey)
    if (making) {
      if (making.tabId !== null) this.d.activate(making.tabId)
      return null
    }
    // at the limit the coordinator could not be made: no tab opens for it
    if (this.d.store.coordinators().length >= MAX_COORDINATORS) return fail(HUB_TEXT.fullCoordinators)
    // the start is pending before the first await, so a second click meanwhile finds it
    const entry: PendingMake = { tabId: null, answer: null }
    this.makes.set(projectKey, entry)
    const cwd = await this.startFolder(folders)
    // disposed meanwhile: the start is gone, and no tab opens for it
    if (this.makes.get(projectKey) !== entry) return null
    // no folder of the project is left to open in: the start is refused, and no tab opens
    if (cwd === null) {
      this.makes.delete(projectKey)
      return fail(HUB_TEXT.folderGone(this.projectName(projectKey)))
    }
    const tabId = this.d.openCoordinatorTab(cwd, projectKey)
    if (tabId === null) {
      this.makes.delete(projectKey)
      return null
    }
    entry.tabId = tabId
    return new Promise<CoordResult | null>((resolve) => {
      entry.answer = resolve
      this.settleMake(tabId)
    })
  }

  /**
   * The folder a chip's coordinator opens in: the main folder of the first of `folders` that git names one for; else the first
   * folder that still exists; null when none does. A failed lookup is no answer, so the next folder is asked.
   */
  private async startFolder(folders: readonly string[]): Promise<string | null> {
    for (const folder of folders) {
      const main = await this.d.mainFolder(folder).catch(() => null)
      if (main !== null) return main
    }
    for (const folder of folders) {
      if (await this.d.isDirectory(folder).catch(() => false)) return folder
    }
    return null
  }

  /** the name of a project as this device's places give it; a plain word when none of its tabs is left to give one */
  private projectName(projectKey: string): string {
    const name = this.d.projectName(projectKey)
    return name === null ? 'The project' : projectText(name)
  }

  /** the tab of a chip's coordinator start got its project: its session may have come already, so the start is settled now */
  placeChanged(tabId: string): void {
    this.settleMake(tabId)
  }

  /** a chip's start whose tab has its session and its project makes the tab the coordinator; one whose tab exited answers null */
  private settleMake(tabId: string): void {
    const found = [...this.makes].find(([, m]) => m.tabId === tabId)
    const tab = found ? this.d.tabs().find((t) => t.tabId === tabId) : undefined
    if (!found || !tab) return
    if (tab.exited) return this.endMake(tabId)
    if (tab.session === null || tab.project === null) return
    const [key, entry] = found
    // the tab's place names another project: it stays an ordinary tab, and the start answers null
    if (tab.project.key !== key) return this.endMake(tabId)
    this.makes.delete(key)
    entry.answer?.(this.make(tabId, false))
  }

  /** the tab of a chip's coordinator start is gone or exited before it became a coordinator: the start answers null */
  private endMake(tabId: string): void {
    const found = [...this.makes].find(([, m]) => m.tabId === tabId)
    if (!found) return
    this.makes.delete(found[0])
    found[1].answer?.(null)
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

    // a session attached to another coordinator is detached from it first, as leave detaches it
    if (this.d.store.hosted(session)) this.leave(tabId)

    // the replaced coordinator's sessions and hosted entries move to the new one; its tasks keep their senders
    const moved = other ? (this.d.store.coordinator(other.session)?.attachments ?? []).filter((a) => a.session !== session) : []
    if (other) {
      this.d.store.removeCoordinator(other.session)
      for (const h of this.d.store.allHosted()) {
        if (h.coordinator.device === null && h.coordinator.session === other.session) {
          this.d.store.putHosted({ ...h, coordinator: this.stored(this.address(null, session)) })
        }
      }
      this.moveStarts(other.session, session)
    }
    this.d.store.putCoordinator({ session, project, since: this.d.now(), attachments: moved, former: other ? [other.session, ...other.former].filter((id) => id !== session).slice(0, MAX_FORMER) : [] })
    for (const a of moved) {
      if (a.device === null) {
        this.write({ kind: 'attach', from: this.address(null, session), to: this.address(null, a.session), replyTo: null, text: HUB_TEXT.attachText(project.name), project: project.name, delivered: true, read: true })
      } else if (other) {
        // a session on another device is told that this coordinator replaces the old one; a pending attachment now waits for that attach
        const id = this.write({ kind: 'attach', from: this.address(null, session), to: { device: a.device, session: a.session, name: a.name }, replyTo: null, text: HUB_TEXT.attachText(project.name), project: project.name, replaces: other.session, delivered: false, read: false })
        if (id !== null && a.pending !== null) this.repend(session, a.session, a.pending, id)
      }
    }
    if (other) this.forwardFormer(other.session)
    this.briefDue.add(tabId)
    this.d.recheckMail()
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
        return this.attachAndWait(tabId, op.session)
      case 'detach':
        return this.detach(tabId, op.session)
      case 'message':
        return this.message(tabId, op.session, op.text)
      case 'resolve':
        return this.resolve(tabId, op.session)
      case 'start':
        return this.start(tabId, op)
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
    const snap = this.remoteSnapshot()
    const v = this.viewOf(c, tabId, snap)
    const found = findRow([...v.sessions, ...v.notAttached], target)
    if ('error' in found) return fail(found.error)
    const row = found.row
    const reportText = row.lastReport ? (this.d.mail.get(row.lastReport.id)?.text ?? null) : null
    // a session of another device: its prompt is what its device reports, and its task list is not read here
    if (row.device !== null) {
      const prompt = row.session === null ? null : (snap.tabByKey.get(remoteKey(row.device, row.session))?.coord?.prompt ?? null)
      return { ok: true, info: readText(row, { prompt, report: reportText, taskList: null }, (ms) => this.d.clock(ms)) }
    }
    return {
      ok: true,
      info: readText(
        row,
        { prompt: row.tabId ? this.d.waits(row.tabId).prompt : null, report: reportText, taskList: row.tabId ? this.d.taskList(row.tabId) : null },
        (ms) => this.d.clock(ms)
      )
    }
  }

  /** starts a new Claude tab: on this device, or on the paired device named; its task is given when its session id comes, and the answer waits for that, or for START_WAIT_MS */
  async start(tabId: string, req: CoordStartRequest): Promise<PipeResponse> {
    const began = this.d.now()
    if (!this.isCoordinator(tabId)) return fail(HUB_TEXT.notCoordinator)
    const problem = this.d.problem()
    if (problem !== null) return fail(problem)
    if (req.task.trim() === '') return fail(HUB_TEXT.noText)
    if (req.task.length > COORD_TASK_MAX) return fail(HUB_TEXT.tooLong)
    if (req.device === null || sameName(req.device, this.d.selfName())) return this.startHere(tabId, req)
    return this.startOnPeer(tabId, req, req.device, began)
  }

  /** a start on this device: its tab opens in the folder asked for, else in the coordinator's folder, on the coordinator's account */
  private async startHere(tabId: string, req: CoordStartRequest): Promise<PipeResponse> {
    const tab = this.d.tabs().find((t) => t.tabId === tabId)
    if (!tab) return fail(HUB_TEXT.notCoordinator)
    const folder = req.folder ?? tab.folder
    // a folder named for this device is a path here: one that is not absolute here is no folder
    const isFolder = this.d.isAbsolute(folder) && (await this.d.isDirectory(folder))
    // the coordinator may have stopped while the folder was checked
    const c = this.own(tabId)
    if (!c) return fail(HUB_TEXT.notCoordinator)
    if (!isFolder) return fail(HUB_TEXT.noFolder(folder))
    if (c.attachments.length + this.startsOf(c).length >= MAX_ATTACHMENTS) return fail(HUB_TEXT.fullAttached)
    if (this.d.store.allHosted().length + this.localStarts().length >= MAX_HOSTED) return fail(HUB_TEXT.fullHosted)
    const newTab = this.d.openTab({ kind: 'claude', cwd: folder, account: tab.account, title: req.name })
    if (newTab === null) return fail(HUB_TEXT.notOpened)
    const text = (req.worktree === null ? '' : worktreeInstruction(req.worktree)) + req.task
    return new Promise<PipeResponse>((answer) => {
      const start: PendingStart = {
        tabId: newTab,
        coordinator: c.session,
        name: req.name ?? folderName(folder),
        folder,
        account: tab.account,
        text,
        startedAt: this.d.now(),
        remote: null,
        answer,
        cancelWait: () => {}
      }
      start.cancelWait = this.d.later(START_WAIT_MS, () => this.waitOver(newTab))
      this.starts.set(newTab, start)
      this.d.changed()
    })
  }

  /** a start on a paired device: it opens the tab there in the folder asked for, else in the folder of a tab of this project there, with this coordinator's email; the session is attached once its tab has one */
  private async startOnPeer(tabId: string, req: CoordStartRequest, device: string, began: number): Promise<PipeResponse> {
    const snap = this.remoteSnapshot()
    const peer = [...snap.peers.values()].find((p) => sameName(p.name, device)) ?? null
    if (!peer) return fail(HUB_TEXT.noDevice(device))
    if (!peer.online) return fail(HUB_TEXT.deviceOffline(peer.name))
    if (!peer.coord) return fail(HUB_TEXT.oldDevice(peer.name))
    if (!peer.mail) return fail(HUB_TEXT.noMail(peer.name))
    const tab = this.d.tabs().find((t) => t.tabId === tabId)
    const c = this.own(tabId)
    if (!tab || !c) return fail(HUB_TEXT.notCoordinator)
    if (c.attachments.length + this.startsOf(c).length >= MAX_ATTACHMENTS) return fail(HUB_TEXT.fullAttached)
    // the folder asked for, else the folder of the device's first live tab of this project
    const projectTab = req.folder === null ? (snap.tabs.find((t) => t.device === peer.id && !t.exited && t.project !== null && sameName(t.project, c.project.name)) ?? null) : null
    const folder = req.folder ?? projectTab?.folder ?? null
    const fromTab = req.folder === null && projectTab !== null
    const opened = await this.d.openRemoteTab(peer.id, { cwd: folder, email: this.d.accountEmail(tab.account), title: req.name })
    // the coordinator may have stopped while the tab opened
    const owner = this.own(tabId)
    if (!owner) return fail(HUB_TEXT.notCoordinator)
    if (!opened.ok) return fail(opened.error)
    // a reply that names a tab of this device, or a start already kept, is no new tab of the peer's: the start is refused
    if (this.d.tabs().some((t) => t.tabId === opened.tabId) || this.starts.has(opened.tabId)) return fail(HUB_TEXT.openedNoTab(peer.name))
    const place = remoteFolderText({ cwd: opened.cwd, asked: folder, fromTab, defaulted: opened.defaulted, project: owner.project.name })
    return new Promise<PipeResponse>((answer) => {
      const start: PendingStart = {
        tabId: opened.tabId,
        coordinator: owner.session,
        name: req.name ?? folderName(opened.cwd),
        folder: opened.cwd,
        account: null,
        text: (req.worktree === null ? '' : worktreeInstruction(req.worktree)) + req.task,
        startedAt: this.d.now(),
        remote: { device: peer.id, deviceName: peer.name, place, account: opened.accountName, listed: false },
        answer,
        cancelWait: () => {}
      }
      // START_WAIT_MS counts from the call: the time the device took to open the tab comes off it, and it is at least a second
      start.cancelWait = this.d.later(Math.max(1000, START_WAIT_MS - (this.d.now() - began)), () => this.waitOver(opened.tabId))
      this.starts.set(opened.tabId, start)
      this.settleRemoteStarts()
      this.d.changed()
    })
  }

  attach(tabId: string, target: string): PipeResponse {
    return this.attachStep(tabId, target).response
  }

  /** the attach of a target, answered when a remote attach is confirmed, refused or detached, or with the attaching answer after REMOTE_ATTACH_WAIT_MS */
  private async attachAndWait(tabId: string, target: string): Promise<PipeResponse> {
    const step = this.attachStep(tabId, target)
    if (step.pending === null) return step.response
    const id = step.pending
    return new Promise<PipeResponse>((answer) => {
      const wait: AttachWait = { answer, cancelWait: () => {} }
      wait.cancelWait = this.d.later(REMOTE_ATTACH_WAIT_MS, () => this.answerAttach(id, step.response))
      this.attachWaits.set(id, wait)
    })
  }

  /** resolves the target among this device's agents and the sessions of the online paired devices, then attaches it */
  private attachStep(tabId: string, target: string): AttachStep {
    const c = this.own(tabId)
    if (!c) return { response: fail(HUB_TEXT.notCoordinator), pending: null }
    const problem = this.d.problem()
    if (problem !== null) return { response: fail(problem), pending: null }
    const resolved = resolveAgent(target, this.attachCandidates(), [])
    if (!resolved.ok) return { response: fail(resolved.error), pending: null }
    return this.attachTo(c, resolved.to)
  }

  /** attaches the session a tab runs: one of this device, or one of a paired device that the window lists */
  attachTab(tabId: string, sessionTabId: string): PipeResponse {
    const c = this.own(tabId)
    if (!c) return fail(HUB_TEXT.notCoordinator)
    const problem = this.d.problem()
    if (problem !== null) return fail(problem)
    const agent = this.d.agents().find((a) => a.tabId === sessionTabId && this.norm(a.device) === null)
    if (agent) return this.attachTo(c, { device: agent.device, session: agent.session, name: agent.name }).response
    const remote = this.d.remoteTabs().find((t) => t.tabId === sessionTabId && t.claude && !t.exited)
    if (!remote || remote.session === null || remote.name === null) return fail(HUB_TEXT.notClaude)
    return this.attachTo(c, { device: remote.device, session: remote.session, name: remote.name }).response
  }

  detach(tabId: string, target: string): PipeResponse {
    const c = this.own(tabId)
    if (!c) return fail(HUB_TEXT.notCoordinator)
    const found = this.attachedFind(c, target)
    if ('error' in found) return fail(found.error)
    if (found.att === null) {
      this.cancelStart(found.start.tabId, HUB_TEXT.startCancelled)
      this.d.changed()
      return { ok: true, info: HUB_TEXT.detached(found.row.name, true) }
    }
    const { att, row } = found
    // best-effort, as end() does it: a refused record is logged, and the session is detached all the same
    this.sendDetach(c, att)
    this.dropPending(c, att, fail(HUB_TEXT.detachedPending(att.name)))
    const dropped = att.device === null ? this.unhost(att.session) > 0 : row.task !== null
    this.unattach(c.session, att.session)
    this.d.changed()
    return { ok: true, info: HUB_TEXT.detached(row.name, dropped) }
  }

  /** the session of a tab leaves the coordinator it is attached to, on this device or on another: its hosted entry goes, and its coordinator is told */
  leave(tabId: string): CoordResult {
    const session = this.sessionOfTab(tabId)
    const hosted = session === null ? null : this.d.store.hostedBy(session)
    if (session === null || !hosted) return fail(HUB_TEXT.notAttached)
    this.unhost(hosted.session)
    if (hosted.coordinator.device === null) {
      // a coordinator of this device: its attachment goes, and the detach record is written here, best-effort
      this.unattach(hosted.coordinator.session, hosted.session)
      this.write(this.detachRecord(hosted.coordinator.session, this.address(null, session), hosted.project))
    } else {
      this.write({ ...this.detachRecord(session, hosted.coordinator, hosted.project), delivered: false, read: false })
    }
    this.d.changed()
    return { ok: true, info: HUB_TEXT.detachText(hosted.project) }
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
    if (found.att === null) return fail(HUB_TEXT.starting(found.row.name))
    const { att, row } = found
    if (att.device !== null) return this.messageDevice(c, att, att.device, row, text)
    const stored = this.d.store.hosted(att.session)
    const hosted = stored ? this.withoutDeadTasks(stored) : null
    if (!hosted) {
      this.d.log.warn(`coordinator: ${row.name} is attached without its hosted entry; the task is not given`)
      return fail(HUB_TEXT.notSaved)
    }
    // a session attached here whose entry names another coordinator is not this coordinator's to task
    if (this.norm(hosted.coordinator.device) !== null || hosted.coordinator.session !== c.session) {
      return fail(HUB_TEXT.elsewhere(row.name, hosted.project, hosted.coordinator.name))
    }
    if (hosted.tasks.length >= MAX_TASKS_PER_SESSION) return fail(HUB_TEXT.tooMany(row.name))
    // the record goes first: the mail listener takes the task into the hosted entry
    if (!this.giveTask(c, att, this.address(null, att.session), text)) return fail(HUB_TEXT.notSaved)
    return { ok: true, info: HUB_TEXT.queued(row.name, refOf(att.session)) }
  }

  /** writes a task from the coordinator to one of its sessions, and un-resolves the attachment; false when the record cannot be written */
  private giveTask(c: StoredCoordinator, att: StoredAttachment, to: MailAddress, text: string): boolean {
    const written = this.write({
      kind: 'task',
      from: this.address(null, c.session),
      to,
      replyTo: null,
      text,
      project: c.project.name,
      delivered: false,
      read: false
    })
    if (written === null) return false
    this.patchAttachment(c, att.session, { resolved: false, failed: false })
    this.d.changed()
    return true
  }

  resolve(tabId: string, target: string): PipeResponse {
    const c = this.own(tabId)
    if (!c) return fail(HUB_TEXT.notCoordinator)
    const found = this.attachedFind(c, target)
    if ('error' in found) return fail(found.error)
    if (found.att === null) return fail(HUB_TEXT.stillStarting(found.row.name))
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
      // a turn the tab is in takes no task as an idle hand-over, whatever its watcher came in: the task starts with the next turn
      if (into === 'idle' && this.inTurn.has(tabId)) return false
      const session = this.sessionOfTab(tabId)
      const hosted = session === null ? null : this.d.store.hosted(session)
      if (session === null || !hosted) return false
      const held = hosted.tasks.find((t) => t.id === r.id)
      return held?.state === 'queued' && this.nextQueuedTask(session)?.id === r.id
    }
    // a report or a progress note from another device is taken only by the coordinator it is addressed to, while its session is attached to it
    if ((kind === 'report' || kind === 'progress') && this.norm(r.from.device) !== null && !this.takesReport(r, this.d.store.coordinator(r.to.session))) return false
    if (kind === 'report' && r.outcome === 'stopped') return into === 'running'
    // a prompt carries a report or a progress note, never a plain message; and only a tab that still coordinates takes one as a prompt
    if (into === 'prompt') return (kind === 'report' || kind === 'progress') && this.isCoordinator(tabId)
    return true
  }

  /** the tab was handed mail: a task among it is open (idle) or delivered (prompt), and a turn starts unless it is a prompt */
  handedOver(tabId: string, taken: MailRecord[], into: HandOver): void {
    const session = this.sessionOfTab(tabId)
    if (session !== null) for (const r of taken) this.advance(session, r.id, { kind: 'handed', into, at: this.d.now() })
    if (into !== 'prompt') this.inTurn.add(tabId)
    this.d.changed()
  }

  /** a turn started: a task delivered as a prompt is open now, and a Stop that waits for its settle is overtaken */
  turnStarted(tabId: string): void {
    this.cancelSettle(tabId)
    this.inTurn.add(tabId)
    this.onCurrent(tabId, { kind: 'turn' })
    if (this.isCoordinator(tabId)) this.d.recheckMail()
    this.d.changed()
  }

  /** a turn ended; without background work left, the task ends at rest after REST_SETTLE_MS, unless a turn starts meanwhile; with background work left, the coordinator gets the answer at once as a progress note */
  turnEnded(tabId: string, end: { background: boolean; lastMessage: string | null }): void {
    this.inTurn.delete(tabId)
    const cur = this.currentOf(tabId)
    if (cur && end.lastMessage !== null) this.answers.set(cur.task.id, end.lastMessage)
    this.cancelSettle(tabId)
    if (cur && !end.background) {
      const taskId = cur.task.id
      this.settle.set(tabId, this.d.later(REST_SETTLE_MS, () => this.rest(tabId, taskId)))
    }
    // background work still runs: the task stays open, and the coordinator hears at once what the turn ended with
    if (cur && end.background && end.lastMessage !== null && cur.task.state === 'open') this.sendProgress(cur, end.lastMessage)
    this.d.recheckMail()
    this.d.poke(tabId)
  }

  /** a turn on an open task ended with background work left: the coordinator gets the turn's answer at once as a progress note, unless the newest note on this task says the same */
  private sendProgress(cur: { session: string; task: StoredTask }, lastMessage: string): void {
    const text = progressText(lastMessage)
    if (text === null) return
    const h = this.d.store.hosted(cur.session)
    if (!h) return
    if (this.lastProgress(cur.task.id)?.text === text) return
    const id = this.write({
      kind: 'progress',
      from: this.address(null, h.session),
      to: this.address(h.coordinator.device, h.coordinator.session),
      replyTo: cur.task.id,
      text,
      delivered: false,
      read: false
    })
    if (id === null) this.d.log.warn(`coordinator: the progress note of the task of ${h.session} was not saved`)
  }

  /** the newest progress note on a task: the latest sentAt, and among equal times the record later in mail.all() */
  private lastProgress(taskId: string): MailRecord | null {
    let last: MailRecord | null = null
    for (const r of this.d.mail.all()) if (kindOf(r) === 'progress' && r.replyTo === taskId && (last === null || r.sentAt >= last.sentAt)) last = r
    return last
  }

  /** a turn failed: a usage limit, or a cut ClaudeTerm continues, ends nothing; any other error fails the task */
  turnFailed(tabId: string, error: string, continued: boolean): void {
    this.inTurn.delete(tabId)
    this.cancelSettle(tabId)
    if (error !== LIMIT_ERROR && !continued) this.onCurrent(tabId, { kind: 'failed', reason: REASONS.error(error) })
    this.d.poke(tabId)
    this.d.changed()
  }

  /** the person ended the running turn; `at` is the transcript time of the entry that says so, 0 when it is not known */
  interrupted(tabId: string, at = 0): void {
    if (!this.inTurn.has(tabId)) return
    const cur = this.currentOf(tabId)
    // an entry older than the task's delivery was written before the task: the feed reads old entries when it starts
    if (at !== 0 && cur?.task.deliveredAt != null && at < cur.task.deliveredAt) return
    this.inTurn.delete(tabId)
    this.cancelSettle(tabId)
    this.onCurrent(tabId, { kind: 'stopped', reason: REASONS.interrupted })
    this.d.poke(tabId)
    this.d.changed()
  }

  /** the tab's process exited: its turn is over and the task it held fails; the queued tasks stay */
  exited(tabId: string): void {
    this.endMake(tabId)
    this.inTurn.delete(tabId)
    this.briefDue.delete(tabId)
    this.cancelSettle(tabId)
    this.onCurrent(tabId, { kind: 'failed', reason: REASONS.exit })
    this.d.changed()
  }

  /** the session a tab of this device runs now; the hub follows the tab's changes through tabSession and sessionStarted */
  tabSession(tabId: string, session: string | null): void {
    const before = this.sessions.get(tabId) ?? null
    if (before !== null && session !== null && before !== session) this.renamedFrom.set(tabId, before)
    this.sessions.set(tabId, session)
    if (session !== null) this.startArrived(tabId, session)
    if (session !== null) this.settleMake(tabId)
  }

  /** a tab's conversation started under a session id; clear, compact and resume move the coordinator and its sessions to it */
  sessionStarted(tabId: string, before: string | null, after: string, source: string): void {
    const remembered = this.renamedFrom.get(tabId) ?? null
    this.renamedFrom.delete(tabId)
    this.sessions.set(tabId, after)
    this.startArrived(tabId, after)
    this.settleMake(tabId)
    // the design names clear and compact; resume is needed too, for a restored tab that resumes under a new id
    if (source !== 'clear' && source !== 'compact' && source !== 'resume') return
    const old = before !== null && before !== after ? before : remembered
    if (old !== null && old !== after) {
      // a rename onto an id that already names a coordinator or a hosted session of this device changes nothing: its starts stay too
      if (this.d.store.renameSession(old, after)) {
        this.moveStarts(old, after)
        this.tellRenamed(old, after)
      }
      this.d.alias(old, after)
      this.d.changed()
    }
    // a clear or a compaction leaves the coordinator with a new session: its next turn is told its role and its sessions again
    if ((source === 'clear' || source === 'compact') && this.isCoordinator(tabId)) this.briefDue.add(tabId)
    // a clear ends the task its session held, and the turn the tab was in; the report comes from the new id
    if (source === 'clear') {
      this.inTurn.delete(tabId)
      this.onCurrent(tabId, { kind: 'stopped', reason: REASONS.clear })
    }
  }

  /** the tab was closed on purpose: its tasks fail, oldest first, and a coordinator's tab stops its coordinator */
  tabClosed(tabId: string): void {
    this.endMake(tabId)
    this.renamedFrom.delete(tabId)
    this.inTurn.delete(tabId)
    this.briefDue.delete(tabId)
    this.cancelSettle(tabId)
    this.cancelStart(tabId, HUB_TEXT.closedEarly)
    const session = this.sessionOfTab(tabId)
    if (session !== null) {
      const tasks = this.d.store.hosted(session)?.tasks ?? []
      for (const t of tasks.sort((a, b) => a.queuedAt - b.queuedAt)) this.advance(session, t.id, { kind: 'failed', reason: REASONS.closed })
    }
    const c = session === null ? null : this.d.store.coordinator(session)
    if (c) this.end(c)
  }

  view(tabId: string): CoordinatorView | null {
    const c = this.own(tabId)
    return c ? this.viewOf(c, tabId) : null
  }

  /**
   * The role note a coordinator's tab is due, as a wake block, or null when none is due or the tab is no coordinator now.
   * It only peeks: roleNoteTaken clears the due once the note is handed over.
   */
  roleNote(tabId: string): string | null {
    if (!this.briefDue.has(tabId)) return null
    const c = this.own(tabId)
    if (c === null) {
      this.briefDue.delete(tabId)
      return null
    }
    return roleBlock(roleNoteText(this.viewOf(c, tabId)))
  }

  /** the instruction a coordinator tab's every turn starts with; null when the tab is no coordinator now */
  turnNote(tabId: string): string | null {
    const c = this.own(tabId)
    return c === null ? null : turnNoteText(c.project.name)
  }

  /** the role note of the tab was handed to its coordinator: it is no longer due */
  roleNoteTaken(tabId: string): void {
    this.briefDue.delete(tabId)
  }

  /** the facts of a Claude tab of this device for the coordinators of other devices; null when the tab has no session */
  facts(tabId: string): RemoteCoordFacts | null {
    const tab = this.d.tabs().find((t) => t.tabId === tabId)
    if (!tab || tab.session === null) return null
    const { prompt, limit } = this.d.waits(tabId)
    const plan = this.d.progress(tabId)
    const current = plan?.tasks.find((t) => t.state === 'current') ?? plan?.tasks.find((t) => t.state === 'left')
    const hosted = this.d.store.hosted(tab.session)
    const task = hosted ? this.taskInfo(hosted) : null
    return {
      prompt: prompt ? { kind: prompt.kind, text: prompt.text === null ? null : oneLineText(prompt.text, PROMPT_TEXT_MAX) || null, since: Math.floor(prompt.since) } : null,
      limit: limit ? { resetsAt: limit.resetsAt === null ? null : Math.floor(limit.resetsAt), since: Math.floor(limit.since) } : null,
      progress: plan
        ? { done: plan.done, total: plan.total, finished: plan.finished, current: current ? oneLineText(current.title, COORD_FACT_TEXT_MAX) || null : null }
        : null,
      task: task ? { id: task.id, state: task.state, since: Math.floor(task.since) } : null,
      attachedTo: hosted ? oneLineText(hosted.coordinator.name, COORD_FACT_TEXT_MAX) || null : null,
      coordinator: this.d.store.coordinator(tab.session) !== null
    }
  }

  /** the paired devices or their tabs changed: the remote starts settle, and the views and the marks are asked again */
  remoteChanged(): void {
    this.settleRemoteStarts()
    this.d.changed()
  }

  marks(): CoordMarks {
    const marks: CoordMarks = {}
    const snap = this.remoteSnapshot()
    for (const c of this.d.store.coordinators()) {
      const tab = this.tabOfSession(c.session)
      if (!tab) continue
      const v = this.viewOf(c, tab.tabId, snap)
      marks[tab.tabId] = { role: 'coordinator', project: c.project.name, sessions: v.sessions.length, waiting: v.waiting }
    }
    for (const h of this.d.store.allHosted()) {
      const tab = this.tabOfSession(h.session)
      if (!tab) continue
      const coordinator = h.coordinator.device === null ? this.tabOfSession(h.coordinator.session) : null
      marks[tab.tabId] = { role: 'attached', project: h.project, coordinator: h.coordinator.name, coordinatorTabId: coordinator?.tabId ?? null }
    }
    // a session of another device, attached and confirmed, is marked in this window: its tab is the one the device lists
    for (const c of this.d.store.coordinators()) {
      const coordinatorTab = this.tabOfSession(c.session)
      for (const a of c.attachments) {
        const rt = a.device === null || a.pending !== null ? null : (snap.tabByKey.get(remoteKey(a.device, a.session)) ?? null)
        if (rt) marks[rt.tabId] = { role: 'attached', project: c.project.name, coordinator: this.nameOf(c.session), coordinatorTabId: coordinatorTab?.tabId ?? null }
      }
    }
    return marks
  }

  dispose(): void {
    this.unsubscribe()
    // every pending start answers now: no caller is left waiting on a tab that will not be settled
    for (const m of this.makes.values()) m.answer?.(null)
    this.makes.clear()
    for (const cancel of this.settle.values()) cancel()
    this.settle.clear()
    for (const s of this.starts.values()) s.cancelWait()
    this.starts.clear()
    for (const w of this.attachWaits.values()) w.cancelWait()
    this.attachWaits.clear()
  }

  /** the coordinator a tab runs, or null */
  private own(tabId: string): StoredCoordinator | null {
    const session = this.sessionOfTab(tabId)
    return session === null ? null : this.d.store.coordinator(session)
  }

  /** the agents an attach may name: this device's agents, and the sessions of the online paired devices, as agents */
  private attachCandidates(): Agent[] {
    const snap = this.remoteSnapshot()
    const remote: Agent[] = []
    for (const t of snap.tabs) {
      const peer = snap.peers.get(t.device)
      if (!peer || !peer.online || !t.claude || t.exited || t.session === null || t.name === null) continue
      remote.push({
        device: t.device,
        deviceName: peer.name,
        tabId: t.tabId,
        session: t.session,
        customTitle: null,
        folder: t.folder,
        branch: t.branch,
        title: null,
        busy: t.working,
        wakes: true,
        claude: null,
        name: t.name,
        ref: refOf(t.session)
      })
    }
    return [...this.d.agents().filter((a) => this.norm(a.device) === null), ...remote]
  }

  /** attaches a session by its address: one of this device at once, one of another device once that device confirms it */
  private attachTo(c: StoredCoordinator, to: MailAddress): AttachStep {
    const device = this.norm(to.device)
    if (device !== null) return this.attachRemote(c, device, to)
    const found = this.attachSession(c, to)
    if (!found.ok) return { response: found, pending: null }
    const response: PipeResponse = found.already ? { ok: true, info: HUB_TEXT.alreadyAttached(to.name) } : { ok: true, info: HUB_TEXT.attached(to.name, refOf(to.session)) }
    return { response, pending: null }
  }

  /** a session of another device: its device confirms the attach, so the attach record goes out and the attachment waits as pending */
  private attachRemote(c: StoredCoordinator, device: string, to: MailAddress): AttachStep {
    const name = to.name
    const snap = this.remoteSnapshot()
    const peer = snap.peers.get(device) ?? null
    const tab = snap.tabByKey.get(remoteKey(device, to.session)) ?? null
    const refused = (error: string): AttachStep => ({ response: fail(error), pending: null })
    if (!peer || !peer.online) return refused(HUB_TEXT.deviceOffline(peer?.name ?? 'another device'))
    if (tab?.coord?.coordinator) return refused(HUB_TEXT.isCoordinator(name))
    if (!peer.coord) return refused(HUB_TEXT.oldDevice(peer.name))
    if (!peer.mail) return refused(HUB_TEXT.noMail(peer.name))
    const ref = refOf(to.session)
    const held = c.attachments.find((a) => a.device === device && a.session === to.session)
    if (held) {
      const response: PipeResponse = held.pending !== null ? { ok: true, info: HUB_TEXT.attaching(name, ref, peer.name) } : { ok: true, info: HUB_TEXT.alreadyAttached(name) }
      return { response, pending: null }
    }
    const elsewhere = this.d.store.coordinators().find((x) => x.session !== c.session && x.attachments.some((a) => a.device === device && a.session === to.session))
    if (elsewhere) return refused(HUB_TEXT.elsewhere(name, elsewhere.project.name, this.nameOf(elsewhere.session)))
    if (c.attachments.length >= MAX_ATTACHMENTS) return refused(HUB_TEXT.fullAttached)

    const id = this.pendRemoteAttach(c, { device, session: to.session, name })
    if (id === null) return refused(HUB_TEXT.notSaved)
    this.d.changed()
    return { response: { ok: true, info: HUB_TEXT.attaching(name, ref, peer.name) }, pending: id }
  }

  /** a session of another device is attached to the coordinator, pending its device's confirmation: its attach record goes out, and the attachment waits for it; null when the record cannot be written */
  private pendRemoteAttach(c: StoredCoordinator, to: { device: string; session: string; name: string }): string | null {
    const project = c.project.name
    const id = this.write({ kind: 'attach', from: this.address(null, c.session), to, replyTo: null, text: HUB_TEXT.attachText(project), project, delivered: false, read: false })
    if (id === null) return null
    const attachment: StoredAttachment = { device: to.device, session: to.session, name: to.name, attachedAt: this.d.now(), resolved: false, failed: false, lastReport: null, pending: id }
    this.d.store.putCoordinator({ ...c, attachments: [...c.attachments, attachment] })
    return id
  }

  /** a task to a session of another device: the task record goes to its device, which holds it as queued; a session not confirmed yet takes none */
  private messageDevice(c: StoredCoordinator, att: StoredAttachment, device: string, row: CoordSessionRow, text: string): PipeResponse {
    if (att.pending !== null) return fail(HUB_TEXT.notConfirmed(row.name))
    const replied = new Set(this.d.mail.all().filter((r) => kindOf(r) === 'report' && r.replyTo !== null).map((r) => r.replyTo))
    const open = this.d.mail
      .all()
      .filter((r) => kindOf(r) === 'task' && this.wroteAs(r, c) && r.to.session === att.session && this.norm(r.to.device) === device && r.sentAt >= att.attachedAt && !replied.has(r.id))
    if (open.length >= MAX_TASKS_PER_SESSION) return fail(HUB_TEXT.tooMany(row.name))
    // the record goes first: the device takes the task into its hosted entry when it has the record
    if (!this.giveTask(c, att, { device, session: att.session, name: row.name }, text)) return fail(HUB_TEXT.notSaved)
    const ref = refOf(att.session)
    return { ok: true, info: row.marker === 'offline' ? HUB_TEXT.queuedOffline(row.name, ref, row.deviceName ?? 'another device') : HUB_TEXT.queued(row.name, ref) }
  }

  /** a session is attached to this coordinator: its attach record, attachment and hosted entry; `already` when it was attached before */
  private attachSession(c: StoredCoordinator, to: MailAddress): { ok: true; already: boolean } | { ok: false; error: string } {
    const session = to.session
    const name = to.name
    if (session === c.session) return fail(HUB_TEXT.self)
    if (this.d.store.coordinator(session)) return fail(HUB_TEXT.isCoordinator(name))
    const hosted = this.d.store.hosted(session)
    if (c.attachments.some((a) => a.session === session) || (hosted?.coordinator.device === null && hosted.coordinator.session === c.session)) {
      return { ok: true, already: true }
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
    const attachment: StoredAttachment = { device: null, session, name, attachedAt: this.d.now(), resolved: false, failed: false, pending: null, lastReport: null }
    this.d.store.putCoordinator({ ...c, attachments: [...c.attachments, attachment] })
    this.d.store.putHosted({ session, coordinator: this.stored(this.address(null, c.session)), project, tasks: [], former: [] })
    this.d.changed()
    return { ok: true, already: false }
  }

  /** a session id came to a tab that a start opened: the session is attached and given the task, or the start answers why not */
  private startArrived(tabId: string, session: string): void {
    const s = this.starts.get(tabId)
    // a remote start is settled by its device's list of tabs, never by a tab of this device
    if (!s || s.remote !== null) return
    this.dropStart(tabId)
    const c = this.d.store.coordinator(s.coordinator)
    if (!c) return this.answerStart(s, fail(HUB_TEXT.startCancelled))
    // the task record is checked before the attach, so a record that cannot be written changes nothing
    const task = this.record({
      kind: 'task',
      from: this.address(null, c.session),
      to: this.address(null, session),
      replyTo: null,
      text: s.text,
      project: c.project.name,
      delivered: false,
      read: false
    })
    if (task === null) return this.answerStart(s, fail(HUB_TEXT.notSaved))
    const to: MailAddress = { device: null, session, name: this.nameOf(session) }
    const attached = this.attachSession(c, to)
    if (!attached.ok) return this.answerStart(s, attached)
    // the record goes after the hosted entry exists: the mail listener takes the task into it
    this.d.mail.add(task)
    this.d.changed()
    this.answerStart(s, { ok: true, info: HUB_TEXT.started(to.name, refOf(session), s.folder, this.d.accountLabel(s.account)) })
  }

  /** START_WAIT_MS passed without a session id: the start answers without one, and it goes on */
  private waitOver(tabId: string): void {
    const s = this.starts.get(tabId)
    if (!s) return
    const info = s.remote === null
      ? HUB_TEXT.opening(s.name, s.folder, this.d.accountLabel(s.account))
      : HUB_TEXT.openingThere(s.name, s.remote.deviceName, s.remote.place, s.remote.account)
    this.answerStart(s, { ok: true, info })
  }

  /** the remote starts, as their devices list their tabs: a tab with its session is attached and given the task; a tab that its listed device no longer has was closed, once it had been listed; the rest wait */
  private settleRemoteStarts(): void {
    const remote = [...this.starts.values()].flatMap((s) => (s.remote === null ? [] : [{ s, r: s.remote }]))
    if (remote.length === 0) return
    const snap = this.remoteSnapshot()
    for (const { s, r } of remote) {
      const tab = snap.tabs.find((t) => t.device === r.device && t.tabId === s.tabId) ?? null
      if (tab === null) {
        if (r.listed && snap.peers.get(r.device)?.listed === true) this.cancelStart(s.tabId, HUB_TEXT.closedEarly)
        continue
      }
      r.listed = true
      if (tab.session !== null && tab.name !== null) this.attachRemoteStart(s, r, tab.session, tab.name)
    }
  }

  /** a remote start's session has come: it is attached to the coordinator, pending its device's confirmation, and given the task; the answer says where it started */
  private attachRemoteStart(s: PendingStart, r: RemoteStart, session: string, name: string): void {
    const c = this.d.store.coordinator(s.coordinator)
    if (!c) return this.cancelStart(s.tabId, HUB_TEXT.startCancelled)
    const to = { device: r.device, session, name }
    const taskInput: RecordInput = { kind: 'task', from: this.address(null, c.session), to, replyTo: null, text: s.text, project: c.project.name, delivered: false, read: false }
    // the task's record is checked before anything is written, so a record the mail check refuses changes nothing
    if (this.record(taskInput) === null) return this.cancelStart(s.tabId, HUB_TEXT.notSaved)
    // the attach goes first: Laptop takes it before the task, and the task is stamped after the attach and the attachment
    if (this.pendRemoteAttach(c, to) === null) return this.cancelStart(s.tabId, HUB_TEXT.notSaved)
    const task = this.record(taskInput)
    if (task === null) return this.cancelStart(s.tabId, HUB_TEXT.notSaved)
    this.d.mail.add(task)
    this.dropStart(s.tabId)
    this.d.changed()
    this.answerStart(s, { ok: true, info: HUB_TEXT.startedThere(name, refOf(session), r.deviceName, r.place, r.account) })
  }

  /** a pending start leaves the hub: its wait timer is cancelled, and the caller answers it */
  private dropStart(tabId: string): PendingStart | null {
    const s = this.starts.get(tabId)
    if (!s) return null
    this.starts.delete(tabId)
    s.cancelWait()
    return s
  }

  /** a pending start leaves the hub and its answer, if still open, is the failure given */
  private cancelStart(tabId: string, error: string): void {
    const s = this.dropStart(tabId)
    if (s) this.answerStart(s, fail(error))
  }

  /** answers a start once: a later answer does nothing */
  private answerStart(s: PendingStart, r: PipeResponse): void {
    const answer = s.answer
    s.answer = null
    answer?.(r)
  }

  /** the starts of a coordinator, oldest first */
  private startsOf(c: StoredCoordinator): PendingStart[] {
    return [...this.starts.values()].filter((s) => s.coordinator === c.session)
  }

  /** the starts on this device: their tabs open here, and they count toward this device's hosted sessions */
  private localStarts(): PendingStart[] {
    return [...this.starts.values()].filter((s) => s.remote === null)
  }

  /** the starts that followed a coordinator to another session id */
  private moveStarts(from: string, to: string): void {
    for (const s of this.starts.values()) if (s.coordinator === from) s.coordinator = to
  }

  /** a Starting… row: its tab is open and its session id has not come */
  private startRow(s: PendingStart): CoordSessionRow {
    return {
      key: `start:${s.tabId}`,
      tabId: s.tabId,
      device: s.remote?.device ?? null,
      deviceName: s.remote?.deviceName ?? null,
      session: null,
      ref: null,
      name: s.name,
      folder: s.folder,
      branch: null,
      group: 'working',
      why: null,
      marker: 'starting',
      line: 'Starting…',
      progress: null,
      changedAt: this.d.now(),
      task: null,
      lastReport: null,
      attachedTo: null
    }
  }

  /** the coordinator is gone: each session is detached as detach does it, and the coordinator is removed */
  private end(c: StoredCoordinator): void {
    for (const s of this.startsOf(c)) this.cancelStart(s.tabId, HUB_TEXT.startCancelled)
    for (const a of c.attachments) {
      this.sendDetach(c, a)
      this.dropPending(c, a, fail(HUB_TEXT.detachedPending(a.name)))
      if (a.device === null) this.unhost(a.session)
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
    for (const t of hosted.tasks) this.answers.delete(t.id)
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

  /** a pending attachment now waits for the attach that replaces its old one: the tool waiting on the old attach is answered by the new one, and a late refusal of the old one does not remove it */
  private repend(session: string, attached: string, old: string, id: string): void {
    const c = this.d.store.coordinator(session)
    if (c) this.patchAttachment(c, attached, { pending: id })
    const wait = this.attachWaits.get(old)
    if (!wait) return
    this.attachWaits.delete(old)
    this.attachWaits.set(id, wait)
  }

  private detachRecord(from: string, to: MailAddress, project: string): RecordInput {
    return {
      kind: 'detach',
      from: this.address(null, from),
      to,
      replyTo: null,
      text: HUB_TEXT.detachText(project),
      delivered: true,
      read: true
    }
  }

  /** the detach record of an attachment that goes: a session of this device keeps it; a session of another device gets it, unread until its device takes it */
  private sendDetach(c: StoredCoordinator, a: StoredAttachment): void {
    const r = this.detachRecord(c.session, this.targetOf(a), c.project.name)
    this.write(a.device === null ? r : { ...r, delivered: false, read: false })
  }

  /** the address of an attached session: this device's, or the device's the attachment names */
  private targetOf(a: StoredAttachment): MailAddress {
    return a.device === null ? this.address(null, a.session) : { device: a.device, session: a.session, name: a.name }
  }

  /** a pending remote attachment that goes: its waiting answer is given, and the tasks given to its session that the session never took are marked delivered and read */
  private dropPending(c: StoredCoordinator, a: StoredAttachment, answer: PipeResponse): void {
    if (a.pending === null) return
    this.answerAttach(a.pending, answer)
    const ids = this.d.mail
      .all()
      .filter((r) => kindOf(r) === 'task' && !r.delivered && this.wroteAs(r, c) && r.to.session === a.session && this.norm(r.to.device) === a.device)
      .map((r) => r.id)
    if (ids.length === 0) return
    this.d.mail.mark(ids, 'delivered')
    this.d.mail.mark(ids, 'read')
  }

  /** answers a remote attach that a tool waits on, once: the wait is over and its timer is cancelled */
  private answerAttach(id: string, r: PipeResponse): void {
    const wait = this.attachWaits.get(id)
    if (!wait) return
    this.attachWaits.delete(id)
    wait.cancelWait()
    wait.answer(r)
  }

  /** an attach this device wrote is delivered: its device took it, so the attachment is confirmed and the tool waiting on it is answered */
  private confirmAttach(r: MailRecord): boolean {
    if (!r.delivered || this.norm(r.from.device) !== null) return false
    const c = this.d.store.coordinatorBy(r.from.session)
    const att = c?.attachments.find((a) => a.pending === r.id)
    if (!c || !att) return false
    this.patchAttachment(c, att.session, { pending: null })
    this.answerAttach(r.id, { ok: true, info: HUB_TEXT.attached(att.name, refOf(att.session)) })
    return true
  }

  /** an attach from another device to a session of this device, not yet delivered: the session takes it for its coordinator, or refuses it with a detach that says why */
  private acceptAttach(r: MailRecord): boolean {
    if (r.delivered || r.read || this.norm(r.from.device) === null || this.norm(r.to.device) !== null) return false
    if (r.was !== undefined) return false
    const session = r.to.session
    const name = this.agentName(session) ?? r.to.name
    const refuse = (reason: string): boolean => {
      this.write({ kind: 'detach', from: this.address(null, session), to: { device: r.from.device, session: r.from.session, name: r.from.name }, replyTo: r.id, text: reason, delivered: false, read: false })
      this.d.mail.mark([r.id], 'read')
      return true
    }
    if (!r.project) return refuse(HUB_TEXT.noProjectGiven)
    const problem = this.d.problem()
    if (problem !== null) return refuse(HUB_TEXT.problemThere(this.d.selfName(), problem))
    const tab = this.tabOfSession(session)
    if (!tab || tab.exited) return refuse(HUB_TEXT.closedThere(name))
    if (this.d.store.coordinator(session)) return refuse(HUB_TEXT.isCoordinator(name))
    const from = this.stored(r.from)
    const hosted = this.d.store.hostedBy(session)
    const same = hosted !== null && this.norm(hosted.coordinator.device) === from.device && hosted.coordinator.session === from.session
    if (hosted && !same) return refuse(HUB_TEXT.elsewhere(name, hosted.project, hosted.coordinator.name))
    if (!same && this.d.store.allHosted().length >= MAX_HOSTED) return refuse(HUB_TEXT.fullHostedThere(this.d.selfName()))
    if (!same) this.d.store.putHosted({ session, coordinator: from, project: r.project, tasks: [], former: [] })
    this.d.mail.mark([r.id], 'delivered')
    this.d.mail.mark([r.id], 'read')
    return true
  }

  /** a detach from another device, not yet delivered: a coordinator here loses that session, and a session here loses the hosted entry of that coordinator; the record is then delivered and read */
  private detachArrived(r: MailRecord): boolean {
    if (r.delivered || r.read || this.norm(r.from.device) === null || this.norm(r.to.device) !== null) return false
    const c = this.d.store.coordinatorBy(r.to.session)
    if (c) this.attachmentLeft(c, r)
    const hosted = this.d.store.hostedBy(r.to.session)
    if (hosted && this.norm(hosted.coordinator.device) === this.norm(r.from.device) && hosted.coordinator.session === r.from.session) this.unhost(hosted.session)
    this.d.mail.mark([r.id], 'delivered')
    this.d.mail.mark([r.id], 'read')
    return true
  }

  /** a detach from a session of another device to this coordinator: a refusal removes the attachment only while it is the one pending; any other detach says the session left */
  private attachmentLeft(c: StoredCoordinator, r: MailRecord): void {
    const att = c.attachments.find((a) => a.device === this.norm(r.from.device) && a.session === r.from.session)
    if (!att) return
    if (r.replyTo !== null && r.replyTo !== att.pending) return
    this.dropPending(c, att, fail(r.replyTo === null ? HUB_TEXT.detachedPending(att.name) : r.text))
    this.unattach(c.session, att.session)
    this.d.changed()
  }

  /** an attach from another device that names the id the sender had (was) or the coordinator it replaces (replaces): the attachment or hosted entry here takes the new one, and the record is delivered and read; a replaces that matches no hosted entry here is a plain attach */
  private followAttach(r: MailRecord): boolean {
    if (r.delivered || r.read || this.norm(r.from.device) === null || this.norm(r.to.device) !== null) return false
    if (r.was !== undefined) {
      this.followRename(r, r.was)
    } else if (r.replaces !== undefined) {
      const hosted = this.d.store.hostedBy(r.to.session)
      if (!hosted || this.norm(hosted.coordinator.device) !== this.norm(r.from.device) || hosted.coordinator.session !== r.replaces) return false
      this.d.store.putHosted({ ...hosted, coordinator: this.stored(r.from), project: r.project ?? hosted.project })
    } else {
      return false
    }
    this.d.mail.mark([r.id], 'delivered')
    this.d.mail.mark([r.id], 'read')
    return true
  }

  /** a session of another device took a new id: its attachment here, or its hosted entry's coordinator, and the tasks it gave take the new id */
  private followRename(r: MailRecord, was: string): void {
    const device = this.norm(r.from.device)
    const c = this.d.store.coordinatorBy(r.to.session)
    const att = c?.attachments.find((a) => a.device === device && a.session === was)
    if (c && att) this.patchAttachment(c, att.session, { session: r.from.session, name: r.from.name })
    const hosted = this.d.store.hostedBy(r.to.session)
    if (hosted && this.norm(hosted.coordinator.device) === device && hosted.coordinator.session === was) {
      const from = this.stored(r.from)
      this.d.store.putHosted({ ...hosted, coordinator: from, tasks: hosted.tasks.map((t) => (this.norm(t.from.device) === device && t.from.session === was ? { ...t, from } : t)) })
    }
  }

  /** a session of this device took a new id: each remote attachment of it, and its hosted entry's coordinator when that is on another device, is told with was; what is in flight to the old id follows */
  private tellRenamed(old: string, session: string): void {
    const c = this.d.store.coordinator(session)
    if (c) {
      for (const a of c.attachments) {
        if (a.device === null) continue
        this.write({ kind: 'attach', from: this.address(null, session), to: { device: a.device, session: a.session, name: a.name }, replyTo: null, text: HUB_TEXT.attachText(c.project.name), project: c.project.name, was: old, delivered: false, read: false })
      }
    }
    const hosted = this.d.store.hosted(session)
    if (hosted && hosted.coordinator.device !== null) {
      this.write({ kind: 'attach', from: this.address(null, session), to: hosted.coordinator, replyTo: null, text: HUB_TEXT.attachText(hosted.project), project: hosted.project, was: old, delivered: false, read: false })
    }
    this.forwardFormer(old)
  }

  /** a coordinator's remote reports and progress notes in flight to a former id here are written again to the current one; a task a hosted session holds is taken by its own hand-over, so it is not copied */
  private forwardFormer(old: string): void {
    for (const r of this.d.mail.all()) if (r.to.session === old && (kindOf(r) === 'report' || kindOf(r) === 'progress')) this.forwardArrived(r)
  }

  /** a report, a progress note or a task from another device, not delivered or read, addressed to a former id of a coordinator or hosted session here, is written again to the current id, and the original is delivered and read */
  private forwardArrived(r: MailRecord): boolean {
    if (r.delivered || r.read || this.norm(r.to.device) !== null || this.norm(r.from.device) === null) return false
    const kind = kindOf(r)
    if (kind !== 'report' && kind !== 'task' && kind !== 'progress') return false
    const holder = kind === 'task' ? this.d.store.hostedBy(r.to.session) : this.d.store.coordinatorBy(r.to.session)
    if (!holder || holder.session === r.to.session) return false
    // a task the hosted session already holds is not copied: a copy would queue it twice
    if (kind === 'task' && this.d.store.hostedBy(r.to.session)?.tasks.some((t) => t.id === r.id)) return false
    const copy = this.write({
      kind,
      from: r.from,
      sentAt: r.sentAt,
      to: { device: r.to.device, session: holder.session, name: this.nameOf(holder.session) },
      replyTo: r.replyTo,
      text: r.text,
      ...(r.project === undefined ? {} : { project: r.project }),
      ...(r.outcome === undefined ? {} : { outcome: r.outcome }),
      ...(r.reason === undefined ? {} : { reason: r.reason }),
      delivered: false,
      read: false
    })
    if (copy === null) return false
    this.d.mail.mark([r.id], 'delivered')
    this.d.mail.mark([r.id], 'read')
    return true
  }

  /** a record this device's coordinator c wrote, under its id now or an id it had before a clear or a replace */
  private wroteAs(r: MailRecord, c: StoredCoordinator): boolean {
    return this.norm(r.from.device) === null && (r.from.session === c.session || c.former.includes(r.from.session))
  }

  /** whether a coordinator takes a report or a progress note from another device: its session is attached to it */
  private takesReport(r: MailRecord, c: StoredCoordinator | null): boolean {
    return c !== null && c.attachments.some((a) => a.session === r.from.session && a.device === this.norm(r.from.device))
  }

  /** an undelivered, unread report or progress note from another device that no coordinator here takes: its session is attached to no coordinator of this device, by its id or a former one */
  private unroutedReport(r: MailRecord): boolean {
    if (r.delivered || r.read || this.norm(r.to.device) !== null || this.norm(r.from.device) === null) return false
    return !this.takesReport(r, this.d.store.coordinatorBy(r.to.session))
  }

  /** the paired devices and their tabs, read once: a view or the marks takes one of these, not a read per lookup */
  private remoteSnapshot(): RemoteSnapshot {
    const tabs = this.d.remoteTabs()
    const tabByKey = new Map<string, HubRemoteTab>()
    for (const t of tabs) {
      if (t.session === null) continue
      const key = remoteKey(t.device, t.session)
      const held = tabByKey.get(key)
      // a session's live tab before an exited one that still lists it
      if (!held || (held.exited && !t.exited)) tabByKey.set(key, t)
    }
    return { peers: new Map(this.d.peers().map((p) => [p.id, p])), tabs, tabByKey }
  }

  /** the rows of a coordinator's attachments, in the order it has them */
  private attachedRows(c: StoredCoordinator, snap: RemoteSnapshot): CoordSessionRow[] {
    const queued = c.attachments.some((a) => a.device !== null) ? this.queuedRemoteTasks(c) : new Map<string, CoordTaskInfo>()
    return c.attachments.map((a) =>
      a.device === null
        ? this.rowOf(a.session, this.agentName(a.session) ?? a.name, this.tabOfSession(a.session), this.d.store.hosted(a.session), a)
        : this.attachedRemoteRow(a, a.device, queued, snap)
    )
  }

  /** a row of a session of another device attached here: its tab's facts from the device's list, and the attachment's marks */
  private attachedRemoteRow(a: StoredAttachment, device: string, queued: Map<string, CoordTaskInfo>, snap: RemoteSnapshot): CoordSessionRow {
    const rt = snap.tabByKey.get(remoteKey(device, a.session)) ?? null
    const peer = snap.peers.get(device) ?? null
    const coord = rt?.coord ?? null
    const marker: CoordMarker = a.pending !== null ? 'attaching' : peer?.online === true ? null : 'offline'
    // the task the device reports is the one it holds; without it, the oldest task this coordinator gave it that it has not taken
    const task = coord?.task ?? queued.get(remoteKey(device, a.session)) ?? null
    const state = rowState(
      {
        marker,
        closed: peer?.online === true && peer.listed && rt === null,
        exited: rt?.exited ?? false,
        working: rt?.working ?? false,
        prompt: coord?.prompt ?? null,
        limit: coord?.limit ?? null,
        progress: planOf(coord),
        task,
        resolved: a.resolved,
        failed: a.failed,
        lastReport: a.lastReport
      },
      this.d.clock
    )
    return {
      key: remoteKey(device, a.session),
      tabId: rt?.tabId ?? null,
      device,
      deviceName: peer?.name ?? 'another device',
      session: a.session,
      ref: refOf(a.session),
      name: rt?.name ?? a.name,
      folder: rt?.folder ?? null,
      branch: rt?.branch ?? null,
      group: state.group,
      why: state.why,
      marker,
      line: state.line,
      progress: state.progress,
      changedAt: this.d.now(),
      task,
      lastReport: a.lastReport,
      attachedTo: null
    }
  }

  /** the sessions of online paired devices that are in this coordinator's project, not coordinators, and not attached here: their rows */
  private notAttachedRemote(c: StoredCoordinator, snap: RemoteSnapshot): CoordSessionRow[] {
    const rows: CoordSessionRow[] = []
    for (const t of snap.tabs) {
      if (!t.claude || t.session === null || t.exited) continue
      const peer = snap.peers.get(t.device)
      if (!peer || !peer.online) continue
      if (t.project === null || !sameName(t.project, c.project.name) || t.coord?.coordinator === true) continue
      if (c.attachments.some((a) => a.device === t.device && a.session === t.session)) continue
      const state = rowState(
        {
          marker: null,
          closed: false,
          exited: false,
          working: t.working,
          prompt: t.coord?.prompt ?? null,
          limit: t.coord?.limit ?? null,
          progress: planOf(t.coord),
          task: null,
          resolved: false,
          failed: false,
          lastReport: null
        },
        this.d.clock
      )
      rows.push({
        key: remoteKey(t.device, t.session),
        tabId: t.tabId,
        device: t.device,
        deviceName: peer.name,
        session: t.session,
        ref: refOf(t.session),
        name: t.name ?? refOf(t.session),
        folder: t.folder,
        branch: t.branch,
        group: state.group,
        why: state.why,
        marker: null,
        line: state.line,
        progress: state.progress,
        changedAt: this.d.now(),
        task: null,
        lastReport: null,
        attachedTo: this.attachedToName(t.device, t.session, t.coord)
      })
    }
    return rows
  }

  /** the coordinator a session of another device is attached to: its device's word, else a coordinator of this device; null: none */
  private attachedToName(device: string, session: string, facts: RemoteCoordFacts | null): string | null {
    const local = this.d.store.coordinators().find((c) => c.attachments.some((a) => a.device === device && a.session === session))
    const name = facts?.attachedTo ?? (local ? this.nameOf(local.session) : null)
    return name === null ? null : replaceControls(name)
  }

  /** the oldest task this coordinator gave each session of another device that has not been delivered and has no report: keyed by the device and the session */
  private queuedRemoteTasks(c: StoredCoordinator): Map<string, CoordTaskInfo> {
    const replied = new Set<string>()
    const open: MailRecord[] = []
    for (const r of this.d.mail.all()) {
      if (kindOf(r) === 'report' && r.replyTo !== null) replied.add(r.replyTo)
      else if (kindOf(r) === 'task' && !r.delivered && this.wroteAs(r, c)) open.push(r)
    }
    const oldest = new Map<string, CoordTaskInfo>()
    for (const r of open) {
      const device = this.norm(r.to.device)
      if (device === null || replied.has(r.id)) continue
      const key = remoteKey(device, r.to.session)
      const held = oldest.get(key)
      if (!held || r.sentAt < held.since) oldest.set(key, { id: r.id, state: 'queued', since: r.sentAt })
    }
    return oldest
  }

  /** the row a target names among a coordinator's attached sessions and its Starting… rows */
  private attachedFind(c: StoredCoordinator, target: string): FoundRow | { error: string } {
    const attached = this.attachedRows(c, this.remoteSnapshot())
    const starts = this.startsOf(c)
    const rows = [...attached, ...starts.map((s) => this.startRow(s))]
    const found = findRow(rows, target)
    if ('error' in found) return found
    const i = rows.indexOf(found.row)
    if (i < attached.length) return { row: found.row, att: c.attachments[i], start: null }
    return { row: found.row, att: null, start: starts[i - attached.length] }
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

  private viewOf(c: StoredCoordinator, tabId: string, snap: RemoteSnapshot = this.remoteSnapshot()): CoordinatorView {
    const sessions = [...this.attachedRows(c, snap), ...this.startsOf(c).map((s) => this.startRow(s))]
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
    notAttached.push(...this.notAttachedRemote(c, snap))
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
    const live = this.withoutDeadTasks(h)
    const t = currentTask(live) ?? nextTask(live)
    return t ? { id: t.id, state: t.state, since: t.deliveredAt ?? t.queuedAt } : null
  }

  /** the mail that arrived: a task given to a session of this device by its hosted coordinator is taken into the hosted entry */
  private mailChanged(changed: MailRecord[]): void {
    let taken = false
    let held = false
    let signalled = false
    let noted = false
    const pokes: string[] = []
    for (const r of changed) {
      if (kindOf(r) === 'attach') {
        if (this.confirmAttach(r) || this.followAttach(r) || this.acceptAttach(r)) signalled = true
        continue
      }
      if (kindOf(r) === 'detach') {
        if (this.detachArrived(r)) signalled = true
        continue
      }
      // a report, a progress note or a task still addressed to a former id is written again to the current one, before any rule that would drop it
      if (this.forwardArrived(r)) continue
      if (kindOf(r) === 'report') {
        if (this.holdReport(r)) {
          held = true
          const tab = this.tabOfSession(r.to.session)
          if (tab) pokes.push(tab.tabId)
        } else if (this.unroutedReport(r)) {
          // a report that no coordinator here takes wakes nobody, so it is marked delivered and read
          this.d.mail.mark([r.id], 'delivered')
          this.d.mail.mark([r.id], 'read')
        }
        continue
      }
      if (kindOf(r) === 'progress') {
        // a progress note no coordinator here takes wakes nobody; one a coordinator takes wakes its tab, which is prompted with it
        if (this.unroutedReport(r)) {
          this.d.mail.mark([r.id], 'delivered')
          this.d.mail.mark([r.id], 'read')
        } else if (!r.delivered && this.norm(r.to.device) === null) {
          const tab = this.tabOfSession(r.to.session)
          if (tab) pokes.push(tab.tabId)
          noted = true
        }
        continue
      }
      if (kindOf(r) !== 'task' || r.delivered || this.norm(r.to.device) !== null) continue
      const hosted = this.d.store.hosted(r.to.session)
      if (!hosted || hosted.tasks.some((t) => t.id === r.id)) continue
      if (this.norm(r.from.device) !== hosted.coordinator.device || r.from.session !== hosted.coordinator.session) continue
      if (hosted.tasks.length >= MAX_TASKS_PER_SESSION) continue
      const from: MailAddress = { device: this.norm(r.from.device), session: r.from.session, name: r.from.name }
      this.d.store.putHosted({ ...hosted, tasks: [...hosted.tasks, { id: r.id, from, state: 'queued', queuedAt: r.sentAt, deliveredAt: null }] })
      taken = true
      const tab = this.tabOfSession(hosted.session)
      if (tab) pokes.push(tab.tabId)
    }
    if (taken) this.d.recheckMail()
    for (const tabId of pokes) this.d.poke(tabId)
    if (taken || held || signalled || noted) this.d.changed()
  }

  /** a report a session of this device sent a coordinator of this device is the last report of that session's attachment, unless it holds this one or a newer one */
  private holdReport(r: MailRecord): boolean {
    if (this.norm(r.to.device) !== null || r.outcome === undefined) return false
    const c = this.d.store.coordinator(r.to.session)
    const att = c?.attachments.find((a) => a.session === r.from.session && a.device === this.norm(r.from.device))
    if (!c || !att) return false
    if (att.lastReport && (att.lastReport.id === r.id || att.lastReport.at > r.sentAt)) return false
    this.patchAttachment(c, att.session, { lastReport: { id: r.id, outcome: r.outcome, reason: r.reason ?? null, at: r.sentAt }, failed: r.outcome === 'failed' })
    return true
  }

  /** the session's next task to give; a queued task whose mail record is gone is dropped first, so it cannot hold the queue */
  private nextQueuedTask(session: string): StoredTask | null {
    const h = this.d.store.hosted(session)
    return h ? nextTask(this.withoutDeadTasks(h)) : null
  }

  /** the hosted entry without its dead tasks: a queued task whose mail record is gone is dropped and stored, so it cannot hold the queue, show in the view or count toward the cap */
  private withoutDeadTasks(h: StoredHosted): StoredHosted {
    const dead = h.tasks.filter((t) => t.state === 'queued' && !this.d.mail.get(t.id))
    if (dead.length === 0) return h
    for (const t of dead) this.d.log.warn(`coordinator: the task ${t.id} of ${h.session} has no mail record; it is dropped`)
    const live = { ...h, tasks: h.tasks.filter((t) => !dead.includes(t)) }
    this.d.store.putHosted(live)
    this.d.changed()
    return live
  }

  /** the session of a tab and the task it holds now, delivered or open; null when it holds none */
  private currentOf(tabId: string): { session: string; task: StoredTask } | null {
    const session = this.sessionOfTab(tabId)
    const h = session === null ? null : this.d.store.hosted(session)
    const task = h ? currentTask(h) : null
    return h && task ? { session: h.session, task } : null
  }

  /** applies an event to the task a tab's session holds now */
  private onCurrent(tabId: string, event: TaskEvent): void {
    const cur = this.currentOf(tabId)
    if (cur) this.advance(cur.session, cur.task.id, event)
  }

  /** the event applied to a task of a session: its new state is stored, or its outcome is reported; an event that does not apply changes nothing */
  private advance(session: string, taskId: string, event: TaskEvent): void {
    const h = this.d.store.hosted(session)
    const task = h?.tasks.find((t) => t.id === taskId)
    if (!h || !task) return
    const step = stepTask(task, event)
    if (step === null) return
    if ('task' in step) this.d.store.putHosted({ ...h, tasks: h.tasks.map((t) => (t.id === taskId ? step.task : t)) })
    else this.report(h, task, step.outcome, step.reason)
  }

  /** the settle of a Stop ran out: the task ends finished, if its session is still at rest on the same task */
  private rest(tabId: string, taskId: string): void {
    this.settle.delete(tabId)
    const cur = this.currentOf(tabId)
    if (!cur || cur.task.id !== taskId || this.inTurn.has(tabId) || !this.d.restingNow(tabId)) return
    this.advance(cur.session, taskId, { kind: 'rest' })
  }

  /** a task's outcome: the report goes to the coordinator, and the task leaves its session's entry */
  private report(h: StoredHosted, task: StoredTask, outcome: ReportOutcome, reason: string | null): void {
    // a task that never reached its session is marked delivered, so it is no unread mail
    if (task.state === 'queued') this.d.mail.mark([task.id], 'delivered')
    const lastMessage = this.answers.get(task.id) ?? null
    this.answers.delete(task.id)
    const previous = task.from.session === h.coordinator.session && task.from.device === h.coordinator.device ? null : task.from.name
    const id = this.write({
      kind: 'report',
      from: this.address(null, h.session),
      to: this.address(h.coordinator.device, h.coordinator.session),
      replyTo: task.id,
      text: reportText({ outcome, reason, lastMessage, previous }),
      outcome,
      ...(reason === null ? {} : { reason }),
      delivered: false,
      read: false
    })
    if (id === null) {
      this.d.log.warn(`coordinator: the report of the task of ${h.session} was not saved; its outcome is kept on the coordinator's row`)
      // the coordinator's row still shows the outcome, as its attachment's last report; the store drops an attachment whose
      // report has no UUID id on the next load, so the id is the task's own when newId gives no UUID
      const c = h.coordinator.device === null ? this.d.store.coordinator(h.coordinator.session) : null
      if (c) {
        const newId = this.d.newId()
        const lastReport = { id: isUuid(newId) ? newId : task.id, outcome, reason, at: this.d.now() }
        this.patchAttachment(c, h.session, { lastReport, failed: outcome === 'failed' })
      }
    }
    const now = this.d.store.hosted(h.session)
    if (now) this.d.store.putHosted({ ...now, tasks: now.tasks.filter((t) => t.id !== task.id) })
    this.d.recheckMail()
    const tab = this.tabOfSession(h.session)
    if (tab) this.d.poke(tab.tabId)
    this.d.changed()
  }

  /** cancels a tab's settle timer, when one waits */
  private cancelSettle(tabId: string): void {
    this.settle.get(tabId)?.()
    this.settle.delete(tabId)
  }

  /** a record the hub makes, checked: null when the mail check refuses it, and the reason is logged */
  private record(r: RecordInput): MailRecord | null {
    const record = checkMailRecord({ v: 1, id: this.d.newId(), sentAt: this.d.now(), delivered: false, read: false, ...r })
    if (record === null) this.d.log.warn(`coordinator: a ${kindOf(r)} record for ${r.to.session} was refused by the mail check`)
    return record
  }

  /** writes a record the hub makes: null when the mail check refuses it */
  private write(r: RecordInput): string | null {
    const record = this.record(r)
    if (record === null) return null
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
    return { device: device ?? (this.d.self() || null), session, name: this.nameOf(session) }
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
