import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEVICE_COPY } from '../../src/shared/devices'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { FAKE_CLAUDE_SETTINGS, KEYS, launchApp, type Launched, writeTranscript } from './helpers'

const SID_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

/** pairing, connecting and the other device's reaction take a few seconds: the polls wait generously */
const SLOW = { timeout: 45_000 }

/** a code as the Settings window shows it: four groups of four Crockford characters */
const CODE_SHAPE = /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/

interface Device extends Launched {
  tabId: string
}

/** an app whose Claude tab runs conversation SID_A, on its own configuration folder and a loopback port chosen by the system */
async function launchDevice(extra: string[] = []): Promise<Device> {
  const config = mkdtempSync(join(tmpdir(), 'ct-config-'))
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeTranscript(config, work, SID_A)
  for (const id of extra) writeTranscript(config, work, id)
  const launched = await launchApp({
    settings: FAKE_CLAUDE_SETTINGS,
    args: ['--claude', work],
    env: { CLAUDE_CONFIG_DIR: config, CLAUDETERM_TEST_DEVICE_HOST: '127.0.0.1', CLAUDETERM_TEST_DEVICE_PORT: '0' }
  })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await launched.page.evaluate(() => window.__ct!.activeTabId()))!
  expect(await sendPipeMessage(launched.pipeName, { v: 1, type: 'session', tabId, sessionId: SID_A, source: 'startup', transcriptPath: null })).toEqual({ ok: true })
  return { ...launched, tabId }
}

/** Ctrl+, in the main window; returns the Settings window once its page is up */
async function openSettings(device: Pick<Launched, 'app' | 'page'>): Promise<Page> {
  await device.page.locator('.terminal-host:visible .xterm').click()
  const [win] = await Promise.all([device.app.waitForEvent('window'), device.page.keyboard.press(KEYS.settings)])
  await win.waitForSelector('#settings .settings-heading')
  return win
}

/** the loopback port a device listens on, from its own view */
async function portOf(page: Page): Promise<number> {
  const view = await page.evaluate(() => window.ct.getDevicesView())
  if (!view.enabled || view.self.port === null) throw new Error('the device listens on no port')
  return view.self.port
}

/** pairs `b` into the group of `a` through the two Settings windows, as a person does it, and waits until both show the other connected */
async function pairThroughSettings(a: Device, b: Device): Promise<{ settingsA: Page; settingsB: Page }> {
  const settingsA = await openSettings(a)
  const settingsB = await openSettings(b)
  await settingsA.getByRole('button', { name: 'Add a device', exact: true }).click()
  const code = settingsA.locator('.device-code')
  await expect(code).toHaveText(CODE_SHAPE)
  const port = await portOf(a.page)
  await settingsB.getByPlaceholder('Address').fill(`127.0.0.1:${port}`)
  await settingsB.getByPlaceholder('Code').fill((await code.textContent())!)
  await settingsB.getByRole('button', { name: 'Join', exact: true }).click()
  await expect(settingsB.locator('.device-row', { hasText: DEVICE_COPY.connected })).toHaveCount(1, SLOW)
  await expect(settingsA.locator('.device-row', { hasText: DEVICE_COPY.connected })).toHaveCount(1, SLOW)
  return { settingsA, settingsB }
}

test('pairing through the Settings windows, and a star in Recent sessions shows on the other device at once', async () => {
  test.setTimeout(180_000)
  const a = await launchDevice()
  const b = await launchDevice()
  try {
    await pairThroughSettings(a, b)
    await b.page.keyboard.press(KEYS.recentSessions)
    await expect(b.page.locator('.session-row')).not.toHaveCount(0)
    await a.page.evaluate((id) => window.ct.setSessionStarred(id, true), SID_A)
    await expect(b.page.locator('.session-row .session-star.starred')).toHaveCount(1, SLOW)
  } finally {
    // both close even when the first close throws
    await Promise.allSettled([a.app.close(), b.app.close()])
  }
})

test('a wrong code shows the error under the form', async () => {
  test.setTimeout(120_000)
  const a = await launchDevice()
  const b = await launchDevice()
  try {
    const settingsA = await openSettings(a)
    const settingsB = await openSettings(b)
    await settingsA.getByRole('button', { name: 'Add a device', exact: true }).click()
    const code = settingsA.locator('.device-code')
    await expect(code).toHaveText(CODE_SHAPE)
    const real = (await code.textContent())!
    // the last character changed: a code of the same shape that is not the one shown
    const wrong = real.slice(0, -1) + (real.endsWith('W') ? 'X' : 'W')
    await settingsB.getByPlaceholder('Address').fill(`127.0.0.1:${await portOf(a.page)}`)
    await settingsB.getByPlaceholder('Code').fill(wrong)
    await settingsB.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(settingsB.getByText(DEVICE_COPY.joinBadCode, { exact: true })).toBeVisible(SLOW)
    await expect(settingsB.locator('.device-row')).toHaveCount(0)
  } finally {
    await Promise.allSettled([a.app.close(), b.app.close()])
  }
})

test('Remove asks in the row, then the other device says it was removed', async () => {
  test.setTimeout(180_000)
  const a = await launchDevice()
  const b = await launchDevice()
  try {
    const { settingsA, settingsB } = await pairThroughSettings(a, b)
    const view = await a.page.evaluate(() => window.ct.getDevicesView())
    if (!view.enabled) throw new Error('no group on the first device')
    const row = settingsA.locator('.device-row')
    await row.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(row).toContainText(/Remove .+\?/)
    await row.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(settingsA.locator('.device-row')).toHaveCount(0, SLOW)
    await expect(settingsB.getByText(DEVICE_COPY.removedBy(view.self.name), { exact: true })).toBeVisible(SLOW)
  } finally {
    await Promise.allSettled([a.app.close(), b.app.close()])
  }
})

const SID_B = '7f1e2d3c-4b5a-4968-8a7b-6c5d4e3f2a10'

/** the address the other device has for the first device of the group, from the view: undefined without a group */
const addressOf = async (page: Page): Promise<string | null | undefined> => {
  const v = await page.evaluate(() => window.ct.getDevicesView())
  return v.enabled ? (v.devices[0]?.address ?? null) : undefined
}

test('a name being typed survives an update from the other device', async () => {
  test.setTimeout(180_000)
  const a = await launchDevice()
  const b = await launchDevice()
  try {
    const { settingsA } = await pairThroughSettings(a, b)
    const name = settingsA.getByLabel('Name of this device')
    await name.fill('Draft name')
    // the other device renames itself: this window gets a new view while the name is being typed, and nothing else has focus
    await b.page.evaluate(() => window.ct.renameThisDevice('Other device'))
    await expect(settingsA.locator('.device-row .device-name')).toHaveText('Other device', SLOW)
    await expect(name).toBeFocused()
    await expect(name).toHaveValue('Draft name')
    // only now the address is typed: filling it blurs the name, which saves the name
    const address = settingsA.locator('.device-row').getByLabel(/^Address of /)
    await address.fill('typed-text')
    await expect(address).toHaveValue('typed-text')
    // a second update while the address is typed: the address keeps its focus and what is typed in it
    await b.page.evaluate(() => window.ct.renameThisDevice('Other device again'))
    await expect(settingsA.locator('.device-row .device-name')).toHaveText('Other device again', SLOW)
    await expect(address).toBeFocused()
    await expect(address).toHaveValue('typed-text')
  } finally {
    await Promise.allSettled([a.app.close(), b.app.close()])
  }
})

test('a name of 65 characters is refused under the input, and blur puts the name back', async () => {
  test.setTimeout(120_000)
  const a = await launchDevice()
  try {
    const settingsA = await openSettings(a)
    await settingsA.getByRole('button', { name: 'Add a device', exact: true }).click()
    const name = settingsA.getByLabel('Name of this device')
    await expect(name).not.toHaveValue('', SLOW)
    const before = await name.inputValue()
    await name.fill('x'.repeat(65))
    await name.press('Enter')
    await expect(settingsA.getByText(DEVICE_COPY.badName, { exact: true })).toBeVisible(SLOW)
    await settingsA.locator('.settings-heading').click()
    await expect(name).toHaveValue(before)
  } finally {
    await a.app.close()
  }
})

test('a refused name whose answer comes after a blur is put back to the name in use', async () => {
  test.setTimeout(120_000)
  const a = await launchDevice()
  try {
    const settingsA = await openSettings(a)
    await settingsA.getByRole('button', { name: 'Add a device', exact: true }).click()
    const name = settingsA.getByLabel('Name of this device')
    await expect(name).not.toHaveValue('', SLOW)
    const before = await name.inputValue()
    // Enter sends the refused name and the field loses focus before the answer comes back: the answer lands unfocused
    await settingsA.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Name of this device"]')!
      input.focus()
      input.value = 'x'.repeat(65)
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
      input.blur()
    })
    await expect(settingsA.getByText(DEVICE_COPY.badName, { exact: true })).toBeVisible(SLOW)
    await expect(name).toHaveValue(before)
  } finally {
    await a.app.close()
  }
})

test('an address typed in a row is saved on Enter, an empty one clears it, and a bad one is refused', async () => {
  test.setTimeout(180_000)
  const a = await launchDevice()
  const b = await launchDevice()
  try {
    const { settingsA } = await pairThroughSettings(a, b)
    const row = settingsA.locator('.device-row')
    const address = row.getByLabel(/^Address of /)
    const portB = await portOf(b.page)
    await address.fill(`127.0.0.1:${portB}`)
    await address.press('Enter')
    await expect.poll(() => addressOf(a.page), SLOW).toBe(`127.0.0.1:${portB}`)
    await address.fill('')
    await address.press('Enter')
    await expect.poll(() => addressOf(a.page), SLOW).toBeNull()
    await address.fill('a b')
    await address.press('Enter')
    await expect(row.getByText(DEVICE_COPY.badAddress, { exact: true })).toBeVisible(SLOW)
  } finally {
    await Promise.allSettled([a.app.close(), b.app.close()])
  }
})

test('Leave the group is disabled while no other device is connected, and says why', async () => {
  test.setTimeout(180_000)
  const a = await launchDevice()
  const b = await launchDevice()
  try {
    const { settingsA } = await pairThroughSettings(a, b)
    await b.app.close()
    await expect.poll(async () => {
      const v = await a.page.evaluate(() => window.ct.getDevicesView())
      return v.enabled ? (v.devices[0]?.state.kind ?? null) : null
    }, SLOW).not.toBe('connected')
    await expect(settingsA.getByRole('button', { name: 'Leave the group', exact: true })).toBeDisabled(SLOW)
    await expect(settingsA.getByText(DEVICE_COPY.leaveNeedsConnection, { exact: true })).toBeVisible()
  } finally {
    await Promise.allSettled([a.app.close(), b.app.close()])
  }
})

test('Leave the group asks first, then leaves the group', async () => {
  test.setTimeout(180_000)
  const a = await launchDevice()
  const b = await launchDevice()
  try {
    const { settingsA } = await pairThroughSettings(a, b)
    const leave = settingsA.getByRole('button', { name: 'Leave the group', exact: true })
    await expect(leave).toBeEnabled(SLOW)
    await leave.click()
    await expect(settingsA.getByText('Leave the group?', { exact: true })).toBeVisible()
    await settingsA.getByRole('button', { name: 'Leave', exact: true }).click()
    await expect(settingsA.locator('.device-row')).toHaveCount(0, SLOW)
    // the device starts a new group of its own: no other device is in it, so Leave is off again and says why
    await expect(settingsA.getByRole('button', { name: 'Leave the group', exact: true })).toBeDisabled(SLOW)
    await expect(settingsA.getByText(DEVICE_COPY.leaveNeedsConnection, { exact: true })).toBeVisible()
  } finally {
    await Promise.allSettled([a.app.close(), b.app.close()])
  }
})

test('the code counts down while it is shown, and Cancel takes the code and the countdown away', async () => {
  test.setTimeout(120_000)
  const a = await launchDevice()
  try {
    const settingsA = await openSettings(a)
    await settingsA.getByRole('button', { name: 'Add a device', exact: true }).click()
    const left = settingsA.getByText(/^Valid for /)
    await expect(left).toBeVisible(SLOW)
    const first = await left.textContent()
    await expect.poll(() => left.textContent(), { timeout: 3000 }).not.toBe(first)
    await settingsA.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(settingsA.locator('.device-code')).toHaveCount(0)
    await expect(settingsA.getByText(/^Valid for /)).toHaveCount(0)
  } finally {
    await a.app.close()
  }
})

test('a star from the other device keeps the selection on the session it was on', async () => {
  test.setTimeout(180_000)
  const a = await launchDevice()
  const b = await launchDevice([SID_B])
  try {
    await pairThroughSettings(a, b)
    await b.page.keyboard.press(KEYS.recentSessions)
    const selected = b.page.locator('.session-row.selected')
    await expect(selected).toHaveCount(1)
    const before = await selected.getAttribute('data-id')
    const other = before === SID_A ? SID_B : SID_A
    await b.page.keyboard.press('ArrowDown')
    await expect(selected).toHaveAttribute('data-id', other)
    await a.page.evaluate((id) => window.ct.setSessionStarred(id, true), other)
    await expect(b.page.locator(`.session-row[data-id="${other}"] .session-star.starred`)).toHaveCount(1, SLOW)
    await expect(selected).toHaveAttribute('data-id', other)
  } finally {
    await Promise.allSettled([a.app.close(), b.app.close()])
  }
})

test('unstarring one of two starred sessions on the other device leaves the other one starred', async () => {
  test.setTimeout(180_000)
  const a = await launchDevice()
  const b = await launchDevice([SID_B])
  try {
    await pairThroughSettings(a, b)
    await b.page.keyboard.press(KEYS.recentSessions)
    await expect(b.page.locator('.session-row')).toHaveCount(2)
    await a.page.evaluate((id) => window.ct.setSessionStarred(id, true), SID_A)
    await a.page.evaluate((id) => window.ct.setSessionStarred(id, true), SID_B)
    await expect(b.page.locator('.session-row .session-star.starred')).toHaveCount(2, SLOW)
    await a.page.evaluate((id) => window.ct.setSessionStarred(id, false), SID_A)
    await expect(b.page.locator(`.session-row[data-id="${SID_A}"] .session-star.starred`)).toHaveCount(0, SLOW)
    await expect(b.page.locator(`.session-row[data-id="${SID_B}"] .session-star.starred`)).toHaveCount(1)
    await expect(b.page.locator('.session-row .session-star.starred')).toHaveCount(1)
  } finally {
    await Promise.allSettled([a.app.close(), b.app.close()])
  }
})

test('with no group the Devices section offers only Add a device and Join', async () => {
  test.setTimeout(60_000)
  const solo = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  try {
    await solo.page.waitForFunction(() => window.__ct!.activeTabId() !== null)
    const settings = await openSettings(solo)
    await expect(settings.getByRole('heading', { name: DEVICE_COPY.section, exact: true })).toBeVisible()
    await expect(settings.getByRole('button', { name: 'Add a device', exact: true })).toBeVisible()
    await expect(settings.getByPlaceholder('Address')).toBeVisible()
    await expect(settings.getByPlaceholder('Code')).toBeVisible()
    await expect(settings.getByRole('button', { name: 'Join', exact: true })).toBeVisible()
    await expect(settings.locator('.device-row')).toHaveCount(0)
    await expect(settings.getByRole('button', { name: 'Leave the group' })).toHaveCount(0)
  } finally {
    await solo.app.close()
  }
})
