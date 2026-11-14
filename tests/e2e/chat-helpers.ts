import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, type ElectronApplication, type Page } from '@playwright/test'
import type { FakeScript } from '../fixtures/fake-claude/install'
import { FAKE_CLAUDE_SETTINGS, launchApp, type Launched } from './helpers'

// The stand-in Claude Code, and the command that runs it. tests/fixtures/fake-claude/install.ts does the same; it is not
// imported here because the e2e loader runs specs as CommonJS, and that module reads import.meta
const STAND_IN = resolve(__dirname, '..', 'fixtures', 'fake-claude', 'fake-claude.ts')

function installCommand(dir: string): string {
  mkdirSync(dir, { recursive: true })
  if (process.platform === 'win32') {
    const file = join(dir, 'claude.cmd')
    writeFileSync(file, `@"${process.execPath}" --experimental-strip-types --no-warnings "${STAND_IN}" %*\r\n`)
    return file
  }
  const file = join(dir, 'claude')
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types --no-warnings "${STAND_IN}" "$@"\n`)
  chmodSync(file, 0o755)
  return file
}

/**
 * The app with one Claude tab that opens in its chat. The stand-in Claude Code runs the script; its config folder is a
 * temp folder, whose .claude.json trusts the work folder unless `trusted` is false, and holds the `login` given as Claude
 * Code's oauthAccount. `log()` reads what the stand-in logged.
 */
export async function launchChatTab(
  script: FakeScript,
  o: { trusted?: boolean; login?: object; version?: string; work?: string; autoContinue?: boolean; headsUp?: boolean; env?: Record<string, string>; tabs?: object; sidePanel?: object; claude?: object; review?: object } = {}
): Promise<Launched & { work: string; config: string; tabId: string; log(): Record<string, unknown>[] }> {
  const root = mkdtempSync(join(tmpdir(), 'ct-chat-'))
  const work = o.work ?? join(root, 'work')
  const config = join(root, 'config')
  mkdirSync(work, { recursive: true })
  mkdirSync(config, { recursive: true })
  const command = installCommand(join(root, 'bin'))
  const scriptFile = join(root, 'script.json')
  writeFileSync(scriptFile, JSON.stringify({ ...script, version: o.version ?? script.version }))
  const logFile = join(root, 'fake-claude.log')
  // Claude Code keys the trust by the folder's real path: the key is the canonical one, as the app compares it
  // o.claude: more of the account's configuration (its user-scope mcpServers), written before the stand-in starts. Its
  // projects are kept: a test may approve or disable a project's servers, the trust entry is added to them
  const claudeProjects = (o.claude as { projects?: Record<string, object> } | undefined)?.projects ?? {}
  const workKey = realpathSync.native(work)
  const claudeJson = {
    ...o.claude,
    ...(o.trusted !== false ? { projects: { ...claudeProjects, [workKey]: { hasTrustDialogAccepted: true, ...claudeProjects[workKey] } } } : o.claude ? { projects: claudeProjects } : {}),
    ...(o.login ? { oauthAccount: o.login } : {})
  }
  if (Object.keys(claudeJson).length > 0) writeFileSync(join(config, '.claude.json'), JSON.stringify(claudeJson))

  // Heads up asks a second Claude Code process now and then: off unless the test is about it, so other tests start only theirs
  const settings = { ...FAKE_CLAUDE_SETTINGS, claude: { ...FAKE_CLAUDE_SETTINGS.claude, command, view: 'chat', autoContinue: o.autoContinue ?? false, headsUp: o.headsUp ?? false }, ...(o.tabs ? { tabs: o.tabs } : {}), ...(o.sidePanel ? { sidePanel: o.sidePanel } : {}), ...(o.review ? { review: o.review } : {}) }
  const launched = await launchApp({
    settings,
    args: ['--claude', work],
    env: { CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_SCRIPT: scriptFile, FAKE_CLAUDE_LOG: logFile, ...o.env }
  })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await launched.page.evaluate(() => window.__ct!.activeTabId()))!
  const log = (): Record<string, unknown>[] => (existsSync(logFile)
    ? readFileSync(logFile, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
    : [])
  return { ...launched, work, config, tabId, log }
}

/** the chat in front: its composer's field, shown by its host */
export const CHAT_INPUT = '.chat-host:visible .chat-input'

/** the chat is ready: its process has answered the start, so a message is not refused as "not running" */
export async function chatReady(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const s = await window.ct.chatSnapshot(window.__ct!.activeTabId()!)
    return s !== null && !s.state.exited && !s.items.some((item) => item.kind === 'notice' && item.text === 'Starting Claude…')
  }), { timeout: 15_000 }).toBe(true)
}

/**
 * The chat in front has stopped moving: a new item's pop-in has ended, and its items, its scroll and its height stay put
 * over two frames. After a turn ends the last answer still slides into place and the status bar may show below, which
 * shrinks the conversation and scrolls it: a test that aims the mouse at a word measures it once this is over.
 */
export async function chatSettled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve) => {
    const host = [...document.querySelectorAll<HTMLElement>('.chat-host')].find((h) => h.offsetParent !== null)
    const scroll = host?.querySelector<HTMLElement>('.chat-scroll')
    if (!host || !scroll) return resolve(false)
    const snap = (): string => JSON.stringify([scroll.scrollTop, scroll.clientHeight, scroll.clientWidth, ...[...host.querySelectorAll('.chat-column > [data-item]')].map((n) => {
      const r = n.getBoundingClientRect()
      return [r.left, r.top, r.width, r.height]
    })])
    // the spinners and the agents' bars loop for as long as they are shown: only an animation that ends can move the layout
    const moving = (): boolean => host.getAnimations({ subtree: true }).some((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity)
    const before = snap()
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(!moving() && snap() === before)))
  }))).toBe(true)
}

/** a message typed into the composer of the chat in front, and sent with Enter */
export async function sendMessage(page: Page, text: string): Promise<void> {
  await chatReady(page)
  await page.locator(CHAT_INPUT).click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/** the bodies of the control responses Claude Code received: the answers to its permission asks, in the order they came */
export function controlResponses(log: () => Record<string, unknown>[]): Record<string, any>[] {
  return (log() as { in?: { type?: string; response?: { response?: Record<string, any> } } }[])
    .filter((e) => e.in?.type === 'control_response')
    .map((e) => e.in!.response?.response ?? {})
}

/** the texts of the user messages Claude Code received */
export function userMessages(log: () => Record<string, unknown>[]): string[] {
  return (log() as { in?: { type?: string; message?: { content?: unknown } } }[])
    .filter((e) => e.in?.type === 'user')
    .map((e) => {
      const content = e.in!.message?.content
      if (typeof content === 'string') return content
      return Array.isArray(content) ? content.map((b: { text?: string }) => b.text ?? '').join('') : ''
    })
}

/**
 * What a chat tab on the stand-in needs when its app is started by a test that pairs devices (pairedApps' options): the
 * settings, the args that open the tab in its work folder, and the env that runs the stand-in. launchChatTab does the same
 * for an app of its own. `config` is the configuration folder the stand-in reads its transcripts from.
 */
export function chatStandIn(script: FakeScript): {
  settings: object
  args: string[]
  env: Record<string, string>
  work: string
  config: string
  log(): Record<string, unknown>[]
} {
  const root = mkdtempSync(join(tmpdir(), 'ct-chat-'))
  const work = join(root, 'work')
  const config = join(root, 'config')
  mkdirSync(work, { recursive: true })
  mkdirSync(config, { recursive: true })
  const command = installCommand(join(root, 'bin'))
  const scriptFile = join(root, 'script.json')
  writeFileSync(scriptFile, JSON.stringify(script))
  const logFile = join(root, 'fake-claude.log')
  writeFileSync(join(config, '.claude.json'), JSON.stringify({ projects: { [realpathSync.native(work)]: { hasTrustDialogAccepted: true } } }))
  const settings = { ...FAKE_CLAUDE_SETTINGS, claude: { ...FAKE_CLAUDE_SETTINGS.claude, command, view: 'chat', autoContinue: false, headsUp: false } }
  const log = (): Record<string, unknown>[] => (existsSync(logFile)
    ? readFileSync(logFile, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
    : [])
  return { settings, args: ['--claude', work], env: { CLAUDE_CONFIG_DIR: config, FAKE_CLAUDE_SCRIPT: scriptFile, FAKE_CLAUDE_LOG: logFile }, work, config, log }
}

/**
 * A chat tab restored from a transcript of `pairs` prompts and answers, as the long-conversation tests of chat-conversation.spec.ts
 * restore one: a first window writes the conversation and closes; a second one restores it, with the same stand-in. Its last
 * message is 'Hi there'. The conversation is written before the window opens, so the restore draws it at once. With `behind`, a
 * shell tab comes first in the saved order: the restore puts it in front and the chat is restored behind it, never drawn, so the
 * first show of the chat is the cold one. Returns the chat's tab id in the second window (ids are new after a restore).
 */
export async function restoredChat(pairs: number, o: { behind?: boolean } = {}): Promise<{ app: ElectronApplication; page: Page; tabId: string; work: string; pipeName: string }> {
  const first = await launchChatTab({ turns: { hello: [{ text: 'Hi there' }] } })
  await sendMessage(first.page, 'hello')
  await expect(first.page.locator('.chat-column')).toContainText('Hi there')
  await expect.poll(async () => (await first.page.evaluate((id) => window.ct.chatSnapshot(id), first.tabId))?.state.turn ?? null, { timeout: 30_000 }).toBe('idle')
  const sid = (await first.page.evaluate((id) => window.ct.chatSnapshot(id), first.tabId))!.state.sessionId!
  if (o.behind) {
    const shell = (await first.page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), tmpdir()))!
    await first.page.waitForFunction(() => window.__ct!.tabIds().length === 2)
    await first.page.evaluate((ids) => window.ct.reorderTabs(ids), [shell.id, first.tabId])
    await first.page.waitForFunction((id) => window.__ct!.tabIds()[0] === id, shell.id)
    // the saved order is written with the session snapshot, as the window closes
    await first.page.waitForTimeout(500)
  }
  // the window closes and keeps its tabs in the session snapshot of the data folder
  const closed = first.app.waitForEvent('close')
  await first.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
  await closed

  const projects = join(first.config, 'projects')
  const file = join(projects, readdirSync(projects).find((dir) => existsSync(join(projects, dir, `${sid}.jsonl`)))!, `${sid}.jsonl`)
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
  const older = Array.from({ length: pairs }, (_, i) => [
    { parentUuid: i === 0 ? null : `a-${i - 1}`, type: 'user', uuid: `u-${i}`, message: { role: 'user', content: `pair ${i}` } },
    { parentUuid: `u-${i}`, type: 'assistant', uuid: `a-${i}`, message: { role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } }
  ]).flat().map((entry) => JSON.stringify({ isSidechain: false, sessionId: sid, timestamp: '2026-10-08T09:00:00.000Z', ...entry }))
  lines[0] = JSON.stringify({ ...(JSON.parse(lines[0]) as Record<string, unknown>), parentUuid: `a-${pairs - 1}` })
  writeFileSync(file, [...older, ...lines].join('\n') + '\n')

  const second = await launchApp({
    dataDir: first.dataDir,
    env: { CLAUDE_CONFIG_DIR: first.config, FAKE_CLAUDE_SCRIPT: join(dirname(first.config), 'script.json'), FAKE_CLAUDE_LOG: join(dirname(first.config), 'fake-claude.log') }
  })
  await expect.poll(() => second.page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await second.page.locator('.banner-restore').click()
  await second.page.waitForFunction((n) => window.__ct!.tabIds().length === n, o.behind ? 2 : 1)
  if (o.behind) {
    const ids = await second.page.evaluate(() => window.__ct!.tabIds())
    expect(await second.page.evaluate(() => window.__ct!.activeTabId())).toBe(ids[0])
    await expect(second.page.locator('.chat-text')).toHaveCount(0)
    return { app: second.app, page: second.page, tabId: ids[1]!, work: first.work, pipeName: second.pipeName }
  }
  await expect(second.page.locator('.chat-host')).toBeVisible()
  // the restored messages are drawn and the column is at its end, before a caller acts on it: the transcript may load late
  await expect(second.page.locator('.chat-text', { hasText: 'Hi there' })).toHaveCount(1)
  await expect.poll(() => second.page.locator('.chat-scroll').evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)).toBe(true)
  const tabId = (await second.page.evaluate(() => window.__ct!.activeTabId()))!
  return { app: second.app, page: second.page, tabId, work: first.work, pipeName: second.pipeName }
}
