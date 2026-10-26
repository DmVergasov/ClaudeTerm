import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutoContinue, CONTINUE_DELAY_MS, CONTINUE_PROMPT, ENTER_DELAY_MS } from '../../src/main/auto-continue'
import { MAX_AUTO_CONTINUES as MAX_CONTINUES } from '../../src/shared/settings-keys'

const CUT_OFF = 'server_error'

function setup(enabled = true) {
  const state = { enabled }
  const writes: string[] = []
  const logs: string[] = []
  const ac = new AutoContinue({
    enabled: () => state.enabled,
    write: (tabId, data) => writes.push(`${tabId}:${data}`),
    log: { info: (m) => logs.push(m) }
  })
  return { ac, writes, logs, state }
}

/** the text, then Enter on its own */
const typed = (tabId: string): string[] => [`${tabId}:${CONTINUE_PROMPT}`, `${tabId}:\r`]

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('AutoContinue', () => {
  it('types the continue prompt into the tab after a pause, then Enter on its own', () => {
    const { ac, writes } = setup()
    ac.turnStarted('t1')
    expect(ac.failed('t1', CUT_OFF)).toBe(true)
    vi.advanceTimersByTime(CONTINUE_DELAY_MS - 1)
    expect(writes).toEqual([])
    vi.advanceTimersByTime(1)
    expect(writes).toEqual([`t1:${CONTINUE_PROMPT}`])
    vi.advanceTimersByTime(ENTER_DELAY_MS)
    expect(writes).toEqual(typed('t1'))
  })

  it('leaves the turn to the user when the setting is off or the error is not a cut-off response', () => {
    const { ac, writes, state } = setup(false)
    expect(ac.failed('t1', CUT_OFF)).toBe(false)
    state.enabled = true
    expect(ac.failed('t1', 'rate_limit')).toBe(false)
    expect(ac.failed('t1', 'authentication_failed')).toBe(false)
    vi.runAllTimers()
    expect(writes).toEqual([])
  })

  it(`continues at most ${MAX_CONTINUES} times in a row, then leaves it to the user`, () => {
    const { ac, writes, logs } = setup()
    for (let i = 0; i < MAX_CONTINUES; i++) {
      expect(ac.failed('t1', CUT_OFF)).toBe(true)
      vi.runAllTimers()
      ac.turnStarted('t1')
    }
    expect(ac.failed('t1', CUT_OFF)).toBe(false)
    vi.runAllTimers()
    expect(writes).toHaveLength(MAX_CONTINUES * 2)
    expect(logs.at(-1)).toMatch(/not continued.*in a row/)
  })

  it('counts again from zero after a turn that ends normally', () => {
    const { ac, writes } = setup()
    for (let i = 0; i < MAX_CONTINUES; i++) {
      ac.failed('t1', CUT_OFF)
      vi.runAllTimers()
      ac.turnStarted('t1')
    }
    ac.turnEnded('t1')
    ac.turnStarted('t1')
    expect(ac.failed('t1', CUT_OFF)).toBe(true)
    vi.runAllTimers()
    expect(writes).toHaveLength((MAX_CONTINUES + 1) * 2)
  })

  it('counts again from zero when the user types into the tab', () => {
    const { ac } = setup()
    for (let i = 0; i < MAX_CONTINUES; i++) {
      ac.failed('t1', CUT_OFF)
      vi.runAllTimers()
      ac.turnStarted('t1')
    }
    ac.userInput('t1')
    ac.turnStarted('t1')
    expect(ac.failed('t1', CUT_OFF)).toBe(true)
  })

  it('does not continue a turn the user typed into after it started: their words may be in the prompt', () => {
    const { ac, writes, logs } = setup()
    ac.userInput('t1')
    ac.turnStarted('t1')
    ac.userInput('t1')
    expect(ac.failed('t1', CUT_OFF)).toBe(false)
    vi.runAllTimers()
    expect(writes).toEqual([])
    expect(logs.at(-1)).toMatch(/not continued.*typed/)
  })

  it('a key typed during the pause cancels the continue', () => {
    const { ac, writes } = setup()
    ac.turnStarted('t1')
    ac.failed('t1', CUT_OFF)
    vi.advanceTimersByTime(CONTINUE_DELAY_MS - 1)
    ac.userInput('t1')
    vi.runAllTimers()
    expect(writes).toEqual([])
  })

  it('a key typed between the text and Enter keeps the Enter back: the prompt is the user\'s now', () => {
    const { ac, writes } = setup()
    ac.turnStarted('t1')
    ac.failed('t1', CUT_OFF)
    vi.advanceTimersByTime(CONTINUE_DELAY_MS)
    ac.userInput('t1')
    vi.runAllTimers()
    expect(writes).toEqual([`t1:${CONTINUE_PROMPT}`])
  })

  it('forgetting a tab cancels its continue', () => {
    const { ac, writes } = setup()
    ac.failed('t1', CUT_OFF)
    ac.forget('t1')
    vi.runAllTimers()
    expect(writes).toEqual([])
  })

  it('keeps tabs apart', () => {
    const { ac, writes } = setup()
    ac.turnStarted('t1')
    ac.turnStarted('t2')
    ac.userInput('t2')
    expect(ac.failed('t1', CUT_OFF)).toBe(true)
    expect(ac.failed('t2', CUT_OFF)).toBe(false)
    vi.runAllTimers()
    expect(writes).toEqual(typed('t1'))
  })
})
