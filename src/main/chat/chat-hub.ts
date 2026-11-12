import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatAnswer, ChatAttachment, ChatCard, ChatCommandInfo, ChatItem, ChatModelInfo, ChatPatch, ChatPermissionMode, ChatSend, ChatSnapshot } from '../../shared/chat'
import { isUuid } from '../../shared/protocol'
import { MAX_CHAT_PUSH_BYTES } from '../../shared/remote'
import type { ImageCard, TabInfo } from '../../shared/types'
import type { ChatHandle, ChatStartRequest } from '../tab-manager'
import { AttachedFiles, prepareMessage, type AttachDeps } from './chat-attachments'
import { capSnapshot } from './chat-mirror'
import { answeredLine, cardFor, resultFor, type PermissionAsk, type SdkPermissionResult } from './chat-cards'
import type { ChatEngine, ChatEngineHandlers, StartChatEngine } from './chat-engine'
import { ChatModel, isPermissionMode } from './chat-model'
import { sessionFolderOf } from './chat-folder'
import type { ChatLaunch } from './claude-spawn'

// One conversation model per Claude tab, in the main process: the engine's messages fold into it, the chat window gets
// its patches in batches, and the permission cards wait here for the user's answers.

/** the patches of the tab in front go out together at most this often */
const BATCH_MS = 16
/** the patches of a tab a member watches go out together at most this often, whatever tab the window shows */
const REMOTE_BATCH_MS = 50
const NOT_RUNNING = 'Claude Code is not running in this tab'
const STARTING = 'Starting Claude…'
const CANCELLED = 'Cancelled'
/** exit codes of a command that cannot run: 126 and 127 (POSIX), 9009 (cmd.exe "not recognized") */
const CANNOT_RUN = new Set([126, 127, 9009])
const REASON_CAP = 500
/** the modes every chat offers; Auto joins them once Claude Code reports it (the account may have it) */
const MODES: ChatPermissionMode[] = ['default', 'acceptEdits', 'plan']
/** a command name part that is a file or folder name of its own: a name from Claude Code is never a path part beyond that */
/** the effort levels Claude Code applies */
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
const COMMAND_PART = /^\w[\w.-]*$/

/**
 * whether the folder defines the command: .claude/commands/<name>.md, a namespaced dir:name as
 * .claude/commands/dir/name.md, or a skill .claude/skills/<name>/
 */
async function isProjectCommand(folder: string, name: string): Promise<boolean> {
  const parts = name.split(':')
  if (parts.length > 2 || !parts.every(part => COMMAND_PART.test(part))) return false
  const file = stat(join(folder, '.claude', 'commands', ...parts.slice(0, -1), `${parts[parts.length - 1]}.md`)).then(s => s.isFile(), () => false)
  const skill = parts.length === 1
    ? stat(join(folder, '.claude', 'skills', name)).then(s => s.isDirectory(), () => false)
    : Promise.resolve(false)
  return (await file) || (await skill)
}

/** the first line of a stderr chunk that has text on it, capped; null when it has none */
const firstLine = (text: string): string | null => text.split('\n').map(line => line.trim()).find(line => line !== '')?.slice(0, REASON_CAP) ?? null

export interface ChatHubDeps {
  engine: StartChatEngine
  support(tab: TabInfo, env: Record<string, string>): Promise<{ launch: Exclude<ChatLaunch, { how: 'none' }> } | { reason: string }>
  history(sessionId: string, folder: string): Promise<unknown[]>     // getSessionMessages with includeSystemMessages
  window(tabId: string, fromRev: number, toRev: number, patches: ChatPatch[]): void
  /** the patches of a tab a member watches, in a batch of their own: the members get them whatever tab the window shows */
  remote(tabId: string, fromRev: number, toRev: number, patches: ChatPatch[]): void
  /** whether a member watches the tab now: its patches are gathered for `remote` */
  watched(tabId: string): boolean
  activeTabId(): string | null
  exists(tabId: string): boolean                                     // the app still has the tab (tabs.get, index.ts)
  cards(tabId: string): ImageCard[]                                  // the Media-panel cards of the tab (images.list)
  attach: AttachDeps                                                 // the files a message carries: stat, read and scale (index.ts)
  setSession(tabId: string, sessionId: string): void                 // tabs.setClaudeSession(tabId, id, 'startup')
  setWorking(tabId: string, working: boolean): void
  status(tabId: string, s: ReturnType<ChatModel['status']>): void
  recordSession(sessionId: string): void
  /** the session works in another folder now (it entered or left a worktree): an absolute path Claude Code named, not yet checked to exist */
  folder(tabId: string, path: string): void
  now(): number
  log: { warn(m: string): void }
}

type Support = Awaited<ReturnType<ChatHubDeps['support']>>

/** a permission card waiting for the user: its ask, the card, and the promise the SDK waits on */
interface PendingCard {
  ask: PermissionAsk
  card: ChatCard
  resolve(result: SdkPermissionResult): void
  signal: AbortSignal
  onAbort(): void
}

/** a Claude tab's chat, from its start to its end */
interface Live {
  tabId: string
  req: ChatStartRequest
  model: ChatModel
  /** the running engine; null until the support check has passed */
  engine: ChatEngine | null
  /** messages sent while the engine starts: shown at once, sent to the engine when it runs, in the order typed; their files are read already */
  waiting: { text: string; images: { mediaType: string; data: string }[]; id: string }[]
  /** the process ended or the start was cancelled: nothing more is started, sent or drawn */
  ended: boolean
  /** Claude Code has answered initialize: the start is over, and an exit now is not a failed start */
  ready: boolean
  /** the models Claude Code lists, from its answer to the start: whether the model the chat runs takes auto mode decides the modes */
  models: ChatModelInfo[]
  /** Claude Code refused the auto mode while the chat ran this model: Auto is not offered while it runs that model */
  autoRefused: { model: string | null } | null
  /** messages sent before ready, waiting or handed to the engine: Claude Code may not have taken them if the start fails */
  unready: number
  /** the id a new session starts with, passed to the engine ('' when resuming: not used then) */
  newSessionId: string
  /** the first line Claude Code wrote to stderr before it was ready: the reason of a failed start */
  firstStderr: string | null
  /** the 'Starting Claude…' notice, until init or the end; kept beside the model's items, so it is always drawn last */
  starting: ChatItem | null
  /** a restart of a resumed session: the column the chat replaces, shown until the history of the session is in */
  kept: { items: ChatItem[]; hasOlder: boolean } | null
  /** the chat was started by a restart: when Claude Code is ready, the restart's line goes and the column says it restarted */
  restarted: boolean
  /** while the history loads: what the process said meanwhile, run in order once the history is in */
  early: (() => void)[] | null
  /** asks that came while the history loads: their card opens once it is in; cancelled if the chat ends first */
  queued: Map<string, { resolve(result: SdkPermissionResult): void; signal: AbortSignal; onAbort(): void }>
  /** the tab asked the process to end (stop or kill): its exit is not an error */
  stopping: boolean
  /** the process exited while the history loaded: its end is drawn once the history is in */
  exitDue: boolean
  /** a turn runs or waits on a card, as last reported to the tab */
  working: boolean
  /** the patches counted so far: the rev of the chat as the window knows it */
  rev: number
  /** patches of the tab in front waiting for their batch, and the rev before the first of them */
  batch: ChatPatch[]
  batchFrom: number
  timer: ReturnType<typeof setTimeout> | null
  /** patches of a tab a member watches waiting for their batch to the members, and the rev before the first of them */
  remoteBatch: ChatPatch[]
  remoteFrom: number
  remoteTimer: ReturnType<typeof setTimeout> | null
  cards: Map<string, PendingCard>
}

/**
 * The list's entry for the model the chat runs: the one whose value is the model, else the one whose resolved id is (of several
 * that resolve to it, one that is not `default` wins). Before the first init names a model, the `default` entry stands for it.
 */
function modelEntry(list: ChatModelInfo[], model: string | null): ChatModelInfo | undefined {
  if (model === null) return list.find(m => m.value === 'default') ?? list[0]
  const byValue = list.find(m => m.value === model)
  if (byValue !== undefined) return byValue
  const byResolved = list.filter(m => m.resolved === model)
  return byResolved.find(m => m.value !== 'default') ?? byResolved[0]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500)
const cancelled = (): SdkPermissionResult => ({ behavior: 'deny', message: CANCELLED })

export class ChatHub {
  private readonly tabs = new Map<string, Live>()
  /** the files the window was handed per tab: the only files its messages may carry */
  private readonly attached = new AttachedFiles()
  /** the last send of each tab: the next one waits for it, so the messages keep the order the user sent them in */
  private readonly sendChain = new Map<string, Promise<unknown>>()
  /** the tabs whose Claude Code reported mode auto: kept across its restarts, dropped with the tab */
  private readonly autoTabs = new Set<string>()
  /** notices for a tab whose chat is not running: shown once its next start's history is in */
  private readonly carried = new Map<string, string[]>()
  /** the revision each tab's chat stood at when its chat ended: the next chat of the tab counts on from it, so the window and the members never see a revision go back */
  private readonly revs = new Map<string, number>()
  /** the tabs whose Claude Code is being restarted: the next chat of each one is a restart's */
  private readonly restarts = new Set<string>()

  constructor(private readonly d: ChatHubDeps) {}

  /** a restart of the tab's Claude Code begins: the chat says so at once, and the chat that starts in its place carries it until Claude Code is ready */
  restarting(tabId: string): void {
    this.restarts.add(tabId)
    const live = this.tabs.get(tabId)
    if (live && !live.ended) this.publish(live, live.model.setState({ activity: { kind: 'restarting', since: this.d.now() } }))
  }

  /** the relaunch of a tab starts another conversation or folder, not a restart of its own: the restart said is none, and the chat starts new */
  newConversation(tabId: string): void {
    this.restarts.delete(tabId)
    const live = this.tabs.get(tabId)
    if (live && !live.ended && live.model.state().activity?.kind === 'restarting') this.publish(live, live.model.setState({ activity: undefined }))
  }

  /** starts the chat process of a tab: its model at once, its history first when it resumes one */
  start(req: ChatStartRequest): ChatHandle {
    const tabId = req.tab.id
    const resume = req.claude.resumeSessionId
    // a restart of the tab keeps the column of the chat it replaces while the history of its session loads
    const restart = this.restarts.delete(tabId)
    const replaced = this.tabs.get(tabId)
    const kept = restart && resume !== null && replaced !== undefined ? replaced.model.page() : null
    this.remove(tabId)
    const newSessionId = resume === null ? randomUUID() : ''
    const live: Live = {
      tabId, req, engine: null, waiting: [], ended: false, ready: false, models: [], autoRefused: null, unready: 0, newSessionId, firstStderr: null, starting: null, early: null,
      kept: null, restarted: restart,
      queued: new Map(), stopping: false, exitDue: false, working: false,
      rev: this.revs.get(tabId) ?? 0, batch: [], batchFrom: 0, timer: null, remoteBatch: [], remoteFrom: 0, remoteTimer: null, cards: new Map(),
      model: new ChatModel({ now: () => this.d.now(), newId: () => randomUUID(), folder: () => req.tab.cwd }),
    }
    this.tabs.set(tabId, live)
    // the session is known at once: the resumed one, or the new one; a fork's comes with its SessionStart or its first init
    live.model.setState({ sessionId: req.claude.forkSession ? null : (resume ?? newSessionId) })
    if (restart) live.model.setState({ activity: { kind: 'restarting', since: this.d.now() } })
    if (kept !== null) {
      live.kept = kept
    } else {
      const starting: ChatItem = { kind: 'notice', id: randomUUID(), tone: 'info', text: STARTING, action: null }
      live.starting = starting
      this.emit(live, [{ op: 'reset', items: [starting], hasOlder: false }])
    }
    // the restart's line reaches the window at once, with the state it starts from
    if (restart) this.emit(live, [{ op: 'state', state: live.model.state() }])

    if (resume !== null) {
      live.early = []
      void this.loadHistory(live, resume)
    }
    // the notices said while the tab had no chat: after the history of a resumed one, as the chat's first lines
    const carried = this.carried.get(tabId) ?? []
    this.carried.delete(tabId)
    for (const text of carried) this.whenLoaded(live, () => this.publish(live, live.model.notice(text, 'info', null)))
    void this.d.support(req.tab, req.env).then(
      support => this.begin(live, support),
      (e: unknown) => this.begin(live, { reason: `Claude Code could not start: ${errorText(e)}` }),
    )
    return {
      stop: () => {
        if (live.ended) return
        live.stopping = true
        if (live.engine) live.engine.close()
        else this.finish(live, null, null)
      },
      kill: () => {
        if (live.ended) return
        live.stopping = true
        if (live.engine) live.engine.kill()
        else this.finish(live, null, null)
      },
    }
  }

  snapshot(tabId: string): ChatSnapshot | null {
    const live = this.tabs.get(tabId)
    if (!live) return null
    // the snapshot holds the changes made so far; the batch waiting still goes, and the window skips what it already has
    // a restart's column stays until the history of its session is in
    const page = live.kept ?? live.model.page()
    return { tabId, rev: live.rev, items: this.withStarting(live, page.items), hasOlder: page.hasOlder, state: live.model.state() }
  }

  /** the chat as a member's push takes it: the snapshot cut to the push's cap; null for a tab with no chat */
  remoteSnapshot(tabId: string): ChatSnapshot | null {
    const s = this.snapshot(tabId)
    return s === null ? null : capSnapshot(s, MAX_CHAT_PUSH_BYTES)
  }

  /** null: sent, or queued behind the running turn; else why it was not sent */
  send(tabId: string, s: ChatSend): Promise<string | null> {
    // the sends of a tab run one after another: a message whose files are still read does not let a later one overtake it
    const run = (this.sendChain.get(tabId) ?? Promise.resolve()).then(() => this.deliver(tabId, s))
    const tail = run.then(() => undefined, () => undefined)
    this.sendChain.set(tabId, tail)
    void tail.then(() => {
      if (this.sendChain.get(tabId) === tail) this.sendChain.delete(tabId)
    })
    return run
  }

  /** the window was handed these files for the tab: its messages may carry them */
  allow(tabId: string, attachments: ChatAttachment[]): void {
    this.attached.add(tabId, attachments)
  }

  /** a message: its files read and scaled first; then shown and sent, or held while Claude Code starts */
  private async deliver(tabId: string, s: ChatSend): Promise<string | null> {
    const live = this.tabs.get(tabId)
    if (!live || live.ended) return NOT_RUNNING
    const prepared = await prepareMessage(s, live.req.tab.cwd, path => this.attached.get(tabId, path), this.d.attach)
    if ('refused' in prepared) return prepared.refused
    // the bubble shows the attachments as main knows them: the window's names and sizes are not trusted
    const shown: ChatSend = { text: s.text, attachments: prepared.attachments, ...(s.from === undefined ? {} : { from: s.from }) }
    // the bubble's id is the uuid the message goes out with: Claude Code names it when it takes the message into a turn
    const id = randomUUID()
    // the tab may have ended while its files were read
    if (this.tabs.get(tabId) !== live || live.ended) return NOT_RUNNING
    // the chat is starting: the message is shown now, and goes to the engine once it runs
    if (live.engine === null) {
      this.whenLoaded(live, () => {
        if (live.ended) return
        this.publish(live, live.model.userSent(shown, id))
      })
      live.waiting.push({ text: prepared.text, images: prepared.images, id })
      live.unready += 1
      return null
    }
    const engine = live.engine
    if (!live.ready) live.unready += 1
    this.whenLoaded(live, () => {
      if (live.ended) return
      this.publish(live, live.model.userSent(shown, id))
      engine.send(prepared.text, prepared.images, id)
    })
    return null
  }

  interrupt(tabId: string): void {
    const run = this.running(tabId)
    if (!run) return
    run.live.model.markInterrupted()
    run.engine.interrupt().catch((e: unknown) => this.d.log.warn(`cannot interrupt the turn: ${errorText(e)}`))
  }

  /** the user answered a card; false when there is no such card waiting, or the answer does not fit it */
  answer(tabId: string, cardId: string, a: ChatAnswer): boolean {
    const live = this.tabs.get(tabId)
    const pending = live?.cards.get(cardId)
    if (!live || !pending) return false
    const result = resultFor(pending.ask, pending.card, a)
    if (result === null) return false
    return this.settle(live, cardId, result, answeredLine(pending.card, a))
  }

  async setMode(tabId: string, mode: ChatPermissionMode): Promise<void> {
    const run = this.running(tabId)
    if (!run) return
    try {
      await run.engine.setPermissionMode(mode)
    } catch (e) {
      if (mode === 'auto') this.refuseAuto(run.live, e)
      throw e
    }
    this.publish(run.live, run.live.model.setState({ mode }))
  }

  /** Claude Code refused the auto mode: its mode stays, the refusal is shown, and Auto is not offered while the chat runs this model */
  private refuseAuto(live: Live, e: unknown): void {
    live.autoRefused = { model: live.model.state().model }
    this.publish(live, live.model.notice(`Claude Code did not switch to Auto mode: ${errorText(e)}`, 'error', null))
  }

  async setModel(tabId: string, model: string | null, effort: string | null): Promise<void> {
    const run = this.running(tabId)
    if (!run) return
    // each one is in state once Claude Code runs it: a failed effort leaves the model shown as the one that runs
    await run.engine.setModel(model)
    this.publish(run.live, run.live.model.setState({ model }))
    await run.engine.setEffort(effort)
    this.publish(run.live, run.live.model.setState({ effort }))
    // the level Claude Code applies may differ from the one asked (a model without effort, an organization's limit)
    this.readEffort(run.live)
  }

  /** whether the tab has a chat that runs now: its process is up and has not ended */
  isRunning(tabId: string): boolean {
    return this.running(tabId) !== null
  }

  /** the permission modes the tab offers, in the order Claude Code cycles them: Auto once its Claude Code reported it, or the model the chat runs takes it */
  modes(tabId: string): ChatPermissionMode[] {
    return this.offersAuto(tabId) ? [...MODES, 'auto'] : [...MODES]
  }

  private offersAuto(tabId: string): boolean {
    const live = this.tabs.get(tabId)
    if (live === undefined) return this.autoTabs.has(tabId)
    const model = live.model.state().model
    if (live.autoRefused !== null && live.autoRefused.model === model) return false
    return this.autoTabs.has(tabId) || modelEntry(live.models, model)?.autoMode === true
  }

  /** a notice for the tab's chat: shown now when the chat runs, else once its next start's history is in */
  noteForChat(tabId: string, text: string): void {
    // a tab the app has closed keeps no note for a later start
    if (!this.d.exists(tabId)) return
    const live = this.tabs.get(tabId)
    if (live && !live.ended) {
      this.whenLoaded(live, () => this.publish(live, live.model.notice(text, 'info', null)))
      return
    }
    this.carried.set(tabId, [...(this.carried.get(tabId) ?? []), text])
  }

  async stopTask(tabId: string, taskId: string): Promise<void> {
    const run = this.running(tabId)
    if (run) await run.engine.stopTask(taskId)
  }

  /** the engine's commands; one the tab's folder defines is a project command, whatever the engine named its group */
  async commands(tabId: string): Promise<ChatCommandInfo[]> {
    const run = this.running(tabId)
    if (!run) return []
    const folder = run.live.req.tab.cwd
    return Promise.all((await run.engine.commands()).map(async (c): Promise<ChatCommandInfo> => {
      if (c.group === 'builtin' || !(await isProjectCommand(folder, c.name))) return c
      return { ...c, group: 'project' }
    }))
  }

  async models(tabId: string): Promise<ChatModelInfo[]> {
    const run = this.running(tabId)
    return run ? run.engine.models() : []
  }

  /** the page before an item, as an answer to the one who asked: no revision, no patch */
  older(tabId: string, beforeId: string): { items: ChatItem[]; hasOlder: boolean } | null {
    const live = this.tabs.get(tabId)
    if (!live) return null
    return live.model.older(beforeId)
  }

  /** the Media-panel cards of a tab changed: the images of its chat that have no card yet take the card of their path */
  imagesChanged(tabId: string, cards: ImageCard[]): void {
    const live = this.tabs.get(tabId)
    if (!live) return
    this.whenLoaded(live, () => this.publish(live, live.model.attachCards(cards)))
  }

  /** the session changed under the tab: a clear, a startup, a resume or a compaction */
  sessionChanged(tabId: string, sessionId: string, source: string): void {
    const live = this.tabs.get(tabId)
    if (!live) return
    this.whenLoaded(live, () => {
      if (sessionId === live.model.state().sessionId) return
      // a clear or a compaction starts a new part of the chat; a startup or a resume only says which session it is
      // a compaction's divider is its boundary's: the SessionStart that comes with it draws none
      const text = source === 'clear' ? 'New conversation' : null
      const divider = text === null ? [] : live.model.divider(text)
      this.publish(live, [...divider, ...live.model.setState({ sessionId })])
    })
  }

  /** the window shows this tab now: the batches of the others stop */
  activated(tabId: string): void {
    for (const live of this.tabs.values()) {
      if (live.tabId !== tabId) this.clearBatch(live)
    }
  }

  /** a closed tab: its chat ends as Claude Code ends by itself, and is killed only after the engine's grace */
  removeTab(tabId: string): void {
    this.remove(tabId, 'close')
    this.revs.delete(tabId)
    this.attached.forget(tabId)
    this.autoTabs.delete(tabId)
    this.restarts.delete(tabId)
    this.carried.delete(tabId)
  }

  /** the engine's end: its cards and its process are over; a process still running is killed at once (a restart, the app's quit) */
  private remove(tabId: string, how: 'kill' | 'close' = 'kill'): void {
    const live = this.tabs.get(tabId)
    if (!live) return
    this.tabs.delete(tabId)
    this.revs.set(tabId, live.rev)
    this.clearBatch(live)
    this.clearRemote(live)
    if (live.ended) return
    live.ended = true
    this.cancelQueued(live)
    for (const id of [...live.cards.keys()]) this.settle(live, id, cancelled(), CANCELLED)
    if (how === 'close') live.engine?.close()
    else live.engine?.kill()
  }

  /** the running engine of a tab, when its process runs */
  private running(tabId: string): { live: Live; engine: ChatEngine } | null {
    const live = this.tabs.get(tabId)
    if (!live || live.ended || live.engine === null) return null
    return { live, engine: live.engine }
  }

  private begin(live: Live, support: Support): void {
    if (live.ended) return
    if ('reason' in support) {
      this.finish(live, null, support.reason)
      return
    }
    const { req } = live
    const handlers: ChatEngineHandlers = {
      ready: info => this.whenLoaded(live, () => this.becomeReady(live, info)),
      message: m => this.whenLoaded(live, () => this.apply(live, m)),
      ask: (ask, signal) => this.ask(live, ask, signal),
      dialog: () => this.whenLoaded(live, () => this.publish(live, live.model.notice('Claude Code asked something the chat cannot show yet', 'info', 'open-terminal'))),
      stderr: text => {
        if (!live.ready && live.firstStderr === null) live.firstStderr = firstLine(text)
        this.d.log.warn(`Claude Code wrote to stderr: ${text.slice(0, 500)}`)
      },
      // not held while the history loads: an exit ends the queued asks at once
      exit: code => this.stopped(live, code),
    }
    try {
      const engine = this.d.engine(
        {
          launch: support.launch, cwd: req.tab.cwd, env: req.env, settingsPath: req.claude.settingsPath, sessionId: req.claude.resumeSessionId,
          newSessionId: live.newSessionId, fork: req.claude.forkSession,
        },
        handlers,
      )
      live.engine = engine
      // the messages sent while it started go out now, in the order they were typed
      const waiting = live.waiting
      live.waiting = []
      for (const message of waiting) engine.send(message.text, message.images, message.id)
    } catch (e) {
      this.finish(live, null, `Claude Code could not start: ${errorText(e)}`)
    }
  }

  /** Claude Code has answered initialize: the start is over, and the mode it reports is the chat's */
  private becomeReady(live: Live, info: { permissionMode: string | null; models?: ChatModelInfo[] }): void {
    if (live.ended || live.ready) return
    live.ready = true
    live.unready = 0
    live.models = info.models ?? []
    this.dropStarting(live)
    if (info.permissionMode === 'auto') this.autoTabs.add(live.tabId)
    const mode = isPermissionMode(info.permissionMode) ? live.model.setState({ mode: info.permissionMode }) : []
    // the state goes out even when nothing in it changed: the window asks for the modes again, now that the models are known
    this.publish(live, [...mode, ...this.restartEnded(live), { op: 'state', state: live.model.state() }])
    this.readEffort(live)
  }

  /** the effort Claude Code applies, as the settings report it: a known level or null goes to the state, anything else keeps the last */
  private readEffort(live: Live): void {
    const engine = live.engine
    if (!engine) return
    engine.effort().then(
      level => {
        if (live.ended || this.tabs.get(live.tabId) !== live) return
        if (level !== null && !(typeof level === 'string' && EFFORT_LEVELS.includes(level))) return
        if (live.model.state().effort === level) return
        this.publish(live, live.model.setState({ effort: level }))
        this.report(live)
      },
      (e: unknown) => this.d.log.warn(`cannot read the effort: ${errorText(e)}`),
    )
  }

  /** the restart is over: its line goes, and the column says the session restarted */
  private restartEnded(live: Live): ChatPatch[] {
    if (!live.restarted) return []
    live.restarted = false
    return [...live.model.setState({ activity: undefined }), ...live.model.divider('Session restarted')]
  }

  /** the process has ended before it ran, or its start was cancelled: the tab gets its exit now */
  private finish(live: Live, code: number | null, fallback: string | null): void {
    live.ended = true
    live.restarted = false
    this.dropStarting(live)
    // a compaction or a restart that never ends is over with the process
    this.publish(live, live.model.setState({ activity: undefined }))
    // the messages that were shown but never reached a started process say so: those still waiting, and those handed to the engine
    if (live.unready > 0) {
      live.waiting = []
      live.unready = 0
      this.publish(live, live.model.notice('Not sent: Claude Code did not start', 'error', null))
    }
    live.req.exit(code, fallback)
  }

  /** a message, a card or an end that comes while the history loads waits, so the history comes first in the model */
  private whenLoaded(live: Live, run: () => void): void {
    if (live.ended) return
    if (live.early !== null) live.early.push(run)
    else run()
  }

  /** a resumed conversation: its history folds into the model, then one reset patch carries it to the window */
  private async loadHistory(live: Live, sessionId: string): Promise<void> {
    let messages: unknown[] = []
    try {
      const got = await this.d.history(sessionId, live.req.tab.cwd)
      if (Array.isArray(got)) messages = got
    } catch (e) {
      this.d.log.warn(`cannot read the history of ${sessionId}: ${errorText(e)}`)
    }
    // a removed tab draws nothing; a chat that ended meanwhile still draws its history, then its end
    if (this.tabs.get(live.tabId) !== live) {
      this.cancelQueued(live)
      return
    }
    for (const msg of messages) live.model.apply(msg)
    // the history is in: a call it left running was cut off, so it ends here (its patches are in the reset below)
    live.model.historyLoaded()
    // the images of the history take the cards the panel holds; their change is in the reset below
    live.model.attachCards(this.d.cards(live.tabId))
    const page = live.model.page()
    live.kept = null
    this.emit(live, [{ op: 'reset', items: this.withStarting(live, page.items), hasOlder: page.hasOlder }])
    this.syncWorking(live)
    const early = live.early ?? []
    live.early = null
    for (const run of early) run()
    if (live.exitDue) this.drawEnd(live)
  }

  private apply(live: Live, msg: unknown): void {
    const patches = live.model.apply(msg)
    this.publish(live, patches)
    // an image the chat shows may have its card already: the panel does not change again to bring it
    if (patches.some(p => (p.op === 'add' || p.op === 'set') && p.item.kind === 'images')) this.publish(live, live.model.attachCards(this.d.cards(live.tabId)))
    if (!isObj(msg)) return
    const moved = sessionFolderOf(msg)
    if (moved !== null) this.d.folder(live.tabId, moved)
    // Claude Code names its mode in a status and in an init: auto in either one adds Auto to the modes of the tab
    if (msg.type === 'system' && (msg.subtype === 'status' || msg.subtype === 'init') && msg.permissionMode === 'auto') this.autoTabs.add(live.tabId)
    if (msg.type === 'system' && msg.subtype === 'init') {
      const sessionId = msg.session_id
      if (isUuid(sessionId)) {
        this.d.setSession(live.tabId, sessionId)
        this.d.recordSession(sessionId)
      }
      this.report(live)
    } else if (msg.type === 'rate_limit_event') {
      this.report(live)
    } else if (msg.type === 'result') {
      this.readContext(live)
    }
  }

  private readContext(live: Live): void {
    const engine = live.engine
    if (!engine) return
    this.readEffort(live)
    engine.context().then(
      c => {
        if (live.ended || this.tabs.get(live.tabId) !== live) return
        const pct = c.pct
        live.model.setContext({ pct: typeof pct === 'number' && Number.isFinite(pct) ? pct : null, used: c.used, size: c.size })
        this.report(live)
      },
      (e: unknown) => this.d.log.warn(`cannot read the context fill: ${errorText(e)}`),
    )
  }

  /** the status the tab shows: nothing until the stream has named the model */
  private report(live: Live): void {
    const status = live.model.status()
    if (status.model !== null) this.d.status(live.tabId, status)
  }

  /** an ask while the history loads waits in `queued`: it settles at once if the chat ends or its signal aborts first */
  private ask(live: Live, ask: Omit<PermissionAsk, 'folder'>, signal: AbortSignal): Promise<SdkPermissionResult> {
    return new Promise(resolve => {
      if (live.ended || signal.aborted) {
        resolve(cancelled())
        return
      }
      if (live.early === null) {
        this.openCard(live, ask, signal, resolve)
        return
      }
      const id = randomUUID()
      const onAbort = (): void => {
        if (live.queued.delete(id)) resolve(cancelled())
      }
      live.queued.set(id, { resolve, signal, onAbort })
      signal.addEventListener('abort', onAbort, { once: true })
      live.early.push(() => {
        const queued = live.queued.get(id)
        if (!queued) return
        live.queued.delete(id)
        signal.removeEventListener('abort', onAbort)
        this.openCard(live, ask, signal, resolve)
      })
    })
  }

  /** every ask still queued is cancelled: the chat ended before its history came */
  private cancelQueued(live: Live): void {
    for (const queued of live.queued.values()) {
      queued.signal.removeEventListener('abort', queued.onAbort)
      queued.resolve(cancelled())
    }
    live.queued.clear()
  }

  private openCard(live: Live, ask: Omit<PermissionAsk, 'folder'>, signal: AbortSignal, resolve: (result: SdkPermissionResult) => void): void {
    if (signal.aborted) {
      resolve(cancelled())
      return
    }
    const full: PermissionAsk = { ...ask, folder: live.req.tab.cwd }
    const card = cardFor(full)
    const id = randomUUID()
    const onAbort = (): void => {
      this.settle(live, id, cancelled(), CANCELLED)
    }
    live.cards.set(id, { ask: full, card, resolve, signal, onAbort })
    signal.addEventListener('abort', onAbort, { once: true })
    this.publish(live, live.model.cardOpened(id, card))
  }

  /** a card's answer, or its cancellation: the SDK gets the result, the card says how it was answered */
  private settle(live: Live, cardId: string, result: SdkPermissionResult, line: string): boolean {
    const pending = live.cards.get(cardId)
    if (!pending) return false
    live.cards.delete(cardId)
    pending.signal.removeEventListener('abort', pending.onAbort)
    pending.resolve(result)
    if (this.tabs.get(live.tabId) === live) this.publish(live, live.model.cardAnswered(cardId, line))
    return true
  }

  /**
   * The process ended: queued asks and open cards are cancelled at once, and the tab's exit is reported at once. The
   * end is drawn now, or, while the history still loads, once the history is drawn (loadHistory), so the history comes first.
   */
  private stopped(live: Live, code: number | null): void {
    if (live.ended || this.tabs.get(live.tabId) !== live) return
    // before ready, a command that cannot run is a failed start: the tab falls back to its terminal, as a failed support check does
    if (!live.ready && !live.stopping && code !== null && CANNOT_RUN.has(code)) {
      this.cancelQueued(live)
      for (const id of [...live.cards.keys()]) this.settle(live, id, cancelled(), CANCELLED)
      this.finish(live, null, `Claude Code could not be started for the chat: ${live.firstStderr ?? `exit code ${code}`}`)
      return
    }
    live.ended = true
    this.cancelQueued(live)
    for (const id of [...live.cards.keys()]) this.settle(live, id, cancelled(), CANCELLED)
    this.dropStarting(live)
    live.req.exit(code, null)
    if (live.early === null) this.drawEnd(live)
    else live.exitDue = true
  }

  /** the end of the process in the chat: its state, and the notice unless the tab asked for the stop */
  private drawEnd(live: Live): void {
    this.publish(live, live.model.processEnded())
    this.publish(live, live.model.setState({ turn: 'idle', turnStartedAt: null, exited: true, activity: undefined }))
    if (!live.stopping) this.publish(live, live.model.notice('Claude Code stopped', 'error', 'restart'))
  }

  private dropStarting(live: Live): void {
    if (live.starting === null) return
    const id = live.starting.id
    live.starting = null
    this.emit(live, [{ op: 'remove', id }])
  }

  private withStarting(live: Live, items: ChatItem[]): ChatItem[] {
    return live.starting === null ? items : [...items, live.starting]
  }

  /** model patches: they go to the window and tell the tab whether a turn runs */
  private publish(live: Live, patches: ChatPatch[]): void {
    this.emit(live, patches)
    this.syncWorking(live)
  }

  private syncWorking(live: Live): void {
    if (this.tabs.get(live.tabId) !== live) return
    const working = live.model.state().turn !== 'idle'
    if (working === live.working) return
    live.working = working
    this.d.setWorking(live.tabId, working)
  }

  /** counts the patches; the tab in front batches them for the window, a tab a member watches for the members, others' are not sent */
  private emit(live: Live, patches: ChatPatch[]): void {
    if (patches.length === 0 || this.tabs.get(live.tabId) !== live) return
    const from = live.rev
    live.rev += patches.length
    this.emitToWindow(live, from, patches)
    this.emitToMembers(live, from, patches)
  }

  private emitToWindow(live: Live, from: number, patches: ChatPatch[]): void {
    if (this.d.activeTabId() !== live.tabId) {
      this.clearBatch(live)
      return
    }
    if (live.batch.length === 0) live.batchFrom = from
    live.batch.push(...patches)
    if (live.timer === null) live.timer = setTimeout(() => this.flush(live), BATCH_MS)
  }

  private emitToMembers(live: Live, from: number, patches: ChatPatch[]): void {
    if (!this.d.watched(live.tabId)) {
      this.clearRemote(live)
      return
    }
    if (live.remoteBatch.length === 0) live.remoteFrom = from
    live.remoteBatch.push(...patches)
    if (live.remoteTimer === null) live.remoteTimer = setTimeout(() => this.flushRemote(live), REMOTE_BATCH_MS)
  }

  /** sends the members' batch waiting, when a member still watches its tab */
  private flushRemote(live: Live): void {
    if (live.remoteTimer !== null) clearTimeout(live.remoteTimer)
    live.remoteTimer = null
    const batch = live.remoteBatch
    if (batch.length === 0) return
    live.remoteBatch = []
    if (this.tabs.get(live.tabId) !== live || !this.d.watched(live.tabId)) return
    this.d.remote(live.tabId, live.remoteFrom, live.remoteFrom + batch.length, batch)
  }

  /** sends the batch waiting, when its tab is still in front */
  private flush(live: Live): void {
    if (live.timer !== null) clearTimeout(live.timer)
    live.timer = null
    const batch = live.batch
    if (batch.length === 0) return
    live.batch = []
    if (this.d.activeTabId() !== live.tabId || this.tabs.get(live.tabId) !== live) return
    this.d.window(live.tabId, live.batchFrom, live.batchFrom + batch.length, batch)
  }

  private clearBatch(live: Live): void {
    if (live.timer !== null) clearTimeout(live.timer)
    live.timer = null
    live.batch = []
  }

  private clearRemote(live: Live): void {
    if (live.remoteTimer !== null) clearTimeout(live.remoteTimer)
    live.remoteTimer = null
    live.remoteBatch = []
  }
}
