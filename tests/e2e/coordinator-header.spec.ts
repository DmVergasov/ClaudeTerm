import { expect as baseExpect, test } from '@playwright/test'
import { basename } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { activate, refOf } from './agent-mail'
import { coord, coordApp, done, makeCoordinator } from './coordinator-helpers'
import { marksOf, openSessions, sessionsToggle } from './coordinator-window'

const expect = baseExpect.configure({ timeout: 15_000 })

test('a coordinator\'s header counts its sessions and has the Sessions toggle with the number that wait; other tabs have neither', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0, t1], sids } = l
  try {
    await makeCoordinator(page, t0)
    await activate(page, t0)
    await expect(page.locator('#sheet-header .sh-coord')).toHaveText('Coordinator · 0 sessions')
    await expect(sessionsToggle(page)).toBeVisible()
    await expect(sessionsToggle(page).locator('.badge')).toBeHidden()
    await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })
    await expect(page.locator('#sheet-header .sh-coord')).toHaveText('Coordinator · 1 session')
    await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId: t1, sessionId: sids[1], reason: 'permission', prompt: 'Allow Bash: npm test' })
    await expect(sessionsToggle(page).locator('.badge')).toHaveText('1')
    await done(pipeName, t1, sids[1])
    await expect(sessionsToggle(page).locator('.badge')).toBeHidden()
    await activate(page, t1)
    await expect(sessionsToggle(page)).toBeHidden()
    await expect(page.locator('#sheet-header .sh-coord')).toHaveCount(0)
  } finally { await l.app.close() }
})

test('the Sessions toggle opens and closes the Sessions panel', async () => {
  const l = await coordApp(1)
  const { page, tabs: [t0] } = l
  try {
    await makeCoordinator(page, t0)
    await activate(page, t0)
    await openSessions(page)
    await expect(page.locator('#image-panel .panel-title')).toHaveText('Sessions')
    await expect(page.locator('#image-panel .panel-sessions')).toBeVisible()
    await expect(sessionsToggle(page)).toHaveClass(/active/)
    await sessionsToggle(page).click()
    await expect(page.locator('#image-panel')).toHaveClass(/collapsed/)
  } finally { await l.app.close() }
})

test('an attached session\'s header says where it reports, and its Detach detaches it', async () => {
  const l = await coordApp(2)
  const { page, pipeName, tabs: [t0, t1], sids, repo } = l
  try {
    expect(await makeCoordinator(page, t0)).toMatchObject({ ok: true })
    expect(await coord(pipeName, t0, { op: 'attach', session: refOf(sids[1]) })).toMatchObject({ ok: true })
    await activate(page, t1)
    await expect(page.locator('#sheet-header .sh-reports')).toHaveText(`↳ Reports to ${basename(repo)} coordinator`)
    const detach = page.locator('#sheet-header .sh-detach')
    await expect(detach).toHaveText('Detach')
    await expect(detach).toHaveAttribute('title', `Detach from the ${basename(repo)} coordinator`)
    await detach.click()
    await expect.poll(async () => (await marksOf(page))[t1]).toBeUndefined()
    await expect(page.locator('#sheet-header .sh-reports')).toHaveCount(0)
  } finally { await l.app.close() }
})
