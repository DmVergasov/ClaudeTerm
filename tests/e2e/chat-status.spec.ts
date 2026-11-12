import { expect, test, type Page } from '@playwright/test'
import { CONTINUE_PROMPT } from '../../src/main/auto-continue'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { launchChatTab, sendMessage, userMessages } from './chat-helpers'

const STATUS_BACKGROUND = '#statusbar .status-background'
const TASK = { id: 'b1', type: 'shell', description: 'Run the e2e suite', command: 'npx playwright test' }
const TASK2 = { id: 'b2', type: 'monitor', description: 'Watch the log', command: 'tail -f server.log' }
const TASK3 = { id: 'c1', type: 'shell', description: 'Build the docs', command: 'npm run docs' }
const LIST_STOPS = '.status-tasks .status-task-stop'

type Logged = { in?: { type?: string; request?: { subtype?: string; task_id?: string } } }

/** the session the chat runs: the one its init named, which comes with the first turn */
async function chatSession(page: Page, tabId: string): Promise<string> {
  await expect.poll(() => page.evaluate((id) => window.ct.chatSnapshot(id).then((s) => s?.state.sessionId ?? null), tabId)).not.toBeNull()
  return page.evaluate((id) => window.ct.chatSnapshot(id).then((s) => s!.state.sessionId!), tabId)
}

/** the chat's turn state: working or idle */
const turnState = (page: Page, tabId: string): Promise<string | null> => page.evaluate((id) => window.ct.chatSnapshot(id).then((s) => s?.state.turn ?? null), tabId)

test('in chat view the status bar has no model pill and shows the context', async () => {
  const { app, page } = await launchChatTab({ turns: {}, contextPct: 42 })
  try {
    await sendMessage(page, 'hi')
    // the context is read as the turn starts and after it: the fill the stand-in answers, with the counts of its recorded answer
    await expect(page.locator('#statusbar .status-context .status-text')).toHaveText('ctx 42% · 21k/1M')
    expect(await page.locator('#statusbar .status-context .status-bar').evaluate((el) => el.style.getPropertyValue('--fill'))).toBe('42%')
    // the composer's model chip carries the model instead
    await expect(page.locator('#statusbar .status-model')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a long turn shows the context while it runs, not only once it has ended', async () => {
  // the turn named "long" waits until it is interrupted: no result comes while the test looks
  const { app, page, tabId } = await launchChatTab({ turns: { long: [{ wait: 60_000 }] }, contextPct: 42 })
  try {
    await sendMessage(page, 'long')
    await expect.poll(() => turnState(page, tabId)).toBe('working')
    await expect(page.locator('#statusbar .status-context .status-text')).toHaveText('ctx 42% · 21k/1M')
    expect(await turnState(page, tabId)).toBe('working')
    // Esc ends the waiting turn, so the app closes at once
    await page.locator('.chat-host:visible .chat-input').click()
    await page.keyboard.press('Escape')
    await expect.poll(() => turnState(page, tabId)).toBe('idle')
  } finally {
    await app.close()
  }
})

test('the session segments sit in the middle of the chat, under its message box, also while a side panel takes the right of the sheet', async () => {
  const { app, page } = await launchChatTab({ turns: {}, contextPct: 42 })
  const centers = (): Promise<{ status: number; field: number; fieldRight: number; panelLeft: number }> => page.evaluate(() => {
    const middle = document.querySelector('#statusbar .status-zone-middle')!.getBoundingClientRect()
    const field = [...document.querySelectorAll('.chat-field')].map((el) => el.getBoundingClientRect()).find((r) => r.width > 0)!
    const panel = document.getElementById('image-panel')!.getBoundingClientRect()
    return { status: middle.left + middle.width / 2, field: field.left + field.width / 2, fieldRight: field.right, panelLeft: panel.left }
  })
  try {
    await sendMessage(page, 'hi')
    await expect(page.locator('#statusbar .status-context .status-text')).toHaveText('ctx 42% · 21k/1M')
    await expect.poll(async () => { const c = await centers(); return Math.abs(c.status - c.field) }).toBeLessThanOrEqual(2)
    // the Media panel opens beside the chat: the chat and its message box narrow, and the segments follow their middle
    await page.locator('#sheet-header .tab-images-toggle').click()
    await expect(page.locator('#image-panel')).not.toHaveClass(/collapsed/)
    await expect.poll(async () => { const c = await centers(); return c.panelLeft >= c.fieldRight }).toBe(true)
    await expect.poll(async () => { const c = await centers(); return Math.abs(c.status - c.field) }).toBeLessThanOrEqual(2)
  } finally {
    await app.close()
  }
})

test('the context segment shows the token counts the answer gives', async () => {
  const { app, page } = await launchChatTab({ turns: {}, contextPct: 74, contextTokens: 148000, contextMax: 200000 })
  try {
    await sendMessage(page, 'hi')
    await expect(page.locator('#statusbar .status-context .status-text')).toHaveText('ctx 74% · 148k/200k')
  } finally {
    await app.close()
  }
})

test('a fill whose answer gives only one of the token counts shows the share alone', async () => {
  const { app, page } = await launchChatTab({ turns: {}, contextPct: 74, contextTokens: null, contextMax: 200000 })
  try {
    await sendMessage(page, 'hi')
    // a size with no used count would read as 0/200k: neither count is shown
    await expect(page.locator('#statusbar .status-context .status-text')).toHaveText('ctx 74%')
  } finally {
    await app.close()
  }
})

test('a background task can be stopped from the status bar', async () => {
  // the turn named "long" waits until it is interrupted, so Esc has a turn to stop
  const { app, page, tabId, pipeName, log } = await launchChatTab({ turns: { long: [{ wait: 60_000 }] } })
  const stops = (): string[] => (log() as Logged[]).filter((e) => e.in?.request?.subtype === 'stop_task').map((e) => e.in!.request!.task_id ?? '')
  try {
    await sendMessage(page, 'first')
    const sessionId = await chatSession(page, tabId)
    await expect.poll(() => turnState(page, tabId)).toBe('idle')
    // a turn that ends with one task still running: the status bar names it
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', background: true, tasks: [TASK] })).toEqual({ ok: true })
    await expect(page.locator(`${STATUS_BACKGROUND} .status-text`)).toHaveText('1 in background: Run the e2e suite')

    // Esc during a turn stops the turn only: the task is left running
    await sendMessage(page, 'long')
    await expect.poll(() => turnState(page, tabId)).toBe('working')
    // the window shows the turn running: Esc acts on what the person sees
    await expect(page.locator('.chat-host:visible .chat-working')).toBeVisible()
    await page.locator('.chat-host:visible .chat-input').click()
    await page.keyboard.press('Escape')
    await expect.poll(() => turnState(page, tabId)).toBe('idle')
    expect((log() as Logged[]).some((e) => e.in?.request?.subtype === 'interrupt')).toBe(true)
    expect(stops()).toEqual([])

    // the segment opens a list of the tasks; the task's ✕ stops it by its id
    await page.locator(STATUS_BACKGROUND).click()
    const row = page.locator('.status-tasks .status-task', { hasText: 'Run the e2e suite' })
    await expect(row).toHaveCount(1)
    await row.locator('button[title="Stop this task"]').click()
    await expect.poll(stops).toEqual(['b1'])
  } finally {
    await app.close()
  }
})

test('the title bar shows the limits the stream reported', async () => {
  const now = Math.floor(Date.now() / 1000)
  const { app, page } = await launchChatTab({
    turns: {},
    fallback: [
      { rateLimit: { type: 'five_hour', utilization: 0.42, resetsAt: now + 4 * 3600, status: 'allowed' } },
      { rateLimit: { type: 'seven_day', utilization: 0.13, resetsAt: now + 3 * 86400, status: 'allowed' } }
    ]
  })
  try {
    await sendMessage(page, 'hi')
    await expect(page.locator('#titlebar .meter-limit .meter-pct')).toHaveText('42%')
    await expect(page.locator('#titlebar .meter-week .meter-pct')).toHaveText('13%')
  } finally {
    await app.close()
  }
})

test('a weekly event whose windows carry the five-hour limit shows both limits', async () => {
  const now = Math.floor(Date.now() / 1000)
  const { app, page } = await launchChatTab({
    turns: {},
    fallback: [
      { rateLimit: { type: 'seven_day', utilization: 0.87, resetsAt: now + 3 * 86400, status: 'allowed', windows: {
        five_hour: { utilization: 0.42, resetsAt: now + 4 * 3600 },
        seven_day: { utilization: 0.87, resetsAt: now + 3 * 86400 }
      } } }
    ]
  })
  try {
    await sendMessage(page, 'hi')
    await expect(page.locator('#titlebar .meter-limit .meter-pct')).toHaveText('42%')
    await expect(page.locator('#titlebar .meter-week .meter-pct')).toHaveText('87%')
  } finally {
    await app.close()
  }
})

test('a cut-off answer is continued in chat view', async () => {
  const { app, page, tabId, pipeName, log } = await launchChatTab({ turns: {} }, { autoContinue: true })
  try {
    await sendMessage(page, 'hi')
    const sessionId = await chatSession(page, tabId)
    // the end of a turn a dropped connection cut off, as the StopFailure hook reports it
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', error: 'server_error' })).toEqual({ ok: true })
    await expect.poll(() => userMessages(log), { timeout: 20_000 }).toContain(CONTINUE_PROMPT)
  } finally {
    await app.close()
  }
})

test('a cut-off answer is not continued while the composer holds a draft', async () => {
  const { app, page, tabId, pipeName, log } = await launchChatTab({ turns: {} }, { autoContinue: true })
  try {
    await sendMessage(page, 'hi')
    const sessionId = await chatSession(page, tabId)
    // the user is typing: the draft stays in the composer and holds the continue back
    await page.locator('.chat-host:visible .chat-input').click()
    await page.keyboard.type('half a sentence')
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', error: 'server_error' })).toEqual({ ok: true })
    // the continue would be due after 5 s: it is given up, not sent later
    await page.waitForTimeout(7000)
    expect(userMessages(log)).not.toContain(CONTINUE_PROMPT)
    await expect(page.locator('.chat-host:visible .chat-input')).toHaveValue('half a sentence')
  } finally {
    await app.close()
  }
})

test('a task stopped with ✕ stays gone: a later turn does not bring it back into the status bar', async () => {
  const { app, page, tabId, pipeName, log } = await launchChatTab({ turns: { after: [{ text: 'ok' }] } })
  try {
    await sendMessage(page, 'first')
    const sessionId = await chatSession(page, tabId)
    await expect.poll(() => turnState(page, tabId)).toBe('idle')
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', background: true, tasks: [TASK] })).toEqual({ ok: true })
    await expect(page.locator(`${STATUS_BACKGROUND} .status-text`)).toHaveText('1 in background: Run the e2e suite')
    await page.locator(STATUS_BACKGROUND).click()
    await page.locator('.status-tasks .status-task', { hasText: 'Run the e2e suite' }).locator('button[title="Stop this task"]').click()
    await expect(page.locator(STATUS_BACKGROUND)).toBeHidden()
    // the next turn and its status updates: the stopped task is not in them, so the bar keeps no trace of it
    await sendMessage(page, 'after')
    await expect.poll(() => userMessages(log)).toContain('after')
    await expect.poll(() => turnState(page, tabId)).toBe('idle')
    await expect(page.locator(STATUS_BACKGROUND)).toBeHidden()
    expect((log() as Logged[]).filter((e) => e.in?.request?.subtype === 'stop_task').length).toBe(1)
  } finally {
    await app.close()
  }
})

test('an open list keeps its rows, and the ✕ under the pointer, through status updates', async () => {
  const { app, page, tabId, pipeName, log } = await launchChatTab({ turns: {} })
  const stops = (): string[] => (log() as Logged[]).filter((e) => e.in?.request?.subtype === 'stop_task').map((e) => e.in!.request!.task_id ?? '')
  try {
    await sendMessage(page, 'first')
    const sessionId = await chatSession(page, tabId)
    await expect.poll(() => turnState(page, tabId)).toBe('idle')
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', background: true, tasks: [TASK, TASK2] })).toEqual({ ok: true })
    await page.locator(STATUS_BACKGROUND).click()
    await expect(page.locator(LIST_STOPS)).toHaveCount(2)
    // the first row's ✕ is tagged: its node must be the same one after every update
    await page.locator(LIST_STOPS).first().evaluate((el) => { (el as HTMLElement).dataset.keep = '1' })
    // a press on ✕ that an update lands in: the click still comes
    const box = (await page.locator(LIST_STOPS).first().boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    // a task renamed by the update: its row changes in place
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', background: true, tasks: [{ ...TASK, description: 'Run the e2e suite again' }, TASK2] })).toEqual({ ok: true })
    await expect(page.locator('.status-tasks .status-task-name').first()).toHaveText('Run the e2e suite again')
    await expect(page.locator('.status-tasks .status-task-name').first()).toHaveAttribute('title', 'Run the e2e suite again')
    await expect(page.locator('[data-keep="1"]')).toHaveCount(1)
    // the ✕ that had the pointer keeps the focus through the update too
    await expect(page.locator('[data-keep="1"]')).toBeFocused()
    await page.mouse.up()
    await expect.poll(stops).toEqual(['b1'])
  } finally {
    await app.close()
  }
})

test('the background segment and its list work from the keyboard', async () => {
  const { app, page, tabId, pipeName, log } = await launchChatTab({ turns: {} })
  const stops = (): string[] => (log() as Logged[]).filter((e) => e.in?.request?.subtype === 'stop_task').map((e) => e.in!.request!.task_id ?? '')
  try {
    await sendMessage(page, 'first')
    const sessionId = await chatSession(page, tabId)
    await expect.poll(() => turnState(page, tabId)).toBe('idle')
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', background: true, tasks: [TASK, TASK2] })).toEqual({ ok: true })
    const segment = page.locator(STATUS_BACKGROUND)
    await expect(segment.locator('.status-text')).toHaveText('2 in background: Run the e2e suite, Watch the log')
    await expect(segment).toHaveAttribute('role', 'button')
    await expect(segment).toHaveAttribute('tabindex', '0')
    await segment.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.status-tasks')).toBeVisible()
    await expect(segment).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator(LIST_STOPS).first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator(LIST_STOPS).nth(1)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(page.locator(LIST_STOPS).first()).toBeFocused()
    // Esc closes the list and gives the focus back to the segment; the turn is not interrupted
    await page.keyboard.press('Escape')
    await expect(page.locator('.status-tasks')).toBeHidden()
    await expect(segment).toBeFocused()
    await expect(segment).toHaveAttribute('aria-expanded', 'false')
    expect((log() as Logged[]).some((e) => e.in?.request?.subtype === 'interrupt')).toBe(false)
    // Space opens it too
    await page.keyboard.press('Space')
    await expect(page.locator('.status-tasks')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.status-tasks')).toBeHidden()
    expect(stops()).toEqual([])
  } finally {
    await app.close()
  }
})

test('when the focused task ends, the focus moves to the row that takes its place', async () => {
  const { app, page, tabId, pipeName } = await launchChatTab({ turns: {} })
  try {
    await sendMessage(page, 'first')
    const sessionId = await chatSession(page, tabId)
    await expect.poll(() => turnState(page, tabId)).toBe('idle')
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', background: true, tasks: [TASK, TASK2, TASK3] })).toEqual({ ok: true })
    await page.locator(STATUS_BACKGROUND).click()
    await expect(page.locator(LIST_STOPS)).toHaveCount(3)
    // the middle task ends while its Stop has the focus: the row after it takes the focus
    await page.locator(LIST_STOPS).nth(1).focus()
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', background: true, tasks: [TASK, TASK3] })).toEqual({ ok: true })
    await expect(page.locator(LIST_STOPS)).toHaveCount(2)
    await expect(page.locator(LIST_STOPS).nth(1)).toBeFocused()
    // the last one ends: the focus goes to the row that is then last
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', background: true, tasks: [TASK] })).toEqual({ ok: true })
    await expect(page.locator(LIST_STOPS)).toHaveCount(1)
    await expect(page.locator(LIST_STOPS).first()).toBeFocused()
  } finally {
    await app.close()
  }
})

test('the list closes when the last of its tasks ends', async () => {
  const { app, page, tabId, pipeName } = await launchChatTab({ turns: {} })
  try {
    await sendMessage(page, 'first')
    const sessionId = await chatSession(page, tabId)
    await expect.poll(() => turnState(page, tabId)).toBe('idle')
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', background: true, tasks: [TASK] })).toEqual({ ok: true })
    await page.locator(STATUS_BACKGROUND).click()
    await expect(page.locator('.status-tasks')).toBeVisible()
    // a turn end that names no background task: the list has nothing left to show
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', tasks: [] })).toEqual({ ok: true })
    await expect(page.locator('.status-tasks')).toBeHidden()
  } finally {
    await app.close()
  }
})

test('the list closes when the tab in front changes', async () => {
  const { app, page, tabId, pipeName, work } = await launchChatTab({ turns: {} })
  try {
    await sendMessage(page, 'first')
    const sessionA = await chatSession(page, tabId)
    await expect.poll(() => turnState(page, tabId)).toBe('idle')
    // a second chat tab with a task of its own, which is reported while the first tab is in front
    const tabB = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), work))!.id
    await page.evaluate((id) => window.ct.chatSend(id, { text: 'first', attachments: [] }), tabB)
    const sessionB = await chatSession(page, tabB)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId: tabB, sessionId: sessionB, reason: 'done', background: true, tasks: [TASK3] })).toEqual({ ok: true })
    // the first tab's list is open
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: sessionA, reason: 'done', background: true, tasks: [TASK, TASK2] })).toEqual({ ok: true })
    await page.locator(STATUS_BACKGROUND).click()
    await expect(page.locator('.status-tasks')).toBeVisible()
    // the second tab comes to the front: its tasks are not the first tab's list
    await page.evaluate((id) => window.ct.activateTab(id), tabB)
    await expect(page.locator(STATUS_BACKGROUND + ' .status-text')).toHaveText('1 in background: Build the docs')
    await expect(page.locator('.status-tasks')).toBeHidden()
  } finally {
    await app.close()
  }
})

test('an open list follows the status bar when the window is resized', async () => {
  const { app, page, tabId, pipeName } = await launchChatTab({ turns: {} })
  try {
    await sendMessage(page, 'first')
    const sessionId = await chatSession(page, tabId)
    await expect.poll(() => turnState(page, tabId)).toBe('idle')
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', background: true, tasks: [TASK, TASK2] })).toEqual({ ok: true })
    await page.locator(STATUS_BACKGROUND).click()
    await expect(page.locator('.status-tasks')).toBeVisible()
    // the window gets shorter: the status bar moves, and the list must sit above it again
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!
      const [width, height] = win.getSize()
      win.setSize(width, height - 120)
    })
    await expect.poll(() => page.evaluate(() => {
      const list = document.querySelector('.status-tasks')!.getBoundingClientRect()
      const bar = document.getElementById('statusbar')!.getBoundingClientRect()
      return Math.round(bar.top - list.bottom)
    })).toBe(4)
  } finally {
    await app.close()
  }
})

test('a task stopped with ✕ leaves the list and the count once Claude Code takes the stop; a second ✕ does nothing', async () => {
  const { app, page, tabId, pipeName, log } = await launchChatTab({ turns: {} })
  const stops = (): string[] => (log() as Logged[]).filter((e) => e.in?.request?.subtype === 'stop_task').map((e) => e.in!.request!.task_id ?? '')
  try {
    await sendMessage(page, 'first')
    const sessionId = await chatSession(page, tabId)
    await expect.poll(() => turnState(page, tabId)).toBe('idle')
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', background: true, tasks: [TASK, TASK2] })).toEqual({ ok: true })
    await expect(page.locator(`${STATUS_BACKGROUND} .status-text`)).toHaveText('2 in background: Run the e2e suite, Watch the log')
    await page.locator(STATUS_BACKGROUND).click()
    const stop = page.locator('.status-tasks .status-task', { hasText: 'Run the e2e suite' }).locator('button[title="Stop this task"]')
    await stop.dblclick()
    await expect(page.locator('.status-tasks .status-task', { hasText: 'Run the e2e suite' })).toHaveCount(0)
    await expect(page.locator(`${STATUS_BACKGROUND} .status-text`)).toHaveText('1 in background: Watch the log')
    expect(stops()).toEqual(['b1'])
  } finally {
    await app.close()
  }
})
