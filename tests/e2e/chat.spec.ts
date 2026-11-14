import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { ChatSnapshot } from '../../src/shared/chat'
import { chatStandIn, launchChatTab } from './chat-helpers'
import { KEYS, launchApp, processAlive } from './helpers'

const SCROLL = '.chat-scroll'
const INPUT = '.chat-input'
/** the header's way back to the view the settings give Claude tabs */
const BACK = '#sheet-header .sh-back'
const IDLE_PLACEHOLDER = 'Message Claude…'
const QUEUE_PLACEHOLDER = 'Queue a follow-up…'

interface Entry {
  pid?: number
  exit?: number
  in?: { type?: string; request?: { subtype?: string }; response?: { response?: Record<string, unknown> }; message?: { content?: unknown } }
  argv?: string[]
  overlap?: string
}

/** the tab shows its terminal, as a command the chat cannot run takes it there */
async function toTerminal(page: Page, tabId: string): Promise<void> {
  expect(await page.evaluate((id) => window.ct.setTabView(id, 'terminal'), tabId)).toBe(true)
}

/** Settings → Claude tabs show: the view every Claude tab follows */
async function showClaudeTabsIn(page: Page, view: 'chat' | 'terminal'): Promise<void> {
  expect(await page.evaluate((v) => window.ct.setSetting('claude.view', v), view)).toMatchObject({ ok: true })
}

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')

/** the texts of the user messages Claude Code received */
function userMessages(log: () => Record<string, unknown>[]): string[] {
  return (log() as Entry[])
    .filter((e) => e.in?.type === 'user')
    .map((e) => {
      const content = e.in!.message?.content
      if (typeof content === 'string') return content
      return Array.isArray(content) ? content.map((b: { text?: string }) => b.text ?? '').join('') : ''
    })
}

/** how many stream-json starts the stand-in logged: each process logs its argv, and a chat start names the input format */
function starts(log: () => Record<string, unknown>[]): number {
  return (log() as Entry[]).filter((e) => Array.isArray(e.argv) && e.argv.includes('--input-format')).length
}

/** the bodies of the control responses Claude Code received: the answers to its permission asks */
function responses(log: () => Record<string, unknown>[]): Record<string, unknown>[] {
  return (log() as Entry[])
    .filter((e) => e.in?.type === 'control_response')
    .map((e) => (e.in!.response?.response ?? {}))
}

/** the chat is ready: its process has answered the start, so a message is not refused as "not running" (no model yet: Claude Code names it in the first turn's init) */
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

async function snapshot(page: Page, tabId: string): Promise<ChatSnapshot | null> {
  return page.evaluate((id) => window.ct.chatSnapshot(id), tabId)
}

async function waitForTurn(page: Page, tabId: string, turn: 'idle' | 'working' | 'waiting'): Promise<void> {
  await expect.poll(async () => (await snapshot(page, tabId))?.state.turn ?? null, { timeout: 15_000 }).toBe(turn)
}

const atBottom = (scroll: Locator): Promise<boolean> => scroll.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)

/** closes the window, which keeps the tabs in the session snapshot of the data folder */
async function closeWindow(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
  await closed
}

test('a message is sent and the answer streams in', async () => {
  const { app, page } = await launchChatTab({ turns: { hello: [{ text: 'Hi there' }] } })
  try {
    await send(page, 'hello')
    await expect(page.locator('.chat-user', { hasText: 'hello' })).toHaveCount(1)
    await expect(page.locator('.chat-column')).toContainText('Hi there')
  } finally {
    await app.close()
  }
})

test('a new chat shows no Starting and no divider before the first message', async () => {
  const { app, page, pipeName, tabId } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    const before = await snapshot(page, tabId)
    expect(before?.items).toEqual([])
    expect(before?.state).toMatchObject({ exited: false, turn: 'idle' })
    // Claude Code's SessionStart for the session the chat started with reaches the tab: the id is not new, so no divider
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: before!.state.sessionId!, source: 'startup', transcriptPath: null })).toEqual({ ok: true })
    expect((await snapshot(page, tabId))?.items).toEqual([])
  } finally {
    await app.close()
  }
})

test('a chat tab has no terminal', async () => {
  const { app, page } = await launchChatTab({ turns: {} })
  try {
    await expect(page.locator('.chat-host')).toBeVisible()
    await expect(page.locator('#terminals .terminal-host')).toHaveCount(0)
    // the header has no Chat | Terminal switch: the tab shows the view of the settings
    await expect(page.locator('#sheet-header .sh-mode:visible')).toHaveCount(0)
    const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
    await toTerminal(page, tabId)
    await expect(page.locator('#terminals .terminal-host')).toHaveCount(1)
    await expect(page.locator(BACK)).toHaveText('Back to chat')
    await page.locator(BACK).click()
    await expect(page.locator('#terminals .terminal-host')).toHaveCount(0)
    await expect(page.locator('.chat-host')).toBeVisible()
    await expect(page.locator(BACK)).toBeHidden()
  } finally {
    await app.close()
  }
})

test('Enter on empty text sends nothing, Shift+Enter makes a new line', async () => {
  const { app, page, log } = await launchChatTab({ turns: {} })
  try {
    await page.locator(INPUT).click()
    await page.keyboard.press('Enter')
    await page.keyboard.type('a')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('b')
    await expect(page.locator(INPUT)).toHaveValue('a\nb')
    expect(userMessages(log)).toEqual([])
  } finally {
    await app.close()
  }
})

test('the composer says what Enter will do', async () => {
  const { app, page } = await launchChatTab({ turns: { wait: [{ wait: 3000 }] } })
  try {
    await expect(page.locator(INPUT)).toHaveAttribute('placeholder', IDLE_PLACEHOLDER)
    await send(page, 'wait')
    await expect(page.locator(INPUT)).toHaveAttribute('placeholder', QUEUE_PLACEHOLDER)
    await expect(page.locator(INPUT)).toHaveAttribute('placeholder', IDLE_PLACEHOLDER, { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('the column sticks to the bottom unless scrolled up', async () => {
  const { app, page } = await launchChatTab({ turns: { long: [{ text: lines(80), chunks: 8 }], again: [{ text: lines(80), chunks: 8 }] } })
  try {
    const scroll = page.locator(SCROLL)
    await send(page, 'long')
    await expect(page.locator('.chat-text', { hasText: 'line 79' })).toHaveCount(1)
    expect(await atBottom(scroll)).toBe(true)

    await scroll.evaluate((el) => { el.scrollTop = 0 })
    await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(0)
    await send(page, 'again')
    await expect(page.locator('.chat-text', { hasText: 'line 79' })).toHaveCount(2)
    expect(await scroll.evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(1)
  } finally {
    await app.close()
  }
})

test('a question card is answered, or skipped', async () => {
  const question = 'Which color?'
  const input = { questions: [{ question, header: 'Color', multiSelect: false, options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }] }] }
  const { app, page, log } = await launchChatTab({
    turns: {
      pick: [{ ask: { tool: 'AskUserQuestion', input }, allowed: [{ text: 'Blue it is.' }], denied: [] }],
      skip: [{ ask: { tool: 'AskUserQuestion', input }, allowed: [], denied: [{ text: 'No answer.' }] }]
    }
  })
  try {
    await send(page, 'pick')
    // a click picks the option; Submit sends it
    await page.locator('.chat-card button', { hasText: 'Blue' }).click()
    await page.locator('.chat-card button', { hasText: 'Submit' }).click()
    await expect(page.locator('.chat-card.answered')).toHaveCount(1)
    await expect(page.locator('.chat-card button')).toHaveCount(0)
    expect(responses(log).some((r) => JSON.stringify((r.updatedInput as { answers?: unknown } | undefined)?.answers) === JSON.stringify({ [question]: 'Blue' }))).toBe(true)

    // a skipped question goes on without an answer: the empty answer is sent
    await send(page, 'skip')
    await page.locator('.chat-card button', { hasText: 'Skip' }).click()
    await expect(page.locator('.chat-card.answered')).toHaveCount(2)
    expect(responses(log).some((r) => JSON.stringify((r.updatedInput as { answers?: unknown } | undefined)?.answers) === JSON.stringify({ [question]: '' }))).toBe(true)
  } finally {
    await app.close()
  }
})

test('a plan card approves or keeps planning', async () => {
  const input = { plan: '1. Read the code' }
  const { app, page, log } = await launchChatTab({
    turns: {
      approve: [{ ask: { tool: 'ExitPlanMode', input }, allowed: [{ text: 'Approved.' }], denied: [] }],
      keep: [{ ask: { tool: 'ExitPlanMode', input }, allowed: [], denied: [{ text: 'Still planning.' }] }]
    }
  })
  try {
    await send(page, 'approve')
    await page.locator('.chat-card button', { hasText: 'Approve and accept edits' }).click()
    await expect(page.locator('.chat-card.answered')).toHaveCount(1)
    expect(responses(log).some((r) => JSON.stringify(r.updatedPermissions) === JSON.stringify([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]))).toBe(true)

    await send(page, 'keep')
    await page.locator('.chat-card button', { hasText: 'Keep planning' }).click()
    await expect(page.locator('.chat-card.answered')).toHaveCount(2)
    expect(responses(log).some((r) => r.behavior === 'deny' && r.message === 'Keep planning.')).toBe(true)
  } finally {
    await app.close()
  }
})

test('a dialog says the chat cannot show it, and opens the terminal', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { ask: [{ dialog: 'example' }, { text: 'done' }] } })
  try {
    await send(page, 'ask')
    await expect(page.locator('.chat-notice', { hasText: 'Claude Code asked something the chat cannot show yet' })).toHaveCount(1)
    await waitForTurn(page, tabId, 'idle')
    await page.locator('.chat-notice button', { hasText: 'Open in the terminal' }).click()
    await expect(page.locator('#terminals .terminal-host')).toBeVisible()
    await expect(page.locator(BACK)).toHaveText('Back to chat')
  } finally {
    await app.close()
  }
})

test('a tab with background tasks keeps its view when the setting changes, and its way back asks first', async () => {
  const { app, page, pipeName, tabId } = await launchChatTab({ turns: { hello: [{ text: 'Hi there' }] } })
  try {
    await send(page, 'hello')
    await expect(page.locator('.chat-column')).toContainText('Hi there')
    await waitForTurn(page, tabId, 'idle')
    const sessionId = (await snapshot(page, tabId))!.state.sessionId!
    const task = { id: 'b1', type: 'shell', description: 'Run the e2e suite', command: 'npx playwright test' }
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', background: true, tasks: [task] })).toEqual({ ok: true })

    // the window must know the task before the switch: a click before that switches at once
    await expect(page.locator('#statusbar .status-background')).toContainText('1 in background: Run the e2e suite')
    // the setting says terminal: a switch would stop the task, so the tab stays in its chat and offers the way
    await showClaudeTabsIn(page, 'terminal')
    await expect(page.locator(BACK)).toHaveText('Back to terminal')
    await expect(page.locator('.chat-host:visible')).toHaveCount(1)
    await page.locator(BACK).click()
    await expect(page.locator('.sh-mode-confirm')).toBeVisible()
    // the row holds its buttons too: the question is what it says
    await expect(page.locator('.sh-mode-confirm')).toContainText('1 background task will stop. Switch anyway?')
    await page.locator('.sh-mode-confirm button', { hasText: 'Cancel' }).click()
    await expect(page.locator('.sh-mode-confirm')).toBeHidden()
    await expect(page.locator('.chat-host:visible')).toHaveCount(1)

    await page.locator(BACK).click()
    await page.locator('.sh-mode-confirm button', { hasText: 'Switch' }).click()
    await expect(page.locator('#terminals .terminal-host:visible')).toHaveCount(1)
    await expect(page.locator(BACK)).toBeHidden()
  } finally {
    await app.close()
  }
})

test('Send from a panel goes to the chat as a message', async () => {
  const { app, page, tabId, log } = await launchChatTab({ turns: { 'Look at a.ts': [{ text: 'Looking.' }] } })
  try {
    await ready(page)
    await page.evaluate((id) => window.__ct!.sendText!(id, 'Look at a.ts'), tabId)
    await expect.poll(() => userMessages(log)).toContain('Look at a.ts')
    await expect(page.locator('.chat-user', { hasText: 'Look at a.ts' })).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('Esc interrupts a running turn', async () => {
  const { app, page, tabId, log } = await launchChatTab({ turns: { wait: [{ wait: 10_000 }] } })
  try {
    await send(page, 'wait')
    await waitForTurn(page, tabId, 'working')
    // the composer takes Esc as a stop once it has the turn's state
    await expect(page.locator(INPUT)).toHaveAttribute('placeholder', QUEUE_PLACEHOLDER)
    await page.locator(INPUT).click()
    await page.keyboard.press('Escape')
    await expect.poll(() => (log() as Entry[]).some((e) => e.in?.type === 'control_request' && e.in.request?.subtype === 'interrupt')).toBe(true)
  } finally {
    await app.close()
  }
})

test('a permission card allows once and denies', async () => {
  const input = { command: 'ls' }
  const { app, page, log } = await launchChatTab({
    turns: {
      run: [{ ask: { tool: 'Bash', input }, allowed: [{ text: 'Listed.' }], denied: [] }],
      again: [{ ask: { tool: 'Bash', input }, allowed: [], denied: [{ text: 'Skipped.' }] }]
    }
  })
  try {
    await send(page, 'run')
    await page.locator('.chat-card button', { hasText: 'Allow once' }).click()
    await expect(page.locator('.chat-card.answered')).toHaveCount(1)
    expect(responses(log).some((r) => r.behavior === 'allow')).toBe(true)

    await send(page, 'again')
    await page.locator('.chat-card button', { hasText: 'Deny' }).click()
    await expect(page.locator('.chat-card.answered')).toHaveCount(2)
    expect(responses(log).some((r) => r.behavior === 'deny')).toBe(true)
  } finally {
    await app.close()
  }
})

test('the setting switches the open tab to the terminal and back, and the conversation goes on', async () => {
  const { app, page, tabId, log } = await launchChatTab({ turns: { hello: [{ text: 'Hi there' }] } })
  try {
    await send(page, 'hello')
    await expect(page.locator('.chat-column')).toContainText('Hi there')
    await waitForTurn(page, tabId, 'idle')
    const sessionId = (await snapshot(page, tabId))!.state.sessionId!

    await showClaudeTabsIn(page, 'terminal')
    await expect(page.locator('#terminals .terminal-host')).toBeVisible()
    await expect.poll(() => page.evaluate((id) => window.__ct!.bufferText(id), tabId)).toContain(`--resume ${sessionId}`)
    // the tab shows the view of the settings: no way back to offer
    await expect(page.locator(BACK)).toBeHidden()

    await showClaudeTabsIn(page, 'chat')
    await expect(page.locator('.chat-user', { hasText: 'hello' })).toHaveCount(1)
    await expect(page.locator('.chat-column')).toContainText('Hi there')
    await expect.poll(() => (log() as Entry[]).some((e) => Array.isArray(e.argv) && e.argv.some((a, i) => a === '--resume' && e.argv![i + 1] === sessionId))).toBe(true)
    expect((log() as Entry[]).some((e) => e.overlap !== undefined)).toBe(false)
  } finally {
    await app.close()
  }
})

test('a tab that works when the setting changes switches once its answer ends; its way back is off meanwhile', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { wait: [{ wait: 6000 }] } })
  try {
    await send(page, 'wait')
    await waitForTurn(page, tabId, 'working')
    await showClaudeTabsIn(page, 'terminal')
    await expect(page.locator(BACK)).toHaveText('Back to terminal')
    await expect(page.locator(BACK)).toBeDisabled()
    await expect(page.locator(BACK)).toHaveAttribute('title', 'Claude is working — switch when it finishes, or press Esc to stop it')
    await expect(page.locator('.chat-host:visible')).toHaveCount(1)
    // the answer ends: the tab follows the setting by itself
    await expect(page.locator('#terminals .terminal-host:visible')).toHaveCount(1, { timeout: 20_000 })
    await expect(page.locator(BACK)).toBeHidden()
  } finally {
    await app.close()
  }
})

test('many tabs that fall back show their reason once', async () => {
  // a restore brings back the Claude tabs that have a session: each tab takes a turn, which gives it one.
  // Two chat tabs keep two composers in the page: the visible one is the active tab's
  const composer = `${INPUT}:visible`
  const first = await launchChatTab({ turns: { hello: [{ text: 'Hi there' }] } })
  await send(first.page, 'hello')
  await waitForTurn(first.page, first.tabId, 'idle')
  await first.page.locator(composer).click()
  await first.page.keyboard.press(KEYS.newClaudeTab)
  await first.page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await ready(first.page)
  await first.page.locator(composer).click()
  await first.page.keyboard.type('hello')
  await first.page.keyboard.press('Enter')
  await expect(first.page.locator('.chat-column:visible')).toContainText('Hi there')
  await waitForTurn(first.page, await first.page.evaluate(() => window.__ct!.activeTabId()) as string, 'idle')
  await closeWindow(first.app)

  // both chat tabs are restored with a Claude Code too old for chat: each falls back to its terminal
  const oldScript = join(mkdtempSync(join(tmpdir(), 'ct-old-')), 'script.json')
  writeFileSync(oldScript, JSON.stringify({ turns: {}, version: '2.1.100' }))
  const second = await launchApp({ dataDir: first.dataDir, env: { CLAUDE_CONFIG_DIR: first.config, FAKE_CLAUDE_SCRIPT: oldScript } })
  try {
    await expect.poll(() => second.page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
    await second.page.locator('.banner-restore').click()
    await second.page.waitForFunction(() => window.__ct!.tabIds().length === 2)
    // each tab's terminal has started: the stand-in's echo is in its buffer
    await expect.poll(() => second.page.evaluate(async () => {
      const ids = window.__ct!.tabIds()
      return ids.every((id) => window.__ct!.bufferText(id).includes('fake-claude'))
    }), { timeout: 15_000 }).toBe(true)
    await expect(second.page.locator('.toast', { hasText: 'this is 2.1.100' })).toHaveCount(1)
    await second.page.waitForTimeout(500)
    await expect(second.page.locator('.toast', { hasText: 'this is 2.1.100' })).toHaveCount(1)
  } finally {
    await second.app.close()
  }
})

test('a restored chat tab opens in chat with its history', async () => {
  const first = await launchChatTab({ turns: { hello: [{ text: 'Hi there' }] } })
  await send(first.page, 'hello')
  await expect(first.page.locator('.chat-column')).toContainText('Hi there')
  await waitForTurn(first.page, first.tabId, 'idle')
  await closeWindow(first.app)

  // the same data folder and Claude Code config: the snapshot names the chat tab, its transcript holds the history
  const second = await launchApp({ dataDir: first.dataDir, env: { CLAUDE_CONFIG_DIR: first.config } })
  try {
    await expect.poll(() => second.page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
    await second.page.locator('.banner-restore').click()
    await second.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
    await expect(second.page.locator('.chat-host:visible')).toHaveCount(1)
    await expect(second.page.locator('.chat-user', { hasText: 'hello' })).toHaveCount(1)
    await expect(second.page.locator('.chat-column')).toContainText('Hi there')
  } finally {
    await second.app.close()
  }
})

test('scrolling to the top brings older items', async () => {
  const first = await launchChatTab({ turns: { hello: [{ text: 'Hi there' }] } })
  await send(first.page, 'hello')
  await expect(first.page.locator('.chat-column')).toContainText('Hi there')
  await waitForTurn(first.page, first.tabId, 'idle')
  const sid = (await snapshot(first.page, first.tabId))!.state.sessionId!
  await closeWindow(first.app)

  // 300 prompts before the conversation's first line: the chat shows its newest 200 items, the rest come on scrolling up
  const projects = join(first.config, 'projects')
  const file = join(projects, readdirSync(projects).find((dir) => existsSync(join(projects, dir, `${sid}.jsonl`)))!, `${sid}.jsonl`)
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
  const older = Array.from({ length: 300 }, (_, i) => JSON.stringify({
    parentUuid: i === 0 ? null : `old-${i - 1}`, isSidechain: false, type: 'user', uuid: `old-${i}`, sessionId: sid,
    timestamp: '2026-10-08T09:00:00.000Z', message: { role: 'user', content: `old ${i}` }
  }))
  lines[0] = JSON.stringify({ ...(JSON.parse(lines[0]) as Record<string, unknown>), parentUuid: 'old-299' })
  writeFileSync(file, [...older, ...lines].join('\n') + '\n')

  const second = await launchApp({ dataDir: first.dataDir, env: { CLAUDE_CONFIG_DIR: first.config } })
  try {
    await expect.poll(() => second.page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
    await second.page.locator('.banner-restore').click()
    await second.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
    await expect(second.page.locator('.chat-user', { hasText: 'old 299' })).toHaveCount(1)
    await expect(second.page.locator('.chat-user', { hasText: 'old 0' })).toHaveCount(0)

    // the window holds 120 items: each scroll to the top brings a page of the items above, until the first message shows.
    // The walk runs inside the page, a frame at a time, so the older pages are read without a round trip per page
    await second.page.evaluate(async () => {
      const scroll = document.querySelector<HTMLElement>('.chat-scroll')!
      const frame = (): Promise<void> => new Promise((resolve) => { requestAnimationFrame(() => resolve()); setTimeout(resolve, 50) })
      const shown = (): boolean => Array.from(document.querySelectorAll('.chat-user')).some((n) => n.textContent === 'old 0')
      for (let i = 0; i < 1500 && !shown(); i++) {
        scroll.scrollTop = 0
        await frame()
      }
    })
    await expect(second.page.locator('.chat-user', { hasText: /^old 0$/ })).toHaveCount(1)
  } finally {
    await second.app.close()
  }
})

test('an untrusted folder opens in the terminal and says why', async () => {
  const { app, page } = await launchChatTab({ turns: {} }, { trusted: false })
  try {
    await expect(page.locator('.toast', { hasText: 'has not been told to trust' })).toHaveCount(1)
    await expect(page.locator(BACK)).toHaveText('Back to chat')
    await expect(page.locator('#terminals .terminal-host')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('an old Claude Code opens in the terminal and says why', async () => {
  const { app, page } = await launchChatTab({ turns: {} }, { version: '2.1.100' })
  try {
    await expect(page.locator('.toast', { hasText: 'this is 2.1.100' })).toHaveCount(1)
    await expect(page.locator(BACK)).toHaveText('Back to chat')
  } finally {
    await app.close()
  }
})

test('Claude Code stopping shows Restart, and Restart starts it again', async () => {
  const { app, page, log } = await launchChatTab({ turns: { hello: [{ text: 'Hi there' }] }, beforeInit: [{ crash: 1, once: true }] })
  try {
    await expect(page.locator('.chat-notice', { hasText: 'Claude Code stopped' })).toHaveCount(1)
    // one start only: the crash is not followed by a restart loop, the stand-in waits for Restart
    expect(starts(log)).toBe(1)
    // a message to the stopped chat is refused, and the composer keeps the text
    await page.locator(INPUT).click()
    await page.keyboard.type('x')
    await page.keyboard.press('Enter')
    await expect(page.locator('.chat-refusal', { hasText: 'Claude Code is not running in this tab' })).toHaveCount(1)
    await expect(page.locator(INPUT)).toHaveValue('x')
    await page.locator(INPUT).fill('')
    await page.locator('.chat-notice button', { hasText: 'Restart' }).click()
    await send(page, 'hello')
    await expect(page.locator('.chat-column')).toContainText('Hi there')
  } finally {
    await app.close()
  }
})

test('closing a chat tab in the middle of a turn ends its Claude Code, and the app stays up', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { wait: [{ wait: 10_000 }] } })
  try {
    // a second tab keeps the app up when the chat tab closes
    await page.locator('.tab-new').click()
    await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
    await page.locator('.tab').first().click()
    await send(page, 'wait')
    await waitForTurn(page, tabId, 'working')
    // the session id is on the stand-in's command line only: it names this one process
    const sessionId = (await snapshot(page, tabId))!.state.sessionId!
    expect(processAlive(sessionId)).toBe(true)

    await page.locator('.tab').first().click({ button: 'right' })
    await page.locator('.menu-item', { hasText: 'Close tab' }).click()
    await expect.poll(() => page.evaluate(() => window.__ct!.tabIds().length)).toBe(1)
    await expect.poll(() => processAlive(sessionId), { timeout: 15_000 }).toBe(false)
    // the window is still there with the second tab
    expect(await page.evaluate(() => window.__ct!.tabIds().length)).toBe(1)
  } finally {
    await app.close()
  }
})

test('closing a chat tab ends the processes Claude Code started', async () => {
  const marker = `ct-child-${randomUUID()}`
  const { app, page, tabId } = await launchChatTab({ turns: { wait: [{ child: marker }, { wait: 30_000 }] } })
  try {
    // a second tab keeps the app up when the chat tab closes
    await page.locator('.tab-new').click()
    await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
    await page.locator('.tab').first().click()
    await send(page, 'wait')
    await waitForTurn(page, tabId, 'working')
    // the child is started by the stand-in: its command line carries the marker
    await expect.poll(() => processAlive(marker)).toBe(true)

    await page.locator('.tab').first().click({ button: 'right' })
    await page.locator('.menu-item', { hasText: 'Close tab' }).click()
    await expect.poll(() => page.evaluate(() => window.__ct!.tabIds().length)).toBe(1)
    await expect.poll(() => processAlive(marker), { timeout: 10_000 }).toBe(false)
  } finally {
    await app.close()
  }
})

test('a slow chat exit holds the terminal back: never two processes on one session', async () => {
  // the stand-in keeps running 1.5 s after its input ends, within the engine's close grace: a slow but graceful exit, which the tab manager waits for before the terminal starts
  const { app, page, tabId, log } = await launchChatTab({ turns: { hello: [{ text: 'Hi there' }, { lingerMs: 1500 }] } })
  try {
    await send(page, 'hello')
    await expect(page.locator('.chat-column')).toContainText('Hi there')
    await waitForTurn(page, tabId, 'idle')
    const sessionId = (await snapshot(page, tabId))!.state.sessionId!

    await toTerminal(page, tabId)
    await expect.poll(() => page.evaluate((id) => window.__ct!.bufferText(id), tabId)).toContain(`--resume ${sessionId}`)
    const entries = log() as Entry[]
    const chat = entries.find((e) => Array.isArray(e.argv) && e.argv.includes('--input-format'))!
    const chatExit = entries.findIndex((e) => e.exit !== undefined && e.pid === chat.pid)
    const terminalStart = entries.findIndex((e) => Array.isArray(e.argv) && !e.argv.includes('--input-format') && e.argv.includes('--resume'))
    expect(chatExit).toBeGreaterThanOrEqual(0)
    expect(terminalStart).toBeGreaterThan(chatExit)
    expect(entries.some((e) => e.overlap !== undefined)).toBe(false)
  } finally {
    await app.close()
  }
})

test('reduced motion: the chat has no running animation', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { wait: [{ wait: 8000 }] } })
  try {
    await send(page, 'wait')
    await waitForTurn(page, tabId, 'working')
    const animated = (): Promise<boolean> => page.evaluate(() => [...document.querySelectorAll('.chat-host *')].some((el) => getComputedStyle(el).animationName !== 'none'))
    await expect.poll(animated).toBe(true)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect.poll(animated).toBe(false)
  } finally {
    await app.close()
  }
})

test('a message typed at once is not lost', async () => {
  // no wait for the chat to run: the message is typed while Claude Code starts
  const { app, page, log } = await launchChatTab({ turns: { hello: [{ text: 'Hi there' }] } })
  try {
    await page.locator(INPUT).click()
    await page.keyboard.type('hello')
    await page.keyboard.press('Enter')
    await expect(page.locator('.chat-user', { hasText: 'hello' })).toHaveCount(1)
    // the start (Claude Code answering initialize) is inside this wait, so it gets the start allowance
    await expect(page.locator('.chat-column')).toContainText('Hi there', { timeout: 15_000 })
    expect(userMessages(log)).toContain('hello')
  } finally {
    await app.close()
  }
})

test('a late PTY chunk does not build a terminal in a chat tab', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: {} })
  try {
    await expect(page.locator('.chat-host')).toBeVisible()
    // output of the terminal the tab had before its switch, still in flight, arrives in the chat view
    await app.evaluate(({ BrowserWindow }, [channel, id]) => { BrowserWindow.getAllWindows()[0].webContents.send(channel, id, 'late output') }, ['ev:pty-data', tabId])
    await page.waitForTimeout(500)
    await expect(page.locator('#terminals .terminal-host')).toHaveCount(0)
    await expect(page.locator('.chat-host')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('an app shortcut works while the composer has focus', async () => {
  const { app, page } = await launchChatTab({ turns: {} })
  try {
    await page.locator(INPUT).click()
    await page.keyboard.press(KEYS.newTab)
    await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  } finally {
    await app.close()
  }
})

test('the composer keeps its own copy: the app\'s copy chord leaves its text alone', async () => {
  const { app, page } = await launchChatTab({ turns: {} })
  try {
    await page.locator(INPUT).click()
    await page.keyboard.type('abc')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+KeyA' : 'Control+KeyA')
    await page.keyboard.press(KEYS.copy)
    await expect(page.locator(INPUT)).toHaveValue('abc')
  } finally {
    await app.close()
  }
})

test('AltGr characters type in the composer and switch no tab', async () => {
  const { app, page } = await launchChatTab({ turns: {} })
  try {
    await page.locator(INPUT).click()
    await page.keyboard.press(KEYS.newClaudeTab)
    await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
    const before = await page.evaluate(() => window.__ct!.activeTabId())
    const composer = page.locator(`${INPUT}:visible`)
    await composer.click()
    // Windows sends AltGr+7 on a German layout as Ctrl+Alt with the character { ; the event is synthetic, so it types nothing here
    const prevented = await composer.evaluate((el) => {
      const e = new KeyboardEvent('keydown', { key: '{', code: 'Digit7', ctrlKey: true, altKey: true, modifierAltGraph: true, bubbles: true, cancelable: true })
      el.dispatchEvent(e)
      return e.defaultPrevented
    })
    expect(prevented).toBe(false)
    expect(await page.evaluate(() => window.__ct!.activeTabId())).toBe(before)
    await expect(composer).toBeFocused()
  } finally {
    await app.close()
  }
})

test('a send that fails keeps the text', async () => {
  const { app, page, log } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('keep me')
    // the main process's handler for the next send throws once, as a failed IPC call does; the real handler is put back after it
    await app.evaluate(({ ipcMain }) => {
      const channel = 'chat:send'
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> })._invokeHandlers
      const real = handlers.get(channel)!
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, (event, ...args) => real(event, ...args))
        throw new Error('the pipe is closed')
      })
    })
    await page.keyboard.press('Enter')
    await expect(page.locator('.chat-refusal').filter({ hasText: 'Could not send:' }).filter({ hasText: 'the pipe is closed' })).toHaveCount(1)
    await expect(page.locator(INPUT)).toHaveValue('keep me')
    expect(userMessages(log)).toEqual([])
  } finally {
    await app.close()
  }
})

test('after a switch to the terminal and back, the chat shows new answers', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { hello: [{ text: 'Hi there' }], again: [{ text: 'Second answer' }] } })
  try {
    await send(page, 'hello')
    await expect(page.locator('.chat-column')).toContainText('Hi there')
    await waitForTurn(page, tabId, 'idle')

    await toTerminal(page, tabId)
    await expect(page.locator('#terminals .terminal-host')).toBeVisible()
    await page.locator(BACK).click()
    await expect(page.locator('.chat-user', { hasText: 'hello' })).toHaveCount(1)

    await send(page, 'again')
    // read what the column draws: the answer is in it, and the working line goes when the turn ends
    await expect(page.locator('.chat-column')).toContainText('Second answer')
    await expect(page.locator('.chat-working')).toBeHidden({ timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('after Restart the chat shows new answers', async () => {
  const { app, page } = await launchChatTab({
    turns: { hello: [{ text: 'Hi there' }, { crash: 1, once: true }], again: [{ text: 'Second answer' }] },
  })
  try {
    await send(page, 'hello')
    await expect(page.locator('.chat-column')).toContainText('Hi there')
    await expect(page.locator('.chat-notice', { hasText: 'Claude Code stopped' })).toHaveCount(1)

    await page.locator('.chat-notice button', { hasText: 'Restart' }).click()
    await send(page, 'again')
    await expect(page.locator('.chat-column')).toContainText('Second answer')
    await expect(page.locator('.chat-working')).toBeHidden({ timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('the Agent SDK is not loaded until a chat tab starts', async () => {
  const stand = chatStandIn({ turns: {} })
  const { app, page } = await launchApp({ settings: stand.settings, env: stand.env })
  try {
    await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
    const sdkLoaded = (): Promise<unknown> => app.evaluate(() => (globalThis as { ctChatSdkLoaded?: boolean }).ctChatSdkLoaded)
    // the first tab is a shell tab, and its prompt is up: the start-up is over, and nothing of the chat has started
    await expect.poll(() => page.evaluate(() => window.__ct!.bufferText(window.__ct!.activeTabId()!).trim().length > 0), { timeout: 15_000 }).toBe(true)
    expect(await sdkLoaded()).not.toBe(true)
    expect(await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd, view: 'chat' }), stand.work)).not.toBeNull()
    await expect.poll(sdkLoaded, { timeout: 15_000 }).toBe(true)
  } finally {
    await app.close()
  }
})
