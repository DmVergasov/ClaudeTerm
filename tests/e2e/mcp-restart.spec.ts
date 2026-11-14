import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatItem } from '../../src/shared/chat'
import { chatReady, launchChatTab, sendMessage } from './chat-helpers'
import { chatStarts, readJsonFile, runStandIn } from './mcp-helpers'

// The restart of a chat when the MCP servers its Claude Code loads change: a card while the answer goes on, the restart after the
// answer, the report of what came up, and the changes a chat is left alone by. The stand-in Claude Code answers for the session.

type ReloadItem = Extract<ChatItem, { kind: 'reload' }>
type DividerItem = Extract<ChatItem, { kind: 'divider' }>
type NoticeItem = Extract<ChatItem, { kind: 'notice' }>

const COLUMN = '.chat-host:visible .chat-column'
const PANEL = '.panel-mcp'
const CONTEXT7 = JSON.stringify({ type: 'http', url: 'https://mcp.context7.com/mcp' })
const DOCS = JSON.stringify({ type: 'http', url: 'https://mcp.example.com/docs' })
const CONTEXT7_LOADS = { context7: { tools: ['resolve-library-id', 'get-library-docs'] } }
const ADD_CONTEXT7 = [
  { cli: ['mcp', 'add-json', '--scope', 'user', '--', 'context7', CONTEXT7] },
  { gate: 'answer-done' },
  { text: 'context7 is added for all your projects.' }
]

/** the restarts of a session: the starts that resume it (the stand-in logs `--resume=<id>`, the first start `--session-id=<id>`) */
function resumedStarts(log: () => Record<string, unknown>[], sid: string): number {
  return log().filter((entry) => Array.isArray(entry.argv) && entry.argv.some((arg) => arg === `--resume=${sid}`)).length
}

async function items(page: Page, tabId: string): Promise<ChatItem[]> {
  return (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.items ?? []
}

async function reloadCard(page: Page, tabId: string): Promise<ReloadItem | null> {
  return (await items(page, tabId)).find((item): item is ReloadItem => item.kind === 'reload') ?? null
}

async function dividers(page: Page, tabId: string): Promise<string[]> {
  return (await items(page, tabId)).filter((item): item is DividerItem => item.kind === 'divider').map((item) => item.text)
}

async function notices(page: Page, tabId: string): Promise<NoticeItem[]> {
  return (await items(page, tabId)).filter((item): item is NoticeItem => item.kind === 'notice')
}

async function turnOf(page: Page, tabId: string): Promise<string | null> {
  return (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.state.turn ?? null
}

/** the session a chat runs: its id is known once the chat has started */
async function sessionId(page: Page, tabId: string): Promise<string> {
  await expect.poll(async () => (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.state.sessionId ?? null).not.toBeNull()
  return (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))!.state.sessionId!
}

/** a folder trusted in the configuration folder's .claude.json: read, the entry added, written; the other entries stay */
function trust(config: string, folder: string): void {
  const file = join(config, '.claude.json')
  const value = readJsonFile(file)
  const projects = { ...(value.projects ?? {}), [realpathSync.native(folder)]: { hasTrustDialogAccepted: true } }
  writeFileSync(file, JSON.stringify({ ...value, projects }))
}

test('Claude adds a server: the chat restarts after the answer and says what came up', async () => {
  const { app, page, tabId, config, log } = await launchChatTab({ turns: { 'add context7': ADD_CONTEXT7 }, mcp: CONTEXT7_LOADS })
  try {
    await sendMessage(page, 'add context7')
    await expect.poll(() => reloadCard(page, tabId), { timeout: 20_000 }).toMatchObject({
      title: 'New MCP server: context7',
      action: 'not-now',
      text: 'The session restarts to load it when Claude finishes — the conversation goes on'
    })
    // the answer is not cut: the session stays as it is while the answer's gate holds
    await page.waitForTimeout(3000)
    expect(chatStarts(log)).toBe(1)
    const sid = await sessionId(page, tabId)
    writeFileSync(join(config, 'answer-done'), '')
    await expect.poll(() => resumedStarts(log, sid), { timeout: 30_000 }).toBe(1)
    await expect.poll(() => dividers(page, tabId), { timeout: 30_000 }).toContain('Session restarted · context7 connected · 2 tools')
    await expect(page.locator(COLUMN)).toContainText('context7 is added for all your projects.')
    expect(await reloadCard(page, tabId)).toBeNull()
  } finally {
    await app.close()
  }
})

test('several changes close together make one restart', async () => {
  const { app, page, tabId, log } = await launchChatTab({
    turns: {
      'add two': [
        { cli: ['mcp', 'add-json', '--scope', 'user', '--', 'context7', CONTEXT7] },
        { cli: ['mcp', 'add-json', '--scope', 'user', '--', 'docs', DOCS] },
        { text: 'both are added.' }
      ]
    }
  })
  try {
    await sendMessage(page, 'add two')
    await expect.poll(() => chatStarts(log), { timeout: 30_000 }).toBe(2)
    await page.waitForTimeout(3000)
    expect(chatStarts(log)).toBe(2)
    // the one restart reports both servers
    await expect.poll(() => dividers(page, tabId), { timeout: 30_000 }).toContain('Session restarted · context7 connected · 1 tool · docs connected · 1 tool')
  } finally {
    await app.close()
  }
})

test('Not now keeps the card with Restart, and Restart restarts', async () => {
  const { app, page, tabId, config, log } = await launchChatTab({ turns: { 'add context7': ADD_CONTEXT7 }, mcp: CONTEXT7_LOADS })
  try {
    await sendMessage(page, 'add context7')
    await expect.poll(() => reloadCard(page, tabId), { timeout: 20_000 }).toMatchObject({ action: 'not-now' })
    expect(await page.evaluate((id) => window.ct.mcpReload(id, 'not-now'), tabId)).toBe(true)
    await expect.poll(() => reloadCard(page, tabId)).toMatchObject({ action: 'restart', text: 'Restart the session to load it — the conversation goes on' })
    writeFileSync(join(config, 'answer-done'), '')
    await expect.poll(() => turnOf(page, tabId), { timeout: 30_000 }).toBe('idle')
    await page.waitForTimeout(3000)
    expect(chatStarts(log)).toBe(1)
    expect(await reloadCard(page, tabId)).toMatchObject({ action: 'restart' })
    expect(await page.evaluate((id) => window.ct.mcpReload(id, 'restart'), tabId)).toBe(true)
    await expect.poll(() => chatStarts(log), { timeout: 30_000 }).toBe(2)
  } finally {
    await app.close()
  }
})

test('with its alerts on, a change the session has not loaded turns the MCP segment blue, until the restart loads it', async () => {
  const { app, page, tabId, config } = await launchChatTab({ turns: { 'add context7': ADD_CONTEXT7 }, mcp: CONTEXT7_LOADS })
  try {
    await chatReady(page)
    expect(await page.evaluate(() => window.ct.setSetting('chat.mcpAlerts', true))).toMatchObject({ ok: true })
    const segment = page.locator('#statusbar .status-mcp')
    await expect(segment).toHaveText('MCP')
    await sendMessage(page, 'add context7')
    await expect.poll(() => reloadCard(page, tabId), { timeout: 20_000 }).toMatchObject({ action: 'not-now' })
    await expect(segment).toHaveText('MCP · restart to load 1')
    await expect(segment).toHaveClass(/\binfo\b/)
    writeFileSync(join(config, 'answer-done'), '')
    // the restart after the answer loads context7: the segment counts it, quietly
    await expect(segment).toHaveText('MCP 1', { timeout: 30_000 })
    await expect(segment).not.toHaveClass(/\binfo\b/)
  } finally {
    await app.close()
  }
})

test('another chat on the same config folder gets the card with Restart and is not restarted', async () => {
  const { app, page, work, config, log } = await launchChatTab({ turns: {} })
  try {
    await chatReady(page)
    const other = mkdtempSync(join(tmpdir(), 'ct-mcp-other-'))
    trust(config, other)
    const second = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), other))!.id
    await chatReady(page)
    // the first chat's start and the second chat's
    expect(chatStarts(log)).toBe(2)
    // a change from outside the chats: Claude Code run in the first chat's folder adds a user-scope server both chats load
    expect(runStandIn(config, work, ['mcp', 'add-json', '--scope', 'user', '--', 'context7', CONTEXT7]).code).toBe(0)
    await expect.poll(() => reloadCard(page, second), { timeout: 20_000 }).toMatchObject({ action: 'restart' })
    await page.waitForTimeout(3000)
    expect(chatStarts(log)).toBe(2)
    expect(await page.evaluate((id) => window.ct.mcpReload(id, 'restart'), second)).toBe(true)
    // only the second chat restarts: a chat with no turn starts a new session, so the starts are counted all together
    await expect.poll(() => chatStarts(log), { timeout: 30_000 }).toBe(3)
  } finally {
    await app.close()
  }
})

test('a local-scope change of another folder leaves this chat alone', async () => {
  const { app, page, tabId, config, work, log } = await launchChatTab({ turns: {}, mcp: CONTEXT7_LOADS })
  try {
    await chatReady(page)
    const elsewhere = mkdtempSync(join(tmpdir(), 'ct-mcp-elsewhere-'))
    expect(runStandIn(config, elsewhere, ['mcp', 'add-json', '--scope', 'local', '--', 'context7', CONTEXT7]).code).toBe(0)
    await page.waitForTimeout(3000)
    expect(await reloadCard(page, tabId)).toBeNull()
    expect(chatStarts(log)).toBe(1)
    // the watch still sees this folder's changes: the same server added in the user scope shows the card
    expect(runStandIn(config, work, ['mcp', 'add-json', '--scope', 'user', '--', 'docs', DOCS]).code).toBe(0)
    await expect.poll(() => reloadCard(page, tabId), { timeout: 20_000 }).toMatchObject({ title: 'New MCP server: docs' })
  } finally {
    await app.close()
  }
})

test('a change from outside the chats shows the card with Restart in an idle chat', async () => {
  const { app, page, tabId, config, work, log } = await launchChatTab({ turns: {}, mcp: CONTEXT7_LOADS })
  try {
    await chatReady(page)
    expect(runStandIn(config, work, ['mcp', 'add-json', '--scope', 'user', '--', 'context7', CONTEXT7]).code).toBe(0)
    await expect.poll(() => reloadCard(page, tabId), { timeout: 20_000 }).toMatchObject({
      title: 'New MCP server: context7',
      action: 'restart',
      text: 'Restart the session to load it — the conversation goes on'
    })
    await page.waitForTimeout(3000)
    expect(chatStarts(log)).toBe(1)
  } finally {
    await app.close()
  }
})

test('Claude Code rewriting its own .claude.json shows no card', async () => {
  const { app, page, tabId, config, log } = await launchChatTab({ turns: {}, mcp: CONTEXT7_LOADS })
  try {
    await chatReady(page)
    const elsewhere = mkdtempSync(join(tmpdir(), 'ct-mcp-rewrite-'))
    // Claude Code keeps its own counters and other folders' entries in this file: none of it is a server of this chat
    const file = join(config, '.claude.json')
    const value = readJsonFile(file)
    writeFileSync(file, JSON.stringify({ ...value, numStartups: 7, projects: { ...value.projects, [realpathSync.native(elsewhere)]: { hasTrustDialogAccepted: true, allowedTools: [] } } }))
    await page.waitForTimeout(3000)
    expect(await reloadCard(page, tabId)).toBeNull()
    expect(chatStarts(log)).toBe(1)
  } finally {
    await app.close()
  }
})

test('a server that fails after the restart says why with a button to the panel', async () => {
  const BROKEN = JSON.stringify({ type: 'stdio', command: 'uvx', args: ['broken'] })
  const { app, page, tabId, log } = await launchChatTab({
    turns: { 'add broken': [{ cli: ['mcp', 'add-json', '--scope', 'user', '--', 'broken', BROKEN] }, { text: 'broken is added.' }] },
    mcp: { broken: { status: 'failed', error: 'spawn uvx ENOENT' } }
  })
  try {
    await sendMessage(page, 'add broken')
    await expect.poll(() => notices(page, tabId), { timeout: 30_000 }).toContainEqual(
      expect.objectContaining({ text: 'broken failed to start: spawn uvx ENOENT', tone: 'error', action: 'open-mcp' })
    )
    expect(chatStarts(log)).toBe(2)
  } finally {
    await app.close()
  }
})

test('removing a server through the panel restarts the chat', async () => {
  const { app, page, tabId, log } = await launchChatTab(
    { turns: {} },
    { claude: { mcpServers: { github: { type: 'http', url: 'https://example.com/github' } } } }
  )
  try {
    await chatReady(page)
    expect(await page.evaluate((id) => window.ct.mcpAction(id, { kind: 'remove', name: 'github', scope: 'user' }), tabId)).toEqual({ ok: true })
    await expect.poll(() => chatStarts(log), { timeout: 30_000 }).toBe(2)
  } finally {
    await app.close()
  }
})

test('the card shows its title, its text and Not now; Not now turns it into Restart', async () => {
  const { app, page, tabId, config, log } = await launchChatTab({ turns: { 'add context7': ADD_CONTEXT7 }, mcp: CONTEXT7_LOADS })
  try {
    await sendMessage(page, 'add context7')
    const card = page.locator(`${COLUMN} .chat-reload`)
    await expect(card).toContainText('New MCP server: context7', { timeout: 20_000 })
    await expect(card).toContainText('The session restarts to load it when Claude finishes — the conversation goes on')
    await card.getByRole('button', { name: 'Not now' }).click()
    await expect(card.getByRole('button', { name: 'Restart' })).toBeVisible()
    await expect(card.getByRole('button', { name: 'Not now' })).toHaveCount(0)
    expect(await reloadCard(page, tabId)).toMatchObject({ action: 'restart' })
    // the answer ends: the card stays with Restart, and the session is not restarted by itself
    writeFileSync(join(config, 'answer-done'), '')
    await expect.poll(() => turnOf(page, tabId), { timeout: 30_000 }).toBe('idle')
    await page.waitForTimeout(3000)
    expect(chatStarts(log)).toBe(1)
    expect(await reloadCard(page, tabId)).toMatchObject({ action: 'restart' })
  } finally {
    await app.close()
  }
})

test('the divider names what came up, the connected part in green', async () => {
  const { app, page, tabId, config, log } = await launchChatTab({ turns: { 'add context7': ADD_CONTEXT7 }, mcp: CONTEXT7_LOADS })
  try {
    await sendMessage(page, 'add context7')
    await expect.poll(() => reloadCard(page, tabId), { timeout: 20_000 }).not.toBeNull()
    const sid = await sessionId(page, tabId)
    writeFileSync(join(config, 'answer-done'), '')
    await expect.poll(() => resumedStarts(log, sid), { timeout: 30_000 }).toBe(1)
    const divider = page.locator(`${COLUMN} .chat-divider`)
    await expect(divider).toContainText('Session restarted · context7 connected · 2 tools')
    const good = divider.locator('.chat-divider-good')
    await expect(good).toHaveText('context7 connected')
    // the divider's text is one flex item: the green part sits inside one text span, with the usual space before it
    const layout = await divider.evaluate((box) => {
      const text = box.querySelector<HTMLElement>('.chat-divider-text')
      const green = text?.querySelector<HTMLElement>('.chat-divider-good') ?? null
      const before = green?.previousSibling ?? null
      if (!text || !green || !before || before.nodeType !== Node.TEXT_NODE) return null
      const range = document.createRange()
      range.selectNodeContents(before)
      return { children: box.children.length, text: text.textContent, gap: green.getBoundingClientRect().left - range.getBoundingClientRect().right }
    })
    expect(layout).toEqual({ children: 1, text: 'Session restarted · context7 connected · 2 tools', gap: expect.any(Number) })
    expect(layout!.gap).toBeLessThan(6)
    const colours = await good.evaluate((node) => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--green)'
      document.body.append(probe)
      const green = getComputedStyle(probe).color
      probe.remove()
      return { color: getComputedStyle(node).color, green, weight: getComputedStyle(node).fontWeight }
    })
    expect(colours.color).toBe(colours.green)
    expect(colours.weight).toBe('500')
  } finally {
    await app.close()
  }
})

test('the notice of a failed server opens the MCP servers', async () => {
  const BROKEN = JSON.stringify({ type: 'stdio', command: 'uvx', args: ['broken'] })
  const { app, page, tabId } = await launchChatTab({
    turns: { 'add broken': [{ cli: ['mcp', 'add-json', '--scope', 'user', '--', 'broken', BROKEN] }, { text: 'broken is added.' }] },
    mcp: { broken: { status: 'failed', error: 'spawn uvx ENOENT' } }
  })
  try {
    await sendMessage(page, 'add broken')
    await expect.poll(() => notices(page, tabId), { timeout: 30_000 }).toContainEqual(expect.objectContaining({ action: 'open-mcp' }))
    const notice = page.locator(`${COLUMN} .chat-notice`).filter({ hasText: 'broken failed to start: spawn uvx ENOENT' })
    await notice.getByRole('button', { name: 'MCP servers' }).click()
    await expect(page.locator(PANEL)).toBeVisible()
    await expect(page.locator(`${PANEL} [data-name="broken"]`)).toBeVisible()
  } finally {
    await app.close()
  }
})

test("Restart on another chat's card restarts that chat and leaves the one in the background", async () => {
  const { app, page, tabId: first, work, config, log } = await launchChatTab({ turns: {} })
  try {
    await chatReady(page)
    const other = mkdtempSync(join(tmpdir(), 'ct-mcp-other-'))
    trust(config, other)
    const second = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), other))!.id
    await chatReady(page)
    expect(runStandIn(config, work, ['mcp', 'add-json', '--scope', 'user', '--', 'context7', CONTEXT7]).code).toBe(0)
    // the second chat is in front: its card is the one the person clicks
    const card = page.locator(`${COLUMN} .chat-reload`)
    await expect(card).toContainText('New MCP server: context7', { timeout: 20_000 })
    const firstSid = await sessionId(page, first)
    await card.getByRole('button', { name: 'Restart' }).click()
    await expect.poll(() => chatStarts(log), { timeout: 30_000 }).toBe(3)
    expect(resumedStarts(log, firstSid)).toBe(0)
    expect(await reloadCard(page, second)).toBeNull()
  } finally {
    await app.close()
  }
})
