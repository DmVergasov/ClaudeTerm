import { expect, test } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { closePaired, type Device, pairedApps, relaunch, SLOW } from './device-pair'
import {
  activate, envelopeOf, listAgents, MAIL_PREFIX, messagesButton, openPanelFocused, refOf, sendText, setSetting, startSession, VERSION_SETTINGS, waitForMail
} from './agent-mail'

test.afterEach(closePaired)

/** the last segment of a folder, which is the label of a tab that has no custom title */
const labelOf = (folder: string): string => basename(folder)

/** a Claude tab of a device in a new folder, with a session: what the other device lists it by */
interface Agent { tab: string; sid: string; folder: string }

/** pairs two apps whose Claude tabs run the stand-in with a version that can be woken */
const pairWithTabs = () => pairedApps({ a: { settings: VERSION_SETTINGS }, b: { settings: VERSION_SETTINGS } })

/** a Claude tab in a new folder on the device, with the session the hooks would report */
async function openAgent(d: Device): Promise<Agent> {
  const folder = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const tab = (await d.page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), folder))!.id
  await d.page.waitForFunction((id) => window.__ct!.tabIds().includes(id), tab)
  const sid = randomUUID()
  expect(await startSession(d.pipeName, tab, sid)).toEqual({ ok: true })
  return { tab, sid, folder }
}

/** the text of a tab's agent_list: polled, since the other device's tabs arrive after pairing */
const listingOf = async (d: Device, tab: string): Promise<string> => (await listAgents(d.pipeName, tab)).info ?? ''

/** the agents of both devices list each other: the listing of each names the other's tab with its ref */
async function bothListed(a: Device, sa: Agent, b: Device, sb: Agent): Promise<void> {
  await expect.poll(() => listingOf(a, sa.tab), SLOW).toContain(`${labelOf(sb.folder)} · Laptop [${refOf(sb.sid)}]`)
  await expect.poll(() => listingOf(b, sb.tab), SLOW).toContain(`${labelOf(sa.folder)} · Studio [${refOf(sa.sid)}]`)
}

/** whether a connected device is online, as the window shows it */
const onlineOf = (d: Device, of: Device): Promise<boolean | undefined> => d.page.evaluate(
  (id) => window.ct.getRemoteDevices().then((list) => list.find((x) => x.id === id)?.online),
  of.id
)

test('a message from Studio\'s tab reaches Laptop\'s waiting watcher, and the reply comes back to Studio\'s', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairWithTabs()
  const sa = await openAgent(a)
  const sb = await openAgent(b)
  await bothListed(a, sa, b, sb)

  const arriving = waitForMail(b.pipeName, sb.tab, sb.sid)
  expect(await sendText(a.pipeName, sa.tab, sb.sid, 'hello from Studio')).toMatchObject({ ok: true, info: `Delivered to ${labelOf(sb.folder)} · Laptop.` })
  const got = await arriving
  expect(got).toMatchObject({ ok: true, info: expect.stringContaining('hello from Studio') })
  expect(got.info).toContain(MAIL_PREFIX)
  expect(got.info).toContain(`from: ${labelOf(sa.folder)} · Studio [${refOf(sa.sid)}]`)
  const id = /^id: (\S+)/m.exec(got.info ?? '')?.[1] ?? null
  expect(id).not.toBeNull()

  const reply = waitForMail(a.pipeName, sa.tab, sa.sid)
  expect(await sendPipeMessage(b.pipeName, { v: 1, type: 'agent_send', tabId: sb.tab, to: refOf(sa.sid), text: 'the reply from Laptop', replyTo: id }))
    .toMatchObject({ ok: true, info: `Delivered to ${labelOf(sa.folder)} · Studio.` })
  expect(await reply).toMatchObject({ ok: true, info: expect.stringContaining('the reply from Laptop') })

  // one conversation of two messages in each app's panel, the tab's own
  for (const [d, t] of [[a, sa.tab], [b, sb.tab]] as const) {
    await activate(d.page, t)
    await messagesButton(d.page).click()
    await expect(d.page.locator('.panel-title')).toHaveText('Agent messages')
    await expect(d.page.locator('.mail-head')).toHaveCount(1)
    await expect(d.page.locator('.mail-text')).toHaveText(['hello from Studio', 'the reply from Laptop'], SLOW)
  }
})

test('reading on one app clears the marks on both', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairWithTabs()
  const sa = await openAgent(a)
  const sb = await openAgent(b)
  await bothListed(a, sa, b, sb)

  expect(await sendText(a.pipeName, sa.tab, sb.sid, 'read me on Laptop')).toMatchObject({ ok: true })
  // the message is unread at both of its ends: the tab that sent it and the tab that gets it
  await expect(envelopeOf(b.page, sb.tab)).toHaveCount(1, SLOW)
  await expect(envelopeOf(a.page, sa.tab)).toHaveCount(1, SLOW)

  await activate(b.page, sb.tab)
  await openPanelFocused(b.page)
  await expect(b.page.locator('.mail-text')).toHaveText('read me on Laptop', SLOW)
  await expect(envelopeOf(b.page, sb.tab)).toHaveCount(0, SLOW)
  await expect(envelopeOf(a.page, sa.tab)).toHaveCount(0, SLOW)
})

test('a closed tab on Laptop: "… is closed."', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairWithTabs()
  const sa = await openAgent(a)
  const sb = await openAgent(b)
  await bothListed(a, sa, b, sb)
  // Studio learns Laptop's conversation from this message, so it can still address it once the tab is gone
  expect(await sendText(a.pipeName, sa.tab, sb.sid, 'before the tab closes')).toMatchObject({ ok: true })

  await b.page.evaluate((id) => window.ct.closeTab(id), sb.tab)
  await expect.poll(() => listingOf(a, sa.tab), SLOW).not.toContain(`[${refOf(sb.sid)}]`)
  expect(await sendText(a.pipeName, sa.tab, sb.sid, 'after the tab closes'))
    .toMatchObject({ ok: false, error: `${labelOf(sb.folder)} · Laptop is closed.` })
})

test('Laptop not running: "Waiting: Laptop is not connected; …"; after relaunch and its tab\'s session again, Laptop\'s watcher gets it', async () => {
  test.setTimeout(240_000)
  const { a, b } = await pairWithTabs()
  const sa = await openAgent(a)
  const sb = await openAgent(b)
  await bothListed(a, sa, b, sb)
  expect(await sendText(a.pipeName, sa.tab, sb.sid, 'before Laptop closes')).toMatchObject({ ok: true })

  await b.app.close()
  await expect.poll(() => onlineOf(a, b), SLOW).toBe(false)
  expect(await sendText(a.pipeName, sa.tab, sb.sid, 'while Laptop is closed'))
    .toMatchObject({ ok: true, info: 'Waiting: Laptop is not connected; the message goes out when it connects.' })

  await relaunch(b)
  const tab = (await b.page.evaluate((cwd) => window.ct.openTab({ kind: 'claude', cwd }), sb.folder))!.id
  expect(await startSession(b.pipeName, tab, sb.sid)).toEqual({ ok: true })
  // the message reached Laptop by catch-up; the watcher of the same session takes it at once
  expect(await waitForMail(b.pipeName, tab, sb.sid)).toMatchObject({ ok: true, info: expect.stringContaining('while Laptop is closed') })
})

test('messages off on Laptop: Studio\'s agent_list says "Laptop: does not accept agent messages" and agent_send answers "Laptop does not accept agent messages."', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairWithTabs()
  const sa = await openAgent(a)
  const sb = await openAgent(b)
  await bothListed(a, sa, b, sb)
  expect(await sendText(a.pipeName, sa.tab, sb.sid, 'before the switch')).toMatchObject({ ok: true })

  expect(await setSetting(b.page, 'agentMessages.enabled', false)).toEqual({ ok: true })
  await expect.poll(() => listingOf(a, sa.tab), SLOW).toContain('Laptop: does not accept agent messages')
  expect(await sendText(a.pipeName, sa.tab, sb.sid, 'after the switch'))
    .toMatchObject({ ok: false, error: 'Laptop does not accept agent messages.' })
})

test('the folded device chip and the left panel\'s device header carry the envelope when a tab of that device has unread messages', async () => {
  test.setTimeout(180_000)
  const { a, b } = await pairWithTabs()
  const sa = await openAgent(a)
  const sb = await openAgent(b)
  await bothListed(a, sa, b, sb)
  expect(await sendText(a.pipeName, sa.tab, sb.sid, 'a mark for the Laptop group')).toMatchObject({ ok: true })

  // Studio folds Laptop's group: its chip in the top bar carries the envelope
  const chip = a.page.locator('.tab-group-chip', { hasText: 'Laptop' })
  await expect(chip).toBeVisible(SLOW)
  await chip.click()
  await expect(chip.locator('.tab-mail')).toHaveCount(1, SLOW)

  // the left panel's device header for Laptop carries it too
  expect(await setSetting(a.page, 'tabs.position', 'left')).toEqual({ ok: true })
  await expect(a.page.locator('#tabpanel')).toBeVisible()
  await expect(a.page.locator(`#tabpanel .tp-device[data-device-id="${b.id}"] .tab-mail`)).toHaveCount(1, SLOW)
})
