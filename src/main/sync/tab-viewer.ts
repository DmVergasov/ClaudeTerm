import type { ChatPatch, ChatSnapshot } from '../../shared/chat'
import { type DevicePlatform, type DeviceView } from '../../shared/devices'
import { ATTACH_TIMEOUT_MS, MAX_INPUT_CHARS, MAX_REMOTE_TABS, REATTACH_MS, type RemoteDeviceView, type RemoteTab } from '../../shared/remote'
import type { NotificationCase } from '../../shared/types'
import { ChatMirror, parseChatPush } from '../chat/chat-mirror'
import { isTerminalAnswer } from '../ipc-guards'
import { AttachedView, type StreamItem, type ViewStep } from './attached-view'
import type { Calls } from './calls'
import type { PeerLink } from './peer-link'
import { piecesOf } from './pieces'
import { CALL_REPLIES, MAX_REVIEW_FILES, parsePush, type PushValue, type ReviewPart, reviewRevOf } from './remote-shapes'
import { type HelloMessage, MAX_FRAME_BYTES, type Message } from './wire'

// The other devices' tabs, as this device shows them: each device's directory, the screen and stream of the tabs it
// attaches to, and what this window sends back (input, claims, the tab in front). Everything from a device is checked
// against the device that sent it: a device speaks only for the tabs it announced.

/** what the window shows: the directory, the streams and the attention of the tabs */
export interface ViewerEvents {
  opened(device: string, tab: RemoteTab): void
  updated(device: string, tab: RemoteTab, before: RemoteTab): void
  closed(tabId: string): void
  devices(list: RemoteDeviceView[]): void
  data(tabId: string, data: string): void
  reset(tabId: string): void
  exit(tabId: string, code: number): void
  /** null: the tab is sized for this window, which fits it; otherwise it keeps that size here */
  size(tabId: string, size: { cols: number; rows: number } | null): void
  /** fresh: an attention that just started; not fresh: one the tab already had when its device came */
  attention(tabId: string, reason: NotificationCase, fresh: boolean): void
  attentionCleared(tabId: string): void
  /** a device is present with this tab of it in front, and its attention rings here: see Attention.ringInFront */
  ring(tabId: string, reason: NotificationCase): void
  push(tabId: string, value: PushValue): void
  /** a chat of an attached tab moved on: its counted patches, from their revisions */
  chat?(tabId: string, fromRev: number, toRev: number, patches: ChatPatch[]): void
  /** a chat of an attached tab was loaded from a snapshot: the window reloads it (its revisions do not count) */
  chatReload?(tabId: string): void
}

export interface RemoteTabsDeps {
  selfId(): string
  isLocal(tabId: string): boolean
  /** whether this device is present (see Presence); false by default. The device that owns the tab in front is told it */
  present?(): boolean
  events: ViewerEvents
  /** how long before a tab in front attaches again after a loss; REATTACH_MS by default */
  reattachMs?: number
  /** says what this window refused: a chat push it cannot check is logged the first time for its tab and kind */
  log?(message: string): void
}

/** a remote tab as this viewer holds it */
interface Entry {
  id: string
  device: string
  tab: RemoteTab
  /** the screen and stream while attached (or while the attach waits); null otherwise */
  view: AttachedView | null
  /** counts the attaches and losses of the tab: the answer of an attach that is no longer current is ignored */
  token: number
  /** the token of the attach call on the wire, while it is out: a second one waits for it to settle */
  pending: number | null
  timer: ReturnType<typeof setTimeout> | null
  /** the tab is sized for this window: a claim this window sent, or a directory that names this window */
  claimed: boolean
  /** attached when its device left: attached again when the device comes back */
  resume: boolean
  /** the chat of the tab while it is attached: from the host's snapshot on; null until one comes in this attach */
  chat: ChatMirror | null
}

/** a device of the group as this viewer knows it */
interface Device {
  id: string
  name: string
  platform: DevicePlatform | null
  /** the link while the device is connected */
  link: PeerLink | null
  calls: Calls | null
  onMessage: ((m: Message) => void) | null
  /** whether its directory was listed on the current link */
  listed: boolean
  tabs: Map<string, Entry>
}

interface Fit {
  cols: number
  rows: number
}

/** a tab's reviews as this viewer has them: the highest rev shown, and the review whose parts are coming */
interface ReviewFlow {
  shown: number | null
  assembly: {
    rev: number
    of: number
    next: number
    head: NonNullable<ReviewPart['head']>
    files: ReviewPart['files']
    /** the parts' sizes added up: past MAX_FRAME_BYTES, the review is no longer assembled */
    bytes: number
  } | null
}

/** the lowest rev a review may have and still be shown: the highest of the shown one and the one being assembled */
function floorOf(flow: ReviewFlow): number {
  return Math.max(flow.shown ?? -1, flow.assembly?.rev ?? -1)
}

/** The tabs of the other devices of the group, as this window shows them. */
export class RemoteTabs {
  private readonly known = new Map<string, Device>()
  /** the device that announced each remote tab */
  private readonly owner = new Map<string, string>()
  /** this window's latest fit of each tab it was activated for */
  private readonly fits = new Map<string, Fit>()
  private readonly wasActivated = new Set<string>()
  /** each tab's reviews: the highest rev shown, and the review being put together from its parts */
  private readonly reviews = new Map<string, ReviewFlow>()
  private readonly reattachMs: number
  /** the remote tab in front in this window, if any */
  private frontId: string | null = null
  /** the device that has a remote tab of this window in front */
  private frontDevice: string | null = null
  private disposed = false
  /** the chat pushes refused, by tab and kind: each is logged the first time only */
  private readonly refusedChats = new Set<string>()

  constructor(private readonly deps: RemoteTabsDeps) {
    this.reattachMs = deps.reattachMs ?? REATTACH_MS
  }

  /** the device's link is up: its directory comes, its front and its attached tabs are sent again */
  addPeer(link: PeerLink, hello: HelloMessage, calls: Calls): void {
    if (this.disposed || hello.id === this.deps.selfId()) return
    let d = this.known.get(hello.id)
    if (d?.link === link) return
    // one link per device: a link that replaces an older one takes its place
    if (d?.link) this.unlink(d)
    if (!d) {
      d = newDevice(hello.id, hello.name, hello.platform)
      this.known.set(hello.id, d)
    }
    const dev = d
    dev.name = hello.name
    dev.platform = hello.platform
    dev.link = link
    dev.calls = calls
    dev.listed = false
    const onMessage = (m: Message): void => {
      try {
        if (dev.link === link) this.inbound(dev, m)
      } catch {
        // a message that cannot be served is dropped
      }
    }
    dev.onMessage = onMessage
    link.on('message', onMessage)
    // the directory is asked for again: the one sent when the link came up may have reached no listener (a link can
    // come up before this window listens, as after a restart). The list comes as a push, in order;
    // the answer adds nothing.
    calls.call('tabs', {}).then(
      () => {
        // the list has come as a push on this link
      },
      () => {
        // a device that does not know the call answers so: its first push still lists its tabs
      }
    )
    if (this.frontId !== null && this.owner.get(this.frontId) === dev.id) {
      this.frontDevice = dev.id
      this.sendFront(dev, this.frontId)
    }
    for (const e of dev.tabs.values()) {
      if (!e.resume && e.id !== this.frontId) continue
      e.resume = false
      this.attach(e)
    }
    this.emitDevices()
  }

  /** the device goes offline: its tabs stay, input to them is dropped */
  removePeer(link: PeerLink): void {
    if (this.disposed) return
    const d = [...this.known.values()].find((x) => x.link === link)
    if (!d) return
    this.unlink(d)
    this.emitDevices()
  }

  /**
   * names from the group, for the devices this run has seen; a device no longer listed is forgotten with its tabs. A
   * listed device that never linked this run is not added.
   */
  members(list: readonly DeviceView[]): void {
    if (this.disposed) return
    const self = this.deps.selfId()
    const listed = new Set<string>()
    let changed = false
    for (const dv of list) {
      if (dv.id === self) continue
      listed.add(dv.id)
      const d = this.known.get(dv.id)
      if (!d) continue
      const platform = dv.platform ?? d.platform
      if (d.name !== dv.name || d.platform !== platform) {
        d.name = dv.name
        d.platform = platform
        changed = true
      }
    }
    for (const id of [...this.known.keys()]) {
      if (listed.has(id)) continue
      this.forget(id)
      changed = true
    }
    if (changed) this.emitDevices()
  }

  has(tabId: string): boolean {
    return this.entryOf(tabId) !== null
  }

  deviceOf(tabId: string): string | null {
    return this.entryOf(tabId)?.device ?? null
  }

  tab(tabId: string): RemoteTab | null {
    return this.entryOf(tabId)?.tab ?? null
  }

  tabsOf(device: string): RemoteTab[] {
    return [...(this.known.get(device)?.tabs.values() ?? [])].map((e) => e.tab)
  }

  /** whether the device's tab list has come on its current link: until it has, its tabs are not known yet, and none is listed */
  listedOf(device: string): boolean {
    return this.known.get(device)?.listed ?? false
  }

  /** every device seen this run, sorted by name (ties by id) */
  devices(): RemoteDeviceView[] {
    return [...this.known.values()]
      .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((d) => ({ id: d.id, name: d.name, platform: d.platform, online: d.link !== null }))
  }

  online(device: string): boolean {
    return (this.known.get(device)?.link ?? null) !== null
  }

  callsOf(device: string): Calls | null {
    return this.known.get(device)?.calls ?? null
  }

  /** a copy of the chat of an attached remote tab, as its device's host holds it; null when the tab has none attached */
  chatSnapshot(tabId: string): ChatSnapshot | null {
    return this.entryOf(tabId)?.chat?.snapshot() ?? null
  }

  /** the tab in front in this window: a remote one, a local one or none */
  activated(tabId: string | null): void {
    if (this.disposed) return
    const prevFront = this.frontId
    const prevDevice = this.frontDevice
    if (prevFront !== null && prevFront !== tabId) {
      const old = this.entryOf(prevFront)
      if (old) this.cancelTimer(old)
    }
    this.frontId = tabId
    if (tabId !== null) this.wasActivated.add(tabId)
    const e = tabId !== null ? this.entryOf(tabId) : null
    const device = e?.device ?? null
    if (prevDevice !== null && prevDevice !== device) {
      const d = this.known.get(prevDevice)
      if (d) this.sendFront(d, null)
    }
    this.frontDevice = device
    if (!e) return
    this.sendFront(this.known.get(e.device)!, e.id)
    const fit = this.fits.get(e.id)
    if (fit) this.claim(e, fit.cols, fit.rows)
    this.attach(e)
  }

  /** this window's fitted size for a remote tab */
  fit(tabId: string, cols: number, rows: number): void {
    if (this.disposed || !this.wasActivated.has(tabId)) return
    const first = !this.fits.has(tabId)
    this.fits.set(tabId, { cols, rows })
    if (this.frontId !== tabId) return
    const e = this.entryOf(tabId)
    if (!e) return
    if (first || e.claimed) this.claim(e, cols, rows)
  }

  /**
   * input typed into a remote tab: a tab not sized for this device is claimed first, with this window's latest fit.
   * This window's answers to terminal questions stay here: the tab's own window answers every one, and a second answer
   * would reach the program as typed text (the bundled ConPTY asks what the terminal is as it starts).
   */
  input(tabId: string, data: string): void {
    if (this.disposed || isTerminalAnswer(data)) return
    const e = this.entryOf(tabId)
    if (!e) return
    const link = this.known.get(e.device)?.link
    if (!link) return
    if (!e.claimed && e.tab.size.by !== this.deps.selfId()) {
      const fit = this.fits.get(tabId)
      if (fit) this.claim(e, fit.cols, fit.rows)
    }
    for (const piece of piecesOf(data, MAX_INPUT_CHARS)) link.send({ t: 'in', id: tabId, d: piece })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const d of this.known.values()) {
      for (const e of d.tabs.values()) this.cancelTimer(e)
      if (d.link && d.onMessage) d.link.off('message', d.onMessage)
    }
    this.known.clear()
    this.owner.clear()
    this.fits.clear()
    this.wasActivated.clear()
    this.reviews.clear()
    this.frontId = null
    this.frontDevice = null
  }

  // ---- messages of a device

  private inbound(d: Device, m: Message): void {
    switch (m.t) {
      case 'tabs':
        this.applyList(d, m.tabs)
        return
      case 'tab':
        this.applyOne(d, m.tab)
        return
      case 'tab-closed':
        if (d.tabs.has(m.id)) this.closeTab(d, m.id)
        return
      case 'out':
      case 'reset':
      case 'exit':
        this.stream(d, m)
        return
      case 'detached': {
        const e = d.tabs.get(m.id)
        if (e?.view) this.lose(e)
        return
      }
      case 'push': {
        const e = d.tabs.get(m.id)
        if (!e) return
        if (m.k === 'chat' || m.k === 'chat-patch') {
          this.chatPush(e, m.k, m.v)
          return
        }
        const value = parsePush(m.k, m.v, m.id)
        if (!value) return
        if (value.k === 'review-part') this.reviewPart(m.id, value.part)
        else if (value.k === 'review') this.review(m.id, value, reviewRevOf(m.v))
        else this.deps.events.push(m.id, value)
        return
      }
      case 'ring':
        // a tab the device announced only: a ring for another device's tab is dropped
        if (d.tabs.has(m.id)) this.deps.events.ring(m.id, m.reason)
        return
      default:
        // in, claim and front are the host's; calls and replies go to the link's Calls
        return
    }
  }

  /**
   * A chat push of an attached tab. A snapshot starts the tab's chat, as the host's model is at its revision; a batch moves
   * it on when it follows the chat's revision. A batch with no chat yet is left out: the snapshot of the attach covers it.
   * A snapshot of another tab, or a batch that does not follow, ends the attach: the tab attaches again for a fresh snapshot.
   */
  private chatPush(e: Entry, k: 'chat' | 'chat-patch', v: unknown): void {
    const push = parseChatPush(v)
    if (!push) {
      this.chatRefused(e.id, k)
      return
    }
    if (!e.view) return
    if ('snapshot' in push) {
      if (k !== 'chat') return
      const s: ChatSnapshot = push.snapshot
      if (s.tabId !== e.id) {
        this.chatRefused(e.id, k)
        this.lose(e)
        return
      }
      e.chat = new ChatMirror()
      e.chat.load(s)
      this.deps.events.chatReload?.(e.id)
      return
    }
    if (k !== 'chat-patch' || !e.chat) return
    if (!e.chat.apply(push.fromRev, push.toRev, push.patches)) {
      this.lose(e)
      return
    }
    this.deps.events.chat?.(e.id, push.fromRev, push.toRev, push.patches)
  }

  /**
   * A whole review: shown unless a review of a higher rev is shown or being assembled. A review with no rev is an older
   * device's, and is shown as it always was.
   */
  private review(tabId: string, value: Extract<PushValue, { k: 'review' }>, rev: number | null): void {
    if (rev !== null) {
      const flow = this.flowOf(tabId)
      if (rev < floorOf(flow)) return
      flow.shown = rev
      flow.assembly = null
    }
    this.deps.events.push(tabId, value)
  }

  /**
   * A part of a review. Part 0 starts its assembly; a part that is not the next of the assembly drops it, and so does a
   * part of a higher rev. The last part shows the review as one push, with the head and all its files.
   */
  private reviewPart(tabId: string, part: ReviewPart): void {
    const flow = this.flowOf(tabId)
    if (part.rev < floorOf(flow)) return
    // a copy of a part the assembly has (the same review pushed twice to this member) changes nothing
    const have = flow.assembly
    if (have && have.rev === part.rev && have.of === part.of && part.i < have.next) return
    if (part.head !== null) flow.assembly = { rev: part.rev, of: part.of, next: 0, head: part.head, files: [], bytes: 0 }
    const a = flow.assembly
    const tooBig = a !== null && a.bytes + part.bytes > MAX_FRAME_BYTES
    if (!a || tooBig || a.rev !== part.rev || a.of !== part.of || a.next !== part.i || a.files.length + part.files.length > MAX_REVIEW_FILES) {
      flow.assembly = null
      return
    }
    for (const f of part.files) a.files.push(f)
    a.bytes += part.bytes
    a.next++
    if (a.next < a.of) return
    flow.assembly = null
    flow.shown = a.rev
    this.deps.events.push(tabId, { k: 'review', v: { ...a.head, files: a.files } })
  }

  private flowOf(tabId: string): ReviewFlow {
    let flow = this.reviews.get(tabId)
    if (!flow) {
      flow = { shown: null, assembly: null }
      this.reviews.set(tabId, flow)
    }
    return flow
  }

  /** a full directory: the device's tabs are replaced by it */
  private applyList(d: Device, list: RemoteTab[]): void {
    const firstList = !d.listed
    d.listed = true
    const ids = new Set<string>()
    const accepted: RemoteTab[] = []
    for (const tab of list) {
      if (ids.has(tab.id) || this.refused(d, tab.id)) continue
      if (accepted.length >= MAX_REMOTE_TABS) break
      ids.add(tab.id)
      accepted.push(tab)
    }
    for (const id of [...d.tabs.keys()]) if (!ids.has(id)) this.closeTab(d, id)
    for (const tab of accepted) this.upsert(d, knownHead(tab, (id) => ids.has(id)), firstList)
    // the first list on a link is news for the devices too, even when it opens and closes no tab: the count of its tabs is shown from it
    if (firstList) this.emitDevices()
  }

  /** one tab of a device's directory; a new one past MAX_REMOTE_TABS is ignored */
  private applyOne(d: Device, tab: RemoteTab): void {
    if (this.refused(d, tab.id)) return
    if (!d.tabs.has(tab.id) && d.tabs.size >= MAX_REMOTE_TABS) return
    this.upsert(d, knownHead(tab, (id) => d.tabs.has(id)), !d.listed)
  }

  /** an id that is this device's own tab or another device's tab is not taken from this device */
  private refused(d: Device, id: string): boolean {
    if (this.deps.isLocal(id)) return true
    const owner = this.owner.get(id)
    return owner !== undefined && owner !== d.id
  }

  private upsert(d: Device, tab: RemoteTab, firstList: boolean): void {
    const ev = this.deps.events
    const self = this.deps.selfId()
    const e = d.tabs.get(tab.id)
    if (!e) {
      const entry: Entry = {
        id: tab.id,
        device: d.id,
        tab,
        view: null,
        token: 0,
        pending: null,
        timer: null,
        claimed: tab.size.by === self,
        resume: false,
        chat: null
      }
      d.tabs.set(tab.id, entry)
      this.owner.set(tab.id, d.id)
      ev.opened(d.id, tab)
      ev.size(tab.id, sizeOf(tab, self))
      this.attentionOf(tab.id, null, tab, firstList)
      if (this.frontId === tab.id) {
        this.frontDevice = d.id
        this.sendFront(d, tab.id)
        this.attach(entry)
      }
      return
    }
    const before = e.tab
    if (JSON.stringify(before) === JSON.stringify(tab)) return
    e.tab = tab
    ev.updated(d.id, tab, before)
    if (before.size.cols !== tab.size.cols || before.size.rows !== tab.size.rows || before.size.by !== tab.size.by) {
      e.claimed = tab.size.by === self
      ev.size(tab.id, sizeOf(tab, self))
    }
    this.attentionOf(tab.id, before, tab, firstList)
  }

  /** an attention that starts is fresh, unless it came with the device's first list */
  private attentionOf(id: string, before: RemoteTab | null, now: RemoteTab, firstList: boolean): void {
    const ev = this.deps.events
    if (now.attention === null) {
      if (before?.attention) ev.attentionCleared(id)
      return
    }
    const prevReason = before?.attention ?? null
    const prevSeq = before?.attentionSeq ?? 0
    const grew = now.attentionSeq > prevSeq
    if (prevReason === now.attention && !grew) return
    ev.attention(id, now.attention, grew && !firstList)
  }

  private closeTab(d: Device, id: string): void {
    const e = d.tabs.get(id)
    if (!e) return
    this.cancelTimer(e)
    e.view = null
    e.token++
    // the attach call (if one is out) is no longer this tab's: the new entry of the tab attaches on its own
    e.pending = null
    d.tabs.delete(id)
    this.owner.delete(id)
    this.fits.delete(id)
    this.wasActivated.delete(id)
    this.reviews.delete(id)
    if (this.frontId === id) {
      this.frontId = null
      this.frontDevice = null
      this.sendFront(d, null)
    }
    this.deps.events.closed(id)
    // the forks of a closed head are forks with no head, whatever the device said of them last
    for (const other of d.tabs.values()) {
      if (other.tab.forkOf !== id) continue
      const before = other.tab
      other.tab = { ...before, forkOf: null }
      this.deps.events.updated(d.id, other.tab, before)
    }
  }

  /** the device left the group: its tabs close, and its link (if any) is no longer heard */
  private forget(id: string): void {
    const d = this.known.get(id)
    if (!d) return
    for (const e of [...d.tabs.values()]) this.closeTab(d, e.id)
    this.unlink(d)
    this.known.delete(id)
  }

  /** the link is gone: the device's tabs stay, the attached ones are resumed when it comes back; their reviews start over */
  private unlink(d: Device): void {
    if (d.link && d.onMessage) d.link.off('message', d.onMessage)
    d.link = null
    d.calls = null
    d.onMessage = null
    for (const e of d.tabs.values()) {
      this.reviews.delete(e.id)
      if (e.view) e.resume = true
      e.view = null
      e.chat = null
      e.token++
      // the call (if one is out) is rejected by the link's Calls: it is no longer this tab's
      e.pending = null
      this.cancelTimer(e)
    }
  }

  // ---- streams and attach

  private stream(d: Device, m: Extract<Message, { t: 'out' | 'reset' | 'exit' }>): void {
    const e = d.tabs.get(m.id)
    if (!e?.view) return
    const item: StreamItem =
      m.t === 'out' ? { t: 'out', seq: m.seq, d: m.d } : m.t === 'reset' ? { t: 'reset', seq: m.seq } : { t: 'exit', seq: m.seq, code: m.code }
    this.apply(e, e.view.stream(item))
  }

  private apply(e: Entry, steps: ViewStep[]): void {
    for (const s of steps) {
      if (s.kind === 'write') this.deps.events.data(e.id, s.data)
      else if (s.kind === 'reset') this.deps.events.reset(e.id)
      else if (s.kind === 'exit') this.deps.events.exit(e.id, s.code)
      else {
        this.lose(e)
        return
      }
    }
  }

  /**
   * attaches a tab of an online device: its screen waits for the snapshot, and the stream waits with it. At most one
   * attach call of a tab is out at a time: while one is, nothing starts another.
   */
  private attach(e: Entry): void {
    if (this.disposed || e.view || e.pending !== null) return
    const d = this.known.get(e.device)
    if (!d?.calls) return
    this.cancelTimer(e)
    const token = ++e.token
    e.view = new AttachedView()
    // the chat of an earlier attach is not this one's: the snapshot of this attach starts it
    e.chat = null
    e.pending = token
    d.calls.call('attach', { id: e.id }, { timeoutMs: ATTACH_TIMEOUT_MS }).then(
      (v) => this.settled(e, token, () => this.attached(e, token, v)),
      () => this.settled(e, token, () => this.failed(e, token))
    )
  }

  /**
   * The attach call of `token` settled. Its answer is used only while the viewer is live and the attach is still
   * current; once the call is over, a tab that still needs a view attaches again (now, or at its timer).
   */
  private settled(e: Entry, token: number, answer: () => void): void {
    try {
      // cleared by unlink() or closeTab(): the call is no longer this tab's
      if (e.pending !== token) return
      e.pending = null
      if (this.disposed) return
      answer()
      if (!e.view && this.frontId === e.id && this.online(e.device) && e.timer === null) this.attach(e)
    } catch {
      // the answer of an attach is dropped if it cannot be shown
    }
  }

  private attached(e: Entry, token: number, v: unknown): void {
    if (token !== e.token || !e.view) return
    const snap = CALL_REPLIES.attach(v)
    if (!snap) {
      this.failed(e, token)
      return
    }
    const view = e.view
    const steps = view.snapshot(snap)
    if (steps.some((s) => s.kind === 'reattach')) {
      this.lose(e)
      return
    }
    this.deps.events.size(e.id, { cols: snap.cols, rows: snap.rows })
    this.apply(e, steps)
    if (e.tab.size.by === this.deps.selfId() && e.view === view) this.deps.events.size(e.id, null)
  }

  private failed(e: Entry, token: number): void {
    if (token !== e.token || !e.view) return
    this.lose(e)
  }

  /** the tab is detached, a gap was seen or its attach failed: it attaches again when it is in front, or at the next switch */
  private lose(e: Entry): void {
    e.token++
    e.view = null
    e.chat = null
    if (this.frontId === e.id && this.online(e.device)) this.scheduleReattach(e)
  }

  /** a chat push this window refused: logged the first time for its tab and kind */
  private chatRefused(tabId: string, k: 'chat' | 'chat-patch'): void {
    const key = `${tabId} ${k}`
    if (this.refusedChats.has(key)) return
    this.refusedChats.add(key)
    this.deps.log?.(`push of ${k} for tab ${tabId} refused by this window`)
  }

  private scheduleReattach(e: Entry): void {
    if (e.timer) return
    e.timer = setTimeout(() => {
      e.timer = null
      try {
        if (this.frontId === e.id) this.attach(e)
      } catch {
        // the timer only attaches; a failure is seen by the next switch
      }
    }, this.reattachMs)
  }

  private cancelTimer(e: Entry): void {
    if (e.timer) clearTimeout(e.timer)
    e.timer = null
  }

  // ---- sending

  /** this window sized the tab: its PTY takes this size, and the window keeps it for the tab */
  private claim(e: Entry, cols: number, rows: number): void {
    const link = this.known.get(e.device)?.link
    if (!link) return
    link.send({ t: 'claim', id: e.id, cols, rows })
    e.claimed = true
  }

  private sendFront(d: Device, id: string | null, present = this.deps.present?.() === true): void {
    // a 0.15.0 host reads focused instead of present: it gets the presence in that field
    d.link?.send({ t: 'front', id, present, focused: present })
  }

  /** this device became present or stopped being present: the device that owns the tab in front is told with the new flag */
  presenceChanged(present: boolean): void {
    if (this.disposed || this.frontId === null || this.frontDevice === null) return
    const d = this.known.get(this.frontDevice)
    if (d) this.sendFront(d, this.frontId, present)
  }

  private emitDevices(): void {
    this.deps.events.devices(this.devices())
  }

  private entryOf(tabId: string): Entry | null {
    const device = this.owner.get(tabId)
    if (device === undefined) return null
    return this.known.get(device)?.tabs.get(tabId) ?? null
  }
}

function newDevice(id: string, name: string, platform: DevicePlatform | null): Device {
  return { id, name, platform, link: null, calls: null, onMessage: null, listed: false, tabs: new Map() }
}

/**
 * A fork's head is kept only when it is a tab of the same device that this viewer knows (`has`); a head of another
 * device, or of no tab, and a tab that is its own head, are no head.
 */
function knownHead(tab: RemoteTab, has: (id: string) => boolean): RemoteTab {
  if (tab.forkOf === null || (tab.forkOf !== tab.id && has(tab.forkOf))) return tab
  return { ...tab, forkOf: null }
}

/** the size a window applies for a tab: null when the tab is sized for this window (it fits), else the tab's size */
function sizeOf(tab: RemoteTab, self: string): { cols: number; rows: number } | null {
  return tab.size.by === self ? null : { cols: tab.size.cols, rows: tab.size.rows }
}
