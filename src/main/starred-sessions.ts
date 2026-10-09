import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isUuid } from '../shared/protocol'

/** The sessions the user starred: ClaudeTerm's own file of session ids, never anything in Claude Code's folders. */
export class StarredSessions {
  readonly path: string
  private readonly starred = new Set<string>()

  constructor(dir: string, private readonly onError?: (message: string) => void) {
    this.path = join(dir, 'starred-sessions.json')
    this.load()
  }

  ids(): ReadonlySet<string> {
    return this.starred
  }

  set(id: string, starred: boolean): void {
    if (starred === this.starred.has(id)) return
    if (starred) this.starred.add(id)
    else this.starred.delete(id)
    this.save()
  }

  private load(): void {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.onError?.(`cannot read ${this.path}: ${(e as Error).message}`)
      return
    }
    try {
      const raw: unknown = JSON.parse(text)
      if (!Array.isArray(raw)) throw new Error('not a list')
      for (const id of raw) if (isUuid(id)) this.starred.add(id)
    } catch {
      this.onError?.(`ignoring corrupt ${this.path}`)
    }
  }

  private save(): void {
    const tmp = `${this.path}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify([...this.starred], null, 2), 'utf8')
      renameSync(tmp, this.path)
    } catch (e) {
      this.onError?.(`cannot save ${this.path}: ${(e as Error).message}`)
    }
  }
}
