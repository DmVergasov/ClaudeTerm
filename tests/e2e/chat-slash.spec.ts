import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatSnapshot } from '../../src/shared/chat'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { launchChatTab } from './chat-helpers'
import { bufferText, KEYS, openTabInFront } from './helpers'

// the chat in front: its composer, its column and the pickers the composer opens
const INPUT = '.chat-host:visible .chat-input'
const MODEL_CHIP = '.chat-host:visible .chat-model-chip'
const SLASH = '.chat-host:visible .chat-slash-menu'
const SLASH_COUNT = '.chat-host:visible .chat-slash-count'
const SLASH_GROUP = '.chat-host:visible .chat-slash-group'
const SLASH_ROW = '.chat-host:visible .chat-slash-row'
const MODEL_PICKER = '.chat-host:visible .chat-model-picker'
const FILE_PICKER = '.chat-host:visible .chat-file-picker'
const FILE_ROW = '.chat-host:visible .chat-file-row'
const NOTE = '.chat-host:visible .chat-note'
const SESSIONS = '#sessions'

/** the commands the stand-in Claude Code lists: its builtins, and a plugin's command */
const COMMANDS = [
  { name: 'context', description: 'Show what fills the context window', argumentHint: '', builtin: true },
  { name: 'compact', description: 'Summarize the conversation and free the context', argumentHint: '[instructions]', builtin: true },
  { name: 'config', description: "Open Claude Code's settings", argumentHint: '', builtin: true },
  { name: 'code-review:review', description: 'Review the current diff for bugs', argumentHint: '' }
]

// the list's entries are aliases: the full id each one resolves to is the one the stream names
const MODELS = [
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks', supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'The fastest, for quick answers', supportedEffortLevels: [] }
]

interface UserEntry { message?: { content?: unknown } }

/** the texts of the user messages Claude Code received */
function userMessages(log: () => Record<string, unknown>[]): string[] {
  return (log() as { in?: { type?: string; message?: UserEntry['message'] } }[])
    .filter((e) => e.in?.type === 'user')
    .map((e) => {
      const content = e.in!.message?.content
      if (typeof content === 'string') return content
      return Array.isArray(content) ? content.map((b: { text?: string }) => b.text ?? '').join('') : ''
    })
}

/** the control requests Claude Code received with a subtype, in order: their bodies */
function requests(log: () => Record<string, unknown>[], subtype: string): Record<string, unknown>[] {
  return (log() as { in?: { request?: Record<string, unknown> & { subtype?: string } } }[])
    .filter((e) => e.in?.request?.subtype === subtype)
    .map((e) => e.in!.request!)
}

/** the launch arguments of every process the stand-in ran, in order */
function launches(log: () => Record<string, unknown>[]): string[][] {
  return (log() as { argv?: string[] }[]).filter((e) => Array.isArray(e.argv)).map((e) => e.argv!)
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

test('/ opens the menu, filters, and Enter runs /context', async () => {
  const { app, page, log } = await launchChatTab({ commands: COMMANDS, terminalCommands: ['config'], turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.press('/')
    await expect(page.locator(SLASH)).toBeVisible()
    // the groups in their order: the builtins, then the plugins' commands with their source
    await expect(page.locator(SLASH_GROUP)).toHaveText(['Claude Code', 'Plugins and skills'])
    await expect(page.locator(SLASH_ROW).nth(3)).toContainText('code-review')
    await page.keyboard.type('con')
    await expect(page.locator(SLASH_COUNT)).toHaveText('2 commands match "con"')
    await expect(page.locator(SLASH_ROW)).toHaveCount(2)
    await expect(page.locator(SLASH_ROW).nth(0)).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(SLASH_ROW).nth(0)).toContainText('Show what fills the context window')
    // the matched letters are highlighted, and the terminal command is tagged
    await expect(page.locator(SLASH_ROW).nth(0).locator('mark')).toHaveText('con')
    await expect(page.locator(SLASH_ROW).nth(1)).toContainText('Opens in the terminal')
    await page.keyboard.press('Enter')
    await expect.poll(() => userMessages(log)).toEqual(['/context'])
    await expect(page.locator(SLASH)).toBeHidden()
    await expect(page.locator(INPUT)).toHaveValue('')
  } finally {
    await app.close()
  }
})

test('Tab completes a command with arguments and waits', async () => {
  const { app, page, log } = await launchChatTab({ commands: COMMANDS, turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('/com')
    await expect(page.locator(SLASH_ROW)).toHaveCount(1)
    await page.keyboard.press('Tab')
    await expect(page.locator(INPUT)).toHaveValue('/compact ')
    await expect(page.locator(SLASH)).toBeHidden()
    expect(userMessages(log)).toEqual([])
    // Enter on a command that takes arguments completes it too, and waits for them
    await page.keyboard.press('Escape')
    await expect(page.locator(INPUT)).toHaveValue('')
    await page.keyboard.type('/com')
    await page.keyboard.press('Enter')
    await expect(page.locator(INPUT)).toHaveValue('/compact ')
    expect(userMessages(log)).toEqual([])
    await page.keyboard.type('focus on the tests')
    await page.keyboard.press('Enter')
    await expect.poll(() => userMessages(log)).toEqual(['/compact focus on the tests'])
  } finally {
    await app.close()
  }
})

test('/model picks a model and effort', async () => {
  // /model without an argument hint: Enter runs it (a command with a hint is completed and waits)
  const { app, page, log, tabId } = await launchChatTab({ commands: [{ name: 'model', description: 'Set the model', argumentHint: '', builtin: true }], models: MODELS, turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('/model')
    await page.keyboard.press('Enter')
    const picker = page.locator(MODEL_PICKER)
    await expect(picker).toBeVisible()
    await expect(picker.locator('.chat-model-option')).toHaveCount(2)
    await picker.locator('.chat-model-option', { hasText: 'Opus 5.5' }).click()
    await picker.locator('.chat-model-effort button', { hasText: 'high' }).click()
    await picker.locator('button', { hasText: 'Apply' }).click()
    await expect(picker).toBeHidden()
    await expect.poll(() => requests(log, 'set_model').map((r) => r.model)).toEqual(['opus'])
    await expect.poll(() => requests(log, 'apply_flag_settings').map((r) => (r.settings as { effortLevel?: string }).effortLevel)).toEqual(['high'])
    await expect(page.locator(MODEL_CHIP)).toContainText('Opus 5.5')
    await expect(page.locator(MODEL_CHIP)).toContainText('high')
    expect(userMessages(log)).toEqual([])
    expect((await snapshot(page, tabId))?.state.model).toBe('opus')
  } finally {
    await app.close()
  }
})

test('/config opens in the terminal and runs there', async () => {
  const { app, page, tabId } = await launchChatTab({ commands: COMMANDS, terminalCommands: ['config'], turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('/config')
    await page.keyboard.press('Enter')
    await expect.poll(() => bufferText(page, tabId), { timeout: 25_000 }).toContain('you said: /config')
    // back in the chat, the line says the command ran in the terminal: the column draws the notice
    await page.evaluate((id) => window.ct.setTabView(id, 'chat'), tabId)
    await expect(page.locator('.chat-host:visible .chat-column')).toContainText('Opened /config in the terminal', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('a terminal command while Claude works waits for the turn', async () => {
  const { app, page, tabId } = await launchChatTab({
    commands: COMMANDS,
    terminalCommands: ['config'],
    turns: { slow: [{ text: 'slow answer', chunks: 6, pace: 300 }] }
  })
  try {
    await send(page, 'slow')
    await waitForTurn(page, tabId, 'working')
    await page.locator(INPUT).click()
    await page.keyboard.type('/config')
    await page.keyboard.press('Enter')
    // not run: the text stays in the composer, and the line says when it will run
    await expect(page.locator(NOTE)).toHaveText('/config opens in the terminal once Claude finishes')
    await expect(page.locator(INPUT)).toHaveValue('/config')
    await waitForTurn(page, tabId, 'idle')
    await expect.poll(() => bufferText(page, tabId), { timeout: 25_000 }).toContain('you said: /config')
  } finally {
    await app.close()
  }
})

test('! commands run in the terminal', async () => {
  const { app, page, tabId, log } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('!echo hello')
    await page.keyboard.press('Enter')
    await expect.poll(() => bufferText(page, tabId), { timeout: 25_000 }).toContain('you said: !echo hello')
    expect(userMessages(log)).toEqual([])
  } finally {
    await app.close()
  }
})

test("/resume opens a session of this folder here, another folder's in a new tab", async () => {
  const { app, page, tabId, work, config, log } = await launchChatTab({ turns: {} })
  try {
    const elsewhere = mkdtempSync(join(tmpdir(), 'ct-elsewhere-'))
    const SID_HERE = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
    const SID_ELSEWHERE = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
    writeSession(config, work, SID_HERE, 'the login work here', 5)
    writeSession(config, elsewhere, SID_ELSEWHERE, 'notes from elsewhere', 1)
    await ready(page)
    // a session of this folder: the conversation resumes in this tab
    await page.locator(INPUT).click()
    await page.keyboard.type('/resume')
    await page.keyboard.press('Enter')
    await expect(page.locator(SESSIONS)).toBeVisible()
    await page.keyboard.type('login work')
    // the filtered row is shown before Enter picks it: Enter right after the window opens could pick the latest session
    await expect(page.locator('#sessions .session-row', { hasText: 'login work' })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await snapshot(page, tabId))?.state.sessionId ?? null, { timeout: 30_000 }).toBe(SID_HERE)
    expect(await page.evaluate(() => window.__ct!.tabIds().length)).toBe(1)
    await expect.poll(() => launches(log).some((argv) => argv.join(' ').includes(`--resume=${SID_HERE}`) || argv.join(' ').includes(`--resume ${SID_HERE}`)), { timeout: 15_000 }).toBe(true)
    // a session of another folder: it opens in a tab of its own
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('/resume')
    await page.keyboard.press('Enter')
    await expect(page.locator(SESSIONS)).toBeVisible()
    await page.keyboard.type('notes from elsewhere')
    // the filtered row is shown before Enter picks it, as in the first half: Enter before it could do nothing
    await expect(page.locator('#sessions .session-row', { hasText: 'notes from elsewhere' })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => window.__ct!.tabIds().length), { timeout: 15_000 }).toBe(2)
    // the new tab's process starts a moment after its tab shows: its launch is waited for
    await expect.poll(() => launches(log).some((argv) => argv.join(' ').includes(`--resume ${SID_ELSEWHERE}`) || argv.join(' ').includes(`--resume=${SID_ELSEWHERE}`)), { timeout: 15_000 }).toBe(true)
  } finally {
    await app.close()
  }
})

test('@ inserts a project file', async () => {
  const { app, page, work } = await launchChatTab({ turns: {} })
  try {
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'notes.txt'), 'notes')
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('@not')
    await expect(page.locator(FILE_PICKER)).toBeVisible()
    await expect(page.locator(FILE_ROW).nth(0)).toContainText('notes.txt')
    await page.keyboard.press('Enter')
    await expect(page.locator(INPUT)).toHaveValue('@notes.txt ')
    await expect(page.locator(FILE_PICKER)).toBeHidden()
  } finally {
    await app.close()
  }
})

test("a command this environment has no answer for is noticed, and Open in the terminal runs the line typed there", async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { '/review focus': [{ notAvailable: 'review' }] } })
  try {
    await send(page, '/review focus')
    await expect(page.locator('.chat-host:visible .chat-notice')).toContainText("/review isn't available in this environment.")
    await page.locator('.chat-host:visible .chat-notice button', { hasText: 'Open in the terminal' }).click()
    await expect.poll(() => bufferText(page, tabId), { timeout: 25_000 }).toContain('you said: /review focus')
  } finally {
    await app.close()
  }
})

test("a ! command's note names its first word, as the line does", async () => {
  const { app, page, tabId } = await launchChatTab({ turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('!echo hello')
    await page.keyboard.press('Enter')
    await expect.poll(() => bufferText(page, tabId), { timeout: 25_000 }).toContain('you said: !echo hello')
    await page.evaluate((id) => window.ct.setTabView(id, 'chat'), tabId)
    await expect(page.locator('.chat-host:visible .chat-column')).toContainText('Opened !echo in the terminal', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

/** the channel answers `value` from now on; the real handler is not called */
async function answerIpc(app: ElectronApplication, channel: string, value: unknown): Promise<void> {
  await app.evaluate(({ ipcMain }, { channel, value }) => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, () => value)
  }, { channel, value })
}

/** a turn of the chat ran, and its session reports a background task: the window knows it before a view switch */
async function withBackgroundTask(page: Page, pipeName: string, tabId: string): Promise<void> {
  await send(page, 'hello')
  await expect(page.locator('.chat-column')).toContainText('Hi there')
  await waitForTurn(page, tabId, 'idle')
  const sessionId = (await snapshot(page, tabId))!.state.sessionId!
  const task = { id: 'b1', type: 'shell', description: 'Run the e2e suite', command: 'npx playwright test' }
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', background: true, tasks: [task] })).toEqual({ ok: true })
  await expect(page.locator('#statusbar .status-background')).toContainText('1 in background: Run the e2e suite')
}

test('the question about background tasks goes when its command is dropped: typing or Esc leaves nothing for Switch to run', async () => {
  const { app, page, pipeName, tabId } = await launchChatTab({ commands: COMMANDS, terminalCommands: ['config'], turns: { hello: [{ text: 'Hi there' }] } })
  try {
    await withBackgroundTask(page, pipeName, tabId)
    await page.locator(INPUT).click()
    await page.keyboard.type('/config')
    await page.keyboard.press('Enter')
    const header = page.locator('.sh-mode-confirm')
    await expect(header).toBeVisible()
    // typing changes the command: the question is over
    await page.keyboard.type('x')
    await expect(header).toBeHidden()
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Enter')
    await expect(header).toBeVisible()
    // Esc drops the command, and its question with it: the text stays
    await page.keyboard.press('Escape')
    await expect(header).toBeHidden()
    await expect(page.locator(INPUT)).toHaveValue('/config')
    expect(await bufferText(page, tabId)).not.toContain('you said: /config')
  } finally {
    await app.close()
  }
})

test('a file picker opened again shows no list of its last query until the answer comes', async () => {
  const { app, page, work } = await launchChatTab({ turns: {} })
  try {
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'notes.txt'), 'notes')
    await ready(page)
    await delayIpc(app, 'chat:files', 1500)
    await page.locator(INPUT).click()
    await page.keyboard.type('@not')
    await expect(page.locator(FILE_ROW).nth(0)).toContainText('notes.txt')
    await page.keyboard.press('Escape')
    await expect(page.locator(FILE_PICKER)).toBeHidden()
    await page.keyboard.type(' @')
    await expect(page.locator(FILE_PICKER)).toBeVisible()
    // the answer to this opening is on its way: the rows of the last one are not shown as its list
    await expect(page.locator(FILE_ROW)).toHaveCount(0)
    await expect(page.locator(FILE_ROW).nth(0)).toContainText('notes.txt')
  } finally {
    await app.close()
  }
})

test('a /resume the chat cannot take says so under the field', async () => {
  const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
  const { app, page, config, work } = await launchChatTab({ turns: {} })
  try {
    writeSession(config, work, SID, 'the login work here', 5)
    await answerIpc(app, 'chat:resume', null)
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('/resume')
    await page.keyboard.press('Enter')
    await expect(page.locator(SESSIONS)).toBeVisible()
    await page.keyboard.type('login work')
    await page.keyboard.press('Enter')
    await expect(page.locator('.chat-host:visible .chat-refusal')).toContainText('could not be resumed here')
  } finally {
    await app.close()
  }
})

test("a session picked for a chat offers this device's sessions only; the window opened on its own also lists the other devices'", async () => {
  const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
  const { app, page, config, work } = await launchChatTab({ turns: {} })
  try {
    writeSession(config, work, SID, 'the login work here', 5)
    // another device's session, as its answer gives it
    const remote = { device: 'dev-b', name: 'Desk B', value: [{ id: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d', cwd: '/elsewhere/app', title: 'remote work', firstPrompt: null, lastPrompt: null, modifiedAt: Date.now(), open: false, starred: false }] }
    await answerIpc(app, 'remote:sessions', [remote])
    await ready(page)
    await page.keyboard.press(KEYS.recentSessions)
    await expect(page.locator(SESSIONS)).toBeVisible()
    await expect(page.locator('#sessions .sessions-device')).toContainText('Desk B')
    await page.keyboard.press('Escape')
    await expect(page.locator(SESSIONS)).toBeHidden()
    await page.locator(INPUT).click()
    await page.keyboard.type('/resume')
    await page.keyboard.press('Enter')
    await expect(page.locator('#sessions .session-row')).toHaveCount(1)
    await expect(page.locator('#sessions .sessions-device')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a paste that starts with / does not open the slash menu', async () => {
  const { app, page } = await launchChatTab({ commands: COMMANDS, turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    // a paste is an input of another type than the typed character: the text is there, the menu is not opened
    await page.locator(INPUT).evaluate((el) => {
      const field = el as HTMLTextAreaElement
      field.value = '/co'
      field.setSelectionRange(3, 3)
      field.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', bubbles: true }))
    })
    await expect(page.locator(INPUT)).toHaveValue('/co')
    await expect(page.locator(SLASH)).toBeHidden()
  } finally {
    await app.close()
  }
})

/** the next calls of a channel wait `ms` before the real handler answers: the answer comes late */
async function delayIpc(app: ElectronApplication, channel: string, ms: number): Promise<void> {
  await app.evaluate(({ ipcMain }, { channel, ms }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> })._invokeHandlers
    const real = handlers.get(channel)!
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      await new Promise((r) => setTimeout(r, ms))
      return real(event, ...args)
    })
  }, { channel, ms })
}

/** a channel answers an empty list, and counts its calls under `key` */
async function emptyAndCount(app: ElectronApplication, channel: string, key: string): Promise<void> {
  await app.evaluate(({ ipcMain }, { channel, key }) => {
    const g = globalThis as unknown as Record<string, number>
    ipcMain.removeHandler(channel)
    g[key] = 0
    ipcMain.handle(channel, () => {
      g[key]++
      return []
    })
  }, { channel, key })
}

const callsOf = (app: ElectronApplication, key: string): Promise<number> =>
  app.evaluate((_, k) => (globalThis as unknown as Record<string, number>)[k] ?? 0, key)

test('a terminal command while background tasks run asks in the sheet header: Cancel keeps the text, Switch runs it', async () => {
  const { app, page, pipeName, tabId } = await launchChatTab({ commands: COMMANDS, terminalCommands: ['config'], turns: { hello: [{ text: 'Hi there' }] } })
  try {
    await send(page, 'hello')
    await expect(page.locator('.chat-column')).toContainText('Hi there')
    await waitForTurn(page, tabId, 'idle')
    const sessionId = (await snapshot(page, tabId))!.state.sessionId!
    const task = { id: 'b1', type: 'shell', description: 'Run the e2e suite', command: 'npx playwright test' }
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', background: true, tasks: [task] })).toEqual({ ok: true })
    await expect(page.locator('#statusbar .status-background')).toContainText('1 in background: Run the e2e suite')

    await page.locator(INPUT).click()
    await page.keyboard.type('/config')
    await page.keyboard.press('Enter')
    // the question is the sheet header's, under its switch; the composer draws none of its own
    const header = page.locator('.sh-mode-confirm')
    await expect(header).toContainText('1 background task will stop. Switch anyway?')
    await header.locator('button', { hasText: 'Cancel' }).click()
    await expect(header).toBeHidden()
    await expect(page.locator(INPUT)).toHaveValue('/config')
    await page.locator(INPUT).click()
    await page.keyboard.press('Enter')
    await expect(header).toBeVisible()
    await header.locator('button', { hasText: 'Switch' }).click()
    await expect.poll(() => bufferText(page, tabId), { timeout: 25_000 }).toContain('you said: /config')
  } finally {
    await app.close()
  }
})

test('a terminal command waiting for the turn ends with Esc: the text stays, and nothing runs when the turn ends', async () => {
  const { app, page, tabId } = await launchChatTab({
    commands: COMMANDS,
    terminalCommands: ['config'],
    turns: { slow: [{ text: 'slow answer', chunks: 6, pace: 300 }] }
  })
  try {
    await send(page, 'slow')
    await waitForTurn(page, tabId, 'working')
    await page.locator(INPUT).click()
    await page.keyboard.type('/config')
    await page.keyboard.press('Enter')
    await expect(page.locator(NOTE)).toHaveText('/config opens in the terminal once Claude finishes')
    await page.keyboard.press('Escape')
    await expect(page.locator(NOTE)).toBeHidden()
    await expect(page.locator(INPUT)).toHaveValue('/config')
    await waitForTurn(page, tabId, 'idle')
    await page.waitForTimeout(1500)
    expect(await bufferText(page, tabId)).not.toContain('you said: /config')
    await expect(page.locator(INPUT)).toHaveValue('/config')
  } finally {
    await app.close()
  }
})

test('/resume while Claude works waits for the turn to end before the sessions open', async () => {
  const { app, page, tabId } = await launchChatTab({
    commands: [{ name: 'resume', description: 'Resume a session', argumentHint: '', builtin: true }],
    turns: { slow: [{ text: 'slow answer', chunks: 6, pace: 300 }] }
  })
  try {
    await send(page, 'slow')
    await waitForTurn(page, tabId, 'working')
    await page.locator(INPUT).click()
    await page.keyboard.type('/resume')
    await page.keyboard.press('Enter')
    await expect(page.locator(NOTE)).toHaveText('/resume opens once Claude finishes')
    await expect(page.locator(SESSIONS)).toBeHidden()
    await waitForTurn(page, tabId, 'idle')
    await expect(page.locator(SESSIONS)).toBeVisible({ timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('a command the terminal flags runs in the terminal, under the name it has', async () => {
  const { app, page, tabId, log } = await launchChatTab({
    commands: [...COMMANDS, { name: 'deploy', description: 'Deploy the app', argumentHint: '', builtin: false }],
    terminalCommands: ['deploy'],
    turns: { hello: [{ text: 'Hi there' }] }
  })
  try {
    await send(page, 'hello')
    await waitForTurn(page, tabId, 'idle')
    await page.locator(INPUT).click()
    await page.keyboard.type('/deploy')
    await page.keyboard.press('Enter')
    await expect.poll(() => bufferText(page, tabId), { timeout: 25_000 }).toContain('you said: /deploy')
    expect(userMessages(log)).toEqual(['hello'])
  } finally {
    await app.close()
  }
})

test('the slash menu lists in the order it draws: the builtins first, then a plugin, and ↓ moves to the next row drawn', async () => {
  const { app, page } = await launchChatTab({
    commands: [
      { name: 'config', description: "Open Claude Code's settings", argumentHint: '', builtin: true },
      { name: 'fixer:run', description: 'Fix the failing tests', argumentHint: '' }
    ],
    turns: {}
  })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.press('/')
    await page.keyboard.type('f')
    await expect(page.locator(SLASH_ROW)).toHaveCount(2)
    await expect(page.locator(SLASH_ROW).nth(0)).toContainText('Open Claude Code')
    await expect(page.locator(SLASH_ROW).nth(0)).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowDown')
    await expect(page.locator(SLASH_ROW).nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator(SLASH_ROW).nth(1)).toContainText('Fix the failing tests')
  } finally {
    await app.close()
  }
})

test('a model picked with the keyboard keeps the focus in the picker; Apply returns it to the field; Esc on the picker closes it', async () => {
  const { app, page, log } = await launchChatTab({ commands: [{ name: 'model', description: 'Set the model', argumentHint: '', builtin: true }], models: MODELS, turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('/model')
    await page.keyboard.press('Enter')
    const picker = page.locator(MODEL_PICKER)
    await expect(picker).toBeVisible()
    const inPicker = (): Promise<boolean> => page.evaluate(() => document.activeElement?.closest('.chat-model-picker') != null)
    await picker.locator('.chat-model-option').nth(0).focus()
    await page.keyboard.press('Enter')
    await expect.poll(inPicker).toBe(true)
    await picker.locator('.chat-model-apply').focus()
    await page.keyboard.press('Enter')
    await expect(picker).toBeHidden()
    await expect.poll(() => requests(log, 'set_model').map((r) => r.model)).toEqual(['opus'])
    await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('chat-input') ?? false)).toBe(true)

    await page.keyboard.type('/model')
    await page.keyboard.press('Enter')
    await expect(picker).toBeVisible()
    await picker.locator('.chat-model-option').nth(1).focus()
    await page.keyboard.press('Escape')
    await expect(picker).toBeHidden()
  } finally {
    await app.close()
  }
})

test('a model with efforts picked with none chosen keeps no effort; a model with none shows no effort row', async () => {
  const { app, page, log } = await launchChatTab({ commands: [{ name: 'model', description: 'Set the model', argumentHint: '', builtin: true }], models: MODELS, turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('/model')
    await page.keyboard.press('Enter')
    const picker = page.locator(MODEL_PICKER)
    await picker.locator('.chat-model-option', { hasText: 'Opus 5.5' }).click()
    await expect(picker.locator('.chat-model-effort')).toBeVisible()
    await expect(picker.locator('.chat-model-levels button[aria-pressed="true"]')).toHaveCount(0)
    await picker.locator('button', { hasText: 'Apply' }).click()
    await expect(picker).toBeHidden()
    await expect.poll(() => requests(log, 'set_model').map((r) => r.model)).toEqual(['opus'])
    await expect(page.locator(MODEL_CHIP)).not.toContainText('high')
    expect(requests(log, 'apply_flag_settings').map((r) => (r.settings as { effortLevel?: string }).effortLevel)).not.toContain('high')

    await page.locator(INPUT).click()
    await page.keyboard.type('/model')
    await page.keyboard.press('Enter')
    await picker.locator('.chat-model-option', { hasText: 'Haiku 5.5' }).click()
    await expect(picker.locator('.chat-model-effort')).toBeHidden()
  } finally {
    await app.close()
  }
})

test('after a turn the model the session runs is the one checked in /model', async () => {
  const HAIKU_ID = 'claude-haiku-5-5'
  const { app, page, tabId } = await launchChatTab({
    commands: [{ name: 'model', description: 'Set the model', argumentHint: '', builtin: true }],
    models: [{ value: HAIKU_ID, displayName: 'Haiku 5.5', description: 'The fastest, for quick answers', supportedEffortLevels: [] }, MODELS[0]!],
    turns: { hi: [{ text: 'hello' }] }
  })
  try {
    await send(page, 'hi')
    await waitForTurn(page, tabId, 'idle')
    await expect.poll(async () => (await snapshot(page, tabId))?.state.model ?? null, { timeout: 15_000 }).toBe(HAIKU_ID)
    await page.locator(INPUT).click()
    await page.keyboard.type('/model')
    await page.keyboard.press('Enter')
    await expect(page.locator(MODEL_PICKER).locator('.chat-model-option', { hasText: 'Haiku 5.5' })).toHaveAttribute('aria-pressed', 'true')
  } finally {
    await app.close()
  }
})

test('a chat whose stream names the full model id shows the list entry it is: its name, /model checks it, and the effort it sets shows after the name', async () => {
  // the entry's own levels: the stand-in's Opus takes max too
  const OPUS = { ...MODELS[0]!, supportedEffortLevels: ['low', 'medium', 'high', 'max'] }
  const { app, page, tabId, log } = await launchChatTab({
    commands: [{ name: 'model', description: 'Set the model', argumentHint: '', builtin: true }],
    models: [OPUS, MODELS[1]!],
    model: 'claude-opus-5-5',
    turns: { hi: [{ text: 'hello' }] }
  })
  try {
    await send(page, 'hi')
    await waitForTurn(page, tabId, 'idle')
    await expect.poll(async () => (await snapshot(page, tabId))?.state.model ?? null, { timeout: 15_000 }).toBe('claude-opus-5-5')
    // the chip names the list's entry, not the id the stream sent; no effort is set yet, so none shows after it
    await expect(page.locator(MODEL_CHIP)).toContainText('Opus 5.5')
    await expect(page.locator(MODEL_CHIP)).not.toContainText('claude-opus')
    await expect(page.locator(MODEL_CHIP)).not.toContainText('·')
    await page.locator(INPUT).click()
    await page.keyboard.type('/model')
    await page.keyboard.press('Enter')
    const picker = page.locator(MODEL_PICKER)
    await expect(picker.locator('.chat-model-option', { hasText: 'Opus 5.5' })).toHaveAttribute('aria-pressed', 'true')
    // the effort row shows the entry's levels, in its order
    await expect(picker.locator('.chat-model-effort')).toBeVisible()
    await expect(picker.locator('.chat-model-levels button')).toHaveText(['low', 'medium', 'high', 'max'])
    await picker.locator('.chat-model-levels button', { hasText: 'max' }).click()
    await picker.locator('.chat-model-apply').click()
    await expect(picker).toBeHidden()
    // the same model with the new effort: the effort is applied, and any model it names is this one
    await expect.poll(() => requests(log, 'apply_flag_settings').map((r) => (r.settings as { effortLevel?: string }).effortLevel)).toEqual(['max'])
    for (const r of requests(log, 'set_model')) expect(['opus', 'claude-opus-5-5']).toContain(r.model)
    // the effort is its own dimmed span after the name, with the chip's gap between them
    await expect(page.locator(MODEL_CHIP)).toContainText('Opus 5.5')
    await expect(page.locator(MODEL_CHIP).locator('.chat-effort')).toHaveText('· max')
  } finally {
    await app.close()
  }
})

test('a model with no effort levels shows no effort row in /model, and its chip names it with no effort', async () => {
  const { app, page, tabId } = await launchChatTab({
    commands: [{ name: 'model', description: 'Set the model', argumentHint: '', builtin: true }],
    models: MODELS,
    model: 'claude-haiku-5-5',
    turns: { hi: [{ text: 'hello' }] }
  })
  try {
    await send(page, 'hi')
    await waitForTurn(page, tabId, 'idle')
    await expect.poll(async () => (await snapshot(page, tabId))?.state.model ?? null, { timeout: 15_000 }).toBe('claude-haiku-5-5')
    await expect(page.locator(MODEL_CHIP)).toContainText('Haiku 5.5')
    await page.locator(INPUT).click()
    await page.keyboard.type('/model')
    await page.keyboard.press('Enter')
    const picker = page.locator(MODEL_PICKER)
    await expect(picker.locator('.chat-model-option', { hasText: 'Haiku 5.5' })).toHaveAttribute('aria-pressed', 'true')
    await expect(picker.locator('.chat-model-effort')).toBeHidden()
  } finally {
    await app.close()
  }
})

test('a second click on the model chip closes the picker, and a third opens it again', async () => {
  const { app, page } = await launchChatTab({ commands: [{ name: 'model', description: 'Set the model', argumentHint: '', builtin: true }], models: MODELS, turns: {} })
  try {
    await ready(page)
    const picker = page.locator(MODEL_PICKER)
    await page.locator(MODEL_CHIP).click()
    await expect(picker).toBeVisible()
    await page.locator(MODEL_CHIP).click()
    await expect(picker).toBeHidden()
    await page.locator(MODEL_CHIP).click()
    await expect(picker).toBeVisible()
  } finally {
    await app.close()
  }
})

test('the slash menu names and descriptions line up, and a long name is cut with its full text in its title', async () => {
  const LONG = { name: 'superpowers:verification-before-completion', description: 'Verify the work before it is called done', argumentHint: '<low|medium|high|xhigh|max|auto>' }
  const { app, page } = await launchChatTab({
    commands: [...COMMANDS, LONG],
    turns: {}
  })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('/')
    await expect(page.locator(SLASH)).toBeVisible()
    const rows = page.locator(`${SLASH} .chat-slash-row`)
    await expect(rows).toHaveCount(COMMANDS.length + 1)
    const cells = await rows.evaluateAll((els) => els.map((row) => {
      const name = row.querySelector<HTMLElement>('.chat-slash-name')!
      const desc = row.querySelector<HTMLElement>('.chat-slash-desc')!
      // the visible end of the name: its text, cut at its box when the name clips
      const range = document.createRange()
      range.selectNodeContents(name)
      const textRight = range.getBoundingClientRect().right
      const box = name.getBoundingClientRect()
      const visibleRight = getComputedStyle(name).overflowX === 'visible' ? textRight : Math.min(textRight, box.right)
      return { visibleRight, descLeft: desc.getBoundingClientRect().left }
    }))
    // every name ends before its row's description begins, and the descriptions start at one x
    for (const c of cells) expect(c.visibleRight).toBeLessThanOrEqual(c.descLeft)
    expect(new Set(cells.map((c) => Math.round(c.descLeft))).size).toBe(1)
    // the long name is cut, and its row's title holds the whole command
    const longRow = rows.filter({ hasText: 'verification-before-completion' })
    const longName = longRow.locator('.chat-slash-name')
    expect(await longName.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
    await expect(longRow).toHaveAttribute('title', '/superpowers:verification-before-completion <low|medium|high|xhigh|max|auto> — Verify the work before it is called done')
  } finally {
    await app.close()
  }
})

test('a closed model picker stops asking for the models', async () => {
  const { app, page } = await launchChatTab({ commands: [{ name: 'model', description: 'Set the model', argumentHint: '', builtin: true }], models: MODELS, turns: {} })
  try {
    await ready(page)
    await emptyAndCount(app, 'chat:models', 'modelAsks')
    await page.locator(INPUT).click()
    await page.keyboard.type('/model')
    await page.keyboard.press('Enter')
    await expect.poll(() => callsOf(app, 'modelAsks')).toBeGreaterThanOrEqual(2)
    await page.keyboard.press('Escape')
    await expect(page.locator(MODEL_PICKER)).toBeHidden()
    await page.waitForTimeout(400)
    const after = await callsOf(app, 'modelAsks')
    await page.waitForTimeout(1500)
    // the answer that was on its way may come; the asks do not go on
    expect(await callsOf(app, 'modelAsks')).toBeLessThanOrEqual(after + 1)
  } finally {
    await app.close()
  }
})

test('a / or an @ typed as text opens its picker, whatever the keyboard layout', async () => {
  const { app, page, work } = await launchChatTab({ commands: COMMANDS, turns: {} })
  try {
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'notes.txt'), 'notes')
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.insertText('/')
    await expect(page.locator(SLASH)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator(SLASH)).toBeHidden()
    await page.locator(INPUT).fill('')
    await page.keyboard.type('see ')
    await page.keyboard.insertText('@')
    await expect(page.locator(FILE_PICKER)).toBeVisible()
    await expect(page.locator(FILE_ROW).nth(0)).toContainText('notes.txt')
  } finally {
    await app.close()
  }
})

test('the slash and @ buttons open their menus; Esc closes the slash menu; the @ button types its @', async () => {
  const { app, page } = await launchChatTab({ commands: COMMANDS, turns: {} })
  try {
    await ready(page)
    await page.locator('.chat-host:visible .chat-slash').click()
    await expect(page.locator(SLASH)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator(SLASH)).toBeHidden()
    await page.locator('.chat-host:visible .chat-at').click()
    await expect(page.locator(INPUT)).toHaveValue('@')
    await expect(page.locator(FILE_PICKER)).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a file with a space is mentioned in quotes; Esc closes the @ picker and keeps what was typed', async () => {
  const { app, page, work } = await launchChatTab({ turns: {} })
  try {
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'my notes.txt'), 'notes')
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('@my')
    await expect(page.locator(FILE_ROW).nth(0)).toContainText('my notes.txt')
    await page.keyboard.press('Enter')
    await expect(page.locator(INPUT)).toHaveValue('@"my notes.txt" ')
    await page.keyboard.type('@no')
    await expect(page.locator(FILE_PICKER)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator(FILE_PICKER)).toBeHidden()
    await expect(page.locator(INPUT)).toHaveValue('@"my notes.txt" @no')
  } finally {
    await app.close()
  }
})

test('the menu closes when the chat is hidden, and does not come back with it', async () => {
  const { app, page, tabId } = await launchChatTab({ commands: COMMANDS, turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.press('/')
    await expect(page.locator(SLASH)).toBeVisible()
    await page.evaluate((id) => window.ct.setTabView(id, 'terminal'), tabId)
    await page.evaluate((id) => window.ct.setTabView(id, 'chat'), tabId)
    await expect(page.locator(SLASH)).toBeHidden()
  } finally {
    await app.close()
  }
})

test('a file list still on its way: Enter does not send the half-typed @word, and the file is picked when it lands', async () => {
  const { app, page, log, work } = await launchChatTab({ turns: {} })
  try {
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'notes.txt'), 'notes')
    await ready(page)
    await delayIpc(app, 'chat:files', 1500)
    await page.locator(INPUT).click()
    await page.keyboard.type('@not')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(2500)
    expect(userMessages(log)).toEqual([])
    await expect(page.locator(INPUT)).toHaveValue('@not')
    await expect(page.locator(FILE_ROW).nth(0)).toContainText('notes.txt')
    await page.keyboard.press('Enter')
    await expect(page.locator(INPUT)).toHaveValue('@notes.txt ')
  } finally {
    await app.close()
  }
})

/** a conversation of this folder as Claude Code keeps it: one user message, dated `minutesAgo` */
function writeSession(config: string, cwd: string, id: string, prompt: string, minutesAgo: number): void {
  const dir = join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  const entry = { type: 'user', cwd, entrypoint: 'cli', isSidechain: false, message: { role: 'user', content: prompt } }
  writeFileSync(file, JSON.stringify(entry) + '\n')
  const at = new Date(Date.now() - minutesAgo * 60_000)
  utimesSync(file, at, at)
}

/** a turn of the chat ran and its session reports `n` background tasks, of the tab given: the tab's own count the window knows */
async function backgroundIn(page: Page, pipeName: string, tabId: string, n: number): Promise<void> {
  await send(page, 'hello')
  await expect(page.locator('.chat-host:visible .chat-column')).toContainText('Hi there')
  await waitForTurn(page, tabId, 'idle')
  const sessionId = (await snapshot(page, tabId))!.state.sessionId!
  const tasks = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, type: 'shell', description: `Task ${i + 1}`, command: 'npx playwright test' }))
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', background: true, tasks })).toEqual({ ok: true })
  await expect(page.locator('#statusbar .status-background')).toContainText(`${n} in background`)
}

test("a notice's Open in the terminal asks in the header while background tasks run; Cancel leaves the terminal and the text alone", async () => {
  const { app, page, pipeName, tabId } = await launchChatTab({
    commands: COMMANDS,
    turns: { hello: [{ text: 'Hi there' }], '/review focus': [{ notAvailable: 'review' }] }
  })
  try {
    await withBackgroundTask(page, pipeName, tabId)
    await send(page, '/review focus')
    await page.locator('.chat-host:visible .chat-notice button', { hasText: 'Open in the terminal' }).click()
    const header = page.locator('.sh-mode-confirm')
    await expect(header).toBeVisible()
    await expect(header).toContainText('1 background task will stop. Switch anyway?')
    await header.locator('button', { hasText: 'Cancel' }).click()
    await expect(header).toBeHidden()
    await expect(page.locator('.chat-host:visible .chat-column')).toBeVisible()
    expect(await bufferText(page, tabId)).not.toContain('you said: /review focus')
  } finally {
    await app.close()
  }
})

test("a notice's Open in the terminal during a turn says the line waits, and the line runs when the turn ends", async () => {
  const { app, page, tabId, config } = await launchChatTab({
    commands: COMMANDS,
    turns: { '/review focus': [{ notAvailable: 'review' }], slow: [{ gate: 'release' }, { text: 'slow answer' }], more: [{ text: 'more answer' }] }
  })
  try {
    await send(page, '/review focus')
    await expect(page.locator('.chat-host:visible .chat-notice button', { hasText: 'Open in the terminal' })).toHaveCount(1)
    await send(page, 'slow')
    await waitForTurn(page, tabId, 'working')
    await page.locator('.chat-host:visible .chat-notice button', { hasText: 'Open in the terminal' }).click()
    await expect(page.locator(NOTE)).toHaveText('/review opens in the terminal once Claude finishes')
    // typing and sending meanwhile keep the waiting line: its note stays, and the line runs when the turn ends
    await send(page, 'more')
    await expect(page.locator(NOTE)).toHaveText('/review opens in the terminal once Claude finishes')
    writeFileSync(join(config, 'release'), '')
    await expect.poll(() => bufferText(page, tabId), { timeout: 25_000 }).toContain('you said: /review focus')
  } finally {
    await app.close()
  }
})

test("a second question in the header replaces the first, and the first one's notice is cancelled: its text stays", async () => {
  const { app, page, pipeName, tabId } = await launchChatTab({
    commands: COMMANDS,
    turns: { hello: [{ text: 'Hi there' }], '/review focus': [{ notAvailable: 'review' }] }
  })
  try {
    await withBackgroundTask(page, pipeName, tabId)
    await send(page, '/review focus')
    await page.locator('.chat-host:visible .chat-notice button', { hasText: 'Open in the terminal' }).click()
    const header = page.locator('.sh-mode-confirm')
    await expect(header).toContainText('Switch anyway?')
    // the header's own Terminal button asks the same question: the notice's question is gone with it
    await page.locator('.sh-mode[data-view="terminal"]').click()
    await expect(page.locator(NOTE)).toBeHidden()
    await expect(header).toBeVisible()
    await header.locator('button', { hasText: 'Cancel' }).click()
    await expect(header).toBeHidden()
    expect(await bufferText(page, tabId)).not.toContain('you said: /review focus')
  } finally {
    await app.close()
  }
})

test("a session of another folder picked while tasks run asks nothing: it opens in a tab of its own", async () => {
  const { app, page, pipeName, tabId, config } = await launchChatTab({ commands: COMMANDS, turns: { hello: [{ text: 'Hi there' }] } })
  const SID_ELSEWHERE = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
  try {
    const elsewhere = mkdtempSync(join(tmpdir(), 'ct-elsewhere-'))
    writeSession(config, elsewhere, SID_ELSEWHERE, 'notes from elsewhere', 1)
    await withBackgroundTask(page, pipeName, tabId)
    await page.locator(INPUT).click()
    await page.keyboard.type('/resume')
    await page.keyboard.press('Enter')
    await expect(page.locator(SESSIONS)).toBeVisible()
    await page.keyboard.type('notes from elsewhere')
    await expect(page.locator('#sessions .session-row', { hasText: 'notes from elsewhere' })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => window.__ct!.tabIds().length), { timeout: 15_000 }).toBe(2)
    await expect(page.locator('.sh-mode-confirm')).toBeHidden()
  } finally {
    await app.close()
  }
})

test('a background question belongs to the tab that asked: the other tab drops it, and each tab asks with its own count', async () => {
  const { app, page, pipeName, tabId: a, work } = await launchChatTab({
    commands: COMMANDS,
    terminalCommands: ['config'],
    turns: { hello: [{ text: 'Hi there' }] }
  })
  try {
    await backgroundIn(page, pipeName, a, 1)
    const b = await openTabInFront(page, 'claude', work)
    await backgroundIn(page, pipeName, b, 2)
    const header = page.locator('.sh-mode-confirm')
    // tab A asks about its one task
    await page.evaluate((id) => window.ct.activateTab(id), a)
    await page.locator(INPUT).click()
    await page.keyboard.type('/config')
    await page.keyboard.press('Enter')
    await expect(header).toBeVisible()
    await expect(header).toContainText('1 background task will stop. Switch anyway?')
    // tab B is in front: A's question goes, and B's own /config asks about B's two tasks
    await page.evaluate((id) => window.ct.activateTab(id), b)
    await expect(header).toBeHidden()
    await page.locator(INPUT).click()
    await page.keyboard.type('/config')
    await page.keyboard.press('Enter')
    await expect(header).toBeVisible()
    await expect(header).toContainText('2 background tasks will stop. Switch anyway?')
    // Switch in B runs B's command only: A keeps its composer's text and its task
    await header.locator('button', { hasText: 'Switch' }).click()
    await expect(page.locator('.chat-host:visible .chat-column')).toHaveCount(0)
    await page.evaluate((id) => window.ct.activateTab(id), a)
    await expect(page.locator(INPUT)).toHaveValue('/config')
    await expect(page.locator('#statusbar .status-background')).toContainText('1 in background')
    await expect(header).toBeHidden()
  } finally {
    await app.close()
  }
})

test("Claude's own sentence about a command raises no notice button", async () => {
  const { app, page } = await launchChatTab({
    commands: COMMANDS,
    turns: { '/review focus': [{ text: "/review isn't available in this environment." }] }
  })
  try {
    await send(page, '/review focus')
    await expect(page.locator('.chat-host:visible .chat-column')).toContainText("/review isn't available in this environment.")
    await expect(page.locator('.chat-host:visible .chat-notice button')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a command answered "isn\'t available" goes to the terminal the next time, and the menu tags it', async () => {
  const { app, page, tabId } = await launchChatTab({
    commands: [...COMMANDS, { name: 'review', description: 'Review a pull request', argumentHint: '' }],
    turns: { '/review focus': [{ notAvailable: 'review' }] }
  })
  try {
    await send(page, '/review focus')
    await expect(page.locator('.chat-host:visible .chat-notice button', { hasText: 'Open in the terminal' })).toHaveCount(1)
    await page.locator(INPUT).click()
    await page.keyboard.type('/rev')
    await expect(page.locator(SLASH_ROW, { hasText: 'review' }).locator('.chat-slash-tag')).toHaveText('Opens in the terminal')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await send(page, '/review')
    await expect.poll(() => bufferText(page, tabId), { timeout: 25_000 }).toContain('you said: /review')
    await expect(page.locator('.chat-host:visible .chat-notice button')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('Enter with no command matching closes the menu and sends the text', async () => {
  const { app, page, log } = await launchChatTab({ commands: COMMANDS, turns: {} })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('/zzz')
    await expect(page.locator(SLASH)).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator(SLASH)).toBeHidden()
    await expect.poll(() => userMessages(log)).toEqual(['/zzz'])
  } finally {
    await app.close()
  }
})

test('Esc on a pending terminal command drops it and keeps the turn; the next Esc interrupts the turn', async () => {
  const { app, page, tabId } = await launchChatTab({
    commands: COMMANDS,
    terminalCommands: ['config'],
    turns: { slow: [{ gate: 'release' }, { text: 'slow answer' }] }
  })
  try {
    await send(page, 'slow')
    await waitForTurn(page, tabId, 'working')
    await page.locator(INPUT).click()
    await page.keyboard.type('/config')
    await page.keyboard.press('Enter')
    await expect(page.locator(NOTE)).toHaveText('/config opens in the terminal once Claude finishes')
    await page.keyboard.press('Escape')
    await expect(page.locator(NOTE)).toBeHidden()
    await expect(page.locator(INPUT)).toHaveValue('/config')
    await page.waitForTimeout(300)
    expect((await snapshot(page, tabId))?.state.turn).toBe('working')
    await page.keyboard.press('Escape')
    await waitForTurn(page, tabId, 'idle')
  } finally {
    await app.close()
  }
})

test('a second Enter while a command is handed to the terminal does nothing: no refusal, one hand-over', async () => {
  const { app, page } = await launchChatTab({ commands: COMMANDS, terminalCommands: ['config'], turns: {} })
  try {
    // the first hand-over takes a while; a second one would be refused, as main refuses a command while one waits
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { handoffs: number }
      g.handoffs = 0
      ipcMain.removeHandler('chat:open-in-terminal')
      ipcMain.handle('chat:open-in-terminal', async () => {
        g.handoffs += 1
        if (g.handoffs > 1) return false
        await new Promise((r) => setTimeout(r, 1200))
        return true
      })
    })
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('/config')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1800)
    expect(await app.evaluate(() => (globalThis as unknown as { handoffs: number }).handoffs)).toBe(1)
    // the refusal line is in the DOM, hidden when there is none: it must not show
    await expect(page.locator('.chat-refusal').first()).toBeHidden()
  } finally {
    await app.close()
  }
})

test('a project command is listed under This project', async () => {
  const work = mkdtempSync(join(tmpdir(), 'ct-project-'))
  mkdirSync(join(work, '.claude', 'commands'), { recursive: true })
  writeFileSync(join(work, '.claude', 'commands', 'deploy-now.md'), 'Deploy the branch.\n')
  const { app, page } = await launchChatTab({
    commands: [...COMMANDS, { name: 'deploy-now', description: 'Deploy the branch', argumentHint: '' }],
    turns: {}
  }, { work })
  try {
    await ready(page)
    await page.locator(INPUT).click()
    await page.keyboard.type('/deploy')
    await expect(page.locator(SLASH_GROUP, { hasText: 'This project' })).toHaveCount(1)
    await expect(page.locator(SLASH_ROW, { hasText: 'deploy-now' })).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('/resume opens the sessions window at once; a pick that resumes here asks about background tasks first, and Cancel keeps the chat', async () => {
  const { app, page, pipeName, tabId, work, config } = await launchChatTab({ commands: COMMANDS, turns: { hello: [{ text: 'Hi there' }] } })
  const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
  try {
    writeSession(config, work, SID, 'the login work here', 5)
    await withBackgroundTask(page, pipeName, tabId)
    await page.locator(INPUT).click()
    await page.keyboard.type('/resume')
    await page.keyboard.press('Enter')
    await expect(page.locator(SESSIONS)).toBeVisible()
    await expect(page.locator('.sh-mode-confirm')).toBeHidden()
    await page.keyboard.type('login work')
    await expect(page.locator('#sessions .session-row', { hasText: 'login work' })).toBeVisible()
    await page.keyboard.press('Enter')
    const header = page.locator('.sh-mode-confirm')
    await expect(header).toBeVisible()
    await expect(header).toContainText('1 background task will stop. Resume here anyway?')
    await header.locator('button', { hasText: 'Cancel' }).click()
    await expect(header).toBeHidden()
    expect((await snapshot(page, tabId))?.state.sessionId).not.toBe(SID)
    await page.locator(INPUT).click()
    await page.keyboard.type('/resume')
    await page.keyboard.press('Enter')
    await expect(page.locator(SESSIONS)).toBeVisible()
    await page.keyboard.type('login work')
    await expect(page.locator('#sessions .session-row', { hasText: 'login work' })).toBeVisible()
    await page.keyboard.press('Enter')
    await header.locator('button', { hasText: 'Resume' }).click()
    await expect.poll(async () => (await snapshot(page, tabId))?.state.sessionId ?? null, { timeout: 30_000 }).toBe(SID)
  } finally {
    await app.close()
  }
})
