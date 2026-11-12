import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isUuid } from '../../shared/protocol'

// The sessions of the chats ClaudeTerm started: Recent sessions lists them, Claude Code marks them as SDK sessions

/** the most ids kept: the newest */
const MAX_IDS = 2000

/** ClaudeTerm's own file of the session ids its chats started, newest last; never anything in Claude Code's folders */
export class ChatSessions {
  private readonly ids = new Set<string>()

  constructor(private readonly file: string) {
    this.load()
  }

  has(sessionId: string): boolean {
    return this.ids.has(sessionId)
  }

  /** a new id, or an older one moved to the newest place; the newest again is no change, so nothing is written */
  add(sessionId: string): void {
    if (!isUuid(sessionId) || sessionId === this.newest()) return
    this.ids.delete(sessionId)
    this.ids.add(sessionId)
    while (this.ids.size > MAX_IDS) {
      const oldest = this.ids.values().next().value
      if (oldest === undefined) break
      this.ids.delete(oldest)
    }
    this.save()
  }

  private newest(): string | undefined {
    let last: string | undefined
    for (const id of this.ids) last = id
    return last
  }

  private load(): void {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      // a missing or corrupt file starts an empty list
      return
    }
    if (!Array.isArray(raw)) return
    for (const id of raw.filter(isUuid).slice(-MAX_IDS)) this.ids.add(id)
  }

  /** written to a temporary file and renamed over the list, so a crash never leaves half a file */
  private save(): void {
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify([...this.ids]), 'utf8')
      renameSync(tmp, this.file)
    } catch {
      // a failed save keeps the list in memory; the next add saves it again
    }
  }
}
