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
  log: Pick<Logger, 'info' | 'warn'>
}

interface TabState {
  /** cancels the armed try, while it waits for its delay */
  cancelTry: (() => void) | null
  /** a try has fired and has not ended: it waits for the window, or for the Enter of its paste */
  busy: boolean
  /** a poke came while a try was busy: one more try is armed when it ends */
  again: boolean
  /** cancels the Enter that follows a paste, while it is pending */
  cancelEnter: (() => void) | null
  /** bumped by whatever stops a try under way, so one still waiting for the window's answer knows */
  run: number
}

/** a paste's text, with its line breaks as carriage returns, between the bracketed-paste markers */
export const bracketedPaste = (text: string): string => `\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~`

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

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

  /** the tab may have mail or a report to take: a try arms, unless one is armed or running already */
  poke(tabId: string): void {
    const s = this.state(tabId)
    if (s.busy) s.again = true
    else this.arm(tabId, s)
  }

  /** the tab closed or Claude left it: its armed try is cancelled, a pending Enter is not */
  forget(tabId: string): void {
    const s = this.tabs.get(tabId)
    if (!s) return
    this.disarm(s)
    s.again = false
    // a paste already written keeps its try until its Enter
    if (s.cancelEnter === null) s.busy = false
    this.prune(tabId, s)
  }

  dispose(): void {
    for (const s of this.tabs.values()) {
      this.disarm(s)
      s.cancelEnter?.()
      s.cancelEnter = null
      s.busy = false
      s.again = false
    }
    this.tabs.clear()
  }

  private arm(tabId: string, s: TabState): void {
    if (s.cancelTry) return
    const run = s.run
    s.cancelTry = this.later(this.d.delayMs, () => {
      s.cancelTry = null
      s.busy = true
      this.attempt(tabId, s, run).catch((err: unknown) => {
        this.d.log.warn(`prompt delivery tab=${tabId}: a try failed: ${reasonOf(err)}`)
        this.end(tabId, s, run)
      })
    })
  }

  private async attempt(tabId: string, s: TabState, run: number): Promise<void> {
    const session = this.waitingSession(tabId)
    if (session === null) return this.end(tabId, s, run)
    const prompt = await this.d.promptState(tabId)
    // a turn, a watcher, the tab closing or a forget while the window answered
    if (s.run !== run) return
    if (prompt !== 'empty') {
      this.d.log.info(`prompt delivery tab=${tabId}: not written, ${prompt === 'draft' ? "the prompt holds the user's text" : 'no prompt on screen'}`)
      return this.end(tabId, s, run)
    }
    // no await from here to the write: what take marks delivered must be written
    const again = this.waitingSession(tabId)
    const view = this.d.view(tabId)
    if (again !== session || view === null) return this.end(tabId, s, run)
    const taken = this.d.take(tabId, session)
    if (taken === null) return this.end(tabId, s, run)
    if (view === 'chat') {
      this.write(tabId, taken.info, 'as a message')
      return this.end(tabId, s, run)
    }
    if (!this.write(tabId, bracketedPaste(taken.info), 'as a paste')) return this.end(tabId, s, run)
    this.d.log.info(`prompt delivery tab=${tabId}: pasted, Enter in ${this.enterDelayMs} ms`)
    s.cancelEnter = this.later(this.enterDelayMs, () => this.enter(tabId, s))
  }

  /** writes the taken text; a failed write is logged, the text is then lost as Claude never gets it */
  private write(tabId: string, data: string, how: string): boolean {
    try {
      this.d.write(tabId, data)
      this.d.log.info(`prompt delivery tab=${tabId}: written ${how}`)
      return true
    } catch (err) {
      this.d.log.warn(`prompt delivery tab=${tabId}: a taken text was not written: ${reasonOf(err)}`)
      return false
    }
  }

  /** a paste's Enter: the paste's try ends with it */
  private enter(tabId: string, s: TabState): void {
    s.cancelEnter = null
    try {
      this.d.write(tabId, '\r')
    } catch (err) {
      this.d.log.warn(`prompt delivery tab=${tabId}: Enter not written: ${reasonOf(err)}`)
    }
    s.busy = false
    this.next(tabId, s)
  }

  /** a try ends; a stale try (forgotten or disposed since) changes nothing */
  private end(tabId: string, s: TabState, run: number): void {
    if (s.run !== run) return
    s.busy = false
    this.next(tabId, s)
  }

  /** after a try: a poke that came meanwhile arms one new try */
  private next(tabId: string, s: TabState): void {
    if (s.again) {
      s.again = false
      this.arm(tabId, s)
    }
    this.prune(tabId, s)
  }

  /** the session a try may write for now: it runs one, is idle, has no watcher and has mail or a report to take */
  private waitingSession(tabId: string): string | null {
    const session = this.d.session(tabId)
    if (session === null || !this.d.idle(tabId) || this.d.hasWatcher(tabId)) return null
    return this.d.canTake(tabId, session) ? session : null
  }

  private disarm(s: TabState): void {
    s.cancelTry?.()
    s.cancelTry = null
    s.run++
  }

  private prune(tabId: string, s: TabState): void {
    if (!s.busy && s.cancelTry === null && s.cancelEnter === null && this.tabs.get(tabId) === s) this.tabs.delete(tabId)
  }

  private state(tabId: string): TabState {
    let s = this.tabs.get(tabId)
    if (!s) {
      s = { cancelTry: null, busy: false, again: false, cancelEnter: null, run: 0 }
      this.tabs.set(tabId, s)
    }
    return s
  }
}
