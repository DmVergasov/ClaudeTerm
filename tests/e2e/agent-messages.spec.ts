import { expect, test, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { FAKE_CLAUDE_SETTINGS, launchApp, launchClaudeTab, type Launched } from './helpers'
import {
  activate, badge, envelopeOf, hasMailWatcher, MAIL_PREFIX, messagesButton, openPanelFocused, refOf, sendText, sessionStartHooks, setSetting, startSession, VERSION_SETTINGS, waitForMail
} from './agent-mail'

const OFF = 'Agent messages are turned off in ClaudeTerm on this device.'

/** the command the version cache holds, or null while the file is missing or being written */
function cachedCommand(dataDir: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dataDir, 'claude-version.json'), 'utf8')) as { command: string }).command
  } catch {
    return null
  }
}

/** the app with two Claude tabs in two folders, both with a session; the mail watcher is on once the probe has answered */
async function twoClaudeTabs(settings: object = VERSION_SETTINGS, env: Record<string, string> = {}): Promise<Launched & { tab1: string; tab2: string; sid1: string; sid2: string; work1: string; work2: string }> {
  const work1 = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const work2 = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const launched = await launchApp({ settings, args: ['--claude', work1], env })
  const { page, pipeName, dataDir } = launched
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tab1 = (await page.evaluate(() => window.__ct!.activeTabId()))!
  const tab2 = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), work2))!.id
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const sid1 = randomUUID()
  const sid2 = randomUUID()
  expect(await startSession(pipeName, tab1, sid1)).toEqual({ ok: true })
  expect(await startSession(pipeName, tab2, sid2)).toEqual({ ok: true })
  // with messages off no watcher is written: the tab settings file is then not checked here
  if ((settings as { agentMessages?: { enabled: boolean } }).agentMessages?.enabled !== false) {
    await expect.poll(() => hasMailWatcher(dataDir), { timeout: 15_000 }).toBe(true)
  }
  return { ...launched, tab1, tab2, sid1, sid2, work1, work2 }
}

/** rejects when the promise has no answer within ms: a bound on a wait that should end at once */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

test('two Claude tabs of one app that was never paired message each other', async () => {
  const { app, pipeName, tab1, tab2, sid2, work2 } = await twoClaudeTabs()
  try {
    const list = await sendPipeMessage(pipeName, { v: 1, type: 'agent_list', tabId: tab1 })
    expect(list).toMatchObject({ ok: true, info: expect.stringContaining(`[${refOf(sid2)}]`) })
    expect((list as { info: string }).info).toContain(work2.split(/[\\/]/).pop()!)

    const arriving = waitForMail(pipeName, tab2, sid2)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'agent_send', tabId: tab1, to: refOf(sid2), text: 'hello from the first tab', replyTo: null }))
      .toMatchObject({ ok: true, info: expect.stringMatching(/^Delivered to /) })
    const answer = await arriving
    expect(answer).toMatchObject({ ok: true, info: expect.stringContaining('hello from the first tab') })
    expect(answer.info).toContain(MAIL_PREFIX)
  } finally {
    await app.close()
  }
})

test('a second mail_wait of one tab ends the first with no info', async () => {
  const { app, pipeName, tab1, tab2, sid2 } = await twoClaudeTabs()
  try {
    const first = waitForMail(pipeName, tab2, sid2)
    const second = waitForMail(pipeName, tab2, sid2)
    // whichever wait main answers first is the superseded one, whatever order the two requests came in
    const won = await Promise.race([
      first.then((r) => ({ which: 'first' as const, answer: r })),
      second.then((r) => ({ which: 'second' as const, answer: r }))
    ])
    expect(won.answer).toEqual({ ok: true })
    const survivor = won.which === 'first' ? second : first
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'agent_send', tabId: tab1, to: refOf(sid2), text: 'after the supersede', replyTo: null }))
      .toMatchObject({ ok: true })
    expect(await survivor).toMatchObject({ ok: true, info: expect.stringContaining('after the supersede') })
  } finally {
    await app.close()
  }
})

test('turning messages off in settings releases a held mail_wait at once', async () => {
  const { app, page, pipeName, tab2, sid2 } = await twoClaudeTabs()
  try {
    // two waits for tab 2: main answers the superseded one at once, so once it has answered, the other one is held for certain
    const first = waitForMail(pipeName, tab2, sid2)
    const second = waitForMail(pipeName, tab2, sid2)
    const won = await Promise.race([
      first.then((r) => ({ which: 'first' as const, answer: r })),
      second.then((r) => ({ which: 'second' as const, answer: r }))
    ])
    expect(won.answer).toEqual({ ok: true })
    const held = won.which === 'first' ? second : first
    expect(await setSetting(page, 'agentMessages.enabled', false)).toEqual({ ok: true })
    expect(await within(held, 5_000)).toEqual({ ok: true })
  } finally {
    await app.close()
  }
})

test('messages off: agent_send answers "Agent messages are turned off in ClaudeTerm on this device." and mail_wait answers at once with no info', async () => {
  const { app, pipeName, tab1, tab2, sid2 } = await twoClaudeTabs({ ...VERSION_SETTINGS, agentMessages: { enabled: false, marks: true } })
  try {
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'agent_send', tabId: tab1, to: refOf(sid2), text: 'hello', replyTo: null }))
      .toEqual({ ok: false, error: OFF })
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'agent_list', tabId: tab1 })).toEqual({ ok: false, error: OFF })
    expect(await waitForMail(pipeName, tab2, sid2)).toEqual({ ok: true })
  } finally {
    await app.close()
  }
})

test('a mail turn\'s end plays no sound and raises no attention by default', async () => {
  // the app writes each sound it would play to this file instead
  const sounds = join(mkdtempSync(join(tmpdir(), 'ct-sound-')), 'sounds.txt')
  const played = (): string => (existsSync(sounds) ? readFileSync(sounds, 'utf8') : '')
  const { app, page, pipeName, tab1, tab2, sid2 } = await twoClaudeTabs(VERSION_SETTINGS, { CLAUDETERM_TEST_SOUND_LOG: sounds })
  try {
    const arriving = waitForMail(pipeName, tab2, sid2)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'agent_send', tabId: tab1, to: refOf(sid2), text: 'a note', replyTo: null })).toMatchObject({ ok: true })
    expect(await arriving).toMatchObject({ ok: true })

    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId: tab2, sessionId: sid2, reason: 'done' })).toEqual({ ok: true })
    expect(played()).toBe('')
    expect(await page.evaluate(() => window.__ct!.banners!())).toEqual([])
    await expect(page.locator(`[data-tab-id="${tab2}"]`)).not.toHaveClass(/\battention\b/)
    // a turn that no mail started is a done like any other: its sound plays (the control of the check above)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId: tab2, sessionId: sid2, reason: 'done' })).toEqual({ ok: true })
    expect(played()).toBe('system\n')
  } finally {
    await app.close()
  }
})

test('the tab settings file holds the mail entries only for a Claude command whose --version is 2.1.287 or later', async () => {
  const withVersion = await launchClaudeTab(VERSION_SETTINGS)
  try {
    await expect.poll(() => hasMailWatcher(withVersion.dataDir), { timeout: 15_000 }).toBe(true)
    expect(sessionStartHooks(withVersion.dataDir).filter((h) => h.asyncRewake === true)).toHaveLength(1)
    // a command change: the new command is asked for its version, and without one the watcher leaves the tab files at once
    // (the peers' accept is sent by announce(); one device here cannot see it, so only the files are checked)
    expect(await setSetting(withVersion.page, 'claude.command', FAKE_CLAUDE_SETTINGS.claude.command)).toEqual({ ok: true })
    await expect.poll(() => cachedCommand(withVersion.dataDir), { timeout: 15_000 }).toBe(FAKE_CLAUDE_SETTINGS.claude.command)
    expect(readFileSync(join(withVersion.dataDir, 'claude-tab-settings.json'), 'utf8')).not.toContain('asyncRewake')
  } finally {
    await withVersion.app.close()
  }

  const plain = await launchClaudeTab()
  try {
    // the probe answers with no version: the cache is written, and the watcher stays out
    await expect.poll(() => existsSync(join(plain.dataDir, 'claude-version.json')), { timeout: 15_000 }).toBe(true)
    expect(readFileSync(join(plain.dataDir, 'claude-tab-settings.json'), 'utf8')).not.toContain('asyncRewake')
  } finally {
    await plain.app.close()
  }
})

const EMPTY = "No messages yet. Agents write here only when Claude Code's own messaging can't reach each other."
const messagesPanel = (page: Page) => page.locator('#image-panel')

/** the last segment of a folder, which is the label of a tab that has no custom title */
const labelOf = (folder: string): string => basename(folder)

test('the Messages button shows the active tab\'s unread count and opens the Agent messages panel', async () => {
  const { app, page, pipeName, tab1, tab2, sid2, work1, work2 } = await twoClaudeTabs()
  try {
    expect(await sendText(pipeName, tab1, sid2, 'hello from the first tab')).toMatchObject({ ok: true })
    await activate(page, tab2)
    await expect(badge(page)).toHaveText('1')

    await messagesButton(page).click()
    await expect(page.locator('.panel-title')).toHaveText('Agent messages')
    await expect(page.locator('.mail-scope.active')).toHaveText('This tab')
    // the other end's name is the first tab's label and device; mine is the second tab's label alone
    await expect(page.locator('.mail-head')).toHaveText(new RegExp(`^${labelOf(work1)} · .+ ⇄ ${labelOf(work2)}$`))
    await expect(page.locator('.mail-text')).toHaveText('hello from the first tab')
  } finally {
    await app.close()
  }
})

test('a message shown in the open panel while the window has focus counts as read', async () => {
  const { app, page, pipeName, tab1, tab2, sid2 } = await twoClaudeTabs()
  try {
    expect(await sendText(pipeName, tab1, sid2, 'read me')).toMatchObject({ ok: true })
    await activate(page, tab2)
    await expect(badge(page)).toHaveText('1')

    await openPanelFocused(page)
    await expect(page.locator('.mail-text')).toHaveText('read me')
    await expect.poll(() => badge(page).textContent()).toBe('')
  } finally {
    await app.close()
  }
})

test('All lists the conversations of every tab, newest first', async () => {
  const { app, page, pipeName, tab1, sid2 } = await twoClaudeTabs()
  try {
    // a third Claude tab, so that there are two conversations to order
    const work3 = mkdtempSync(join(tmpdir(), 'ct-work-'))
    const tab3 = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), work3))!.id
    await page.waitForFunction(() => window.__ct!.tabIds().length === 3)
    const sid3 = randomUUID()
    expect(await startSession(pipeName, tab3, sid3)).toEqual({ ok: true })

    expect(await sendText(pipeName, tab1, sid2, 'first conversation')).toMatchObject({ ok: true })
    // the two sends must not share a time: the order is by time
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await sendText(pipeName, tab1, sid3, 'second conversation')).toMatchObject({ ok: true })

    await activate(page, tab1)
    await messagesButton(page).click()
    await expect(page.locator('.mail-scope.active')).toHaveText('This tab')
    await page.locator('.mail-scope', { hasText: 'All' }).click()
    await expect(page.locator('.mail-scope.active')).toHaveText('All')
    await expect(page.locator('.mail-head')).toHaveCount(2)
    await expect(page.locator('.mail-text')).toHaveText(['second conversation', 'first conversation'])
  } finally {
    await app.close()
  }
})

test('an empty panel says "No messages yet. Agents write here only when Claude Code\'s own messaging can\'t reach each other."', async () => {
  const { app, page } = await twoClaudeTabs()
  try {
    await messagesButton(page).click()
    await expect(page.locator('.panel-title')).toHaveText('Agent messages')
    await expect(page.locator('.panel-messages .panel-empty')).toHaveText(EMPTY)
  } finally {
    await app.close()
  }
})

test('a waiting message says waiting beside its time', async () => {
  // no watcher holds a mail_wait here, so the message is not delivered: it waits
  const { app, page, pipeName, tab1, tab2, sid2 } = await twoClaudeTabs()
  try {
    expect(await sendText(pipeName, tab1, sid2, 'still waiting')).toMatchObject({ ok: true })
    await activate(page, tab2)
    await messagesButton(page).click()
    await expect(page.locator('.mail-text')).toHaveText('still waiting')
    await expect(page.locator('.mail-time')).toHaveText(/ · waiting$/)
  } finally {
    await app.close()
  }
})

test('with messages off the Messages button is hidden', async () => {
  const { app, page } = await twoClaudeTabs()
  try {
    await messagesButton(page).click()
    await expect(page.locator('.panel-title')).toHaveText('Agent messages')
    await expect(messagesPanel(page)).not.toHaveClass(/collapsed/)

    expect(await setSetting(page, 'agentMessages.enabled', false)).toEqual({ ok: true })
    await expect(messagesButton(page)).toBeHidden()
    await expect(messagesPanel(page)).toHaveClass(/collapsed/)
  } finally {
    await app.close()
  }
})

test('a message that a watcher takes while the panel is open stops saying waiting', async () => {
  const { app, page, pipeName, tab1, tab2, sid2 } = await twoClaudeTabs()
  try {
    expect(await sendText(pipeName, tab1, sid2, 'taken later')).toMatchObject({ ok: true })
    await activate(page, tab2)
    await messagesButton(page).click()
    await expect(page.locator('.mail-text')).toHaveText('taken later')
    await expect(page.locator('.mail-time')).toHaveText(/ · waiting$/)

    // the watcher of tab 2 takes the mail: the record is delivered, and the open panel must say so
    // (the window keeps its focus here, so the panel reads the message as it opens; the counts then change, and
    // the delivery changes nothing in them: only the store's own change tells the window)
    const taken = await waitForMail(pipeName, tab2, sid2)
    expect(taken).toMatchObject({ ok: true, info: expect.stringContaining('taken later') })
    await expect(page.locator('.mail-text')).toHaveText('taken later')
    await expect(page.locator('.mail-time')).not.toHaveText(/waiting/)
  } finally {
    await app.close()
  }
})

test('with a shell tab active, This tab shows the empty text even when other tabs have messages', async () => {
  const { app, page, pipeName, tab1, sid2 } = await twoClaudeTabs()
  try {
    expect(await sendText(pipeName, tab1, sid2, 'between two Claude tabs')).toMatchObject({ ok: true })
    const shell = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), mkdtempSync(join(tmpdir(), 'ct-work-'))))!.id
    await page.waitForFunction(() => window.__ct!.tabIds().length === 3)
    await activate(page, shell)

    await messagesButton(page).click()
    await expect(page.locator('.mail-scope.active')).toHaveText('This tab')
    await expect(page.locator('.panel-messages .panel-empty')).toHaveText(EMPTY)
    await expect(page.locator('.mail-head')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a tab with unread messages carries the envelope mark after its title, in the top bar and in the left panel', async () => {
  const { app, page, pipeName, tab1, tab2, sid2 } = await twoClaudeTabs()
  try {
    expect(await sendText(pipeName, tab1, sid2, 'an envelope for the second tab')).toMatchObject({ ok: true })
    await expect(envelopeOf(page, tab2)).toHaveCount(1)
    await expect(envelopeOf(page, tab2)).toHaveAttribute('title', 'Unread agent messages')
    await expect(page.locator(`#tabbar .tab[data-tab-id="${tab2}"] .tab-title ~ .tab-mail`)).toHaveCount(1)

    expect(await setSetting(page, 'tabs.position', 'left')).toEqual({ ok: true })
    await expect(page.locator('#tabpanel')).toBeVisible()
    await expect(page.locator(`#tabpanel .tp-tab[data-tab-id="${tab2}"] .tab-mail`)).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('reading the messages clears the mark', async () => {
  const { app, page, pipeName, tab1, tab2, sid2 } = await twoClaudeTabs()
  try {
    expect(await sendText(pipeName, tab1, sid2, 'read me')).toMatchObject({ ok: true })
    await activate(page, tab2)
    await expect(envelopeOf(page, tab2)).toHaveCount(1)

    await openPanelFocused(page)
    await expect(page.locator('.mail-text')).toHaveText('read me')
    await expect(envelopeOf(page, tab2)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('with marks off the envelope and the badge go, and the panel still shows the messages', async () => {
  const { app, page, pipeName, tab1, tab2, sid2 } = await twoClaudeTabs()
  try {
    // the positive control: with the marks on, the message shows the envelope in the top bar, in the left panel and in the badge
    expect(await sendText(pipeName, tab1, sid2, 'no mark for this')).toMatchObject({ ok: true })
    await activate(page, tab2)
    await expect(envelopeOf(page, tab2)).toHaveCount(1)
    await expect(badge(page)).toHaveText('1')
    expect(await setSetting(page, 'tabs.position', 'left')).toEqual({ ok: true })
    await expect(page.locator('#tabpanel')).toBeVisible()
    await expect(page.locator(`#tabpanel .tp-tab[data-tab-id="${tab2}"] .tab-mail`)).toHaveCount(1)

    // the flip: the marks go off, and the envelope and the badge go with them
    expect(await setSetting(page, 'agentMessages.marks', false)).toEqual({ ok: true })
    await expect(page.locator(`#tabpanel .tp-tab[data-tab-id="${tab2}"] .tab-mail`)).toHaveCount(0)
    await expect(page.locator('#tabpanel .tab-messages-toggle .badge')).toHaveText('')

    expect(await setSetting(page, 'tabs.position', 'top')).toEqual({ ok: true })
    await expect(envelopeOf(page, tab2)).toHaveCount(0)
    await expect(badge(page)).toHaveText('')

    // the panel still lists the message, and the message is read when it is shown with the window focused
    await openPanelFocused(page)
    await expect(page.locator('.mail-text')).toHaveText('no mark for this')
    await expect(envelopeOf(page, tab2)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a conversation resumed under a new session id keeps its mail: the old address reaches the new session', async () => {
  const { app, pipeName, tab1, tab2, sid2 } = await twoClaudeTabs()
  try {
    // no watcher holds here: the message waits for tab 2 under its first session id
    expect(await sendText(pipeName, tab1, sid2, 'sent before the resume')).toMatchObject({ ok: true })
    const sid2Resumed = randomUUID()
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId: tab2, sessionId: sid2Resumed, source: 'resume', transcriptPath: null }))
      .toEqual({ ok: true })
    // the watcher of the resumed session gets the mail; without the alias the wait would be held and this would time out
    const answer = await within(waitForMail(pipeName, tab2, sid2Resumed), 5_000)
    expect(answer).toMatchObject({ ok: true, info: expect.stringContaining('sent before the resume') })
  } finally {
    await app.close()
  }
})

test('after a restart the conversation and its read message are still there, and no message is unread', async () => {
  const first = await twoClaudeTabs()
  const { page, pipeName, tab1, tab2, sid2, dataDir, work2 } = first
  try {
    expect(await sendText(pipeName, tab1, sid2, 'kept over a restart')).toMatchObject({ ok: true })
    await activate(page, tab2)
    await openPanelFocused(page)
    await expect(page.locator('.mail-text')).toHaveText('kept over a restart')
    await expect.poll(() => badge(page).textContent()).toBe('')
  } finally {
    await first.app.close()
  }

  // the same data folder: the store and the read marks are read back at start
  const again = await launchApp({ dataDir, args: ['--claude', work2] })
  try {
    await openPanelFocused(again.page)
    await again.page.locator('.mail-scope', { hasText: 'All' }).click()
    await expect(again.page.locator('.mail-scope.active')).toHaveText('All')
    await expect(again.page.locator('.mail-head')).toHaveCount(1)
    await expect(again.page.locator('.mail-text')).toHaveText(['kept over a restart'])
    const conversations = await again.page.evaluate(() => window.ct.getMailConversations(null))
    expect(conversations.flatMap((c) => c.messages)).toEqual([expect.objectContaining({ text: 'kept over a restart', read: true })])
  } finally {
    await again.app.close()
  }
})

test('with agent messages off the envelope goes, though the marks stay on', async () => {
  const { app, page, pipeName, tab1, tab2, sid2 } = await twoClaudeTabs()
  try {
    // agent_send refuses while messages are off, so the message is sent first and the setting turned off after
    expect(await sendText(pipeName, tab1, sid2, 'enabled then off')).toMatchObject({ ok: true })
    await activate(page, tab2)
    await expect(envelopeOf(page, tab2)).toHaveCount(1)

    expect(await setSetting(page, 'agentMessages.enabled', false)).toEqual({ ok: true })
    await expect(messagesButton(page)).toBeHidden()
    await expect(envelopeOf(page, tab2)).toHaveCount(0)
  } finally {
    await app.close()
  }
})
