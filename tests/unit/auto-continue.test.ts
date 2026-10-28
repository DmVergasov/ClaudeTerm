import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutoContinue, CONTINUE_DELAY_MS, CONTINUE_PROMPT, ENTER_DELAY_MS } from '../../src/main/auto-continue'
import type { PromptState } from '../../src/shared/ipc'
import { MAX_AUTO_CONTINUES as MAX_CONTINUES } from '../../src/shared/settings-keys'

const CUT_OFF = 'server_error'

function setup(enabled = true) {
  const state = { enabled, prompt: 'empty' as PromptState }
  const writes: string[] = []
  const notified: string[] = []
  const asked: string[] = []
  const logs: string[] = []
  const ac = new AutoContinue({
    enabled: () => state.enabled,
    promptState: async (tabId) => {
      asked.push(tabId)
      return state.prompt
    },
    write: (tabId, data) => writes.push(`${tabId}:${data}`),
    notify: (tabId) => notified.push(tabId),
    log: { info: (m) => logs.push(m) }
  })
  return { ac, writes, notified, asked, logs, state }
}

/** the text, then Enter on its own */
const typed = (tabId: string): string[] => [`${tabId}:${CONTINUE_PROMPT}`, `${tabId}:\r`]
const runAll = (): Promise<void> => vi.runAllTimersAsync().then(() => undefined)

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('AutoContinue', () => {
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
        log: { info: () => {} }
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
