import type { ChatAnswer, ChatCommandInfo, ChatItem, ChatModelInfo, ChatPermissionMode, ChatSend, TabView } from '../../shared/chat'
import type { DeviceResult } from '../../shared/devices'
import { IMAGE_CACHE_BYTES, IMAGE_PART_TIMEOUT_MS, IMAGE_READS_AT_ONCE, LIST_TIMEOUT_MS, REMOTE_COPY, type DeviceAnswer, type DeviceChoices, type FolderResult, type RemoteTab } from '../../shared/remote'
import { NOT_RUNNING, type ReviewSendState } from '../../shared/review'
import type { ImageCard, RecentSession, TabInfo } from '../../shared/types'
import { CallError } from './calls'
import { CALL_REPLIES, type CallArgs, type CallMethod, type CallReplies, type ReviewAction } from './remote-shapes'
import type { RemoteTabs } from './tab-viewer'

// What this device asks of another device about its tabs: the calls of the tab menu, the close and the rename, and the
// answers, refused by the words the window shows. The new-tab menu's lists (each device's profiles and accounts) are
// kept per device, answered at once from what came last, and refreshed in the background.

export interface AskOptions {
  timeoutMs?: number
  bulk?: boolean
}

/**
 * The Media cards of the other devices' tabs this window shows, and the bytes it keeps of them. A card is known as the
 * tab that pushed it. Bytes are kept for one version of a card; the least recently used go first once more than
 * `maxBytes` are held, and a buffer larger than that is not kept at all.
 */
export class RemoteImages {
  private readonly cards = new Map<string, ImageCard>()
  private readonly tabCards = new Map<string, Set<string>>()
  /** the bytes kept, in order of use: the first entry is the least recently used */
  private readonly kept = new Map<string, { version: number; data: Buffer }>()
  private keptBytes = 0

  constructor(private readonly maxBytes = IMAGE_CACHE_BYTES) {}

  /** a tab's cards as its device pushed them: a card the push no longer lists goes with its bytes, a card whose version changed loses its bytes */
  setCards(tabId: string, cards: ImageCard[]): void {
    const before = this.tabCards.get(tabId) ?? new Set<string>()
    const now = new Set<string>()
    for (const c of cards) {
      if (c.tabId !== tabId) continue
      const prev = this.cards.get(c.id)
      // an id another tab holds is not taken over: the card belongs to the tab that pushed it first
      if (prev && prev.tabId !== tabId) continue
      if (prev && prev.version !== c.version) this.forgetBytes(c.id)
      this.cards.set(c.id, { ...c })
      now.add(c.id)
    }
    for (const id of before) if (!now.has(id)) this.forget(id)
    this.tabCards.set(tabId, now)
  }

  /** the card with this id, from the tab that pushed it; null when no tab of another device has it */
  card(cardId: string): ImageCard | null {
    return this.cards.get(cardId) ?? null
  }

  /** the bytes kept for the card at this version, which become the most recently used; null for another version or none */
  cached(cardId: string, version: number): Buffer | null {
    const hit = this.kept.get(cardId)
    if (!hit || hit.version !== version) return null
    this.kept.delete(cardId)
    this.kept.set(cardId, hit)
    return hit.data
  }

  /** keeps the bytes of a card this window knows, at the version the card has now; the least recently used go when the cache is full */
  store(cardId: string, version: number, data: Buffer): void {
    if (this.cards.get(cardId)?.version !== version) return
    this.forgetBytes(cardId)
    if (data.length > this.maxBytes) return
    this.kept.set(cardId, { version, data })
    this.keptBytes += data.length
    for (const id of this.kept.keys()) {
      if (this.keptBytes <= this.maxBytes) break
      this.forgetBytes(id)
    }
  }

  /** a tab closed on its device: its cards and their bytes go */
  dropTab(tabId: string): void {
    for (const id of this.tabCards.get(tabId) ?? []) this.forget(id)
    this.tabCards.delete(tabId)
  }

  /** everything goes: the group closed */
  clear(): void {
    this.cards.clear()
    this.tabCards.clear()
    this.kept.clear()
    this.keptBytes = 0
  }

  private forget(cardId: string): void {
    this.cards.delete(cardId)
    this.forgetBytes(cardId)
  }

  private forgetBytes(cardId: string): void {
    const old = this.kept.get(cardId)
    if (!old) return
    this.kept.delete(cardId)
    this.keptBytes -= old.data.length
  }
}

/** the calls one device makes to another; a refusal reaches the window as its message */
export class RemoteActions {
  /** the last whole answer of each device's lists: kept while the device stops answering */
  private readonly kept = new Map<string, DeviceChoices>()
  /** the last Recent sessions each device answered: kept the same way */
  private readonly keptSessions = new Map<string, RecentSession[]>()
  /** the list calls out now, by device and method: a refresh does not ask again while one is out */
  private readonly out = new Map<string, Promise<unknown>>()
  /** the image bytes being read now, by card and version: a call for a card's version that is read already shares that read */
  private readonly fetching = new Map<string, Promise<{ version: number; data: Buffer } | null>>()
  /** the image part calls of each device: those out, and the reads waiting for their turn */
  private readonly lanes = new Map<string, { out: number; waiting: (() => void)[] }>()

  constructor(
    private readonly tabs: RemoteTabs,
    private readonly toast: (m: string) => void,
    private readonly onFresh?: (what: 'choices' | 'sessions') => void
  ) {}

  /**
   * A call to a device. Rejects with the device's refusal, or with the window's words for an offline device, a device that
   * does not answer in time, and an answer of the wrong shape.
   */
  async ask<M extends CallMethod>(device: string, m: M, a: CallArgs[M], opts: AskOptions = {}): Promise<CallReplies[M]> {
    const name = this.nameOf(device)
    const calls = this.tabs.callsOf(device)
    if (!calls) throw new CallError(REMOTE_COPY.deviceOffline(name))
    let v: unknown
    try {
      v = await calls.call(m, a, opts)
    } catch (e) {
      throw refusalOf(e, name)
    }
    const parse: (x: unknown) => unknown = CALL_REPLIES[m]
    const reply = parse(v) as CallReplies[M] | null
    if (reply === null) throw new CallError('bad reply')
    return reply
  }

  /** a call about one of the device's tabs: the device is the one the tab runs on */
  async askTab<M extends CallMethod>(tabId: string, m: M, a: CallArgs[M], opts: AskOptions = {}): Promise<CallReplies[M]> {
    const device = this.tabs.deviceOf(tabId)
    if (device === null) throw new CallError(REMOTE_COPY.unknownTab)
    return this.ask(device, m, a, opts)
  }

  /** every online device with its last whole answer (null: none yet), in the order of RemoteTabs.devices(); at once */
  choicesNow(): DeviceAnswer<DeviceChoices>[] {
    return this.tabs
      .devices()
      .filter((d) => d.online)
      .map((d) => ({ device: d.id, name: d.name, value: this.kept.get(d.id) ?? null }))
  }

  /**
   * Asks every online device its profiles and accounts at once, in the background. A device's list call still out is not
   * asked again. Both lists answered keeps the answer, and a kept answer that changes calls onFresh('choices'); a list
   * refused or not answered in time keeps the last one.
   */
  refreshChoices(): void {
    for (const d of this.tabs.devices()) {
      if (!d.online) continue
      const device = d.id
      void Promise.all([this.listCall(device, 'profiles'), this.listCall(device, 'accounts')]).then(([profiles, accounts]) => {
        if (profiles === null || accounts === null) return
        this.keep(device, { profiles, accounts })
      })
    }
  }

  /** every online device with its last Recent sessions (null: none yet), each session with its device; at once */
  sessionsNow(): DeviceAnswer<RecentSession[]>[] {
    return this.tabs
      .devices()
      .filter((d) => d.online)
      .map((d) => {
        const list = this.keptSessions.get(d.id)
        return { device: d.id, name: d.name, value: list ? list.map((s) => ({ ...s, device: { id: d.id, name: d.name } })) : null }
      })
  }

  /**
   * the device whose last Recent sessions list this session: the preferred one when it keeps the session, online or not (the
   * section the pick was made in, so an offline one gets the open and says it is not connected); otherwise an online one
   * before an offline one, since two devices may list the same session; offline devices count too (the window keeps their
   * sessions until it is told); null for none
   */
  deviceOfSession(id: string, prefer?: string): string | null {
    const online = new Map(this.tabs.devices().map((d) => [d.id, d.online]))
    // a pick names its section's device: an offline one is asked too, so the person is told it is not connected
    if (prefer !== undefined && this.keptSessions.get(prefer)?.some((s) => s.id === id)) return prefer
    let offline: string | null = null
    for (const [device, list] of this.keptSessions) {
      if (!online.has(device) || !list.some((s) => s.id === id)) continue
      if (online.get(device)) return device
      offline ??= device
    }
    return offline
  }

  /**
   * Asks every online device for its Recent sessions at once, in the background, as refreshChoices does. A device's call
   * still out is not asked again. An answer that changes what is kept calls onFresh('sessions'); a refused or late answer
   * keeps the last one.
   */
  refreshSessions(): void {
    for (const d of this.tabs.devices()) {
      if (!d.online) continue
      const device = d.id
      void this.listCall(device, 'sessions').then((list) => {
        if (list !== null) this.keepSessions(device, list)
      })
    }
  }

  /** a Recent session on another device: the id of the tab in its conversation or of the tab it resumed, or null with the window's words for the failure (toasted) */
  async openSession(device: string, id: string): Promise<string | null> {
    try {
      return (await this.ask(device, 'open-session', { session: id })).id
    } catch (e) {
      this.toast(messageOf(e))
      return null
    }
  }

  /** a new tab on another device: its id, or null with the window's words for the failure (toasted) */
  async openTab(device: string, req: CallArgs['open-tab']): Promise<string | null> {
    try {
      return (await this.ask(device, 'open-tab', req)).id
    } catch (e) {
      this.toast(messageOf(e))
      return null
    }
  }

  close(tabId: string): void {
    this.fire(tabId, 'close', { id: tabId })
  }

  rename(tabId: string, title: string | null): void {
    this.fire(tabId, 'rename', { id: tabId, title })
  }

  mute(tabId: string, muted: boolean): void {
    this.fire(tabId, 'mute', { id: tabId, muted })
  }

  restart(tabId: string, live: boolean): void {
    this.fire(tabId, 'restart', { id: tabId, live })
  }

  /** the task list of a tab on another device is cleared there; a refusal is toasted and gives false */
  async clearTaskList(tabId: string): Promise<boolean> {
    try {
      const ok = (await this.askTab(tabId, 'clear-task-list', { id: tabId })).ok
      if (!ok) this.toast(REMOTE_COPY.clearTaskListFailed)
      return ok
    } catch (e) {
      this.toast(messageOf(e))
      return false
    }
  }

  /** true when the tab now runs on the account; a refusal is toasted and gives false */
  async switchAccount(tabId: string, account: string | null): Promise<boolean> {
    try {
      return (await this.askTab(tabId, 'switch-account', { id: tabId, account })).ok
    } catch (e) {
      this.toast(messageOf(e))
      return false
    }
  }

  /**
   * The bytes of a card of one of the device's tabs at `version`, read in parts of IMAGE_PART_BYTES. Null when the card is
   * not there, a call fails, the card's version or size changes midway, or `wanted` is false for a read still waiting its
   * turn. A call for the same card and version that is read already shares that read.
   */
  imageBytes(tabId: string, cardId: string, version: number, wanted: () => boolean = () => true): Promise<{ version: number; data: Buffer } | null> {
    const key = `${cardId} ${version}`
    const running = this.fetching.get(key)
    if (running) return running
    const read = this.readParts(tabId, cardId, version, wanted).finally(() => {
      this.fetching.delete(key)
    })
    this.fetching.set(key, read)
    return read
  }

  /** the card's parts from offset 0 to its size, every part at `version` and of one size; a part must advance */
  private async readParts(tabId: string, cardId: string, version: number, wanted: () => boolean): Promise<{ version: number; data: Buffer } | null> {
    const parts: Buffer[] = []
    let size: number | null = null
    let offset = 0
    for (;;) {
      const part = await this.partOf(tabId, cardId, offset, wanted)
      if (part === null || part.version !== version) return null
      const data = Buffer.from(part.data, 'base64')
      if (size === null) size = part.size
      if (part.size !== size || offset + data.length > size) return null
      // a part with no bytes before the end would never finish
      if (data.length === 0 && offset < size) return null
      parts.push(data)
      offset += data.length
      if (offset >= size) return { version, data: Buffer.concat(parts, offset) }
    }
  }

  /**
   * One part of a card through the device's read lane: at most IMAGE_READS_AT_ONCE part calls are out per device, and a
   * call's time limit starts when it is sent, not when it is queued. A read waiting its turn is answered null with no call
   * when `wanted` is false by then, or its tab or device is gone. The next part of a read under way (an offset past 0) goes
   * to the front of the lane, so the read finishes before the reads that wait start. That needs the order in readParts: the
   * next part is queued before the finished part's `finally` frees its slot and pumps. An `await` added between receiving
   * a part and asking for the next one would let a waiting read take the turn.
   */
  private partOf(tabId: string, cardId: string, offset: number, wanted: () => boolean): Promise<CallReplies['image'] | null> {
    const device = this.tabs.deviceOf(tabId)
    if (device === null) return Promise.resolve(null)
    let lane = this.lanes.get(device)
    if (!lane) {
      lane = { out: 0, waiting: [] }
      this.lanes.set(device, lane)
    }
    const at = lane
    return new Promise((resolve) => {
      const part = () => {
        if (!wanted() || this.tabs.deviceOf(tabId) === null) {
          resolve(null)
          return
        }
        at.out++
        void this.askTab(tabId, 'image', { id: tabId, card: cardId, offset }, { timeoutMs: IMAGE_PART_TIMEOUT_MS })
          .then(resolve, () => resolve(null))
          .finally(() => {
            at.out--
            this.pump(device)
          })
      }
      if (offset > 0) at.waiting.unshift(part)
      else at.waiting.push(part)
      this.pump(device)
    })
  }

  /** starts the waiting part calls of a device while fewer than IMAGE_READS_AT_ONCE are out; an idle device's lane goes */
  private pump(device: string): void {
    const lane = this.lanes.get(device)
    if (!lane) return
    while (lane.out < IMAGE_READS_AT_ONCE && lane.waiting.length > 0) lane.waiting.shift()!()
    if (lane.out === 0 && lane.waiting.length === 0) this.lanes.delete(device)
  }

  /** the other device's Media of the tab is seen: its unseen count goes down there */
  markImagesSeen(tabId: string): void {
    const device = this.tabs.deviceOf(tabId)
    if (device === null || this.tabs.callsOf(device) === null) return
    this.fire(tabId, 'images-seen', { id: tabId })
  }

  /** a card removed from the other device's Media */
  removeImage(tabId: string, cardId: string): void {
    this.fire(tabId, 'image-remove', { id: tabId, card: cardId })
  }

  /** a Changes action about the tab: the device checks it; a refusal is toasted */
  review(tabId: string, action: ReviewAction): void {
    this.fire(tabId, 'review', { id: tabId, action })
  }

  /** whether the tab's Claude can be forked now; an offline device, a refusal or an answer past LIST_TIMEOUT_MS is no */
  async canFork(tabId: string): Promise<boolean> {
    try {
      return (await this.askTab(tabId, 'can-fork', { id: tabId }, { timeoutMs: LIST_TIMEOUT_MS })).ok
    } catch {
      return false
    }
  }

  /** a fork of the tab, made on its device: the new tab's id, or null with the window's words for the failure (toasted) */
  async forkTab(tabId: string): Promise<string | null> {
    try {
      return (await this.askTab(tabId, 'fork-tab', { id: tabId })).id
    } catch (e) {
      this.toast(messageOf(e))
      return null
    }
  }

  /** the subfolders of a tab's folder (null: the tab's own) on its device; a refusal or a failed call is the answer's error */
  async listFolders(tabId: string, path: string | null): Promise<FolderResult> {
    try {
      return await this.askTab(tabId, 'folders', { id: tabId, path })
    } catch (e) {
      return { ok: false, error: messageOf(e) }
    }
  }

  /** moves a tab to another folder on its device; the device's refusal, or a failed call, is the error */
  async changeFolder(tabId: string, path: string): Promise<DeviceResult> {
    try {
      await this.askTab(tabId, 'change-folder', { id: tabId, path })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: messageOf(e) }
    }
  }

  /** whether the tab's Claude takes a message now; any failure (no device, offline, no answer, refused, a bad reply) says not running */
  async canSend(tabId: string): Promise<ReviewSendState> {
    try {
      return await this.askTab(tabId, 'can-send', { id: tabId })
    } catch {
      return { ok: false, reason: NOT_RUNNING }
    }
  }

  /** a message to a remote chat: null when the device took it; else why not, the device's refusal or the failed call's words */
  async chatSend(tabId: string, s: ChatSend): Promise<string | null> {
    try {
      await this.askTab(tabId, 'chat-send', { id: tabId, text: s.text, attachments: s.attachments })
      return null
    } catch (e) {
      return messageOf(e)
    }
  }

  /** an answer to a card of a remote chat: the device's ok (false when the card was answered already), false when the call is refused */
  async chatAnswer(tabId: string, cardId: string, answer: ChatAnswer): Promise<boolean> {
    try {
      return (await this.askTab(tabId, 'chat-answer', { id: tabId, cardId, answer })).ok
    } catch {
      return false
    }
  }

  /** an older page of a remote chat before an item; null when the device refuses it or does not answer */
  async chatOlder(tabId: string, beforeId: string): Promise<{ items: ChatItem[]; hasOlder: boolean } | null> {
    try {
      return await this.askTab(tabId, 'chat-older', { id: tabId, beforeId })
    } catch {
      return null
    }
  }

  /** the permission modes a remote chat's device offers; null when it refuses, does not answer, or is too old to know the call (the caller keeps its own list) */
  async chatModes(tabId: string): Promise<ChatPermissionMode[] | null> {
    try {
      return await this.askTab(tabId, 'chat-modes', { id: tabId })
    } catch {
      return null
    }
  }

  /** the commands a remote chat offers; none when the device refuses or does not answer */
  async chatCommands(tabId: string): Promise<ChatCommandInfo[]> {
    try {
      return await this.askTab(tabId, 'chat-commands', { id: tabId })
    } catch {
      return []
    }
  }

  /** the models a remote chat offers; none when the device refuses or does not answer */
  async chatModels(tabId: string): Promise<ChatModelInfo[]> {
    try {
      return await this.askTab(tabId, 'chat-models', { id: tabId })
    } catch {
      return []
    }
  }

  /** the project files that match a query in a remote chat's folder; none when the device refuses or does not answer */
  async chatFiles(tabId: string, query: string): Promise<string[]> {
    try {
      return await this.askTab(tabId, 'chat-files', { id: tabId, query })
    } catch {
      return []
    }
  }

  /** a remote tab's view switches on its device; a refusal gives false, and the caller says why (no toast here) */
  async chatView(tabId: string, view: TabView): Promise<boolean> {
    try {
      await this.askTab(tabId, 'chat-view', { id: tabId, view })
      return true
    } catch {
      return false
    }
  }

  /** a command typed into a remote tab's terminal on its device (null: only the switch); a refusal gives false, and the caller says why (no toast here) */
  async chatTerminal(tabId: string, line: string | null): Promise<boolean> {
    try {
      await this.askTab(tabId, 'chat-terminal', { id: tabId, line: line ?? '' })
      return true
    } catch {
      return false
    }
  }

  chatInterrupt(tabId: string): void {
    this.fire(tabId, 'chat-interrupt', { id: tabId })
  }

  chatMode(tabId: string, mode: ChatPermissionMode): void {
    this.fire(tabId, 'chat-mode', { id: tabId, mode })
  }

  chatModel(tabId: string, model: string | null, effort: string | null): void {
    this.fire(tabId, 'chat-model', { id: tabId, model, effort })
  }

  chatStopTask(tabId: string, taskId: string): void {
    this.fire(tabId, 'chat-stop-task', { id: tabId, taskId })
  }

  /** a call whose answer is not needed: a failure is toasted */
  private fire<M extends CallMethod>(tabId: string, m: M, a: CallArgs[M]): void {
    this.askTab(tabId, m, a).catch((e: unknown) => {
      this.toast(messageOf(e))
    })
  }

  /** the device's name as the group shows it; its id when it is not listed */
  private nameOf(device: string): string {
    return this.tabs.devices().find((d) => d.id === device)?.name ?? device
  }

  /** one list call of a device, shared with a call still out; null when it is refused or not answered in time */
  private listCall<M extends 'profiles' | 'accounts' | 'sessions'>(device: string, m: M): Promise<CallReplies[M] | null> {
    const key = `${device} ${m}`
    let call = this.out.get(key)
    if (!call) {
      call = this.ask(device, m, {}, { timeoutMs: LIST_TIMEOUT_MS }).catch(() => null)
      this.out.set(key, call)
      void call.then(() => this.out.delete(key))
    }
    return call as Promise<CallReplies[M] | null>
  }

  /** keeps a whole answer; a kept answer that changes is announced */
  private keep(device: string, v: DeviceChoices): void {
    const before = this.kept.get(device)
    if (before && JSON.stringify(before) === JSON.stringify(v)) return
    this.kept.set(device, v)
    this.onFresh?.('choices')
  }

  /** keeps a device's Recent sessions; a list that changes is announced */
  private keepSessions(device: string, list: RecentSession[]): void {
    const before = this.keptSessions.get(device)
    if (before && JSON.stringify(before) === JSON.stringify(list)) return
    this.keptSessions.set(device, list)
    this.onFresh?.('sessions')
  }
}

/** the window's words for a failed call: a timeout is no answer, a closed link is an offline device; other refusals pass */
function refusalOf(e: unknown, name: string): Error {
  if (e instanceof CallError && e.message === 'timeout') return new CallError(REMOTE_COPY.noAnswer(name))
  if (e instanceof CallError && e.message === 'link closed') return new CallError(REMOTE_COPY.deviceOffline(name))
  return e instanceof Error ? e : new CallError('failed')
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : 'failed'
}

/** a tab that runs on another device, as this device's window keeps it: its TabInfo fields and what the device adds */
export function remoteTabInfo(device: string, tab: RemoteTab): TabInfo {
  return {
    id: tab.id,
    kind: tab.kind,
    profile: tab.profile,
    cwd: tab.cwd,
    // the folder the tab works in on its device now, as the device sent it
    folder: tab.folder,
    customTitle: tab.customTitle,
    claudeSessionId: tab.claudeSessionId,
    account: tab.account,
    muted: tab.muted,
    // a fork of its head while that is open on its device; a fork of none once it closed
    fork: tab.fork ? { of: tab.forkOf, from: null } : null,
    exited: tab.exited,
    activity: tab.working ? 'working' : null,
    // the view a Claude tab shows on its device; an older device sends none, and that device has no chat for the tab: null, a plain remote terminal
    view: tab.kind === 'claude' ? tab.view ?? null : null,
    remote: { device, accountName: tab.accountName, images: tab.images, title: tab.title }
  }
}
