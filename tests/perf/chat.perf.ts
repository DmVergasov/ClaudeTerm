// Chat perf harness: `npm run perf` measures the chat against the budgets of the chat-mode spec (Performance), and prints one
// JSON line with the median of five runs of each. The launch and the terminal are timing.perf.ts. Not part of the test suite
// (playwright.perf.config.ts).
import { expect, test, type Page } from '@playwright/test'
import { CHAT_INPUT, chatReady, chatStandIn, launchChatTab, restoredChat, sendMessage } from '../e2e/chat-helpers'
import { launchApp } from '../e2e/helpers'

const RUNS = 5
/** the conversation of the activation and scrolling budgets: 5,000 pairs, 10,001 items with the last message */
const LONG_PAIRS = 5000
/** a screen at a time, the scroll reaches the first pair; the cap is far above what the conversation needs */
const MAX_SCROLL_STEPS = 2000
/** a streamed answer of 1,000 words at 200 words (tokens) a second: 5 s; ten paragraphs, each one a Markdown block */
const STREAM_RATE = 200
const STREAM_WORDS = 1000
const STREAM = Array.from({ length: 10 }, (_, p) => Array.from({ length: STREAM_WORDS / 10 }, (_, i) => `word${p * 100 + i}`).join(' ')).join('\n\n')
const TYPED = 'abcdefghij'.repeat(4)
/** the tabs of the memory numbers */
const MEMORY_TABS = 20
const MB = 1024 * 1024

/** the budgets; chatTurnStartMs is the turn's opening frame (the message, the working line), which must stay in one frame */
const BUDGET = { chatActivateMs: 150, chatScrollLongTaskMs: 50, chatFrameMs: 4, chatTurnStartMs: 16.7, typingLatencyMs: 16.7 }

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.floor(sorted.length / 2)]! * 10) / 10
}

/** resolves after two animation frames: the page has painted what the step before it changed */
const twoFrames = (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

/**
 * The renderer's memory in bytes after a garbage collection: the V8 heap, Blink's heap (the DOM) and the array buffers (xterm's
 * lines). performance.memory is bucketed and sees only V8, so it is not used.
 */
async function rendererBytes(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('HeapProfiler.collectGarbage')
    const usage = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number; embedderHeapUsedSize: number; backingStorageSize: number }
    return usage.usedSize + usage.embedderHeapUsedSize + usage.backingStorageSize
  } finally {
    await cdp.detach()
  }
}

/** the last message of the conversation, in the chat in front, is inside the view of its scroll */
function lastMessageShown(): boolean {
  const host = [...document.querySelectorAll<HTMLElement>('.chat-host')].find((h) => h.getClientRects().length > 0)
  const scroll = host?.querySelector<HTMLElement>('.chat-scroll')
  const last = [...(host?.querySelectorAll<HTMLElement>('.chat-text') ?? [])].filter((el) => el.textContent?.includes('Hi there')).pop()
  if (!scroll || !last) return false
  const view = scroll.getBoundingClientRect()
  const at = last.getBoundingClientRect()
  return at.height > 0 && at.top >= view.top && at.bottom <= view.bottom
}

/**
 * A restored chat of 5,000 pairs, cold: it is restored behind a shell tab, so its first show is the activation timed here, from
 * the activation to its last message in view. Then the view is scrolled from the bottom to the first pair, a screen per wheel
 * step, each step given its frames, so the window pages the held items in and asks main for the older pages. The longest task
 * (Long Tasks API) and the longest gap between two frames are taken over the scroll.
 */
async function longChat(): Promise<{ activateMs: number; scrollLongTaskMs: number; scrollFrameGapMs: number; scrollSteps: number }> {
  const { app, page, tabId } = await restoredChat(LONG_PAIRS, { behind: true })
  try {
    const t0 = performance.now()
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await page.waitForFunction(lastMessageShown)
    const activateMs = performance.now() - t0

    const scroll = page.locator('.chat-host:visible .chat-scroll')
    const box = (await scroll.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.evaluate(() => {
      const w = window as unknown as { __longTask: number; __longObserver: PerformanceObserver; __gap: number; __last: number; __raf: number }
      w.__longTask = 0
      w.__gap = 0
      w.__last = performance.now()
      // kept on the window: the observers live as long as the page does
      w.__longObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__longTask = Math.max(w.__longTask, entry.duration)
      })
      w.__longObserver.observe({ type: 'longtask' })
      const frame = (now: number): void => {
        w.__gap = Math.max(w.__gap, now - w.__last)
        w.__last = now
        w.__raf = requestAnimationFrame(frame)
      }
      w.__raf = requestAnimationFrame(frame)
    })
    // the first pair is the first item drawn, with the view at its top
    const atStart = (): Promise<boolean> => scroll.evaluate((el) => el.scrollTop === 0 && el.querySelector('.chat-user')?.textContent?.trim() === 'pair 0')
    let steps = 0
    while (steps < MAX_SCROLL_STEPS && !(await atStart())) {
      await page.mouse.wheel(0, -box.height)
      await twoFrames(page)
      steps++
    }
    expect(await atStart(), `the scroll reached pair 0 after ${steps} steps`).toBe(true)
    const measured = await page.evaluate(() => {
      const w = window as unknown as { __longTask: number; __longObserver: PerformanceObserver; __gap: number; __raf: number }
      cancelAnimationFrame(w.__raf)
      w.__longObserver.disconnect()
      return { longTask: w.__longTask, gap: w.__gap }
    })
    return { activateMs, scrollLongTaskMs: measured.longTask, scrollFrameGapMs: measured.gap, scrollSteps: steps }
  } finally {
    await app.close()
  }
}

/**
 * A chat streams 200 tokens a second for 5 s in front. The budget is the text arriving: the largest chat-frame measure from the
 * first words drawn on; the turn's opening frame (the sent message, the working line) is taken apart as chatTurnStartMs. Then a
 * second chat is in front and the first one streams hidden, while 40 characters are typed into the second one's composer: the
 * time from each keydown to the next animation frame.
 */
async function streamingChat(): Promise<{ frameMs: number; turnStartMs: number; typingMs: number; typingMaxMs: number }> {
  const { app, page, tabId, work } = await launchChatTab({ turns: { stream: [{ text: STREAM, rate: STREAM_RATE }] } })
  try {
    await chatReady(page)
    await page.evaluate(() => {
      const w = window as unknown as { __frames: { start: number; ms: number }[]; __observer: PerformanceObserver }
      w.__frames = []
      w.__observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntriesByName('chat-frame')) w.__frames.push({ start: entry.startTime, ms: entry.duration })
      })
      w.__observer.observe({ entryTypes: ['measure'] })
    })
    // the moment the first streaming text is drawn: the frames before it are the turn's opening, the frames from it the text's
    await page.evaluate(() => {
      const w = window as unknown as { __streamAt: number | null; __streamWatch: MutationObserver }
      w.__streamAt = null
      w.__streamWatch = new MutationObserver(() => {
        if (w.__streamAt === null && document.querySelector('.chat-text.streaming') !== null) {
          w.__streamAt = performance.now()
          w.__streamWatch.disconnect()
        }
      })
      w.__streamWatch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    })
    const sent = await page.evaluate(() => performance.now())
    await sendMessage(page, 'stream')
    await expect(page.locator('.chat-host:visible .chat-text.streaming')).toContainText('word1', { timeout: 30_000 })
    const from = await page.evaluate(() => (window as unknown as { __streamAt: number | null }).__streamAt)
    expect(from, 'the first streaming text was drawn').not.toBeNull()
    const streamAt = from ?? 0
    await expect(page.locator('.chat-column')).toContainText('word999', { timeout: 30_000 })
    await expect.poll(async () => (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.state.turn ?? null, { timeout: 30_000 }).toBe('idle')
    const frames = await page.evaluate(() => (window as unknown as { __frames: { start: number; ms: number }[] }).__frames)
    const frameMs = Math.max(0, ...frames.filter((f) => f.start >= streamAt).map((f) => f.ms))
    const turnStartMs = Math.max(0, ...frames.filter((f) => f.start >= sent && f.start < streamAt).map((f) => f.ms))

    // a second chat in front; the first one streams behind it
    const second = await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), work)
    expect(second).not.toBeNull()
    await page.waitForFunction((id) => window.__ct!.activeTabId() === id, second!.id)
    await chatReady(page)
    expect(await page.evaluate(({ id, text }) => window.__ct!.sendText!(id, text), { id: tabId, text: 'stream' })).toBeNull()
    await page.evaluate(() => {
      const w = window as unknown as { __keys: number[] }
      w.__keys = []
      document.addEventListener('keydown', () => {
        const t0 = performance.now()
        requestAnimationFrame(() => w.__keys.push(performance.now() - t0))
      }, true)
    })
    await page.locator(CHAT_INPUT).click()
    await page.keyboard.type(TYPED)
    await page.waitForFunction((n) => (window as unknown as { __keys: number[] }).__keys.length === n, TYPED.length)
    // the stream is still going: the typing happened while the first chat streamed
    expect((await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.state.turn).toBe('working')
    const keys = await page.evaluate(() => (window as unknown as { __keys: number[] }).__keys)
    return { frameMs, turnStartMs, typingMs: median(keys), typingMaxMs: Math.max(...keys) }
  } finally {
    await app.close()
  }
}

/**
 * The renderer's memory growth, in MB, of MEMORY_TABS tabs of a view, each one shown once: the setting names the view new Claude
 * tabs open in (the IPC guard drops a view from openTab), and the views are checked (a terminal has an xterm, a chat none).
 */
async function memoryGrowthMB(view: 'chat' | 'terminal'): Promise<number> {
  const stand = chatStandIn({ turns: {} })
  const settings = { ...stand.settings, claude: { ...(stand.settings as { claude: object }).claude, view } }
  const { app, page } = await launchApp({ settings, env: stand.env })
  try {
    await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
    const before = await rendererBytes(page)
    const ids: string[] = []
    for (let i = 0; i < MEMORY_TABS; i++) {
      ids.push((await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), stand.work))!.id)
    }
    await page.waitForFunction((n) => window.__ct!.tabIds().length === n, MEMORY_TABS + 1)
    for (const id of ids) {
      await page.evaluate((x) => window.ct.activateTab(x), id)
      await page.waitForFunction((x) => window.__ct!.activeTabId() === x, id)
      await twoFrames(page)
    }
    // the shell tab's xterm is in both runs; the terminal tabs add theirs
    expect(await page.locator('.xterm').count()).toBe(view === 'terminal' ? MEMORY_TABS + 1 : 1)
    return ((await rendererBytes(page)) - before) / MB
  } finally {
    await app.close()
  }
}

test('chat', async () => {
  test.setTimeout(90 * 60_000)
  const samples = {
    chatActivateMs: [] as number[],
    chatScrollLongTaskMs: [] as number[],
    chatScrollFrameGapMs: [] as number[],
    chatFrameMs: [] as number[],
    chatTurnStartMs: [] as number[],
    typingLatencyMs: [] as number[],
    typingLatencyMaxMs: [] as number[],
    chatMemoryMB: [] as number[],
    terminalMemoryMB: [] as number[]
  }
  for (let i = 0; i < RUNS; i++) {
    const long = await longChat()
    samples.chatActivateMs.push(long.activateMs)
    samples.chatScrollLongTaskMs.push(long.scrollLongTaskMs)
    samples.chatScrollFrameGapMs.push(long.scrollFrameGapMs)
    const streaming = await streamingChat()
    samples.chatFrameMs.push(streaming.frameMs)
    samples.chatTurnStartMs.push(streaming.turnStartMs)
    samples.typingLatencyMs.push(streaming.typingMs)
    samples.typingLatencyMaxMs.push(streaming.typingMaxMs)
    samples.chatMemoryMB.push(await memoryGrowthMB('chat'))
    samples.terminalMemoryMB.push(await memoryGrowthMB('terminal'))
  }

  const result = {
    chatActivateMs: median(samples.chatActivateMs),
    chatScrollLongTaskMs: median(samples.chatScrollLongTaskMs),
    chatScrollFrameGapMs: median(samples.chatScrollFrameGapMs),
    chatFrameMs: median(samples.chatFrameMs),
    chatTurnStartMs: median(samples.chatTurnStartMs),
    typingLatencyMs: median(samples.typingLatencyMs),
    typingLatencyMaxMs: median(samples.typingLatencyMaxMs),
    chatMemoryMB: median(samples.chatMemoryMB),
    terminalMemoryMB: median(samples.terminalMemoryMB)
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  // the budgets are on the median of the runs; the runs are printed with a failure
  const runs = (key: keyof typeof samples): string => JSON.stringify(samples[key])
  expect(result.chatActivateMs, `chatActivateMs runs ${runs('chatActivateMs')}`).toBeLessThanOrEqual(BUDGET.chatActivateMs)
  expect(result.chatScrollLongTaskMs, `chatScrollLongTaskMs runs ${runs('chatScrollLongTaskMs')}`).toBeLessThanOrEqual(BUDGET.chatScrollLongTaskMs)
  expect(result.chatFrameMs, `chatFrameMs runs ${runs('chatFrameMs')}`).toBeLessThanOrEqual(BUDGET.chatFrameMs)
  expect(result.chatTurnStartMs, `chatTurnStartMs runs ${runs('chatTurnStartMs')}`).toBeLessThanOrEqual(BUDGET.chatTurnStartMs)
  expect(result.typingLatencyMs, `typingLatencyMs runs ${runs('typingLatencyMs')}`).toBeLessThanOrEqual(BUDGET.typingLatencyMs)
})
