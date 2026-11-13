import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { isNoteSize, isProjectKey, MAX_NOTE_LENGTH, type ProjectNote } from '../shared/note'

/** Reads the project notes file: valid entries by project key; null when the text is not a JSON object. */
export function parseProjectNotes(text: string): Map<string, ProjectNote> | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const notes = new Map<string, ProjectNote>()
  for (const [key, value] of Object.entries(raw)) {
    const note = projectNoteEntry(key, value)
    if (note) notes.set(key, note)
  }
  return notes
}

/** One entry of the project notes file as a note; a size that is not valid is left out. null when the entry has no text. */
function projectNoteEntry(key: string, value: unknown): ProjectNote | null {
  if (!isProjectKey(key) || typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (typeof v.text !== 'string' || v.text.length > MAX_NOTE_LENGTH || v.text.trim().length === 0) return null
  const note: ProjectNote = { text: v.text }
  const size = v.size
  if (isNoteSize(size)) note.size = { width: size.width, height: size.height }
  return note
}

export interface ProjectNotesOptions {
  debounceMs?: number
  onError?(message: string): void
  /** what the user is told: the file could not be read */
  warn?(message: string): void
}

/** The person's notes by project key (TabPlace.project.key): ClaudeTerm's own file, never anything in Claude Code's folders. */
export class ProjectNotes {
  readonly path: string
  private readonly notes = new Map<string, ProjectNote>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  /** false when a file that could not be read could not be moved aside either: it is never written over */
  private writable = true

  constructor(dir: string, private readonly opts: ProjectNotesOptions = {}) {
    this.path = join(dir, 'project-notes.json')
    this.load()
  }

  get(key: string): ProjectNote | null {
    const n = this.notes.get(key)
    return n ? { ...n } : null
  }

  /** Stores the note; null or a note without text removes it. Saved after the debounce. */
  set(key: string, note: ProjectNote | null): void {
    if (note && note.text.trim().length > 0) this.notes.set(key, { ...note })
    else this.notes.delete(key)
    this.scheduleSave()
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty || !this.writable) return
    this.save()
  }

  private save(): void {
    const tmp = `${this.path}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.notes), null, 2), 'utf8')
      renameSync(tmp, this.path)
      this.dirty = false
    } catch (e) {
      this.opts.onError?.(`cannot save ${this.path}: ${(e as Error).message}`)
    }
  }

  private scheduleSave(): void {
    this.dirty = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.opts.debounceMs ?? 500)
  }

  private load(): void {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      this.opts.onError?.(`cannot read ${this.path}: ${(e as Error).message}`)
      this.moveAside()
      return
    }
    const notes = parseProjectNotes(text)
    if (!notes) {
      this.moveAside()
      return
    }
    for (const [key, n] of notes) this.notes.set(key, n)
  }

  /** a file that is not notes is kept beside the new one, never written over; the notes start empty */
  private moveAside(): void {
    const aside = `${this.path}.corrupt-${Date.now()}`
    try {
      renameSync(this.path, aside)
      this.opts.warn?.(`Project notes could not be read; the file was kept as ${basename(aside)}`)
    } catch (e) {
      this.writable = false
      this.opts.onError?.(`cannot move ${this.path} aside: ${(e as Error).message}`)
      this.opts.warn?.(`Project notes could not be read and are not being saved this run: ${this.path}`)
    }
  }
}
