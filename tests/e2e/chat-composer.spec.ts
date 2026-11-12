import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { deflateSync } from 'node:zlib'
import { join } from 'node:path'
import { CONTINUE_DELAY_MS, CONTINUE_PROMPT } from '../../src/main/auto-continue'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { PipeMessage } from '../../src/shared/protocol'
import type { ChatSnapshot } from '../../src/shared/chat'
import { launchChatTab } from './chat-helpers'
import { keepingClipboard, openTabInFront, PNG_1x1 } from './helpers'

// the composer of the chat in front: a tab's hidden chat keeps its own composer in the page
const INPUT = '.chat-host:visible .chat-input'
const COLUMN = '.chat-host:visible .chat-column'
const MODE_CHIP = '.chat-host:visible .chat-mode-chip'
const MODEL_CHIP = '.chat-host:visible .chat-model-chip'
const SEND = '.chat-host:visible .chat-send'
const STOP = '.chat-host:visible .chat-stop'
const ATTACHED = '.chat-host:visible .chat-attached'
const REFUSAL = '.chat-host:visible .chat-refusal'
const WAITING = '.chat-host:visible .chat-waiting'
const QUEUE_PLACEHOLDER = 'Queue a follow-up…'
// the composer's own key for a paste: Ctrl V, or Cmd V on macOS
const PASTE_KEY = process.platform === 'darwin' ? 'Meta+V' : 'Control+V'
const SESSION = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

interface UserEntry { message?: { content?: unknown } }

/** the user messages as Claude Code received them */
function userEntries(log: () => Record<string, unknown>[]): UserEntry[] {
  return (log() as { in?: { type?: string; message?: UserEntry['message'] } }[])
    .filter((e) => e.in?.type === 'user')
    .map((e) => e.in as UserEntry)
}

/** the texts of the user messages Claude Code received */
function userMessages(log: () => Record<string, unknown>[]): string[] {
  return userEntries(log).map((e) => {
    const content = e.message?.content
    if (typeof content === 'string') return content
    return Array.isArray(content) ? content.map((b: { text?: string }) => b.text ?? '').join('') : ''
  })
}

/** the modes Claude Code was asked for, in order */
function modeRequests(log: () => Record<string, unknown>[]): string[] {
  return (log() as { in?: { request?: { subtype?: string; mode?: string } } }[])
    .filter((e) => e.in?.request?.subtype === 'set_permission_mode')
    .map((e) => e.in!.request!.mode!)
}

/** the chat is ready: its process has answered the start, so a message is not refused as "not running" */
async function ready(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const s = await window.ct.chatSnapshot(window.__ct!.activeTabId()!)
    return s !== null && !s.state.exited && !s.items.some((item) => item.kind === 'notice' && item.text === 'Starting Claude…')
  }), { timeout: 15_000 }).toBe(true)
}

async function snapshot(page: Page, tabId: string): Promise<ChatSnapshot | null> {
  return page.evaluate((id) => window.ct.chatSnapshot(id), tabId)
}

async function waitForTurn(page: Page, tabId: string, turn: 'idle' | 'working' | 'waiting'): Promise<void> {
  await expect.poll(async () => (await snapshot(page, tabId))?.state.turn ?? null, { timeout: 15_000 }).toBe(turn)
}

async function send(page: Page, text: string): Promise<void> {
  await ready(page)
  await page.locator(INPUT).click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/** drops files on the chat's sheet, as a drag from the desktop does: real files, so the window knows their paths */
async function dropFiles(page: Page, files: string[]): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('drop-source')?.remove()
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'drop-source'
    input.multiple = true
    input.hidden = true
    document.body.append(input)
  })
  await page.locator('#drop-source').setInputFiles(files)
  await page.locator('.chat-host:visible').evaluate((host) => {
    const input = document.getElementById('drop-source') as HTMLInputElement
    const data = new DataTransfer()
    for (const file of Array.from(input.files!)) data.items.add(file)
    host.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
  })
}

/** a file in the work folder, its real path (the window's paths are real) */
function workFile(work: string, name: string, content: string | Buffer): string {
  const file = join(realpathSync.native(work), name)
  writeFileSync(file, content)
  return file
}

/**
 * The main process's handler for a channel, replaced for the test: it counts its calls (`count`, a global of the main
 * process), waits `delay` ms, then throws `error` when given, else answers `answer` when given, else with the real handler's
 * answer. The app is closed by the test, so the handler is not put back.
 */
async function stubIpc(app: ElectronApplication, channel: string, s: { delay?: number; answer?: unknown; error?: string; count?: string }): Promise<void> {
  await app.evaluate(({ ipcMain }, { channel, s }) => {
    const g = globalThis as unknown as Record<string, number>
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> })._invokeHandlers
    const real = handlers.get(channel)!
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      if (s.count !== undefined) g[s.count] = (g[s.count] ?? 0) + 1
      if (s.delay) await new Promise((r) => setTimeout(r, s.delay))
      if (s.error !== undefined) throw new Error(s.error)
      return s.answer !== undefined ? s.answer : real(event, ...args)
    })
  }, { channel, s })
}

/** the calls of a stubbed channel so far */
const callsOf = (app: ElectronApplication, name: string): Promise<number> =>
  app.evaluate((_, key) => (globalThis as unknown as Record<string, number>)[key] ?? 0, name)

/** a cut-off response, as the StopFailure hook reports it: auto-continue's own input */
const cutOff = (tabId: string): PipeMessage => ({ v: 1, type: 'attention', tabId, sessionId: SESSION, reason: 'done', error: 'server_error' })

test('Enter sends, Shift+Enter is a new line', async () => {
  const { app, page, log } = await launchChatTab({ turns: { 'line one\nline two': [{ text: 'two lines received' }] } })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('line one')
    await page.keyboard.press('Shift+Enter')
    await expect(page.locator(INPUT)).toHaveValue('line one\n')
    await page.keyboard.type('line two')
    await page.keyboard.press('Enter')
    await expect.poll(() => userMessages(log)).toEqual(['line one\nline two'])
    await expect(page.locator(INPUT)).toHaveValue('')
    await expect(page.locator(COLUMN)).toContainText('two lines received')
  } finally {
    await app.close()
  }
})

test('a queued message leaves the queue when Claude Code folds it into the running turn', async () => {
  // the turn reads the message sent after it starts; its first answer names it as taken into the turn, and the turn goes on
  const { app, page, tabId } = await launchChatTab({
    turns: { slow: [{ wait: 2500 }, { fold: true }, { text: 'noted' }, { wait: 60_000 }], next: [{ text: 'next answer' }] }
  })
  try {
    await send(page, 'slow')
    await waitForTurn(page, tabId, 'working')
    await page.locator(INPUT).click()
    await page.keyboard.type('next')
    await page.keyboard.press('Enter')
    await expect(page.locator('.chat-user-row.queued')).toContainText('Queued')
    // the answer names the message: its bubble is no longer queued, while the turn still works
    await expect(page.locator(COLUMN)).toContainText('noted')
    await expect(page.locator('.chat-user-row.queued')).toHaveCount(0, { timeout: 15_000 })
    await waitForTurn(page, tabId, 'working')
    // the turn's last step waits a minute: Esc stops it, as the other tests of a long turn do
    await page.locator(INPUT).click()
    await page.keyboard.press('Escape')
  } finally {
    await app.close()
  }
})

test('a send folded into the turn on its result leaves the queue, and the working line hides when the turn ends', async () => {
  // the send waits while the turn runs; the turn's result names it as taken into the turn, so no turn of its own runs it
  const { app, page, tabId } = await launchChatTab({
    turns: { slow: [{ wait: 2500 }, { fold: 'result' }, { text: 'noted' }], next: [{ text: 'next answer' }] }
  })
  try {
    await send(page, 'slow')
    await waitForTurn(page, tabId, 'working')
    await page.locator(INPUT).click()
    await page.keyboard.type('next')
    await page.keyboard.press('Enter')
    await expect(page.locator('.chat-user-row.queued')).toContainText('Queued')
    await waitForTurn(page, tabId, 'idle')
    await expect(page.locator('.chat-user-row.queued')).toHaveCount(0)
    await expect(page.locator('.chat-working')).toBeHidden()
    await expect(page.locator(COLUMN)).not.toContainText('next answer')
  } finally {
    await app.close()
  }
})

test('after Esc, the message waiting behind the interrupted turn is no longer queued at once, and its turn goes on', async () => {
  // the next turn's first frame comes 3 s after its start: the bubble must leave the queue before it, as Claude Code takes the message at once
  const { app, page, tabId } = await launchChatTab({
    turns: { slow: [{ wait: 60_000 }], next: [{ wait: 3000 }, { text: 'next answer' }] }
  })
  try {
    await send(page, 'slow')
    await waitForTurn(page, tabId, 'working')
    await page.locator(INPUT).click()
    await page.keyboard.type('next')
    await page.keyboard.press('Enter')
    await expect(page.locator('.chat-user-row.queued')).toContainText('Queued')
    await page.keyboard.press('Escape')
    await expect(page.locator(COLUMN)).toContainText('Interrupted')
    await expect(page.locator('.chat-user-row.queued')).toHaveCount(0, { timeout: 1500 })
    await expect(page.locator(COLUMN)).toContainText('next answer', { timeout: 15_000 })
    await waitForTurn(page, tabId, 'idle')
  } finally {
    await app.close()
  }
})

test('a held Esc sends one interrupt: the repeated keydowns of a held key do nothing', async () => {
  const { app, page, tabId, log } = await launchChatTab({ turns: { slow: [{ wait: 60_000 }] } })
  const interrupts = (): number => (log() as { in?: { request?: { subtype?: string } } }[]).filter((e) => e.in?.request?.subtype === 'interrupt').length
  try {
    await send(page, 'slow')
    await waitForTurn(page, tabId, 'working')
    await page.locator(INPUT).click()
    // one fresh Esc and the two repeats a held key sends, all while the turn still runs
    await page.locator(INPUT).evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true, cancelable: true }))
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true, bubbles: true, cancelable: true }))
    })
    await expect.poll(interrupts).toBe(1)
    await waitForTurn(page, tabId, 'idle')
    expect(interrupts()).toBe(1)
  } finally {
    await app.close()
  }
})

test('the model chip shows the effort Claude Code runs the chat at, without a pick in /model', async () => {
  // the init, which names the effort in effect, comes with the first turn: the chip shows it with the model, though nothing was picked
  const { app, page, tabId } = await launchChatTab({ model: 'claude-opus-5-5', effort: 'high', turns: { hi: [{ text: 'hello' }] } })
  try {
    await ready(page)
    await send(page, 'hi')
    await waitForTurn(page, tabId, 'idle')
    await expect(page.locator(MODEL_CHIP)).toContainText('· high')
  } finally {
    await app.close()
  }
})

test('the model chip shows the effort that get_settings reports when the init names none', async () => {
  // a Claude Code that is not a Remote Control host leaves the effort out of the init: the chat reads it from the settings it applies
  const { app, page } = await launchChatTab({ model: 'claude-opus-5-5', appliedEffort: 'xhigh', turns: { hi: [{ text: 'hello' }] } })
  try {
    await ready(page)
    await expect(page.locator(MODEL_CHIP)).toContainText('· xhigh')
  } finally {
    await app.close()
  }
})

test('a message sent while Claude works is queued until its turn', async () => {
  const { app, page, tabId } = await launchChatTab({
    turns: { slow: [{ text: 'slow answer', chunks: 6, pace: 300 }], next: [{ text: 'next answer' }] }
  })
  try {
    await send(page, 'slow')
    await waitForTurn(page, tabId, 'working')
    await expect(page.locator(INPUT)).toHaveAttribute('placeholder', QUEUE_PLACEHOLDER)
    await page.locator(INPUT).click()
    await page.keyboard.type('next')
    await page.keyboard.press('Enter')
    await expect(page.locator('.chat-user-row.queued')).toContainText('Queued')
    // its turn comes: the bubble is no longer queued, and its answer is drawn
    await expect(page.locator('.chat-user-row.queued')).toHaveCount(0, { timeout: 15_000 })
    await expect(page.locator('.chat-quiet', { hasText: 'Queued' })).toHaveCount(0)
    await expect(page.locator(COLUMN)).toContainText('next answer')
  } finally {
    await app.close()
  }
})

test('↑ recalls earlier messages', async () => {
  const { app, page } = await launchChatTab({ turns: { first: [{ text: 'one' }], second: [{ text: 'two' }] } })
  try {
    await send(page, 'first')
    await expect(page.locator(COLUMN)).toContainText('one')
    await send(page, 'second')
    await expect(page.locator(COLUMN)).toContainText('two')
    await page.locator(INPUT).click()
    await page.keyboard.press('ArrowUp')
    await expect(page.locator(INPUT)).toHaveValue('second')
    await page.keyboard.press('ArrowUp')
    await expect(page.locator(INPUT)).toHaveValue('first')
    await page.keyboard.press('ArrowDown')
    await expect(page.locator(INPUT)).toHaveValue('second')
    await page.keyboard.press('ArrowDown')
    await expect(page.locator(INPUT)).toHaveValue('')
  } finally {
    await app.close()
  }
})

test('history skips empty texts, and ↑ moves the caret between the lines of a recalled message', async () => {
  const { app, page, work } = await launchChatTab({ turns: { first: [{ text: 'one' }], 'line a\nline b': [{ text: 'two' }] } })
  try {
    await send(page, 'first')
    await expect(page.locator(COLUMN)).toContainText('one')
    // a message of attachments only has no text: it is not an earlier message to recall
    await dropFiles(page, [workFile(work, 'notes.txt', 'notes')])
    await expect(page.locator(ATTACHED)).toHaveCount(1)
    await page.locator(INPUT).click()
    await page.keyboard.press('Enter')
    await expect(page.locator(ATTACHED)).toHaveCount(0)
    await page.keyboard.type('line a')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('line b')
    await page.keyboard.press('Enter')
    await expect(page.locator(COLUMN)).toContainText('two')
    // ↑ on an empty field recalls the two-line message; its caret is on the last line, so the next ↑ only moves it up
    await page.keyboard.press('ArrowUp')
    await expect(page.locator(INPUT)).toHaveValue('line a\nline b')
    await page.keyboard.press('ArrowUp')
    await expect(page.locator(INPUT)).toHaveValue('line a\nline b')
    await page.keyboard.press('ArrowUp')
    await expect(page.locator(INPUT)).toHaveValue('first')
  } finally {
    await app.close()
  }
})

test('Esc stops the turn, Esc again clears the draft and its files', async () => {
  const { app, page, tabId, work } = await launchChatTab({ turns: { slow: [{ text: 'slow answer', chunks: 8, pace: 400 }] } })
  try {
    await send(page, 'slow')
    await waitForTurn(page, tabId, 'working')
    await page.locator(INPUT).click()
    await page.keyboard.type('half')
    await dropFiles(page, [workFile(work, 'notes.txt', 'notes')])
    await expect(page.locator(ATTACHED)).toHaveCount(1)
    await page.locator(INPUT).press('Escape')
    await waitForTurn(page, tabId, 'idle')
    // the first Esc only stopped the turn: the draft is still there; the window shows the turn over before the second Esc
    await expect(page.locator(INPUT)).toHaveValue('half')
    await expect(page.locator(ATTACHED)).toHaveCount(1)
    await expect(page.locator(INPUT)).toHaveAttribute('placeholder', 'Message Claude…')
    await page.locator(INPUT).press('Escape')
    await expect(page.locator(INPUT)).toHaveValue('')
    await expect(page.locator(ATTACHED)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('while a card waits for an answer, Esc clears the draft and does not stop the turn; the line says so', async () => {
  const { app, page, tabId } = await launchChatTab({
    turns: { ask: [{ ask: { tool: 'Bash', input: { command: 'ls' } }, allowed: [], denied: [] }] }
  })
  try {
    await send(page, 'ask')
    await waitForTurn(page, tabId, 'waiting')
    await expect(page.locator(WAITING)).toHaveText('Claude is waiting for your answer')
    await expect(page.locator(WAITING)).toHaveAttribute('role', 'status')
    await page.locator(INPUT).click()
    await page.keyboard.type('draft')
    await page.locator(INPUT).press('Escape')
    await expect(page.locator(INPUT)).toHaveValue('')
    // the turn it belongs to is still waiting: Esc did not interrupt it
    expect((await snapshot(page, tabId))?.state.turn).toBe('waiting')
  } finally {
    await app.close()
  }
})

test('Shift+Tab cycles the mode and Claude Code hears it', async () => {
  const { app, page, log } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.press('Shift+Tab')
    await expect(page.locator(MODE_CHIP)).toContainText('Accept edits')
    await expect.poll(() => modeRequests(log)).toEqual(['acceptEdits'])
  } finally {
    await app.close()
  }
})

test('a chat that starts in Auto keeps Auto among its modes: Shift+Tab comes back round to it', async () => {
  // Claude Code says it runs in auto mode only in its answer to the start, after the composer asked for the modes
  const { app, page, log } = await launchChatTab({ permissionMode: 'auto', turns: {} })
  try {
    await ready(page)
    await expect(page.locator(MODE_CHIP)).toContainText('Auto')
    await page.locator(INPUT).click()
    for (const label of ['Ask before edits', 'Accept edits', 'Plan', 'Auto']) {
      await page.keyboard.press('Shift+Tab')
      await expect(page.locator(MODE_CHIP)).toContainText(label)
    }
    await expect.poll(() => modeRequests(log)).toEqual(['default', 'acceptEdits', 'plan', 'auto'])
  } finally {
    await app.close()
  }
})

test('a model that runs auto mode lets Shift+Tab reach Auto before any message, and Claude Code hears it', async () => {
  // the models Claude Code lists say which run auto mode: the chat runs the default one, which does
  const { app, page, log } = await launchChatTab({
    autoMode: true,
    models: [
      { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5', supportedEffortLevels: [], supportsAutoMode: true },
      { value: 'haiku', displayName: 'Haiku 5.5', description: 'Fastest for quick answers', supportedEffortLevels: [] },
    ],
    turns: {},
  })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    for (const label of ['Accept edits', 'Plan', 'Auto']) {
      await page.keyboard.press('Shift+Tab')
      await expect(page.locator(MODE_CHIP)).toContainText(label)
    }
    await expect.poll(() => modeRequests(log)).toEqual(['acceptEdits', 'plan', 'auto'])
  } finally {
    await app.close()
  }
})

test('a chat whose first init reports Auto, with a models list that does not mark its model: after an answer, cycling away from Auto and back reaches Auto', async () => {
  // the initialize reply says the chat starts in default; the first turn's init says auto, and the models do not say auto mode
  const { app, page, log, tabId } = await launchChatTab({ initPermissionMode: 'auto', turns: { hi: [{ text: 'hello' }] } })
  try {
    await send(page, 'hi')
    await waitForTurn(page, tabId, 'idle')
    await expect(page.locator(MODE_CHIP)).toContainText('Auto')
    await page.locator(INPUT).click()
    for (const label of ['Ask before edits', 'Accept edits', 'Plan', 'Auto']) {
      await page.keyboard.press('Shift+Tab')
      await expect(page.locator(MODE_CHIP)).toContainText(label)
    }
    await expect.poll(() => modeRequests(log)).toEqual(['default', 'acceptEdits', 'plan', 'auto'])
  } finally {
    await app.close()
  }
})

test('two quick Shift+Tab presses advance twice, before the first answer comes back', async () => {
  const { app, page, log } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => modeRequests(log)).toEqual(['acceptEdits', 'plan'])
  } finally {
    await app.close()
  }
})

test('two Shift+Tab presses made before the modes have loaded both apply, in order', async () => {
  const { app, page, log } = await launchChatTab({ turns: {} })
  try {
    await stubIpc(app, 'chat:modes', { delay: 1500 })
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => modeRequests(log), { timeout: 15_000 }).toEqual(['acceptEdits', 'plan'])
  } finally {
    await app.close()
  }
})

test('the model the person picks decides whether Auto is offered: a model that runs auto mode brings Auto into the modes', async () => {
  // the chat starts on the first model, which does not run auto mode; the person picks the second one, which does
  const { app, page } = await launchChatTab({
    autoMode: true,
    models: [
      { value: 'opus', displayName: 'Opus 5.5', description: 'For complex work', supportedEffortLevels: [] },
      { value: 'haiku', displayName: 'Haiku 5.5', description: 'Fastest for quick answers', supportedEffortLevels: [], supportsAutoMode: true },
    ],
    turns: {},
  })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    // Shift+Tab cycles the three modes this model offers: Auto is not among them
    for (const label of ['Accept edits', 'Plan', 'Ask before edits']) {
      await page.keyboard.press('Shift+Tab')
      await expect(page.locator(MODE_CHIP)).toContainText(label)
    }
    // the person picks the model that runs auto mode in the model picker
    await page.locator(MODEL_CHIP).click()
    const picker = page.locator('.chat-host:visible .chat-model-picker')
    await picker.locator('.chat-model-option', { hasText: 'Haiku 5.5' }).click()
    await picker.locator('button', { hasText: 'Apply' }).click()
    await expect(picker).toBeHidden()
    await expect(page.locator(MODEL_CHIP)).toContainText('Haiku 5.5')
    // Auto is among the modes now: Shift+Tab reaches it
    await page.locator(INPUT).click()
    for (const label of ['Accept edits', 'Plan', 'Auto']) {
      await page.keyboard.press('Shift+Tab')
      await expect(page.locator(MODE_CHIP)).toContainText(label)
    }
  } finally {
    await app.close()
  }
})

test('the model chip reads Model before the first turn, then the model', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { hi: [{ text: 'hello' }] } })
  try {
    await ready(page)
    await expect(page.locator(MODEL_CHIP)).toContainText('Model')
    await send(page, 'hi')
    await waitForTurn(page, tabId, 'idle')
    await expect(page.locator(MODEL_CHIP)).not.toContainText('Model')
    await expect(page.locator(MODEL_CHIP)).toContainText(/haiku/i)
  } finally {
    await app.close()
  }
})

test('the attach menu offers the files and the pasted image, and Esc closes it', async () => {
  const { app, page } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await page.locator('.chat-host:visible [aria-label="Attach a file or image"]').click()
    const menu = page.locator('.chat-host:visible .chat-menu')
    await expect(menu).toBeVisible()
    await expect(menu.locator('.chat-menu-item').nth(0)).toHaveText('Files on this computer…')
    await expect(menu.locator('.chat-menu-item').nth(1)).toContainText('Paste an image')
    await expect(menu.locator('.chat-kbd')).toHaveText(process.platform === 'darwin' ? '⌘V' : 'Ctrl V')
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
  } finally {
    await app.close()
  }
})

test('a Ctrl chord types nothing into the composer, and a plain / types a slash', async () => {
  const { app, page } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.press('Control+/')
    await expect(page.locator(INPUT)).toHaveValue('')
    await page.keyboard.press('/')
    await expect(page.locator(INPUT)).toHaveValue('/')
  } finally {
    await app.close()
  }
})

test('Send is enabled only with something to send: an attachment alone goes as its mention', async () => {
  const { app, page, log, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await expect(page.locator(SEND)).toBeDisabled()
    await dropFiles(page, [workFile(work, 'notes.txt', 'notes')])
    await expect(page.locator(SEND)).toBeEnabled()
    await page.locator(INPUT).click()
    await page.keyboard.press('Enter')
    await expect.poll(() => userMessages(log)).toEqual(['@notes.txt'])
    await expect(page.locator(SEND)).toBeDisabled()
  } finally {
    await app.close()
  }
})

test('dropped files become chips and go as mentions', async () => {
  const { app, page, log, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await dropFiles(page, [workFile(work, 'notes.txt', 'notes')])
    await expect(page.locator(ATTACHED, { hasText: 'notes.txt' })).toHaveCount(1)
    await page.locator(INPUT).click()
    await page.keyboard.type('read it')
    await page.keyboard.press('Enter')
    await expect.poll(() => userMessages(log)).toEqual(['read it\n\n@notes.txt'])
    await expect(page.locator(ATTACHED)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a chip shows the name and its size, and ✕ removes it', async () => {
  const { app, page, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await dropFiles(page, [workFile(work, 'notes-1k.txt', 'x'.repeat(1024))])
    const chip = page.locator(ATTACHED, { hasText: 'notes-1k.txt' })
    await expect(chip).toHaveCount(1)
    await expect(chip).toContainText('1 KB')
    await chip.locator('[aria-label="Remove notes-1k.txt"]').click()
    await expect(page.locator(ATTACHED)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('the same file dropped twice is one chip', async () => {
  const { app, page, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    const file = workFile(work, 'notes.txt', 'notes')
    await dropFiles(page, [file])
    await expect(page.locator(ATTACHED)).toHaveCount(1)
    await dropFiles(page, [file])
    await expect(page.locator(ATTACHED)).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('an image chip shows its thumbnail through ctimg://', async () => {
  const { app, page, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await dropFiles(page, [workFile(work, 'pic.png', PNG_1x1)])
    await expect(page.locator(`${ATTACHED} .chat-attached-thumb`)).toHaveAttribute('src', /^ctimg:\/\//, { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('Enter waits for a file still being attached, so the message goes with it', async () => {
  const { app, page, log, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await stubIpc(app, 'chat:attach', { delay: 1500 })
    await dropFiles(page, [workFile(work, 'notes.txt', 'notes')])
    await page.locator(INPUT).click()
    await page.keyboard.type('with file')
    await page.keyboard.press('Enter')
    await expect.poll(() => userMessages(log), { timeout: 15_000 }).toEqual(['with file\n\n@notes.txt'])
    await expect(page.locator(ATTACHED)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('Esc during the wait for an attach cancels the send: a file that lands after the Esc is not in the next message', async () => {
  const { app, page, log, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await stubIpc(app, 'chat:attach', { delay: 1500 })
    await dropFiles(page, [workFile(work, 'notes.txt', 'notes')])
    await page.locator(INPUT).click()
    await page.keyboard.type('with file')
    await page.keyboard.press('Enter')
    await page.locator(INPUT).press('Escape')
    await expect(page.locator(INPUT)).toHaveValue('')
    // the next message goes alone: the file that lands late is not sent with it, nor put in the cleared draft
    await page.keyboard.type('marker')
    await page.keyboard.press('Enter')
    await expect.poll(() => userMessages(log), { timeout: 15_000 }).toEqual(['marker'])
    await expect(page.locator(ATTACHED)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a refused attach during the wait cancels the send: the refusal shows and the draft stays', async () => {
  const { app, page, log, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await stubIpc(app, 'chat:attach', { delay: 1000, error: 'the file is gone' })
    await dropFiles(page, [workFile(work, 'notes.txt', 'notes')])
    await page.locator(INPUT).click()
    await page.keyboard.type('with file')
    await page.keyboard.press('Enter')
    await expect(page.locator(REFUSAL)).toContainText('Could not attach:')
    await expect(page.locator(REFUSAL)).toContainText('the file is gone')
    await expect(page.locator(INPUT)).toHaveValue('with file')
    expect(userMessages(log)).toEqual([])
  } finally {
    await app.close()
  }
})

test('a refused attachment says why and keeps the draft', async () => {
  const { app, page, log, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    const big = workFile(work, 'big.bin', Buffer.alloc(31 * 1024 * 1024))
    await dropFiles(page, [big])
    await expect(page.locator(ATTACHED, { hasText: 'big.bin' })).toHaveCount(1)
    await page.locator(INPUT).click()
    await page.keyboard.type('look at this')
    await page.keyboard.press('Enter')
    await expect(page.locator(REFUSAL)).toHaveText('big.bin is over 30 MB')
    await expect(page.locator(REFUSAL)).toHaveAttribute('role', 'alert')
    await expect(page.locator(REFUSAL)).toHaveCSS('color', 'rgb(242, 134, 126)')
    await expect(page.locator(INPUT)).toHaveValue('look at this')
    await expect(page.locator(ATTACHED, { hasText: 'big.bin' })).toHaveCount(1)
    expect(userMessages(log)).toEqual([])
  } finally {
    await app.close()
  }
})

test('a pasted image file is attached as a chip, without the clipboard', async () => {
  const { app, page, log } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    // main saves the clipboard's image to a file and answers with its path: the test answers with a file of its own
    const saved = join(mkdtempSync(join(tmpdir(), 'ct-paste-')), 'pasted.png')
    writeFileSync(saved, PNG_1x1)
    await app.evaluate(({ ipcMain }, path) => {
      ipcMain.removeHandler('clipboard:save-image')
      ipcMain.handle('clipboard:save-image', () => path)
    }, saved)
    await page.locator(INPUT).click()
    await page.locator(INPUT).evaluate((el, b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const data = new DataTransfer()
      data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, PNG_1x1.toString('base64'))
    await expect(page.locator(ATTACHED, { hasText: 'pasted.png' })).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect.poll(() => userEntries(log).length).toBe(1)
    const content = userEntries(log)[0].message!.content as { type?: string }[]
    expect(content.some((b) => b.type === 'image')).toBe(true)
  } finally {
    await app.close()
  }
})

test('the draft stays with its tab', async () => {
  const { app, page, tabId, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('draft for the first tab')
    const second = await openTabInFront(page, 'claude', work)
    await expect(page.locator(INPUT)).toHaveValue('')
    await page.locator(INPUT).click()
    await page.keyboard.type('draft for the second tab')
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await expect(page.locator(INPUT)).toHaveValue('draft for the first tab')
    await page.evaluate((id) => window.ct.activateTab(id), second)
    await expect(page.locator(INPUT)).toHaveValue('draft for the second tab')
  } finally {
    await app.close()
  }
})

test('a multi-line draft keeps its height when its tab was hidden while a refusal came back', async () => {
  const { app, page, tabId, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    // the send is refused a moment later, while the tab is no longer in front
    await stubIpc(app, 'chat:send', { delay: 1500, answer: 'Claude Code is not running in this tab' })
    await page.locator(INPUT).click()
    await page.keyboard.type('line one')
    for (const line of ['line two', 'line three', 'line four']) {
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type(line)
    }
    const tall = await page.locator(INPUT).evaluate((el) => el.clientHeight)
    await page.keyboard.press('Enter')
    await openTabInFront(page, 'shell', work)
    await page.waitForTimeout(2000)
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await expect(page.locator(INPUT)).toHaveValue('line one\nline two\nline three\nline four')
    await expect.poll(() => page.locator(INPUT).evaluate((el) => el.clientHeight)).toBe(tall)
    expect(tall).toBeGreaterThan(80)
  } finally {
    await app.close()
  }
})

test('auto-continue asks the composer: a draft holds the continue back, an empty composer lets it go', async () => {
  const { app, page, tabId, work, pipeName, log } = await launchChatTab({ turns: {} }, { autoContinue: true })
  try {
    await ready(page)
    // a background tab marks the end of a turn that auto-continue did not continue: that is the sign the check is done
    const row = page.locator(`[data-tab-id="${tabId}"]`)
    const back = async (): Promise<void> => {
      await openTabInFront(page, 'shell', work)
      expect(await sendPipeMessage(pipeName, cutOff(tabId))).toEqual({ ok: true })
    }
    const activate = async (): Promise<void> => {
      await page.evaluate((id) => window.ct.activateTab(id), tabId)
      await expect(row).not.toHaveClass(/\battention\b/)
    }
    // a draft of text: the cut-off turn is not continued over it
    await page.locator(INPUT).click()
    await page.keyboard.type('half a thought')
    await back()
    await expect(row).toHaveClass(/\battention\b/, { timeout: CONTINUE_DELAY_MS + 15_000 })
    expect(userMessages(log)).not.toContain(CONTINUE_PROMPT)
    // a draft of an attached file alone holds it back too
    await activate()
    await expect(page.locator(INPUT)).toHaveValue('half a thought')
    await page.locator(INPUT).press('Escape')
    await dropFiles(page, [workFile(work, 'notes.txt', 'notes')])
    await expect(page.locator(ATTACHED)).toHaveCount(1)
    await back()
    await expect(row).toHaveClass(/\battention\b/, { timeout: CONTINUE_DELAY_MS + 15_000 })
    expect(userMessages(log)).not.toContain(CONTINUE_PROMPT)
    // Esc clears the draft: the next cut-off is continued in the chat
    await activate()
    await page.locator(INPUT).press('Escape')
    await expect(page.locator(ATTACHED)).toHaveCount(0)
    expect(await sendPipeMessage(pipeName, cutOff(tabId))).toEqual({ ok: true })
    await expect.poll(() => userMessages(log), { timeout: 20_000 }).toContain(CONTINUE_PROMPT)
  } finally {
    await app.close()
  }
})

test('a pasted image is attached, scaled and sent as an image', { tag: '@alone' }, async () => {
  const { app, page, log } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    // a 4000 x 3000 picture, drawn in the page and put on the system clipboard as a PNG
    const dataUrl = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 4000
      canvas.height = 3000
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#D97757'
      ctx.fillRect(0, 0, 4000, 3000)
      return canvas.toDataURL('image/png')
    })
    const png = [...Buffer.from(dataUrl.split(',')[1], 'base64')]
    await keepingClipboard(app, async () => {
      await app.evaluate(async ({ clipboard, ClipboardItem }, bytes) => {
        await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) })])
      }, png)
      await page.locator(INPUT).click()
      await page.keyboard.press(PASTE_KEY)
      await expect(page.locator(ATTACHED)).toHaveCount(1)
      await page.keyboard.type('what is this')
      await page.keyboard.press('Enter')
      await expect.poll(() => userEntries(log).length).toBe(1)
    })
    const content = userEntries(log)[0].message!.content as { type?: string; source?: { data?: string } }[]
    const image = content.find((b) => b.type === 'image')
    expect(image?.source?.data).toBeTruthy()
    const longEdge = await app.evaluate(({ nativeImage }, data) => {
      const size = nativeImage.createFromBuffer(Buffer.from(data, 'base64')).getSize()
      return Math.max(size.width, size.height)
    }, image!.source!.data!)
    expect(longEdge).toBeGreaterThan(0)
    expect(longEdge).toBeLessThanOrEqual(1568)
  } finally {
    await app.close()
  }
})

test('a scaled PNG photo with no transparency goes to Claude as a JPEG image block', async () => {
  const { app, page, log, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    // an opaque 2000 x 1500 gradient: a PNG the window scales, whose picture has no alpha to keep
    const dataUrl = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 2000
      canvas.height = 1500
      const ctx = canvas.getContext('2d')!
      const gradient = ctx.createLinearGradient(0, 0, 2000, 1500)
      gradient.addColorStop(0, '#D97757')
      gradient.addColorStop(1, '#2D4F8A')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, 2000, 1500)
      return canvas.toDataURL('image/png')
    })
    await dropFiles(page, [workFile(work, 'photo.png', Buffer.from(dataUrl.split(',')[1]!, 'base64'))])
    await expect(page.locator(ATTACHED, { hasText: 'photo.png' })).toHaveCount(1)
    await page.locator(INPUT).click()
    await page.keyboard.type('what is this')
    await page.keyboard.press('Enter')
    await expect.poll(() => userEntries(log).length).toBe(1)
    const content = userEntries(log)[0].message!.content as { type?: string; source?: { media_type?: string } }[]
    expect(content.find((b) => b.type === 'image')?.source?.media_type).toBe('image/jpeg')
  } finally {
    await app.close()
  }
})

test('a small PNG goes to Claude as an image/png block with exactly the file\'s bytes', async () => {
  const { app, page, log, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    const png = blackPng(64, 64)
    await dropFiles(page, [workFile(work, 'small.png', png)])
    await expect(page.locator(ATTACHED, { hasText: 'small.png' })).toHaveCount(1)
    await page.locator(INPUT).click()
    await page.keyboard.type('what is this')
    await page.keyboard.press('Enter')
    await expect.poll(() => userEntries(log).length).toBe(1)
    const content = userEntries(log)[0].message!.content as { type?: string; source?: { media_type?: string; data?: string } }[]
    const image = content.find((b) => b.type === 'image')
    expect(image?.source?.media_type).toBe('image/png')
    expect(image?.source?.data).toBe(png.toString('base64'))
  } finally {
    await app.close()
  }
})

test('a JPEG saved as photo.png goes to Claude as an image/jpeg block: the bytes decide, not the name', async () => {
  const { app, page, log, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    const dataUrl = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 64
      canvas.height = 64
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#D97757'
      ctx.fillRect(0, 0, 64, 64)
      return canvas.toDataURL('image/jpeg')
    })
    await dropFiles(page, [workFile(work, 'photo.png', Buffer.from(dataUrl.split(',')[1]!, 'base64'))])
    await expect(page.locator(ATTACHED, { hasText: 'photo.png' })).toHaveCount(1)
    await page.locator(INPUT).click()
    await page.keyboard.type('what is this')
    await page.keyboard.press('Enter')
    await expect.poll(() => userEntries(log).length).toBe(1)
    const content = userEntries(log)[0].message!.content as { type?: string; source?: { media_type?: string } }[]
    expect(content.find((b) => b.type === 'image')?.source?.media_type).toBe('image/jpeg')
  } finally {
    await app.close()
  }
})

const SLASH_MENU = '.chat-host:visible .chat-slash-menu'
const FILE_PICKER = '.chat-host:visible .chat-file-picker'

test('Ctrl+/ and Meta+/ do not open the slash menu; a plain / as the first character does', async () => {
  const { app, page } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.press('Control+/')
    await expect(page.locator(SLASH_MENU)).toBeHidden()
    await page.keyboard.press('Meta+/')
    await expect(page.locator(SLASH_MENU)).toBeHidden()
    await expect(page.locator(INPUT)).toHaveValue('')
    await page.keyboard.press('/')
    await expect(page.locator(SLASH_MENU)).toBeVisible()
    await expect(page.locator(INPUT)).toHaveValue('/')
  } finally {
    await app.close()
  }
})

test('Ctrl+@ and Alt+@ do not open the file picker; a typed @ does', async () => {
  const { app, page } = await launchChatTab({ turns: {} })
  // a key as the keyboard reports it: the modifiers are the ones the chord holds (AltGr is Ctrl+Alt with the AltGraph state)
  const keyAt = (init: Record<string, unknown>): Promise<void> => page.locator(INPUT).evaluate((el, i) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { ...i, bubbles: true, cancelable: true }))
  }, init)
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await keyAt({ key: '@', code: 'Digit2', ctrlKey: true })
    await expect(page.locator(FILE_PICKER)).toBeHidden()
    await keyAt({ key: '@', code: 'Digit2', altKey: true })
    await expect(page.locator(FILE_PICKER)).toBeHidden()
    // the @ a layout types (AltGr on some, Option on others) is text: the picker opens from the text, not from the chord
    await page.keyboard.insertText('@')
    await expect(page.locator(FILE_PICKER)).toBeVisible()
  } finally {
    await app.close()
  }
})

/** the next `count` set-mode requests never reach the hub (a refusal sends no answer back); the rest do */
async function dropSetModes(app: ElectronApplication, count: number): Promise<void> {
  await app.evaluate(({ ipcMain }, n) => {
    const g = globalThis as unknown as Record<string, number>
    const real = ipcMain.listeners('chat:set-mode')[0] as (event: unknown, ...args: unknown[]) => void
    ipcMain.removeAllListeners('chat:set-mode')
    g.setModeCalls = 0
    ipcMain.on('chat:set-mode', (event, ...args) => {
      g.setModeCalls++
      if (g.setModeCalls <= n) return
      real(event, ...args)
    })
  }, count)
}

test('a Shift+Tab that Claude Code never answers is not waited for: the next press advances from the mode shown', async () => {
  const { app, page, log } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await dropSetModes(app, 1)
    await page.locator(INPUT).click()
    await page.keyboard.press('Shift+Tab')
    await page.waitForTimeout(2500)
    await page.keyboard.press('Shift+Tab')
    // from the mode shown (Ask before edits): the next one is Accept edits, not the Plan the dropped press had asked for
    await expect.poll(() => modeRequests(log)).toEqual(['acceptEdits'])
    await expect(page.locator(MODE_CHIP)).toContainText('Accept edits')
  } finally {
    await app.close()
  }
})

test('a mode Claude changed is the one the next press advances from, not a press still waiting for its answer', async () => {
  const { app, page, log, tabId } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await dropSetModes(app, 1)
    await page.locator(INPUT).click()
    await page.keyboard.press('Shift+Tab')
    // the mode is set from elsewhere: it reaches the hub and the chat reports Plan
    await page.evaluate((id) => window.ct.chatSetMode(id, 'plan'), tabId)
    await expect(page.locator(MODE_CHIP)).toContainText('Plan')
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => modeRequests(log)).toEqual(['plan', 'default'])
  } finally {
    await app.close()
  }
})

/** the first chat:modes call fails after `ms` (a list that does not come); the calls after it are the real handler's */
async function failFirstModes(app: ElectronApplication, ms: number): Promise<void> {
  await app.evaluate(({ ipcMain }, delay) => {
    const g = globalThis as unknown as Record<string, number | boolean>
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> })._invokeHandlers
    const real = handlers.get('chat:modes')!
    ipcMain.removeHandler('chat:modes')
    ipcMain.handle('chat:modes', async (event, ...args) => {
      g.modesCalls = ((g.modesCalls as number | undefined) ?? 0) + 1
      if (g.modesCalls !== 1) return real(event, ...args)
      await new Promise((r) => setTimeout(r, delay))
      g.modesFailed = true
      throw new Error('the modes did not come')
    })
  }, ms)
}

test('the Shift+Tab presses made while the modes fail to load are not applied by the next load', async () => {
  const { app, page, log, work } = await launchChatTab({ turns: {} })
  try {
    // a chat's list is asked for when the chat starts: the first tab's list is in before the failing stub goes in, and
    // a second tab's chat is the one whose list fails
    await ready(page)
    await failFirstModes(app, 1200)
    await openTabInFront(page, 'claude', work)
    await ready(page)
    await expect.poll(() => callsOf(app, 'modesCalls')).toBeGreaterThan(0)
    await page.locator(INPUT).click()
    // two presses while the list is on its way: they wait for it
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as Record<string, unknown>).modesFailed === true), { timeout: 15_000 }).toBe(true)
    await page.waitForTimeout(300)
    // one press after the failure: the list loads now, and only this press is applied
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => modeRequests(log), { timeout: 15_000 }).toEqual(['acceptEdits'])
  } finally {
    await app.close()
  }
})

/** the first `count` calls of an IPC channel answer an empty list; the calls after them are the real handler's. `calls` counts them */
async function emptyFirst(app: ElectronApplication, channel: string, count: number): Promise<void> {
  await app.evaluate(({ ipcMain }, { channel, count }) => {
    const g = globalThis as unknown as Record<string, number>
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> })._invokeHandlers
    const real = handlers.get(channel)!
    ipcMain.removeHandler(channel)
    g.calls = 0
    ipcMain.handle(channel, (event, ...args) => {
      g.calls++
      return g.calls <= count ? [] : real(event, ...args)
    })
  }, { channel, count })
}

const HAIKU = { value: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'The fastest, for quick answers', supportedEffortLevels: [] }

test('an empty models() answer is asked again on the next state, and the chip shows the model it names', async () => {
  const { app, page, tabId } = await launchChatTab({ models: [HAIKU], turns: { hi: [{ text: 'hello' }] } })
  try {
    await emptyFirst(app, 'chat:models', 1)
    await send(page, 'hi')
    await waitForTurn(page, tabId, 'idle')
    await expect(page.locator(MODEL_CHIP)).toContainText('Haiku 5.5')
  } finally {
    await app.close()
  }
})

test('an attach refused after an Esc is not shown under the cleared field', async () => {
  const { app, page, log, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await stubIpc(app, 'chat:attach', { delay: 1500, error: 'the file is gone' })
    await dropFiles(page, [workFile(work, 'notes.txt', 'notes')])
    await page.locator(INPUT).click()
    await page.keyboard.type('with file')
    await page.keyboard.press('Enter')
    await page.locator(INPUT).press('Escape')
    await expect(page.locator(INPUT)).toHaveValue('')
    // the refusal comes back after the Esc: the cleared field shows no refusal
    await page.waitForTimeout(2500)
    await expect(page.locator(REFUSAL)).toBeHidden()
    await expect(page.locator(INPUT)).toHaveValue('')
    expect(userMessages(log)).toEqual([])
  } finally {
    await app.close()
  }
})

/** drops files on a target of the page, as a drag from the desktop does: real files, so the window knows their paths */
async function dropFilesOn(page: Page, target: string, files: string[]): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('drop-source')?.remove()
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'drop-source'
    input.multiple = true
    input.hidden = true
    document.body.append(input)
  })
  await page.locator('#drop-source').setInputFiles(files)
  await page.locator(target).evaluate((node) => {
    const input = document.getElementById('drop-source') as HTMLInputElement
    const data = new DataTransfer()
    for (const file of Array.from(input.files!)) data.items.add(file)
    node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }))
  })
}

/** a black PNG of the size, with one bit a pixel: small on disk, and a decoder still has to make every pixel */
function blackPng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0)
    return Buffer.concat([head, data, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 1 // bit depth
  ihdr[9] = 0 // greyscale
  // every row starts with its filter byte (0) and the bits are all 0: black
  const raw = Buffer.alloc((1 + Math.ceil(width / 8)) * height)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

test('an image too big to scale in the main process goes as its path, and the window stays responsive', { tag: '@alone' }, async () => {
  const { app, page, log, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await dropFiles(page, [workFile(work, 'huge.png', blackPng(10000, 10000))])
    await expect(page.locator(ATTACHED, { hasText: 'huge.png' })).toHaveAttribute('title', /Claude reads it from its path/)
    await page.locator(INPUT).click()
    await page.keyboard.type('look')
    await page.keyboard.press('Enter')
    // round trips to main for as long as the message goes, until it is sent: a picture decoded in main would hold them all through
    // its decode, so the slowest one shows it. The loop runs past the first trips: the picture is read and scaled after the send starts
    let slowest = 0
    const started = Date.now()
    do {
      slowest = Math.max(slowest, await page.evaluate(async () => {
        const t = performance.now()
        await window.ct.chatSnapshot(window.__ct!.activeTabId()!)
        return performance.now() - t
      }))
    } while (userMessages(log).length === 0 && Date.now() - started < 10_000)
    expect(slowest).toBeLessThan(200)
    await expect.poll(() => userMessages(log)).toEqual(['look\n\n@huge.png'])
    const blocks = userEntries(log).flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []) as { type?: string }[])
    expect(blocks.some((b) => b.type === 'image')).toBe(false)
  } finally {
    await app.close()
  }
})

test("a Review Send text and an auto-continue prompt are not recalled by ↑: an empty field recalls what the person typed", async () => {
  const { app, page, tabId, pipeName, log } = await launchChatTab(
    { turns: { mine: [{ text: 'mine answered' }], 'review text': [{ text: 'review answered' }] } },
    { autoContinue: true }
  )
  try {
    await send(page, 'mine')
    await expect.poll(() => userMessages(log)).toContain('mine')
    await waitForTurn(page, tabId, 'idle')
    // the Changes panel's Send: a message of the conversation that the person did not type here
    await page.evaluate((id) => window.__ct!.sendText!(id, 'review text'), tabId)
    await expect.poll(() => userMessages(log)).toContain('review text')
    await waitForTurn(page, tabId, 'idle')
    // a cut-off turn with an empty composer: auto-continue sends its prompt
    expect(await sendPipeMessage(pipeName, cutOff(tabId))).toEqual({ ok: true })
    await expect.poll(() => userMessages(log), { timeout: 20_000 }).toContain(CONTINUE_PROMPT)
    await waitForTurn(page, tabId, 'idle')
    await page.locator(INPUT).click()
    await expect(page.locator(INPUT)).toHaveValue('')
    await page.keyboard.press('ArrowUp')
    await expect(page.locator(INPUT)).toHaveValue('mine')
  } finally {
    await app.close()
  }
})

test('a drop that would pass 20 files adds none and says so', async () => {
  const { app, page, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    const files = Array.from({ length: 21 }, (_, i) => workFile(work, `f${i}.txt`, 'x'))
    await dropFiles(page, files)
    await expect(page.locator(REFUSAL)).toHaveText('At most 20 files per message')
    await expect(page.locator(ATTACHED)).toHaveCount(0)
    await dropFiles(page, files.slice(0, 15))
    await expect(page.locator(ATTACHED)).toHaveCount(15)
    await dropFiles(page, files.slice(15))
    await expect(page.locator(REFUSAL)).toHaveText('At most 20 files per message')
    await expect(page.locator(ATTACHED)).toHaveCount(15)
  } finally {
    await app.close()
  }
})

test('a refused message brings its files back once, when the same file was attached again meanwhile', async () => {
  const { app, page, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    const file = workFile(work, 'notes.txt', 'notes')
    await dropFiles(page, [file])
    await expect(page.locator(ATTACHED)).toHaveCount(1)
    await stubIpc(app, 'chat:send', { delay: 800, answer: 'Refused for the test.' })
    await page.locator(INPUT).click()
    await page.keyboard.type('read it')
    await page.keyboard.press('Enter')
    await expect(page.locator(ATTACHED)).toHaveCount(0)
    await dropFiles(page, [file])
    await expect(page.locator(ATTACHED)).toHaveCount(1)
    await expect(page.locator(REFUSAL)).toHaveText('Refused for the test.')
    await expect(page.locator(ATTACHED)).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('Files on this computer… attaches the file the dialog picked', async () => {
  const { app, page, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    const file = workFile(work, 'picked.txt', 'picked')
    await app.evaluate(({ dialog }, path: string) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as unknown as typeof dialog.showOpenDialog
    }, file)
    await page.locator('.chat-host:visible button[aria-label="Attach a file or image"]').click()
    await page.locator('.chat-host:visible .chat-menu-item', { hasText: 'Files on this computer' }).click()
    await expect(page.locator(ATTACHED, { hasText: 'picked.txt' })).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('the attach menu closes with Esc and the turn goes on: Esc only closes the menu', async () => {
  const { app, page, tabId, config } = await launchChatTab({ turns: { go: [{ gate: 'release' }, { text: 'done' }] } })
  try {
    await send(page, 'go')
    await waitForTurn(page, tabId, 'working')
    await page.locator('.chat-host:visible button[aria-label="Attach a file or image"]').click()
    await expect(page.locator('.chat-host:visible .chat-menu')).toBeVisible()
    await page.locator(INPUT).click()
    await page.keyboard.press('Escape')
    await expect(page.locator('.chat-host:visible .chat-menu')).toBeHidden()
    await page.waitForTimeout(300)
    expect((await snapshot(page, tabId))?.state.turn).toBe('working')
    writeFileSync(join(config, 'release'), '')
    await waitForTurn(page, tabId, 'idle')
  } finally {
    await app.close()
  }
})

test('a file dropped on the sheet header is attached like a drop on the sheet', async () => {
  const { app, page, work } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await dropFilesOn(page, '#sheet-header', [workFile(work, 'header.txt', 'header')])
    await expect(page.locator(ATTACHED, { hasText: 'header.txt' })).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('a draft stays through a switch to the terminal and back', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('keep this')
    await page.evaluate((id) => window.ct.setTabView(id, 'terminal'), tabId)
    await expect(page.locator(INPUT)).toBeHidden()
    await page.evaluate((id) => window.ct.setTabView(id, 'chat'), tabId)
    await expect(page.locator(INPUT)).toHaveValue('keep this')
  } finally {
    await app.close()
  }
})

test('an Enter that ends an IME composition in the composer sends nothing', async () => {
  const { app, page, log } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('ni')
    await page.locator(INPUT).evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })))
    await expect(page.locator(INPUT)).toHaveValue('ni')
    expect(userMessages(log)).toEqual([])
  } finally {
    await app.close()
  }
})


test('while a turn runs and the field is empty, a Stop button holds the place of Send; a letter brings Send back and clearing it brings Stop back', async () => {
  const { app, page, tabId, log } = await launchChatTab({ turns: { slow: [{ wait: 60_000 }] } })
  const interrupts = (): number => (log() as { in?: { request?: { subtype?: string } } }[]).filter((e) => e.in?.request?.subtype === 'interrupt').length
  try {
    await send(page, 'slow')
    await waitForTurn(page, tabId, 'working')
    const stop = page.locator(STOP)
    await expect(stop).toBeVisible()
    await expect(stop).toHaveAttribute('aria-label', 'Stop Claude')
    await expect(stop).toHaveAttribute('title', 'Stop (Esc)')
    await expect(page.locator(SEND)).toBeHidden()
    // the arc turns while the turn runs
    expect(await stop.locator('.chat-stop-arc').evaluate((el) => getComputedStyle(el).animationName)).not.toBe('none')
    // the Stop button takes no focus from the field
    expect(await page.evaluate(() => document.activeElement?.classList.contains('chat-input') ?? false)).toBe(true)
    await page.keyboard.type('x')
    await expect(page.locator(SEND)).toBeVisible()
    await expect(stop).toBeHidden()
    await page.keyboard.press('Backspace')
    await expect(stop).toBeVisible()
    await expect(page.locator(SEND)).toBeHidden()
    // a click on Stop interrupts the turn, as Esc does; Send is back when the turn ends
    await stop.click()
    await expect.poll(interrupts).toBe(1)
    await waitForTurn(page, tabId, 'idle')
    await expect(page.locator(SEND)).toBeVisible()
    await expect(stop).toBeHidden()
  } finally {
    await app.close()
  }
})

test('under reduced motion the Stop arc stands still', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { slow: [{ wait: 60_000 }] } })
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await send(page, 'slow')
    await waitForTurn(page, tabId, 'working')
    await expect(page.locator(STOP)).toBeVisible()
    expect(await page.locator(`${STOP} .chat-stop-arc`).evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
    await page.locator(STOP).click()
    await waitForTurn(page, tabId, 'idle')
  } finally {
    await app.close()
  }
})

test('after a click on Stop the focus is in the field, and what is typed next goes there', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { slow: [{ wait: 60_000 }] } })
  try {
    await send(page, 'slow')
    await waitForTurn(page, tabId, 'working')
    await page.locator(STOP).click()
    await expect(page.locator(INPUT)).toBeFocused()
    await page.keyboard.type('next')
    await expect(page.locator(INPUT)).toHaveValue('next')
  } finally {
    await app.close()
  }
})

test('with an attachment and no text, Send is the button: Stop shows only when there is nothing to send', async () => {
  const { app, page, tabId, work } = await launchChatTab({ turns: { slow: [{ wait: 60_000 }] } })
  try {
    await send(page, 'slow')
    await waitForTurn(page, tabId, 'working')
    await expect(page.locator(STOP)).toBeVisible()
    await dropFiles(page, [workFile(work, 'notes.txt', 'notes')])
    await expect(page.locator(ATTACHED)).toHaveCount(1)
    await expect(page.locator(SEND)).toBeVisible()
    await expect(page.locator(STOP)).toBeHidden()
    // the follow-up can be sent by its button; here the turn is stopped instead
    await page.locator(INPUT).press('Escape')
    await waitForTurn(page, tabId, 'idle')
  } finally {
    await app.close()
  }
})
