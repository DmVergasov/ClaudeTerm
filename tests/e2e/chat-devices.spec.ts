import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FakeScript } from '../fixtures/fake-claude/install'
import { chatReady, chatStandIn, CHAT_INPUT, controlResponses, sendMessage, userMessages } from './chat-helpers'
import { closePaired, type Device, pairedApps, SLOW, startApps } from './device-pair'
import { bufferText, launchApp, writeTranscript } from './helpers'

test.afterEach(closePaired)

// a member's chat: the card, the composer's keys and the sheet header's switch are the member's own
const PERMISSION = '.chat-host:visible .chat-card-permission'
const ANSWERED = '.chat-host:visible .chat-card.answered'
const CARD_BUTTON = '.chat-host:visible .chat-card button'
const COLUMN = '.chat-host:visible .chat-column'
const SCROLL = '.chat-host:visible .chat-scroll'
const MODE_CHIP = '.chat-host:visible .chat-mode-chip'
const TERMINAL_MODE = '.sh-mode[data-view="terminal"]'
const SLASH_MENU = '.chat-host:visible .chat-slash-menu'
const FILE_PICKER = '.chat-host:visible .chat-file-picker'
const MODEL_PICKER = '.chat-host:visible .chat-model-picker'
const ATTACHED = '.chat-host:visible .chat-attached'
const REFUSAL = '.chat-host:visible .chat-refusal'
const SESSIONS = '#sessions'
const COMPOSER_NOTE = '.chat-host:visible .chat-note'
const BASH = { command: 'ls' }
/** the pieces of a streamed answer, then its last word: the member sees the first pieces before the end */
const STREAM = `${Array.from({ length: 100 }, (_, i) => `part${i}`).join(' ')} end-of-stream`
/** the commands, models and terminal commands the stand-in Claude Code lists: what the member's composer offers */
const COMMANDS = [
  { name: 'context', description: 'Show what fills the context window', argumentHint: '', builtin: true },
  { name: 'model', description: 'Set the model', argumentHint: '', builtin: true },
  { name: 'config', description: "Open Claude Code's settings", argumentHint: '', builtin: true },
  { name: 'code-review:review', description: 'Review the current diff for bugs', argumentHint: '' }
]
const MODELS = [
  { value: 'opus', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks', supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'haiku', displayName: 'Haiku 5.5', description: 'The fastest, for quick answers', supportedEffortLevels: [] }
]
const RESUME_SID = '3c8a6f2e-1d7b-4e5a-8f9c-0b1a2c3d4e5f'

const tabIdsOf = (d: Device) => d.page.evaluate(() => window.__ct!.tabIds())
const snapshotOf = (d: Device, tabId: string) => d.page.evaluate((id) => window.ct.chatSnapshot(id), tabId)
const turnOf = async (d: Device, tabId: string) => (await snapshotOf(d, tabId))?.state.turn ?? null

/** the texts of the answers and the user messages a chat draws, in order */
const drawn = (d: Device) => d.page.evaluate(() => [...document.querySelectorAll('.chat-host .chat-column .chat-text, .chat-host .chat-column .chat-user')]
  .filter((e) => (e.closest('.chat-host') as HTMLElement).style.display !== 'none')
  .map((e) => e.textContent))

/** the toasts a window showed since watchToasts, each text once: a toast shown and gone is still in the list */
async function watchToasts(d: Device): Promise<void> {
  await d.page.evaluate(() => {
    const seen: string[] = []
    ;(window as unknown as { __toasts: string[] }).__toasts = seen
    new MutationObserver(() => {
      for (const t of document.querySelectorAll('.toast')) {
        const text = t.textContent ?? ''
        if (!seen.includes(text)) seen.push(text)
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
}
const toastsOf = (d: Device): Promise<string[]> => d.page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts ?? [])

/** a member's window: the remote tab is in front there, as a click on its row would put it */
async function frontOnMember(member: Device, tabId: string): Promise<void> {
  await expect.poll(() => tabIdsOf(member), SLOW).toContain(tabId)
  await member.page.evaluate((id) => window.ct.activateTab(id), tabId)
  await expect(member.page.locator('.chat-host:visible')).toHaveCount(1, SLOW)
}

/** the chat of A's tab is idle: its turn has ended, so the test may read its session */
async function idle(d: Device, tabId: string): Promise<void> {
  await expect.poll(() => turnOf(d, tabId), { timeout: 30_000 }).toBe('idle')
}

/** the member's conversation ends like the host's: the same texts in the same order, and the streamed answer is whole */
async function expectSameAnswers(a: Device, b: Device, tabId: string): Promise<void> {
  await idle(a, tabId)
  await expect.poll(() => drawn(b), SLOW).toEqual(await drawn(a))
  expect((await drawn(b)).some((t) => t?.startsWith(STREAM.slice(0, 40)) && t.includes('end-of-stream'))).toBe(true)
}

/** the device's chat tab is ready: the stand-in answered its start, so a message is not refused as "not running" */
async function chatTab(script: FakeScript) {
  const stand = chatStandIn(script)
  const { a, b } = await pairedApps({ a: { settings: stand.settings, args: stand.args, env: stand.env } })
  return { stand, a, b, tabId: a.firstTab }
}

/** the requests Claude Code received with a subtype, in order */
function requestsOf(log: () => Record<string, unknown>[], subtype: string): Record<string, unknown>[] {
  return (log() as { in?: { request?: { subtype?: string } } }[])
    .filter((e) => e.in?.request?.subtype === subtype)
    .map((e) => e.in!.request as Record<string, unknown>)
}

/** drops files on the chat in front of a page, as a drag from the desktop does: real files, so the window knows their paths */
async function dropFilesOn(page: Page, files: string[]): Promise<void> {
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

/**
 * A loopback relay in front of device A: B's link runs through it, so the test can cut the link. `connections()` counts the
 * links the relay has taken: a cut link is followed by a new one when B dials again.
 */
async function relayTo(port: number): Promise<{ port: number; cut(): void; close(): void; connections(): number }> {
  const open = new Set<Socket>()
  let accepted = 0
  const server: Server = createServer((client) => {
    accepted++
    const upstream = connect(port, '127.0.0.1')
    const pair = [client, upstream]
    for (const s of pair) {
      open.add(s)
      s.on('error', () => {})
      s.on('close', () => { open.delete(s) })
    }
    client.pipe(upstream)
    upstream.pipe(client)
    const end = (): void => { for (const s of pair) s.destroy() }
    client.on('close', end)
    upstream.on('close', end)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    cut: () => { for (const s of [...open]) s.destroy() },
    close: () => { for (const s of [...open]) s.destroy(); server.close() },
    connections: () => accepted
  }
}

/** A and B paired as pairApps does, but B joins A through a relay in front of A, which the caller gets back */
async function pairThrough(a: Device, b: Device): Promise<Awaited<ReturnType<typeof relayTo>>> {
  const view = await a.page.evaluate(() => window.ct.startDevicePairing())
  if (!view.enabled || !view.pairing || view.self.port === null) throw new Error('no pairing code')
  const relay = await relayTo(view.self.port)
  const code = view.pairing.code
  expect(await b.page.evaluate(([addr, c]) => window.ct.joinDevice(addr, c), [`127.0.0.1:${relay.port}`, code] as [string, string])).toEqual({ ok: true })
  const aView = await a.page.evaluate(() => window.ct.getDevicesView())
  const bView = await b.page.evaluate(() => window.ct.getDevicesView())
  if (!aView.enabled || !bView.enabled) throw new Error('device sync is off')
  a.id = aView.self.id
  b.id = bView.self.id
  await expect.poll(async () => (await b.page.evaluate(() => window.ct.getRemoteDevices())).some((d) => d.id === a.id && d.online), SLOW).toBe(true)
  return relay
}

test('a member sees a chat tab as a chat and its answer streaming', async () => {
  test.setTimeout(180_000)
  const { a, b, tabId } = await chatTab({ turns: { hello: [{ text: STREAM, chunks: 100, pace: 30 }] } })
  await frontOnMember(b, tabId)
  await sendMessage(a.page, 'hello')
  // the answer is drawn on the member while it streams, and ends the same on both
  await expect(b.page.locator(COLUMN)).toContainText('part50', SLOW)
  await expect(b.page.locator(COLUMN)).toContainText('end-of-stream', SLOW)
  await expectSameAnswers(a, b, tabId)
  expect((await drawn(b))[0]).toBe('hello')
})

test("a member's message, interrupt and mode change reach the host's Claude Code", async () => {
  test.setTimeout(180_000)
  const stand = chatStandIn({ turns: { hello: [{ text: 'Hi from the host' }], wait: [{ wait: 10_000 }] } })
  const { a, b } = await pairedApps({ a: { settings: stand.settings, args: stand.args, env: stand.env } })
  const tabId = a.firstTab
  await frontOnMember(b, tabId)

  // the message is typed on the member and reaches Claude Code, and the answer is drawn on both
  await sendMessage(b.page, 'hello')
  await expect.poll(() => userMessages(stand.log)).toEqual(['hello'])
  await expect(b.page.locator(COLUMN)).toContainText('Hi from the host', SLOW)
  await idle(a, tabId)

  // the mode change is Shift+Tab in the member's composer: Claude Code is asked for it
  await b.page.locator(CHAT_INPUT).click()
  await b.page.keyboard.press('Shift+Tab')
  await expect(b.page.locator(MODE_CHIP)).toContainText('Accept edits', SLOW)
  await expect.poll(() => requestsOf(stand.log, 'set_permission_mode').some((r) => r.mode === 'acceptEdits')).toBe(true)

  // the interrupt is Esc in the member's composer while the turn runs
  await sendMessage(b.page, 'wait')
  await expect.poll(() => turnOf(b, tabId), SLOW).toBe('working')
  await b.page.locator(CHAT_INPUT).click()
  await b.page.keyboard.press('Escape')
  await expect.poll(() => requestsOf(stand.log, 'interrupt').length, SLOW).toBeGreaterThan(0)
})

test('host and member answer the same card: the first wins, both cards close', async () => {
  test.setTimeout(180_000)
  const ask = (text: string) => ({ ask: { tool: 'Bash', input: BASH }, allowed: [{ text }], denied: [] })
  const { stand, a, b, tabId } = await chatTab({ turns: { run: [ask('Listed.')], again: [ask('Listed again.')] } })
  await frontOnMember(b, tabId)
  await watchToasts(a)
  await watchToasts(b)

  // the member answers first: Claude Code gets one answer, the host's card closes as answered, and no toast shows
  await sendMessage(a.page, 'run')
  await expect(a.page.locator(PERMISSION)).toHaveCount(1, SLOW)
  await expect(b.page.locator(PERMISSION)).toHaveCount(1, SLOW)
  await b.page.locator(CARD_BUTTON, { hasText: 'Allow once' }).click()
  await expect(a.page.locator(ANSWERED)).toHaveCount(1, SLOW)
  await expect(b.page.locator(ANSWERED)).toHaveCount(1, SLOW)
  expect(controlResponses(stand.log)).toHaveLength(1)
  expect(await toastsOf(a)).toEqual([])
  expect(await toastsOf(b)).toEqual([])

  // both answer the next card at once: one of them wins, the other card closes as answered, and both show the same answer
  await sendMessage(a.page, 'again')
  await expect(a.page.locator(PERMISSION)).toHaveCount(1, SLOW)
  await expect(b.page.locator(PERMISSION)).toHaveCount(1, SLOW)
  // each click lands in its own window at once; a card the other answer closed first has no button left, and that click is nothing
  const press = (page: Page, label: string) => page.evaluate((text) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.chat-host .chat-card button')].find((b) => b.textContent?.includes(text) && (b.closest('.chat-host') as HTMLElement).style.display !== 'none')
    button?.click()
  }, label)
  await Promise.all([press(a.page, 'Deny'), press(b.page, 'Allow once')])
  await expect(a.page.locator(ANSWERED)).toHaveCount(2, SLOW)
  await expect(b.page.locator(ANSWERED)).toHaveCount(2, SLOW)
  await expect.poll(() => controlResponses(stand.log).length).toBe(2)
  expect(await a.page.locator(ANSWERED).allTextContents()).toEqual(await b.page.locator(ANSWERED).allTextContents())
  expect(await toastsOf(a)).toEqual([])
  expect(await toastsOf(b)).toEqual([])
})

test('a member that reconnects mid-stream catches up', async () => {
  test.setTimeout(240_000)
  // a slower stream (8 s): the member's link is held shut while the host streams past its middle
  const stand = chatStandIn({ turns: { hello: [{ text: STREAM, chunks: 100, pace: 80 }] } })
  const { a, b } = await startApps({ a: { settings: stand.settings, args: stand.args, env: stand.env } })
  const relay = await pairThrough(a, b)
  try {
    const tabId = a.firstTab
    await frontOnMember(b, tabId)
    await sendMessage(a.page, 'hello')
    await expect(b.page.locator(COLUMN)).toContainText('part30', SLOW)

    // B's link is cut while A streams on: B dials again through the relay, which counts the new link, and A is still
    // working when that link is back, so B's chat takes its snapshot mid-stream and goes on from there. B may catch up
    // within moments of the cut, so the proof is that the link came back and A's turn was still running, then that
    // B's column ends like A's
    const before = relay.connections()
    relay.cut()
    await expect.poll(() => relay.connections(), SLOW).toBeGreaterThan(before)
    expect(await turnOf(a, tabId)).toBe('working')
    await expectSameAnswers(a, b, tabId)
  } finally {
    relay.close()
  }
})

/** the transcript lines that make a conversation of `pairs` pairs before the restored one: each pair is a user item and an answer */
function olderPairs(sid: string, pairs: number): string[] {
  return Array.from({ length: pairs }, (_, i) => [
    { parentUuid: i === 0 ? null : `a-${i - 1}`, type: 'user', uuid: `u-${i}`, message: { role: 'user', content: `pair ${i}` } },
    { parentUuid: `u-${i}`, type: 'assistant', uuid: `a-${i}`, message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } }
  ]).flat().map((entry) => JSON.stringify({ isSidechain: false, sessionId: sid, timestamp: '2026-10-08T09:00:00.000Z', ...entry }))
}

test('a member attaching a 5 000-item conversation shows its end and pages older items', async () => {
  test.setTimeout(300_000)
  const stand = chatStandIn({ turns: { hello: [{ text: 'Hi there' }] } })
  const { a, b } = await pairedApps({ a: { settings: stand.settings, args: stand.args, env: stand.env } })
  await sendMessage(a.page, 'hello')
  await expect(a.page.locator('.chat-host:visible .chat-text', { hasText: 'Hi there' })).toHaveCount(1)
  await idle(a, a.firstTab)
  const sid = (await snapshotOf(a, a.firstTab))!.state.sessionId!

  // A's window closes, which keeps its tabs for the next start; the transcript of its chat gets 2 500 older pairs (5 000
  // items), and A starts again with the chat restored by its banner
  const closed = a.app.waitForEvent('close')
  await a.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
  await closed
  const projects = join(stand.config, 'projects')
  const file = join(projects, readdirSync(projects).find((dir) => existsSync(join(projects, dir, `${sid}.jsonl`)))!, `${sid}.jsonl`)
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
  const pairs = 2500
  lines[0] = JSON.stringify({ ...(JSON.parse(lines[0]) as Record<string, unknown>), parentUuid: `a-${pairs - 1}` })
  writeFileSync(file, [...olderPairs(sid, pairs), ...lines].join('\n') + '\n')
  const again = await launchApp({ dataDir: a.dataDir, env: a.env })
  await expect.poll(() => again.page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await again.page.locator('.banner-restore').click()
  Object.assign(a, again)
  // the restored chat is the tab whose conversation is the session A had
  let restored: string | null = null
  await expect.poll(async () => {
    restored = await a.page.evaluate(async (session) => {
      for (const id of window.__ct!.tabIds()) if ((await window.ct.chatSnapshot(id))?.state.sessionId === session) return id
      return null
    }, sid)
    return restored
  }, { timeout: 60_000 }).not.toBeNull()
  a.firstTab = restored!
  // the host itself holds a page of the older items once the history is in (it loads after the chat starts, which
  // shows Starting Claude… until then): the member's paging is over a snapshot that has more
  await expect.poll(async () => (await snapshotOf(a, a.firstTab))!.hasOlder, { timeout: 60_000 }).toBe(true)

  // the member attaches it: the end is drawn, the snapshot is a page of it, and scrolling up brings the older pages
  await frontOnMember(b, a.firstTab)
  await expect(b.page.locator(COLUMN)).toContainText('Hi there', SLOW)
  await expect(b.page.locator('.chat-host:visible .chat-text', { hasText: 'Hi there' })).toBeInViewport()
  // the window's 120 items, the agents dock and the working line
  expect(await b.page.locator(`${COLUMN} > *`).count()).toBeLessThanOrEqual(122)
  const mirror = (await snapshotOf(b, a.firstTab))!
  expect(mirror.hasOlder).toBe(true)
  expect(mirror.items.length).toBeLessThan(5000)
  await expect.poll(async () => {
    await b.page.locator(SCROLL).evaluate((el) => { el.scrollTop = 0 })
    return b.page.locator('.chat-user', { hasText: /^pair 0$/ }).count()
  }, { timeout: 120_000, intervals: [200] }).toBe(1)
})

test("the member switches the host's tab to the terminal", async () => {
  test.setTimeout(180_000)
  const { a, b, tabId } = await chatTab({ turns: { hello: [{ text: 'Hi there' }] } })
  await frontOnMember(b, tabId)
  await sendMessage(a.page, 'hello')
  await expect(b.page.locator(COLUMN)).toContainText('Hi there', SLOW)
  await idle(a, tabId)
  const sid = (await snapshotOf(a, tabId))!.state.sessionId!

  await b.page.locator(TERMINAL_MODE).click()
  // the host's tab shows its terminal, and the member shows a terminal copy of it: the resumed session's command is in both
  await expect(a.page.locator('#terminals .terminal-host:visible')).toHaveCount(1, SLOW)
  await expect.poll(() => bufferText(a.page, tabId), SLOW).toContain(`--resume ${sid}`)
  await expect(b.page.locator('.chat-host:visible')).toHaveCount(0, SLOW)
  await expect(b.page.locator('#terminals .terminal-host:visible')).toHaveCount(1, SLOW)
  await expect.poll(() => bufferText(b.page, tabId), SLOW).toContain(`--resume ${sid}`)
})

test('a member that switches away while the host streams shows the whole answer when it comes back', async () => {
  test.setTimeout(180_000)
  const { a, b, tabId } = await chatTab({ turns: { hello: [{ text: STREAM, chunks: 100, pace: 30 }] } })
  await frontOnMember(b, tabId)
  await sendMessage(a.page, 'hello')
  await expect(b.page.locator(COLUMN)).toContainText('part10', SLOW)
  // the member's window puts its own tab in front: the chat is not drawn while the host streams on
  await b.page.evaluate((id) => window.ct.activateTab(id), b.firstTab)
  await expect(b.page.locator('.chat-host:visible')).toHaveCount(0, SLOW)
  await idle(a, tabId)
  await frontOnMember(b, tabId)
  await expectSameAnswers(a, b, tabId)
})

test("a member's composer runs the host's calls: its commands, files, models, an attachment, /resume and Open in the terminal", async () => {
  test.setTimeout(300_000)
  const stand = chatStandIn({ commands: COMMANDS, models: MODELS, terminalCommands: ['config'], turns: { hello: [{ text: 'Hi there' }] } })
  // a file in the host's folder for the @ picker, and a session of that folder for /resume
  writeFileSync(join(stand.work, 'host-notes.txt'), 'notes on the host')
  const { a, b } = await pairedApps({ a: { settings: stand.settings, args: stand.args, env: stand.env } })
  // the member's Recent sessions read the member's own configuration folder, so the session is written there
  writeTranscript(b.config, stand.work, RESUME_SID)
  const tabId = a.firstTab
  await sendMessage(a.page, 'hello')
  await expect(a.page.locator('.chat-host:visible .chat-text', { hasText: 'Hi there' })).toHaveCount(1)
  await idle(a, tabId)
  await frontOnMember(b, tabId)
  const input = b.page.locator(CHAT_INPUT)

  // / lists the host's commands
  await input.click()
  await b.page.keyboard.type('/')
  await expect(b.page.locator(SLASH_MENU)).toContainText('code-review:review', SLOW)
  await b.page.keyboard.press('Escape')
  await b.page.keyboard.press('Backspace')

  // @ lists a file from the host's folder
  await b.page.keyboard.type('@')
  await expect(b.page.locator(FILE_PICKER)).toContainText('host-notes.txt', SLOW)
  await b.page.keyboard.press('Escape')
  await b.page.keyboard.press('Backspace')

  // /model lists the host's models, and the change is asked of the host's Claude Code
  await b.page.keyboard.type('/model')
  await b.page.keyboard.press('Enter')
  const picker = b.page.locator(MODEL_PICKER)
  await expect(picker.locator('.chat-model-option')).toHaveCount(2, SLOW)
  await picker.locator('.chat-model-option', { hasText: 'Opus 5.5' }).click()
  await picker.locator('button', { hasText: 'Apply' }).click()
  await expect(picker).toBeHidden()
  await expect.poll(() => requestsOf(stand.log, 'set_model').map((r) => r.model), SLOW).toEqual(['opus'])

  // a file dropped on the member's chat is attached on the host and reaches the host's Claude Code as its mention
  const local = join(mkdtempSync(join(tmpdir(), 'ct-member-')), 'member-notes.txt')
  writeFileSync(local, 'from the member')
  await dropFilesOn(b.page, [local])
  await expect(b.page.locator(ATTACHED, { hasText: 'member-notes.txt' })).toHaveCount(1, SLOW)
  await input.click()
  await b.page.keyboard.type('read it')
  await b.page.keyboard.press('Enter')
  await expect.poll(() => userMessages(stand.log).some((m) => m.includes('read it') && m.includes('member-notes.txt')), SLOW).toBe(true)

  // /resume on the member: the sessions open, a pick is refused with the notice, and nothing resumes on the host
  await input.click()
  await b.page.keyboard.type('/resume')
  await b.page.keyboard.press('Enter')
  await expect(b.page.locator(SESSIONS)).toBeVisible(SLOW)
  await b.page.locator('.sessions-search').fill('hello')
  await expect(b.page.locator(`.session-row[data-id="${RESUME_SID}"]`)).toBeVisible(SLOW)
  await b.page.keyboard.press('Enter')
  await expect(b.page.locator(REFUSAL)).toContainText('could not be resumed here', SLOW)
  expect(stand.log().some((e) => Array.isArray(e.argv) && e.argv.includes('--resume') && e.argv.includes(RESUME_SID))).toBe(false)

  // /config is a terminal command: it runs in the host's terminal
  await input.fill('')
  await input.click()
  await b.page.keyboard.type('/config')
  await b.page.keyboard.press('Enter')
  await expect.poll(() => bufferText(a.page, tabId), { timeout: 25_000 }).toContain('you said: /config')
  // not covered here: a background task's Stop from the member. The stand-in shows no task a member can stop, and the
  // call's argument checks are in tests/unit/sync-remote-shapes.test.ts
})

test("a member's /mcp goes to the host's Claude Code and says where to manage MCP", async () => {
  const { stand, a, b, tabId } = await chatTab({ turns: { hello: [{ text: 'Hi there' }] } })
  await chatReady(a.page)
  await frontOnMember(b, tabId)
  await b.page.locator(CHAT_INPUT).click()
  await b.page.keyboard.type('/mcp')
  await b.page.keyboard.press('Enter')
  // the member's panel does not open: the host's servers are the host's, and the line says where they are managed
  await expect(b.page.locator(COMPOSER_NOTE)).toHaveText(`Manage MCP on ${a.name}`, SLOW)
  await expect.poll(() => userMessages(stand.log).includes('/mcp'), SLOW).toBe(true)
  await expect(b.page.locator('.tab-mcp-toggle')).toBeHidden()
})
