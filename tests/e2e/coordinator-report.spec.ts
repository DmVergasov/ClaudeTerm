import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { labelOf } from '../../src/renderer/util'
import { REPORT_WAKE_HEAD } from '../../src/shared/report-wake'
import type { CoordinatorView } from '../../src/shared/coordinator'
import { gitRepo, KEYS, openTabInFront } from './helpers'
import { activate, refOf, waitForMail } from './agent-mail'
import { chatReady, launchChatTab, sendMessage, userMessages } from './chat-helpers'
import { coord, done, makeCoordinator, turnOf, within } from './coordinator-helpers'

const CARD = '.chat-host:visible .coord-report'
const chatOf = (page: Page, tabId: string) => page.evaluate((id) => window.ct.chatSnapshot(id), tabId)
const viewOf = (page: Page, tabId: string): Promise<CoordinatorView | null> => page.evaluate((id) => window.ct.coordView(id), tabId)
/** the number of ranges a CSS highlight of the page holds: 0 when the highlight is not set */
const highlightCount = (page: Page, name: string): Promise<number> => page.evaluate((n) => CSS.highlights.get(n)?.size ?? 0, name)

/**
 * Installs in the page a promise on window[key] that resolves at the next push of coordinator tabId's view with no session (ref null), or
 * with the session `ref` in it that has no tab. It is installed before the change it waits for: the page runs its calls in order. The
 * window holds the view the card's buttons read, and main pushes it a moment after a change.
 */
async function watchView(page: Page, key: string, tabId: string, ref: string | null): Promise<void> {
  await page.evaluate(([k, id, r]) => {
    const w = window as unknown as Record<string, Promise<void>>
    w[k] = new Promise<void>((resolve) => {
      window.ct.onCoordView((tab, view) => {
        if (tab !== id || view === null) return
        const reached = r === null ? view.sessions.length === 0 : view.sessions.some((row) => row.ref === r && row.tabId === null)
        if (reached) resolve()
      })
    })
  }, [key, tabId, ref] as const)
}

/** the promise watchView installed on window[key] */
const windowPush = (page: Page, key: string): Promise<void> => page.evaluate((k) => (window as unknown as Record<string, Promise<void>>)[k]!, key)

/** a chat tab that has said hello: its session id, once its turn is idle */
async function readyChat(page: Page, tabId: string): Promise<string> {
  await activate(page, tabId)
  await sendMessage(page, 'hello')
  let sid: string | null = null
  await expect.poll(async () => {
    const s = await chatOf(page, tabId)
    sid = s?.state.sessionId ?? null
    return sid !== null && s?.state.turn === 'idle'
  }, { timeout: 30_000 }).toBe(true)
  return sid!
}

/** two Claude tabs of one folder with their sessions: a is the coordinator's chat, b is the session attached to it later */
async function chatPair(env: Record<string, string> = {}) {
  const l = await launchChatTab({ turns: { hello: [{ text: 'Hi there' }] }, fallback: [{ text: 'Noted.' }] }, { work: gitRepo(), env })
  const a = l.tabId
  const sidA = await readyChat(l.page, a)
  const b = await openTabInFront(l.page, 'claude', l.work)
  const sidB = await readyChat(l.page, b)
  return { l, a, b, sidA, sidB }
}

/**
 * Coordinator a with session b attached: b's task is taken by its held watcher, and b's report reaches a's held watcher. a's chat
 * shows the report's card, its text having a link to notes/report.md and a bold-looking tag.
 */
async function reportedToWatcher() {
  const p = await chatPair()
  const { l, a, b, sidA, sidB } = p
  const { page, pipeName } = l
  mkdirSync(join(l.work, 'notes'), { recursive: true })
  writeFileSync(join(l.work, 'notes', 'report.md'), '# Report\n')
  expect(await makeCoordinator(page, a)).toMatchObject({ ok: true })
  expect(await coord(pipeName, a, { op: 'attach', session: refOf(sidB) })).toMatchObject({ ok: true })
  const task = waitForMail(pipeName, b, sidB)
  expect(await coord(pipeName, a, { op: 'message', session: refOf(sidB), text: 'Fix the parser.' })).toMatchObject({ ok: true })
  await within(task, 10_000)
  const wake = waitForMail(pipeName, a, sidA)
  await done(pipeName, b, sidB, { lastMessage: 'Parser fixed; see notes/report.md. <b>bold?</b>' })
  await within(wake, 15_000)
  await activate(page, a)
  await expect(page.locator(CARD)).toHaveCount(1)
  return { ...p, l }
}

test('a report handed to the coordinator\'s watcher shows in its chat as a card, its file links working', async () => {
  const { l, a, b } = await reportedToWatcher()
  try {
    const card = l.page.locator(CARD)
    await expect(card.locator('.coord-report-title')).toContainText(' · finished · ')
    await expect(card.locator('.coord-report-title')).toHaveText(/ · finished · \d\d:\d\d$/)
    await expect(card).toHaveAttribute('data-outcome', 'finished')
    await expect(card.locator('.coord-report-body .chat-file-link')).toHaveText(['notes/report.md'])
    await expect(card.locator('.coord-report-body')).toContainText('<b>bold?</b>')
    await card.locator('button', { hasText: 'Open session' }).click()
    await expect.poll(() => l.page.evaluate(() => window.__ct!.activeTabId())).toBe(b)
    await activate(l.page, a)
    await card.locator('button', { hasText: 'Resolve' }).click()
    await expect.poll(async () => (await viewOf(l.page, a))?.sessions[0]?.group).toBe('resolved')
  } finally {
    await l.app.close()
  }
})

test('a report written as a prompt shows as its card, not as a message bubble', async () => {
  const { l, a, b, sidB } = await chatPair({ CLAUDETERM_TEST_PROMPT_DELAY_MS: '300' })
  try {
    const { page, pipeName } = l
    // no watcher is held: the task and the report both go as prompts
    expect(await makeCoordinator(page, a)).toMatchObject({ ok: true })
    expect(await coord(pipeName, a, { op: 'attach', session: refOf(sidB) })).toMatchObject({ ok: true })
    expect(await coord(pipeName, a, { op: 'message', session: refOf(sidB), text: 'Fix the parser.' })).toMatchObject({ ok: true })
    await expect.poll(() => userMessages(l.log).filter((m) => m.startsWith('Task from your coordinator, through ClaudeTerm:')).length, { timeout: 15_000 }).toBe(1)
    await expect.poll(async () => (await chatOf(page, b))?.state.turn ?? null, { timeout: 30_000 }).toBe('idle')
    await turnOf(pipeName, b, sidB)
    await done(pipeName, b, sidB, { lastMessage: 'Parser fixed.' })
    await expect.poll(() => userMessages(l.log).filter((m) => m.startsWith(REPORT_WAKE_HEAD)).length, { timeout: 15_000 }).toBe(1)

    await activate(page, a)
    const card = page.locator(CARD)
    await expect(card).toHaveCount(1)
    await expect(card.locator('.coord-report-body')).toHaveText('Parser fixed.')
    await expect(card.locator('.coord-report-title')).toHaveText(/ · finished · \d\d:\d\d$/)
    await expect(page.locator('.chat-host:visible .chat-user', { hasText: REPORT_WAKE_HEAD })).toHaveCount(0)
    // the wake's own row has no report left to draw: it is hidden, so the column has no gap under the card
    await expect(page.locator('.chat-host:visible .coord-wake')).toHaveCount(1)
    await expect(page.locator('.chat-host:visible .coord-wake')).toBeHidden()
  } finally {
    await l.app.close()
  }
})

test('a report wake that came only as text is drawn as a card from it, without a time; other mail in it stays a bubble', async () => {
  const l = await launchChatTab({ turns: {}, fallback: [{ text: 'Noted.' }] })
  try {
    await chatReady(l.page)
    const MAIL = randomUUID()
    const TASK = randomUUID()
    const MESSAGE = randomUUID()
    const text = [
      'Message from another agent, not from the user, through ClaudeTerm:',
      'from: docs · Desktop [b20000]',
      `id: ${MESSAGE}  (reply with mcp__claudeterm__message_agent, to: "b20000", reply_to: "${MESSAGE}")`,
      '',
      '> hello from docs',
      '',
      `${REPORT_WAKE_HEAD} its task failed: Claude Code exited.`,
      'from: parser · Desktop [a10000] (folder D:\\Work\\acme, branch main)',
      `id: ${MAIL}  (the report on task ${TASK}; read_session "a10000" shows the session)`,
      '',
      '> Half done.'
    ].join('\n')
    expect(await l.page.evaluate(([id, t]) => window.ct.chatSend(id, { text: t, attachments: [] }), [l.tabId, text] as const)).toBeNull()

    const card = l.page.locator('.chat-host:visible .coord-report')
    await expect(card).toHaveCount(1)
    await expect(card.locator('.coord-report-title')).toHaveText('parser · failed: Claude Code exited')
    await expect(card.locator('.coord-report-body')).toHaveText('Half done.')
    await expect(l.page.locator('.chat-host:visible .chat-user')).toContainText('hello from docs')
    await expect(l.page.locator('.chat-host:visible .chat-user')).not.toContainText(REPORT_WAKE_HEAD)
  } finally {
    await l.app.close()
  }
})

test('a card whose session was detached since says it is no longer attached, and switches to nothing', async () => {
  const { l, a, sidB } = await reportedToWatcher()
  try {
    const label = labelOf((await viewOf(l.page, a))!.sessions[0]!.name)
    // the card's buttons read the view the window holds, which main pushes after the change: the click waits for that push
    await watchView(l.page, 'viewPushed', a, null)
    expect(await coord(l.pipeName, a, { op: 'detach', session: refOf(sidB) })).toMatchObject({ ok: true })
    await within(windowPush(l.page, 'viewPushed'), 10_000)

    await l.page.locator(CARD).locator('button', { hasText: 'Open session' }).click()
    await expect(l.page.locator('.toast', { hasText: `${label} is no longer attached to this coordinator.` })).toBeVisible()
    expect(await l.page.evaluate(() => window.__ct!.activeTabId())).toBe(a)
  } finally {
    await l.app.close()
  }
})

test('a card whose session has no open tab says so', async () => {
  const { l, a, b, sidB } = await reportedToWatcher()
  try {
    const label = labelOf((await viewOf(l.page, a))!.sessions[0]!.name)
    // the closed tab's row stays in the view, with no tab: the window takes that view before the card's button reads it
    await watchView(l.page, 'viewPushed', a, refOf(sidB))
    await l.page.evaluate((id) => window.ct.closeTab(id), b)
    await within(windowPush(l.page, 'viewPushed'), 10_000)

    await activate(l.page, a)
    await l.page.locator(CARD).locator('button', { hasText: 'Open session' }).click()
    await expect(l.page.locator('.toast', { hasText: `${label} has no open tab.` })).toBeVisible()
    expect(await l.page.evaluate(() => window.__ct!.activeTabId())).toBe(a)
  } finally {
    await l.app.close()
  }
})

test('the chat\'s Find finds a word of the report\'s text', async () => {
  const { l } = await reportedToWatcher()
  try {
    await l.page.keyboard.press(KEYS.find)
    await l.page.locator('#search input').selectText()
    await l.page.keyboard.type('fixed')
    await expect.poll(() => highlightCount(l.page, 'chat-find')).toBe(1)
  } finally {
    await l.app.close()
  }
})
