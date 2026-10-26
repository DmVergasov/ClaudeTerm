import { promptText, type Screen } from './claude-screen'

/**
 * The pill Claude Code's fullscreen conversation shows while it is scrolled up: "Jump to bottom (ctrl+End) ↓", "3 new
 * messages (click) ↓". The same words in the conversation have no background, so only shaded cells are searched.
 */
const PILL = /(?:Jump to bottom|\b\d+ new messages?)(?: \([^)]*\))?(?: ↓|: \S+ to scroll)/

/** a Claude tab left with something unfinished: a reply not read to its end, or a prompt not sent */
export function leftUnfinished(s: Screen): boolean {
  return s.scrolledBack || s.rows.some((r) => PILL.test(r.shaded)) || Boolean(promptText(s.rows))
}
