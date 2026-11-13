import { defaultKeymap, history, historyKeymap, redo } from '@codemirror/commands'
import { Annotation, EditorState, type Extension, type Range, Prec, Transaction } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, keymap, placeholder, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'
import { MAX_NOTE_LENGTH } from '../shared/note'
import { diffText, parseLine } from '../shared/note-items'
import { continueList, tickAtCaret, tickLineAt, toggleBullet, toggleCheckbox } from './note-commands'

export interface NoteEditorOptions {
  /** a change the person made: the whole text */
  changed(text: string): void
  /** a keydown before the editor's own keys; true when it was handled (Escape, the note shortcut) */
  key(e: KeyboardEvent): boolean
  /** a copy of the selection, as the note has it (Markdown): the system clipboard is written by main */
  copy(text: string): void
}

/** marks the transactions that bring Claude's changes into the note: they are not the person's */
const fromMain = Annotation.define<boolean>()

const CHECK = '- [ ] '

class CheckWidget extends WidgetType {
  constructor(private readonly checked: boolean) {
    super()
  }

  eq(other: CheckWidget): boolean {
    return other.checked === this.checked
  }

  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'note-check'
    input.tabIndex = -1
    input.checked = this.checked
    input.addEventListener('mousedown', (e) => {
      // the editor keeps the caret; the click ticks the item of this line
      e.preventDefault()
      const spec = tickLineAt(view.state, view.posAtDOM(input))
      if (spec) view.dispatch(spec)
    })
    return input
  }
}

class BulletWidget extends WidgetType {
  eq(): boolean {
    return true
  }

  toDOM(): HTMLElement {
    return Object.assign(document.createElement('span'), { className: 'note-bullet', textContent: '•' })
  }
}

const bulletMark = Decoration.replace({ widget: new BulletWidget() })

/** the decorations of the visible lines: an item's line and box, a bullet's dot; the boxes and dots are atomic */
function build(view: EditorView): { decorations: DecorationSet; atoms: DecorationSet } {
  const decorations: Range<Decoration>[] = []
  const atoms: Range<Decoration>[] = []
  for (const range of view.visibleRanges) {
    let pos = range.from
    while (pos <= range.to) {
      const line = view.state.doc.lineAt(pos)
      const parsed = parseLine(line.text)
      if (parsed.kind === 'item') {
        decorations.push(Decoration.line({ class: parsed.checked ? 'note-item note-item-done' : 'note-item' }).range(line.from))
        const box = Decoration.replace({ widget: new CheckWidget(parsed.checked) }).range(line.from + parsed.indent, line.from + parsed.textStart)
        decorations.push(box)
        atoms.push(box)
      } else if (parsed.kind === 'bullet') {
        const dot = bulletMark.range(line.from + parsed.indent, line.from + parsed.textStart)
        decorations.push(dot)
        atoms.push(dot)
      }
      pos = line.to + 1
    }
  }
  return { decorations: Decoration.set(decorations, true), atoms: Decoration.set(atoms, true) }
}

class LineMarks {
  decorations: DecorationSet
  atoms: DecorationSet

  constructor(view: EditorView) {
    const built = build(view)
    this.decorations = built.decorations
    this.atoms = built.atoms
  }

  update(update: ViewUpdate): void {
    if (!update.docChanged && !update.viewportChanged) return
    const built = build(update.view)
    this.decorations = built.decorations
    this.atoms = built.atoms
  }
}

const lineMarks = ViewPlugin.fromClass(LineMarks, {
  decorations: (plugin) => plugin.decorations,
  provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atoms ?? Decoration.none)
})

/** a space typed after `[ ]` or `[]` at the start of a line makes that line a checkbox item */
const boxInput = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== ' ' || from !== to) return false
  const line = view.state.doc.lineAt(from)
  const before = line.text.slice(0, from - line.from)
  if (!/^[ \t]*\[ ?\]$/.test(before)) return false
  const start = line.from + before.search(/\S/)
  view.dispatch({ changes: { from: start, to: from, insert: CHECK }, selection: { anchor: start + CHECK.length }, userEvent: 'input.type' })
  return true
})

/** a change of the person's may not make the note longer than it can be stored; Claude's text is checked by main */
const withinLimit = EditorState.changeFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(fromMain) === true) return true
  return tr.newDoc.length <= MAX_NOTE_LENGTH || tr.newDoc.length <= tr.startState.doc.length
})

function extensions(opts: NoteEditorOptions, placeholderText: string): Extension[] {
  return [
    history(),
    Prec.highest(EditorView.domEventHandlers({
      keydown: (e) => opts.key(e),
      // the copy goes through main like the other copies of the app: the native copy left the system clipboard empty in the e2e run
      copy: (e, view) => {
        const { from, to, empty } = view.state.selection.main
        if (empty) return false
        e.preventDefault()
        opts.copy(view.state.sliceDoc(from, to))
        return true
      }
    })),
    Prec.high(keymap.of([
      { key: 'Enter', run: continueList },
      { key: 'Mod-Enter', run: tickAtCaret },
      { key: 'Ctrl-Enter', run: tickAtCaret }
    ])),
    // historyKeymap redoes with Ctrl+Y on Windows only; Ctrl+Shift+Z redoes there too
    keymap.of([...defaultKeymap, ...historyKeymap, { key: 'Mod-Shift-z', run: redo, preventDefault: true }]),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ class: 'note-text', spellcheck: 'false', 'aria-label': 'Note' }),
    placeholder(placeholderText),
    lineMarks,
    boxInput,
    withinLimit,
    EditorView.updateListener.of((update) => {
      if (update.transactions.some((tr) => tr.docChanged && tr.annotation(fromMain) !== true)) opts.changed(update.state.doc.toString())
    })
  ]
}

/** the note's text as a CodeMirror editor: Markdown checkboxes and bullets, drawn as boxes and dots */
export class NoteEditor {
  readonly dom: HTMLElement
  private readonly view: EditorView

  constructor(private readonly opts: NoteEditorOptions) {
    this.view = new EditorView({ state: EditorState.create({ extensions: extensions(opts, '') }) })
    this.dom = this.view.dom
  }

  get text(): string {
    return this.view.state.doc.toString()
  }

  /** another note: its text, a new history, the placeholder */
  load(text: string, placeholder: string): void {
    this.view.setState(EditorState.create({ doc: text, extensions: extensions(this.opts, placeholder) }))
  }

  /** a change from main to the note shown (one of Claude's edits): the one change diffText gives, applied with addToHistory false; caret, selection and history kept; not reported to changed() */
  update(text: string): void {
    const change = diffText(this.text, text)
    if (!change) return
    this.view.dispatch({ changes: change, annotations: [fromMain.of(true), Transaction.addToHistory.of(false)] })
  }

  toggleCheckbox(): void {
    toggleCheckbox({ state: this.view.state, dispatch: (tr) => this.view.dispatch(tr) })
  }

  toggleBullet(): void {
    toggleBullet({ state: this.view.state, dispatch: (tr) => this.view.dispatch(tr) })
  }

  /** the keyboard in the editor, the caret at the end */
  focus(): void {
    this.view.dispatch({ selection: { anchor: this.view.state.doc.length }, scrollIntoView: true })
    this.view.focus()
  }
}
