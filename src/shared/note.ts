import type { TabPlace } from './types'

/** How a session's note is drawn: a one-line label, or a card with the whole text. */
export type NoteForm = 'label' | 'card'

/** Which card a note is: the Claude session's note, or the project's. */
export type NoteSide = 'session' | 'project'

export interface NoteSize {
  width: number
  height: number
}

/** The user's note on a Claude session; `form` is kept while the note is hidden. */
export interface Note {
  text: string
  shown: boolean
  form: NoteForm
  side?: NoteSide
  size?: NoteSize
}

/** A project's note, shared by the Claude tabs of that project. */
export interface ProjectNote {
  text: string
  size?: NoteSize
}

/** a tab's project note: its project, or why it has none */
export type NoteProject = { key: string; name: string } | { key: null; why: 'remote' | 'outside' | 'unknown' }

export const NOTE_FORMS: readonly NoteForm[] = ['label', 'card']

export const NOTE_SIDES: readonly NoteSide[] = ['session', 'project']

export const NOTE_SIZE: NoteSize = { width: 340, height: 240 }
export const MIN_NOTE_SIZE: NoteSize = { width: 260, height: 140 }
/** the largest stored; the card is drawn within its area */
export const MAX_NOTE_SIZE: NoteSize = { width: 4000, height: 4000 }

export const MAX_NOTE_LENGTH = 100_000
export const MAX_PROJECT_KEY = 4096
export const NOTE_ADD_MAX = 10_000
export const NOTE_ITEM_MAX = 2_000

export const hasText = (note: Note | null | undefined): boolean => !!note && note.text.trim().length > 0

export function isNoteSize(v: unknown): v is NoteSize {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const { width, height } = v as Record<string, unknown>
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    (width as number) >= MIN_NOTE_SIZE.width &&
    (width as number) <= MAX_NOTE_SIZE.width &&
    (height as number) >= MIN_NOTE_SIZE.height &&
    (height as number) <= MAX_NOTE_SIZE.height
  )
}

export function isProjectKey(v: unknown): v is string {
  return typeof v === 'string' && v.length >= 1 && v.length <= MAX_PROJECT_KEY && !v.includes('\0')
}

/** the project a tab's note belongs to; `place` is undefined while the tab's place is not known yet, null outside git */
export function noteProjectOf(remote: boolean, place: TabPlace | null | undefined): NoteProject {
  if (remote) return { key: null, why: 'remote' }
  if (place === undefined) return { key: null, why: 'unknown' }
  if (place === null) return { key: null, why: 'outside' }
  return { key: place.project.key, name: place.project.name }
}
