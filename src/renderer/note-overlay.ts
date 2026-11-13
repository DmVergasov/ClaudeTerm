import { hasText as noteHasText, type Note, type NoteForm, type NoteProject, type NoteSide, type ProjectNote } from '../shared/note'
import { applyNoteOp, itemCount, type NoteOp, noteLabel } from '../shared/note-items'
import { el } from './dom'
import { icon as iconSvg } from './icons'
import { mapKey } from './keymap'
import { NoteEditor } from './note-editor'

/** the sticky note: the Note button, the label, the card and the mark on a tab */
export function noteIcon(size: number): string {
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M2.65 2.65h10.7v7.2l-3.5 3.5h-7.2z"/><path d="M9.85 13.35v-3.5h3.5"/><path d="M5 6h6M5 8.5h3.5"/></svg>`
}

export interface NoteOverlayCallbacks {
  /** `generation`: the number of the note it was typed against, as main gave it */
  setText(tabId: string, text: string, generation: number): void
  setView(tabId: string, shown: boolean, form: NoteForm, generation: number): void
  /** which note the card shows in front */
  setSide(tabId: string, side: NoteSide, generation: number): void
  /** the text of the tab's project note; `key` is the project's, `generation` as for setText */
  setProjectText(tabId: string, key: string, text: string, generation: number): void
  /** the tab's project, or why it has none */
  projectOf(tabId: string): NoteProject
  focusTerminal(): void
  /** the text the person copied from the note's editor */
  copyText(text: string): void
  /** a note got or lost its text, or was shown or hidden */
  changed(): void
}

/** a project's note as the window keeps it: its text, its size and the number main gave it */
type ProjectEntry = ProjectNote & { generation: number }

const PLACEHOLDER = 'Write a note for this session…'
const PROJECT_PLACEHOLDER = 'Write a note for this project…'
const SESSION_TITLE = 'Session note: kept with this conversation'
const NO_PROJECT: Record<'remote' | 'outside' | 'unknown', string> = {
  remote: 'No project note: this tab runs on another device',
  outside: 'No project note: this folder is not in a git repository',
  unknown: "No project note yet: looking for this tab's project"
}
const UNKNOWN_PROJECT: NoteProject = { key: null, why: 'unknown' }

const icon = (size: number): HTMLElement => el('span', { className: 'note-icon', innerHTML: noteIcon(size) })

const filled = (text: string): boolean => text.trim() !== ''

/** the key of a note in the editor: its tab and its side */
const noteKey = (tabId: string, side: NoteSide): string => `${side}:${tabId}`

/**
 * The note of the Claude tab in front, over the top right of the terminal: a label with its first line, or a card with
 * the whole text to edit. It lies over the terminal, which keeps its size. Every change of a note goes to main.
 * A tab has two notes: its session's, and its project's, which the Claude tabs of the project share.
 */
export class NoteOverlay {
  private readonly notes = new Map<string, Note>()
  /** the number of the note main gave each tab last; 0 until it gives one */
  private readonly generations = new Map<string, number>()
  /** the project notes of the run, by project key */
  private readonly projects = new Map<string, ProjectEntry>()
  /** the Claude tab in front; null for a shell tab or none */
  private active: string | null = null
  private readonly label: HTMLElement
  private readonly labelCount: HTMLElement
  private readonly labelText: HTMLElement
  /** the note the editor holds (noteKey); null for none */
  private loaded: string | null = null
  private readonly card: HTMLElement
  private readonly editor: NoteEditor
  private readonly sides: Record<NoteSide, { button: HTMLElement; count: HTMLElement }>

  constructor(private readonly root: HTMLElement, private readonly cb: NoteOverlayCallbacks, private readonly platform: string) {
    this.labelCount = el('span', { className: 'note-label-count' })
    this.labelText = el('span', { className: 'note-label-text' })
    this.label = el('div', { className: 'note-label', title: 'Show the note' }, icon(14), this.labelCount, this.labelText)
    this.label.addEventListener('click', () => {
      this.present('card')
      this.focusText()
    })
    const collapse = el('button', { className: 'note-collapse', textContent: '–', title: 'Collapse to a label' })
    // a note without text has no label to collapse to
    collapse.addEventListener('click', () => this.present(this.active !== null && this.frontHasText(this.active) ? 'label' : null))
    const hide = el('button', { className: 'note-hide', innerHTML: iconSvg('x', 12), title: 'Hide the note' })
    hide.addEventListener('click', () => this.present(null))
    this.editor = new NoteEditor({
      changed: (text) => this.typed(text),
      key: (e) => this.key(e),
      copy: (text) => this.cb.copyText(text)
    })
    // the placeholder is the editor's from the start: an empty text is not loaded again
    this.editor.load('', PLACEHOLDER)
    const body = el('div', { className: 'note-body' }, this.editor.dom)
    const foot = el('div', { className: 'note-foot' }, this.tool('checkbox', 'Checkbox', 'Turn the line into a checkbox item, or back (or type [ ] at its start)', () => this.editor.toggleCheckbox()), this.tool('list', 'List', 'Turn the line into a bullet item, or back', () => this.editor.toggleBullet()))
    this.sides = { session: this.sideButton('session', 'Session'), project: this.sideButton('project', 'Project') }
    const switcher = el('div', { className: 'note-switch' }, this.sides.session.button, this.sides.project.button)
    const head = el('div', { className: 'note-head' }, icon(14), switcher, collapse, hide)
    this.card = el('div', { className: 'note-card' }, head, body, foot)
    root.replaceChildren(this.label, this.card)
    this.draw()
  }

  /** the text of the editor: the note of the tab in front, kept while the card is hidden */
  editorText(): string {
    return this.editor.text
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

  /**
   * a project's note from main, with its number; ignored when the window has that project at that number or later
   * (a note comes once per run, before the first tab of the project is placed)
   */
  setProjectNote(key: string, note: ProjectNote | null, generation: number): void {
    if ((this.projects.get(key)?.generation ?? -1) >= generation) return
    this.projects.set(key, { ...note, text: note?.text ?? '', generation })
    this.redraw()
  }

  /** one of Claude's edits to a tab's session note: the text and the number, then the editor if it holds that note */
  applyOp(tabId: string, op: NoteOp, generation: number): void {
    const note = this.noteOf(tabId)
    const had = noteHasText(note)
    note.text = applyNoteOp(note.text, op)
    this.generations.set(tabId, generation)
    if (this.loaded === noteKey(tabId, 'session')) this.editor.update(note.text)
    if (noteHasText(note) !== had) this.cb.changed()
    this.redraw()
  }

  /** one of Claude's edits to a project's note; a project note the window has not got yet counts as empty at number 0 */
  applyProjectOp(key: string, op: NoteOp, generation: number): void {
    const entry = this.projectEntry(key)
    entry.text = applyNoteOp(entry.text, op)
    entry.generation = generation
    const active = this.active
    if (active !== null && this.loaded === noteKey(active, 'project') && this.projectOf(active).key === key) this.editor.update(entry.text)
    this.redraw()
  }

  /** the tab's project may have changed: the card is drawn again when the tab is in front */
  placeChanged(tabId: string): void {
    if (tabId === this.active) this.redraw()
  }

  /** the tab in front changed; only a Claude tab has a note. A shown note without text goes once its tab is left */
  show(tabId: string | null, claude: boolean): void {
    const left = this.active !== tabId ? this.active : null
    const note = left === null ? undefined : this.notes.get(left)
    const emptied = left !== null && note !== undefined && note.shown && !filled(this.frontText(left))
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
    else if (this.frontHasText(this.active)) this.present(note.form)
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

  private projectEntry(key: string): ProjectEntry {
    let entry = this.projects.get(key)
    if (!entry) {
      entry = { text: '', generation: 0 }
      this.projects.set(key, entry)
    }
    return entry
  }

  private generationOf(tabId: string): number {
    return this.generations.get(tabId) ?? 0
  }

  private projectOf(tabId: string): NoteProject {
    return this.cb.projectOf(tabId)
  }

  /** the side in front: the project's when the card has it selected and the tab has a project, else the session's */
  private sideOf(tabId: string): NoteSide {
    return this.notes.get(tabId)?.side === 'project' && this.projectOf(tabId).key !== null ? 'project' : 'session'
  }

  /** the text of a tab's note on a side; a project note the window has not got is empty */
  private textOf(tabId: string, side: NoteSide): string {
    if (side === 'session') return this.notes.get(tabId)?.text ?? ''
    const key = this.projectOf(tabId).key
    return (key === null ? undefined : this.projects.get(key)?.text) ?? ''
  }

  private frontText(tabId: string): string {
    return this.textOf(tabId, this.sideOf(tabId))
  }

  private frontHasText(tabId: string): boolean {
    return filled(this.frontText(tabId))
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

  /** the side the person clicked: main is told, and the editor shows that note; the Project side of a tab without a project does nothing */
  private choose(side: NoteSide): void {
    const tabId = this.active
    if (tabId === null || side === this.sideOf(tabId) || (side === 'project' && this.projectOf(tabId).key === null)) return
    // the editor loads the other note with the caret at its start: a keyboard in the card goes to the end of it
    const keyboard = this.card.contains(document.activeElement)
    this.noteOf(tabId).side = side
    this.cb.setSide(tabId, side, this.generationOf(tabId))
    this.redraw()
    if (keyboard) this.focusText()
  }

  /** the keys of the editor that the card handles first: Escape leaves it, the note shortcut hides or shows the card */
  private key(e: KeyboardEvent): boolean {
    if (e.key === 'Escape') {
      // the card stays; the keyboard goes back to the terminal
      e.preventDefault()
      this.cb.focusTerminal()
      return true
    }
    if (mapKey(e, this.platform)?.type === 'toggleNote') {
      e.preventDefault()
      this.toggle()
      return true
    }
    return false
  }

  /** a tool button of the card's foot: the editor keeps the caret when it is pressed */
  private tool(name: string, label: string, title: string, run: () => void): HTMLElement {
    const button = el('button', { className: 'note-tool', textContent: label, title })
    button.dataset.tool = name
    button.addEventListener('mousedown', (e) => e.preventDefault())
    button.addEventListener('click', run)
    return button
  }

  /** a side of the card's switch: the editor keeps the keyboard when it is pressed */
  private sideButton(side: NoteSide, label: string): { button: HTMLElement; count: HTMLElement } {
    const count = el('span', { className: 'note-side-count' })
    const button = el('button', { className: 'note-side', textContent: label }, count)
    button.dataset.side = side
    button.addEventListener('mousedown', (e) => e.preventDefault())
    button.addEventListener('click', () => this.choose(side))
    return { button, count }
  }

  /** the person's text: the note in front takes it; the editor's text is the note's already */
  private typed(text: string): void {
    const tabId = this.active
    if (tabId === null) return
    const side = this.sideOf(tabId)
    const key = this.projectOf(tabId).key
    if (side === 'project' && key !== null) {
      const entry = this.projectEntry(key)
      entry.text = text
      this.cb.setProjectText(tabId, key, text, entry.generation)
    } else {
      const note = this.noteOf(tabId)
      const had = noteHasText(note)
      note.text = text
      this.cb.setText(tabId, note.text, this.generationOf(tabId))
      if (noteHasText(note) !== had) this.cb.changed()
    }
    this.draw()
  }

  /** the keyboard in the card's text, at its end */
  private focusText(): void {
    this.editor.focus()
  }

  /** draws the note; when the card that had the keyboard goes, the keyboard goes back to the terminal */
  private redraw(): void {
    const keyboard = this.root.contains(document.activeElement)
    this.draw()
    if (keyboard && this.card.hidden) this.cb.focusTerminal()
  }

  private draw(): void {
    const tabId = this.active
    const side: NoteSide = tabId === null ? 'session' : this.sideOf(tabId)
    const text = tabId === null ? '' : this.textOf(tabId, side)
    const note = tabId === null ? undefined : this.notes.get(tabId)
    const form = note?.shown ? note.form : null
    this.label.hidden = form !== 'label' || !filled(text)
    this.card.hidden = form !== 'card'
    const label = noteLabel(text)
    this.labelCount.hidden = label.count === null
    this.labelCount.textContent = label.count ?? ''
    this.labelText.textContent = label.text
    this.drawSides(tabId, side)
    // the editor holds one note. Another tab's, side's or text's note is loaded (new text, new history); Claude's edits come
    // through applyOp and applyProjectOp, which update the editor first, so the text is equal here and nothing reloads
    const key = tabId === null ? null : noteKey(tabId, side)
    if (key !== this.loaded || this.editor.text !== text) {
      this.editor.load(text, side === 'project' ? PROJECT_PLACEHOLDER : PLACEHOLDER)
      this.loaded = key
    }
  }

  /** the switch: the side in front, each side's count and the Project side's reason when it has no project */
  private drawSides(tabId: string | null, front: NoteSide): void {
    const project = tabId === null ? UNKNOWN_PROJECT : this.projectOf(tabId)
    for (const side of ['session', 'project'] as const) {
      const { button, count } = this.sides[side]
      const reachable = side === 'session' || project.key !== null
      const on = side === front
      button.classList.toggle('active', on)
      button.setAttribute('aria-pressed', String(on))
      button.setAttribute('aria-disabled', String(!reachable))
      button.title = side === 'session' ? SESSION_TITLE : project.key === null ? NO_PROJECT[project.why] : `Project note: ${project.name}, shared by the Claude tabs of this project`
      const { checked, total } = itemCount(tabId === null || !reachable ? '' : this.textOf(tabId, side))
      count.hidden = total === 0
      count.textContent = `${checked}/${total}`
    }
  }
}
