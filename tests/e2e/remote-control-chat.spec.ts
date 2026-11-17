import { expect, test } from '@playwright/test'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { activate, refOf } from './agent-mail'
import { chatState, coord, makeCoordinator } from './coordinator-helpers'
import { controlResponses, sendMessage, userMessages } from './chat-helpers'
import { runs } from './account-helpers'
import { externalCalls, gitRepo, stubExternal } from './helpers'
import { bridgeSeen, launchRcChat, openRcTab, RC_TOKEN, rcStatus } from './remote-control-helpers'

test('switching RC on in a chat shows connecting, then connected with its link; off closes the bridge; no token reaches the log', async () => {
  const t = await launchRcChat({ turns: {} })
  try {
    await stubExternal(t.app)
    const seg = t.page.locator('#statusbar .status-remote')
    await t.app.evaluate(() => { (globalThis as any).ctTestBridgeHold = true })
    await seg.click()
    await expect(t.page.locator('.remote-popover .remote-chat-note')).toHaveText('ClaudeTerm sends this chat to claude.ai while it is on: messages, tool results, file contents. Prompts and permission answers can come from there.')
    await t.page.locator('.remote-popover input.switch').click()
    await expect(seg).toHaveAttribute('data-dot', 'connecting')
    await t.app.evaluate(() => { (globalThis as any).ctTestBridgeHold = false })
    await expect(seg).toHaveAttribute('data-dot', 'on')
    expect((await bridgeSeen(t.app)).calls.map((c) => c.fn)).toEqual(['create', 'credentials', 'attach'])
    expect((await bridgeSeen(t.app)).calls[0]).toMatchObject({ token: RC_TOKEN })
    await t.page.locator('.remote-popover .remote-open').click()
    await expect.poll(() => externalCalls(t.app)).toEqual(['https://claude.ai/code/cse_test1'])
    await t.page.locator('.remote-popover input.switch').click()
    await expect(seg).toHaveAttribute('data-dot', 'off')
    // close() runs after the sequence number is written: the count is polled
    await expect.poll(async () => (await bridgeSeen(t.app)).handles[0].closes).toBe(1)
    const log = readFileSync(join(t.dataDir, 'logs', 'main.log'), 'utf8')
    expect(log).not.toContain(RC_TOKEN)
    expect(log).not.toContain('fake-worker-jwt-0001')
  } finally {
    await t.app.close()
  }
})

test('a message sent in the window reaches claude.ai, with the end of its turn', async () => {
  const t = await launchRcChat({ turns: { hello: [{ text: 'Hi there.' }] } })
  try {
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, true), t.tabId)
    await expect(t.page.locator('#statusbar .status-remote')).toHaveAttribute('data-dot', 'on')
    await sendMessage(t.page, 'hello')
    await expect.poll(async () => (await bridgeSeen(t.app)).handles[0].writes.some((m: any) => m.type === 'user' && m.message.content === 'hello')).toBe(true)
    await expect.poll(async () => (await bridgeSeen(t.app)).handles[0].results).toBeGreaterThanOrEqual(1)
  } finally {
    await t.app.close()
  }
})

test('a message from claude.ai shows in the chat as from claude.ai and reaches Claude Code', async () => {
  const t = await launchRcChat({ turns: { 'from the phone': [{ text: 'Got it.' }] } })
  try {
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, true), t.tabId)
    await expect(t.page.locator('#statusbar .status-remote')).toHaveAttribute('data-dot', 'on')
    await t.app.evaluate(() => (globalThis as any).ctTestBridge.inbound('from the phone'))
    const row = t.page.locator('.chat-host:visible .chat-user-row', { hasText: 'from the phone' })
    await expect(row.locator('.chat-from-remote')).toHaveText('from claude.ai')
    await expect.poll(() => userMessages(t.log)).toContain('from the phone')
  } finally {
    await t.app.close()
  }
})

test("a message from claude.ai is the person's words in the coordinator's tab, as a paired device's Send is", async () => {
  test.setTimeout(120_000)
  const work = gitRepo()
  const t = await launchRcChat({ turns: { 'Should we ship?': [{ text: 'Shall I merge feat/x into master?' }] }, fallback: [{ text: 'OK.' }] }, { work })
  const idle = (id: string) => expect.poll(async () => (await chatState(t.page, id))?.turn ?? null, { timeout: 30_000 }).toBe('idle')
  try {
    const a = t.tabId
    const b = (await t.page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), work))!.id
    await activate(t.page, b)
    await sendMessage(t.page, 'hello')
    await idle(b)
    // tab a has RC on; the coordinator asks in the window, the person answers on claude.ai
    await activate(t.page, a)
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, true), a)
    await expect(t.page.locator('#statusbar .status-remote')).toHaveAttribute('data-dot', 'on')
    await sendMessage(t.page, 'Should we ship?')
    await idle(a)
    await t.app.evaluate(() => (globalThis as any).ctTestBridge.inbound('Yes, merge it.'))
    await expect.poll(() => userMessages(t.log)).toContain('Yes, merge it.')
    await idle(a)
    const sidA = (await chatState(t.page, a))!.sessionId!
    const sidB = (await chatState(t.page, b))!.sessionId!
    // the coordinator's transcript, as the stand-in wrote it: the session start reports it, as the hook does
    const transcript = join(t.config, 'projects', realpathSync.native(work).replace(/[^a-zA-Z0-9]/g, '-'), `${sidA}.jsonl`)
    expect(await sendPipeMessage(t.pipeName, { v: 1, type: 'session', tabId: a, sessionId: sidA, source: 'startup', transcriptPath: transcript })).toEqual({ ok: true })
    expect(await makeCoordinator(t.page, a)).toMatchObject({ ok: true })
    expect(await coord(t.pipeName, a, { op: 'attach', session: refOf(sidB) })).toMatchObject({ ok: true })
    expect(await coord(t.pipeName, a, { op: 'message', session: refOf(sidB), text: 'Merge feat/x into master and push.', words: 'Yes, merge it.' })).toMatchObject({ ok: true })
  } finally {
    await t.app.close()
  }
})

test('a permission card answered from claude.ai closes in the window', async () => {
  const t = await launchRcChat({ turns: { run: [{ ask: { tool: 'Bash', input: { command: 'ls' } }, allowed: [{ text: 'Listed.' }], denied: [{ text: 'Not listed.' }] }] } })
  try {
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, true), t.tabId)
    await expect(t.page.locator('#statusbar .status-remote')).toHaveAttribute('data-dot', 'on')
    await sendMessage(t.page, 'run')
    await expect(t.page.locator('.chat-host:visible .chat-card-permission')).toHaveCount(1)
    await expect.poll(async () => (await bridgeSeen(t.app)).handles[0].requests.length).toBe(1)
    const requestId = (await bridgeSeen(t.app)).handles[0].requests[0].request_id as string
    await t.app.evaluate((_electron, id) => (globalThis as any).ctTestBridge.answer(id, 'allow'), requestId)
    await expect(t.page.locator('.chat-host:visible .chat-card.answered')).toContainText('Allowed from claude.ai')
    await expect.poll(() => controlResponses(t.log).map((r) => r.behavior)).toEqual(['allow'])
  } finally {
    await t.app.close()
  }
})

test('a permission card already open when Remote Control turns on reaches claude.ai, and the tab requires action until it is answered there', async () => {
  const t = await launchRcChat({ turns: { run: [{ ask: { tool: 'Bash', input: { command: 'ls' } }, allowed: [{ text: 'Listed.' }], denied: [{ text: 'Not listed.' }] }] } })
  try {
    await sendMessage(t.page, 'run')
    await expect(t.page.locator('.chat-host:visible .chat-card-permission')).toHaveCount(1)
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, true), t.tabId)
    await expect(t.page.locator('#statusbar .status-remote')).toHaveAttribute('data-dot', 'on')
    await expect.poll(async () => (await bridgeSeen(t.app)).handles[0]?.requests.length ?? 0).toBe(1)
    const seen = await bridgeSeen(t.app)
    expect(seen.handles[0].states.at(-1)).toBe('requires_action')
    const requestId = seen.handles[0].requests[0].request_id as string
    await t.app.evaluate((_electron, id) => (globalThis as any).ctTestBridge.answer(id, 'allow'), requestId)
    await expect(t.page.locator('.chat-host:visible .chat-card.answered')).toContainText('Allowed from claude.ai')
  } finally {
    await t.app.close()
  }
})

test('closing a chat tab with an open card and Remote Control on cancels the card on claude.ai before the session closes, and no status for the tab follows', async () => {
  const t = await launchRcChat({ turns: { run: [{ ask: { tool: 'Bash', input: { command: 'ls' } }, allowed: [{ text: 'Listed.' }], denied: [{ text: 'Not listed.' }] }] } })
  try {
    await sendMessage(t.page, 'run')
    await expect(t.page.locator('.chat-host:visible .chat-card-permission')).toHaveCount(1)
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, true), t.tabId)
    await expect(t.page.locator('#statusbar .status-remote')).toHaveAttribute('data-dot', 'on')
    await expect.poll(async () => (await bridgeSeen(t.app)).handles[0]?.requests.length ?? 0).toBe(1)
    const requestId = (await bridgeSeen(t.app)).handles[0].requests[0].request_id as string
    // another tab stays open, so closing this one does not close the window
    await openRcTab(t.page, gitRepo())
    // the statuses the window hears from now on, the tab's among them
    await t.page.evaluate(() => {
      const heard: string[] = []
      ;(window as any).__heardStatus = heard
      window.ct.onStatus((u) => { heard.push(u.tabId) })
    })
    await t.page.evaluate((id) => { (window as any).__heardStatus.length = 0; return window.ct.closeTab(id) }, t.tabId)
    await expect.poll(async () => (await bridgeSeen(t.app)).handles[0].closes).toBe(1)
    expect((await bridgeSeen(t.app)).handles[0].cancelsAtClose).toEqual([requestId])
    await t.page.waitForTimeout(500)
    expect(await t.page.evaluate(() => (window as any).__heardStatus as string[])).not.toContain(t.tabId)
  } finally {
    await t.app.close()
  }
})

test('the choice goes with the tab: chat → terminal starts Claude Code with --rc, and back in the chat the bridge re-attaches to the same claude.ai session', async () => {
  const t = await launchRcChat({ turns: { hello: [{ text: 'Hi.' }] } })
  try {
    await t.page.evaluate((id) => window.ct.remoteControlSet(id, true), t.tabId)
    await expect(t.page.locator('#statusbar .status-remote')).toHaveAttribute('data-dot', 'on')
    await sendMessage(t.page, 'hello')
    await expect.poll(async () => (await chatState(t.page, t.tabId))?.turn ?? null, { timeout: 30_000 }).toBe('idle')
    expect(await t.page.evaluate((id) => window.ct.setTabView(id, 'terminal'), t.tabId)).toBe(true)
    await expect.poll(() => runs(t.log).some((r) => r.argv.includes('--rc')), { timeout: 20_000 }).toBe(true)
    // Claude Code connects in the terminal: its statusLine says so (no hook runs in the e2e tests)
    expect(await sendPipeMessage(t.pipeName, rcStatus(t.tabId, 'session_01Term'))).toEqual({ ok: true })
    expect(await t.page.evaluate((id) => window.ct.setTabView(id, 'chat'), t.tabId)).toBe(true)
    await expect.poll(async () => (await bridgeSeen(t.app)).calls.filter((c) => c.fn === 'attach').map((c) => c.sessionId), { timeout: 20_000 }).toEqual(['cse_test1', 'cse_test1'])
    expect((await bridgeSeen(t.app)).calls.filter((c) => c.fn === 'create')).toHaveLength(1)
  } finally {
    await t.app.close()
  }
})
