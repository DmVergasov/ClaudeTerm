import { WAKE_HEADS } from '../shared/report-wake'
import { BACKGROUND_PROMPT, CONTINUE_PROMPT, LIMIT_PROMPT, RESUME_PROMPT } from './auto-continue'

/** what ClaudeTerm types itself to get Claude going again: from the history these come back as plain user messages */
const OWN_PROMPTS = new Set([CONTINUE_PROMPT, RESUME_PROMPT, BACKGROUND_PROMPT, LIMIT_PROMPT])

/**
 * the one rule for text ClaudeTerm sent itself, not the person: an auto-continue prompt, live or read back from the history, or a
 * wake text ClaudeTerm wrote (a role note, a report, a message, the person's relayed words... all with a head of WAKE_HEADS). The
 * heads up and the person's words both read a user message through it
 */
export function isClaudeTermText(text: string): boolean {
  return OWN_PROMPTS.has(text.trim()) || WAKE_HEADS.some((h) => text.startsWith(h))
}
