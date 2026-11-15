import { expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HUB_TEXT } from '../../src/main/coordinator/coordinator-hub'
import type { CoordOp, CoordResult, CoordinatorView } from '../../src/shared/coordinator'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { AttentionMessage } from '../../src/shared/protocol'
import { gitRepo, launchApp, type Launched } from './helpers'
import { hasMailWatcher, listAgents, refOf, startSession, VERSION_SETTINGS, type WaitAnswer } from './agent-mail'
import { type AppOptions, type Device, pairedApps, SLOW } from './device-pair'

/** the app with `count` Claude tabs in one git repository, each with a session, the mail watcher on */
export async function coordApp(count: number, o: { settings?: object; env?: Record<string, string>; repo?: string; transcripts?: boolean } = {}): Promise<Launched & { repo: string; tabs: string[]; sids: string[]; transcripts: string[] }> {
  const repo = o.repo ?? gitRepo()
  const settings = o.settings ?? VERSION_SETTINGS
  const launched = await launchApp({ settings, args: ['--claude', repo], env: o.env })
  const { page, pipeName, dataDir } = launched
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabs = [(await page.evaluate(() => window.__ct!.activeTabId()))!]
  while (tabs.length < count) tabs.push((await page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), repo))!.id)
  await page.waitForFunction((n) => window.__ct!.tabIds().length === n, count)
  const sids: string[] = []
  const transcripts: string[] = []
  for (const tab of tabs) {
    const sid = randomUUID()
    sids.push(sid)
    if (o.transcripts) {
      // an empty transcript, as Claude Code writes it before the first message
      const path = join(mkdtempSync(join(tmpdir(), 'ct-transcript-')), `${sid}.jsonl`)
      writeFileSync(path, '')
      transcripts.push(path)
      expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId: tab, sessionId: sid, source: 'startup', transcriptPath: path })).toEqual({ ok: true })
    } else {
      expect(await startSession(pipeName, tab, sid)).toEqual({ ok: true })
    }
  }
  if ((settings as { agentMessages?: { enabled: boolean } }).agentMessages?.enabled !== false) {
    await expect.poll(() => hasMailWatcher(dataDir), { timeout: 15_000 }).toBe(true)
  }
  return { ...launched, repo, tabs, sids, transcripts }
}

/** a Claude tab of the running app in cwd, with a session */
export async function claudeTabIn(l: Launched, cwd: string): Promise<{ tabId: string; sid: string }> {
  const tabId = (await l.page.evaluate((c) => window.ct.openTab({ kind: 'claude', cwd: c }), cwd))!.id
  const sid = randomUUID()
  expect(await startSession(l.pipeName, tabId, sid)).toEqual({ ok: true })
  return { tabId, sid }
}

/** a coordinator tool's pipe message from a tab, as the MCP server sends it */
export const coord = (pipeName: string, tabId: string, op: CoordOp): Promise<WaitAnswer> =>
  sendPipeMessage(pipeName, { v: 1, type: 'coord', tabId, ...op }, 30_000) as Promise<WaitAnswer>

/** Make project coordinator through the window, once git has given the tab its project */
export async function makeCoordinator(page: Page, tabId: string, replace = false): Promise<CoordResult> {
  const until = Date.now() + 15_000
  for (;;) {
    const r = await page.evaluate(([id, rep]) => window.ct.coordMake(id, rep), [tabId, replace] as const)
    if (!(r.ok === false && r.error === HUB_TEXT.noProject) || Date.now() > until) return r
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** the session starts a turn: a prompt of the user was taken */
export const turnOf = (pipeName: string, tabId: string, sessionId: string): Promise<unknown> =>
  sendPipeMessage(pipeName, { v: 1, type: 'turn', tabId, sessionId })

/** the session's turn ends: a Stop, with what the extra fields say */
export const done = (pipeName: string, tabId: string, sessionId: string, extra: Partial<AttentionMessage> = {}): Promise<unknown> =>
  sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId, reason: 'done', ...extra })

/** rejects when the promise has no answer within ms: a bound on a wait that should end at once */
export function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

/** passes when p has not settled within ms */
export async function stillWaiting(p: Promise<unknown>, ms: number): Promise<void> {
  let settled = false
  p.then(() => { settled = true }, () => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, ms))
  expect(settled).toBe(false)
}

/** a Claude tab of a device in a folder, with a session the hooks would report */
async function claudeTabOf(d: Device, cwd: string): Promise<{ tab: string; sid: string }> {
  const tab = (await d.page.evaluate((c) => window.ct.openTab({ kind: 'claude', cwd: c }), cwd))!.id
  await d.page.waitForFunction((id) => window.__ct!.tabIds().includes(id), tab)
  const sid = randomUUID()
  expect(await startSession(d.pipeName, tab, sid)).toEqual({ ok: true })
  return { tab, sid }
}

/**
 * Studio and Laptop paired, the stand-in Claude Code 2.1.400 and its mail watcher on both; on each a Claude tab with a session in a
 * repository named acme. Studio's is made the coordinator, and returns once its view lists Laptop's session as not attached.
 */
export async function coordDevices(o: { b?: AppOptions } = {}): Promise<{ a: Device; b: Device; coordTab: string; coordSid: string; sessionTab: string; sessionSid: string; repoA: string; repoB: string }> {
  const { a, b } = await pairedApps({ a: { settings: VERSION_SETTINGS }, b: { settings: VERSION_SETTINGS, ...o.b } })
  const repoA = gitRepo('acme')
  const repoB = gitRepo('acme')
  const own = await claudeTabOf(a, repoA)
  const other = await claudeTabOf(b, repoB)
  await expect.poll(() => hasMailWatcher(a.dataDir), SLOW).toBe(true)
  await expect.poll(() => hasMailWatcher(b.dataDir), SLOW).toBe(true)
  expect(await makeCoordinator(a.page, own.tab)).toMatchObject({ ok: true })
  await expect.poll(async () => (await coordViewOf(a, own.tab))?.notAttached.map((r) => r.key) ?? [], SLOW).toContain(`${b.id}:${other.sid}`)
  // Laptop's session is listed by name: its row is listed only when Laptop's mail-accept says it wakes a session
  await expect.poll(async () => (await listAgents(a.pipeName, own.tab)).info ?? '', SLOW).toContain(`acme · Laptop [${refOf(other.sid)}]`)
  return { a, b, coordTab: own.tab, coordSid: own.sid, sessionTab: other.tab, sessionSid: other.sid, repoA, repoB }
}

/** a Claude tab's coordinator view in a device's window; null when the tab does not coordinate */
export const coordViewOf = (d: Device, tabId: string): Promise<CoordinatorView | null> => d.page.evaluate((id) => window.ct.coordView(id), tabId)
