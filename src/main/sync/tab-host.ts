import { DETACH_BACKLOG_BYTES, MAX_OUT_CHARS, MAX_REMOTE_TABS, REMOTE_COPY, type PushKind, type RemoteSnapshot, type RemoteTab } from '../../shared/remote'
import type { NotificationCase } from '../../shared/types'
import { CallError, type CallEntry } from './calls'
import type { PeerLink } from './peer-link'
import { piecesOf } from './pieces'
import { CALL_ARGS } from './remote-shapes'
import type { ScreenMirrorsApi } from './screen-mirror'
import { TabDirectory } from './tab-directory'
import type { Message } from './wire'

/** the next turn of the event loop: a large review is sent in steps, with a turn between them */
export function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** This device's tabs, as the host serves them to the members. */
export interface HostTabs {
  list(): RemoteTab[]
  has(tabId: string): boolean
  input(tabId: string, data: string, from: string): void
  claim(tabId: string, from: string, cols: number, rows: number): void
  /** the tab of this device in front on a member's window; null: none of them. present: the member is present (see Presence); focused: a 0.15.0 member's flag */
  front(from: string, tabId: string | null, present: boolean, focused: boolean): void
  /** the tab's current hub updates, for a member that attaches; a large review comes in parts, in order */
  pushes(tabId: string): Promise<Array<{ k: PushKind; v: unknown }>>
}

export interface TabHostDeps {
  tabs: HostTabs
  mirrors: ScreenMirrorsApi
  /** how much a member's link may hold unsent before it is detached from a tab; 4 MiB by default */
  detachBacklogBytes?: number
  onPeerGone?(device: string): void
  onWatchers?(): void
  /** a push the member's link refused (send returned false): the tab and the kind of the push */
  onPushRefused?(tabId: string, k: PushKind): void
}

/** a member of the group, linked on one link; `watching`: the tabs it is attached to */
interface Member {
  device: string
  link: PeerLink
  watching: Set<string>
  onMessage: (m: Message) => void
  onClose: () => void
}

/**
 * Serves this device's tabs to each linked member: the directory, attach (a snapshot of the tab's screen copy), the
 * numbered output of the tabs to the members attached to them, the hub pushes, and the member's input, claims and tab
 * in front. Nothing a member sends is trusted: a message for a tab this device does not have is dropped.
 */
export class TabHost {
  private readonly tabs: HostTabs
  private readonly mirrors: ScreenMirrorsApi
  private readonly detachBacklogBytes: number
  private readonly directory = new TabDirectory()
  /** the members by device: one link per device */
  private readonly members = new Map<string, Member>()
  /** the number of the last chunk written into each tab's stream */
  private readonly seqs = new Map<string, number>()
  private disposed = false

  constructor(private readonly deps: TabHostDeps) {
    this.tabs = deps.tabs
    this.mirrors = deps.mirrors
    this.detachBacklogBytes = deps.detachBacklogBytes ?? DETACH_BACKLOG_BYTES
  }

  /** sends the whole directory, reads in / claim / front, and removes the member on the link's 'close' */
  addPeer(link: PeerLink, device: string): void {
    if (this.disposed) return
    const old = this.members.get(device)
    if (old?.link === link) return
    // one link per device: a link that replaces an older one takes its place
    if (old) this.removePeer(old.link)
    this.changed()
    const onMessage = (m: Message): void => {
      try {
        this.inbound(device, m)
      } catch {
        // a message that cannot be served is dropped
      }
    }
    const onClose = (): void => {
      try {
        this.removePeer(link)
      } catch {
        // the link is closed already; nothing more to do with the error
      }
    }
    const member: Member = { device, link, watching: new Set(), onMessage, onClose }
    this.members.set(device, member)
    link.on('message', onMessage)
    link.on('close', onClose)
    link.send({ t: 'tabs', tabs: this.directory.all() })
  }

  /** the member on this link stops watching every tab; onPeerGone fires once */
  removePeer(link: PeerLink): void {
    const member = [...this.members.values()].find((m) => m.link === link)
    if (!member) return
    this.members.delete(member.device)
    this.release(member)
    const watched = member.watching.size > 0
    member.watching.clear()
    if (watched) this.deps.onWatchers?.()
    this.deps.onPeerGone?.(member.device)
  }

  /**
   * the calls this side answers for that member: attach, and tabs (the directory again). The link's one Calls serves
   * them (connectPeer).
   */
  handlers(device: string): Record<string, CallEntry> {
    return {
      attach: {
        bulk: true,
        key: (a) => CALL_ARGS.attach(a)?.id ?? null,
        run: (a) => this.attach(device, a)
      },
      // the directory again, as a push on the same link: the one sent when the link came up may have reached
      // no listener
      tabs: {
        run: (a) => {
          if (!CALL_ARGS.tabs(a)) throw new CallError('bad arguments')
          const member = this.members.get(device)
          if (!member || this.disposed) throw new CallError('not linked')
          member.link.send({ t: 'tabs', tabs: this.directory.all() })
          return {}
        }
      }
    }
  }

  /** an attention of a tab of this device rings on a member that is present with the tab in front; a member not linked hears nothing */
  ring(tabId: string, device: string, reason: NotificationCase): void {
    if (this.disposed || !this.tabs.has(tabId)) return
    this.members.get(device)?.link.send({ t: 'ring', id: tabId, reason })
  }

  /** sends the directory's changes to every member: the tabs that changed, and the tabs that closed */
  changed(): void {
    if (this.disposed) return
    // a viewer drops a directory of more than MAX_REMOTE_TABS entries whole: the first ones in order are sent
    const { changed, closed } = this.directory.diff(this.tabs.list().slice(0, MAX_REMOTE_TABS))
    for (const m of this.members.values()) {
      for (const tab of changed) m.link.send({ t: 'tab', tab })
      for (const id of closed) m.link.send({ t: 'tab-closed', id })
    }
  }

  /** a tab it does not have yet: its copy opens at number 0; one it has (a new worker): the copy opens again at the tab's current number. awaitSeed: see Task 4 */
  opened(tabId: string, cols: number, rows: number, scrollback: number, opts?: { awaitSeed?: boolean }): void {
    if (this.disposed) return
    const seq = this.seqs.get(tabId) ?? 0
    this.seqs.set(tabId, seq)
    this.mirrors.open(tabId, cols, rows, scrollback, { seq, awaitSeed: opts?.awaitSeed === true })
  }

  seed(tabId: string, data: string): void {
    if (this.disposed) return
    this.mirrors.seed(tabId, data)
  }

  /** the tab's copy is gone: its members stop watching it, and its numbering starts again if it opens again */
  closed(tabId: string): void {
    if (this.disposed) return
    this.mirrors.close(tabId)
    this.seqs.delete(tabId)
    let watched = false
    for (const m of this.members.values()) if (m.watching.delete(tabId)) watched = true
    if (watched) this.deps.onWatchers?.()
  }

  resized(tabId: string, cols: number, rows: number): void {
    if (this.disposed) return
    this.mirrors.resize(tabId, cols, rows)
  }

  /** the tab's output: cut into pieces, each numbered and sent to the members attached to the tab */
  output(tabId: string, data: string): void {
    if (!this.hasCopy(tabId)) return
    let watched = false
    for (const piece of piecesOf(data, MAX_OUT_CHARS)) {
      const seq = this.next(tabId)
      this.mirrors.write(tabId, seq, piece)
      for (const m of this.members.values()) {
        if (!m.watching.has(tabId)) continue
        // a member that holds too much is detached, not buffered: it attaches again from a fresh snapshot
        if (m.link.backlog() > this.detachBacklogBytes) {
          m.watching.delete(tabId)
          m.link.send({ t: 'detached', id: tabId })
          watched = true
          continue
        }
        m.link.send({ t: 'out', id: tabId, seq, d: piece })
      }
    }
    if (watched) this.deps.onWatchers?.()
  }

  reset(tabId: string): void {
    if (!this.hasCopy(tabId)) return
    const seq = this.next(tabId)
    this.mirrors.reset(tabId, seq)
    for (const m of this.watchersOf(tabId)) m.link.send({ t: 'reset', id: tabId, seq })
  }

  exit(tabId: string, code: number): void {
    if (!this.hasCopy(tabId)) return
    const seq = this.next(tabId)
    this.mirrors.write(tabId, seq, '')
    for (const m of this.watchersOf(tabId)) m.link.send({ t: 'exit', id: tabId, seq, code })
  }

  /** a hub update of the tab, to the members attached to it */
  push(tabId: string, k: PushKind, v: unknown): void {
    if (this.disposed) return
    for (const m of this.watchersOf(tabId)) this.pushTo(m, tabId, k, v)
  }

  /** the members attached to the tab */
  watchers(tabId: string): string[] {
    return this.watchersOf(tabId).map((m) => m.device)
  }

  peers(): string[] {
    return [...this.members.keys()]
  }

  /** removes every member and its listeners; the links stay open, their owner closes them */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const m of this.members.values()) {
      this.release(m)
      m.watching.clear()
    }
    this.members.clear()
    this.seqs.clear()
  }

  /** attach: the member watches the tab, gets its hub updates, then the snapshot of its copy */
  private async attach(device: string, a: unknown): Promise<RemoteSnapshot> {
    const args = CALL_ARGS.attach(a)
    if (!args) throw new CallError('bad arguments')
    const id = args.id
    if (!this.tabs.has(id)) throw new CallError(REMOTE_COPY.unknownTab)
    const member = this.members.get(device)
    if (!member || this.disposed) throw new CallError('not linked')
    this.watch(member, id)
    const pushes = await this.tabs.pushes(id)
    // a member detached or removed while the pushes were made gets none of them: the viewer attaches again
    if (this.disposed || this.members.get(device) !== member || !member.watching.has(id)) throw new CallError('detached')
    // the status, plan and images go at once; the parts of a review go one per turn, so a large review holds nothing up
    let reviewed = false
    for (const p of pushes) {
      if (p.k === 'review' || p.k === 'review-part') {
        if (reviewed) await nextTurn()
        reviewed = true
        if (this.disposed || this.members.get(device) !== member || !member.watching.has(id)) throw new CallError('detached')
      }
      this.pushTo(member, id, p.k, p.v)
    }
    const snap = await this.mirrors.snapshot(id)
    // a member detached, removed or disposed while its snapshot waited gets no snapshot: the viewer attaches again
    if (this.disposed || this.members.get(device) !== member || !member.watching.has(id)) throw new CallError('detached')
    if (!snap) {
      this.unwatch(member, id)
      throw new CallError('no screen')
    }
    return snap
  }

  /** a message of a member: input, claim and the tab in front, for a tab this device has */
  private inbound(device: string, m: Message): void {
    if (this.disposed) return
    switch (m.t) {
      case 'in':
        if (this.tabs.has(m.id)) this.tabs.input(m.id, m.d, device)
        return
      case 'claim':
        if (this.tabs.has(m.id)) this.tabs.claim(m.id, device, m.cols, m.rows)
        return
      case 'front':
        if (m.id === null) this.tabs.front(device, null, m.present, m.focused)
        else if (this.tabs.has(m.id)) this.tabs.front(device, m.id, m.present, m.focused)
        return
    }
  }

  private watch(member: Member, id: string): void {
    if (member.watching.has(id)) return
    member.watching.add(id)
    this.deps.onWatchers?.()
  }

  private unwatch(member: Member, id: string): void {
    if (member.watching.delete(id)) this.deps.onWatchers?.()
  }

  /**
   * A review push replaces a queued older one for the same tab, and a review part the older part of its index, so the
   * parts of a newer review take the place of an older review's unsent parts; the other kinds are sent at once.
   */
  private pushTo(member: Member, id: string, k: PushKind, v: unknown): void {
    const m: Message = { t: 'push', id, k, v }
    let sent: boolean
    if (k === 'review') sent = member.link.sendBulk(m, `push:review:${id}`)
    else if (k === 'review-part') sent = member.link.sendBulk(m, `push:review:${id}:${(v as { i: number }).i}`)
    else sent = member.link.send(m)
    if (!sent) this.deps.onPushRefused?.(id, k)
  }

  private watchersOf(tabId: string): Member[] {
    return [...this.members.values()].filter((m) => m.watching.has(tabId))
  }

  /** true while the tab has an open copy: after closed() its output is dropped, and a reopen counts from 0 */
  private hasCopy(tabId: string): boolean {
    return !this.disposed && this.seqs.has(tabId)
  }

  /** the next number of a tab's stream */
  private next(tabId: string): number {
    const seq = (this.seqs.get(tabId) ?? 0) + 1
    this.seqs.set(tabId, seq)
    return seq
  }

  /** stops the member's listeners */
  private release(member: Member): void {
    member.link.off('message', member.onMessage)
    member.link.off('close', member.onClose)
  }
}
