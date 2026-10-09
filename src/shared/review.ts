// What the main process and the Changes panel exchange about a review.

export type ReviewScope = 'uncommitted' | 'last_turn' | 'session'
export const REVIEW_SCOPES: readonly ReviewScope[] = ['uncommitted', 'last_turn', 'session']
/** the view's name in the Send message and in show_diff labels */
export const SCOPE_LABELS: Record<ReviewScope, string> = { uncommitted: 'uncommitted', last_turn: 'last turn', session: 'session' }

/** why Send is refused: the main process says it, the Changes panel shows it */
export const NOT_RUNNING = 'Claude is not running in this tab'
export const IN_DIALOG = "Answer Claude's prompt in the terminal first"

export type ReviewLineKind = 'context' | 'add' | 'del'

export interface ReviewLine {
  kind: ReviewLineKind
  text: string
  /** the line's number on the old side; null for an added line */
  oldNo: number | null
  /** the line's number on the new side; null for a deleted line */
  newNo: number | null
}

export interface ReviewHunk {
  /** "@@ -38,7 +38,9 @@" */
  header: string
  lines: ReviewLine[]
}

export type ReviewFileStatus = 'added' | 'modified' | 'deleted'

/** why a file shows one row instead of hunks */
export type ReviewFileNote = 'binary' | 'too-large' | 'eol-only' | 'no-baseline' | 'submodule' | 'unreadable' | 'too-many'

export interface ReviewFile {
  /** absolute */
  path: string
  /** what the panel shows: relative to the repository root or the tab's folder, with / separators */
  relPath: string
  status: ReviewFileStatus
  additions: number
  deletions: number
  hunks: ReviewHunk[]
  note: ReviewFileNote | null
  /** a "too large" file can be built anyway: both sides are at most 10 MB */
  canForce: boolean
  /** names the file's current content: a Viewed mark lasts while it stays the same */
  hash: string
  viewed: boolean
}

export type ReviewSendState = { ok: true } | { ok: false; reason: string }

export interface ReviewCounter {
  files: number
  additions: number
  deletions: number
  /** the status bar tooltip */
  title: string
}

export interface ReviewUpdate {
  tabId: string
  view: { kind: 'scope'; scope: ReviewScope } | { kind: 'request' }
  /** "uncommitted", "last turn", "session", or the show_diff chip text */
  label: string
  uncommitted: { available: true } | { available: false; reason: string }
  files: ReviewFile[]
  additions: number
  deletions: number
  unviewed: number
  /** files review.hideIgnored left out of this view */
  ignored: number
  /** review.hideTests is on: the Hide tests checkbox shows it */
  hideTests: boolean
  /** test files review.hideTests left out of this view, and up to 10 of their paths (relative to the view's root, sorted) */
  testsHidden: number
  testsSample: string[]
  /** files outside the tab's folder that Last turn and Session leave out, and up to 10 of their paths (sorted) */
  outside: number
  outsideSample: string[]
  /** the tab's folder: the one Last turn and Session are limited to */
  folder: string
  notice: string | null
  send: ReviewSendState
  counter: ReviewCounter | null
  /** show_diff asked to open the panel */
  reveal: boolean
}
