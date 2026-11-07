import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEVICE_COPY, type DevicesView } from '../../src/shared/devices'
import type { Note } from '../../src/shared/note'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { FAKE_CLAUDE_SETTINGS, launchApp, makeDataDir, type Launched, writeTranscript } from './helpers'

const SID_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

/** pairing, connecting and the other device's reaction take a few seconds: the polls wait generously */
const SLOW = { timeout: 45_000 }

interface Device extends Launched {
  tabId: string
}

/** an app whose Claude tab runs conversation SID_A, on its own configuration folder and the test's loopback port */
async function launchDevice(port: string): Promise<Device> {
  const config = mkdtempSync(join(tmpdir(), 'ct-config-'))
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeTranscript(config, work, SID_A)
  const launched = await launchApp({
    settings: FAKE_CLAUDE_SETTINGS,
    args: ['--claude', work],
    env: { CLAUDE_CONFIG_DIR: config, CLAUDETERM_TEST_DEVICE_HOST: '127.0.0.1', CLAUDETERM_TEST_DEVICE_PORT: port }
  })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await launched.page.evaluate(() => window.__ct!.activeTabId()))!
  expect(await sendPipeMessage(launched.pipeName, { v: 1, type: 'session', tabId, sessionId: SID_A, source: 'startup', transcriptPath: null })).toEqual({ ok: true })
  return { ...launched, tabId }
}

/** a device's state toward the other device of the group, as the Settings window shows it */
const connectionState = (page: Page) => page.evaluate(async () => {
  const v = await window.ct.getDevicesView()
  return v.enabled ? (v.devices[0]?.state.kind ?? null) : null
})

/** shows a code on `a`, types it on `b` with a's loopback address, and waits until the two devices are connected */
async function pair(a: Device, b: Device): Promise<void> {
  const view = await a.page.evaluate(() => window.ct.startDevicePairing())
  if (!view.enabled || !view.pairing || view.self.port === null) throw new Error('no pairing code')
  const { code } = view.pairing
  const address = `127.0.0.1:${view.self.port}`
  expect(await b.page.evaluate(([addr, c]) => window.ct.joinDevice(addr, c), [address, code] as [string, string])).toEqual({ ok: true })
  await expect.poll(() => connectionState(b.page), SLOW).toBe('connected')
}

const recordNotes = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { notes: [string, Note | null, number][] }
  w.notes = []
  window.ct.onNote((id, n, generation) => { w.notes.push([id, n, generation]) })
})
const recordedNotes = (page: Page) => page.evaluate(() => (window as unknown as { notes: [string, Note | null, number][] }).notes)

const recordStars = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { stars: string[][] }
  w.stars = []
  window.ct.onStarred((ids) => { w.stars.push(ids) })
})
const recordedStars = (page: Page) => page.evaluate(() => (window as unknown as { stars: string[][] }).stars)

const recordDevices = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { views: DevicesView[] }
  w.views = []
  window.ct.onDevices((v) => { w.views.push(v) })
})
/** the names of the devices that removed this one, as the views the window was sent name them */
const removedByOf = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { views: DevicesView[] }
  return w.views.flatMap((v) => (v.enabled && v.removedBy ? [v.removedBy] : [])).at(-1) ?? null
})

/** whether something accepts connections on the port: a closed one refuses them */
function connectError(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.on('connect', () => {
      socket.destroy()
      resolve(null)
    })
    socket.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'))
  })
}

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

test('two devices pair, then a star and a note made on one show on the other', async () => {
  test.setTimeout(180_000)
  const a = await launchDevice('0')
  const b = await launchDevice('0')
  try {
    await pair(a, b)
    await recordStars(b.page)
    await recordNotes(b.page)
    await a.page.evaluate((id) => window.ct.setSessionStarred(id, true), SID_A)
    await expect.poll(async () => (await b.page.evaluate(() => window.ct.listSessions())).find((s) => s.id === SID_A)?.starred, SLOW).toBe(true)
    await expect.poll(() => recordedStars(b.page), SLOW).toContainEqual([SID_A])
    await a.page.evaluate((id) => window.ct.setNoteText(id, 'shared plan', 0), a.tabId)
    await expect.poll(async () => (await recordedNotes(b.page)).at(-1)?.[1]?.text, SLOW).toBe('shared plan')
  } finally {
    // both close even when the first close throws
    await Promise.allSettled([a.app.close(), b.app.close()])
  }
})

test('removing a device tells it', async () => {
  test.setTimeout(180_000)
  const a = await launchDevice('0')
  const b = await launchDevice('0')
  try {
    await pair(a, b)
    const view = await a.page.evaluate(() => window.ct.getDevicesView())
    if (!view.enabled || view.devices.length !== 1) throw new Error('the pair is not in the group')
    const bId = view.devices[0]!.id
    await recordDevices(b.page)
    expect(await a.page.evaluate((id) => window.ct.removeDevice(id), bId)).toEqual({ ok: true })
    await expect.poll(() => removedByOf(b.page), SLOW).toBe(view.self.name)
  } finally {
    // both close even when the first close throws
    await Promise.allSettled([a.app.close(), b.app.close()])
  }
})

test('with no identity there is no device sync and no port, and the first pairing creates it', async () => {
  test.setTimeout(180_000)
  const port = await freePort()
  const env = { CLAUDETERM_TEST_DEVICE_HOST: '127.0.0.1', CLAUDETERM_TEST_DEVICE_PORT: String(port) }
  const first = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env })
  const dataDir = first.dataDir
  try {
    expect(await first.page.evaluate(() => window.ct.getDevicesView())).toEqual({ enabled: false })
    expect(await connectError(port)).toBe('ECONNREFUSED')
    expect(existsSync(join(dataDir, 'device-identity.json'))).toBe(false)
    expect(existsSync(join(dataDir, 'sync-replica.json'))).toBe(false)

    const view = await first.page.evaluate(() => window.ct.startDevicePairing())
    expect(view.enabled && view.pairing !== null).toBe(true)
    expect(existsSync(join(dataDir, 'device-identity.json'))).toBe(true)
  } finally {
    await first.app.close()
  }

  // the identity is there at the next start: the group opens without a pairing shown
  const second = await launchApp({ dataDir, env })
  try {
    await expect.poll(() => second.page.evaluate(async () => {
      const v = await window.ct.getDevicesView()
      return v.enabled ? v.pairing : 'off'
    }), SLOW).toBeNull()
    expect(await second.page.evaluate(() => window.ct.getDevicesView())).toMatchObject({ enabled: true, pairing: null })
  } finally {
    await second.app.close()
  }
})

const devicesRecorded = (page: Page) => page.evaluate(() => (window as unknown as { views: DevicesView[] }).views)

/** an app with no identity and the test's loopback host, for the calls that must not make one */
function launchWithoutGroup(): Promise<Launched> {
  return launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDETERM_TEST_DEVICE_HOST: '127.0.0.1', CLAUDETERM_TEST_DEVICE_PORT: '0' } })
}

test('two concurrent first pairings open one group, and the window hears of it', async () => {
  test.setTimeout(120_000)
  const a = await launchDevice('0')
  try {
    await recordDevices(a.page)
    const [first, second] = await a.page.evaluate(() => Promise.all([window.ct.startDevicePairing(), window.ct.startDevicePairing()]))
    if (!first.enabled || !second.enabled) throw new Error('no group')
    expect(second.self.id).toBe(first.self.id)
    // the test host is the only address this device is given, so the code lists only it
    expect(first.pairing?.addresses).toEqual(['127.0.0.1'])
    expect(existsSync(join(a.dataDir, 'device-identity.json'))).toBe(true)
    const id = first.self.id
    await expect.poll(async () => (await devicesRecorded(a.page)).some((v) => v.enabled && v.self.id === id), SLOW).toBe(true)
  } finally {
    await a.app.close()
  }
})

test('without a group, the calls that need one answer that device sync is off, and bad arguments make no identity', async () => {
  const solo = await launchWithoutGroup()
  try {
    const UUID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
    const OFF = { ok: false, error: DEVICE_COPY.disabled }
    expect(await solo.page.evaluate((id) => window.ct.removeDevice(id), UUID)).toEqual(OFF)
    expect(await solo.page.evaluate(() => window.ct.leaveDeviceGroup())).toEqual(OFF)
    expect(await solo.page.evaluate((id) => window.ct.setDeviceAddress(id, null), UUID)).toEqual(OFF)
    expect(await solo.page.evaluate(() => window.ct.renameThisDevice('x'))).toEqual(OFF)
    expect(await solo.page.evaluate(() => window.ct.joinDevice('', 'x'))).toEqual(OFF)
    expect(await solo.page.evaluate(() => window.ct.joinDevice('a'.repeat(300), 'x'))).toEqual(OFF)
    expect(existsSync(join(solo.dataDir, 'device-identity.json'))).toBe(false)
  } finally {
    await solo.app.close()
  }
})

test('with a group open, bad arguments are answered with what is wrong with them', async () => {
  test.setTimeout(120_000)
  const a = await launchDevice('0')
  try {
    expect((await a.page.evaluate(() => window.ct.startDevicePairing())).enabled).toBe(true)
    const UUID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
    const TOO_LONG = 'x'.repeat(300)
    expect(await a.page.evaluate((id) => window.ct.removeDevice(id), 'not-a-device')).toEqual({ ok: false, error: DEVICE_COPY.unknownDevice })
    expect(await a.page.evaluate((id) => window.ct.setDeviceAddress(id, null), 'not-a-device')).toEqual({ ok: false, error: DEVICE_COPY.unknownDevice })
    expect(await a.page.evaluate(([id, address]) => window.ct.setDeviceAddress(id, address), [UUID, TOO_LONG] as [string, string])).toEqual({ ok: false, error: DEVICE_COPY.badAddress })
    expect(await a.page.evaluate((name) => window.ct.renameThisDevice(name), TOO_LONG)).toEqual({ ok: false, error: DEVICE_COPY.badName })
    expect(await a.page.evaluate(([address, code]) => window.ct.joinDevice(address, code), ['', 'K7QM-2XPD-9TRA-W4BN'] as [string, string])).toEqual({ ok: false, error: DEVICE_COPY.badAddress })
    expect(await a.page.evaluate(([address, code]) => window.ct.joinDevice(address, code), ['127.0.0.1:1', TOO_LONG] as [string, string])).toEqual({ ok: false, error: DEVICE_COPY.joinBadCode })
  } finally {
    await a.app.close()
  }
})

test('a join that opens the group, with no pairing shown, makes the window hear of the group', async () => {
  test.setTimeout(120_000)
  const solo = await launchWithoutGroup()
  try {
    await recordDevices(solo.page)
    // nothing listens on port 1: the join fails, but the group it opened is reported
    const result = await solo.page.evaluate(() => window.ct.joinDevice('127.0.0.1:1', 'K7QM-2XPD-9TRA-W4BN'))
    expect(result.ok).toBe(false)
    await expect.poll(async () => (await devicesRecorded(solo.page)).some((v) => v.enabled && v.pairing === null), SLOW).toBe(true)
  } finally {
    await solo.app.close()
  }
})

test('a CLAUDETERM_TEST_DEVICE_PORT that is not a port is ignored: the settings port is used', async () => {
  const port = await freePort()
  const dataDir = makeDataDir({ ...FAKE_CLAUDE_SETTINGS, devices: { port } })
  const { app, page } = await launchApp({ dataDir, env: { CLAUDETERM_TEST_DEVICE_HOST: '127.0.0.1', CLAUDETERM_TEST_DEVICE_PORT: 'abc' } })
  try {
    const view = await page.evaluate(() => window.ct.startDevicePairing())
    expect(view.enabled && view.self.port).toBe(port)
  } finally {
    await app.close()
  }
})

test('a port changed in settings.json restarts the group on the new port, and the window hears of it', async () => {
  test.setTimeout(120_000)
  const p1 = await freePort()
  let p2 = await freePort()
  while (p2 === p1) p2 = await freePort()
  const dataDir = makeDataDir({ ...FAKE_CLAUDE_SETTINGS, devices: { port: p1 } })
  const { app, page } = await launchApp({ dataDir, env: { CLAUDETERM_TEST_DEVICE_HOST: '127.0.0.1' } })
  try {
    await recordDevices(page)
    const first = await page.evaluate(() => window.ct.startDevicePairing())
    expect(first.enabled && first.self.port).toBe(p1)
    expect(await connectError(p1)).toBe(null)
    const before = (await devicesRecorded(page)).length
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ...FAKE_CLAUDE_SETTINGS, devices: { port: p2 } }))
    // the old port is released, and the window hears of the restarted group
    await expect.poll(() => connectError(p1), SLOW).toBe('ECONNREFUSED')
    await expect.poll(async () => (await devicesRecorded(page)).slice(before).some((v) => v.enabled), SLOW).toBe(true)
    // a listener opens only while a pairing is shown or devices are paired: the next pairing is on the new port
    const next = await page.evaluate(() => window.ct.startDevicePairing())
    expect(next.enabled && next.self.port).toBe(p2)
    expect(await connectError(p2)).toBe(null)
  } finally {
    await app.close()
  }
})
