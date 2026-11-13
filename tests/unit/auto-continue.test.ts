import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutoContinue, BACKGROUND_PROMPT, CONTINUE_DELAY_MS, CONTINUE_PROMPT, ENTER_DELAY_MS, LIMIT_ERROR, LIMIT_MARGIN_MS, LIMIT_PROMPT, RESUME_PROMPT, limitResetOf } from '../../src/main/auto-continue'
import type { PromptState } from '../../src/shared/ipc'
import { MAX_AUTO_CONTINUES as MAX_CONTINUES } from '../../src/shared/settings-keys'

const CUT_OFF = 'server_error'

function setup(enabled = true) {
  const state = { enabled, prompt: 'empty' as PromptState, afterLimit: true, resetsAt: null as number | null }
  const writes: string[] = []
  const notified: string[] = []
  const asked: string[] = []
  const logs: string[] = []
  const waits: string[] = []
  /** when each wait said Claude goes on */
  const goesOn: number[] = []
  const ac = new AutoContinue({
    enabled: () => state.enabled,
    promptState: async (tabId) => {
      asked.push(tabId)
      return state.prompt
    },
    write: (tabId, data) => writes.push(`${tabId}:${data}`),
    notify: (tabId) => notified.push(tabId),
    log: { info: (m) => logs.push(m) },
    limit: {
      enabled: () => state.afterLimit,
      resetsAt: () => state.resetsAt,
      now: () => Date.now(),
      waiting: (tabId, wait) => {
        waits.push(`${tabId}:${wait?.resetsAt ?? 'none'}`)
        if (wait) goesOn.push(wait.goesOnAt)
      }
    }
  })
  return { ac, writes, notified, asked, logs, state, waits, goesOn }
}

/** the text, then Enter on its own */
const typed = (tabId: string): string[] => [`${tabId}:${CONTINUE_PROMPT}`, `${tabId}:\r`]
const runAll = (): Promise<void> => vi.runAllTimersAsync().then(() => undefined)

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('AutoContinue', () => {
  it('a restored tab whose turn was cut off goes on after the pause with its own nudge, whatever claude.autoContinue says', async () => {
    const { ac, writes, notified } = setup(false)
    ac.resumed('t1')
    await vi.advanceTimersByTimeAsync(CONTINUE_DELAY_MS - 1)
    expect(writes).toEqual([])
    await runAll()
    expect(writes).toEqual([`t1:${RESUME_PROMPT}`, 't1:\r'])
    expect(notified).toEqual([])
  })

  it('a restored tab whose turn had ended while its background work ran is told that work stopped, after the same pause', async () => {
    const { ac, writes, notified } = setup(false)
    ac.resumed('t1', 'background')
    await vi.advanceTimersByTimeAsync(CONTINUE_DELAY_MS - 1)
    expect(writes).toEqual([])
    await runAll()
    expect(writes).toEqual([`t1:${BACKGROUND_PROMPT}`, 't1:\r'])
    expect(notified).toEqual([])
  })

  it('a restored tab with the user\'s text in its prompt, or no prompt, gets nothing typed and calls the user; a key first cancels it', async () => {
    const { ac, writes, notified, state } = setup()
    state.prompt = 'draft'
    ac.resumed('t1')
    await runAll()
    state.prompt = 'none'
    ac.resumed('t2')
    await runAll()
    expect(writes).toEqual([])
    expect(notified).toEqual(['t1', 't2'])
    state.prompt = 'empty'
    ac.resumed('t3')
    ac.userInput('t3')
    await runAll()
    expect(writes).toEqual([])
  })

  it('after a pause asks what the prompt holds; with nothing in it types the nudge, then Enter on its own', async () => {
    const { ac, writes, asked, notified } = setup()
    ac.turnStarted('t1')
    expect(ac.failed('t1', CUT_OFF)).toBe(true)
    await vi.advanceTimersByTimeAsync(CONTINUE_DELAY_MS - 1)
    expect(asked).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(asked).toEqual(['t1'])
    expect(writes).toEqual([`t1:${CONTINUE_PROMPT}`])
    await vi.advanceTimersByTimeAsync(ENTER_DELAY_MS)
    expect(writes).toEqual(typed('t1'))
    expect(notified).toEqual([])
  })

  it('leaves the turn to the user when the setting is off or the error is not a cut-off response', async () => {
    const { ac, writes, state } = setup(false)
    expect(ac.failed('t1', CUT_OFF)).toBe(false)
    state.enabled = true
    expect(ac.failed('t1', 'rate_limit')).toBe(false)
    expect(ac.failed('t1', 'authentication_failed')).toBe(false)
    await runAll()
    expect(writes).toEqual([])
  })

  it('keys the user pressed during the turn, answering Claude\'s question or a permission, do not stop it', async () => {
    const { ac, writes } = setup()
    ac.turnStarted('t1')
    ac.userInput('t1')
    ac.userInput('t1')
    expect(ac.failed('t1', CUT_OFF)).toBe(true)
    await runAll()
    expect(writes).toEqual(typed('t1'))
  })

  it('a prompt that holds the user\'s text is left alone, and the tab calls the user after all', async () => {
    const { ac, writes, notified, logs, state } = setup()
    state.prompt = 'draft'
    expect(ac.failed('t1', CUT_OFF)).toBe(true)
    await runAll()
    expect(writes).toEqual([])
    expect(notified).toEqual(['t1'])
    expect(logs.at(-1)).toMatch(/not continued, the prompt holds the user's text/)
  })

  it('without a prompt on screen (a dialog, no answer from the window) nothing is typed and the tab calls the user', async () => {
    const { ac, writes, notified, logs, state } = setup()
    state.prompt = 'none'
    ac.failed('t1', CUT_OFF)
    await runAll()
    expect(writes).toEqual([])
    expect(notified).toEqual(['t1'])
    expect(logs.at(-1)).toMatch(/not continued, no prompt on screen/)
  })

  it(`continues at most ${MAX_CONTINUES} times in a row, then leaves it to the user`, async () => {
    const { ac, writes, logs } = setup()
    for (let i = 0; i < MAX_CONTINUES; i++) {
      expect(ac.failed('t1', CUT_OFF)).toBe(true)
      await runAll()
      ac.turnStarted('t1')
    }
    expect(ac.failed('t1', CUT_OFF)).toBe(false)
    await runAll()
    expect(writes).toHaveLength(MAX_CONTINUES * 2)
    expect(logs.at(-1)).toMatch(/not continued.*in a row/)
  })

  it('counts again from zero after a turn that ends normally, and after a key', async () => {
    const { ac, writes } = setup()
    for (let i = 0; i < MAX_CONTINUES; i++) {
      ac.failed('t1', CUT_OFF)
      await runAll()
      ac.turnStarted('t1')
    }
    ac.turnEnded('t1')
    expect(ac.failed('t1', CUT_OFF)).toBe(true)
    await runAll()
    for (let i = 1; i < MAX_CONTINUES; i++) {
      ac.failed('t1', CUT_OFF)
      await runAll()
    }
    ac.userInput('t1')
    expect(ac.failed('t1', CUT_OFF)).toBe(true)
    await runAll()
    expect(writes).toHaveLength((2 * MAX_CONTINUES + 1) * 2)
  })

  it('a key during the pause cancels the continue: the user is at the tab', async () => {
    const { ac, writes, asked, notified } = setup()
    ac.failed('t1', CUT_OFF)
    await vi.advanceTimersByTimeAsync(CONTINUE_DELAY_MS - 1)
    ac.userInput('t1')
    await runAll()
    expect(asked).toEqual([])
    expect(writes).toEqual([])
    expect(notified).toEqual([])
  })

  it('a turn that starts during the pause (a queued message Claude Code sent) goes on without the nudge', async () => {
    const { ac, writes } = setup()
    ac.failed('t1', CUT_OFF)
    await vi.advanceTimersByTimeAsync(CONTINUE_DELAY_MS / 2)
    ac.turnStarted('t1')
    await runAll()
    expect(writes).toEqual([])
  })

  it('a key, a new turn or the tab closing while the window is asked stops it too', async () => {
    for (const stop of ['userInput', 'turnStarted', 'forget'] as const) {
      const writes: string[] = []
      const notified: string[] = []
      let answer: (s: PromptState) => void = () => {}
      const ac = new AutoContinue({
        enabled: () => true,
        promptState: () => new Promise((r) => { answer = r }),
        write: (tabId, data) => writes.push(`${tabId}:${data}`),
        notify: (tabId) => notified.push(tabId),
        log: { info: () => {} },
        limit: { enabled: () => true, resetsAt: () => null, now: () => Date.now(), waiting: () => {} }
      })
      ac.failed('t1', CUT_OFF)
      await vi.advanceTimersByTimeAsync(CONTINUE_DELAY_MS)
      ac[stop]('t1')
      answer('empty')
      await runAll()
      expect(writes, stop).toEqual([])
      expect(notified, stop).toEqual([])
    }
  })

  it('a key typed between the text and Enter keeps the Enter back: the prompt is the user\'s now', async () => {
    const { ac, writes } = setup()
    ac.failed('t1', CUT_OFF)
    await vi.advanceTimersByTimeAsync(CONTINUE_DELAY_MS)
    ac.userInput('t1')
    await runAll()
    expect(writes).toEqual([`t1:${CONTINUE_PROMPT}`])
  })

  it('forgetting a tab cancels its continue', async () => {
    const { ac, writes } = setup()
    ac.failed('t1', CUT_OFF)
    ac.forget('t1')
    await runAll()
    expect(writes).toEqual([])
  })

  it('keeps tabs apart', async () => {
    const { ac, writes } = setup()
    ac.failed('t1', CUT_OFF)
    ac.failed('t2', CUT_OFF)
    ac.userInput('t2')
    await runAll()
    expect(writes).toEqual(typed('t1'))
  })
})

describe('limitResetOf', () => {
  const NOW = 1_800_000_000_000
  const at = (ms: number): number => (NOW + ms) / 1000

  it('the reset of a used-up limit; with both used up, the later one', () => {
    expect(limitResetOf({ fiveHour: { usedPct: 100, resetsAt: at(3600_000) }, sevenDay: { usedPct: 40, resetsAt: at(86_400_000) } }, NOW)).toBe(NOW + 3600_000)
    expect(limitResetOf({ fiveHour: { usedPct: 100, resetsAt: at(3600_000) }, sevenDay: { usedPct: 100, resetsAt: at(86_400_000) } }, NOW)).toBe(NOW + 86_400_000)
  })

  it('none while no limit is used up, its reset has passed, or there is no status', () => {
    expect(limitResetOf({ fiveHour: { usedPct: 99, resetsAt: at(3600_000) }, sevenDay: null }, NOW)).toBeNull()
    expect(limitResetOf({ fiveHour: { usedPct: 100, resetsAt: at(-1000) }, sevenDay: null }, NOW)).toBeNull()
    expect(limitResetOf(null, NOW)).toBeNull()
  })
})

describe('AutoContinue after a usage limit', () => {
  const HOUR = 60 * 60 * 1000

  it('a turn the usage limit stopped goes on with its own nudge once the limit has reset, and nobody is called meanwhile', async () => {
    const { ac, writes, notified, state, waits, goesOn } = setup(false)
    state.resetsAt = Date.now() + 2 * HOUR
    // claude.autoContinue (a cut-off response) is off: the limit has a setting of its own
    expect(ac.failed('t1', LIMIT_ERROR)).toBe(true)
    expect(waits).toEqual([`t1:${state.resetsAt}`])
    // the wait says when Claude goes on: the margin after the reset
    expect(goesOn).toEqual([state.resetsAt! + LIMIT_MARGIN_MS])
    await vi.advanceTimersByTimeAsync(2 * HOUR + LIMIT_MARGIN_MS - 1)
    expect(writes).toEqual([])
    await runAll()
    expect(writes).toEqual([`t1:${LIMIT_PROMPT}`, 't1:\r'])
    expect(notified).toEqual([])
    expect(waits).toEqual([`t1:${state.resetsAt}`, 't1:none'])
  })

  it('with the setting off, no reset time, or a reset time already past, the limit calls the user as before', () => {
    const { ac, state, waits } = setup()
    state.afterLimit = false
    state.resetsAt = Date.now() + HOUR
    expect(ac.failed('t1', LIMIT_ERROR)).toBe(false)
    state.afterLimit = true
    state.resetsAt = null
    expect(ac.failed('t1', LIMIT_ERROR)).toBe(false)
    state.resetsAt = Date.now() - 1000
    expect(ac.failed('t1', LIMIT_ERROR)).toBe(false)
    expect(waits).toEqual([])
  })

  it('a message the person sends, or a key, while it waits ends the wait: nothing is typed at the reset', async () => {
    const { ac, writes, state, waits } = setup()
    state.resetsAt = Date.now() + HOUR
    ac.failed('t1', LIMIT_ERROR)
    ac.failed('t2', LIMIT_ERROR)
    ac.turnStarted('t1')
    ac.userInput('t2')
    await runAll()
    expect(writes).toEqual([])
    expect(waits).toEqual([`t1:${state.resetsAt}`, `t2:${state.resetsAt}`, 't1:none', 't2:none'])
  })

  it("the person's text in the prompt at the reset holds the nudge back, and the tab calls them", async () => {
    const { ac, writes, notified, state } = setup()
    state.resetsAt = Date.now() + HOUR
    ac.failed('t1', LIMIT_ERROR)
    state.prompt = 'draft'
    await runAll()
    expect(writes).toEqual([])
    expect(notified).toEqual(['t1'])
  })

  it('a tab that closes while it waits ends its wait', async () => {
    const { ac, writes, state, waits } = setup()
    state.resetsAt = Date.now() + HOUR
    ac.failed('t1', LIMIT_ERROR)
    ac.forget('t1')
    await runAll()
    expect(writes).toEqual([])
    expect(waits).toEqual([`t1:${state.resetsAt}`, 't1:none'])
  })
})
