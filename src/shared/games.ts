export const GAME_IDS = ['runner', 'merge', 'clicker'] as const

export type GameId = (typeof GAME_IDS)[number]

/** board: 16 cells row by row; 0 is empty, e > 0 is a tile of 2^(e-1) KB (1 → 1 KB, 11 → 1 MB) */
export interface MergeSave {
  board: number[]
  score: number
  best: number
  won: boolean
}

/** lines may be fractional; helpers: how many of each of the 4 helpers; at: ms since epoch the lines were last brought up to date */
export interface ClickerSave {
  lines: number
  helpers: number[]
  at: number
}

export interface GamesSave {
  game: GameId
  runnerBest: number
  merge: MergeSave | null
  clicker: ClickerSave | null
}

export const EMPTY_GAMES: GamesSave = { game: 'runner', runnerBest: 0, merge: null, clicker: null }

const MAX_SCORE = 1e12
const MAX_LINES = 1e15
const MAX_HELPER = 1e6
const MERGE_CELLS = 16
const MAX_CELL = 30
const HELPER_KINDS = 4

const isScore = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_SCORE

function isMergeSave(v: unknown): v is MergeSave {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const { board, score, best, won } = v as Record<string, unknown>
  return (
    Array.isArray(board) &&
    board.length === MERGE_CELLS &&
    board.every((c) => Number.isInteger(c) && (c as number) >= 0 && (c as number) <= MAX_CELL) &&
    isScore(score) &&
    isScore(best) &&
    typeof won === 'boolean'
  )
}

function isClickerSave(v: unknown): v is ClickerSave {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const { lines, helpers, at } = v as Record<string, unknown>
  return (
    typeof lines === 'number' &&
    Number.isFinite(lines) &&
    lines >= 0 &&
    lines <= MAX_LINES &&
    Array.isArray(helpers) &&
    helpers.length === HELPER_KINDS &&
    helpers.every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_HELPER) &&
    typeof at === 'number' &&
    Number.isFinite(at) &&
    at >= 0
  )
}

/**
 * Validates a games save read from disk or from the pipe. Each part is checked on its own: a bad part is replaced
 * by its empty value and named in `bad`; a non-object is EMPTY_GAMES with bad ['all'].
 */
export function parseGamesSave(raw: unknown): { save: GamesSave; bad: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { save: { ...EMPTY_GAMES }, bad: ['all'] }
  const r = raw as Record<string, unknown>
  const bad: string[] = []

  const game = (GAME_IDS as readonly unknown[]).includes(r.game) ? (r.game as GameId) : EMPTY_GAMES.game
  if (game !== r.game) bad.push('game')

  const runnerBest = isScore(r.runnerBest) ? r.runnerBest : EMPTY_GAMES.runnerBest
  if (runnerBest !== r.runnerBest) bad.push('runnerBest')

  let merge: MergeSave | null = null
  if (isMergeSave(r.merge)) merge = { board: [...r.merge.board], score: r.merge.score, best: r.merge.best, won: r.merge.won }
  else if (r.merge !== null) bad.push('merge')

  let clicker: ClickerSave | null = null
  if (isClickerSave(r.clicker)) clicker = { lines: r.clicker.lines, helpers: [...r.clicker.helpers], at: r.clicker.at }
  else if (r.clicker !== null) bad.push('clicker')

  return { save: { game, runnerBest, merge, clicker }, bad }
}
