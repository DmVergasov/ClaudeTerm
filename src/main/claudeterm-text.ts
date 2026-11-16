import { WAKE_HEADS } from '../shared/report-wake'
import { FORWARD_HEAD } from './chat/agent-forward'
import { BACKGROUND_PROMPT, CONTINUE_PROMPT, LIMIT_PROMPT, RESUME_PROMPT } from './auto-continue'

/** what ClaudeTerm types itself to get Claude going again: from the history these come back as plain user messages */
const OWN_PROMPTS = new Set([CONTINUE_PROMPT, RESUME_PROMPT, BACKGROUND_PROMPT, LIMIT_PROMPT])

/**
 * the one rule for text ClaudeTerm sent itself, not the person: an auto-continue prompt, live or read back from the history, a wake
 * text ClaudeTerm wrote (a role note, a report, a message, the person's relayed words... all with a head of WAKE_HEADS), or the text
 * that forwards a message to a subagent (FORWARD_HEAD). The heads are read after the text's leading whitespace and byte order mark.
 * The heads up and the person's words both read a user message through it
 */
export function isClaudeTermText(text: string): boolean {
  const t = text.trim()
  return OWN_PROMPTS.has(t) || WAKE_HEADS.some((h) => t.startsWith(h)) || t.startsWith(FORWARD_HEAD)
}
