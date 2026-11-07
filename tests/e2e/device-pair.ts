import { expect, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TabInfo } from '../../src/shared/types'
import { FAKE_CLAUDE_SETTINGS, launchApp, makeDataDir, type Launched } from './helpers'

/** pairing, connecting and the other device's reaction take a few seconds: the polls wait generously */
export const SLOW = { timeout: 45_000 }

export interface AppOptions {
  settings?: object
  args?: string[]
  env?: Record<string, string>
}

/** firstTab: the tab the app had in front right after launch (its own first tab) */
export interface Device extends Launched {
  id: string
  name: string
  config: string
  work: string
  env: Record<string, string>
  args: string[]
  firstTab: string
  /** the folder this app saves the files copied to it in (CLAUDETERM_TEST_RECEIVED_ROOT) */
  received: string
}

/** every device the helpers started and has not closed: closePaired closes them */
const running: Device[] = []

/** a loopback port nothing listens on: taken from the system, then given back */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** the tab in front once the app has one: a fresh launch opens its first tab, a relaunch restores its tabs */
async function firstTabOf(d: Launched): Promise<string> {
  await d.page.waitForFunction(() => window.__ct!.activeTabId() !== null, undefined, { timeout: 45_000 })
  return (await d.page.evaluate(() => window.__ct!.activeTabId()))!
}

/** one app on its own data folder, configuration folder and work folder; the port is the test's loopback port or '0' */
async function launchDevice(o: AppOptions, port: string): Promise<Device> {
  const config = mkdtempSync(join(tmpdir(), 'ct-config-'))
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const settings = (o.settings ?? FAKE_CLAUDE_SETTINGS) as { defaultFolder?: unknown }
  const dataDir = makeDataDir(settings.defaultFolder == null ? { ...settings, defaultFolder: work } : o.settings)
  const args = o.args ?? []
  // each app's received folder is its own, so the tests learn where a copy landed from the app that received it
  const received = join(mkdtempSync(join(tmpdir(), 'ct-recv-')), 'ClaudeTerm', 'received')
  const env = {
    CLAUDE_CONFIG_DIR: config,
    CLAUDETERM_TEST_DEVICE_HOST: '127.0.0.1',
    CLAUDETERM_TEST_DEVICE_PORT: port,
    CLAUDETERM_TEST_RECEIVED_ROOT: received,
    ...o.env
  }
  const launched = await launchApp({ dataDir, args, env })
  const device: Device = { ...launched, id: '', name: '', config, work, env, args, firstTab: '', received }
  running.push(device)
  device.firstTab = await firstTabOf(device)
  return device
}

/** two apps: A listens on a free port found before launch (so a relaunch listens on the same one), B on '0' */
export async function startApps(o: { a?: AppOptions; b?: AppOptions } = {}): Promise<{ a: Device; b: Device }> {
  const port = String(await freePort())
  const a = await launchDevice(o.a ?? {}, port)
  const b = await launchDevice(o.b ?? {}, '0')
  return { a, b }
}

/** the state of a device's one link, as the Settings window shows it */
const linkState = (page: Device['page']) => page.evaluate(async () => {
  const v = await window.ct.getDevicesView()
  return v.enabled ? (v.devices[0]?.state.kind ?? null) : null
})

/** A shows a code, B joins it at 127.0.0.1:<A's port>; they are renamed Studio and Laptop; waits until each lists the other connected and B lists Studio online */
export async function pairApps(a: Device, b: Device): Promise<void> {
  const view = await a.page.evaluate(() => window.ct.startDevicePairing())
  if (!view.enabled || !view.pairing || view.self.port === null) throw new Error('no pairing code')
  const { code } = view.pairing
  const address = `127.0.0.1:${view.self.port}`
  expect(await b.page.evaluate(([addr, c]) => window.ct.joinDevice(addr, c), [address, code] as [string, string])).toEqual({ ok: true })
  await expect.poll(() => linkState(b.page), SLOW).toBe('connected')

  expect(await a.page.evaluate((name) => window.ct.renameThisDevice(name), 'Studio')).toEqual({ ok: true })
  expect(await b.page.evaluate((name) => window.ct.renameThisDevice(name), 'Laptop')).toEqual({ ok: true })
  await expect.poll(() => linkState(a.page), SLOW).toBe('connected')

  const aView = await a.page.evaluate(() => window.ct.getDevicesView())
  const bView = await b.page.evaluate(() => window.ct.getDevicesView())
  if (!aView.enabled || !bView.enabled) throw new Error('device sync is off')
  a.id = aView.self.id
  a.name = 'Studio'
  b.id = bView.self.id
  b.name = 'Laptop'
  await expect.poll(async () => (await b.page.evaluate(() => window.ct.getRemoteDevices())).some((d) => d.id === a.id && d.name === 'Studio' && d.online), SLOW).toBe(true)
}

export async function pairedApps(o: { a?: AppOptions; b?: AppOptions } = {}): Promise<{ a: Device; b: Device }> {
  const devices = await startApps(o)
  await pairApps(devices.a, devices.b)
  return devices
}

/** the same data folder, args and env: the device's app is closed and started again, in place (the same object) */
export async function relaunch(d: Device): Promise<Device> {
  await d.app.close()
  const launched = await launchApp({ dataDir: d.dataDir, args: d.args, env: d.env })
  Object.assign(d, launched)
  d.firstTab = await firstTabOf(d)
  return d
}

/** resizes a device's window: the size of its terminals follows the window's */
export function setWindowSize(d: Launched, width: number, height: number): Promise<void> {
  return d.app.evaluate(({ BrowserWindow }, size) => { BrowserWindow.getAllWindows()[0].setSize(size.width, size.height) }, { width, height })
}

/** the size of a tab's terminal in a device's window, as its xterm has it */
export function termSize(page: Page, tabId: string): Promise<{ cols: number; rows: number } | null> {
  return page.evaluate((id) => window.__ct!.termSize!(id), tabId)
}

/** a shell tab in d.work */
export async function openShell(d: Device): Promise<TabInfo> {
  const tab = await d.page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), d.work)
  if (!tab) throw new Error('the shell tab did not open')
  return tab
}

/** how long an app may take to close before it is killed (a close under load can take long; the afterEach limit is 180 s) */
const CLOSE_TIMEOUT_MS = 20_000

/**
 * closes every app these helpers started; for test.afterEach. An app that does not quit within CLOSE_TIMEOUT_MS is killed,
 * so a hang does not hold the worker, and the test fails by name: a quit hang is a failure, not a pass
 */
export async function closePaired(): Promise<void> {
  const devices = running.splice(0)
  const killed: string[] = []
  await Promise.allSettled(devices.map(async (d) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), CLOSE_TIMEOUT_MS) })
    try {
      const closed = d.app.close().then(() => 'closed' as const)
      if (await Promise.race([closed, timeout]) === 'timeout') {
        d.app.process().kill('SIGKILL')
        killed.push(d.name || 'an unpaired app')
      }
    } finally {
      clearTimeout(timer)
    }
  }))
  if (killed.length > 0) throw new Error(`${killed.join(', ')} did not quit within ${CLOSE_TIMEOUT_MS / 1000} s and was killed`)
}
