/*
 * What Claude Code draws in a Claude tab, read from the terminal's screen. As Claude Code 2.1.308 draws it in its
 * fullscreen mode: its prompt sits between two rules, starts with ❯ and a no-break space, and shows its placeholder dim.
 */

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

/** the rules above and below Claude Code's prompt */
const RULE = /^─{20,}/
/** the start of Claude Code's prompt: ❯ and a no-break space (a plain one in the conversation above), or ❯ alone once the space is trimmed */
const PROMPT = /^❯(?:[ \u00a0]|$)/

/**
 * What Claude Code's prompt holds: the text typed into it and not sent, '' when it shows only its dim placeholder, null
 * when the screen shows no prompt (a dialog in its place, another program).
 */
export function promptText(rows: ScreenRow[]): string | null {
  let top = rows.length - 2
  while (top >= 0 && !(RULE.test(rows[top]!.text) && PROMPT.test(rows[top + 1]!.text))) top--
  if (top < 0) return null
  const lines: string[] = []
  for (let i = top + 1; i < rows.length && !RULE.test(rows[i]!.text); i++) {
    lines.push((i === top + 1 ? rows[i]!.bright.replace(PROMPT, '') : rows[i]!.bright).trim())
  }
  return lines.join('\n').trim()
}
