import type { AddressInfo, Socket } from 'node:net'
import * as tls from 'node:tls'
import type { TLSSocket } from 'node:tls'
import { DEFAULT_DEVICE_PORT, DEVICE_COPY, type DeviceResult, type DeviceState, MAX_PAIR_FAILURES, PAIR_CODE_TTL_MS, type PairingView } from '../../shared/devices'
import { parseAddress } from './address'
import type { DeviceIdentity } from './identity'
import { newPairCode, normalizePairCode, pairProof, proofMatches } from './pair-code'
import { PeerLink, type PeerLinkOptions } from './peer-link'
import { type HelloMessage, MAX_FRAME_BYTES, type Message, PRE_AUTH_FRAME_BYTES, PROTOCOL_VERSION } from './wire'

/** A device of the group as the group knows it: where to dial it, and the fingerprint its certificate must have. */
export interface NetMember {
  id: string
  fingerprint: string
  addresses: string[]
  port: number
}

/** The waits of the device network, in milliseconds; tests shorten them. */
export interface DeviceNetTiming {
  minRetryMs: number
  maxRetryMs: number
  dialTimeoutMs: number
  /** how long each step of a handshake may wait for the peer's next message */
  handshakeMs: number
  link?: Partial<PeerLinkOptions>
}

export interface DeviceNetDeps {
  identity: DeviceIdentity
  hello(): Omit<HelloMessage, 't' | 'v' | 'reachedYou'>
  /** admitted, not removed, not this device */
  members(): NetMember[]
  /** the remover's name when that fingerprint was removed from the group; null otherwise */
  removedBy(fingerprint: string): string | null
  /** the addresses other devices can reach this one at: the pairing code lists them */
  addresses(): string[]
  onPaired(link: PeerLink, hello: HelloMessage, typedAddress: string | null): void
  onLink(link: PeerLink, hello: HelloMessage): void
  onRemovedNotice(by: string): void
  onReach(memberId: string, reachedYou: boolean | null): void
  /** listening, pairing or a member's state changed */
  onChange(): void
  /** listen even without members or a code: a device that removed another keeps listening for a while, so the removed one hears of it */
  keepListening?(): boolean
  host: string
  port: number
  now(): number
  timing?: Partial<DeviceNetTiming>
}

const DEFAULT_TIMING: DeviceNetTiming = { minRetryMs: 2_000, maxRetryMs: 60_000, dialTimeoutMs: 5_000, handshakeMs: 10_000 }

/** How many inbound connections may be unauthenticated at once; one past this is closed as it arrives. */
const MAX_PENDING_SOCKETS = 16

/** The endpoint of a connection: unique among the connections open at once, so it names one of them. */
function endpointOf(socket: Socket): string {
  return `${socket.remoteAddress}:${socket.remotePort}`
}

/** Reads the next message of a handshake; a message it does not expect closes the link. */
type Reader = (m: Message) => void

/** The socket under each link, so a last message can be written before the link closes. */
const socketOf = new WeakMap<PeerLink, TLSSocket>()

/** Sends one last message, then closes the link once that message is written, so the peer gets it. */
export function closeWithNotice(link: PeerLink, m: Message, reason: string): void {
  const socket = socketOf.get(link)
  link.send(m)
  if (socket) socket.end(() => link.close(reason))
  else link.close(reason)
}

/**
 * One authentication over a new link. Each step reads the peer's next message, and a step that hears nothing within the
 * time limit closes the link. `done` hands the link over and stops reading it here.
 */
class Exchange {
  readonly link: PeerLink
  private reader: Reader | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private open = true
  private readonly listener = (m: Message): void => {
    if (this.reader) this.reader(m)
    else this.link.close('out of order')
  }

  constructor(
    readonly socket: TLSSocket,
    outbound: boolean,
    opts: Partial<PeerLinkOptions>,
    private readonly limitMs: number,
    private readonly onAbort: (reason: string) => void = () => {}
  ) {
    // a link is held to the small frame limit until its handshake hands it over
    this.link = new PeerLink(socket, { outbound, ...opts, maxFrameBytes: PRE_AUTH_FRAME_BYTES })
    socketOf.set(this.link, socket)
    this.link.on('message', this.listener)
    this.link.on('close', (reason: string) => {
      if (!this.open) return
      this.open = false
      this.clear()
      this.onAbort(reason)
    })
  }

  /** The next message is read by `reader`, and the peer has the time limit to send it. */
  next(reader: Reader): void {
    if (!this.open) return
    this.reader = reader
    this.clear()
    this.timer = setTimeout(() => this.link.close('handshake timeout'), this.limitMs)
  }

  /** The handshake succeeded: the link is handed over, no longer read here, and may carry member-sized frames. */
  done(): PeerLink {
    this.release()
    this.link.setMaxFrameBytes(MAX_FRAME_BYTES)
    return this.link
  }

  /** The peer is refused with one last message: the link closes once that message is written. */
  refuse(m: Message, reason: string): void {
    this.release()
    closeWithNotice(this.link, m, reason)
  }

  /** The handshake failed: the link closes. */
  fail(reason: string): void {
    this.link.close(reason)
  }

  private release(): void {
    this.open = false
    this.clear()
    this.link.off('message', this.listener)
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

interface Slot {
  member: NetMember
  dialing: boolean
  retry: ReturnType<typeof setTimeout> | null
  /** dial rounds in a row that reached no address; 0 once a link authenticates */
  failures: number
  /** host:port of the last address tried */
  tried: string | null
  /** whether this device last reached the member: sent in our hello */
  reached: boolean | null
}

interface Pairing {
  code: string
  expiresAt: number
  failures: number
}

/**
 * The network of a device's group: the TLS listener, dialing the members, pairing with a code, and one link per member.
 * Everything from the network is checked before it is trusted; nothing here throws out of a socket or timer handler.
 */
export class DeviceNet {
  private readonly timing: DeviceNetTiming
  private readonly slots = new Map<string, Slot>()
  /** the link kept for each member: only links that authenticated */
  private readonly kept = new Map<string, PeerLink>()
  /** when each member's kept link closed, in this run */
  private readonly since = new Map<string, number>()
  /** every socket not yet closed, so stop can end them all */
  private readonly sockets = new Set<Socket>()
  /** inbound connections that are not member links yet and not closed, by endpoint; at most MAX_PENDING_SOCKETS */
  private readonly pending = new Map<string, Socket>()
  private server: tls.Server | null = null
  private listening: number | null = null
  private ready: Promise<void> = Promise.resolve()
  private problemText: string | null = null
  private pairingState: Pairing | null = null
  private pairTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private stopping: Promise<void> | null = null

  constructor(private readonly deps: DeviceNetDeps) {
    this.timing = { ...DEFAULT_TIMING, ...deps.timing }
  }

  /** Listens or stops listening to match what the device needs, dials the members that have no link, and closes the links of former members. */
  update(): void {
    if (this.stopped) return
    const members = this.deps.members()
    const ids = new Set(members.map((m) => m.id))
    for (const [id, slot] of [...this.slots]) {
      if (ids.has(id)) continue
      this.clearRetry(slot)
      this.slots.delete(id)
    }
    for (const [id, link] of [...this.kept]) {
      if (ids.has(id)) continue
      this.kept.delete(id)
      this.since.delete(id)
      // a former member that the group removed hears of it before its link closes
      const by = this.deps.removedBy(link.peerFingerprint)
      if (by !== null) closeWithNotice(link, { t: 'removed', by }, 'removed')
      else link.close('removed from the group')
    }
    for (const m of members) {
      const link = this.kept.get(m.id)
      if (link && link.peerFingerprint !== m.fingerprint) {
        this.kept.delete(m.id)
        link.close('fingerprint changed')
      }
      const slot = this.slots.get(m.id)
      if (!slot) {
        const created: Slot = { member: m, dialing: false, retry: null, failures: 0, tried: null, reached: null }
        this.slots.set(m.id, created)
        this.dial(created)
        continue
      }
      // a member whose address or certificate changed is dialed now; any other keeps its retry schedule
      const moved =
        slot.member.fingerprint !== m.fingerprint ||
        slot.member.port !== m.port ||
        JSON.stringify(slot.member.addresses) !== JSON.stringify(m.addresses)
      slot.member = m
      if (moved) this.dial(slot)
    }
    this.reconcile()
    this.deps.onChange()
  }

  /** A new pairing code, replacing one that is shown; resolves once the listener is up (or has failed, see problem()). */
  startPairing(): Promise<PairingView> {
    if (this.stopped) return Promise.reject(new Error('device network stopped'))
    const pairing: Pairing = { code: newPairCode(), expiresAt: this.deps.now() + PAIR_CODE_TTL_MS, failures: 0 }
    this.endPairing()
    this.pairingState = pairing
    this.pairTimer = setTimeout(() => this.cancelPairing(), PAIR_CODE_TTL_MS)
    this.deps.onChange()
    return this.listen().then(() => this.viewOf(pairing))
  }

  cancelPairing(): void {
    if (!this.pairingState) return
    this.endPairing()
    this.reconcile()
    this.deps.onChange()
  }

  pairing(): PairingView | null {
    const pairing = this.pairingState
    if (!pairing || this.deps.now() > pairing.expiresAt) return null
    return this.viewOf(pairing)
  }

  /** Joins the group of the device at `address`, with the code it shows. */
  join(address: string, code: string): Promise<DeviceResult> {
    const key = normalizePairCode(code)
    if (key === null) return Promise.resolve({ ok: false, error: DEVICE_COPY.joinBadCode })
    const target = parseAddress(address, DEFAULT_DEVICE_PORT)
    const noAnswer: DeviceResult = { ok: false, error: DEVICE_COPY.joinNoAnswer }
    if (!target || this.stopped) return Promise.resolve(noAnswer)
    return new Promise<DeviceResult>((resolve) => {
      let settled = false
      const end = (result: DeviceResult): void => {
        if (settled) return
        settled = true
        clearTimeout(dialTimer)
        resolve(result)
      }
      const socket = this.connect(target.host, target.port)
      const dialTimer = setTimeout(() => {
        socket.destroy()
        end(noAnswer)
      }, this.timing.dialTimeoutMs)
      socket.on('error', () => end(noAnswer))
      socket.on('close', () => end(noAnswer))
      socket.once('secureConnect', () => {
        clearTimeout(dialTimer)
        const ex = new Exchange(socket, true, this.timing.link ?? {}, this.timing.handshakeMs, () => end(noAnswer))
        const hostFingerprint = ex.link.peerFingerprint
        ex.link.send(this.helloMessage(null))
        ex.link.send({ t: 'pair', proof: pairProof(key, 'join', hostFingerprint, this.deps.identity.fingerprint) })
        ex.next((m) => this.joinerReply(ex, { key, hostFingerprint, typed: address.trim(), host: null, end }, m))
      })
    })
  }

  /** The state of a member as this device sees it. */
  state(memberId: string): DeviceState {
    if (this.kept.has(memberId)) return { kind: 'connected' }
    const since = this.since.get(memberId)
    if (since !== undefined) return { kind: 'offline', since }
    const slot = this.slots.get(memberId)
    if (slot && slot.tried !== null && slot.failures > 0) return { kind: 'unreachable', address: slot.tried }
    return { kind: 'unknown' }
  }

  listeningPort(): number | null {
    return this.listening
  }

  /** Why the device cannot listen, in words for the user; null when it can, or is not trying to. */
  problem(): string | null {
    return this.problemText
  }

  /** The member links that authenticated and are open. */
  links(): PeerLink[] {
    return [...this.kept.values()]
  }

  /** Dials every member that has no link now, instead of waiting for the next retry. */
  wake(): void {
    if (this.stopped) return
    for (const slot of this.slots.values()) this.dial(slot)
  }

  /** Closes every link and the listener, cancels pairing and retries; resolves once the listener has closed. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopped = true
    this.endPairing()
    for (const slot of this.slots.values()) this.clearRetry(slot)
    this.slots.clear()
    const links = [...this.kept.values()]
    this.kept.clear()
    this.since.clear()
    for (const link of links) link.close('stopped')
    for (const socket of [...this.sockets]) socket.destroy()
    const server = this.server
    this.server = null
    this.listening = null
    this.stopping = new Promise<void>((resolve) => {
      if (!server) resolve()
      else server.close(() => resolve())
    })
    return this.stopping
  }

  private viewOf(pairing: Pairing): PairingView {
    return { code: pairing.code, addresses: this.deps.addresses(), port: this.listening ?? this.deps.port, expiresAt: pairing.expiresAt }
  }

  /** Ends the pairing code without touching the listener. */
  private endPairing(): void {
    if (this.pairTimer) clearTimeout(this.pairTimer)
    this.pairTimer = null
    this.pairingState = null
  }

  /** Listens while there is a code or a member; stops otherwise. */
  private reconcile(): void {
    if (this.stopped) return
    if (this.pairingState || this.deps.members().length > 0 || this.deps.keepListening?.()) this.listen()
    else this.closeServer()
  }

  private listen(): Promise<void> {
    if (this.server) return this.ready
    const server = tls.createServer({
      key: this.deps.identity.keyPem,
      cert: this.deps.identity.certPem,
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      // a connection that never finishes its TLS handshake is closed after the same time a handshake may take
      handshakeTimeout: this.timing.handshakeMs
    })
    server.on('connection', (raw: Socket) => this.admit(raw))
    server.on('secureConnection', (socket: TLSSocket) => this.accept(socket))
    // a client that fails the TLS handshake is dropped: a handshake timeout leaves its socket open, so it is destroyed here
    server.on('tlsClientError', (_e: Error, socket: TLSSocket) => socket.destroy())
    this.server = server
    this.ready = new Promise<void>((resolve) => this.bind(server, this.deps.host, resolve))
    return this.ready
  }

  private bind(server: tls.Server, host: string, done: () => void): void {
    const onError = (e: NodeJS.ErrnoException): void => {
      server.off('listening', onListening)
      // a host with no IPv6 stack: every IPv4 interface instead
      if (host === '::' && (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL')) {
        this.bind(server, '0.0.0.0', done)
        return
      }
      this.fail(server, e)
      done()
    }
    const onListening = (): void => {
      server.off('error', onError)
      if (this.server !== server) {
        // stopped or replaced while binding
        server.close()
      } else {
        this.listening = (server.address() as AddressInfo).port
        this.problemText = null
        server.on('error', (e: Error) => this.fail(server, e))
        this.deps.onChange()
      }
      done()
    }
    server.once('listening', onListening)
    server.once('error', onError)
    server.listen(this.deps.port, host)
  }

  /** The listener failed: it is dropped, and the problem is shown to the user. EACCES is a port Windows excludes. */
  private fail(server: tls.Server, e: NodeJS.ErrnoException | Error): void {
    if (this.server !== server) return
    this.server = null
    this.listening = null
    const code = (e as NodeJS.ErrnoException).code
    this.problemText = code === 'EADDRINUSE' || code === 'EACCES' ? DEVICE_COPY.portInUse(this.deps.port) : e.message
    server.close()
    this.deps.onChange()
  }

  private closeServer(): void {
    const server = this.server
    if (!server) return
    this.server = null
    this.listening = null
    server.close()
  }

  private connect(host: string, port: number): TLSSocket {
    const socket = tls.connect({
      host,
      port,
      key: this.deps.identity.keyPem,
      cert: this.deps.identity.certPem,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3'
    })
    this.track(socket)
    return socket
  }

  private track(socket: Socket): void {
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
  }

  /** An inbound connection counts as pending until it becomes a member link or closes; past the cap it is destroyed at once. */
  private admit(raw: Socket): void {
    this.track(raw)
    if (this.pending.size >= MAX_PENDING_SOCKETS) {
      raw.destroy()
      return
    }
    const key = endpointOf(raw)
    this.pending.set(key, raw)
    raw.once('close', () => {
      if (this.pending.get(key) === raw) this.pending.delete(key)
    })
  }

  /** The connection of `ex` becomes a member link: it no longer counts as pending. */
  private unpend(ex: Exchange): void {
    this.pending.delete(endpointOf(ex.socket))
  }

  private helloMessage(reachedYou: boolean | null): HelloMessage {
    return { t: 'hello', v: PROTOCOL_VERSION, ...this.deps.hello(), reachedYou }
  }

  /** A connection from a device: it must be a member, a removed device, or a device that brings the code. */
  private accept(socket: TLSSocket): void {
    this.track(socket)
    if (this.stopped) {
      socket.destroy()
      return
    }
    const ex = new Exchange(socket, false, this.timing.link ?? {}, this.timing.handshakeMs)
    ex.next((m) => this.acceptHello(ex, m))
  }

  private acceptHello(ex: Exchange, m: Message): void {
    if (m.t !== 'hello') return ex.fail('out of order')
    if (m.v !== PROTOCOL_VERSION) return ex.fail('protocol version')
    const fingerprint = ex.link.peerFingerprint
    if (this.stillMember(m.id, fingerprint)) {
      ex.link.send(this.helloMessage(this.slots.get(m.id)?.reached ?? null))
      this.unpend(ex)
      this.linkUp(m.id, ex.done(), m)
      return
    }
    const by = this.deps.removedBy(fingerprint)
    if (by !== null) return ex.refuse({ t: 'removed', by }, 'removed')
    // not a member: the device may be bringing a code, so its next message is read as the pairing proof; with no code
    // shown, acceptPair answers 'no-code' to that proof, and a device that sends anything else is closed
    ex.next((next) => this.acceptPair(ex, m, next))
  }

  /** The joiner's proof for the code: on success the joiner is paired and its link is kept. */
  private acceptPair(ex: Exchange, hello: HelloMessage, m: Message): void {
    if (m.t !== 'pair') return ex.fail('out of order')
    const pairing = this.pairingState
    if (!pairing) return ex.refuse({ t: 'pair-fail', reason: 'no-code' }, 'no-code')
    const fingerprint = ex.link.peerFingerprint
    // this device's own certificate or id is never paired with: the code stays up
    if (this.isSelf(hello.id, fingerprint)) return ex.fail('self')
    if (this.deps.now() > pairing.expiresAt) {
      this.cancelPairing()
      return ex.refuse({ t: 'pair-fail', reason: 'expired' }, 'expired')
    }
    const expected = pairProof(pairing.code, 'join', this.deps.identity.fingerprint, fingerprint)
    if (!proofMatches(m.proof, expected)) {
      pairing.failures += 1
      if (pairing.failures >= MAX_PAIR_FAILURES) this.cancelPairing()
      return ex.refuse({ t: 'pair-fail', reason: 'code' }, 'code')
    }
    // the code is used up; the listener stays up until the group calls update(), which reconciles it
    this.endPairing()
    this.deps.onChange()
    this.unpend(ex)
    const link = ex.done()
    link.send(this.helloMessage(null))
    link.send({ t: 'pair-ok', proof: pairProof(pairing.code, 'accept', this.deps.identity.fingerprint, fingerprint) })
    this.pairedUp(link, hello, null)
  }

  private joinerReply(
    ex: Exchange,
    join: { key: string; hostFingerprint: string; typed: string; host: HelloMessage | null; end: (r: DeviceResult) => void },
    m: Message
  ): void {
    if (m.t === 'hello') {
      if (join.host || m.v !== PROTOCOL_VERSION) return ex.fail('out of order')
      return ex.next((next) => this.joinerReply(ex, { ...join, host: m }, next))
    }
    if (m.t === 'pair-fail') {
      join.end({ ok: false, error: m.reason === 'no-code' ? DEVICE_COPY.joinNoCode : DEVICE_COPY.joinBadCode })
      return ex.fail(m.reason)
    }
    if (m.t !== 'pair-ok' || !join.host) return ex.fail('out of order')
    // a host that is this device itself is never paired with
    if (this.isSelf(join.host.id, join.hostFingerprint)) return ex.fail('self')
    if (!proofMatches(m.proof, pairProof(join.key, 'accept', join.hostFingerprint, this.deps.identity.fingerprint))) {
      join.end({ ok: false, error: DEVICE_COPY.joinNotProved })
      return ex.fail('bad proof')
    }
    this.pairedUp(ex.done(), join.host, join.typed)
    join.end({ ok: true })
  }

  /** Whether a peer is this device itself: its id or its certificate is this device's own. */
  private isSelf(id: string, fingerprint: string): boolean {
    return id === this.deps.identity.id || fingerprint === this.deps.identity.fingerprint
  }

  /** Whether the group still has `id` with this certificate. Read again whenever a link is about to be kept. */
  private stillMember(id: string, fingerprint: string): boolean {
    return this.deps.members().some((m) => m.id === id && m.fingerprint === fingerprint)
  }

  /** A link that authenticated as a new device: it is kept, and the group is told it is paired. */
  private pairedUp(link: PeerLink, hello: HelloMessage, typedAddress: string | null): void {
    if (!this.keep(hello.id, link)) return
    this.deps.onPaired(link, hello, typedAddress)
    this.deps.onLink(link, hello)
  }

  /** A link that authenticated as a member: its reach report and the link go to the group, unless the other link wins. */
  private linkUp(id: string, link: PeerLink, hello: HelloMessage): void {
    // a member removed while the handshake ran is not linked
    if (!this.stillMember(id, link.peerFingerprint)) {
      link.close('no longer a member')
      return
    }
    if (!this.keep(id, link)) return
    this.deps.onReach(id, hello.reachedYou)
    this.deps.onLink(link, hello)
  }

  /**
   * Keeps `link` as the link to member `id`. When another link to that member is kept, the one dialed by the device with
   * the lower id is kept, on both sides, and the other is closed. Two links dialed by the same device: the newer is kept,
   * since after a sleep the older one is likely dead. False when `link` is the one closed.
   */
  private keep(id: string, link: PeerLink): boolean {
    const current = this.kept.get(id)
    if (current && this.dialerOf(id, link) > this.dialerOf(id, current)) {
      link.close('duplicate')
      return false
    }
    this.kept.set(id, link)
    this.since.delete(id)
    const slot = this.slots.get(id)
    if (slot) slot.failures = 0
    link.on('close', () => this.linkClosed(id, link))
    link.on('message', (m: Message) => {
      if (m.t === 'removed' && this.kept.get(id) === link) this.removedNotice(link, m.by)
    })
    if (current) current.close('duplicate')
    this.deps.onChange()
    return true
  }

  private dialerOf(id: string, link: PeerLink): string {
    return link.outbound ? this.deps.identity.id : id
  }

  private linkClosed(id: string, link: PeerLink): void {
    if (this.kept.get(id) !== link) return
    this.kept.delete(id)
    this.since.set(id, this.deps.now())
    const slot = this.slots.get(id)
    if (slot) {
      slot.failures = 1
      this.retryLater(slot)
    }
    this.deps.onChange()
  }

  /** A removed notice on a member link: the group hears it, and the link closes. */
  private removedNotice(link: PeerLink, by: string): void {
    this.deps.onRemovedNotice(by)
    link.close('removed')
  }

  private dial(slot: Slot): void {
    if (this.stopped || slot.dialing || this.kept.has(slot.member.id)) return
    this.clearRetry(slot)
    slot.dialing = true
    // a round that throws is a failed attempt: the slot is not left dialing, and a retry is scheduled
    void this.round(slot)
      .catch(() => false)
      .then((ok) => {
        slot.dialing = false
        if (this.stopped || this.slots.get(slot.member.id) !== slot) return
        if (ok) slot.failures = 0
        else {
          slot.failures += 1
          this.retryLater(slot)
        }
        this.deps.onChange()
      })
  }

  /** Tries each address of the member in turn; true when a link authenticated (or one is kept already). */
  private async round(slot: Slot): Promise<boolean> {
    const member = slot.member
    if (this.kept.has(member.id)) return true
    for (const address of member.addresses) {
      const target = parseAddress(address, member.port)
      if (!target) continue
      if (this.stopped || this.slots.get(member.id) !== slot) return false
      slot.tried = `${target.host}:${target.port}`
      if (await this.dialOne(slot, target.host, target.port)) {
        slot.reached = true
        return true
      }
      if (this.kept.has(member.id)) return true
    }
    slot.reached = false
    return false
  }

  /** One dial: connect, then the member handshake. True when the member authenticated. */
  private dialOne(slot: Slot, host: string, port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(dialTimer)
        resolve(ok)
      }
      const socket = this.connect(host, port)
      const dialTimer = setTimeout(() => {
        socket.destroy()
        finish(false)
      }, this.timing.dialTimeoutMs)
      socket.on('error', () => finish(false))
      socket.on('close', () => finish(false))
      socket.once('secureConnect', () => {
        clearTimeout(dialTimer)
        const ex = new Exchange(socket, true, this.timing.link ?? {}, this.timing.handshakeMs, () => finish(false))
        const fingerprint = ex.link.peerFingerprint
        if (fingerprint !== slot.member.fingerprint) return ex.fail('fingerprint mismatch')
        // the member may have been removed while the connection was made
        if (this.stopped || this.slots.get(slot.member.id) !== slot || !this.stillMember(slot.member.id, fingerprint)) {
          return ex.fail('no longer a member')
        }
        ex.link.send(this.helloMessage(slot.reached))
        ex.next((m) => this.dialerReply(ex, slot, m, finish))
      })
    })
  }

  private dialerReply(ex: Exchange, slot: Slot, m: Message, finish: (ok: boolean) => void): void {
    const id = slot.member.id
    if (m.t === 'removed') {
      if (this.stillMember(id, ex.link.peerFingerprint)) this.deps.onRemovedNotice(m.by)
      return ex.fail('removed')
    }
    if (this.stopped || this.slots.get(id) !== slot) return ex.fail('no longer a member')
    if (m.t !== 'hello' || m.v !== PROTOCOL_VERSION || m.id !== id) return ex.fail('out of order')
    this.linkUp(id, ex.done(), m)
    finish(true)
  }

  private retryLater(slot: Slot): void {
    this.clearRetry(slot)
    const delay = Math.min(this.timing.minRetryMs * 2 ** (slot.failures - 1), this.timing.maxRetryMs)
    slot.retry = setTimeout(() => {
      slot.retry = null
      this.dial(slot)
    }, delay)
  }

  private clearRetry(slot: Slot): void {
    if (slot.retry) clearTimeout(slot.retry)
    slot.retry = null
  }
}
