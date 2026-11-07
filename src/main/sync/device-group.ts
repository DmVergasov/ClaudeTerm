import { existsSync } from 'node:fs'
import {
  type ActiveDevicesView,
  DEFAULT_DEVICE_PORT,
  DEVICE_COPY,
  type DeviceResult,
  type DevicePlatform,
  type DeviceView,
  MAX_DEVICE_NAME,
  REMOVAL_NOTICE_MS
} from '../../shared/devices'
import type { Vault } from '../accounts'
import { parseAddress } from './address'
import { type DeviceNetDeps, DeviceNet, type NetMember } from './device-net'
import { type DeviceIdentity, IdentityStore } from './identity'
import type { PeerLink } from './peer-link'
import { ReplicaFile } from './replica-file'
import { type Collection, type Dot, emptyReplica, type KeyState, type RecordUpdate, Replica, type ReplicaData, type VersionVector } from './replica'
import { admissionOf, isRemoved, type Removal, removalOf, type SelfDescription, memberOf } from './views'
import { BULK_CHUNK_BYTES, type HelloMessage, type Message } from './wire'

/** The most JSON one records message carries; more records go in the next message. The 1 KiB left in a chunk is for the envelope, so a full batch is one frame. */
const BATCH_BYTES = BULK_CHUNK_BYTES - 1024

/** How long leave waits for the other devices to close their links, in milliseconds. */
const LEAVE_WAIT_MS = 2000

/** The collections whose change may add, remove or re-describe a device. */
const MEMBERSHIP: ReadonlySet<Collection> = new Set<Collection>(['admitted', 'removed', 'members'])

type RecordsMessage = Extract<Message, { t: 'records' }>

export interface DeviceGroupDeps {
  /** the data folder: device-identity.json and sync-replica.json */
  dir: string
  vault: Vault
  host: string
  port: number
  platform: DevicePlatform
  hostName(): string
  /** the addresses other devices can reach this one at */
  addresses(): string[]
  now?(): number
  /** the stars and notes that other devices changed; the bridge writes them into the stores */
  onData(updates: RecordUpdate[]): void
  onView(view: ActiveDevicesView): void
  /** the replica started over (removed, left): the bridge writes the stores' data into it again */
  onReset(): void
  /** a member link is kept and its hello is in: the window connects the device's tabs to it */
  onPeer?(link: PeerLink, hello: HelloMessage): void
  warn(m: string): void
  onError(m: string): void
  timing?: DeviceNetDeps['timing']
  saveDebounceMs?: number
}

/**
 * The device group of this device: its replica of the synced records, the network that links it to the other devices, and
 * the pairing, removal and leaving that change who is in the group. Everything from the network goes through the replica's
 * checks, and a failure only makes the group stop: nothing here throws out of a socket or timer handler.
 */
export class DeviceGroup {
  private identity: DeviceIdentity
  private replica: Replica
  private net: DeviceNet | null = null
  /** the links that authenticated, each with the id of its member */
  private readonly links = new Map<PeerLink, string>()
  /** the latest report each member made about whether it reaches this device */
  private readonly reports = new Map<string, boolean>()
  private leaving = false
  /** true after a reset failed: the group does not listen or dial for the rest of the run */
  private stopped = false
  private closed = false
  /** set by close(): the group is shutting down, so nothing starts and no write is taken */
  private closing: Promise<void> | null = null
  /** the start-over that is running, if any: a second one asks for this one instead of starting its own */
  private resetting: Promise<string | null> | null = null
  /** the start-over that is running, if any; it never rejects */
  private busy: Promise<void> = Promise.resolve()

  private constructor(
    private readonly deps: DeviceGroupDeps,
    private readonly identities: IdentityStore,
    private readonly replicaFile: ReplicaFile,
    identity: DeviceIdentity,
    replica: Replica
  ) {
    this.identity = identity
    this.replica = replica
  }

  /**
   * Opens the group in the data folder. A replica that cannot be read, or that belongs to another identity, starts empty; with
   * an identity that existed before and was not replaced, the identity is replaced too, so no sequence number is reused.
   * A failure is reported through warn and the open is rejected, with nothing left running.
   */
  static async open(deps: DeviceGroupDeps): Promise<DeviceGroup> {
    let replaced = false
    const identities = new IdentityStore(deps.dir, deps.vault, {
      onError: deps.onError,
      warn: (m) => {
        replaced = true
        deps.warn(m)
      }
    })
    const hadIdentity = existsSync(identities.path)
    let group: DeviceGroup | null = null
    try {
      let identity = await identities.load()
      const replicaFile = new ReplicaFile(deps.dir, { debounceMs: deps.saveDebounceMs, onError: deps.onError, warn: deps.warn })
      let data: ReplicaData | null = replicaFile.load()
      if (data === null || data.device !== identity.id) {
        if (hadIdentity && !replaced) {
          identity = await identities.reset()
          deps.warn("This device's sync data could not be read; it was given a new key and has to be paired again")
        }
        data = emptyReplica(identity.id)
      }
      group = new DeviceGroup(deps, identities, replicaFile, identity, new Replica(data, () => (deps.now ? deps.now() : Date.now())))
      group.start()
      return group
    } catch (e) {
      const message = (e as Error).message
      group?.halt()
      deps.warn(message)
      throw e
    }
  }

  /**
   * A local write of a star or a note; returns its dot. Null when the write was ignored: the group is closed or stopped, or this
   * device is leaving.
   */
  write(col: 'stars' | 'notes', key: string, value: unknown, base?: VersionVector): Dot | null {
    if (!this.live() || this.leaving) return null
    const update = this.replica.write(col, key, value, base)
    this.commit(update)
    return ownDot(update, this.replica.device)
  }

  context(col: 'stars' | 'notes', key: string): VersionVector {
    return this.replica.context(col, key)
  }

  state(col: 'stars' | 'notes', key: string): KeyState | undefined {
    return this.replica.get(col, key)
  }

  keys(col: 'stars' | 'notes'): string[] {
    return this.replica.keys(col)
  }

  /** Shows a pairing code and listens for the device that brings it. */
  startPairing(): Promise<ActiveDevicesView> {
    const net = this.live()
    if (!net) return Promise.reject(new Error(DEVICE_COPY.disabled))
    return net.startPairing().then(() => this.view())
  }

  cancelPairing(): void {
    this.live()?.cancelPairing()
  }

  /** Joins the group of the device at `address`, with the code it shows. */
  join(address: string, code: string): Promise<DeviceResult> {
    const net = this.live()
    if (!net) return Promise.resolve({ ok: false, error: DEVICE_COPY.disabled })
    return net.join(address, code)
  }

  /** Removes a device from the group: it is told, when it is connected, and the others refuse it from now on. */
  remove(id: string): DeviceResult {
    if (!this.live() || this.leaving) return { ok: false, error: DEVICE_COPY.disabled }
    if (!this.isMember(id)) return { ok: false, error: DEVICE_COPY.unknownDevice }
    const update = this.replica.write('removed', id, { by: this.identity.id, at: this.now() })
    this.saveSoon()
    // the removed device is not sent the record: its notice follows from the link closing
    this.sendAll(update, id)
    this.membershipChanged()
    return { ok: true }
  }

  /**
   * Leaves the group. It needs a connected device, so that the group hears of it: the removal is sent, and the device starts
   * over once the others have closed their links, or after LEAVE_WAIT_MS.
   */
  async leave(): Promise<DeviceResult> {
    if (this.leaving) return { ok: true }
    if (!this.live()) return { ok: false, error: DEVICE_COPY.disabled }
    if (this.links.size === 0) return { ok: false, error: DEVICE_COPY.leaveNeedsConnection }
    this.leaving = true
    this.commit(this.replica.write('removed', this.identity.id, { by: this.identity.id, at: this.now() }))
    this.onView()
    await this.waitForLinks(LEAVE_WAIT_MS)
    if (this.closing) {
      this.leaving = false
      return { ok: false, error: DEVICE_COPY.disabled }
    }
    const error = await this.startOver(null)
    return error === null ? { ok: true } : { ok: false, error }
  }

  /** Sets or clears the address typed for a device; null clears it. */
  setAddress(id: string, address: string | null): DeviceResult {
    const net = this.live()
    if (!net) return { ok: false, error: DEVICE_COPY.disabled }
    if (!this.isMember(id)) return { ok: false, error: DEVICE_COPY.unknownDevice }
    if (address === null) {
      delete this.replica.local.addresses[id]
    } else {
      const text = address.trim()
      if (!parseAddress(text, DEFAULT_DEVICE_PORT)) return { ok: false, error: DEVICE_COPY.badAddress }
      this.replica.local.addresses[id] = text
    }
    this.saveSoon()
    net.update()
    this.onView()
    return { ok: true }
  }

  /** Renames this device for the others: 1 to 64 characters, no control characters. */
  rename(name: string): DeviceResult {
    if (!this.live()) return { ok: false, error: DEVICE_COPY.disabled }
    const text = name.trim()
    if (text.length < 1 || text.length > MAX_DEVICE_NAME || hasControlCharacter(text)) return { ok: false, error: DEVICE_COPY.badName }
    this.replica.local.name = text
    this.saveSoon()
    this.writeSelf()
    this.onView()
    return { ok: true }
  }

  /** This machine's addresses may have changed: its description is rewritten if they did, and the group redials. */
  refreshSelf(): void {
    const net = this.live()
    if (!net) return
    const before = this.selfAddresses()
    this.writeSelf()
    // update() also re-decides whether to keep listening, which a removal notice window can end
    net.update()
    // the members are dialed again only when this device's addresses moved; otherwise their retry schedule is kept
    if (JSON.stringify(before) !== JSON.stringify(this.selfAddresses())) net.wake()
  }

  /** The addresses this device's record holds for itself, as the others were last told. */
  private selfAddresses(): string[] {
    return memberOf(this.replica.get('members', this.identity.id))?.addresses ?? []
  }

  view(): ActiveDevicesView {
    const net = this.net
    const devices: DeviceView[] = []
    for (const id of this.replica.keys('admitted')) {
      if (!this.isMember(id)) continue
      const admission = admissionOf(this.replica.get('admitted', id))
      if (!admission) continue
      const described = memberOf(this.replica.get('members', id))
      const typed: unknown = this.replica.local.addresses[id]
      devices.push({
        id,
        name: described?.name ?? id,
        platform: described?.platform ?? null,
        state: net ? net.state(id) : { kind: 'unknown' },
        addedBy: this.nameOf(admission.addedBy),
        addedAt: admission.addedAt,
        address: typeof typed === 'string' ? typed : null
      })
    }
    devices.sort((x, y) => x.addedAt - y.addedAt || (x.id < y.id ? -1 : 1))
    const reports = [...this.reports].filter(([id]) => this.isMember(id)).map(([, reached]) => reached)
    return {
      enabled: true,
      self: { id: this.identity.id, name: this.selfName(), addresses: this.deps.addresses(), port: net?.listeningPort() ?? null },
      devices,
      pairing: net ? net.pairing() : null,
      unreachableByOthers: reports.includes(false) && !reports.includes(true),
      removedBy: this.replica.local.removedBy,
      problem: this.stopped ? DEVICE_COPY.syncStopped : net ? net.problem() : null,
      keyring: this.identities.keyring(),
      canLeave: this.links.size > 0 && !this.leaving
    }
  }

  wake(): void {
    this.live()?.wake()
  }

  flush(): void {
    this.replicaFile.flush()
  }

  /** Saves what is pending, then closes the links and the listener. Writes after this are ignored. */
  close(): Promise<void> {
    if (!this.closing) this.closing = this.shutDown()
    return this.closing
  }

  private async shutDown(): Promise<void> {
    // a start-over that is running finishes first, so the identity file and the replica file stay in step; none starts now
    for (let running = this.busy; ; running = this.busy) {
      await running
      if (running === this.busy) break
    }
    this.replicaFile.flush()
    this.closed = true
    const net = this.net
    this.net = null
    this.links.clear()
    this.reports.clear()
    if (net) await net.stop()
  }

  private onView(): void {
    if (this.closed) return
    this.deps.onView(this.view())
  }

  private start(): void {
    this.writeSelf()
    this.net = this.createNet()
    this.net.update()
    this.saveSoon()
    this.replicaFile.flush()
  }

  private live(): DeviceNet | null {
    return this.closing || this.stopped ? null : this.net
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private createNet(): DeviceNet {
    const net: DeviceNet = new DeviceNet({
      identity: this.identity,
      hello: () => ({
        id: this.identity.id,
        name: this.selfName(),
        platform: this.deps.platform,
        port: net.listeningPort() ?? this.deps.port,
        addresses: this.deps.addresses()
      }),
      members: () => this.netMembers(),
      keepListening: () => this.keepsListening(),
      removedBy: (fingerprint) => this.removedByFingerprint(fingerprint),
      onPaired: (link, hello, typed) => this.paired(net, link, hello, typed),
      onLink: (link, hello) => this.linked(net, link, hello),
      onRemovedNotice: (by) => this.removedNotice(net, by),
      onReach: (memberId, reached) => this.reported(net, memberId, reached),
      onChange: () => this.netChanged(net),
      addresses: () => this.deps.addresses(),
      host: this.deps.host,
      port: this.deps.port,
      now: () => this.now(),
      timing: this.deps.timing
    })
    return net
  }

  /** The members the network dials: admitted, not removed, not this device; each with the addresses it may be reached at. */
  private netMembers(): NetMember[] {
    const out: NetMember[] = []
    for (const id of this.replica.keys('admitted')) {
      const admission = admissionOf(this.replica.get('admitted', id))
      if (!admission || !this.isMember(id)) continue
      const described = memberOf(this.replica.get('members', id))
      const typed: unknown = this.replica.local.addresses[id]
      const addresses = [...(typeof typed === 'string' ? [typed] : []), ...(described?.addresses ?? [])]
      out.push({
        id,
        fingerprint: admission.fingerprint,
        addresses: addresses.filter((a, i, all) => a.length > 0 && all.indexOf(a) === i),
        port: described?.port ?? DEFAULT_DEVICE_PORT
      })
    }
    return out
  }

  /** The name of the device that removed the admitted device with this fingerprint; null when none did. */
  private removedByFingerprint(fingerprint: string): string | null {
    for (const id of this.replica.keys('admitted')) {
      if (admissionOf(this.replica.get('admitted', id))?.fingerprint !== fingerprint) continue
      const removal = removalOf(this.replica.get('removed', id))
      return removal ? this.nameOf(removal.by) : null
    }
    return null
  }

  /** A device paired with this one: both sides record the admission, and the typed address is kept on the joiner's side. */
  private paired(net: DeviceNet, link: PeerLink, hello: HelloMessage, typed: string | null): void {
    if (this.net !== net) return
    if (typed !== null) this.replica.local.addresses[hello.id] = typed
    this.replica.local.removedBy = null
    if (admissionOf(this.replica.get('admitted', hello.id)) === null) {
      const admitted = { fingerprint: link.peerFingerprint, addedBy: this.identity.id, addedAt: this.now() }
      this.commit(this.replica.write('admitted', hello.id, admitted))
    }
    this.saveSoon()
    this.membershipChanged()
  }

  /** A member link is kept: the records are exchanged from here on. An inbound link shows that the member reaches this device. */
  private linked(net: DeviceNet, link: PeerLink, hello: HelloMessage): void {
    // the link may have closed before this point: it is not registered then
    if (this.net !== net || !net.links().includes(link)) return
    this.links.set(link, hello.id)
    if (!link.outbound) this.reports.set(hello.id, true)
    link.on('message', (m: Message) => this.received(net, link, m))
    link.on('close', () => this.unlinked(link))
    link.send({ t: 'sync', seen: this.replica.seen() })
    this.notifyPeer(link, hello)
    this.onView()
  }

  /** The window hears of a kept link once; a link closed by now is not reported, since unlinked() has removed it. */
  private notifyPeer(link: PeerLink, hello: HelloMessage): void {
    if (!this.deps.onPeer || !this.links.has(link)) return
    try {
      this.deps.onPeer(link, hello)
    } catch (e) {
      this.deps.onError(`A device's tabs could not be connected: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private unlinked(link: PeerLink): void {
    this.links.delete(link)
    this.onView()
  }

  private received(net: DeviceNet, link: PeerLink, m: Message): void {
    if (this.net !== net || !this.isLinkMember(link)) return
    if (m.t === 'sync') this.sendRecords(link, this.replica.since(m.seen), this.replica.seen())
    else if (m.t === 'records') this.applyRecords(link, m)
  }

  /** Records from a linked device: merged, forwarded to the other links, and reported to the bridge or the network. */
  private applyRecords(link: PeerLink, m: RecordsMessage): void {
    if (this.leaving) return
    const changed = this.replica.apply(m.updates)
    if (m.done) this.replica.absorbSeen(m.done.seen)
    this.saveSoon()
    if (changed.length === 0) return
    // membership first: a link to a device this change removed is closed before anything is forwarded
    const net = this.net
    if (changed.some((u) => MEMBERSHIP.has(u.col))) this.membershipChanged()
    // this device started over: its replica is new, and nothing from the old one goes on
    if (this.net !== net) return
    for (const [other] of this.links) if (other !== link && this.isLinkMember(other)) this.sendRecords(other, changed)
    const data = changed.filter((u) => u.col === 'stars' || u.col === 'notes')
    if (data.length > 0) this.deps.onData(data)
  }

  /** Sends records in messages of about BATCH_BYTES each, on the bulk lane; the last one carries `done` when it is given. */
  private sendRecords(link: PeerLink, updates: RecordUpdate[], done?: VersionVector): void {
    this.saveReservation()
    const batches: RecordUpdate[][] = []
    let batch: RecordUpdate[] = []
    let size = 0
    for (const u of updates) {
      const bytes = Buffer.byteLength(JSON.stringify(u))
      if (batch.length > 0 && size + bytes > BATCH_BYTES) {
        batches.push(batch)
        batch = []
        size = 0
      }
      batch.push(u)
      size += bytes
    }
    if (batch.length > 0) batches.push(batch)
    if (batches.length === 0 && done) batches.push([])
    for (let i = 0; i < batches.length; i++) {
      const last = i === batches.length - 1
      // a batch the link refuses ends the records: the peer must not mark as seen what it never got, so no done follows either
      const sent = link.sendBulk(last && done ? { t: 'records', updates: batches[i], done: { seen: done } } : { t: 'records', updates: batches[i] })
      if (!sent) return
    }
  }

  /** A local write: saved, and sent to every linked device. */
  private commit(update: RecordUpdate): void {
    this.saveSoon()
    this.sendAll(update)
  }

  private sendAll(update: RecordUpdate, except?: string): void {
    for (const [link, id] of this.links) if (id !== except && this.isMember(id)) this.sendRecords(link, [update])
  }

  private saveSoon(): void {
    if (this.closed) return
    this.replicaFile.schedule(() => this.replica.data())
  }

  /**
   * Saves the replica now when a write moved its sequence reservation: a number above the saved reservation must be on disk
   * before any record that uses it leaves the device, or a crash could make this device reuse it.
   */
  private saveReservation(): void {
    if (!this.replica.takeReserveSave()) return
    this.saveSoon()
    if (!this.replicaFile.flush()) this.replica.reserveSaveFailed()
  }

  private reported(net: DeviceNet, memberId: string, reached: boolean | null): void {
    if (this.net !== net || reached === null) return
    this.reports.set(memberId, reached)
  }

  private netChanged(net: DeviceNet): void {
    if (this.net !== net) return
    this.writeSelf()
    this.onView()
  }

  private removedNotice(net: DeviceNet, by: string): void {
    if (this.net !== net || this.leaving) return
    void this.restart(by)
  }

  /** The membership changed: a device that was removed starts over, and the links are updated otherwise. */
  private membershipChanged(): void {
    const removal = this.removedSelf()
    if (removal !== null) {
      void this.restart(removal)
      return
    }
    // a link to a device that is no longer a member is forgotten at once; net.update() closes its connection
    for (const [link, id] of [...this.links]) if (!this.isMember(id)) this.links.delete(link)
    this.net?.update()
    this.onView()
  }

  /** Starts over from an event handler: nothing is thrown out of it, and a failure leaves the group stopped. */
  private restart(removedBy: string | null): Promise<string | null> {
    return this.startOver(removedBy).catch((e: unknown) => this.stopWith(e))
  }

  /** The name of the device that removed this one, when it was removed. */
  private removedSelf(): string | null {
    if (this.leaving) return null
    const removal: Removal | null = removalOf(this.replica.get('removed', this.identity.id))
    return removal ? this.nameOf(removal.by) : null
  }

  /**
   * Starts over with a new identity and an empty replica, the reason it was removed kept. Null when it did; the error message
   * when the key could not be replaced, in which case the group stays stopped.
   */
  private startOver(removedBy: string | null): Promise<string | null> {
    // one reset at a time: a second request gets the running one
    if (this.resetting) return this.resetting
    if (this.closing) return Promise.resolve(null)
    const run = this.runStartOver(removedBy).finally(() => {
      this.resetting = null
    })
    this.resetting = run
    this.busy = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async runStartOver(removedBy: string | null): Promise<string | null> {
    this.halt()
    let identity: DeviceIdentity
    try {
      identity = await this.identities.reset()
    } catch (e) {
      return this.stopWith(e)
    }
    try {
      this.identity = identity
      const data = emptyReplica(identity.id)
      data.local.removedBy = removedBy
      // the name this device was given stays with it
      data.local.name = this.replica.local.name
      this.replica = new Replica(data, () => this.now())
      this.leaving = false
      this.saveSoon()
      this.replicaFile.flush()
      this.net = this.createNet()
      this.net.update()
      this.deps.onReset()
      this.onView()
      return null
    } catch (e) {
      return this.stopWith(e)
    }
  }

  /** A failure while starting over: reported through onError, and the group stays stopped. Returns the message. */
  private stopWith(e: unknown): string {
    const message = e instanceof Error ? e.message : String(e)
    this.halt()
    this.stopped = true
    this.leaving = false
    this.deps.onError(message)
    try {
      this.onView()
    } catch {
      // the next change reports the view again
    }
    return message
  }

  /** Stops the network and forgets the links; nothing is written. */
  private halt(): void {
    const net = this.net
    this.net = null
    this.links.clear()
    this.reports.clear()
    void net?.stop()
  }

  private async waitForLinks(ms: number): Promise<void> {
    const end = Date.now() + ms
    while (this.links.size > 0 && !this.closing && Date.now() < end) await sleep(10)
  }

  /** Writes this device's own description when it differs from the record; the port is written once it is known. */
  private writeSelf(): void {
    if (this.stopped || this.closed) return
    const port = this.net?.listeningPort() ?? this.deps.port
    if (port < 1) return
    const want: SelfDescription = { name: this.selfName(), platform: this.deps.platform, addresses: this.deps.addresses(), port }
    const cur = memberOf(this.replica.get('members', this.identity.id))
    if (cur && sameDescription(cur, want)) return
    this.commit(this.replica.write('members', this.identity.id, want))
  }

  /** An admitted device other than this one that has not been removed. */
  private isMember(id: string): boolean {
    return id !== this.identity.id && admissionOf(this.replica.get('admitted', id)) !== null && !isRemoved(this.replica.get('removed', id))
  }

  /** Whether the member on a link is still a member; a link to a device that is not one carries nothing. */
  private isLinkMember(link: PeerLink): boolean {
    const id = this.links.get(link)
    return id !== undefined && this.isMember(id)
  }

  /** Whether a removal this device wrote is recent enough that its listener stays open for the removed device to hear it. */
  private keepsListening(): boolean {
    const now = this.now()
    for (const id of this.replica.keys('removed')) {
      for (const s of this.replica.get('removed', id)?.siblings ?? []) {
        const removal = s.value as Removal | null
        if (removal && removal.by === this.identity.id && now - removal.at < REMOVAL_NOTICE_MS) return true
      }
    }
    return false
  }

  private selfName(): string {
    const name = (this.replica.local.name ?? this.deps.hostName()).trim().slice(0, MAX_DEVICE_NAME)
    return name.length > 0 ? name : this.identity.id
  }

  private nameOf(id: string): string {
    if (id === this.identity.id) return this.selfName()
    return memberOf(this.replica.get('members', id))?.name ?? id
  }
}

/** The dot of the sibling a local write added: this device's latest sequence number in the record. */
function ownDot(update: RecordUpdate, device: string): Dot | null {
  let dot: Dot | null = null
  for (const s of update.state.siblings) {
    if (s.dot[0] === device && (dot === null || s.dot[1] > dot[1])) dot = s.dot
  }
  return dot
}

function sameDescription(a: SelfDescription, b: SelfDescription): boolean {
  return a.name === b.name && a.platform === b.platform && a.port === b.port && JSON.stringify(a.addresses) === JSON.stringify(b.addresses)
}

function hasControlCharacter(text: string): boolean {
  // C0 controls, DEL, and the C1 controls U+0080 to U+009F
  return [...text].some((ch) => {
    const code = ch.charCodeAt(0)
    return code < 32 || (code >= 127 && code <= 159)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
