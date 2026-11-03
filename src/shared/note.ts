/** How a session's note is drawn: a one-line label, or a card with the whole text. */
export type NoteForm = 'label' | 'card'

/** The user's note on a Claude session; `form` is kept while the note is hidden. */
export interface Note {
  text: string
  shown: boolean
  form: NoteForm
}

export const NOTE_FORMS: readonly NoteForm[] = ['label', 'card']

export const MAX_NOTE_LENGTH = 100_000

export const hasText = (note: Note | null | undefined): boolean => !!note && note.text.trim().length > 0
