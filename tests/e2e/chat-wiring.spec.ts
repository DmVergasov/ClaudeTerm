import { expect, test } from '@playwright/test'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { ChatAnswer, ChatSend, TabView } from '../../src/shared/chat'
import { launchChatTab } from './chat-helpers'

const NEW_SESSION = '00000000-0000-4000-8000-000000000099'

test("a chat tab's status bar leaves the model to the composer", async () => {
  const { app, page, tabId } = await launchChatTab({ turns: {} })
  try {
    // Claude Code names its model in the init that starts a turn: a turn goes first
    expect(await page.evaluate((id) => window.ct.chatSend(id, { text: 'hi', attachments: [] }), tabId)).toBeNull()
    // the model chip of the composer names it; the status bar has no model pill in chat view
    await expect(page.locator('.chat-host:visible .chat-model-chip')).toContainText(/haiku/i)
    await expect(page.locator('#statusbar .status-model')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a session message moves a chat tab to the new conversation', async () => {
  const { app, page, pipeName, tabId } = await launchChatTab({ turns: {} })
  try {
    // the chat is ready: its start has ended
    await expect.poll(() => page.evaluate((id) => window.ct.chatSnapshot(id).then((s) => s !== null && !s.items.some((i) => i.kind === 'notice' && i.text === 'Starting Claude…')), tabId)).toBe(true)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: NEW_SESSION, source: 'clear', transcriptPath: null })).toEqual({ ok: true })
    await expect.poll(() => page.evaluate((id) => window.ct.chatSnapshot(id).then((s) => s?.state.sessionId ?? null), tabId)).toBe(NEW_SESSION)
    const snapshot = await page.evaluate((id) => window.ct.chatSnapshot(id), tabId)
    expect(snapshot?.items).toContainEqual(expect.objectContaining({ kind: 'divider', text: 'New conversation' }))
  } finally {
    await app.close()
  }
})

test('an unknown context fill shows no context segment', async () => {
  // every turn waits, so the turn is still running when the status bar is read
  const { app, page, tabId } = await launchChatTab({ turns: {}, fallback: [{ wait: 3000 }] })
  try {
    expect(await page.evaluate((id) => window.ct.chatSend(id, { text: 'wait', attachments: [] }), tabId)).toBeNull()
    await expect.poll(() => page.evaluate((id) => window.ct.chatSnapshot(id).then((s) => s?.state.turn ?? null), tabId)).toBe('working')
    // the model is named by now (the composer's chip), so the status bar's having no model pill is not just too early
    await expect(page.locator('.chat-host:visible .chat-model-chip')).toContainText(/haiku/i)
    await expect(page.locator('#statusbar .status-model')).toHaveCount(0)
    await expect(page.locator('#statusbar .status-context')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a call with wrong arguments is refused and changes nothing', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: {} })
  try {
    expect(await page.evaluate((id) => window.ct.chatSend(id, { text: 'hi', attachments: [] }), tabId)).toBeNull()
    await expect(page.locator('.chat-host:visible .chat-model-chip')).toContainText(/haiku/i)
    expect(await page.evaluate((id) => window.ct.chatAnswer(id, 'no-such-card', { type: 'bogus' } as unknown as ChatAnswer), tabId)).toBe(false)
    expect(await page.evaluate((id) => window.ct.setTabView(id, 'sideways' as unknown as TabView), tabId)).toBe(false)
    // the chat is still the tab's: its conversation is still served, and its status bar still has no model pill
    expect(await page.evaluate((id) => window.ct.chatSnapshot(id), tabId)).not.toBeNull()
    await expect(page.locator('#statusbar .status-model')).toHaveCount(0)
    await expect(page.locator('.chat-host:visible .chat-model-chip')).toContainText(/haiku/i)
  } finally {
    await app.close()
  }
})

test('chat calls for a shell tab do nothing', async () => {
  const { app, page, work, tabId, log } = await launchChatTab({ turns: {} })
  try {
    const shell = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work))!.id
    expect(await page.evaluate((id) => window.ct.chatSnapshot(id), shell)).toBeNull()
    expect(await page.evaluate((id) => window.ct.setTabView(id, 'chat'), shell)).toBe(false)
    expect(await page.evaluate((id) => window.ct.chatSend(id, { text: 'x', attachments: [] }), shell)).toBe('Claude Code is not running in this tab')

    // a wrong message is refused, and nothing reaches Claude Code
    expect(await page.evaluate((id) => window.ct.chatSend(id, { text: 7 } as unknown as ChatSend), tabId)).toBe('Invalid message')
    expect(log().filter((entry) => (entry.in as { type?: string } | undefined)?.type === 'user')).toEqual([])
  } finally {
    await app.close()
  }
})
