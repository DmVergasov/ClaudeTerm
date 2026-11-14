import type { PromptState } from '../../shared/ipc'
import type { TabView } from '../../shared/chat'
import { ENTER_DELAY_MS } from '../auto-continue'
import type { Logger } from '../log'

/*
 * A task or a report waits for a session that no mail watcher is waiting to take it: its text is typed into the session's
 * prompt instead, once the session is idle and the prompt on screen is empty. A chat tab takes the text as one message; a
 * terminal tab takes it as a bracketed paste, and Enter follows on its own, as Send does.
 */

export interface PromptDeliveryDeps {
  /** the session the tab runs; null: none, or the session exited */
  session(tabId: string): string | null
  /** no turn, no continue armed */
  idle(tabId: string): boolean
  hasWatcher(tabId: string): boolean
  canTake(tabId: string, session: string): boolean
  /** the mail's text for the session, marked delivered: once it has returned, the text must be written */
  take(tabId: string, session: string): { info: string } | null
  promptState(tabId: string): Promise<PromptState>
  view(tabId: string): TabView | null
  /** writes into the tab's terminal as if typed */
  write(tabId: string, data: string): void
  /** time for the session to take input again, before a try */
  delayMs: number
  /** Enter's delay after a paste; ENTER_DELAY_MS when not given */
  enterDelayMs?: number
  /** a timer whose function cancels it; setTimeout when not given */
  later?(ms: number, fn: () => void): () => void
  log: Pick<Logger, 'info'>
}

interface TabState {
  /** cancels the armed try, if one is armed */
  cancelTry: (() => void) | null
  /** cancels the Enter that follows a paste, if one is pending */
  cancelEnter: (() => void) | null
  /** bumped by whatever stops a try under way, so one still waiting for the window's answer knows */
  run: number
}

/** a paste's text, with its line breaks as carriage returns, between the bracketed-paste markers */
export const bracketedPaste = (text: string): string => `\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`

export class PromptDelivery {
  private readonly tabs = new Map<string, TabState>()
  private readonly enterDelayMs: number
  private readonly later: (ms: number, fn: () => void) => () => void

  constructor(private readonly d: PromptDeliveryDeps) {
    this.enterDelayMs = d.enterDelayMs ?? ENTER_DELAY_MS
    this.later = d.later ?? ((ms, fn) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    })
  }

  /** the tab may have mail or a report to take: a try arms, unless one is armed already */
  poke(tabId: string): void {
    const s = this.state(tabId)
    if (s.cancelTry) return
    const run = s.run
    s.cancelTry = this.later(this.d.delayMs, () => {
      s.cancelTry = null
      void this.attempt(tabId, s, run)
    })
  }

  /** the tab closed or Claude left it: its armed try is cancelled, a pending Enter is not */
  forget(tabId: string): void {
    const s = this.tabs.get(tabId)
    if (!s) return
    this.cancelTry(s)
    if (s.cancelEnter === null) this.tabs.delete(tabId)
  }

  dispose(): void {
    for (const s of this.tabs.values()) {
      this.cancelTry(s)
      s.cancelEnter?.()
      s.cancelEnter = null
    }
    this.tabs.clear()
  }

  private async attempt(tabId: string, s: TabState, run: number): Promise<void> {
    const session = this.waitingSession(tabId)
    if (session === null) return
    const prompt = await this.d.promptState(tabId)
    // a turn, a watcher, the tab closing or a new poke while the window answered
    if (s.run !== run) return
    if (prompt !== 'empty') {
      this.d.log.info(`prompt delivery tab=${tabId}: not written, ${prompt === 'draft' ? "the prompt holds the user's text" : 'no prompt on screen'}`)
      return
    }
    // no await from here to the write: what take marks delivered must be written
    const again = this.waitingSession(tabId)
    if (again === null || again !== session) return
    const view = this.d.view(tabId)
    if (view === null) return
    const taken = this.d.take(tabId, session)
    if (taken === null) return
    if (view === 'chat') {
      this.d.write(tabId, taken.info)
      this.d.log.info(`prompt delivery tab=${tabId}: written as a message`)
      return
    }
    this.d.write(tabId, bracketedPaste(taken.info))
    this.d.log.info(`prompt delivery tab=${tabId}: pasted, Enter in ${this.enterDelayMs} ms`)
    s.cancelEnter = this.later(this.enterDelayMs, () => {
      s.cancelEnter = null
      this.d.write(tabId, '\r')
      if (this.tabs.get(tabId) === s && s.cancelTry === null) this.tabs.delete(tabId)
    })
  }

  /** the session a try may write for now: it runs one, is idle, has no watcher and has mail or a report to take */
  private waitingSession(tabId: string): string | null {
    const session = this.d.session(tabId)
    if (session === null || !this.d.idle(tabId) || this.d.hasWatcher(tabId)) return null
    return this.d.canTake(tabId, session) ? session : null
  }

  private cancelTry(s: TabState): void {
    s.cancelTry?.()
    s.cancelTry = null
    s.run++
  }

  private state(tabId: string): TabState {
    let s = this.tabs.get(tabId)
    if (!s) {
      s = { cancelTry: null, cancelEnter: null, run: 0 }
      this.tabs.set(tabId, s)
    }
    return s
  }
}
