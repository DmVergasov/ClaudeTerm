import type { PeerLink } from '../sync/peer-link'
import { MAX_HAVE_ENTRIES, MAX_MAIL_RECORDS } from '../sync/remote-wire'
import { BULK_CHUNK_BYTES, type HelloMessage, type Message } from '../sync/wire'
import type { MailRecord } from '../../shared/mail'
import { isShareable, type MailOrigin, type MailStore } from './mail-store'

/** what a device says of its own mail: whether it takes mail (on), whether its watcher wakes a session (wakes), and its Claude Code version */
export interface MailAccept {
  on: boolean
  wakes: boolean
  claude: string | null
}

export interface MailSyncDeps {
  store: MailStore
  accept(): MailAccept
  onPeers?(): void
  /** the most digest entries sent in one mail-have; MAX_HAVE_ENTRIES by default */
  haveChunk?: number
}

/** the room left in a bulk chunk for the message's own fields: a mail-records batch stays within one chunk */
const RECORDS_BYTES = BULK_CHUNK_BYTES - 1024

/** the most chunks of a digest a link keeps before the digest is dropped: 10 chunks, 200 000 entries at the default size */
const MAX_HAVE_CHUNKS = 10

/** the chunks of a peer's digest received so far, until the chunk without more: dropped when they outgrow MAX_HAVE_CHUNKS */
interface HaveBuffer {
  entries: [string, number][]
  chunks: number
  dropped: boolean
}

/** a link that carries mail, with the device at its far end, the accept that device last sent, the digest being received and the listeners on the link */
interface MailLink {
  device: string
  accept: MailAccept | null
  have: HaveBuffer
  onMessage(m: Message): void
  onClose(): void
}

/**
 * The mail between devices over their links. Each side sends the other what it lacks, takes in what the other sends, and
 * passes on what it takes in to the other links. A link whose peer has no mail in its hello carries no mail at all.
 */
export class MailSync {
  private readonly links = new Map<PeerLink, MailLink>()
  private closed = false
  /** stops the store's change listener of this sync */
  private readonly unsubscribe: () => void

  constructor(private readonly deps: MailSyncDeps) {
    this.unsubscribe = deps.store.onChange((changed, origin) => this.relay(changed, origin))
  }

  /** Starts the mail on a link, when the peer's hello says it speaks the mail protocol: sends this device's accept and digest. */
  attach(link: PeerLink, hello: HelloMessage): void {
    if (this.closed || hello.mail !== 1 || this.links.has(link)) return
    const entry: MailLink = {
      device: hello.id,
      accept: null,
      have: { entries: [], chunks: 0, dropped: false },
      onMessage: (m) => this.onMessage(link, m),
      onClose: () => this.detach(link)
    }
    this.links.set(link, entry)
    link.on('message', entry.onMessage)
    link.on('close', entry.onClose)
    this.sendAccept(link)
    this.sendDigest(link)
    this.deps.onPeers?.()
  }

  /** The accept a device last sent on its link; null when it is not connected, has sent none yet, or speaks no mail protocol. */
  acceptOf(device: string): MailAccept | null {
    for (const entry of this.links.values()) {
      if (entry.device === device) return entry.accept
    }
    return null
  }

  /** Sends this device's accept to every mail link, after its settings change. */
  announce(): void {
    for (const link of this.links.keys()) this.sendAccept(link)
  }

  close(): void {
    this.closed = true
    this.unsubscribe()
    for (const [link, entry] of this.links) {
      link.off('message', entry.onMessage)
      link.off('close', entry.onClose)
    }
    this.links.clear()
  }

  private detach(link: PeerLink): void {
    const entry = this.links.get(link)
    if (!entry) return
    link.off('message', entry.onMessage)
    link.off('close', entry.onClose)
    this.links.delete(link)
    this.deps.onPeers?.()
  }

  private onMessage(link: PeerLink, m: Message): void {
    const entry = this.links.get(link)
    if (!entry || this.closed) return
    switch (m.t) {
      case 'mail-accept':
        entry.accept = { on: m.on, wakes: m.wakes, claude: m.claude }
        this.deps.onPeers?.()
        return
      case 'mail-have':
        this.onHave(link, entry, m)
        return
      case 'mail-records':
        this.deps.store.merge(m.records, { link })
        return
    }
  }

  /**
   * A digest from the peer. Its chunks with more are kept until the chunk without more comes; then the whole digest is answered
   * once, so each record the peer lacks is sent once. A digest of more than MAX_HAVE_CHUNKS buffered chunks is dropped, and
   * the chunks up to the one without more are ignored.
   */
  private onHave(link: PeerLink, entry: MailLink, m: Extract<Message, { t: 'mail-have' }>): void {
    const have = entry.have
    if (m.more) {
      if (have.dropped) return
      if (have.chunks === MAX_HAVE_CHUNKS) {
        have.entries = []
        have.dropped = true
        return
      }
      for (const e of m.have) have.entries.push(e)
      have.chunks++
      return
    }
    const digest = have.dropped ? null : [...have.entries, ...m.have]
    have.entries = []
    have.chunks = 0
    have.dropped = false
    if (digest) this.sendRecords(link, this.deps.store.missingFor(digest))
  }

  /** Sends the changed records that may leave this device to every mail link, but not back to the link they came from. */
  private relay(changed: MailRecord[], origin: MailOrigin): void {
    if (this.closed) return
    const out = changed.filter(isShareable)
    if (out.length === 0) return
    for (const link of this.links.keys()) {
      if (origin !== 'local' && origin.link === link) continue
      this.sendRecords(link, out)
    }
  }

  private sendAccept(link: PeerLink): void {
    const accept = this.deps.accept()
    link.send({ t: 'mail-accept', on: accept.on, wakes: accept.wakes, claude: accept.claude })
  }

  /**
   * Sends the digest in mail-have messages of at most haveChunk entries. Every chunk but the last carries more; an empty
   * digest is one message with no entries, so the peer answers with what it holds.
   */
  private sendDigest(link: PeerLink): void {
    const digest = this.deps.store.digest()
    if (digest.length === 0) {
      link.sendBulk({ t: 'mail-have', have: [] })
      return
    }
    const size = Math.max(1, Math.min(this.deps.haveChunk ?? MAX_HAVE_ENTRIES, MAX_HAVE_ENTRIES))
    for (let at = 0; at < digest.length; at += size) {
      const have = digest.slice(at, at + size)
      const more = at + size < digest.length
      link.sendBulk(more ? { t: 'mail-have', have, more: true } : { t: 'mail-have', have })
    }
  }

  /** Sends records in mail-records messages of at most MAX_MAIL_RECORDS records, each within one bulk chunk. */
  private sendRecords(link: PeerLink, records: MailRecord[]): void {
    let batch: MailRecord[] = []
    let bytes = 0
    for (const r of records) {
      // the size of the record's JSON and the comma that joins it to the next
      const size = Buffer.byteLength(JSON.stringify(r), 'utf8') + 1
      if (batch.length > 0 && (batch.length === MAX_MAIL_RECORDS || bytes + size > RECORDS_BYTES)) {
        link.sendBulk({ t: 'mail-records', records: batch })
        batch = []
        bytes = 0
      }
      batch.push(r)
      bytes += size
    }
    if (batch.length > 0) link.sendBulk({ t: 'mail-records', records: batch })
  }
}
