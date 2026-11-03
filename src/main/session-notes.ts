import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hasText, MAX_NOTE_LENGTH, NOTE_FORMS, type Note } from '../shared/note'
import { isUuid } from '../shared/protocol'

/** Reads the notes file: valid entries by session id; null when the text is not a JSON object. */
export function parseNotes(text: string): Map<string, Note> | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const notes = new Map<string, Note>()
  for (const [id, value] of Object.entries(raw)) {
    if (!isUuid(id) || typeof value !== 'object' || value === null) continue
    const v = value as Record<string, unknown>
    if (typeof v.text !== 'string' || v.text.length > MAX_NOTE_LENGTH) continue
    if (typeof v.shown !== 'boolean') continue
    if (!NOTE_FORMS.some((f) => f === v.form)) continue
    const note: Note = { text: v.text, shown: v.shown, form: v.form as Note['form'] }
    if (hasText(note)) notes.set(id, note)
  }
  return notes
}

export interface SessionNotesOptions {
  debounceMs?: number
  onError?(message: string): void
}

/** The user's notes by Claude session id: ClaudeTerm's own file, never anything in Claude Code's folders. */
export class SessionNotes {
  readonly path: string
  private readonly notes = new Map<string, Note>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false

  constructor(dir: string, private readonly opts: SessionNotesOptions = {}) {
    this.path = join(dir, 'session-notes.json')
    this.load()
  }

  get(sessionId: string): Note | null {
    const n = this.notes.get(sessionId)
    return n ? { ...n } : null
  }

  /** Stores the note; null or a note without text removes it. */
  set(sessionId: string, note: Note | null): void {
    if (note && hasText(note)) this.notes.set(sessionId, { ...note })
    else this.notes.delete(sessionId)
    this.dirty = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.opts.debounceMs ?? 500)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return
    this.dirty = false
    const tmp = `${this.path}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.notes), null, 2), 'utf8')
      renameSync(tmp, this.path)
    } catch (e) {
      this.opts.onError?.(`cannot save ${this.path}: ${(e as Error).message}`)
    }
  }

  private load(): void {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.opts.onError?.(`cannot read ${this.path}: ${(e as Error).message}`)
      return
    }
    const parsed = parseNotes(text)
    if (!parsed) {
      this.opts.onError?.(`ignoring corrupt ${this.path}`)
      return
    }
    for (const [id, n] of parsed) this.notes.set(id, n)
  }
}
