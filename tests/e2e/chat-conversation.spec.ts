import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { IPC } from '../../src/shared/ipc'
import type { ChatSnapshot } from '../../src/shared/chat'
import { launchChatTab } from './chat-helpers'
import { claudeTempRoot, sessionTempDir } from '../../src/main/image-watcher'
import { gitRepo, KEYS, keepingClipboard, launchApp, openTabInFront, PNG_1x1 } from './helpers'

const INPUT = '.chat-input'

/** the chat is ready: its process has answered the start, so a message is not refused as "not running" */
async function ready(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const s = await window.ct.chatSnapshot(window.__ct!.activeTabId()!)
    return s !== null && !s.state.exited && !s.items.some((item) => item.kind === 'notice' && item.text === 'Starting Claude…')
  }), { timeout: 15_000 }).toBe(true)
}

async function send(page: Page, text: string): Promise<void> {
  await ready(page)
  await page.locator(INPUT).click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/** records the URLs main hands to shell.openExternal, instead of opening a browser */
async function stubExternal(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const calls: string[] = []
    ;(globalThis as Record<string, unknown>).__externalCalls = calls
    shell.openExternal = (u: string) => { calls.push(u); return Promise.resolve() }
  })
}
const externalCalls = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as Record<string, unknown>).__externalCalls as string[])

test("Claude's Markdown is drawn, a code block can be copied", { tag: '@alone' }, async () => {
  const text = ['## Plan', '', '- first item', '- second item', '', 'Run `npm test` first.', '', '```', 'npm test', '```'].join('\n')
  const { app, page } = await launchChatTab({ turns: { write: [{ text }] } })
  try {
    await send(page, 'write')
    await expect(page.locator('.chat-text h2', { hasText: 'Plan' })).toHaveCount(1)
    await expect(page.locator('.chat-text li')).toHaveCount(2)
    await expect(page.locator('.chat-text p code', { hasText: 'npm test' })).toHaveCount(1)
    await expect(page.locator('.chat-code')).toHaveCount(1)
    await keepingClipboard(app, async () => {
      await page.locator('.chat-copy').click()
      await expect(page.locator('.chat-copy')).toHaveText('Copied')
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('npm test')
      await expect(page.locator('.chat-copy')).toHaveText('Copy', { timeout: 4000 })
    })
  } finally {
    await app.close()
  }
})

test('raw HTML is text', async () => {
  const { app, page } = await launchChatTab({ turns: { html: [{ text: '<img src=x onerror="document.title=\'x\'">' }] } })
  try {
    await send(page, 'html')
    await expect(page.locator('.chat-text')).toContainText('<img src=x')
    await expect(page.locator('.chat-text img')).toHaveCount(0)
    expect(await page.title()).not.toBe('x')
  } finally {
    await app.close()
  }
})

test('a link opens in the browser, a file link does not', async () => {
  const { app, page } = await launchChatTab({ turns: { links: [{ text: 'See [the docs](https://example.com), [notes](./notes.md) and [secret](file:///etc/passwd)' }] } })
  try {
    await stubExternal(app)
    const url = page.url()
    await send(page, 'links')
    await expect(page.locator('.chat-text a.chat-link', { hasText: 'the docs' })).toHaveCount(1)
    await expect(page.locator('.chat-text a[href^="file:"]')).toHaveCount(0)
    // a relative address is text that cannot navigate: its click opens nothing
    await page.locator('.chat-text a.chat-link', { hasText: 'notes' }).click()
    await page.locator('.chat-text a.chat-link', { hasText: 'the docs' }).click()
    await expect.poll(() => externalCalls(app)).toEqual(['https://example.com/'])
    // the window never navigates to the link
    expect(page.url()).toBe(url)
  } finally {
    await app.close()
  }
})

test('thinking is folded and unfolds to its summary', async () => {
  const { app, page } = await launchChatTab({
    turns: {
      think: [{ thinking: 'Checking the build first.', ms: 2000 }, { text: 'Done.' }],
      'think again': [{ thinking: '', ms: 1000 }, { text: 'Done again.' }]
    }
  })
  try {
    await send(page, 'think')
    const block = page.locator('.chat-thinking').first()
    await expect(block).toContainText('Thought for 2s')
    await expect(block).not.toContainText('Checking the build first.')
    await block.locator('.chat-thinking-head').click()
    await expect(block).toContainText('Checking the build first.')
    // a thinking block with no summary draws no row: the turn's answer is all the column shows
    await send(page, 'think again')
    await expect(page.locator('.chat-column')).toContainText('Done again.')
    await expect(page.locator('.chat-thinking')).toHaveCount(1)
    await expect(page.locator('.chat-column')).not.toContainText('Thought for 1s')
    await expect(page.locator('.chat-column')).not.toContainText('No summary')
  } finally {
    await app.close()
  }
})

test('/context output is a quiet block', async () => {
  const { app, page } = await launchChatTab({
    turns: { '/context': [{ command: '/context', output: 'Context Usage\nMessages: 12k tokens' }] }
  })
  try {
    await send(page, '/context')
    const block = page.locator('.chat-command')
    await expect(block.locator('.chat-command-head')).toHaveText('/context')
    await expect(block.locator('pre')).toContainText('Messages: 12k tokens')
    await expect(block.locator('pre')).toHaveCSS('max-height', '240px')
    await expect(block.locator('pre')).toHaveCSS('font-size', '12px')
  } finally {
    await app.close()
  }
})

test('a retry is one line', async () => {
  const { app, page } = await launchChatTab({
    turns: { 'retry me': [{ retry: { attempt: 1, max: 3, delayMs: 2000 } }, { text: 'Back.' }] }
  })
  try {
    await send(page, 'retry me')
    const notice = page.locator('.chat-notice', { hasText: 'Retrying in 2s · attempt 1 of 3' })
    await expect(notice).toHaveCount(1)
    const box = await notice.locator('.chat-notice-text').boundingBox()
    expect(box!.height).toBeLessThan(24)
  } finally {
    await app.close()
  }
})

test('the working line counts while Claude works and goes when it ends', async () => {
  const { app, page } = await launchChatTab({ turns: { wait: [{ wait: 4000 }] } })
  try {
    await send(page, 'wait')
    const working = page.locator('.chat-working')
    await expect(working).toBeVisible()
    await expect(working).toContainText('Working')
    await expect(working).toContainText('Esc to interrupt')
    await expect(working).toContainText(/·\s*\d+s/)
    // the time moves: read now, then 1.2 s later, it shows another time
    const first = await page.locator('.chat-elapsed').textContent()
    await page.waitForTimeout(1200)
    await expect(working).toBeVisible()
    expect(await page.locator('.chat-elapsed').textContent()).not.toBe(first)
    await expect(working).toBeHidden({ timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('the working line keeps its height at every step of the glyph', async () => {
  const { app, page } = await launchChatTab({ turns: { wait: [{ wait: 8000 }] } })
  try {
    await send(page, 'wait')
    await expect(page.locator('.chat-working')).toBeVisible()
    // the glyph's ten steps, each one frozen in turn (120 ms apart, read at its middle); a step that changes the line's height moves the column
    await page.addStyleTag({ content: '.chat-glyph::before { animation-play-state: paused !important; animation-delay: var(--step) !important; }' })
    const heights: number[] = []
    for (let i = 0; i < 10; i++) {
      heights.push(await page.evaluate((ms) => {
        const glyph = document.querySelector<HTMLElement>('.chat-glyph')!
        glyph.style.setProperty('--step', `-${ms}ms`)
        return glyph.closest<HTMLElement>('.chat-working')!.getBoundingClientRect().height
      }, i * 120 + 60))
    }
    expect(heights).toEqual(new Array(10).fill(heights[0]))
  } finally {
    await app.close()
  }
})

test('while Claude waits the line says Waiting for you, without Esc to interrupt', async () => {
  const { app, page } = await launchChatTab({
    turns: { ask: [{ ask: { tool: 'Bash', input: { command: 'ls' } }, allowed: [{ text: 'listed' }], denied: [{ text: 'no' }] }] }
  })
  try {
    await send(page, 'ask')
    const working = page.locator('.chat-working')
    await expect(working).toContainText('Waiting for you')
    // the text the user sees: a hidden hint does not count
    await expect(working).not.toContainText('Esc to interrupt', { useInnerText: true })
    await page.locator('.chat-card button', { hasText: 'Allow once' }).click()
    await expect(page.locator('.chat-column')).toContainText('listed')
    await expect(working).toBeHidden({ timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('a sent image shows as a thumbnail, another file as a chip', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: {} })
  const dir = mkdtempSync(join(tmpdir(), 'ct-attach-'))
  const png = join(dir, 'shot.png')
  const txt = join(dir, 'notes.txt')
  writeFileSync(png, PNG_1x1)
  writeFileSync(txt, 'notes')
  try {
    await ready(page)
    await page.evaluate(async ([id, paths]) => {
      const attachments = await window.ct.chatAttach(id, paths)
      await window.ct.chatSend(id, { text: 'look at these', attachments })
    }, [tabId, [png, txt]] as [string, string[]])
    const row = page.locator('.chat-user-row', { hasText: 'look at these' })
    await expect(row.locator('.chat-thumb img')).toHaveCount(1)
    await expect(row.locator('.chat-chip')).toHaveCount(1)
    await expect(row.locator('.chat-chip')).toContainText('notes.txt')
  } finally {
    await app.close()
  }
})

test('two images in one bubble both show as thumbnails', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: {} })
  const dir = mkdtempSync(join(tmpdir(), 'ct-attach2-'))
  const first = join(dir, 'one.png')
  const second = join(dir, 'two.png')
  writeFileSync(first, PNG_1x1)
  writeFileSync(second, PNG_1x1)
  try {
    await ready(page)
    await page.evaluate(async ([id, paths]) => {
      const attachments = await window.ct.chatAttach(id, paths)
      await window.ct.chatSend(id, { text: 'two shots', attachments })
    }, [tabId, [first, second]] as [string, string[]])
    const row = page.locator('.chat-user-row', { hasText: 'two shots' })
    await expect(row.locator('.chat-thumb img')).toHaveCount(2)
    await expect(row.locator('.chat-chip')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('streaming draws the settled part once', async () => {
  const rest = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
  const { app, page } = await launchChatTab({
    turns: { stream: [{ text: `First block of the answer.\n\n${rest}`, chunks: 80, pace: 60 }] }
  })
  try {
    await send(page, 'stream')
    // the first block is drawn once, as a part of the streaming text
    const part = page.locator('.chat-part').first()
    await expect(part).toContainText('First block')
    await part.evaluate((el) => { (el as HTMLElement).dataset.keep = 'yes' })
    // the text goes on arriving: the tail is drawn again, the part is not
    await expect(page.locator('.chat-text.streaming .chat-tail')).toContainText('word40', { timeout: 15_000 })
    await expect(page.locator('.chat-part[data-keep="yes"]')).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('a second Copy restarts the 1.5 s of Copied', async () => {
  const { app, page } = await launchChatTab({ turns: { code: [{ text: '```\nnpm test\n```' }] } })
  try {
    // the copy is recorded, not written to the machine's clipboard
    await app.evaluate(({ clipboard }) => {
      const writes: string[] = []
      ;(globalThis as Record<string, unknown>).__clipboardWrites = writes
      clipboard.writeText = (t: string) => { writes.push(t); return Promise.resolve() }
    })
    await send(page, 'code')
    const copy = page.locator('.chat-copy')
    // the text has settled: a click lands on the block that stays
    await expect(copy).toHaveCount(1)
    await expect(page.locator('.chat-text.streaming')).toHaveCount(0)
    // the clicks and the checks are timed on the page's clock, so a loaded machine moves both alike: the first 1.5 s end 400 ms
    // before the check, and the second 1.5 s end 400 ms after it. A first timer that is not cleared reverts the text in between
    const copied = await copy.evaluate(async (el) => {
      const wait = (until: number): Promise<void> => new Promise((resolve) => {
        const tick = (): void => {
          if (performance.now() >= until) resolve()
          else setTimeout(tick, 5)
        }
        tick()
      })
      const button = el as HTMLButtonElement
      button.click()
      const first = performance.now()
      await wait(first + 800)
      button.click()
      const second = performance.now()
      await wait(second + 1100)
      return button.textContent
    })
    expect(copied).toBe('Copied')
    await expect(copy).toHaveText('Copy', { timeout: 3000 })
  } finally {
    await app.close()
  }
})

test('a divider and an error notice are drawn', async () => {
  const { app, page, pipeName, tabId } = await launchChatTab({ turns: { boom: [{ error: 'The model is unavailable' }] } })
  try {
    await send(page, 'boom')
    const notice = page.locator('.chat-notice.error')
    await expect(notice).toHaveCount(1)
    await expect(notice).toHaveCSS('color', 'rgb(242, 134, 126)')
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: randomUUID(), source: 'clear', transcriptPath: null })).toEqual({ ok: true })
    const divider = page.locator('.chat-divider')
    await expect(divider).toHaveCount(1)
    await expect(divider).toHaveCSS('text-transform', 'uppercase')
    await expect(divider).toHaveCSS('font-size', '11px')
  } finally {
    await app.close()
  }
})

test('chat code is set in the font setting', async () => {
  const { app, page } = await launchChatTab({ turns: { code: [{ text: 'Run `npm test` now' }] } })
  try {
    // a list, as the setting holds it: each family is its own name, not one quoted string with the commas in it
    await page.evaluate(() => window.ct.setSetting('font.family', 'Cascadia Mono, Consolas, monospace'))
    await send(page, 'code')
    await expect(page.locator('.chat-text code')).toHaveCSS('font-family', /^"Cascadia Mono", Consolas/)
  } finally {
    await app.close()
  }
})

test('new items pop in, and not under reduced motion', async () => {
  const { app, page } = await launchChatTab({ turns: {} })
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await send(page, 'hello')
    const row = page.locator('.chat-user-row', { hasText: 'hello' })
    await expect(row).toHaveCSS('animation-name', 'pop-in')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await send(page, 'again')
    await expect(page.locator('.chat-user-row', { hasText: 'again' })).toHaveCSS('animation-name', 'none')
  } finally {
    await app.close()
  }
})

/** a step folds to its pill once its calls are done: the test opens the pill to look at its rows */
async function unfoldPill(page: Page): Promise<void> {
  const pill = page.locator('.chat-steps.folded .chat-step-head')
  await expect(pill).toHaveCount(1, { timeout: 15_000 })
  await pill.click()
}

test('a running step is open, a done step folds to its pill', async () => {
  const { app, page } = await launchChatTab({ turns: { run: [{ tool: { name: 'Bash', input: { command: 'npm test' }, result: 'ok', ms: 2500 } }, { text: 'Done.' }] } })
  try {
    await send(page, 'run')
    const steps = page.locator('.chat-steps')
    await expect(steps).toHaveClass(/open/)
    await expect(steps.locator('.chat-step-head')).toHaveText('Running 1 tool')
    await expect(steps.locator('.chat-tool-name', { hasText: 'Bash' })).toHaveCount(1)
    await expect(steps.locator('.chat-ring')).toHaveCount(1)
    await expect(steps).toHaveClass(/folded/, { timeout: 15_000 })
    await expect(steps.locator('.chat-step-head')).toHaveText(/^Ran 1 tool · \d+\.\ds$/)
    await expect(steps.locator('.chat-step-row')).toBeHidden()
  } finally {
    await app.close()
  }
})

test('the pill unfolds the step', async () => {
  const { app, page } = await launchChatTab({ turns: { pill: [{ tool: { name: 'Bash', input: { command: 'npm test' }, result: 'ok' } }, { text: 'Done.' }] } })
  try {
    await send(page, 'pill')
    await unfoldPill(page)
    const steps = page.locator('.chat-steps')
    await expect(steps).toHaveClass(/open/)
    await expect(steps.locator('.chat-step-row', { hasText: 'Bash' })).toBeVisible()
    await expect(steps.locator('.chat-step-state.done')).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('a Bash well shows the last lines and unfolds', async () => {
  const output = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n')
  const { app, page } = await launchChatTab({ turns: { big: [{ tool: { name: 'Bash', input: { command: 'cat big.log' }, result: output } }, { text: 'Done.' }] } })
  try {
    await send(page, 'big')
    await unfoldPill(page)
    const well = page.locator('.chat-well')
    await expect(well).toHaveCount(1)
    await expect(well).not.toHaveClass(/unfolded/)
    const folded = (await well.locator('pre').textContent()) ?? ''
    expect(folded.split('\n').length).toBeLessThanOrEqual(5)
    expect(folded).toMatch(/line \d+/)
    expect(folded).toContain(output.slice(0, 65_536).slice(-16))
    await well.click()
    await expect(well).toHaveClass(/unfolded/)
    const pre = well.locator('pre')
    await expect(pre).toHaveCSS('max-height', '400px')
    // the whole output, which main keeps to 64 KiB: its first 64 KiB, so the well ends with the last line main kept
    const length = await pre.evaluate((el) => el.textContent!.length)
    expect(length).toBeGreaterThan(60_000)
    expect(length).toBeLessThanOrEqual(65_536 + 1)
    const kept = output.slice(0, 65_536)
    expect(await pre.textContent()).toContain(kept.slice(-16))
  } finally {
    await app.close()
  }
})

test('a Bash call that ends within 1 s never opens its step', async () => {
  const { app, page } = await launchChatTab({ turns: { quick: [{ tool: { name: 'Bash', input: { command: 'ls' }, result: 'a.txt', ms: 300 } }, { text: 'Done.' }] } })
  try {
    // every change of the step's open state, from before the call starts
    await page.evaluate(() => {
      const w = window as unknown as { __opens: boolean[]; __observer: MutationObserver }
      w.__opens = []
      w.__observer = new MutationObserver(() => {
        const steps = document.querySelector('.chat-steps')
        if (steps !== null) w.__opens.push(steps.classList.contains('open'))
      })
      w.__observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
    })
    await send(page, 'quick')
    await expect(page.locator('.chat-steps.folded')).toHaveCount(1, { timeout: 15_000 })
    const opens = await page.evaluate(() => (window as unknown as { __opens: boolean[] }).__opens)
    expect(opens.some((open) => open)).toBe(false)
  } finally {
    await app.close()
  }
})

test('a Bash call with no output yet draws no output box while it runs', async () => {
  const { app, page } = await launchChatTab({ turns: { silent: [{ tool: { name: 'Bash', input: { command: 'sleep 4' }, result: 'done', ms: 4000 } }, { text: 'Done.' }] } })
  try {
    await send(page, 'silent')
    // the step opens after 2 s, while the call still has no output: its box takes no height
    await expect(page.locator('.chat-steps')).toHaveClass(/open/, { timeout: 10_000 })
    // the box is drawn, hidden while it has no output: it takes no height
    const well = page.locator('.chat-well')
    await expect(well).toHaveCount(1)
    await expect(well).toBeHidden()
    expect(await well.evaluate((el) => el.getBoundingClientRect().height)).toBe(0)
  } finally {
    await app.close()
  }
})

test('a Bash call that runs over 2 s opens its step, shows its output, and folds when the turn settles', async () => {
  const { app, page } = await launchChatTab({ turns: { long: [{ tool: { name: 'Bash', input: { command: 'sleep 3' }, result: 'slept', ms: 3000 } }, { text: 'Done.' }] } })
  try {
    const t0 = Date.now()
    await send(page, 'long')
    const steps = page.locator('.chat-steps')
    await expect(steps).toHaveClass(/open/, { timeout: 10_000 })
    // it opens once the call has run for 2 s, not at once
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1800)
    await expect(steps.locator('.chat-step-state.done')).toHaveCount(1, { timeout: 15_000 })
    await expect(page.locator('.chat-well')).toContainText('slept')
    await expect(steps).toHaveClass(/folded/, { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('a running subagent keeps its bar delay when an earlier agent ends', async () => {
  const { app, page } = await launchChatTab({
    turns: {
      team: [{
        task: {
          description: 'Check the totals',
          result: 'Checked.',
          agents: [
            { type: 'Explore', description: 'Search the sales folder', ms: 2500 },
            { type: 'general-purpose', description: 'Check the totals', ms: 8000 }
          ]
        }
      }, { text: 'Done.' }]
    }
  })
  try {
    await send(page, 'team')
    const second = page.locator('.chat-steps .chat-agent').nth(1)
    await expect(second.locator('.chat-agent-bar')).toHaveCount(1)
    const delay = (): Promise<string> => second.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--bar-delay'))
    const before = await delay()
    // the first agent ends while the second still runs: the second bar keeps its delay, so it does not jump
    await expect(page.locator('.chat-steps .chat-agent').first()).toContainText('done', { timeout: 15_000 })
    await expect(second.locator('.chat-agent-bar')).toHaveCount(1)
    expect(await delay()).toBe(before)
  } finally {
    await app.close()
  }
})

test('a step that settles while its call still runs stays folded, and does not open again', async () => {
  const { app, page, tabId, pipeName } = await launchChatTab({
    turns: { long: [{ tool: { name: 'Bash', input: { command: 'sleep 9' }, result: 'slept', ms: 9000 } }, { text: 'Done.' }] }
  })
  try {
    await send(page, 'long')
    const steps = page.locator('.chat-steps')
    // the call has run 2 s: the step opens by itself
    await expect(steps).toHaveClass(/open/, { timeout: 10_000 })
    // a divider after the step settles it while its call still runs: it folds
    await sendDividers(pipeName, tabId, 1)
    await expect(steps).toHaveClass(/folded/)
    // and it stays folded: the call has run long, but the step is settled
    await page.waitForTimeout(2500)
    await expect(steps).toHaveClass(/folded/)
  } finally {
    await app.close()
  }
})

test('a call that finishes updates its row in place', async () => {
  const { app, page } = await launchChatTab({ turns: { slow: [{ tool: { name: 'Bash', input: { command: 'sleep 3' }, result: 'slept', ms: 2500 } }, { text: 'Done.' }] } })
  try {
    await send(page, 'slow')
    // a Bash output box is drawn when its output comes, and the output comes with the call's end: the call's row shows the check
    await expect(page.locator('.chat-steps .chat-step-row', { hasText: 'Bash' }).locator('.chat-step-state.done')).toHaveCount(1, { timeout: 15_000 })
    // the turn settles, and the step folds to its pill: the user opens the pill to reach the well
    await expect(page.locator('.chat-steps')).toHaveClass(/folded/, { timeout: 15_000 })
    await unfoldPill(page)
    const well = page.locator('.chat-well')
    await expect(well).toHaveCount(1)
    await well.click()
    await expect(well).toHaveClass(/unfolded/)
    // the well the user unfolds stays unfolded, and its step stays open
    await expect(well).toHaveClass(/unfolded/)
    await expect(page.locator('.chat-steps')).toHaveClass(/open/)
  } finally {
    await app.close()
  }
})

test('an edit row opens Changes at its file', async () => {
  // a repository with a change to a.ts: the edit's file is in the Changes panel
  const repo = gitRepo()
  writeFileSync(join(repo, 'a.ts'), 'one\nTWO\nthree\n')
  const { app, page } = await launchChatTab({
    turns: { edit: [{ tool: { name: 'Edit', input: { file_path: join(repo, 'a.ts'), old_string: 'two', new_string: 'TWO' }, result: 'The file has been updated.' } }, { text: 'Done.' }] }
  }, { work: repo })
  try {
    await send(page, 'edit')
    await unfoldPill(page)
    const row = page.locator('.chat-step-row.edit', { hasText: 'a.ts' })
    await expect(row).toHaveCount(1)
    await expect(row.locator('.chat-tool-detail', { hasText: '+1' })).toHaveCount(1)
    // the removed lines are red, the added ones green
    await expect(row.locator('.chat-tool-detail .minus')).toHaveText('−1')
    await expect(row.locator('.chat-tool-detail .minus')).toHaveCSS('color', 'rgb(242, 134, 126)')
    await row.click()
    await expect(page.locator('#image-panel')).not.toHaveClass(/collapsed/)
    await expect(page.locator('#sheet-header .tab-changes-toggle')).toHaveClass(/active/)
    await expect(page.locator('.review-file[data-path="a.ts"]')).toBeInViewport()
  } finally {
    await app.close()
  }
})

test('a failed call shows its error', async () => {
  const { app, page } = await launchChatTab({
    turns: { fail: [{ tool: { name: 'Bash', input: { command: 'npm test' }, result: 'npm ERR! Test failed', isError: true } }, { text: 'It failed.' }] }
  })
  try {
    await send(page, 'fail')
    await unfoldPill(page)
    await expect(page.locator('.chat-step-row.failed')).toHaveCount(1)
    await expect(page.locator('.chat-step-state.failed')).toHaveCount(1)
    const error = page.locator('.chat-step-error')
    await expect(error).toHaveText('npm ERR! Test failed')
    await expect(error).toHaveCSS('color', 'rgb(242, 134, 126)')
  } finally {
    await app.close()
  }
})

test('subagents of a Task call are listed with their state', async () => {
  const { app, page } = await launchChatTab({
    turns: {
      team: [{
        task: {
          description: 'Find the revenue reports',
          result: 'Found two reports.',
          agents: [
            { type: 'Explore', description: 'Search the sales folder', ms: 1000 },
            { type: 'general-purpose', description: 'Check the totals', ms: 3000, failed: true }
          ]
        }
      }, { text: 'Done.' }]
    }
  })
  try {
    await send(page, 'team')
    // two Agent calls in one step, run in parallel: one agents card for the step, with a row per subagent
    await expect(page.locator('.chat-tool-name', { hasText: 'Agent' })).toHaveCount(2)
    await expect(page.locator('.chat-steps .chat-agents')).toHaveCount(1)
    const agents = page.locator('.chat-steps .chat-agents')
    await expect(agents.locator('.chat-agent')).toHaveCount(2)
    await expect(agents.locator('.chat-agents-head')).toHaveText('2 agents · 0 done')
    // while the agents run the step is open, and its card shows
    await expect(agents).toBeVisible()
    await expect(agents.locator('.chat-agent', { hasText: 'Explore' })).toContainText('done · 1s', { timeout: 10_000 })
    await expect(agents.locator('.chat-agents-head')).toHaveText('2 agents · 1 done')
    await expect(agents.locator('.chat-agent', { hasText: 'Check the totals' }).locator('.chat-agent-bar')).toHaveCount(1)
    await expect(agents.locator('.chat-agent', { hasText: 'Check the totals' })).toContainText('failed', { timeout: 10_000 })
    await expect(agents.locator('.chat-agent', { hasText: 'Check the totals' }).locator('.chat-step-state.failed')).toHaveCount(1)
    // once every call is done the step is its pill, and the card goes with the rows
    await expect(page.locator('.chat-steps.folded')).toHaveCount(1, { timeout: 15_000 })
    await expect(agents).toBeHidden()
    // a click on the pill opens the step, and the card shows again
    await page.locator('.chat-steps.folded .chat-step-head').click()
    await expect(agents).toBeVisible()
  } finally {
    await app.close()
  }
})

test('an image Claude read shows as a card and opens the lightbox', async () => {
  const work = mkdtempSync(join(tmpdir(), 'ct-read-'))
  writeFileSync(join(work, 'shot.png'), PNG_1x1)
  const { app, page, pipeName, tabId } = await launchChatTab({
    turns: { look: [{ tool: { name: 'Read', input: { file_path: join(work, 'shot.png') }, result: '1\tpixel' } }, { text: 'It is a pixel.' }] }
  }, { work })
  try {
    await send(page, 'look')
    await expect(page.locator('.chat-images')).toHaveCount(1)
    await expect(page.locator('.chat-image-card')).toHaveCount(0)
    // the Media panel holds the picture once it is shown (main matches the card to the image by its path)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_image', tabId, path: join(work, 'shot.png'), caption: null })).toEqual({ ok: true })
    const card = page.locator('.chat-image-card')
    await expect(card).toHaveCount(1, { timeout: 10_000 })
    await expect(card.locator('.chat-image-name')).toHaveText('shot.png')
    await card.click()
    await expect(page.locator('#lightbox')).toBeVisible()
    await expect(page.locator('.lightbox-caption')).toHaveText('shot.png  (1/1)')
  } finally {
    await app.close()
  }
})

test('a long run of line breaks in an output does not stall the window', async () => {
  const output = '\n'.repeat(65_000) + 'x'
  const { app, page } = await launchChatTab({ turns: { breaks: [{ tool: { name: 'Bash', input: { command: 'make' }, result: output } }, { text: 'Done.' }] } })
  try {
    // the longest task the page runs from now on (the Long Tasks API reports one of 50 ms or more)
    await page.evaluate(() => {
      const w = window as unknown as { __longest: number; __longObserver: PerformanceObserver }
      w.__longest = 0
      // kept on the window: the observer lives as long as the page does
      w.__longObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) w.__longest = Math.max(w.__longest, entry.duration)
      })
      w.__longObserver.observe({ type: 'longtask', buffered: true })
    })
    await send(page, 'breaks')
    await unfoldPill(page)
    // the last line is drawn, and no task of the drawing held the window for long
    await expect(page.locator('.chat-well-text')).toContainText('x')
    const longest = await page.evaluate(() => (window as unknown as { __longest: number }).__longest)
    expect(longest).toBeLessThan(1000)
  } finally {
    await app.close()
  }
})

test('Enter on an edit row opens Changes at its file', async () => {
  const repo = gitRepo()
  writeFileSync(join(repo, 'a.ts'), 'one\nTWO\nthree\n')
  const { app, page } = await launchChatTab({
    turns: { edit: [{ tool: { name: 'Edit', input: { file_path: join(repo, 'a.ts'), old_string: 'two', new_string: 'TWO' }, result: 'The file has been updated.' } }, { text: 'Done.' }] }
  }, { work: repo })
  try {
    await send(page, 'edit')
    await unfoldPill(page)
    const row = page.locator('.chat-step-row.edit', { hasText: 'a.ts' })
    await row.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('#image-panel')).not.toHaveClass(/collapsed/)
    await expect(page.locator('#sheet-header .tab-changes-toggle')).toHaveClass(/active/)
    await expect(page.locator('.review-file[data-path="a.ts"]')).toBeInViewport()
  } finally {
    await app.close()
  }
})

test('a call that starts in an open step is added as a row', async () => {
  const { app, page } = await launchChatTab({
    turns: {
      two: [
        { tool: { name: 'Read', input: { file_path: 'notes.txt' }, result: '1\tnotes' } },
        { tool: { name: 'Bash', input: { command: 'npm test' }, result: 'ok', ms: 2000 } },
        { text: 'Done.' }
      ]
    }
  })
  try {
    await send(page, 'two')
    // the second call starts while the step is open: its row is added to the step
    await expect(page.locator('.chat-step-call')).toHaveCount(2, { timeout: 15_000 })
    await expect(page.locator('.chat-tool-name')).toHaveText(['Read', 'Bash'])
    await expect(page.locator('.chat-steps .chat-step-state.done')).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test("a step the user folded stays folded when its next call starts", async () => {
  const { app, page } = await launchChatTab({
    turns: {
      three: [
        { tool: { name: 'Bash', input: { command: 'a' }, result: 'ok' } },
        { tool: { name: 'Bash', input: { command: 'b' }, result: 'ok', ms: 3000 } },
        { tool: { name: 'Bash', input: { command: 'c' }, result: 'ok' } },
        { text: 'Done.' }
      ]
    }
  })
  try {
    await send(page, 'three')
    const steps = page.locator('.chat-steps')
    await expect(page.locator('.chat-step-call')).toHaveCount(2, { timeout: 15_000 })
    await expect(steps).toHaveClass(/open/)
    // the user folds the step while the second call runs
    await steps.locator('.chat-step-head').click()
    await expect(steps).toHaveClass(/folded/)
    // the third call is added to the folded step: it stays folded
    await expect(page.locator('.chat-step-call')).toHaveCount(3, { timeout: 15_000 })
    await expect(steps).toHaveClass(/folded/)
    await expect(steps.locator('.chat-step-head')).toHaveText(/^Ran 3 tools · \d+\.\ds$/, { timeout: 15_000 })
    // and the user opens it again: all three rows show
    await steps.locator('.chat-step-head').click()
    await expect(steps).toHaveClass(/open/)
    await expect(page.locator('.chat-step-row').nth(2)).toBeVisible()
  } finally {
    await app.close()
  }
})

const SCROLL = '.chat-scroll'
/** the transcript the one long-conversation test restores; the scrolling tests restore PAIRS */
const LONG_PAIRS = 5000
const PAIRS = 400
/** a streamed answer of about 3 s: 100 pieces, 30 ms apart; it ends with its last word */
const STREAM = `${Array.from({ length: 100 }, (_, i) => `part${i}`).join(' ')} end-of-stream`
/** a long answer, taller than the view: the view can sit inside it */
const LONG_TEXT = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: a few lines of text here, so that the answer is taller than the view.`).join('\n\n')

/** what walkUp waits for: an element with a text */
type Stop = { selector: string; text?: string }

async function snapshot(page: Page, tabId: string): Promise<ChatSnapshot | null> {
  return page.evaluate((id) => window.ct.chatSnapshot(id), tabId)
}

async function waitForTurn(page: Page, tabId: string, turn: 'idle' | 'working' | 'waiting'): Promise<void> {
  await expect.poll(async () => (await snapshot(page, tabId))?.state.turn ?? null, { timeout: 30_000 }).toBe(turn)
}

const atBottom = (scroll: Locator): Promise<boolean> => scroll.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)

/** the number of nodes the chat column holds, the working line included */
const columnNodes = (page: Page): Promise<number> => page.locator('.chat-column > *').count()

/** closes the window, which keeps the tabs in the session snapshot of the data folder */
async function closeWindow(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
  await closed
}

/** `count` dividers, each from a new session: each one is an item of its own, below the last */
async function sendDividers(pipeName: string, tabId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: randomUUID(), source: 'clear', transcriptPath: null })).toEqual({ ok: true })
  }
}

/**
 * Wraps the handler of the older-page request in the main process: each request is counted, answered after `delayMs`, and,
 * with `refuseFirst`, the first one is refused. The page's bridge object takes no new function, so the handler is the place.
 */
async function wrapOlder(app: ElectronApplication, delayMs: number, refuseFirst = false): Promise<void> {
  await app.evaluate(({ ipcMain }, [channel, ms, refuse]: [string, number, boolean]) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>> })._invokeHandlers
    const original = handlers.get(channel)
    if (original === undefined) throw new Error(`no handler for ${channel}`)
    const g = globalThis as Record<string, unknown>
    g.__olderCalls = 0
    handlers.set(channel, async (event, ...args) => {
      const call = (g.__olderCalls as number) + 1
      g.__olderCalls = call
      await new Promise((resolve) => setTimeout(resolve, ms))
      if (refuse && call === 1) throw new Error('refused')
      return original(event, ...args)
    })
  }, [IPC.chatOlder, delayMs, refuseFirst] as [string, number, boolean])
}

/** the older-page requests the app has taken so far, counted in the main process */
const olderCalls = (app: ElectronApplication): Promise<number> =>
  app.evaluate(() => ((globalThis as Record<string, unknown>).__olderCalls as number | undefined) ?? 0)

/**
 * scrolls 40 px down and back to the top, a frame apart, `times` times: each return to the top is a real scroll event, so the
 * view asks again if it is allowed to. Setting the top again while the view is there would fire no event.
 */
async function bounceAtTop(page: Page, times: number): Promise<void> {
  await page.evaluate(async (n) => {
    const scroll = document.querySelector<HTMLElement>('.chat-scroll')!
    const frame = (): Promise<void> => new Promise((resolve) => { requestAnimationFrame(() => resolve()); setTimeout(resolve, 50) })
    for (let i = 0; i < n; i++) {
      scroll.scrollTop = 40
      await frame()
      scroll.scrollTop = 0
      await frame()
    }
  }, times)
}

/** scrolls to the top a frame at a time until the app has taken `calls` older-page requests */
async function walkToOlder(app: ElectronApplication, page: Page, calls: number): Promise<void> {
  await expect.poll(async () => {
    await page.evaluate(async () => {
      document.querySelector<HTMLElement>('.chat-scroll')!.scrollTop = 0
      await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); setTimeout(resolve, 50) })
    })
    return olderCalls(app)
  }, { timeout: 60_000, intervals: [50] }).toBeGreaterThanOrEqual(calls)
}

/**
 * Scrolls to the top a frame at a time, inside the page, until the stop shows. Each scroll to the top brings the page above
 * (or asks for it), so a long walk is one evaluate, not one round trip per page.
 */
async function walkUp(page: Page, stop: Stop): Promise<void> {
  await expect.poll(() => page.evaluate(async (s: Stop) => {
    const scroll = document.querySelector<HTMLElement>('.chat-scroll')!
    const done = (): boolean => Array.from(document.querySelectorAll(s.selector)).some((n) => s.text === undefined || n.textContent === s.text)
    const frame = (): Promise<void> => new Promise((resolve) => { requestAnimationFrame(() => resolve()); setTimeout(resolve, 50) })
    for (let i = 0; i < 1500 && !done(); i++) {
      scroll.scrollTop = 0
      await frame()
    }
    return done()
  }, stop), { timeout: 150_000, intervals: [100] }).toBe(true)
}

/** the first item in view, by its id, and its top sampled in every frame until stopSampling; the view is settled first */
async function startSampling(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frame = (): Promise<void> => new Promise((resolve) => { requestAnimationFrame(() => resolve()); setTimeout(resolve, 50) })
    await frame()
    await frame()
    const scroll = document.querySelector<HTMLElement>('.chat-scroll')!
    const first = Array.from(document.querySelectorAll<HTMLElement>('.chat-column > [data-item]'))
      .find((node) => node.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top)!
    const w = window as unknown as { __id: string; __tops: number[]; __stop: boolean }
    w.__id = first.dataset.item!
    w.__tops = []
    w.__stop = false
    const sample = (): void => {
      if (w.__stop) return
      const node = document.querySelector<HTMLElement>(`.chat-column > [data-item="${w.__id}"]`)
      if (node) w.__tops.push(node.getBoundingClientRect().top)
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
}

async function stopSampling(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __tops: number[]; __stop: boolean }
    w.__stop = true
    return w.__tops
  })
}

/**
 * A chat tab restored from a transcript of `pairs` prompts and answers, whose last message is 'Hi there'. The second window
 * runs the same stand-in script, so the restored chat can take messages of its own: 'stream', and 'held', whose answer comes
 * 2.5 s after the message.
 */
async function restoredLong(pairs = PAIRS): Promise<{ app: ElectronApplication; page: Page; tabId: string; work: string; pipeName: string }> {
  const first = await launchChatTab({
    turns: {
      hello: [{ text: 'Hi there' }],
      stream: [{ text: STREAM, chunks: 100, pace: 30 }],
      held: [{ wait: 20_000 }, { text: 'Answer held' }],
      run: [{ tool: { name: 'Bash', input: { command: 'npm test' }, result: 'ok' } }, { text: 'Done.' }]
    }
  })
  await send(first.page, 'hello')
  await expect(first.page.locator('.chat-column')).toContainText('Hi there')
  await waitForTurn(first.page, first.tabId, 'idle')
  const sid = (await snapshot(first.page, first.tabId))!.state.sessionId!
  await closeWindow(first.app)

  const projects = join(first.config, 'projects')
  const file = join(projects, readdirSync(projects).find((dir) => existsSync(join(projects, dir, `${sid}.jsonl`)))!, `${sid}.jsonl`)
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
  const older = Array.from({ length: pairs }, (_, i) => [
    { parentUuid: i === 0 ? null : `a-${i - 1}`, type: 'user', uuid: `u-${i}`, message: { role: 'user', content: `pair ${i}` } },
    { parentUuid: `u-${i}`, type: 'assistant', uuid: `a-${i}`, message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } }
  ]).flat().map((entry) => JSON.stringify({ isSidechain: false, sessionId: sid, timestamp: '2026-10-08T09:00:00.000Z', ...entry }))
  lines[0] = JSON.stringify({ ...(JSON.parse(lines[0]) as Record<string, unknown>), parentUuid: `a-${pairs - 1}` })
  writeFileSync(file, [...older, ...lines].join('\n') + '\n')

  // the stand-in of the first window, with its script and log: the restored chat runs the same turns
  const root = dirname(first.config)
  const second = await launchApp({
    dataDir: first.dataDir,
    env: { CLAUDE_CONFIG_DIR: first.config, FAKE_CLAUDE_SCRIPT: join(root, 'script.json'), FAKE_CLAUDE_LOG: join(root, 'fake-claude.log') }
  })
  await expect.poll(() => second.page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await second.page.locator('.banner-restore').click()
  await second.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await expect(second.page.locator('.chat-host')).toBeVisible()
  // the restored messages are drawn and the column is at its end, before a test scrolls it: the transcript may load late
  await expect(second.page.locator('.chat-text', { hasText: 'Hi there' })).toHaveCount(1)
  await expect.poll(() => atBottom(second.page.locator(SCROLL))).toBe(true)
  const tabId = (await second.page.evaluate(() => window.__ct!.activeTabId()))!
  return { app: second.app, page: second.page, tabId, work: first.work, pipeName: second.pipeName }
}

test('a long conversation shows its end and holds a small DOM', async () => {
  const { app, page } = await restoredLong(LONG_PAIRS)
  try {
    await expect(page.locator('.chat-text', { hasText: 'Hi there' })).toHaveCount(1)
    await expect(page.locator('.chat-text', { hasText: 'Hi there' })).toBeInViewport()
    expect(await columnNodes(page)).toBeLessThanOrEqual(121)
  } finally {
    await app.close()
  }
})

test('scrolling up brings older items', async () => {
  const { app, page } = await restoredLong()
  try {
    await expect(page.locator('.chat-user', { hasText: /^pair 0$/ })).toHaveCount(0)
    await walkUp(page, { selector: '.chat-user', text: 'pair 0' })
    await expect(page.locator('.chat-user', { hasText: /^pair 0$/ })).toHaveCount(1)
    expect(await columnNodes(page)).toBeLessThanOrEqual(121)
  } finally {
    await app.close()
  }
})

test('while you read above, a streamed answer below does not pull the view down, and the pill brings you down', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { long: [{ text: LONG_TEXT }], stream: [{ text: STREAM, chunks: 100, pace: 30 }] } })
  try {
    await send(page, 'long')
    await waitForTurn(page, tabId, 'idle')
    await expect(page.locator('.chat-text', { hasText: 'Paragraph 39' })).toHaveCount(1)
    // the answer streams in at the bottom, drawn, and the user scrolls up a little: it is below the view
    await send(page, 'stream')
    await expect(page.locator('.chat-text.streaming')).toContainText('part5')
    await page.locator(SCROLL).evaluate((el) => { el.scrollTop -= 800 })
    await startSampling(page)
    await waitForTurn(page, tabId, 'idle')
    const tops = await stopSampling(page)
    expect(tops.length).toBeGreaterThan(10)
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1)

    // the pill shows at the bottom centre, and a click on it brings the column to its end
    const pill = page.locator('.chat-pill')
    await expect(pill).toBeVisible()
    await expect(pill).toHaveText('↓ New messages')
    await pill.click()
    await expect.poll(() => atBottom(page.locator(SCROLL))).toBe(true)
    await expect(pill).toBeHidden()
    await expect(page.locator('.chat-text', { hasText: 'end-of-stream' })).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('a drawn step above the view that gains a row does not move the column', async () => {
  // the first call ends, the second waits 8 s: the step is above the view when its second row comes back
  const { app, page, tabId, pipeName } = await launchChatTab({
    turns: {
      long: [{ text: LONG_TEXT }],
      grow: [{ tool: { name: 'Bash', input: { command: 'npm test' }, result: 'ok', ms: 0 } }, { wait: 8000 }, { tool: { name: 'Bash', input: { command: 'npm run lint' }, result: 'ok', ms: 2000 } }, { text: 'Done.' }]
    }
  })
  try {
    await send(page, 'long')
    await waitForTurn(page, tabId, 'idle')
    await send(page, 'grow')
    await expect(page.locator('.chat-step-row')).toHaveCount(1, { timeout: 15_000 })
    // thirty dividers below the step (more than the view is tall, so the view can sit below the step): the first of them is in view, and the step is above it
    await sendDividers(pipeName, tabId, 30)
    await expect(page.locator('.chat-divider')).toHaveCount(30)
    // the view is placed so that the first divider is at its top: the step is above it, all of it
    await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>('.chat-scroll')!
      const divider = document.querySelector<HTMLElement>('.chat-divider')!
      scroll.scrollTop += divider.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 4
    })
    expect(await page.evaluate(() => document.querySelector<HTMLElement>('.chat-steps')!.getBoundingClientRect().bottom <= document.querySelector<HTMLElement>('.chat-scroll')!.getBoundingClientRect().top)).toBe(true)
    await startSampling(page)
    // the second call starts: the step opens with its second row, above the divider that is in view
    await expect(page.locator('.chat-step-row')).toHaveCount(2, { timeout: 20_000 })
    await waitForTurn(page, tabId, 'idle')
    const tops = await stopSampling(page)
    expect(tops.length).toBeGreaterThan(10)
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1)
  } finally {
    await app.close()
  }
})

test('an answer that arrives out of the window is drawn when the user scrolls down to it', async () => {
  const { app, page, tabId } = await restoredLong()
  try {
    const scroll = page.locator(SCROLL)
    // the message is sent at the end, and the answer comes 20 s later. The window moves up to the first older page well before
    // that: the order is checked, not assumed, so a slow walk fails here instead of drawing the answer in the window
    await send(page, 'held')
    await wrapOlder(app, 0)
    await walkToOlder(app, page, 1)
    expect(await snapshot(page, tabId)).not.toBeNull()
    expect((await snapshot(page, tabId))!.items.some((item) => item.kind === 'text' && item.markdown === 'Answer held')).toBe(false)
    await expect.poll(async () => (await snapshot(page, tabId))?.items.some((item) => item.kind === 'text' && item.markdown === 'Answer held') ?? false, { timeout: 40_000 }).toBe(true)
    await expect(page.locator('.chat-text', { hasText: 'Answer held' })).toHaveCount(0)
    await expect(page.locator('.chat-pill')).toBeVisible()
    // each scroll to the bottom of the window brings the next part of the rest, until the held item is drawn
    await expect.poll(async () => {
      await scroll.evaluate((el) => { el.scrollTop = el.scrollHeight })
      return page.locator('.chat-text', { hasText: 'Answer held' }).count()
    }, { timeout: 60_000 }).toBe(1)
    // the column grows as the held item is drawn: each try takes the bottom again
    await expect.poll(async () => {
      await scroll.evaluate((el) => { el.scrollTop = el.scrollHeight })
      return atBottom(scroll)
    }).toBe(true)
  } finally {
    await app.close()
  }
})

test('the pill click with more than 120 items held out ends at the newest item', async () => {
  const { app, page, tabId, pipeName } = await restoredLong()
  try {
    await page.locator(SCROLL).evaluate((el) => { el.scrollTop -= 1500 })
    await sendDividers(pipeName, tabId, 130)
    const pill = page.locator('.chat-pill')
    await expect(pill).toBeVisible()
    await pill.click()
    await expect.poll(() => atBottom(page.locator(SCROLL))).toBe(true)
    await expect(pill).toBeHidden()
    // the newest divider is the column's last item
    const last = await page.evaluate(() => {
      const items = document.querySelectorAll<HTMLElement>('.chat-column > [data-item]')
      return items[items.length - 1]?.className ?? ''
    })
    expect(last).toContain('chat-divider')
    expect(await columnNodes(page)).toBeLessThanOrEqual(121)
  } finally {
    await app.close()
  }
})

test('a step and a thinking block that leave the window come back with their state, and a call that ends away shows its result', async () => {
  const { app, page, tabId, pipeName } = await launchChatTab({
    turns: { keep: [{ thinking: 'Checking the build first.', ms: 2000 }, { tool: { name: 'Bash', input: { command: 'npm test' }, result: 'ok', ms: 5000 } }, { text: 'Done.' }] }
  })
  try {
    await send(page, 'keep')
    await expect(page.locator('.chat-thinking-head')).toHaveCount(1, { timeout: 15_000 })
    await page.locator('.chat-thinking-head').click()
    await expect(page.locator('.chat-thinking-body')).toContainText('Checking the build first.')
    await expect(page.locator('.chat-steps .chat-ring')).toHaveCount(1, { timeout: 15_000 })
    // a call that runs over 2 s opens its step by itself; the user then folds it: that choice is kept too
    await expect(page.locator('.chat-steps')).toHaveClass(/open/)
    await page.locator('.chat-steps .chat-step-head').click()
    await expect(page.locator('.chat-steps')).toHaveClass(/folded/)
    // 130 items below them: the step and the thinking block leave the window while the call runs
    await sendDividers(pipeName, tabId, 130)
    await expect(page.locator('.chat-steps')).toHaveCount(0)
    await expect(page.locator('.chat-thinking')).toHaveCount(0)
    // the call ends while the step is out of the window
    await expect.poll(async () => (await snapshot(page, tabId))?.items.some((item) => item.kind === 'tools' && item.calls[0]?.state === 'done') ?? false, { timeout: 30_000 }).toBe(true)
    await walkUp(page, { selector: '.chat-steps' })
    // the step comes back with its call's result, and the thinking block comes back open (the step's folded choice is not
    // proven here: a settled step is folded by default, so a lost choice would look the same)
    await expect(page.locator('.chat-steps .chat-step-state.done')).toHaveCount(1)
    await expect(page.locator('.chat-thinking-body')).toContainText('Checking the build first.')
  } finally {
    await app.close()
  }
})

test('a step the user opened stays open when it comes back into the window', async () => {
  const { app, page, tabId, pipeName } = await launchChatTab({
    turns: { open: [{ tool: { name: 'Bash', input: { command: 'npm test' }, result: 'ok', ms: 0 } }, { text: 'Done.' }] }
  })
  try {
    await send(page, 'open')
    // the step is folded once its call is done: the user opens it
    await page.locator('.chat-steps.folded .chat-step-head').click({ timeout: 15_000 })
    await expect(page.locator('.chat-steps')).toHaveClass(/open/)
    await sendDividers(pipeName, tabId, 130)
    await expect(page.locator('.chat-steps')).toHaveCount(0)
    await walkUp(page, { selector: '.chat-steps' })
    await expect(page.locator('.chat-steps')).toHaveClass(/open/)
    await expect(page.locator('.chat-step-row', { hasText: 'npm test' })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a step stays open between its calls and folds once the turn moves on', async () => {
  const { app, page } = await launchChatTab({
    turns: {
      two: [
        // each call runs over 2 s, so the step opens by itself and stays open until the turn settles
        { tool: { name: 'Bash', input: { command: 'npm test' }, result: 'ok', ms: 2500 } },
        { wait: 3000 },
        { tool: { name: 'Bash', input: { command: 'npm run lint' }, result: 'ok', ms: 2500 } },
        { wait: 3000 },
        { text: 'Done.' }
      ]
    }
  })
  try {
    await send(page, 'two')
    // the first call is done and the second has not started: the card stays open, it is not a pill between the calls
    await expect(page.locator('.chat-step-state.done')).toHaveCount(1, { timeout: 15_000 })
    await expect(page.locator('.chat-steps')).toHaveClass(/open/)
    await expect(page.locator('.chat-steps')).not.toHaveClass(/folded/)
    // the second call ends while the turn goes on: the card is still open
    await expect(page.locator('.chat-step-state.done')).toHaveCount(2, { timeout: 15_000 })
    await expect(page.locator('.chat-steps')).toHaveClass(/open/)
    // the text that follows the step settles it: it is a pill
    await expect(page.locator('.chat-text', { hasText: 'Done.' })).toHaveCount(1, { timeout: 15_000 })
    await expect(page.locator('.chat-steps')).toHaveClass(/folded/)
  } finally {
    await app.close()
  }
})

test('an older request in flight is not repeated by more scrolling', async () => {
  const { app, page } = await restoredLong()
  try {
    await wrapOlder(app, 3000)
    await walkToOlder(app, page, 1)
    // five more returns to the top, all within the wait for the first answer: real scroll events at the top, and no second request
    await bounceAtTop(page, 5)
    expect(await olderCalls(app)).toBe(1)
    await walkUp(page, { selector: '.chat-user', text: 'pair 0' })
  } finally {
    await app.close()
  }
})

test('a refused older request is not asked again until the next scroll', async () => {
  const { app, page } = await restoredLong()
  try {
    await wrapOlder(app, 50, true)
    await walkToOlder(app, page, 1)
    // the refusal ends the request; with no scroll, nothing asks again
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)))
    expect(await olderCalls(app)).toBe(1)
    // the next scroll asks again, and the page comes
    await page.locator(SCROLL).evaluate(async (el) => {
      el.scrollTop = 40
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
      el.scrollTop = 0
    })
    await expect.poll(() => olderCalls(app)).toBe(2)
    await walkUp(page, { selector: '.chat-user', text: 'pair 0' })
  } finally {
    await app.close()
  }
})

test('without older items there is no request', async () => {
  // 99 pairs and the two messages of the chat: 200 items, all of them in the snapshot
  const { app, page } = await restoredLong(99)
  try {
    await wrapOlder(app, 0)
    await walkUp(page, { selector: '.chat-user', text: 'pair 0' })
    // the first item is held at the top, and the view returns to the top again and again: still no request
    await bounceAtTop(page, 5)
    expect(await olderCalls(app)).toBe(0)
  } finally {
    await app.close()
  }
})

test("the user's own message brings the column to its end", async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { long: [{ text: LONG_TEXT }], hello: [{ text: 'Hi there' }] } })
  try {
    await send(page, 'long')
    await waitForTurn(page, tabId, 'idle')
    await expect(page.locator('.chat-text', { hasText: 'Paragraph 39' })).toHaveCount(1)
    await page.locator(SCROLL).evaluate((el) => { el.scrollTop -= 800 })
    await send(page, 'hello')
    await expect(page.locator('.chat-user', { hasText: 'hello' })).toBeInViewport()
    await expect.poll(() => atBottom(page.locator(SCROLL))).toBe(true)
  } finally {
    await app.close()
  }
})

/** the first item in the visible chat's view, by its id, and the column's scrollTop: where the reader is */
const readingPlace = (page: Page): Promise<{ id: string | null; scrollTop: number }> => page.evaluate(() => {
  const scroll = Array.from(document.querySelectorAll<HTMLElement>('.chat-scroll')).find((el) => el.offsetParent !== null)!
  const top = scroll.getBoundingClientRect().top
  const first = Array.from(scroll.querySelectorAll<HTMLElement>('.chat-column > [data-item]')).find((el) => el.getBoundingClientRect().bottom > top)
  return { id: first?.dataset.item ?? null, scrollTop: scroll.scrollTop }
})

test('a chat keeps its place, its older pages and its open steps when you switch away and back', async () => {
  // a restored chat of 400 pairs, walked up and down: longer than the default test time on a loaded machine
  test.setTimeout(150_000)
  const { app, page, tabId, work } = await restoredLong()
  try {
    await send(page, 'run')
    await waitForTurn(page, tabId, 'idle')
    // the view goes up past the first page, so the older pages come in
    await wrapOlder(app, 0)
    await walkUp(page, { selector: '.chat-user', text: 'pair 0' })
    // down again to the step, which is folded to its pill, and the step is opened
    await expect.poll(async () => {
      await page.locator(SCROLL).evaluate((el) => { el.scrollTop = el.scrollHeight })
      return page.locator('.chat-steps.folded').count()
    }, { timeout: 60_000 }).toBe(1)
    await page.locator('.chat-steps.folded .chat-step-head').click()
    await expect(page.locator('.chat-steps')).toHaveClass(/open/)
    // a little up from the bottom: the reader is in the middle of the chat, with items above them
    await page.locator(SCROLL).evaluate((el) => { el.scrollTop -= 1500 })
    const before = await readingPlace(page)
    expect(before.id).not.toBeNull()
    await openTabInFront(page, 'shell', work)
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await expect(page.locator('.chat-host:visible .chat-steps.open')).toHaveCount(1)
    const after = await readingPlace(page)
    expect(after.id).toBe(before.id)
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(2)
    // the older pages are still held: the view goes up to the first one again without asking for a page
    const asked = await olderCalls(app)
    await walkUp(page, { selector: '.chat-user', text: 'pair 0' })
    expect(await olderCalls(app)).toBe(asked)
  } finally {
    await app.close()
  }
})

test('clicking the tab in front does not move its chat', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { long: [{ text: LONG_TEXT }] } })
  try {
    await send(page, 'long')
    await waitForTurn(page, tabId, 'idle')
    await expect(page.locator('.chat-text', { hasText: 'Paragraph 39' })).toHaveCount(1)
    // the view learns of a scroll from its scroll event, which comes with the next frame: the click comes after it, as a person's does
    await page.locator(SCROLL).evaluate((el) => new Promise<void>((resolve) => {
      el.addEventListener('scroll', () => resolve(), { once: true })
      el.scrollTop -= 800
    }))
    const before = await readingPlace(page)
    // a click on the tab in front activates it again: main sends the activation once more
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await page.waitForTimeout(500)
    const after = await readingPlace(page)
    expect(after.id).toBe(before.id)
    expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(2)
  } finally {
    await app.close()
  }
})

test('an answer that came while the tab was away is there when you come back', async () => {
  const { app, page, tabId, work } = await launchChatTab({ turns: { long: [{ text: LONG_TEXT }], away: [{ text: 'Answer while away' }] } })
  try {
    await send(page, 'long')
    await waitForTurn(page, tabId, 'idle')
    await expect.poll(() => atBottom(page.locator(SCROLL))).toBe(true)
    await openTabInFront(page, 'shell', work)
    // the chat is not in front: its message is sent and its answer comes in the background
    await page.evaluate((id) => window.ct.chatSend(id, { text: 'away', attachments: [] }), tabId)
    await expect.poll(async () => (await snapshot(page, tabId))?.items.some((item) => item.kind === 'text' && item.markdown === 'Answer while away') ?? false, { timeout: 20_000 }).toBe(true)
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await expect(page.locator('.chat-host:visible .chat-text', { hasText: 'Answer while away' })).toHaveCount(1)
    // the column was at its end when the tab went away: it is at its end now
    await expect.poll(() => atBottom(page.locator('.chat-host:visible .chat-scroll'))).toBe(true)
  } finally {
    await app.close()
  }
})

test('a chat at its end is at its end when you come back from a shell tab', async () => {
  const { app, page, tabId, work } = await launchChatTab({ turns: { long: [{ text: LONG_TEXT }], more: [{ text: 'More text' }] } })
  try {
    await send(page, 'long')
    await waitForTurn(page, tabId, 'idle')
    await expect.poll(() => atBottom(page.locator(SCROLL))).toBe(true)
    await openTabInFront(page, 'shell', work)
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await expect(page.locator('.chat-host:visible .chat-text', { hasText: 'Paragraph 39' })).toHaveCount(1)
    await expect.poll(() => atBottom(page.locator('.chat-host:visible .chat-scroll')), { timeout: 3000 }).toBe(true)
    // and it still follows the chat: an answer that comes now is drawn at the end, in view
    await page.evaluate((id) => window.ct.chatSend(id, { text: 'more', attachments: [] }), tabId)
    await expect(page.locator('.chat-host:visible .chat-text', { hasText: 'More text' })).toHaveCount(1)
    await expect.poll(() => atBottom(page.locator('.chat-host:visible .chat-scroll')), { timeout: 3000 }).toBe(true)
  } finally {
    await app.close()
  }
})

test('a step that reads an image stays open until the turn moves on', async () => {
  const work = mkdtempSync(join(tmpdir(), 'ct-look-'))
  writeFileSync(join(work, 'shot.png'), PNG_1x1)
  const { app, page } = await launchChatTab({
    turns: {
      look: [
        // the calls run over 2 s, so the step opens by itself; it then stays open until the turn moves on
        { tool: { name: 'Read', input: { file_path: join(work, 'shot.png') }, result: '1\tpixel', ms: 2500 } },
        { wait: 3000 },
        { tool: { name: 'Bash', input: { command: 'npm test' }, result: 'ok', ms: 2500 } },
        { wait: 3000 },
        { text: 'It is a pixel.' }
      ]
    }
  }, { work })
  try {
    // every change of the step's card is recorded: whether it was folded, and whether the answer's text was drawn by then
    await page.evaluate(() => {
      const w = window as unknown as { __folds: { folded: boolean; text: boolean }[]; __observer: MutationObserver; __opened?: boolean }
      w.__folds = []
      w.__observer = new MutationObserver(() => {
        const steps = document.querySelector('.chat-steps')
        // a step is drawn folded before it opens by itself: the record starts at its first opening
        if (steps !== null && !steps.classList.contains('folded')) w.__opened = true
        if (steps !== null && w.__opened) w.__folds.push({ folded: steps.classList.contains('folded'), text: document.querySelector('.chat-text') !== null })
      })
      w.__observer.observe(document.querySelector('.chat-column')!, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
    })
    await send(page, 'look')
    const steps = page.locator('.chat-steps')
    // the Read is done and the turn waits for the next call: the step stays open
    await expect(page.locator('.chat-step-state.done')).toHaveCount(1, { timeout: 15_000 })
    await expect(steps).toHaveClass(/open/)
    // the Bash call joins the step, which is open while it runs and after it
    await expect(page.locator('.chat-step-row')).toHaveCount(2, { timeout: 15_000 })
    await expect(steps).toHaveClass(/open/)
    await expect(page.locator('.chat-step-state.done')).toHaveCount(2, { timeout: 15_000 })
    await expect(steps).toHaveClass(/open/)
    // the text that follows folds the step to its pill
    await expect(page.locator('.chat-text', { hasText: 'It is a pixel.' })).toHaveCount(1, { timeout: 15_000 })
    await expect(steps).toHaveClass(/folded/)
    const folds = await page.evaluate(() => (window as unknown as { __folds: { folded: boolean; text: boolean }[] }).__folds)
    expect(folds.some((f) => f.folded && !f.text)).toBe(false)
    expect(folds.some((f) => f.folded && f.text)).toBe(true)
  } finally {
    await app.close()
  }
})

test('the end stays in view when the composer grows', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { long: [{ text: LONG_TEXT }] } })
  try {
    await send(page, 'long')
    await waitForTurn(page, tabId, 'idle')
    await expect.poll(() => atBottom(page.locator(SCROLL))).toBe(true)
    // five lines typed in the composer with Shift+Enter: the composer grows, and the column's last item stays above it
    await page.locator(INPUT).click()
    await page.keyboard.type('one')
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type('line')
    }
    await expect.poll(() => page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>('.chat-scroll')!
      const items = document.querySelectorAll<HTMLElement>('.chat-column > [data-item]')
      return items[items.length - 1]!.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().bottom + 1
    })).toBe(true)
  } finally {
    await app.close()
  }
})

test('the end stays in view when lines are typed as an answer arrives', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { stream: [{ text: STREAM, chunks: 100, pace: 30 }] } })
  try {
    await send(page, 'stream')
    // the lines go in while the answer still streams: the composer grows as the column is growing
    await expect(page.locator('.chat-text.streaming')).toContainText('part5')
    await page.locator(INPUT).click()
    await page.keyboard.type('one')
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type('line')
    }
    await waitForTurn(page, tabId, 'idle')
    await expect.poll(() => page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>('.chat-scroll')!
      const items = document.querySelectorAll<HTMLElement>('.chat-column > [data-item]')
      return items[items.length - 1]!.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().bottom + 1
    })).toBe(true)
  } finally {
    await app.close()
  }
})

test('a hidden chat tab is not touched', async () => {
  // an answer of about 8 s: it is still streaming when the tab is hidden and when it is shown again
  const long = Array.from({ length: 200 }, (_, i) => `part${i}`).join(' ') + ' end-of-stream'
  const { app, page, tabId, work } = await launchChatTab({ turns: { stream: [{ text: long, chunks: 200, pace: 40 }] } })
  try {
    await send(page, 'stream')
    // the answer is on screen: the tab is switched away from while it streams
    await expect(page.locator('.chat-host:visible .chat-text.streaming')).toContainText('part5')
    // a second chat tab comes in front: the first one is hidden while its Claude goes on streaming
    await openTabInFront(page, 'claude', work)
    await page.evaluate(() => {
      const w = window as unknown as { __mutations: number }
      const hidden = Array.from(document.querySelectorAll<HTMLElement>('.chat-host')).find((host) => host.style.display === 'none')
      w.__mutations = 0
      new MutationObserver((records) => { w.__mutations += records.length })
        .observe(hidden!.querySelector('.chat-column')!, { childList: true, subtree: true, characterData: true, attributes: true })
    })
    // the answer goes on while the tab is hidden: its text grows in the snapshot the window holds
    await expect.poll(async () => (await snapshot(page, tabId))?.items.some((item) => item.kind === 'text' && item.markdown.includes('part100')) ?? false, { timeout: 15_000 }).toBe(true)
    expect(await page.evaluate(() => (window as unknown as { __mutations: number }).__mutations)).toBe(0)

    // the tab comes back: the streamed text is there, and it ends
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await expect(page.locator('.chat-host:visible .chat-column')).toContainText('end-of-stream', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('an image whose Media card was deleted shows no broken image', async () => {
  // the session's scratchpad is the watched folder: the hook's session message starts the watch, as Claude Code's does
  const temp = mkdtempSync(join(tmpdir(), 'ct-temp-'))
  const env: Record<string, string> = process.platform === 'win32' ? {} : { CLAUDE_CODE_TMPDIR: temp }
  const { app, page, pipeName, tabId, config } = await launchChatTab({ turns: { hello: [{ text: 'Hi there' }] } }, { env })
  try {
    await send(page, 'hello')
    await expect.poll(async () => (await snapshot(page, tabId))?.state.sessionId ?? null, { timeout: 30_000 }).not.toBeNull()
    const sid = (await snapshot(page, tabId))!.state.sessionId!
    const projects = join(config, 'projects')
    const transcriptPath = join(projects, readdirSync(projects).find((dir) => existsSync(join(projects, dir, `${sid}.jsonl`)))!, `${sid}.jsonl`)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: sid, source: 'startup', transcriptPath })).toEqual({ ok: true })
    const scratchpad = sessionTempDir(transcriptPath, sid, claudeTempRoot({ platform: process.platform, env, tmpdir: process.platform === 'win32' ? tmpdir() : temp, uid: process.getuid?.() ?? -1 }))
    await expect.poll(() => existsSync(scratchpad), { timeout: 10_000 }).toBe(true)
    // the watcher starts a moment after the folder is there
    await page.waitForTimeout(500)
    const png = join(scratchpad, 'shot.png')
    writeFileSync(png, PNG_1x1)
    await expect(page.locator('#image-panel .card')).toHaveCount(1, { timeout: 10_000 })
    // the picture goes with a message: its Media card makes it a thumbnail in the bubble
    await page.evaluate(async ([id, paths]) => {
      const attachments = await window.ct.chatAttach(id, paths)
      await window.ct.chatSend(id, { text: 'look at this', attachments })
    }, [tabId, [png]] as [string, string[]])
    await expect(page.locator('.chat-user-row .chat-thumb img')).toHaveCount(1, { timeout: 10_000 })
    // the file is deleted: its card is marked deleted, and the bubble shows the picture as a chip, with no image
    unlinkSync(png)
    await expect(page.locator('#image-panel .card.deleted')).toHaveCount(1, { timeout: 20_000 })
    await expect(page.locator('.chat-user-row .chat-thumb')).toHaveCount(0, { timeout: 20_000 })
    await expect(page.locator('.chat-column img')).toHaveCount(0)
    await expect(page.locator('.chat-user-row .chat-chip', { hasText: 'shot.png' })).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('a selection in a finished row survives another call\'s update', async () => {
  const { app, page } = await launchChatTab({
    turns: {
      two: [
        { tool: { name: 'Bash', input: { command: 'npm test' }, result: 'ok' } },
        { tool: { name: 'Bash', input: { command: 'npm run lint' }, result: 'ok', ms: 3000 } },
        // the turn goes on after the second call: the step stays open, and the text that follows would fold it
        { wait: 4000 },
        { text: 'Done.' }
      ]
    }
  })
  try {
    await send(page, 'two')
    await expect(page.locator('.chat-step-call')).toHaveCount(2, { timeout: 15_000 })
    // the second call runs over 2 s: the step opens by itself, and the selection is made in the open step
    await expect(page.locator('.chat-steps')).toHaveClass(/open/)
    await expect(page.locator('.chat-step-call').first().locator('.chat-step-state.done')).toHaveCount(1)
    // the user selects the first row's text while the second call runs
    await page.evaluate(() => {
      const range = document.createRange()
      range.selectNodeContents(document.querySelector('.chat-step-call .chat-tool-subject')!)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
    })
    const selected = await page.evaluate(() => window.getSelection()!.toString())
    expect(selected).toBe('npm test')
    // the second call ends: its row changes, the first row's text is the same selection
    await expect(page.locator('.chat-step-state.done')).toHaveCount(2, { timeout: 15_000 })
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selected)
  } finally {
    await app.close()
  }
})

test('a running subagent shows a sliding bar in its colour, and two running agents have different colours', async () => {
  const { app, page } = await launchChatTab({
    turns: {
      team: [{
        task: {
          description: 'Check the totals',
          result: 'Checked.',
          agents: [
            { type: 'Explore', description: 'Search the sales folder', ms: 6000 },
            { type: 'general-purpose', description: 'Check the totals', ms: 6000 }
          ]
        }
      }, { text: 'Done.' }]
    }
  })
  try {
    // the bar moves only with motion allowed: this machine can report reduced motion
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await send(page, 'team')
    const rows = page.locator('.chat-steps .chat-agent')
    await expect(rows).toHaveCount(2)
    const bars = page.locator('.chat-steps .chat-agent-bar')
    await expect(bars).toHaveCount(2)
    // the bar moves only in a step that is open: the running step opens itself once its calls have run 2 s
    await expect(page.locator('.chat-steps')).toHaveClass(/open/)
    // the card has no running time: the bar says the agent runs
    await expect(page.locator('.chat-steps .chat-agents')).not.toContainText('running')
    // each bar is in its row's colour, which is the top colour of the row's ring
    const colours = await rows.evaluateAll((els) => els.map((row) => {
      const ring = row.querySelector<HTMLElement>('.chat-ring')!
      const bar = row.querySelector<HTMLElement>('.chat-agent-bar')!
      return { ring: getComputedStyle(ring).borderTopColor, bar: getComputedStyle(bar).backgroundColor }
    }))
    expect(colours[0]!.bar).toBe(colours[0]!.ring)
    expect(colours[1]!.bar).toBe(colours[1]!.ring)
    expect(colours[0]!.bar).not.toBe(colours[1]!.bar)
    // the bar slides through its track
    const at = (): Promise<string> => bars.first().evaluate((el) => getComputedStyle(el).transform)
    const first = await at()
    await page.waitForTimeout(400)
    expect(await at()).not.toBe(first)
    // once the agent ends its row shows its time, and no bar
    await expect(rows.first()).toContainText('done · 6s', { timeout: 15_000 })
    await expect(rows.first().locator('.chat-agent-bar')).toHaveCount(0)
    await expect(rows.first().locator('.chat-agent-state')).not.toContainText('running')
  } finally {
    await app.close()
  }
})

test('under reduced motion the subagent ring and bar stand still, and the bar shows full width', async () => {
  const { app, page } = await launchChatTab({
    turns: {
      team: [{
        task: {
          description: 'Check the totals',
          result: 'Checked.',
          agents: [{ type: 'general-purpose', description: 'Check the totals', ms: 8000 }]
        }
      }, { text: 'Done.' }]
    }
  })
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await send(page, 'team')
    const bar = page.locator('.chat-steps .chat-agent-bar')
    await expect(bar).toHaveCount(1)
    expect(await bar.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    expect(await page.locator('.chat-steps .chat-agent .chat-ring').evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    const widths = await bar.evaluate((el) => [el.getBoundingClientRect().width, el.parentElement!.getBoundingClientRect().width])
    expect(widths[0]).toBeGreaterThanOrEqual(widths[1]! - 1)
  } finally {
    await app.close()
  }
})

test("a running subagent's bar is drawn again on a tab switch, in its colour", async () => {
  const { app, page, tabId, work } = await launchChatTab({
    turns: {
      team: [{
        task: {
          description: 'Check the totals',
          result: 'Checked.',
          agents: [{ type: 'general-purpose', description: 'Check the totals', ms: 8000 }]
        }
      }, { text: 'Done.' }]
    }
  })
  try {
    await send(page, 'team')
    const colour = (): Promise<string | undefined> => page.locator('.chat-steps .chat-agent-bar').first().evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => undefined)
    await expect(page.locator('.chat-steps .chat-agent-bar')).toHaveCount(1)
    const before = await colour()
    await openTabInFront(page, 'shell', work)
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    // drawn again on the switch: still running, still in the same colour
    await expect(page.locator('.chat-host:visible .chat-agent-bar')).toHaveCount(1)
    expect(await colour()).toBe(before)
  } finally {
    await app.close()
  }
})

test('an edit row of tests/index.ts reveals that file, not the root index.ts', async () => {
  // both files are large, so the review folds them: the revealed file unfolds, and the root file stays folded
  const repo = gitRepo()
  const lines = (tag: string): string => Array.from({ length: 1101 }, (_, i) => `${tag} ${i}`).join('\n') + '\n'
  mkdirSync(join(repo, 'tests'))
  writeFileSync(join(repo, 'index.ts'), 'root\n')
  writeFileSync(join(repo, 'tests', 'index.ts'), 'test\n')
  execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' })
  execFileSync('git', ['commit', '-qm', 'two files'], { cwd: repo, stdio: 'ignore' })
  writeFileSync(join(repo, 'index.ts'), lines('root'))
  writeFileSync(join(repo, 'tests', 'index.ts'), lines('test'))
  const { app, page } = await launchChatTab({
    turns: { edit: [{ tool: { name: 'Edit', input: { file_path: join(repo, 'tests', 'index.ts'), old_string: 'test 1', new_string: 'TEST 1' }, result: 'The file has been updated.' } }, { text: 'Done.' }] } }, { work: repo })
  try {
    await send(page, 'edit')
    await unfoldPill(page)
    await page.locator('.chat-step-row.edit').click()
    await expect(page.locator('.review-file[data-path="tests/index.ts"] .review-arrow')).toHaveText('▾')
    await expect(page.locator('.review-file[data-path="index.ts"] .review-arrow')).toHaveText('▸')
  } finally {
    await app.close()
  }
})

test('closing a chat with Find open leaves no highlights', async () => {
  const { app, page, tabId, work } = await launchChatTab({ turns: { 'limiter here': [{ text: 'Noted.' }] } })
  try {
    await send(page, 'limiter here')
    await waitForTurn(page, tabId, 'idle')
    // another tab in front and back, so the chat is in front again with its Find painting
    await openTabInFront(page, 'shell', work)
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await page.keyboard.press(KEYS.find)
    await page.locator('#search input').selectText()
    await page.keyboard.type('limiter')
    await expect.poll(() => highlightCount(page, 'chat-find')).toBe(1)
    await page.evaluate((id) => window.ct.closeTab(id), tabId)
    await expect.poll(() => highlightCount(page, 'chat-find')).toBe(0)
    expect(await highlightCount(page, 'chat-find-current')).toBe(0)
  } finally {
    await app.close()
  }
})

/** the number of ranges a CSS highlight of the page holds: 0 when the highlight is not set */
const highlightCount = (page: Page, name: string): Promise<number> => page.evaluate((n) => CSS.highlights.get(n)?.size ?? 0, name)

test('Find highlights matches and walks them', async () => {
  const { app, page, tabId } = await launchChatTab({
    turns: { 'limiter one': [{ text: 'Noted.' }], 'limiter two': [{ text: 'Noted.' }], 'limiter three': [{ text: 'Noted.' }] }
  })
  try {
    for (const text of ['limiter one', 'limiter two', 'limiter three']) {
      await send(page, text)
      await waitForTurn(page, tabId, 'idle')
    }
    await expect(page.locator('.chat-user')).toHaveCount(3)
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('limiter')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    // the search starts at the newest match and walks back: the third match is the oldest message
    await expect(page.locator('.chat-user', { hasText: 'limiter one' })).toBeInViewport()
    expect(await highlightCount(page, 'chat-find-current')).toBe(1)
    expect(await highlightCount(page, 'chat-find')).toBe(3)
  } finally {
    await app.close()
  }
})

test('Find reaches an item outside the DOM window', async () => {
  // 400 pairs: the first message is outside the DOM window and outside main's first page of items
  const { app, page } = await restoredLong(400)
  try {
    await expect(page.locator('.chat-user', { hasText: /^pair 0$/ })).toHaveCount(0)
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('pair 0')
    // typing searches the held items only: the page that holds the first message is asked for by Enter
    await page.keyboard.press('Enter')
    await expect(page.locator('.chat-user', { hasText: /^pair 0$/ })).toBeInViewport({ timeout: 30_000 })
    expect(await highlightCount(page, 'chat-find-current')).toBe(1)
  } finally {
    await app.close()
  }
})

test('closing Find clears the highlights', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { 'limiter here': [{ text: 'Noted.' }] } })
  try {
    await send(page, 'limiter here')
    await waitForTurn(page, tabId, 'idle')
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('limiter')
    await expect.poll(() => highlightCount(page, 'chat-find')).toBe(1)
    await page.keyboard.press('Escape')
    await expect(page.locator('#search')).toBeHidden()
    expect(await highlightCount(page, 'chat-find')).toBe(0)
    expect(await highlightCount(page, 'chat-find-current')).toBe(0)
  } finally {
    await app.close()
  }
})

test('text in the conversation can be selected and copied', { tag: '@alone' }, async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { 'copy this': [{ text: 'Copied text from Claude.' }] } })
  try {
    await send(page, 'copy this')
    await waitForTurn(page, tabId, 'idle')
    await keepingClipboard(app, async () => {
      await page.locator('.chat-text', { hasText: 'Copied text' }).click({ clickCount: 3 })
      await page.keyboard.press(KEYS.copy)
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Copied text from Claude.')
    })
  } finally {
    await app.close()
  }
})

/** the text of the item the current match is in; '' when there is no current match */
const currentItemText = (page: Page): Promise<string> => page.evaluate(() => {
  const current = CSS.highlights.get('chat-find-current')
  if (current === undefined || current.size === 0) return ''
  const range = [...current][0] as Range
  return range.startContainer.parentElement?.closest('[data-item]')?.textContent ?? ''
})

test('switching tab with Find open leaves no highlights on the chat left', async () => {
  const { app, page, tabId, work } = await launchChatTab({ turns: { 'limiter here': [{ text: 'Noted.' }] } })
  try {
    await send(page, 'limiter here')
    await waitForTurn(page, tabId, 'idle')
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('limiter')
    await expect.poll(() => highlightCount(page, 'chat-find')).toBe(1)
    // another tab comes in front with Find still open, then the chat is back
    await openTabInFront(page, 'shell', work)
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await expect(page.locator('.chat-host:visible .chat-user', { hasText: 'limiter here' })).toHaveCount(1)
    expect(await highlightCount(page, 'chat-find')).toBe(0)
    expect(await highlightCount(page, 'chat-find-current')).toBe(0)
  } finally {
    await app.close()
  }
})

test('typing does not pull older pages, Enter does', async () => {
  // 400 pairs: the term is in none of the held items, so only an Enter may ask main for the page before them
  const { app, page } = await restoredLong(400)
  try {
    await wrapOlder(app, 0)
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('zzz-no-such-word')
    // the as-you-type search waits 150 ms for the next key
    await page.waitForTimeout(600)
    expect(await olderCalls(app)).toBe(0)
    await page.keyboard.press('Enter')
    await expect.poll(() => olderCalls(app)).toBeGreaterThan(0)
  } finally {
    await app.close()
  }
})

test('Find opens a folded step to show its match', async () => {
  // the output's last line holds the word: the step is folded to its pill, and the word is past the lines its well shows
  const output = Array.from({ length: 20_000 }, (_, i) => (i === 19_999 ? 'line 19999 deep-marker-output' : 'x')).join('\n')
  const { app, page, tabId, pipeName } = await launchChatTab({
    turns: { big: [{ tool: { name: 'Bash', input: { command: 'cat deep.log' }, result: output } }, { text: 'Done.' }] }
  })
  try {
    await send(page, 'big')
    await waitForTurn(page, tabId, 'idle')
    await expect(page.locator('.chat-steps.folded')).toHaveCount(1, { timeout: 15_000 })
    // more than a window of items after the step: the step is out of the DOM window
    await sendDividers(pipeName, tabId, 130)
    await expect(page.locator('.chat-steps')).toHaveCount(0)
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('deep-marker-output')
    // Find lands on the step: it opens, its well shows the whole output, and the word is highlighted
    await expect.poll(() => highlightCount(page, 'chat-find-current')).toBe(1)
    await expect(page.locator('.chat-steps')).toHaveClass(/open/)
    const well = page.locator('.chat-well')
    await expect(well).toHaveClass(/unfolded/)
    expect(await well.locator('pre').textContent()).toContain('line 19999 deep-marker-output')
    expect(await highlightCount(page, 'chat-find')).toBe(1)
    // the step stays open once Find closes: the choice is the user's, as if they had opened it
    await page.keyboard.press('Escape')
    await expect(page.locator('#search')).toBeHidden()
    await expect(page.locator('.chat-steps')).toHaveClass(/open/)
    expect(await highlightCount(page, 'chat-find')).toBe(0)
  } finally {
    await app.close()
  }
})

test('Find skips a folded step whose only match is in a Read output no row draws', async () => {
  const { app, page, tabId } = await launchChatTab({
    turns: {
      'first question': [{ text: 'The parser handles ticks.' }],
      'second question': [{ tool: { name: 'Read', input: { file_path: 'notes.txt' }, result: 'parser internals' } }, { text: 'Done.' }]
    }
  })
  try {
    await send(page, 'first question')
    await waitForTurn(page, tabId, 'idle')
    await send(page, 'second question')
    await waitForTurn(page, tabId, 'idle')
    await expect(page.locator('.chat-steps.folded')).toHaveCount(1, { timeout: 15_000 })
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('parser')
    // the newer step holds the word only in the file its Read returned, which no row draws: Find lands on the older match
    await expect.poll(() => currentItemText(page)).toContain('The parser handles ticks.')
    await expect(page.locator('.chat-steps')).toHaveClass(/folded/)
  } finally {
    await app.close()
  }
})

test('Find finds a file name in a folded edit row', async () => {
  const { app, page, tabId, pipeName } = await launchChatTab({
    turns: { edit: [{ tool: { name: 'Edit', input: { file_path: join(tmpdir(), 'parser-edit.ts'), old_string: 'a', new_string: 'b' }, result: 'The file has been updated.' } }, { text: 'Done.' }] } })
  try {
    await send(page, 'edit')
    await waitForTurn(page, tabId, 'idle')
    await expect(page.locator('.chat-steps.folded')).toHaveCount(1)
    await sendDividers(pipeName, tabId, 130)
    await expect(page.locator('.chat-steps')).toHaveCount(0)
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('parser-edit.ts')
    await expect.poll(() => highlightCount(page, 'chat-find-current')).toBe(1)
    await expect(page.locator('.chat-steps')).toHaveClass(/open/)
    await expect(page.locator('.chat-step-row.edit', { hasText: 'parser-edit.ts' })).toBeVisible()
    expect(await currentItemText(page)).toContain('parser-edit.ts')
  } finally {
    await app.close()
  }
})

test('Find does not load the images of items it passes', async () => {
  const { app, page, tabId, pipeName } = await launchChatTab({ turns: {} })
  const dir = mkdtempSync(join(tmpdir(), 'ct-passed-'))
  const png = join(dir, 'shot.png')
  writeFileSync(png, PNG_1x1)
  try {
    await ready(page)
    await page.evaluate(async ([id, paths]) => {
      const attachments = await window.ct.chatAttach(id, paths)
      await window.ct.chatSend(id, { text: 'look at these', attachments })
    }, [tabId, [png]] as [string, string[]])
    // the picture has its Media card, so the bubble shows it as a thumbnail
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_image', tabId, path: png, caption: null })).toEqual({ ok: true })
    await expect(page.locator('.chat-user-row .chat-thumb img')).toHaveCount(1, { timeout: 10_000 })
    // more than a window of items below the bubble: it leaves the window
    await sendDividers(pipeName, tabId, 130)
    await expect(page.locator('.chat-user', { hasText: 'look at these' })).toHaveCount(0)
    // from here on, every image source set is recorded
    await page.evaluate(() => {
      const w = window as unknown as { __imageSources: string[] }
      w.__imageSources = []
      const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true,
        get() { return src.get!.call(this) },
        set(value: string) { w.__imageSources.push(String(value)); src.set!.call(this, value) }
      })
    })
    // the name of the picture is in the bubble's attachments, not in its text: the search passes the bubble without drawing it
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('shot')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(600)
    expect(await page.evaluate(() => (window as unknown as { __imageSources: string[] }).__imageSources.filter((s) => s.startsWith('ctimg')))).toEqual([])
    expect(await highlightCount(page, 'chat-find-current')).toBe(0)
  } finally {
    await app.close()
  }
})

test('Find in a 10 000-row table answers quickly', async () => {
  const rows = Array.from({ length: 10_000 }, (_, i) => `| row ${i} | value ${i * 3} |`)
  const table = ['| name | value |', '| --- | --- |', ...rows].join('\n')
  const { app, page, tabId } = await launchChatTab({ turns: { table: [{ text: table }] } })
  try {
    await send(page, 'table')
    await waitForTurn(page, tabId, 'idle')
    await expect(page.locator('.chat-text .chat-table')).toHaveCount(1, { timeout: 30_000 })
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('1')
    // the highlight is set within two seconds, and at most 1 000 ranges are highlighted
    await expect.poll(() => highlightCount(page, 'chat-find'), { timeout: 2_000 }).toBeGreaterThan(0)
    expect(await highlightCount(page, 'chat-find')).toBeLessThanOrEqual(1000)
  } finally {
    await app.close()
  }
})

test('a chat left in the background does not wipe the Find of the chat in front', async () => {
  const { app, page, tabId, work } = await launchChatTab({
    turns: { 'limiter here': [{ text: 'Noted.' }], 'limiter there': [{ text: 'Noted.' }] }
  })
  try {
    await send(page, 'limiter here')
    await waitForTurn(page, tabId, 'idle')
    // a Find in the first chat, then the second chat comes in front: the first chat's Find is kept, and its highlights go
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('limiter')
    await expect.poll(() => highlightCount(page, 'chat-find')).toBe(1)
    const front = await openTabInFront(page, 'claude', work)
    await page.evaluate((id) => window.ct.setTabView(id, 'chat'), front)
    await expect(page.locator('.chat-host:visible')).toHaveCount(1)
    // two chats are in the window: the message goes to the front one by its id
    await ready(page)
    await page.evaluate((id) => window.ct.chatSend(id, { text: 'limiter there', attachments: [] }), front)
    await waitForTurn(page, front, 'idle')
    await expect(page.locator('.chat-user', { hasText: 'limiter there' })).toHaveCount(1)
    await page.keyboard.press(KEYS.find)
    await page.locator('#search input').selectText()
    await page.keyboard.type('limiter')
    await expect.poll(() => highlightCount(page, 'chat-find')).toBe(1)
    // the first chat's view is changed in the background: its terminal is made, which shows it hidden
    await page.evaluate((id) => window.ct.setTabView(id, 'terminal'), tabId)
    await page.waitForTimeout(800)
    expect(await highlightCount(page, 'chat-find')).toBe(1)
    expect(await highlightCount(page, 'chat-find-current')).toBe(1)
  } finally {
    await app.close()
  }
})

test('typing a letter and deleting it stays on the same match', async () => {
  const { app, page, tabId } = await launchChatTab({
    turns: { 'limiter one': [{ text: 'Noted.' }], 'limiter two': [{ text: 'Noted.' }], 'limiter three': [{ text: 'Noted.' }] }
  })
  try {
    for (const text of ['limiter one', 'limiter two', 'limiter three']) {
      await send(page, text)
      await waitForTurn(page, tabId, 'idle')
    }
    await expect(page.locator('.chat-user')).toHaveCount(3)
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('limiter')
    await page.keyboard.press('Enter')
    expect(await currentItemText(page)).toContain('limiter two')
    // a letter typed and taken back before the as-you-type search runs: the term is the same, so the match stays
    await page.keyboard.type('x')
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(600)
    expect(await currentItemText(page)).toContain('limiter two')
  } finally {
    await app.close()
  }
})

test('Shift+Enter goes to the newer match', async () => {
  const { app, page, tabId } = await launchChatTab({
    turns: { 'limiter one': [{ text: 'Noted.' }], 'limiter two': [{ text: 'Noted.' }], 'limiter three': [{ text: 'Noted.' }] }
  })
  try {
    for (const text of ['limiter one', 'limiter two', 'limiter three']) {
      await send(page, text)
      await waitForTurn(page, tabId, 'idle')
    }
    await expect(page.locator('.chat-user')).toHaveCount(3)
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('limiter')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    expect(await currentItemText(page)).toContain('limiter one')
    await page.keyboard.press('Shift+Enter')
    expect(await currentItemText(page)).toContain('limiter two')
  } finally {
    await app.close()
  }
})

test('Find wraps from the oldest match to the newest', async () => {
  const { app, page, tabId } = await launchChatTab({
    turns: { 'limiter one': [{ text: 'Noted.' }], 'limiter two': [{ text: 'Noted.' }], 'limiter three': [{ text: 'Noted.' }] }
  })
  try {
    for (const text of ['limiter one', 'limiter two', 'limiter three']) {
      await send(page, text)
      await waitForTurn(page, tabId, 'idle')
    }
    await expect(page.locator('.chat-user')).toHaveCount(3)
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('limiter')
    for (let i = 0; i < 2; i++) await page.keyboard.press('Enter')
    expect(await currentItemText(page)).toContain('limiter one')
    await page.keyboard.press('Enter')
    expect(await currentItemText(page)).toContain('limiter three')
  } finally {
    await app.close()
  }
})

test('a new term cancels an older walk that is still running', async () => {
  const { app, page } = await restoredLong(400)
  try {
    // the page before the held items comes 1.5 s after its request
    await wrapOlder(app, 1500)
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('pair 0')
    await page.keyboard.press('Enter')
    // the walk is running: its request for the page before the held items is in
    await expect.poll(() => olderCalls(app)).toBe(1)
    for (let i = 0; i < 6; i++) await page.keyboard.press('Backspace')
    // a new term that the held items hold: its match lands first, so the walk's answer comes after a search that ran
    await page.keyboard.type('Hi there')
    await expect.poll(() => highlightCount(page, 'chat-find-current')).toBe(1)
    expect(await currentItemText(page)).toContain('Hi there')
    // the walk for 'pair 0' answers after the new term is in: it must not move the match of the new term
    await page.waitForTimeout(2500)
    expect(await olderCalls(app)).toBe(1)
    expect(await highlightCount(page, 'chat-find-current')).toBe(1)
    expect(await currentItemText(page)).toContain('Hi there')
  } finally {
    await app.close()
  }
})
