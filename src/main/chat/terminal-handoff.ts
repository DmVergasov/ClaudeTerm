import { isHandoffLine, type TabView } from '../../shared/chat'
import type { PromptState } from '../../shared/ipc'

// A chat hands a command to the terminal: the tab switches to its terminal, and the command is typed into Claude Code's
// prompt once that prompt is empty, so the text the user keeps there is never mixed with the command.

const POLL_MS = 300
const WAIT_MS = 30_000
/** the tabs with a command waiting for their prompt: a second command for one of them is refused */
const waiting = new Set<string>()

export interface HandoffDeps {
  setView(tabId: string, view: TabView): Promise<boolean>
  promptState(tabId: string): Promise<PromptState>
  write(tabId: string, data: string): void
  note(tabId: string, text: string): void
  /** a message the window shows as a toast, for a handoff that did not type its line: the user may be in the terminal, not the chat */
  toast(text: string): void
  sleep(ms: number): Promise<void>
  /** the tab is still in the app: a tab closed meanwhile gets nothing */
  exists(tabId: string): boolean
}

export { isHandoffLine }

/** switches the tab to the terminal, waits for Claude Code's empty prompt (every 300 ms, up to 30 s), types the line and Enter */
export async function openInTerminal(tabId: string, line: string | null, what: string, d: HandoffDeps): Promise<boolean> {
  if (line !== null && !isHandoffLine(line)) return false
  // one command at a time per tab: the first one types its line, a second one would type over it
  if (waiting.has(tabId)) return false
  waiting.add(tabId)
  try {
    return await hand(tabId, line, what, d)
  } finally {
    waiting.delete(tabId)
  }
}

async function hand(tabId: string, line: string | null, what: string, d: HandoffDeps): Promise<boolean> {
  if (!(await d.setView(tabId, 'terminal'))) return false
  // a null line only switches the tab: an unknown dialog has nothing to type
  if (line === null) return true
  for (let waited = 0; ; waited += POLL_MS) {
    if (!d.exists(tabId)) return false
    if ((await d.promptState(tabId)) === 'empty') {
      if (!d.exists(tabId)) return false
      d.write(tabId, line)
      d.write(tabId, '\r')
      d.note(tabId, `Opened ${what} in the terminal`)
      return true
    }
    if (waited >= WAIT_MS) break
    await d.sleep(POLL_MS)
  }
  // the switch happened: the tab is in its terminal, the command is not typed
  if (!d.exists(tabId)) return false
  // the chat says it, and a toast too: the user may be looking at the terminal, where the note is not
  const why = `Could not run ${what}: Claude Code's prompt did not come up`
  d.note(tabId, why)
  d.toast(why)
  return true
}
