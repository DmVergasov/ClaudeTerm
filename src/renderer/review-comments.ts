import type { ReviewFile, ReviewLine, ReviewLineKind, ReviewSendState } from '../shared/review'

export interface AnchorLine {
  kind: ReviewLineKind
  text: string
  oldNo: number | null
  newNo: number | null
}

/** what a comment is about: lines of a file, by their text and place */
export interface CommentAnchor {
  path: string
  relPath: string
  lines: AnchorLine[]
  /** the view it was written in: there it follows its lines; elsewhere it is only looked up */
  viewKey: string
}

export interface ReviewComment {
  id: string
  anchor: CommentAnchor
  text: string
  outdated: boolean
}

export interface Located {
  file: number
  hunk: number
  from: number
  to: number
}

export const MAX_QUOTE_LINES = 6
export const NEAR_LINES = 50

export function viewKeyOf(u: { view: { kind: 'scope'; scope: string } | { kind: 'request' }; label: string }): string {
  return u.view.kind === 'scope' ? `scope:${u.view.scope}` : `request:${u.label}`
}

export function anchorOf(file: ReviewFile, lines: ReviewLine[], viewKey: string): CommentAnchor {
  return { path: file.path, relPath: file.relPath, lines: lines.map((l) => ({ ...l })), viewKey }
}

const position = (l: { oldNo: number | null; newNo: number | null }, side: 'new' | 'old'): number => (side === 'new' ? l.newNo : l.oldNo) ?? 0

/** The anchor's lines in `files`: the same lines of the same file, nearest to where they were, within 50 lines. */
export function locate(anchor: CommentAnchor, files: ReviewFile[], samePath: (a: string, b: string) => boolean): Located | null {
  const fi = files.findIndex((f) => samePath(f.path, anchor.path))
  const first = anchor.lines[0]
  if (fi < 0 || !first) return null
  const side = first.newNo !== null ? 'new' : 'old'
  const target = position(first, side)
  let best: Located | null = null
  let bestDist = Number.POSITIVE_INFINITY
  files[fi]!.hunks.forEach((h, hi) => {
    for (let i = 0; i + anchor.lines.length <= h.lines.length; i++) {
      if (!anchor.lines.every((w, k) => h.lines[i + k]!.kind === w.kind && h.lines[i + k]!.text === w.text)) continue
      const dist = Math.abs(position(h.lines[i]!, side) - target)
      if (dist <= NEAR_LINES && dist < bestDist) {
        best = { file: fi, hunk: hi, from: i, to: i + anchor.lines.length - 1 }
        bestDist = dist
      }
    }
  })
  return best
}

/** the anchor moved to where `at` found its lines */
export function moveAnchor(anchor: CommentAnchor, files: ReviewFile[], at: Located): CommentAnchor {
  return { ...anchor, lines: files[at.file]!.hunks[at.hunk]!.lines.slice(at.from, at.to + 1).map((l) => ({ ...l })) }
}

/**
 * A comment of the view after an update: it follows its lines. It is outdated only when its file is still shown with
 * hunks but without its lines; a file that left the view, or shows a row instead of hunks, says nothing about them.
 */
export function reanchorComment(c: ReviewComment, files: ReviewFile[], samePath: (a: string, b: string) => boolean): ReviewComment {
  const at = locate(c.anchor, files, samePath)
  if (at) return { ...c, anchor: moveAnchor(c.anchor, files, at), outdated: false }
  const file = files.find((f) => samePath(f.path, c.anchor.path))
  return file && file.note === null ? { ...c, outdated: true } : c
}

/** the Send error after an update: it goes with a change of tab, and once the tab may send again */
export function sendErrorAfter(error: string | null, tabId: string | null, update: { tabId: string; send: ReviewSendState } | null): string | null {
  return update === null || update.tabId !== tabId || update.send.ok ? null : error
}

/** Send's outcome: null when it went, else why not; a failure is a reason too */
export async function attemptSend(send: () => Promise<string | null>): Promise<string | null> {
  try {
    return await send()
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** a comment being typed outlives a Send that took the others; one editing a sent comment becomes a new comment */
export function draftAfterSend<D extends { text: string; editing: string | null }>(draft: D | null): D | null {
  return draft !== null && draft.text.trim() !== '' ? { ...draft, editing: null } : null
}

function range(nums: number[]): string {
  const lo = Math.min(...nums)
  const hi = Math.max(...nums)
  return lo === hi ? `${lo}` : `${lo}-${hi}`
}

/** "src/a.ts:40-41", or the old numbers of removed lines */
export function location(a: CommentAnchor): string {
  const news = a.lines.flatMap((l) => (l.newNo === null ? [] : [l.newNo]))
  if (news.length > 0) return `${a.relPath}:${range(news)}`
  const olds = a.lines.flatMap((l) => (l.oldNo === null ? [] : [l.oldNo]))
  if (a.lines.length === 1) return `${a.relPath}:${range(olds)} (removed line, was: ${a.lines[0]!.text.trim()})`
  return `${a.relPath}:${range(olds)} (removed lines)`
}

/** "Line 40", "Lines 40–41", "Removed line 12" — the header of a comment box */
export function describeLines(a: CommentAnchor): string {
  const news = a.lines.flatMap((l) => (l.newNo === null ? [] : [l.newNo]))
  const nums = news.length > 0 ? news : a.lines.flatMap((l) => (l.oldNo === null ? [] : [l.oldNo]))
  const lo = Math.min(...nums)
  const hi = Math.max(...nums)
  const what = news.length > 0 ? 'Line' : 'Removed line'
  return lo === hi ? `${what} ${lo}` : `${what}s ${lo}–${hi}`
}

const indentOf = (s: string): number => /^\s*/.exec(s)![0].length

function quote(a: CommentAnchor): string[] {
  // a single removed line is quoted in the location already
  if (a.lines.length === 1 && a.lines[0]!.kind === 'del') return []
  const mixed = a.lines.some((l) => l.kind === 'del') && a.lines.some((l) => l.kind !== 'del')
  const mark = (l: AnchorLine): string => (!mixed ? '' : l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ')
  const shown = a.lines.slice(0, MAX_QUOTE_LINES)
  const cut = Math.min(...shown.filter((l) => l.text.trim() !== '').map((l) => indentOf(l.text)))
  const out = shown.map((l) => `   > ${mark(l)}${l.text.slice(Number.isFinite(cut) ? Math.min(cut, indentOf(l.text)) : 0)}`.trimEnd())
  if (a.lines.length > MAX_QUOTE_LINES) out.push('   > …')
  return out
}

/** The message Send writes into Claude's prompt. */
export function formatSendMessage(label: string, comments: ReviewComment[]): string {
  const blocks = comments.map((c, i) => {
    const where = location(c.anchor) + (c.outdated ? ' (outdated: the lines changed since)' : '')
    const body = c.text.trim().split(/\r?\n/).map((l) => `   ${l}`.trimEnd())
    return [`${i + 1}. ${where}`, ...quote(c.anchor), ...body].join('\n')
  })
  return [`Review comments on the changes (${label}):`, '', blocks.join('\n\n')].join('\n')
}
