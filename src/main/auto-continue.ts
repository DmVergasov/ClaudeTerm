import { MAX_AUTO_CONTINUES } from '../shared/settings-keys'
import type { Logger } from './log'

/*
 * Claude Code ends an interactive turn whose response was cut off mid-stream (a connection lost, a stream that stopped
 * arriving) and waits for the user; only subagents and claude -p are nudged to go on by Claude Code itself. Such a turn
 * reports StopFailure with error server_error. With claude.autoContinue on, ClaudeTerm types the nudge Claude Code
 * would send into the tab instead of calling the user, unless the user typed into the tab since the turn started.
 */

/** the words Claude Code itself sends a subagent whose response was cut off mid-stream */
export const CONTINUE_PROMPT = 'Your response above was cut off mid-stream. Resume directly from where it stops - no apology, no recap. If none of it survived, answer the request from the start.'
/** the StopFailure error of a response cut off mid-stream, also of a server error the retries did not get past */
export const CUT_OFF_ERROR = 'server_error'
/** time for Claude Code to take input again, and for a dropped connection to come back */
export const CONTINUE_DELAY_MS = 5000
/** Enter goes on its own after the text, as Send does: in the same write it would be part of a paste */
export const ENTER_DELAY_MS = 50

export interface AutoContinueDeps {
  enabled(): boolean
  /** writes into the tab's terminal as if typed */
  write(tabId: string, data: string): void
  log: Pick<Logger, 'info'>
}

interface TabState {
  /** continues typed since the last turn that ended normally or the user's last key */
  tries: number
  /** a key since the turn started: the user's words may be in the prompt */
  typed: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export class AutoContinue {
  private readonly tabs = new Map<string, TabState>()

  constructor(private readonly d: AutoContinueDeps) {}

  /** UserPromptSubmit: the prompt went in, the input line is empty */
  turnStarted(tabId: string): void {
    this.state(tabId).typed = false
  }

  /** Stop */
  turnEnded(tabId: string): void {
    this.state(tabId).tries = 0
  }

  /** a key the user typed into the tab: a continue still waiting is cancelled */
  userInput(tabId: string): void {
    const s = this.state(tabId)
    s.typed = true
    s.tries = 0
    this.cancel(s)
  }

  /** StopFailure. True when the turn will be continued: then nobody needs to be called. */
  failed(tabId: string, error: string): boolean {
    if (!this.d.enabled() || error !== CUT_OFF_ERROR) return false
    const s = this.state(tabId)
    if (s.typed) return this.skip(tabId, 'the user typed into the tab during the turn')
    if (s.tries >= MAX_AUTO_CONTINUES) return this.skip(tabId, `${MAX_AUTO_CONTINUES} continues in a row`)
    s.tries++
    this.cancel(s)
    s.timer = setTimeout(() => {
      this.d.write(tabId, CONTINUE_PROMPT)
      s.timer = setTimeout(() => {
        s.timer = null
        this.d.write(tabId, '\r')
      }, ENTER_DELAY_MS)
    }, CONTINUE_DELAY_MS)
    this.d.log.info(`auto-continue tab=${tabId} try=${s.tries}/${MAX_AUTO_CONTINUES} in ${CONTINUE_DELAY_MS} ms`)
    return true
  }

  /** the tab closed or Claude left it */
  forget(tabId: string): void {
    const s = this.tabs.get(tabId)
    if (s) this.cancel(s)
    this.tabs.delete(tabId)
  }

  private skip(tabId: string, why: string): false {
    this.d.log.info(`auto-continue tab=${tabId}: not continued, ${why}`)
    return false
  }

  private cancel(s: TabState): void {
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
  }

  private state(tabId: string): TabState {
    let s = this.tabs.get(tabId)
    if (!s) {
      s = { tries: 0, typed: false, timer: null }
      this.tabs.set(tabId, s)
    }
    return s
  }
}
