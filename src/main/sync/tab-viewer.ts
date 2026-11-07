import { type DevicePlatform, type DeviceView } from '../../shared/devices'
import { ATTACH_TIMEOUT_MS, MAX_INPUT_CHARS, MAX_REMOTE_TABS, REATTACH_MS, type RemoteDeviceView, type RemoteTab } from '../../shared/remote'
import type { NotificationCase } from '../../shared/types'
import { AttachedView, type StreamItem, type ViewStep } from './attached-view'
import type { Calls } from './calls'
import type { PeerLink } from './peer-link'
import { piecesOf } from './pieces'
import { CALL_REPLIES, parsePush, type PushValue } from './remote-shapes'
import type { HelloMessage, Message } from './wire'

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
  push(tabId: string, value: PushValue): void
}

export interface RemoteTabsDeps {
  selfId(): string
  isLocal(tabId: string): boolean
  /** whether this window has the focus; false by default. The device that owns the tab in front is told it */
  windowFocused?(): boolean
  events: ViewerEvents
  /** how long before a tab in front attaches again after a loss; REATTACH_MS by default */
  reattachMs?: number
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

/** The tabs of the other devices of the group, as this window shows them. */
export class RemoteTabs {
  private readonly known = new Map<string, Device>()
  /** the device that announced each remote tab */
  private readonly owner = new Map<string, string>()
  /** this window's latest fit of each tab it was activated for */
  private readonly fits = new Map<string, Fit>()
  private readonly wasActivated = new Set<string>()
  private readonly reattachMs: number
  /** the remote tab in front in this window, if any */
  private frontId: string | null = null
  /** the device that has a remote tab of this window in front */
  private frontDevice: string | null = null
  private disposed = false

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

  /** input typed into a remote tab: a tab not sized for this device is claimed first, with this window's latest fit */
  input(tabId: string, data: string): void {
    if (this.disposed) return
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
        if (!d.tabs.has(m.id)) return
        const value = parsePush(m.k, m.v, m.id)
        if (value) this.deps.events.push(m.id, value)
        return
      }
      default:
        // in, claim and front are the host's; calls and replies go to the link's Calls
        return
    }
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
        resume: false
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

  /** the link is gone: the device's tabs stay, the attached ones are resumed when it comes back */
  private unlink(d: Device): void {
    if (d.link && d.onMessage) d.link.off('message', d.onMessage)
    d.link = null
    d.calls = null
    d.onMessage = null
    for (const e of d.tabs.values()) {
      if (e.view) e.resume = true
      e.view = null
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
    if (this.frontId === e.id && this.online(e.device)) this.scheduleReattach(e)
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

  private sendFront(d: Device, id: string | null, focused = this.deps.windowFocused?.() === true): void {
    d.link?.send({ t: 'front', id, focused })
  }

  /** this window gained or lost the focus: the device that owns the tab in front is told with the new flag */
  focusChanged(focused: boolean): void {
    if (this.disposed || this.frontId === null || this.frontDevice === null) return
    const d = this.known.get(this.frontDevice)
    if (d) this.sendFront(d, this.frontId, focused)
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
