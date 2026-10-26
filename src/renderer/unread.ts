/** a row of the screen: its text, and the same with some cells blanked */
export interface ScreenRow {
  text: string
  /** dim cells blanked: Claude Code draws the prompt's placeholder dim */
  bright: string
  /** only the cells with a background of their own: Claude Code draws its pill on one, over the conversation */
  shaded: string
}

export interface Screen {
  /** the rows on screen, top to bottom */
  rows: ScreenRow[]
  /** the view is up in the scrollback (Claude Code without its fullscreen mode) */
  scrolledBack: boolean
}

/**
 * The pill Claude Code's fullscreen conversation shows while it is scrolled up: "Jump to bottom (ctrl+End) ↓", "3 new
 * messages (click) ↓". The same words in the conversation have no background, so only shaded cells are searched.
 */
const PILL = /(?:Jump to bottom|\b\d+ new messages?)(?: \([^)]*\))?(?: ↓|: \S+ to scroll)/
/** the rules above and below Claude Code's prompt */
const RULE = /^─{20,}/
const PROMPT = '❯ '

/** text typed into Claude Code's prompt and not sent: anything but its dim placeholder between the rules */
function hasDraft(rows: ScreenRow[]): boolean {
  let top = rows.length - 2
  while (top >= 0 && !(RULE.test(rows[top]!.text) && rows[top + 1]!.text.startsWith(PROMPT))) top--
  if (top < 0) return false
  for (let i = top + 1; i < rows.length && !RULE.test(rows[i]!.text); i++) {
    const bright = i === top + 1 ? rows[i]!.bright.slice(PROMPT.length) : rows[i]!.bright
    if (bright.trim() !== '') return true
  }
  return false
}

/** a Claude tab left with something unfinished: a reply not read to its end, or a prompt not sent */
export function leftUnfinished(s: Screen): boolean {
  return s.scrolledBack || s.rows.some((r) => PILL.test(r.shaded)) || hasDraft(s.rows)
}
