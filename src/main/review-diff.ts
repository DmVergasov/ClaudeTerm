import { structuredPatch } from 'diff'
import type { ReviewFile, ReviewFileStatus, ReviewHunk, ReviewLine } from '../shared/review'
import { contentSha, isBinary } from './edit-ledger'

/** a side larger than this shows "too large" */
export const MAX_SIDE_BYTES = 1024 * 1024
/** "show anyway" builds sides up to this size */
export const MAX_FORCED_BYTES = 10 * 1024 * 1024
/** a view with more files lists only this many, without reading them */
export const MAX_FILES = 500
/** a view reads at most about this much text */
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024
/** a file's diff gives up after this long (the main process waits for it): the file shows "too large" */
export const DIFF_TIMEOUT_MS = 300
/** the time limit for a file asked for with "show anyway" */
export const FORCED_DIFF_TIMEOUT_MS = 3000
/** a view diffs for at most this long: the files left are listed without hunks */
export const VIEW_DIFF_MS = 1500

/** one side of a file in a view */
export type Side =
  | { kind: 'data'; data: Buffer }
  | { kind: 'absent' }
  | { kind: 'binary' }
  | { kind: 'too-large'; size: number }
  | { kind: 'dir' }
  /** no baseline could be found (the before side of Claude's edits) */
  | { kind: 'none' }
  | { kind: 'unreadable' }
  /** not read: the view is over its limits */
  | { kind: 'skipped' }

export interface DiffInput {
  path: string
  relPath: string
  before: Side
  after: Side
  /** "show anyway" was asked for this file */
  forced: boolean
  /** git's status, for files whose sides were not read */
  status?: ReviewFileStatus
}

export const normalizeEol = (s: string): string => s.replace(/\r\n/g, '\n')
/** names the current content for Viewed; a too large file is named by its size, so a change still clears the mark */
const hashOf = (s: Side): string => (s.kind === 'data' ? contentSha(s.data) : s.kind === 'too-large' ? `too-large:${s.size}` : s.kind)

/** the hunks; null when the diff took longer than `timeoutMs` and gave up */
export function toHunks(before: string, after: string, timeoutMs: number): { hunks: ReviewHunk[]; additions: number; deletions: number } | null {
  const patch = structuredPatch('a', 'b', before, after, '', '', { context: 3, timeout: timeoutMs })
  if (!patch) return null
  let additions = 0
  let deletions = 0
  const hunks = patch.hunks.map((h): ReviewHunk => {
    let oldNo = h.oldStart
    let newNo = h.newStart
    const lines: ReviewLine[] = []
    for (const l of h.lines) {
      const text = l.slice(1)
      if (l[0] === '+') {
        lines.push({ kind: 'add', text, oldNo: null, newNo: newNo++ })
        additions++
      } else if (l[0] === '-') {
        lines.push({ kind: 'del', text, oldNo: oldNo++, newNo: null })
        deletions++
      } else if (l[0] === ' ') {
        lines.push({ kind: 'context', text, oldNo: oldNo++, newNo: newNo++ })
      }
      // '\ No newline at end of file' is not a line
    }
    return { header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, lines }
  })
  return { hunks, additions, deletions }
}

/** The review entry for one file; null when there is nothing to show (both sides the same, or absent). `skip`: list it without diffing. */
export function buildFile(input: DiffInput, skip = false): ReviewFile | null {
  const { before, after } = input
  if (before.kind === 'absent' && after.kind === 'absent') return null
  const status: ReviewFileStatus = input.status ?? (before.kind === 'absent' ? 'added' : after.kind === 'absent' ? 'deleted' : 'modified')
  const file: ReviewFile = {
    path: input.path, relPath: input.relPath, status, additions: 0, deletions: 0, hunks: [], note: null, canForce: false, hash: hashOf(after), viewed: false
  }
  const kinds = [before.kind, after.kind]
  if (skip || kinds.includes('skipped')) return { ...file, note: 'too-many' }
  if (before.kind === 'none') return { ...file, note: 'no-baseline' }
  if (kinds.includes('unreadable')) return { ...file, note: 'unreadable' }
  if (kinds.includes('dir')) return { ...file, note: 'submodule' }
  if (kinds.includes('binary')) return { ...file, note: 'binary' }
  if (before.kind === 'too-large' || after.kind === 'too-large') {
    const fits = [before, after].every((s) => s.kind !== 'too-large' || s.size <= MAX_FORCED_BYTES)
    return { ...file, note: 'too-large', canForce: fits && !input.forced }
  }
  const b = before.kind === 'data' ? before.data : Buffer.alloc(0)
  const a = after.kind === 'data' ? after.data : Buffer.alloc(0)
  if (isBinary(b) || isBinary(a)) return { ...file, note: 'binary' }
  const bt = normalizeEol(b.toString('utf8'))
  const at = normalizeEol(a.toString('utf8'))
  if (status === 'modified' && bt === at) return b.equals(a) ? null : { ...file, note: 'eol-only' }
  const diff = toHunks(bt, at, input.forced ? FORCED_DIFF_TIMEOUT_MS : DIFF_TIMEOUT_MS)
  // too slow to diff: shown like a too large file, and "show anyway" gives it longer
  if (!diff) return { ...file, note: 'too-large', canForce: !input.forced && b.length <= MAX_FORCED_BYTES && a.length <= MAX_FORCED_BYTES }
  return { ...file, ...diff }
}

/**
 * A view's files. It yields to the event loop between files, so pipe messages (an edit waiting for its baseline)
 * and IPC are served during a long build; after VIEW_DIFF_MS of diffing the files left are listed without hunks.
 */
export async function buildFiles(inputs: DiffInput[], now: () => number = Date.now): Promise<{ files: ReviewFile[]; tooMany: boolean }> {
  const files: ReviewFile[] = []
  let spent = 0
  let tooMany = false
  for (const [i, input] of inputs.entries()) {
    if (i > 0) await new Promise<void>((r) => setImmediate(r))
    tooMany ||= spent >= VIEW_DIFF_MS
    const start = now()
    const f = buildFile(input, tooMany)
    spent += now() - start
    if (f) files.push(f)
  }
  return { files, tooMany }
}
