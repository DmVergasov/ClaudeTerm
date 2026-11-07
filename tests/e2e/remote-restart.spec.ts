import { expect, test } from '@playwright/test'
import { bufferText, typeInTerminal } from './helpers'
import { closePaired, type Device, openShell, pairedApps, relaunch, SLOW } from './device-pair'

test.afterEach(closePaired)

const tabIdsOf = (d: Device) => d.page.evaluate(() => window.__ct!.tabIds())

test("B restarts in place: A's tab comes back on B with the same id, its screen, and B's input reaches A", async () => {
  test.setTimeout(240_000)
  const { a, b } = await pairedApps()
  const tab = await openShell(a)
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(tab.id)

  await relaunch(b)
  await expect.poll(() => tabIdsOf(b), SLOW).toContain(tab.id)

  // A prints after B's restart: B shows the output and takes its input
  await typeInTerminal(a.page, 'echo marker-after-laptop-restart')
  await expect.poll(() => bufferText(a.page, tab.id), SLOW).toMatch(/marker-after-laptop-restart[\s\S]*marker-after-laptop-restart/)
  await b.page.evaluate((id) => window.ct.activateTab(id), tab.id)
  await expect.poll(() => bufferText(b.page, tab.id), SLOW).toMatch(/marker-after-laptop-restart[\s\S]*marker-after-laptop-restart/)
  await typeInTerminal(b.page, 'echo input-from-laptop-restarted')
  await expect.poll(() => bufferText(a.page, tab.id), SLOW).toMatch(/input-from-laptop-restarted[\s\S]*input-from-laptop-restarted/)
})

test("A restarts in place: B's tab comes back on A with the same id", async () => {
  test.setTimeout(240_000)
  const { a, b } = await pairedApps()
  const tab = await openShell(b)
  await expect.poll(() => tabIdsOf(a), SLOW).toContain(tab.id)

  await relaunch(a)
  await expect.poll(() => tabIdsOf(a), SLOW).toContain(tab.id)
})
