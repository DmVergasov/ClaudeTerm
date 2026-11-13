import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Note, ProjectNote } from '../../src/shared/note'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { FAKE_CLAUDE_SETTINGS, gitRepo, KEYS, launchClaudeTab, noteText } from './helpers'

const SID_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

async function closeWindow(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
  await closed
}

/** the note over the terminal: its card, the Note button and the switch */
function note(page: Page) {
  return {
    card: page.locator('#note .note-card'),
    button: page.locator('#sheet-header .tab-note-toggle'),
    side: (name: 'session' | 'project') => page.locator(`#note .note-side[data-side="${name}"]`)
  }
}

/** the size of the card as it is drawn */
async function cardSize(card: Locator): Promise<{ width: number; height: number }> {
  const box = (await card.boundingBox())!
  return { width: Math.round(box.width), height: Math.round(box.height) }
}

/** a drag of the grip: the pointer goes down at its centre, moves by (dx, dy) in five steps and is let go */
async function dragGrip(page: Page, dx: number, dy: number): Promise<void> {
  const box = (await page.locator('#note .note-grip').boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 5 })
  await page.mouse.up()
}

/** binds the tab to the conversation SID_A, so its session note is stored under it */
const bindSession = (pipeName: string, tabId: string) =>
  sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: SID_A, source: 'startup', transcriptPath: null })

test('dragging the grip left and down makes the card bigger, and the size is kept with the session note', async () => {
  const { app, page, tabId, pipeName, dataDir } = await launchClaudeTab()
  expect(await bindSession(pipeName, tabId)).toEqual({ ok: true })
  const { card, button } = note(page)

  await button.click()
  await expect(card).toBeVisible()
  expect(await cardSize(card)).toEqual({ width: 340, height: 240 })
  await page.keyboard.type('Goal: payments')
  await expect.poll(() => noteText(page)).toBe('Goal: payments')

  await dragGrip(page, -160, 100)
  expect(await cardSize(card)).toEqual({ width: 500, height: 340 })
  await closeWindow(app)
  const saved = JSON.parse(readFileSync(join(dataDir, 'session-notes.json'), 'utf8')) as Record<string, Note>
  expect(saved[SID_A]?.size).toEqual({ width: 500, height: 340 })
})

test('each note keeps its own size', async () => {
  const repo = gitRepo()
  const { app, page, tabId, pipeName, dataDir } = await launchClaudeTab(FAKE_CLAUDE_SETTINGS, repo)
  expect(await bindSession(pipeName, tabId)).toEqual({ ok: true })
  await expect.poll(() => page.evaluate((id) => window.__ct!.placeOf!(id) !== undefined, tabId)).toBe(true)
  const { card, button, side } = note(page)

  await button.click()
  await page.keyboard.type('Session text')
  await expect.poll(() => noteText(page)).toBe('Session text')
  await dragGrip(page, -160, 100)
  expect(await cardSize(card)).toEqual({ width: 500, height: 340 })

  await side('project').click()
  await expect(side('project')).toHaveClass(/active/)
  expect(await cardSize(card)).toEqual({ width: 340, height: 240 })
  await page.keyboard.type('Project text')
  await expect.poll(() => noteText(page)).toBe('Project text')
  await dragGrip(page, -60, 60)
  expect(await cardSize(card)).toEqual({ width: 400, height: 300 })

  await side('session').click()
  expect(await cardSize(card)).toEqual({ width: 500, height: 340 })
  await closeWindow(app)
  const project = JSON.parse(readFileSync(join(dataDir, 'project-notes.json'), 'utf8')) as Record<string, ProjectNote>
  expect(Object.values(project)[0]?.size).toEqual({ width: 400, height: 300 })
})

test('a double click on the grip goes back to the default size', async () => {
  const { app, page, tabId, pipeName, dataDir } = await launchClaudeTab()
  expect(await bindSession(pipeName, tabId)).toEqual({ ok: true })
  const { card, button } = note(page)

  await button.click()
  await page.keyboard.type('Goal: payments')
  await expect.poll(() => noteText(page)).toBe('Goal: payments')
  await dragGrip(page, -160, 100)
  expect(await cardSize(card)).toEqual({ width: 500, height: 340 })

  await page.locator('#note .note-grip').dblclick()
  expect(await cardSize(card)).toEqual({ width: 340, height: 240 })
  await closeWindow(app)
  const saved = JSON.parse(readFileSync(join(dataDir, 'session-notes.json'), 'utf8')) as Record<string, Note>
  expect(saved[SID_A]?.text).toBe('Goal: payments')
  expect(saved[SID_A]?.size).toBeUndefined()
})

test("the card stays within the terminal's area, and is never smaller than its minimum", async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  expect(await bindSession(pipeName, tabId)).toEqual({ ok: true })
  const { card, button } = note(page)

  await button.click()
  await page.keyboard.type('Goal: payments')
  await expect.poll(() => noteText(page)).toBe('Goal: payments')
  const area = (await page.locator('#terminals').boundingBox())!

  await dragGrip(page, -5000, 5000)
  const box = (await card.boundingBox())!
  expect(Math.round(box.x)).toBeGreaterThanOrEqual(Math.round(area.x) + 10)
  expect(Math.round(box.x + box.width)).toBeLessThanOrEqual(Math.round(area.x + area.width))
  expect(Math.round(box.y)).toBeGreaterThanOrEqual(Math.round(area.y))
  expect(Math.round(box.y + box.height)).toBeLessThanOrEqual(Math.round(area.y + area.height) - 10)

  await dragGrip(page, 5000, -5000)
  expect(await cardSize(card)).toEqual({ width: 260, height: 140 })
  await app.close()
})

test('the card keeps its room under Find: with the find box open it ends above the area\'s bottom, and it grows back when Find closes', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  expect(await bindSession(pipeName, tabId)).toEqual({ ok: true })
  const { card, button } = note(page)

  await button.click()
  await page.keyboard.type('Goal: payments')
  await expect.poll(() => noteText(page)).toBe('Goal: payments')
  await dragGrip(page, 0, 5000)
  const bottomOfRoom = async (): Promise<number> => {
    const area = (await page.locator('#terminals').boundingBox())!
    const box = (await card.boundingBox())!
    return Math.round(box.y + box.height) - Math.round(area.y + area.height)
  }
  expect(await bottomOfRoom()).toBe(-10)

  await page.locator('.terminal-host:visible .xterm').click({ position: { x: 20, y: 20 } })
  await page.keyboard.press(KEYS.find)
  await expect(page.locator('#search')).toBeVisible()
  expect(await bottomOfRoom()).toBe(-10)

  await page.keyboard.press('Escape')
  await expect(page.locator('#search')).toBeHidden()
  expect(await bottomOfRoom()).toBe(-10)
  await app.close()
})
