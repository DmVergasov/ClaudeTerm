import { describe, expect, it } from 'vitest'
import { ENTER_DELAY_MS } from '../../src/main/auto-continue'
import { PromptDelivery, bracketedPaste, type PromptDeliveryDeps } from '../../src/main/coordinator/prompt-delivery'
import type { PromptState } from '../../src/shared/ipc'
import type { TabView } from '../../src/shared/chat'

const DELAY = 5000

/** a fake clock for the timers the delivery arms; `fire` runs the due ones, as time passes */
function clock() {
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = []
  let now = 0
  return {
    later(ms: number, fn: () => void): () => void {
      const t = { at: now + ms, fn, cancelled: false }
      timers.push(t)
      return () => { t.cancelled = true }
    },
    fire(ms: number): void {
      const end = now + ms
      for (;;) {
        const due = timers.filter((t) => !t.cancelled && t.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        due.cancelled = true
        now = due.at
        due.fn()
      }
      now = end
    },
    pending(): number {
      return timers.filter((t) => !t.cancelled).length
    }
  }
}

/** a promptState the test answers by hand, one call at a time */
function asker() {
  const waiting: { resolve: (s: PromptState) => void }[] = []
  return {
    ask: (): Promise<PromptState> => new Promise((resolve) => waiting.push({ resolve })),
    answer: (state: PromptState): void => {
      waiting.shift()?.resolve(state)
    },
    count: () => waiting.length
  }
}

/** lets the promises of a try settle, and a rejection reach its handler */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function world(o: { view?: TabView | null; prompt?: PromptState | 'manual' | 'reject'; session?: string | null; idle?: boolean; watcher?: boolean; canTake?: boolean; info?: string | null; writeThrows?: boolean } = {}) {
  const t = clock()
  const a = asker()
  const writes: [string, string][] = []
  const takes: [string, string][] = []
  const logs: string[] = []
  const warns: string[] = []
  const state = {
    view: (o.view === undefined ? 'chat' : o.view) as TabView | null,
    session: o.session === undefined ? 's-1' : o.session,
    idle: o.idle ?? true,
    watcher: o.watcher ?? false,
    canTake: o.canTake ?? true,
    info: o.info === undefined ? 'WAKE' : o.info
  }
  const d: PromptDeliveryDeps = {
    session: () => state.session,
    idle: () => state.idle,
    hasWatcher: () => state.watcher,
    canTake: () => state.canTake,
    take: (tabId, session) => {
      takes.push([tabId, session])
      return state.info === null ? null : { info: state.info }
    },
    promptState: () => {
      if (o.prompt === 'reject') return Promise.reject(new Error('window gone'))
      return o.prompt === 'manual' || o.prompt === undefined ? a.ask() : Promise.resolve(o.prompt)
    },
    view: () => state.view,
    write: (tabId, data) => {
      if (o.writeThrows) throw new Error('pty closed')
      writes.push([tabId, data])
    },
    delayMs: DELAY,
    enterDelayMs: ENTER_DELAY_MS,
    later: (ms, fn) => t.later(ms, fn),
    log: { info: (m) => logs.push(m), warn: (m) => warns.push(m) }
  }
  const delivery = new PromptDelivery(d)
  return { delivery, t, a, writes, takes, logs, warns, state }
}

describe('PromptDelivery', () => {
  it('an idle chat tab with no watcher gets the wake text as one message after the delay', async () => {
    const w = world({ view: 'chat', prompt: 'empty' })
    w.delivery.poke('tab-1')
    w.t.fire(DELAY - 1)
    expect(w.writes).toEqual([])
    w.t.fire(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(w.writes).toEqual([['tab-1', 'WAKE']])
    expect(w.takes).toEqual([['tab-1', 's-1']])
  })

  it('a terminal tab gets it as a bracketed paste and Enter 50 ms later', async () => {
    const w = world({ view: 'terminal', prompt: 'empty', info: 'line one\nline two' })
    w.delivery.poke('tab-1')
    w.t.fire(DELAY)
    await Promise.resolve()
    await Promise.resolve()
    expect(w.writes).toEqual([['tab-1', '\x1b[200~line one\rline two\x1b[201~']])
    w.t.fire(ENTER_DELAY_MS - 1)
    expect(w.writes).toHaveLength(1)
    w.t.fire(1)
    expect(w.writes).toEqual([['tab-1', '\x1b[200~line one\rline two\x1b[201~'], ['tab-1', '\r']])
  })

  it('nothing is written when a watcher waits, the tab works, or nothing waits', async () => {
    const cases: Partial<Parameters<typeof world>[0]>[] = [
      { watcher: true },
      { idle: false },
      { canTake: false },
      { session: null }
    ]
    for (const c of cases) {
      const w = world({ prompt: 'empty', ...c })
      w.delivery.poke('tab-1')
      w.t.fire(DELAY)
      await Promise.resolve()
      expect(w.writes).toEqual([])
      expect(w.takes).toEqual([])
      expect(w.a.count()).toBe(0)
    }
  })

  it('a prompt that is not empty is left alone', async () => {
    for (const prompt of ['draft', 'none'] as const) {
      const w = world({ prompt })
      w.delivery.poke('tab-1')
      w.t.fire(DELAY)
      await Promise.resolve()
      await Promise.resolve()
      expect(w.writes).toEqual([])
      expect(w.takes).toEqual([])
      expect(w.logs.some((l) => l.includes('tab=tab-1'))).toBe(true)
    }
  })

  it('a take that returns nothing writes nothing', async () => {
    const w = world({ prompt: 'empty', info: null })
    w.delivery.poke('tab-1')
    w.t.fire(DELAY)
    await Promise.resolve()
    await Promise.resolve()
    expect(w.takes).toEqual([['tab-1', 's-1']])
    expect(w.writes).toEqual([])
  })

  it('a tab that starts working while the window answers is not written into', async () => {
    const w = world({ prompt: 'manual' })
    w.delivery.poke('tab-1')
    w.t.fire(DELAY)
    expect(w.a.count()).toBe(1)
    w.state.idle = false
    w.a.answer('empty')
    await Promise.resolve()
    await Promise.resolve()
    expect(w.takes).toEqual([])
    expect(w.writes).toEqual([])
  })

  it('pokes during the delay arm one try; forget cancels it', async () => {
    const w = world({ prompt: 'empty' })
    w.delivery.poke('tab-1')
    w.delivery.poke('tab-1')
    w.t.fire(DELAY - 1)
    w.delivery.poke('tab-1')
    w.t.fire(1)
    await Promise.resolve()
    await Promise.resolve()
    expect(w.takes).toHaveLength(1)
    expect(w.writes).toEqual([['tab-1', 'WAKE']])

    const v = world({ prompt: 'empty' })
    v.delivery.poke('tab-1')
    v.delivery.forget('tab-1')
    v.t.fire(DELAY * 2)
    await Promise.resolve()
    expect(v.takes).toEqual([])
    expect(v.writes).toEqual([])
  })

  it('forget while the window answers: nothing is taken or written after it', async () => {
    const w = world({ prompt: 'manual' })
    w.delivery.poke('tab-1')
    w.t.fire(DELAY)
    expect(w.a.count()).toBe(1)
    w.delivery.forget('tab-1')
    w.a.answer('empty')
    await Promise.resolve()
    await Promise.resolve()
    expect(w.takes).toEqual([])
    expect(w.writes).toEqual([])
  })

  it('forget does not cancel the Enter of a paste already written', async () => {
    const w = world({ view: 'terminal', prompt: 'empty', info: 'one' })
    w.delivery.poke('tab-1')
    w.t.fire(DELAY)
    await Promise.resolve()
    await Promise.resolve()
    w.delivery.forget('tab-1')
    w.t.fire(ENTER_DELAY_MS)
    expect(w.writes).toEqual([['tab-1', bracketedPaste('one')], ['tab-1', '\r']])
  })

  it('dispose cancels the armed try and the pending Enter', async () => {
    const armed = world({ prompt: 'empty' })
    armed.delivery.poke('tab-1')
    armed.delivery.dispose()
    armed.t.fire(DELAY * 2)
    expect(armed.takes).toEqual([])

    const paste = world({ view: 'terminal', prompt: 'empty', info: 'one' })
    paste.delivery.poke('tab-1')
    paste.t.fire(DELAY)
    await Promise.resolve()
    await Promise.resolve()
    paste.delivery.dispose()
    paste.t.fire(ENTER_DELAY_MS)
    expect(paste.writes).toEqual([['tab-1', bracketedPaste('one')]])

    const running = world({ prompt: 'manual' })
    running.delivery.poke('tab-1')
    running.t.fire(DELAY)
    running.delivery.dispose()
    running.a.answer('empty')
    await Promise.resolve()
    await Promise.resolve()
    expect(running.takes).toEqual([])
    expect(running.writes).toEqual([])
  })

  it('a window answer that fails takes nothing, writes nothing, and is logged for the tab', async () => {
    const w = world({ prompt: 'reject' })
    w.delivery.poke('tab-1')
    w.t.fire(DELAY)
    await flush()
    expect(w.takes).toEqual([])
    expect(w.writes).toEqual([])
    expect(w.warns).toHaveLength(1)
    expect(w.warns[0]).toContain('tab=tab-1')
  })

  it('a taken text whose write fails is logged as not written', async () => {
    const w = world({ prompt: 'empty', writeThrows: true })
    w.delivery.poke('tab-1')
    w.t.fire(DELAY)
    await flush()
    expect(w.takes).toEqual([['tab-1', 's-1']])
    expect(w.writes).toEqual([])
    expect(w.warns).toHaveLength(1)
    expect(w.warns[0]).toContain('not written')
  })

  it('a poke while a try waits for the window arms no second try: one paste, then one new try after its Enter', async () => {
    const w = world({ view: 'terminal', prompt: 'manual', info: 'one' })
    w.delivery.poke('tab-1')
    w.t.fire(DELAY)
    expect(w.a.count()).toBe(1)
    w.delivery.poke('tab-1')
    expect(w.t.pending()).toBe(0)
    w.a.answer('empty')
    await flush()
    expect(w.takes).toHaveLength(1)
    expect(w.writes).toEqual([['tab-1', bracketedPaste('one')]])
    expect(w.t.pending()).toBe(1)
    w.t.fire(ENTER_DELAY_MS)
    expect(w.writes).toEqual([['tab-1', bracketedPaste('one')], ['tab-1', '\r']])
    expect(w.t.pending()).toBe(1)
    w.t.fire(DELAY)
    expect(w.a.count()).toBe(1)
    expect(w.t.pending()).toBe(0)
    expect(w.takes).toHaveLength(1)
  })
})

describe('bracketedPaste', () => {
  it('wraps the text in the paste markers and turns line breaks into carriage returns', () => {
    expect(bracketedPaste('a\r\nb\nc')).toBe('\x1b[200~a\rb\rc\x1b[201~')
  })
})
