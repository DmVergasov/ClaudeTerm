import { PROMPT_STATES, type PromptState } from '../shared/ipc'

/** the window answers at once; one that does not is closing or stuck */
export const PROMPT_QUERY_TIMEOUT_MS = 1000

export interface PromptQueryDeps {
  /** sends the query to the window; false when there is none */
  send(queryId: number, tabId: string): boolean
}

/**
 * Asks the window what Claude Code's prompt in a tab holds: only the window has the terminal's screen, main has the bytes.
 * No window, a late answer or a bad one all mean 'none': no prompt to type into.
 */
export class PromptQueries {
  private next = 1
  private readonly pending = new Map<number, (state: PromptState) => void>()

  constructor(private readonly d: PromptQueryDeps) {}

  ask(tabId: string): Promise<PromptState> {
    const queryId = this.next++
    return new Promise((resolve) => {
      const done = (state: PromptState): void => {
        clearTimeout(timer)
        this.pending.delete(queryId)
        resolve(state)
      }
      const timer = setTimeout(() => done('none'), PROMPT_QUERY_TIMEOUT_MS)
      this.pending.set(queryId, done)
      if (!this.d.send(queryId, tabId)) done('none')
    })
  }

  /** the window's answer; anything but an answer to a query still waiting is ignored */
  answer(queryId: unknown, state: unknown): void {
    if (typeof queryId !== 'number' || !PROMPT_STATES.includes(state as PromptState)) return
    this.pending.get(queryId)?.(state as PromptState)
  }
}
