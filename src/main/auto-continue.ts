import type { PromptState } from '../shared/ipc'
import { MAX_AUTO_CONTINUES } from '../shared/settings-keys'
import type { MainStatus } from '../shared/types'
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
/**
 * for a turn that had ended while work Claude left in the background (agents, background commands) still ran when
 * ClaudeTerm closed: that work stopped with it, and nothing will wake the restored conversation
 */
export const BACKGROUND_PROMPT = 'The terminal closed while work you had left running in the background (agents, background commands) was still going, and it stopped with the terminal. Check what of it finished, start again what did not, and go on - no apology, no recap.'
/** what ClaudeTerm's closing cut off in a restored tab: a turn under way, or the background work a finished turn left */
export type RestoreCut = 'turn' | 'background'
/** the StopFailure error of a turn the usage limit stopped (Claude Code's rate_limit) */
export const LIMIT_ERROR = 'rate_limit'
/** typed into a tab whose turn the usage limit stopped, once the limit has reset */
export const LIMIT_PROMPT = 'The usage limit has reset. Go on from where you stopped - no apology, no recap.'
/** after a limit's reset time, before its nudge: the reset is not always in effect at the second it names */
export const LIMIT_MARGIN_MS = 60_000
/**
 * When the usage limit that stopped a turn resets, in ms: of the tab's limits used up (100%) whose reset is to come, the later
 * one, as both must have reset for Claude to go on; null when the status shows none
 */
export function limitResetOf(main: Pick<MainStatus, 'fiveHour' | 'sevenDay'> | null, now: number): number | null {
  const resets = [main?.fiveHour, main?.sevenDay]
    .filter((l): l is { usedPct: number; resetsAt: number } => l !== null && l !== undefined && l.usedPct >= 100 && l.resetsAt * 1000 > now)
    .map((l) => l.resetsAt * 1000)
  return resets.length === 0 ? null : Math.max(...resets)
}
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
  /** a turn the usage limit stopped: it goes on once the limit has reset (claude.continueAfterLimit) */
  limit: {
    enabled(): boolean
    /** when the tab's used-up limit resets, in ms; null when it is not known */
    resetsAt(tabId: string): number | null
    now(): number
    /** the tab waits for its limit to reset (the reset time), or no longer does (null) */
    waiting(tabId: string, at: number | null): void
    /** the wait after the reset; LIMIT_MARGIN_MS when not given (a test gives a short one) */
    marginMs?: number
  }
}

interface TabState {
  /** continues typed since the last turn that ended normally or the user's last key */
  tries: number
  timer: ReturnType<typeof setTimeout> | null
  /** bumped by whatever stops a continue under way, so one still waiting for the window's answer knows */
  run: number
  /** the reset time the tab waits for, while it waits for its usage limit to reset */
  limitAt: number | null
}

export class AutoContinue {
  private readonly tabs = new Map<string, TabState>()

  constructor(private readonly d: AutoContinueDeps) {}

  /** UserPromptSubmit: a turn that starts during the pause (a queued message Claude Code sent) goes on without the nudge */
  turnStarted(tabId: string): void {
    this.cancel(tabId, this.state(tabId))
  }

  /** Stop */
  turnEnded(tabId: string): void {
    this.state(tabId).tries = 0
  }

  /** a key the user typed into the tab: they are at it, and a continue still waiting is cancelled */
  userInput(tabId: string): void {
    const s = this.state(tabId)
    s.tries = 0
    this.cancel(tabId, s)
  }

  /** StopFailure. True when the turn will be continued, or given up later with notify: nobody needs to be called now. */
  failed(tabId: string, error: string): boolean {
    if (error === LIMIT_ERROR) return this.afterLimit(tabId)
    if (!this.d.enabled() || error !== CUT_OFF_ERROR) return false
    const s = this.state(tabId)
    if (s.tries >= MAX_AUTO_CONTINUES) return this.skip(tabId, `${MAX_AUTO_CONTINUES} continues in a row`)
    s.tries++
    this.cancel(tabId, s)
    const run = s.run
    s.timer = setTimeout(() => {
      s.timer = null
      void this.type(tabId, s, run, CONTINUE_PROMPT)
    }, CONTINUE_DELAY_MS)
    this.d.log.info(`auto-continue tab=${tabId} try=${s.tries}/${MAX_AUTO_CONTINUES} in ${CONTINUE_DELAY_MS} ms`)
    return true
  }

  /**
   * A restored tab's session started again (SessionStart) after ClaudeTerm closed in the middle of its turn (`turn`), or
   * while work Claude left in the background still ran (`background`): Claude goes on once the prompt is empty, as a
   * cut-off response does, and the tab calls the user when it is not
   */
  resumed(tabId: string, cut: RestoreCut = 'turn'): void {
    const s = this.state(tabId)
    this.cancel(tabId, s)
    const run = s.run
    s.timer = setTimeout(() => {
      s.timer = null
      void this.type(tabId, s, run, cut === 'background' ? BACKGROUND_PROMPT : RESUME_PROMPT)
    }, CONTINUE_DELAY_MS)
    this.d.log.info(`continue after restore tab=${tabId} (${cut}) in ${CONTINUE_DELAY_MS} ms`)
  }

  /**
   * A turn the usage limit stopped: the tab waits for the limit to reset, and a little after it Claude goes on, as a cut-off
   * response does. Without the setting, or a reset time still to come, the tab calls the user as before.
   */
  private afterLimit(tabId: string): boolean {
    const at = this.d.limit.resetsAt(tabId)
    if (!this.d.limit.enabled()) return this.skip(tabId, 'claude.continueAfterLimit is off')
    if (at === null || at <= this.d.limit.now()) return this.skip(tabId, 'no reset time of the limit to wait for')
    const s = this.state(tabId)
    this.cancel(tabId, s)
    const run = s.run
    s.limitAt = at
    const margin = this.d.limit.marginMs ?? LIMIT_MARGIN_MS
    s.timer = setTimeout(() => {
      s.timer = null
      this.endWait(tabId, s)
      void this.type(tabId, s, run, LIMIT_PROMPT)
    }, at - this.d.limit.now() + margin)
    this.d.limit.waiting(tabId, at)
    this.d.log.info(`continue after the usage limit tab=${tabId} at ${new Date(at + margin).toISOString()}`)
    return true
  }

  /** the tab closed or Claude left it */
  forget(tabId: string): void {
    const s = this.tabs.get(tabId)
    if (s) this.cancel(tabId, s)
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

  private cancel(tabId: string, s: TabState): void {
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
    s.run++
    this.endWait(tabId, s)
  }

  /** a wait for the limit's reset is over: it came, or something ended the wait */
  private endWait(tabId: string, s: TabState): void {
    if (s.limitAt === null) return
    s.limitAt = null
    this.d.limit.waiting(tabId, null)
  }

  private state(tabId: string): TabState {
    let s = this.tabs.get(tabId)
    if (!s) {
      s = { tries: 0, timer: null, run: 0, limitAt: null }
      this.tabs.set(tabId, s)
    }
    return s
  }
}
