import type { NoteProject, NoteSize, ProjectNote } from '../shared/note'
import { type NoteOp, type OpResult, replayNoteOps, tryNoteOp } from '../shared/note-items'
import { type KeptOp, OPS_KEPT, opsSince } from './note-hub'
import type { ProjectNotes } from './project-notes'

export interface ProjectNoteHubDeps {
  store: Pick<ProjectNotes, 'get' | 'set'>
  /** a project's note, with number 1, when the first tab of the project is placed in this run */
  publish(key: string, note: ProjectNote | null, generation: number): void
  /** one of Claude's edits of a project's note, with the number it makes */
  publishOp(key: string, op: NoteOp, generation: number): void
}

interface ProjectEntry {
  note: ProjectNote | null
  generation: number
  /** Claude's edits of the note, oldest first */
  ops: KeptOp[]
}

type Project = { key: string; name: string }

/** Each project's note, shared by every Claude tab of the project (its worktrees included). */
export class ProjectNoteHub {
  /** the project of each placed tab, null outside git; a tab not here is not placed yet */
  private readonly places = new Map<string, Project | null>()
  /** the projects brought in this run, kept for the run */
  private readonly entries = new Map<string, ProjectEntry>()

  constructor(private readonly deps: ProjectNoteHubDeps) {}

  /** the tab's place is known: its project, or null outside git */
  place(tabId: string, project: Project | null): void {
    this.places.set(tabId, project)
    if (project) this.bring(project.key)
  }

  removeTab(tabId: string): void {
    this.places.delete(tabId)
  }

  projectOf(tabId: string): NoteProject {
    const project = this.places.get(tabId)
    if (project === undefined) return { key: null, why: 'unknown' }
    return project ?? { key: null, why: 'outside' }
  }

  /** null: a key no tab has brought this run */
  get(key: string): ProjectNote | null {
    const note = this.entries.get(key)?.note
    return note ? { ...note } : null
  }

  /** `generation`: the number of the note the text was typed against, as NoteHub.setText */
  setText(tabId: string, key: string, text: string, generation: number): void {
    const entry = this.entryOf(tabId, key)
    if (!entry) return
    if (generation === entry.generation) {
      this.change(key, entry, (n) => ({ ...n, text }))
      return
    }
    const ops = opsSince(entry.ops, entry.generation, generation)
    if (ops) this.change(key, entry, (n) => ({ ...n, text: replayNoteOps(text, ops) }))
  }

  /** null removes the size, so the default size is drawn */
  setSize(tabId: string, key: string, size: NoteSize | null): void {
    const entry = this.entryOf(tabId, key)
    if (!entry) return
    this.change(key, entry, (n) => {
      const next: ProjectNote = { text: n.text }
      if (size) next.size = { width: size.width, height: size.height }
      return next
    })
  }

  /** one of Claude's edits of the tab's project note; null: the tab has no project */
  apply(tabId: string, op: NoteOp): OpResult | null {
    const project = this.places.get(tabId)
    const entry = project ? this.entries.get(project.key) : undefined
    if (!project || !entry) return null
    const result = tryNoteOp(entry.note?.text ?? '', op)
    if (!result.ok || !result.changed) return result
    const text = result.text
    this.change(project.key, entry, (n) => ({ ...n, text }))
    entry.generation++
    entry.ops.push({ generation: entry.generation, op })
    if (entry.ops.length > OPS_KEPT) entry.ops.shift()
    this.deps.publishOp(project.key, op, entry.generation)
    return result
  }

  /** the project's entry, when the tab is placed in that project */
  private entryOf(tabId: string, key: string): ProjectEntry | null {
    if (this.places.get(tabId)?.key !== key) return null
    return this.entries.get(key) ?? null
  }

  private bring(key: string): void {
    if (this.entries.has(key)) return
    const stored = this.deps.store.get(key)
    this.entries.set(key, { note: stored && { ...stored }, generation: 1, ops: [] })
    this.deps.publish(key, stored, 1)
  }

  /** every change is stored under its key; the store drops a note without text */
  private change(key: string, entry: ProjectEntry, edit: (note: ProjectNote) => ProjectNote): void {
    entry.note = edit(entry.note ?? { text: '' })
    this.deps.store.set(key, { ...entry.note })
  }
}
