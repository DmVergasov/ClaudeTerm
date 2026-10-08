import type { PatchHunk } from './transcript-edits'

/** An edit the transcript tells about: what Claude Code stored with its result. */
export interface HistoryEdit {
  at: number
  toolUseId: string
  path: string
  created: boolean
  originalFile: string | null
  patch: PatchHunk[]
}

export type HistoryBaseline = { kind: 'text'; text: string } | { kind: 'absent' } | { kind: 'none' }

/** how far from its recorded place a hunk is looked for */
const MAX_OFFSET = 200

function matchesAt(lines: string[], block: string[], at: number): boolean {
  if (at < 0 || at + block.length > lines.length) return false
  for (let i = 0; i < block.length; i++) if (lines[at + i] !== block[i]) return false
  return true
}

/** The text before an edit, from the text after it and the edit's hunks; null when a hunk does not fit. */
export function reverseApply(text: string, hunks: PatchHunk[]): string | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  for (const h of [...hunks].sort((a, b) => b.newStart - a.newStart)) {
    const body = h.lines.filter((l) => !l.startsWith('\\'))
    const strip = (l: string): string => l.slice(1).replace(/\r$/, '')
    const after = body.filter((l) => l[0] === ' ' || l[0] === '+').map(strip)
    const before = body.filter((l) => l[0] === ' ' || l[0] === '-').map(strip)
    // an empty new side sits after line newStart; otherwise it starts at line newStart
    const expected = after.length === 0 ? h.newStart : h.newStart - 1
    let at = -1
    for (let d = 0; d <= MAX_OFFSET && at < 0; d++) {
      if (matchesAt(lines, after, expected - d)) at = expected - d
      else if (d > 0 && matchesAt(lines, after, expected + d)) at = expected + d
    }
    if (at < 0) return null
    lines.splice(at, after.length, ...before)
  }
  return lines.join(eol)
}

/**
 * A file's content before the first of `edits` (one file, oldest first). The first edit's originalFile when
 * Claude Code stored it; otherwise `later` — the content right after the last edit — with the edits undone,
 * newest first, taking a stored originalFile on the way where there is one.
 */
export function historyBaseline(edits: HistoryEdit[], later: string | null): HistoryBaseline {
  const first = edits[0]
  if (!first) return { kind: 'none' }
  if (first.created) return { kind: 'absent' }
  if (first.originalFile !== null) return { kind: 'text', text: first.originalFile }
  let text = later
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i]!
    if (e.originalFile !== null) {
      text = e.originalFile
      continue
    }
    // a file created again after the first edit: what came before cannot be rebuilt
    if (e.created || text === null) return { kind: 'none' }
    text = reverseApply(text, e.patch)
    if (text === null) return { kind: 'none' }
  }
  return text === null ? { kind: 'none' } : { kind: 'text', text }
}
