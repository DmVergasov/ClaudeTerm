import type { PromptState } from '../shared/ipc'
import { MAX_AUTO_CONTINUES } from '../shared/settings-keys'
import type { Logger } from './log'

/*
 * Claude Code ends an interactive turn whose response was cut off mid-stream (a connection lost, a stream that stopped
 * arriving) and waits for the user; only subagents and claude -p are nudged to go on by Claude Code itself. Such a turn
 * reports StopFailure with error server_error. With claude.autoContinue on, ClaudeTerm types the nudge Claude Code
 * would send into the tab instead of calling the user, unless the user's own text waits in the prompt: right before it
 * types, it asks the window what Claude Code's prompt holds on screen. With claude.continueAfterRestore on, a tab restored
 * with a turn ClaudeTerm's closing cut off gets the same kind of nudge once its session has started again.
 */

/** the words Claude Code itself sends a subagent whose response was cut off mid-stream */
export const CONTINUE_PROMPT = 'Your response above was cut off mid-stream. Resume directly from where it stops - no apology, no recap. If none of it survived, answer the request from the start.'
/** the StopFailure error of a response cut off mid-stream, also of a server error the retries did not get past */
export const CUT_OFF_ERROR = 'server_error'
/** for a turn that was still running when ClaudeTerm closed, typed into the tab restored with its conversation */
export const RESUME_PROMPT = 'Your previous turn was cut off when the terminal closed. Resume directly from where it stops - no apology, no recap.'
/** time for Claude Code to take input again, and for a dropped connection to come back */
export const CONTINUE_DELAY_MS = 5000
/** Enter goes on its own after the text, as Send does: in the same write it would be part of a paste */
export const ENTER_DELAY_MS = 50

export interface AutoContinueDeps {
  enabled(): boolean
  /** what Claude Code's prompt in the tab holds now, read from the terminal's screen */
  promptState(tabId: string): Promise<PromptState>
  /** writes into the tab's terminal as if typed */
  write(tabId: string, data: string): void
  /** a continue given up when it was due: the tab gives the signals of a finished answer after all */
  notify(tabId: string): void
  log: Pick<Logger, 'info'>
}

interface TabState {
  /** continues typed since the last turn that ended normally or the user's last key */
  tries: number
  timer: ReturnType<typeof setTimeout> | null
  /** bumped by whatever stops a continue under way, so one still waiting for the window's answer knows */
  run: number
}

export class AutoContinue {
  private readonly tabs = new Map<string, TabState>()

  constructor(private readonly d: AutoContinueDeps) {}

  /** UserPromptSubmit: a turn that starts during the pause (a queued message Claude Code sent) goes on without the nudge */
  turnStarted(tabId: string): void {
    this.cancel(this.state(tabId))
  }

  /** Stop */
  turnEnded(tabId: string): void {
    this.state(tabId).tries = 0
  }

  /** a key the user typed into the tab: they are at it, and a continue still waiting is cancelled */
  userInput(tabId: string): void {
    const s = this.state(tabId)
    s.tries = 0
    this.cancel(s)
  }

  /** StopFailure. True when the turn will be continued, or given up later with notify: nobody needs to be called now. */
  failed(tabId: string, error: string): boolean {
    if (!this.d.enabled() || error !== CUT_OFF_ERROR) return false
    const s = this.state(tabId)
    if (s.tries >= MAX_AUTO_CONTINUES) return this.skip(tabId, `${MAX_AUTO_CONTINUES} continues in a row`)
    s.tries++
    this.cancel(s)
    const run = s.run
    s.timer = setTimeout(() => {
      s.timer = null
      void this.type(tabId, s, run, CONTINUE_PROMPT)
    }, CONTINUE_DELAY_MS)
    this.d.log.info(`auto-continue tab=${tabId} try=${s.tries}/${MAX_AUTO_CONTINUES} in ${CONTINUE_DELAY_MS} ms`)
    return true
  }

  /**
   * A restored tab's session started again (SessionStart) after ClaudeTerm closed in the middle of its turn: the turn goes on
   * once the prompt is empty, as a cut-off response does, and the tab calls the user when it is not
   */
  resumed(tabId: string): void {
    const s = this.state(tabId)
    this.cancel(s)
    const run = s.run
    s.timer = setTimeout(() => {
      s.timer = null
      void this.type(tabId, s, run, RESUME_PROMPT)
    }, CONTINUE_DELAY_MS)
    this.d.log.info(`continue after restore tab=${tabId} in ${CONTINUE_DELAY_MS} ms`)
  }

  /** the tab closed or Claude left it */
  forget(tabId: string): void {
    const s = this.tabs.get(tabId)
    if (s) this.cancel(s)
    this.tabs.delete(tabId)
  }

  private async type(tabId: string, s: TabState, run: number, text: string): Promise<void> {
    const prompt = await this.d.promptState(tabId)
    // a key, a new turn or the tab closing while the window answered
    if (this.tabs.get(tabId) !== s || s.run !== run) return
    if (prompt !== 'empty') {
      this.skip(tabId, prompt === 'draft' ? "the prompt holds the user's text" : 'no prompt on screen')
      this.d.notify(tabId)
      return
    }
    this.d.write(tabId, text)
    s.timer = setTimeout(() => {
      s.timer = null
      this.d.write(tabId, '\r')
    }, ENTER_DELAY_MS)
  }

  private skip(tabId: string, why: string): false {
    this.d.log.info(`auto-continue tab=${tabId}: not continued, ${why}`)
    return false
  }

  private cancel(s: TabState): void {
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
    s.run++
  }

  private state(tabId: string): TabState {
    let s = this.tabs.get(tabId)
    if (!s) {
      s = { tries: 0, timer: null, run: 0 }
      this.tabs.set(tabId, s)
    }
    return s
  }
}
