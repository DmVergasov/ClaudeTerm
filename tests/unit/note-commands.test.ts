import { history, undo } from '@codemirror/commands'
import { EditorState, type StateCommand } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { continueList, tickAtCaret, tickLineAt, toggleBullet, toggleCheckbox } from '../../src/renderer/note-commands'

/** a state from a text where `^` marks the anchor of a selection and `|` its head (the caret, without a selection) */
function parse(marked: string): EditorState {
  let doc = ''
  let anchor: number | null = null
  let head = 0
  for (const ch of marked) {
    if (ch === '^') anchor = doc.length
    else if (ch === '|') head = doc.length
    else doc += ch
  }
  return EditorState.create({ doc, selection: { anchor: anchor ?? head, head }, extensions: history() })
}

/** the text with the same marks: `^` at the anchor of a selection, `|` at its head */
function show(state: EditorState): string {
  const { anchor, head } = state.selection.main
  const marks = anchor === head ? [[head, '|']] : [[anchor, '^'], [head, '|']]
  let text = state.doc.toString()
  for (const [pos, mark] of (marks as [number, string][]).sort((a, b) => b[0] - a[0])) text = text.slice(0, pos) + mark + text.slice(pos)
  return text
}

/** runs a command; null when it answers false and changes nothing */
function step(state: EditorState, cmd: StateCommand): EditorState | null {
  let next: EditorState | null = null
  const ran = cmd({ state, dispatch: (tr) => { next = state.update(tr).state } })
  return ran ? next : null
}

/** the text after a command on the marked text, or null when the command answers false */
function run(cmd: StateCommand, marked: string): string | null {
  const next = step(parse(marked), cmd)
  return next ? show(next) : null
}

describe('note commands', () => {
  it('toggleCheckbox turns a plain line into an item keeping its indent, and an item back', () => {
    expect(run(toggleCheckbox, '  Write|')).toBe('  - [ ] Write|')
    expect(run(toggleCheckbox, '- [x] Done|')).toBe('Done|')
  })

  it('toggleCheckbox turns a bullet into an item, and an empty line into an empty item', () => {
    expect(run(toggleCheckbox, '- a|')).toBe('- [ ] a|')
    expect(run(toggleCheckbox, '|')).toBe('- [ ] |')
  })

  it('toggleCheckbox on several lines: all become items unless all are, blank lines left', () => {
    expect(run(toggleCheckbox, '^a\n\nb|')).toBe('- [ ] ^a\n\n- [ ] b|')
    expect(run(toggleCheckbox, '- [ ] ^a\n\n- [ ] b|')).toBe('^a\n\nb|')
  })

  it('a range ending at the start of a line leaves that line out', () => {
    expect(run(toggleCheckbox, '^a\n|b')).toBe('- [ ] ^a\n|b')
  })

  it('toggleBullet does the same for bullets and turns an item into a bullet', () => {
    expect(run(toggleBullet, '- a|')).toBe('a|')
    expect(run(toggleBullet, '- [x] Done|')).toBe('- Done|')
    expect(run(toggleBullet, 'a|')).toBe('- a|')
  })

  it('continueList at the end of an item starts a new unticked item with its indent; inside, it splits the text', () => {
    expect(run(continueList, '  - [x] one|')).toBe('  - [x] one\n  - [ ] |')
    expect(run(continueList, '- [ ] on|e')).toBe('- [ ] on\n- [ ] |e')
    expect(run(continueList, '- a|')).toBe('- a\n- |')
  })

  it('continueList on an empty item or bullet ends the list; elsewhere it answers false', () => {
    expect(run(continueList, '  - [ ] |')).toBe('|')
    expect(run(continueList, '- |')).toBe('|')
    expect(run(continueList, 'a|')).toBeNull()
    expect(run(continueList, '-| [ ] one')).toBeNull()
    expect(run(continueList, '^- [ ] one|')).toBeNull()
  })

  it('tickAtCaret ticks and unticks the item under the caret; [X] counts as ticked; elsewhere false', () => {
    expect(run(tickAtCaret, '- [ ] one|')).toBe('- [x] one|')
    expect(run(tickAtCaret, '- [x] one|')).toBe('- [ ] one|')
    expect(run(tickAtCaret, '- [X] one|')).toBe('- [ ] one|')
    expect(run(tickAtCaret, 'plain|')).toBeNull()
  })

  it('tickLineAt flips the box of the line at a position', () => {
    const state = parse('- [ ] a\n- [x] b')
    const spec = tickLineAt(state, 10)
    expect(spec).not.toBeNull()
    expect(state.update(spec!).state.doc.toString()).toBe('- [ ] a\n- [ ] b')
    expect(tickLineAt(parse('plain'), 2)).toBeNull()
  })

  it('undo after a toggle brings the text back', () => {
    const toggled = step(parse('Write|'), toggleCheckbox)!
    expect(show(toggled)).toBe('- [ ] Write|')
    expect(show(step(toggled, undo)!)).toBe('Write|')
  })
})
