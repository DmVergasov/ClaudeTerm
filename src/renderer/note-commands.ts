import type { EditorState, Line, StateCommand, TransactionSpec } from '@codemirror/state'
import { parseLine, type NoteLine } from '../shared/note-items'

/** the commands of the note editor: the text changes they make, with no DOM, so that the unit tests run in node */

const CHECK = '- [ ] '
const BULLET = '- '

/** the lines the main selection touches; a range that ends at a line's start leaves that line out */
function touchedLines(state: EditorState): Line[] {
  const { from, to, empty } = state.selection.main
  const first = state.doc.lineAt(from)
  let last = state.doc.lineAt(to)
  if (!empty && last.from === to && last.number > first.number) last = state.doc.line(last.number - 1)
  const lines: Line[] = []
  for (let n = first.number; n <= last.number; n++) lines.push(state.doc.line(n))
  return lines
}

/** the transaction of a marker command: the edits, with the caret kept on its text */
function transaction(state: EditorState, edits: { from: number; to: number; insert: string }[]): TransactionSpec {
  const changes = state.changes(edits)
  return { changes, selection: state.selection.map(changes, 1), userEvent: 'input', scrollIntoView: true }
}

/**
 * Gives the touched lines the marker `mark`, or takes it off when they all have it already. `kind` is the kind of line
 * that has the marker. Blank lines are left, except a single blank line, which gets the marker.
 */
function toggleMarker(state: EditorState, mark: string, kind: NoteLine['kind']): TransactionSpec | null {
  const lines = touchedLines(state)
  const content = lines.filter((line) => line.text.trim() !== '')
  const edits: { from: number; to: number; insert: string }[] = []
  if (content.length > 0 && content.every((line) => parseLine(line.text).kind === kind)) {
    for (const line of content) {
      const parsed = parseLine(line.text)
      edits.push({ from: line.from + parsed.indent, to: line.from + parsed.textStart, insert: '' })
    }
  } else if (content.length > 0) {
    for (const line of content) {
      const parsed = parseLine(line.text)
      if (parsed.kind === kind) continue
      edits.push({ from: line.from + parsed.indent, to: line.from + parsed.textStart, insert: mark })
    }
  } else if (lines.length === 1) {
    const at = lines[0].from + parseLine(lines[0].text).indent
    edits.push({ from: at, to: at, insert: mark })
  }
  return edits.length > 0 ? transaction(state, edits) : null
}

/** the Checkbox button: the lines become checkbox items, or stop being items */
export const toggleCheckbox: StateCommand = ({ state, dispatch }) => {
  const spec = toggleMarker(state, CHECK, 'item')
  if (!spec) return false
  dispatch(state.update(spec))
  return true
}

/** the List button: the lines become bullets, or stop being bullets */
export const toggleBullet: StateCommand = ({ state, dispatch }) => {
  const spec = toggleMarker(state, BULLET, 'bullet')
  if (!spec) return false
  dispatch(state.update(spec))
  return true
}

/** Enter in a list: a new line with the same indent and marker; on an empty item or bullet the marker goes */
export const continueList: StateCommand = ({ state, dispatch }) => {
  const { head, empty } = state.selection.main
  if (!empty) return false
  const line = state.doc.lineAt(head)
  const parsed = parseLine(line.text)
  if (parsed.kind === 'plain' || head - line.from < parsed.textStart) return false
  if (line.text.slice(parsed.textStart).trim() === '') {
    dispatch(state.update({ changes: { from: line.from, to: line.to, insert: '' }, selection: { anchor: line.from }, userEvent: 'input' }))
    return true
  }
  const insert = '\n' + line.text.slice(0, parsed.indent) + (parsed.kind === 'item' ? CHECK : BULLET)
  dispatch(state.update({ changes: { from: head, insert }, selection: { anchor: head + insert.length }, userEvent: 'input', scrollIntoView: true }))
  return true
}

/** the change that flips the box of the checkbox item on the line at `pos`; null when that line is not an item */
export function tickLineAt(state: EditorState, pos: number): TransactionSpec | null {
  const line = state.doc.lineAt(pos)
  const parsed = parseLine(line.text)
  if (parsed.kind !== 'item') return null
  const box = line.from + parsed.indent + 3
  return { changes: { from: box, to: box + 1, insert: parsed.checked ? ' ' : 'x' }, userEvent: 'input.tick' }
}

/** Ctrl+Enter: ticks the item under the caret */
export const tickAtCaret: StateCommand = ({ state, dispatch }) => {
  const spec = tickLineAt(state, state.selection.main.head)
  if (!spec) return false
  dispatch(state.update(spec))
  return true
}
