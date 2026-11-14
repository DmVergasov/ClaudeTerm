import { type PushKind, type RemoteSnapshot } from '../shared/remote'
import { olderChatPush } from './chat/chat-mirror'
import { Coalescer } from './coalesce'
import type { Calls, CallEntry } from './sync/calls'
import type { PeerLink } from './sync/peer-link'
import type { MirrorOpen, ScreenMirrorsApi } from './sync/screen-mirror'
import { RemoteActions } from './sync/remote-actions'
import { connectPeer } from './sync/remote-link'
import { type HostTabs, TabHost } from './sync/tab-host'
import { RemoteTabs, type ViewerEvents } from './sync/tab-viewer'
import type { HelloMessage } from './sync/wire'
import type { TabManager } from './tab-manager'

/** the size a copy opens at when the tab has no size yet */
const DEFAULT_SIZE = { cols: 80, rows: 24 }

/** the token of the next seed request; one counter for the process, so no two holders ever ask with the same token */
let nextSeedToken = 1

/** the members hear of title changes once per this wait: a program that retitles itself many times a second costs one update */
const TITLE_WAIT_MS = 200

export interface RemoteHolderDeps {
  tabs: Pick<TabManager, 'list' | 'size'>
  scrollback(): number
  hostTabs: HostTabs
  hostHandlers(device: string): Record<string, CallEntry>
  viewerEvents: ViewerEvents
  isLocal(tabId: string): boolean
  selfId(): string
  /** whether this device is present (see Presence): a member is told it with its tab in front */
  present(): boolean
  toast(m: string): void
  /** a device's answer to the lists of the new-tab menu changed what is kept: the window draws it again */
  onFresh(what: 'choices' | 'sessions'): void
  /** starts a screen worker; tests give in-process copies */
  startMirrors(): ScreenMirrorsApi & { onExit(cb: () => void): void }
  /** asks this window for the screen of a tab; the answer comes back through seed(), with the same token */
  requestSeed(tabId: string, token: number): void
  onTitle(tabId: string, title: string): void
  onPeerGone(device: string): void
  log(m: string): void
  /** a member link came up or went down: the window checks what it keeps awake */
  onLinks?(): void
  /** a tab's watchers changed: a member attached to a tab, stopped watching it, or left */
  onWatchers?(): void
}

/**
 * The screen copies the host serves, through the current worker. The holder points it at a new worker when the old one
 * exits, and at none once the worker has been restarted once and exited again: the copies then answer nothing.
 */
class ForwardingMirrors implements ScreenMirrorsApi {
  private current: ScreenMirrorsApi | null = null
  private readonly titleCbs: ((tabId: string, title: string) => void)[] = []

  /** the worker that answers from now on; the title callbacks are registered on it */
  use(m: ScreenMirrorsApi): void {
    this.current = m
    for (const cb of this.titleCbs) m.onTitle(cb)
  }

  /** the worker that answers now, null when there is none */
  worker(): ScreenMirrorsApi | null {
    return this.current
  }

  /** no worker any more: snapshots answer null and the other calls do nothing */
  stop(): void {
    this.current = null
  }

  open(tabId: string, cols: number, rows: number, scrollback: number, opts?: MirrorOpen): void {
    this.current?.open(tabId, cols, rows, scrollback, opts)
  }

  write(tabId: string, seq: number, data: string): void {
    this.current?.write(tabId, seq, data)
  }

  resize(tabId: string, cols: number, rows: number): void {
    this.current?.resize(tabId, cols, rows)
  }

  reset(tabId: string, seq: number): void {
    this.current?.reset(tabId, seq)
  }

  close(tabId: string): void {
    this.current?.close(tabId)
  }

  seed(tabId: string, data: string): void {
    this.current?.seed(tabId, data)
  }

  snapshot(tabId: string): Promise<RemoteSnapshot | null> {
    return this.current ? this.current.snapshot(tabId) : Promise.resolve(null)
  }

  onTitle(cb: (tabId: string, title: string) => void): void {
    this.titleCbs.push(cb)
    this.current?.onTitle(cb)
  }

  dispose(): void {
    const m = this.current
    this.current = null
    m?.dispose()
  }
}

/**
 * This device's side of the remote tabs, as the window holds it while the device group is open: its tabs' screen copies
 * and host, the viewer of the other devices' tabs, and the calls this device makes to them.
 */
export class RemoteHolder {
  readonly host: TabHost
  readonly viewer: RemoteTabs
  readonly actions: RemoteActions
  private readonly forward = new ForwardingMirrors()
  /** the worker exits seen so far: one exit is answered with a new worker, a second one with none */
  private exits = 0
  /** the token of the latest seed request of each tab: only the answer that carries it is applied */
  private readonly latest = new Map<string, number>()
  /** the calls of each linked member, which serve its host handlers and make this device's calls */
  private readonly calls = new Map<PeerLink, Calls>()
  /** the pushes a link refused, once per tab and kind: each is logged the first time only */
  private readonly refusedPushes = new Set<string>()
  /** the members' directory after a title change, once per TITLE_WAIT_MS */
  private readonly titleSoon = new Coalescer(TITLE_WAIT_MS, () => {
    if (!this.disposed) this.host.changed()
  })
  private disposed = false

  /** opens a copy of every tab this device has, each waiting for its seed, and asks the window for each */
  constructor(private readonly deps: RemoteHolderDeps) {
    this.forward.onTitle((tabId, title) => {
      if (this.disposed) return
      deps.onTitle(tabId, title)
      this.titleSoon.request()
    })
    this.startWorker()
    try {
      this.host = new TabHost({
        tabs: deps.hostTabs,
        mirrors: this.forward,
        onPeerGone: (device) => deps.onPeerGone(device),
        onWatchers: () => {
          if (!this.disposed) deps.onWatchers?.()
        },
        onPushRefused: (tabId, k) => this.pushRefused(tabId, k),
        forOlder: olderChatPush
      })
      this.viewer = new RemoteTabs({
        selfId: () => deps.selfId(),
        isLocal: (tabId) => deps.isLocal(tabId),
        present: () => deps.present(),
        events: deps.viewerEvents,
        log: (m) => this.deps.log(m)
      })
      // a toast for a call that fails after dispose is dropped: the window is no longer showing this device
      this.actions = new RemoteActions(
        this.viewer,
        (m) => {
          if (!this.disposed) deps.toast(m)
        },
        (what) => {
          if (!this.disposed) deps.onFresh(what)
        }
      )
      this.openEvery()
    } catch (e) {
      // the worker started above is not left running behind an error
      this.forward.dispose()
      throw e
    }
  }

  /** a member link of the group came up: its tabs and this device's tabs are connected, with the host's handlers for it */
  connect(link: PeerLink, hello: HelloMessage): void {
    if (this.disposed || this.calls.has(link)) return
    this.calls.set(link, connectPeer(link, hello, this.host, this.viewer, this.deps.hostHandlers(hello.id)))
    link.on('close', () => {
      this.calls.delete(link)
      this.linksChanged()
    })
    this.actions.refreshChoices()
    this.actions.refreshSessions()
    this.linksChanged()
  }

  /** the links whose calls this holder keeps: for tests only */
  linkCount(): number {
    return this.calls.size
  }

  /**
   * The window's answer to a seed request, with the token the request went with. Only the latest request of the tab
   * applies: an answer to an older request, of this holder or an earlier one, a second answer, or one for a tab never
   * asked for is dropped.
   */
  seed(tabId: string, token: number, data: string): void {
    if (this.disposed) return
    if (this.latest.get(tabId) !== token) return
    this.latest.delete(tabId)
    this.host.seed(tabId, data)
  }

  /** the tab closed here: its copy is closed and any seed still asked for it is dropped */
  closed(tabId: string): void {
    if (this.disposed) return
    this.latest.delete(tabId)
    this.host.closed(tabId)
  }

  /**
   * every linked device gives its tabs back (onPeerGone), every remote tab closes here (viewerEvents.closed, then
   * devices([])), and everything stops, the worker included
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const device of this.host.peers()) this.deps.onPeerGone(device)
    for (const d of this.viewer.devices()) {
      for (const t of this.viewer.tabsOf(d.id)) this.deps.viewerEvents.closed(t.id)
    }
    this.deps.viewerEvents.devices([])
    this.host.dispose()
    this.viewer.dispose()
    // the links stay open (their owner closes them), but this device's calls on them stop: no host handler runs after this
    for (const c of [...this.calls.values()]) c.close()
    this.calls.clear()
    this.latest.clear()
    this.titleSoon.cancel()
    this.forward.dispose()
  }

  /** the window hears that a member link came or went, unless this holder is disposed */
  private linksChanged(): void {
    if (!this.disposed) this.deps.onLinks?.()
  }

  /** a push a member's link refused: logged the first time for its tab and kind */
  private pushRefused(tabId: string, k: PushKind): void {
    const key = `${tabId} ${k}`
    if (this.refusedPushes.has(key)) return
    this.refusedPushes.add(key)
    this.deps.log(`push of ${k} for tab ${tabId} refused by a member link`)
  }

  private startWorker(): void {
    const m = this.deps.startMirrors()
    m.onExit(() => this.workerExited(m))
    this.forward.use(m)
  }

  private workerExited(m: ScreenMirrorsApi): void {
    if (this.disposed || m !== this.forward.worker()) return
    this.exits++
    this.deps.log(`screen worker exited (${this.exits})`)
    if (this.exits > 1) {
      this.deps.log('screen worker not started again')
      this.forward.stop()
      return
    }
    try {
      this.startWorker()
    } catch (e) {
      this.deps.log(`screen worker could not be started again: ${e instanceof Error ? e.message : String(e)}`)
      this.forward.stop()
      return
    }
    this.openEvery()
  }

  /** each tab opens its copy and is asked for its seed in one step: nothing async between the two */
  private openEvery(): void {
    for (const t of this.deps.tabs.list()) {
      const size = this.deps.tabs.size(t.id) ?? DEFAULT_SIZE
      this.host.opened(t.id, size.cols, size.rows, this.deps.scrollback(), { awaitSeed: true })
      const token = nextSeedToken++
      this.latest.set(t.id, token)
      this.deps.requestSeed(t.id, token)
    }
  }
}
