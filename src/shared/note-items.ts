import { MAX_NOTE_LENGTH } from './note'

/** One line of a note, read as Markdown: a checkbox item, a bullet, or plain text. */
export interface NoteLine {
  indent: number
  kind: 'item' | 'bullet' | 'plain'
  checked: boolean
  /** where the line's text starts: after the marker */
  textStart: number
}

/** A checkbox item of a note; `line` is 0-based, `text` is trimmed. */
export interface NoteItem {
  line: number
  checked: boolean
  text: string
}

/** An edit Claude makes to a note: an appended text, or a tick on one item. */
export type NoteOp = { kind: 'append'; text: string } | { kind: 'check'; item: string; checked: boolean }

export type OpResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; reason: 'empty' }
  | { ok: false; reason: 'too-long'; adds: number }
  | { ok: false; reason: 'no-match' }
  | { ok: false; reason: 'ambiguous'; matches: number }

/** the one change that turns a text into another */
export interface TextChange {
  from: number
  to: number
  insert: string
}

const ITEM = /^([ \t]*)- \[([ xX])\](?: |$)/
const BULLET = /^([ \t]*)- /
const INDENT = /^[ \t]*/

export function parseLine(line: string): NoteLine {
  const item = ITEM.exec(line)
  if (item) return { indent: item[1].length, kind: 'item', checked: item[2] !== ' ', textStart: item[0].length }
  const bullet = BULLET.exec(line)
  if (bullet) return { indent: bullet[1].length, kind: 'bullet', checked: false, textStart: bullet[1].length + 2 }
  const indent = INDENT.exec(line)![0].length
  return { indent, kind: 'plain', checked: false, textStart: indent }
}

export function noteItems(text: string): NoteItem[] {
  const items: NoteItem[] = []
  text.split('\n').forEach((line, index) => {
    const parsed = parseLine(line)
    if (parsed.kind !== 'item') return
    items.push({ line: index, checked: parsed.checked, text: line.slice(parsed.textStart).trim() })
  })
  return items
}

export function itemCount(text: string): { checked: number; total: number } {
  const items = noteItems(text)
  return { checked: items.filter((item) => item.checked).length, total: items.length }
}

/** the first line with text, from its text start, trimmed */
export function firstLine(text: string): string {
  for (const line of text.split('\n')) {
    const body = line.slice(parseLine(line).textStart).trim()
    if (body !== '') return body
  }
  return ''
}

/** the card's label: the count of ticked items and the first unticked one; no items, the first line */
export function noteLabel(text: string): { count: string | null; text: string } {
  const items = noteItems(text)
  if (items.length === 0) return { count: null, text: firstLine(text) }
  const checked = items.filter((item) => item.checked).length
  const unticked = items.find((item) => !item.checked)
  return { count: `${checked}/${items.length}`, text: unticked ? unticked.text : firstLine(text) }
}

/** the addition as it is appended: line ends as \n, leading blank lines and trailing whitespace removed */
function normaliseAddition(addition: string): string {
  return addition
    .replace(/\r\n?/g, '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd()
}

/** the text with the addition after one blank line; no limit check */
export function appendText(text: string, addition: string): string {
  const add = normaliseAddition(addition)
  if (text.trim() === '') return add
  if (/\n[ \t]*\n$/.test(text)) return text + add
  if (text.endsWith('\n')) return text + '\n' + add
  return text + '\n\n' + add
}

export function tryNoteOp(text: string, op: NoteOp): OpResult {
  if (op.kind === 'append') {
    if (normaliseAddition(op.text) === '') return { ok: false, reason: 'empty' }
    const result = appendText(text, op.text)
    if (result.length > MAX_NOTE_LENGTH) return { ok: false, reason: 'too-long', adds: result.length - text.length }
    return { ok: true, text: result, changed: true }
  }

  const target = op.item.trim()
  const lines = text.split('\n')
  const matches = target === '' ? [] : noteItems(text).filter((item) => item.text === target)
  if (matches.length === 0) return { ok: false, reason: 'no-match' }
  if (matches.length > 1) return { ok: false, reason: 'ambiguous', matches: matches.length }

  const line = lines[matches[0].line]
  const box = parseLine(line).indent + 3
  if (matches[0].checked === op.checked) return { ok: true, text, changed: false }
  lines[matches[0].line] = line.slice(0, box) + (op.checked ? 'x' : ' ') + line.slice(box + 1)
  return { ok: true, text: lines.join('\n'), changed: true }
}

/** the new text, or `text` when the op is refused */
export function applyNoteOp(text: string, op: NoteOp): string {
  const result = tryNoteOp(text, op)
  return result.ok ? result.text : text
}

export function replayNoteOps(text: string, ops: readonly NoteOp[]): string {
  return ops.reduce((current, op) => applyNoteOp(current, op), text)
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

export function diffText(a: string, b: string): TextChange | null {
  if (a === b) return null
  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
  if (prefix > 0 && isHighSurrogate(a.charCodeAt(prefix - 1))) prefix--

  let suffix = 0
  const limit = Math.min(a.length, b.length) - prefix
  while (suffix < limit && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++
  if (isLowSurrogate(a.charCodeAt(a.length - suffix))) suffix--

  return { from: prefix, to: a.length - suffix, insert: b.slice(prefix, b.length - suffix) }
}
