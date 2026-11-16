import { readFile, rename, writeFile } from 'node:fs/promises'
import { isBridgeId } from '../../shared/remote-control'

/** the claude.ai session a conversation continues: its id and the sequence number of its last event */
export interface RemoteSessionEntry {
  remoteId: string
  sequenceNum: number
}

/** an entry not used for this long is forgotten */
export const REMOTE_SESSION_KEEP_MS = 30 * 24 * 3_600_000

interface StoredSession extends RemoteSessionEntry {
  /** the pathKey of the config folder the session was made under */
  account: string
  usedAt: number
}

function parseSession(value: unknown): StoredSession | null {
  if (typeof value !== 'object' || value === null) return null
  const s = value as Record<string, unknown>
  if (!isBridgeId(s.remoteId) || typeof s.sequenceNum !== 'number' || !Number.isSafeInteger(s.sequenceNum) || s.sequenceNum < 0) return null
  if (typeof s.account !== 'string' || typeof s.usedAt !== 'number' || !Number.isFinite(s.usedAt)) return null
  return { remoteId: s.remoteId, sequenceNum: s.sequenceNum, account: s.account, usedAt: s.usedAt }
}

/**
 * The claude.ai sessions of the conversations, in remote-sessions.json in the app's data folder. Only the ids are kept:
 * no token. Saves run one after another; a failed read or save is logged, and the store goes on.
 */
export class RemoteSessionStore {
  private sessions: Promise<Map<string, StoredSession>> | null = null
  private saved: Promise<void> = Promise.resolve()

  constructor(private readonly file: string, private readonly now: () => number, private readonly log: { warn(m: string): void }) {}

  /** the conversation's claude.ai session, when it was made under this account (the pathKey of its config folder) */
  async get(sessionId: string, account: string): Promise<RemoteSessionEntry | null> {
    const sessions = await this.load()
    this.prune(sessions)
    const s = sessions.get(sessionId)
    if (!s || s.account !== account) return null
    s.usedAt = this.now()
    await this.save()
    return { remoteId: s.remoteId, sequenceNum: s.sequenceNum }
  }

  async put(sessionId: string, account: string, entry: RemoteSessionEntry): Promise<void> {
    const sessions = await this.load()
    sessions.set(sessionId, { remoteId: entry.remoteId, sequenceNum: entry.sequenceNum, account, usedAt: this.now() })
    await this.save()
  }

  async forget(sessionId: string): Promise<void> {
    const sessions = await this.load()
    if (sessions.delete(sessionId)) await this.save()
  }

  private load(): Promise<Map<string, StoredSession>> {
    this.sessions ??= this.read()
    return this.sessions
  }

  private async read(): Promise<Map<string, StoredSession>> {
    const sessions = new Map<string, StoredSession>()
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (e) {
      // no file yet: no session kept
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`cannot read the remote sessions: ${(e as Error).message}`)
      return sessions
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      this.log.warn('the remote sessions file is not JSON: its sessions are left out')
      return sessions
    }
    const body = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    const list = body.version === 1 && typeof body.sessions === 'object' && body.sessions !== null ? (body.sessions as Record<string, unknown>) : {}
    for (const [id, value] of Object.entries(list)) {
      const s = parseSession(value)
      if (s) sessions.set(id, s)
    }
    return sessions
  }

  /** forgets the entries not used for REMOTE_SESSION_KEEP_MS */
  private prune(sessions: Map<string, StoredSession>): void {
    const cutoff = this.now() - REMOTE_SESSION_KEEP_MS
    for (const [id, s] of sessions) if (s.usedAt < cutoff) sessions.delete(id)
  }

  private save(): Promise<void> {
    this.saved = this.saved.then(() => this.write())
    return this.saved
  }

  private async write(): Promise<void> {
    try {
      const sessions = await this.load()
      this.prune(sessions)
      const tmp = `${this.file}.tmp`
      await writeFile(tmp, JSON.stringify({ version: 1, sessions: Object.fromEntries(sessions) }, null, 2))
      await rename(tmp, this.file)
    } catch (e) {
      this.log.warn(`cannot save the remote sessions: ${(e as Error).message}`)
    }
  }
}
