import { hasText as noteHasText, MAX_NOTE_LENGTH, type Note, type NoteForm } from '../shared/note'
import { el } from './dom'
import { mapKey } from './keymap'

/** the sticky note: the Note button, the label, the card and the mark on a tab */
export function noteIcon(size: number): string {
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M2.65 2.65h10.7v7.2l-3.5 3.5h-7.2z"/><path d="M9.85 13.35v-3.5h3.5"/><path d="M5 6h6M5 8.5h3.5"/></svg>`
}

export interface NoteOverlayCallbacks {
  /** `generation`: the number of the note it was typed against, as main gave it */
  setText(tabId: string, text: string, generation: number): void
  setView(tabId: string, shown: boolean, form: NoteForm, generation: number): void
  focusTerminal(): void
  /** a note got or lost its text, or was shown or hidden */
  changed(): void
}

/** what the label says: the note's first line that is not blank */
const firstLine = (text: string): string => text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? ''

const icon = (size: number): HTMLElement => el('span', { className: 'note-icon', innerHTML: noteIcon(size) })

/**
 * The note of the Claude tab in front, over the top right of the terminal: a label with its first line, or a card with
 * the whole text to edit. It lies over the terminal, which keeps its size. Every change of a note goes to main.
 */
export class NoteOverlay {
  private readonly notes = new Map<string, Note>()
  /** the number of the note main gave each tab last; 0 until it gives one */
  private readonly generations = new Map<string, number>()
  /** the Claude tab in front; null for a shell tab or none */
  private active: string | null = null
  private readonly label: HTMLElement
  private readonly labelText: HTMLElement
  private readonly card: HTMLElement
  private readonly text: HTMLTextAreaElement

  constructor(private readonly root: HTMLElement, private readonly cb: NoteOverlayCallbacks, private readonly platform: string) {
    this.labelText = el('span', { className: 'note-label-text' })
    this.label = el('div', { className: 'note-label', title: 'Show the note' }, icon(14), this.labelText)
    this.label.addEventListener('click', () => {
      this.present('card')
      this.focusText()
    })
    const collapse = el('button', { className: 'note-collapse', textContent: '–', title: 'Collapse to a label' })
    // an empty note has no label to collapse to
    collapse.addEventListener('click', () => this.present(this.active !== null && this.hasText(this.active) ? 'label' : null))
    const hide = el('button', { className: 'note-hide', textContent: '×', title: 'Hide the note' })
    hide.addEventListener('click', () => this.present(null))
    this.text = el('textarea', { className: 'note-text', placeholder: 'Write a note for this session…', maxLength: MAX_NOTE_LENGTH, spellcheck: false })
    this.text.addEventListener('input', () => this.typed())
    this.text.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // the card stays; the keyboard goes back to the terminal
        e.preventDefault()
        this.cb.focusTerminal()
      } else if (mapKey(e, this.platform)?.type === 'toggleNote') {
        e.preventDefault()
        this.toggle()
      }
    })
    const head = el('div', { className: 'note-head' }, icon(14), el('span', { className: 'note-title', textContent: 'Note' }), collapse, hide)
    this.card = el('div', { className: 'note-card' }, head, this.text)
    root.replaceChildren(this.label, this.card)
    this.draw()
  }

  /**
   * the note that came from main with the tab's conversation (null: none) and its number, drawn at once; the caller redraws
   * the tabs
   */
  set(tabId: string, note: Note | null, generation: number): void {
    if (note) this.notes.set(tabId, { ...note })
    else this.notes.delete(tabId)
    this.generations.set(tabId, generation)
    if (tabId === this.active) this.redraw()
  }

  /** the tab in front changed; only a Claude tab has a note. A shown note without text goes once its tab is left */
  show(tabId: string | null, claude: boolean): void {
    const left = this.active !== tabId ? this.active : null
    const note = left === null ? undefined : this.notes.get(left)
    const emptied = left !== null && note !== undefined && note.shown && !noteHasText(note)
    if (emptied) {
      note.shown = false
      this.cb.setView(left, false, note.form, this.generationOf(left))
    }
    this.active = claude ? tabId : null
    this.redraw()
    if (emptied) this.cb.changed()
  }

  /** the Note button and the shortcut: a hidden note comes back in its last form, an empty one as the card to write in */
  toggle(): void {
    if (this.active === null) return
    const note = this.noteOf(this.active)
    if (note.shown) this.present(null)
    else if (noteHasText(note)) this.present(note.form)
    else {
      this.present('card')
      this.focusText()
    }
  }

  hasText(tabId: string): boolean {
    return noteHasText(this.notes.get(tabId))
  }

  /** whether the note of the tab in front is shown */
  isShown(): boolean {
    return this.active !== null && this.notes.get(this.active)?.shown === true
  }

  dropTab(tabId: string): void {
    this.notes.delete(tabId)
    this.generations.delete(tabId)
    if (this.active !== tabId) return
    this.active = null
    this.draw()
  }

  private noteOf(tabId: string): Note {
    let note = this.notes.get(tabId)
    if (!note) {
      note = { text: '', shown: false, form: 'card' }
      this.notes.set(tabId, note)
    }
    return note
  }

  private generationOf(tabId: string): number {
    return this.generations.get(tabId) ?? 0
  }

  /** shows the note of the tab in front as `form`, or hides it (null), and tells main; the keyboard leaves with the card */
  private present(form: NoteForm | null): void {
    if (this.active === null) return
    const note = this.noteOf(this.active)
    const wasShown = note.shown
    note.shown = form !== null
    if (form !== null) note.form = form
    this.cb.setView(this.active, note.shown, note.form, this.generationOf(this.active))
    this.redraw()
    if (note.shown !== wasShown) this.cb.changed()
  }

  private typed(): void {
    if (this.active === null) return
    const note = this.noteOf(this.active)
    const had = noteHasText(note)
    note.text = this.text.value
    this.cb.setText(this.active, note.text, this.generationOf(this.active))
    if (noteHasText(note) !== had) this.cb.changed()
  }

  /** the keyboard in the card's text, at its end */
  private focusText(): void {
    this.text.focus()
    const end = this.text.value.length
    this.text.setSelectionRange(end, end)
  }

  /** draws the note; when the card that had the keyboard goes, the keyboard goes back to the terminal */
  private redraw(): void {
    const keyboard = this.root.contains(document.activeElement)
    this.draw()
    if (keyboard && this.card.hidden) this.cb.focusTerminal()
  }

  private draw(): void {
    const note = this.active === null ? undefined : this.notes.get(this.active)
    const form = note?.shown ? note.form : null
    this.label.hidden = form !== 'label' || !noteHasText(note)
    this.card.hidden = form !== 'card'
    this.labelText.textContent = firstLine(note?.text ?? '')
    // the typed text is the note's already; another tab's note, or one that came with another conversation (main never
    // echoes what was typed), replaces it even under the user's typing. An unchanged text keeps the caret where it is
    const text = note?.text ?? ''
    if (this.text.value !== text) this.text.value = text
  }
}
