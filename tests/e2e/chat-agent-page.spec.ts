import { expect, test, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '../../src/shared/ipc'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { FakeAgentFrame, FakeTask } from '../fixtures/fake-claude/install'
import { chatReady, chatSettled, chatStandIn, CHAT_INPUT, launchChatTab, sendMessage } from './chat-helpers'
import { KEYS, launchApp, openTabInFront } from './helpers'

const DOCK = '.chat-host:visible .chat-agents-dock'
const ROWS = `${DOCK} .chat-agent`
const PAGE = '.agent-page'
const BACK = '.agent-page .agent-back'
const VPAGE = '.chat-host:visible .agent-page'
const COLUMN = `${VPAGE} .agent-column`
/** the main conversation's column: hidden while a page shows */
const MAIN_COLUMN = '.chat-host:visible .chat-column'
const AGENT_SCROLL = `${VPAGE} .agent-scroll`
const PILL = `${VPAGE} .agent-pill`
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
/** the composer under the page: the footer is a sibling of the page, in the chat view */
const FOOTER = '.chat-host:visible .agent-footer'
const AGENT_INPUT = `${FOOTER} .agent-input`
const AGENT_HINT = `${FOOTER} .agent-hint`
const AGENT_REFUSAL = `${FOOTER} .agent-refusal`
const AGENT_OFF = `${FOOTER} .agent-off`
/** a forward on the page is a bubble; in the main conversation it is a note */
const FORWARD_BUBBLE = `${COLUMN} .chat-user-row.forward`
const FORWARD_NOTE = '.chat-host:visible .chat-column .chat-forward'

/** a background agent that runs until the test writes the gate's file; its conversation: a thought, a text and a Glob */
function liveTask(gate: string, pace?: number): FakeTask {
  return {
    description: 'Find the sales files',
    result: 'unused',
    background: true,
    agents: [{
      type: 'Explore',
      description: 'Search the sales folder',
      ms: 60_000,
      gate,
      pace,
      frames: [
        { thinking: 'The sales files are probably in one folder.' },
        { text: 'Looking at the sales folder' },
        { tool: { name: 'Glob', input: { pattern: 'sales/**/*.csv' }, result: 'sales/q1.csv' } }
      ]
    }]
  }
}

/** a background task of two agents, each running until its own gate's file exists */
function twoAgentsTask(gates: [string, string]): FakeTask {
  const agent = (description: string, gate: string): FakeTask['agents'][number] => ({ type: 'Explore', description, ms: 60_000, gate, frames: [{ text: `${description} at work` }] })
  return { description: 'Two searches', result: 'unused', background: true, agents: [agent('Search the sales folder', gates[0]), agent('Search the totals', gates[1])] }
}

/** a background agent whose conversation is the frames given (its prompt first, when given), running until the gate's file exists */
function framesTask(gate: string, frames: FakeAgentFrame[], pace?: number, prompt?: string): FakeTask {
  return { description: 'Read the release notes', result: 'unused', background: true, agents: [{ type: 'Explore', description: 'Read the release notes', ms: 60_000, gate, pace, prompt, frames }] }
}

/** the first item of the agent page's column that is at least partly in view, and its offset from the top of the view */
const agentTopItem = (page: Page): Promise<{ id: string; offset: number } | null> => page.locator(AGENT_SCROLL).evaluate((el) => {
  const top = el.getBoundingClientRect().top
  for (const node of Array.from(el.querySelectorAll<HTMLElement>('.agent-column > [data-item]'))) {
    const box = node.getBoundingClientRect()
    if (box.bottom > top) return { id: node.dataset.item!, offset: box.top - top }
  }
  return null
})

/** the reading place once it stops moving: the top item and the scroll position are the same in two reads 100 ms apart */
async function settledPlace(page: Page): Promise<{ id: string; offset: number } | null> {
  let last = ''
  for (let i = 0; i < 100; i++) {
    const top = await agentTopItem(page)
    const read = JSON.stringify({ top, scrollTop: await page.locator(AGENT_SCROLL).evaluate((el) => el.scrollTop) })
    if (read === last) return top
    last = read
    await page.waitForTimeout(100)
  }
  throw new Error("the agent page's reading place keeps moving")
}

/** scrolls the agent page to its top a frame at a time until a text of its column matches: each return to the top is a real scroll event */
async function walkUpAgent(page: Page, text: RegExp): Promise<void> {
  await expect.poll(() => page.evaluate(async (source) => {
    // the chat in front: the host that is shown (Playwright's :visible is not a selector the page has)
    const host = [...document.querySelectorAll<HTMLElement>('.chat-host')].find((h) => h.offsetParent !== null)!
    const scroll = host.querySelector<HTMLElement>('.agent-scroll')!
    const want = new RegExp(source)
    const drawn = (): boolean => Array.from(host.querySelectorAll('.agent-column .chat-text')).some((n) => want.test(n.textContent ?? ''))
    const frame = (): Promise<void> => new Promise((resolve) => { requestAnimationFrame(() => resolve()); setTimeout(resolve, 50) })
    for (let i = 0; i < 1500 && !drawn(); i++) {
      scroll.scrollTop = 0
      await frame()
    }
    return drawn()
  }, text.source), { timeout: 90_000, intervals: [100] }).toBe(true)
}

/** the paragraphs of a long answer: the main column scrolls, and the reader can be left in its middle */
const LONG_ANSWER = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: the main conversation keeps its place while the agent runs.`).join('\n\n')

/** the first item of the main column that is at least partly in view, and its offset from the top of the view */
const topItem = (page: Page): Promise<{ id: string; offset: number } | null> => page.locator('.chat-host:visible .chat-scroll').evaluate((el) => {
  const top = el.getBoundingClientRect().top
  for (const node of Array.from(el.querySelectorAll<HTMLElement>('.chat-column > [data-item]'))) {
    const box = node.getBoundingClientRect()
    if (box.bottom > top) return { id: node.dataset.item!, offset: box.top - top }
  }
  return null
})

test('a click on a dock row opens the page: header, running ring, live text, thinking and tool steps', async () => {
  const { app, page } = await launchChatTab({ turns: { team: [{ task: liveTask('release-search') }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    const agent = page.locator(PAGE)
    await expect(agent).toBeVisible()
    await expect(agent.locator('.agent-type')).toHaveText('Explore')
    await expect(agent.locator('.agent-desc')).toHaveText('Search the sales folder')
    await expect(agent.locator('.agent-state .chat-ring')).toHaveCount(1)
    await expect(agent.locator('.agent-state-text')).toContainText('Running · ')
    await expect(agent.locator('.chat-text')).toContainText('Looking at the sales folder')
    await expect(agent.locator('.chat-thinking')).toHaveCount(1)
    await expect(agent.locator('.chat-tool-name')).toHaveText('Glob')
  } finally {
    await app.close()
  }
})

test('Enter and Space on a dock row open the page', async () => {
  const { app, page } = await launchChatTab({ turns: { team: [{ task: liveTask('release-search') }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    const row = page.locator(ROWS)
    await expect(row).toHaveAttribute('role', 'button')
    await expect(row).toHaveAttribute('tabindex', '0')
    await expect(row).toHaveAttribute('title', 'Open this agent')
    await row.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator(PAGE)).toBeVisible()
    await expect(row).toHaveAttribute('aria-current', 'true')
    await page.locator(BACK).click()
    await expect(page.locator(PAGE)).toHaveCount(0)
    await row.focus()
    await page.keyboard.press(' ')
    await expect(page.locator(PAGE)).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a snapshot that fails opens no page and leaves no error on the page', async () => {
  const { app, page } = await launchChatTab({ turns: { team: [{ task: liveTask('release-snapshot') }, { text: 'Done.' }] } })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    // main answers every snapshot request with a failure, as it does when its guard throws
    await app.evaluate(({ ipcMain }, channel) => {
      const state = globalThis as { failedSnapshots?: number }
      state.failedSnapshots = 0
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => {
        state.failedSnapshots = (state.failedSnapshots ?? 0) + 1
        return Promise.reject(new Error('the snapshot failed'))
      })
    }, IPC.chatAgentSnapshot)
    await page.locator(ROWS).click()
    await expect.poll(() => app.evaluate(() => (globalThis as { failedSnapshots?: number }).failedSnapshots ?? 0)).toBe(1)
    // a second request is answered after the first answer, so the first failure has reached the page when this returns
    await page.evaluate(() => window.ct.chatAgentSnapshot(window.__ct!.activeTabId()!, 'agent-after-failure')).catch(() => undefined)
    await expect(page.locator(PAGE)).toHaveCount(0)
    await expect(page.locator(CHAT_INPUT)).toBeVisible()
    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})

test('the back arrow and Esc return to the main conversation at the same top item, and Esc interrupts nothing', async () => {
  const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: the main conversation keeps its place while the agent runs.`)
  const { app, page, log } = await launchChatTab({ turns: { team: [{ text: paragraphs.join('\n\n') }, { task: liveTask('release-search') }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    // the reader reads up: the column is no longer stuck to its end
    await page.locator('.chat-host:visible .chat-scroll').evaluate((el) => { el.scrollTop = 400 })
    const before = await topItem(page)
    expect(before).not.toBeNull()
    // the dock is out of view at this scroll, so the row is clicked where it is
    await page.locator(ROWS).dispatchEvent('click')
    await expect(page.locator(PAGE)).toBeVisible()
    await page.locator(BACK).click()
    await expect(page.locator(PAGE)).toHaveCount(0)
    const afterBack = await topItem(page)
    expect(afterBack?.id).toBe(before!.id)
    expect(Math.abs(afterBack!.offset - before!.offset)).toBeLessThanOrEqual(1)
    // Esc on the page closes it the same way, and interrupts nothing
    await page.locator(ROWS).dispatchEvent('click')
    await expect(page.locator(PAGE)).toBeVisible()
    await page.locator(PAGE).focus()
    await page.keyboard.press('Escape')
    await expect(page.locator(PAGE)).toHaveCount(0)
    const afterEsc = await topItem(page)
    expect(afterEsc?.id).toBe(before!.id)
    expect(Math.abs(afterEsc!.offset - before!.offset)).toBeLessThanOrEqual(1)
    expect(JSON.stringify(log())).not.toContain('interrupt')
  } finally {
    await app.close()
  }
})

test('keys typed on the page reach neither the main composer nor a waiting card', async () => {
  const { app, page } = await launchChatTab({
    turns: {
      team: [
        { task: liveTask('release-search') },
        { ask: { tool: 'Bash', input: { command: 'ls' } }, allowed: [{ text: 'listed' }], denied: [{ text: 'no' }] }
      ]
    }
  })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator('.chat-card button', { hasText: 'Allow once' })).toBeVisible()
    await page.locator(ROWS).click()
    await expect(page.locator(PAGE)).toBeVisible()
    await page.locator(PAGE).focus()
    await page.keyboard.type('yes please')
    await page.keyboard.press('Enter')
    await page.locator(BACK).click()
    await expect(page.locator(PAGE)).toHaveCount(0)
    // the card still waits, unanswered, and the composer's field is empty
    await expect(page.locator('.chat-card button', { hasText: 'Allow once' })).toBeVisible()
    await expect(page.locator('.chat-card.answered')).toHaveCount(0)
    await expect(page.locator(CHAT_INPUT)).toHaveValue('')
  } finally {
    await app.close()
  }
})

test('the header reaches Done, Failed and Stopped', async () => {
  // three agents of one call: one fails at 4 s, one is done at 6 s, one is stopped at 8 s; the page of each is opened while it runs
  const { app, page } = await launchChatTab({
    turns: {
      team: [{
        task: {
          description: 'Check the sales',
          result: 'Checked.',
          agents: [
            { type: 'Explore', description: 'Failing search', ms: 4_000, failed: true },
            { type: 'general-purpose', description: 'Totals check', ms: 6_000 },
            { type: 'general-purpose', description: 'Stopped check', ms: 8_000, end: 'stopped' }
          ]
        }
      }, { text: 'Done.' }]
    }
  })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(3)
    const agent = page.locator(PAGE)
    await page.locator(ROWS).nth(0).click()
    await expect(agent.locator('.agent-desc')).toHaveText('Failing search')
    await expect(agent.locator('.agent-state-text')).toHaveText(/^Failed · /, { timeout: 15_000 })
    await expect(agent.locator('.agent-state .chat-ring')).toHaveCount(0)
    await page.locator(BACK).click()
    await page.locator(ROWS).nth(1).click()
    await expect(agent.locator('.agent-state-text')).toHaveText(/^Done · /, { timeout: 15_000 })
    await page.locator(BACK).click()
    await page.locator(ROWS).nth(2).click()
    await expect(agent.locator('.agent-state-text')).toHaveText('Stopped', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('with reduced motion the header\'s ring stands still', async () => {
  const { app, page } = await launchChatTab({ turns: { team: [{ task: liveTask('release-search') }, { text: 'Done.' }] } })
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await sendMessage(page, 'team')
    await page.locator(ROWS).click()
    const ring = page.locator(`${PAGE} .agent-state .chat-ring`)
    await expect(ring).toHaveCount(1)
    expect(await ring.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
  } finally {
    await app.close()
  }
})

test('switching tabs keeps the page, and the reading place of the conversation', async () => {
  const { app, page, tabId, work } = await launchChatTab({ turns: { team: [{ text: LONG_ANSWER }, { task: liveTask('release-search') }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    // the reader reads up in the conversation, then opens the agent from the dock out of view
    await page.locator('.chat-host:visible .chat-scroll').evaluate((el) => { el.scrollTop = 400 })
    const before = await topItem(page)
    await page.locator(ROWS).dispatchEvent('click')
    await expect(page.locator(PAGE)).toBeVisible()
    await openTabInFront(page, 'shell', work)
    await expect(page.locator(PAGE)).toBeHidden()
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await expect(page.locator(PAGE)).toBeVisible()
    await expect(page.locator(`${PAGE} .agent-type`)).toHaveText('Explore')
    await chatSettled(page)
    await page.locator(BACK).click()
    await expect(page.locator(PAGE)).toHaveCount(0)
    const after = await topItem(page)
    expect(after?.id).toBe(before!.id)
    expect(Math.abs(after!.offset - before!.offset)).toBeLessThanOrEqual(1)
  } finally {
    await app.close()
  }
})

test('a page hidden when its reload is answered keeps its reading place', async () => {
  const frames = Array.from({ length: 40 }, (_, i) => ({ text: `Paragraph ${i + 1} of the search` }))
  const { app, page, tabId, work } = await launchChatTab({ turns: { team: [{ task: framesTask('release-hidden', frames, 0) }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(`${COLUMN} .chat-text`, { hasText: 'Paragraph 40 of the search' })).toHaveCount(1)
    // the reader is up in the page; the snapshot the page reloads is taken from the chat, and main holds its answers from here
    const agentId = (await page.locator(ROWS).getAttribute('data-agent'))!
    const snapshot = await page.evaluate(([tab, agent]) => window.ct.chatAgentSnapshot(tab, agent), [tabId, agentId])
    await page.locator(AGENT_SCROLL).evaluate((el) => { el.scrollTop = 200 })
    const before = await settledPlace(page)
    expect(before).not.toBeNull()
    await app.evaluate(({ ipcMain }, args) => {
      const state = globalThis as { snapshotAnswer?: unknown; holdSnapshots?: boolean; heldSnapshots?: Array<(answer: unknown) => void> }
      state.snapshotAnswer = args.answer
      state.holdSnapshots = true
      state.heldSnapshots = []
      ipcMain.removeHandler(args.channel)
      ipcMain.handle(args.channel, () => (state.holdSnapshots ? new Promise((resolve) => { state.heldSnapshots?.push(resolve) }) : state.snapshotAnswer))
    }, { channel: IPC.chatAgentSnapshot, answer: snapshot })
    // the tab is shown again: the page asks for its snapshot, and the reader leaves again before the answer comes
    const shell = await openTabInFront(page, 'shell', work)
    await expect(page.locator(PAGE)).toBeHidden()
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await expect(page.locator(PAGE)).toBeVisible()
    await page.evaluate((id) => window.ct.activateTab(id), shell)
    await expect(page.locator(PAGE)).toBeHidden()
    // the answer comes while the page is hidden
    await app.evaluate(() => {
      const state = globalThis as { snapshotAnswer?: unknown; holdSnapshots?: boolean; heldSnapshots?: Array<(answer: unknown) => void> }
      state.holdSnapshots = false
      for (const answer of state.heldSnapshots ?? []) answer(state.snapshotAnswer)
      state.heldSnapshots = []
    })
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await expect(page.locator(PAGE)).toBeVisible()
    await expect.poll(async () => {
      const place = await settledPlace(page)
      return place !== null && place.id === before!.id && Math.abs(place.offset - before!.offset) <= 1
    }, { timeout: 15_000 }).toBe(true)
  } finally {
    await app.close()
  }
})

test('the dock stays on the page: the open agent\'s row is visible and marked, and another row opens its page', async () => {
  const { app, page } = await launchChatTab({ turns: { team: [{ task: twoAgentsTask(['release-one', 'release-two']) }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(2)
    await page.locator(ROWS).nth(0).click()
    await expect(page.locator(`${PAGE} .agent-desc`)).toHaveText('Search the sales folder')
    const open = page.locator(`${DOCK} .chat-agent[aria-current="true"]`)
    await expect(open).toHaveCount(1)
    await expect(open).toBeVisible()
    await expect(open).toContainText('Search the sales folder')
    // the dock's clock keeps counting while the page shows
    const clock = page.locator(`${DOCK} .chat-agent-time`).first()
    const first = await clock.textContent()
    await expect.poll(() => clock.textContent(), { timeout: 5_000 }).not.toBe(first)
    // the other row is in sight on the page: a click opens that agent's page
    await page.locator(ROWS).nth(1).click()
    await expect(page.locator(`${PAGE} .agent-desc`)).toHaveText('Search the totals')
    await expect(page.locator(`${DOCK} .chat-agent[aria-current="true"]`)).toContainText('Search the totals')
  } finally {
    await app.close()
  }
})

test('a page follows its agent live: its later text and Glob step appear on the open page', async () => {
  // the frames come a few seconds apart: the page is opened after the first one, and the rest arrive on it
  const { app, page } = await launchChatTab({ turns: { team: [{ task: liveTask('release-search', 3000) }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    // the agent's frames are 3 s apart: the text comes within the page's own wait for them, under the load of two workers
    await expect(page.locator(`${PAGE} .chat-text`)).toContainText('Looking at the sales folder', { timeout: 20_000 })
    await expect(page.locator(`${PAGE} .chat-tool-name`)).toHaveText('Glob', { timeout: 20_000 })
  } finally {
    await app.close()
  }
})

test('Find closing on the page gives the focus back to the page, so Esc still returns', async () => {
  const { app, page } = await launchChatTab({ turns: { team: [{ task: liveTask('release-search') }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await page.locator(ROWS).click()
    await expect(page.locator(PAGE)).toBeVisible()
    await page.keyboard.press(KEYS.find)
    await expect(page.locator('#search input')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('#search input')).toBeHidden()
    expect(await page.evaluate(() => document.activeElement?.classList.contains('agent-page'))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.locator(PAGE)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a page open in a tab in the back does not stop the page in front from getting its agent\'s frames', async () => {
  test.setTimeout(180_000)
  // the first tab's page is closed while the second tab's page is in front: the front page is still watched, so its later frames come
  const { app, page, tabId, work } = await launchChatTab({ turns: { team: [{ task: liveTask('release-back', 12_000) }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await page.locator(ROWS).click()
    await expect(page.locator(VPAGE)).toBeVisible()
    await openTabInFront(page, 'claude', work)
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(VPAGE)).toBeVisible()
    // the first tab's page is closed in the back (its view switches to the terminal)
    await page.evaluate((id) => window.ct.setTabView(id, 'terminal'), tabId)
    // the tab in front stays the second one: its page is the one that must keep its frames
    await expect.poll(() => page.evaluate(() => window.__ct!.activeTabId())).not.toBe(tabId)
    // the agent starts after the view change, and its frames are 12 s apart: the later frames are waited for over two of those gaps
    await expect(page.locator(`${VPAGE} .chat-text`)).toContainText('Looking at the sales folder', { timeout: 60_000 })
    await expect(page.locator(`${VPAGE} .chat-tool-name`)).toHaveText('Glob', { timeout: 60_000 })
  } finally {
    await app.close()
  }
})

test('an agent that ends as its page opens shows Done', async () => {
  // the agent ends at once after the page is asked for: its last patch must reach the page, not be lost in the snapshot's gap
  const { app, page, config } = await launchChatTab({ turns: { team: [{ task: liveTask('release-end') }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    writeFileSync(join(config, 'release-end'), '')
    await expect(page.locator(`${PAGE} .agent-state-text`)).toHaveText(/^Done · /, { timeout: 20_000 })
  } finally {
    await app.close()
  }
})

test('switching to the terminal closes the page', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { team: [{ task: liveTask('release-search') }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await page.locator(ROWS).click()
    await expect(page.locator(PAGE)).toBeVisible()
    await page.evaluate((id) => window.ct.setTabView(id, 'terminal'), tabId)
    await expect(page.locator(PAGE)).toHaveCount(0)
    await page.evaluate((id) => window.ct.setTabView(id, 'chat'), tabId)
    await expect(page.locator('.chat-host:visible .chat-input')).toBeVisible()
    await expect(page.locator(PAGE)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a long agent conversation shows its end, holds a small DOM and pages older items', async () => {
  test.setTimeout(180_000)
  const frames = Array.from({ length: 600 }, (_, i) => ({ text: `Frame ${i + 1} of the search` }))
  const { app, page } = await launchChatTab({ turns: { team: [{ task: framesTask('release-long', frames, 0) }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(`${COLUMN} .chat-text`, { hasText: 'Frame 600 of the search' })).toBeInViewport()
    expect(await page.locator(`${COLUMN} > [data-item]`).count()).toBeLessThanOrEqual(120)
    // the first frame is held by the agent's memory, not drawn: the reader's walk to the top asks for the older pages
    // a text's own text ends with a line break: the match allows it
    await walkUpAgent(page, /^Frame 1 of the search\s*$/)
    await expect(page.locator(`${COLUMN} .chat-text`, { hasText: /^Frame 1 of the search\s*$/ })).toHaveCount(1)
    expect(await page.locator(`${COLUMN} > [data-item]`).count()).toBeLessThanOrEqual(120)
  } finally {
    await app.close()
  }
})

test('while you read above, new frames do not move the column and the pill brings you down', async () => {
  test.setTimeout(180_000)
  // a frame every 300 ms: the reader is up in the page before the last frames come
  const frames = Array.from({ length: 80 }, (_, i) => ({ text: `Paragraph ${i + 1}: the search goes on while you read.` }))
  const { app, page } = await launchChatTab({ turns: { team: [{ task: framesTask('release-read', frames, 300) }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    // a frame every 300 ms: the 20th is about 6 s in, so the wait for it is longer than the default
    await expect(page.locator(`${COLUMN} .chat-text`, { hasText: 'Paragraph 20:' })).toHaveCount(1, { timeout: 30_000 })
    await page.locator(AGENT_SCROLL).evaluate((el) => { el.scrollTop = 200 })
    const before = await agentTopItem(page)
    expect(before).not.toBeNull()
    await expect(page.locator(PILL)).toBeVisible({ timeout: 60_000 })
    const after = await agentTopItem(page)
    expect(after?.id).toBe(before!.id)
    expect(Math.abs(after!.offset - before!.offset)).toBeLessThanOrEqual(1)
    await page.locator(PILL).click()
    // the bottom is in view as the click lands, and the pill is gone with it
    await expect(page.locator(`${COLUMN} .chat-text`, { hasText: 'Paragraph 80:' })).toBeInViewport({ timeout: 60_000 })
    await expect(page.locator(PILL)).toBeHidden()
  } finally {
    await app.close()
  }
})

test('Claude asked is folded after six lines and Show all unfolds it', async () => {
  const prompt = Array.from({ length: 8 }, (_, i) => `Part ${i + 1} of the question: check the sales folder.`).join('\n\n')
  const { app, page } = await launchChatTab({ turns: { team: [{ task: framesTask('release-ask', [{ text: 'Reading the files' }], 0, prompt) }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    const asked = page.locator(`${COLUMN} .chat-prompt`)
    await expect(asked.locator('.chat-prompt-head')).toHaveText('Claude asked')
    const body = asked.locator('.chat-prompt-body')
    await expect(body).toBeVisible()
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await expect(asked.locator('.chat-prompt-more')).toHaveText('Show all')
    await asked.locator('.chat-prompt-more').click()
    await expect(asked.locator('.chat-prompt-more')).toHaveCount(0)
    expect(await body.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true)
    await expect(body).toContainText('Part 8 of the question')
  } finally {
    await app.close()
  }
})

test('a later message from Claude is a From Claude block', async () => {
  // a message Claude sends the agent after its first: the stand-in sends it as a user frame, which is a prompt of the page
  const later: FakeAgentFrame = { prompt: 'Also check the totals for March.' }
  const { app, page } = await launchChatTab({ turns: { team: [{ task: framesTask('release-later', [{ text: 'Reading the files' }, later], 0, 'Find the sales files.') }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(`${COLUMN} .chat-prompt`)).toHaveCount(2)
    await expect(page.locator(`${COLUMN} .chat-prompt-head`)).toHaveText(['Claude asked', 'From Claude'])
    await expect(page.locator(`${COLUMN} .chat-prompt`).nth(1)).toContainText('Also check the totals for March.')
  } finally {
    await app.close()
  }
})

test('Find searches the agent page that shows', async () => {
  const { app, page } = await launchChatTab({ turns: { team: [{ task: framesTask('release-find', [{ text: 'The release notes mention a zebra crossing.' }]) }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(`${COLUMN} .chat-text`)).toContainText('zebra')
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('zebra')
    await expect.poll(() => page.evaluate(() => CSS.highlights.get('chat-find-current')?.size ?? 0)).toBe(1)
    expect(await page.evaluate(() => {
      const [current] = [...CSS.highlights.get('chat-find-current')!]
      return current!.startContainer.parentElement?.closest('.agent-column') != null
    })).toBe(true)
  } finally {
    await app.close()
  }
})

test('an agent that has said nothing yet says so', async () => {
  const task = { description: 'Read the release notes', result: 'unused', background: true as const, agents: [{ type: 'Explore', description: 'Search the sales folder', ms: 60_000, gate: 'release-quiet' }] }
  const { app, page } = await launchChatTab({ turns: { team: [{ task }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(`${VPAGE} .agent-empty`)).toHaveText('Nothing yet — the agent has just started')
  } finally {
    await app.close()
  }
})

test('an ended agent with nothing live and no transcript says it was not saved', async () => {
  const task = { description: 'Read the release notes', result: 'unused', background: true as const, agents: [{ type: 'Explore', description: 'Search the sales folder', ms: 60_000, gate: 'release-gone', transcript: false as const }] }
  const { app, page, config } = await launchChatTab({ turns: { team: [{ task }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(`${VPAGE} .agent-empty`)).toHaveText('Nothing yet — the agent has just started')
    writeFileSync(join(config, 'release-gone'), '')
    await expect(page.locator(`${VPAGE} .agent-state-text`)).toHaveText(/^Done · /, { timeout: 20_000 })
    await expect(page.locator(`${VPAGE} .agent-empty`)).toHaveText("This agent's conversation was not saved")
  } finally {
    await app.close()
  }
})

test('a reload keeps the older items the reader paged in, and the reading place', async () => {
  test.setTimeout(180_000)
  // 600 frames: the snapshot a reload brings is the newest 200, so the first frame is held only by the pages the reader paged in
  const frames = Array.from({ length: 600 }, (_, i) => ({ text: `Frame ${i + 1} of the search` }))
  const { app, page, tabId, work } = await launchChatTab({ turns: { team: [{ task: framesTask('release-reload', frames, 0) }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(`${COLUMN} .chat-text`, { hasText: 'Frame 600 of the search' })).toHaveCount(1)
    await walkUpAgent(page, /^Frame 1 of the search\s*$/)
    await expect(page.locator(`${COLUMN} .chat-text`, { hasText: /^Frame 1 of the search\s*$/ })).toHaveCount(1)
    const before = await settledPlace(page)
    expect(before).not.toBeNull()
    // the tab is left and shown again: the page is reloaded from its snapshot
    await openTabInFront(page, 'shell', work)
    await expect(page.locator(PAGE)).toBeHidden()
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await expect(page.locator(PAGE)).toBeVisible()
    // the place is read once it stops moving, and the offset is checked with the id, inside the poll
    await expect.poll(async () => {
      const place = await settledPlace(page)
      return place !== null && place.id === before!.id && Math.abs(place.offset - before!.offset) <= 1
    }, { timeout: 15_000 }).toBe(true)
    await expect(page.locator(`${COLUMN} .chat-text`, { hasText: /^Frame 1 of the search\s*$/ })).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test('Show all holds: a Claude asked block stays unfolded when the agent ends', async () => {
  const prompt = Array.from({ length: 8 }, (_, i) => `Part ${i + 1} of the question: check the sales folder.`).join('\n\n')
  const { app, page, config } = await launchChatTab({ turns: { team: [{ task: framesTask('release-show', [{ text: 'Reading the files' }], 0, prompt) }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    const body = page.locator(`${COLUMN} .chat-prompt-body`)
    await expect(body).toHaveClass(/folded/)
    await page.locator(`${COLUMN} .chat-prompt-more`).click()
    await expect(body).not.toHaveClass(/folded/)
    writeFileSync(join(config, 'release-show'), '')
    await expect(page.locator(`${VPAGE} .agent-state-text`)).toHaveText(/^Done · /, { timeout: 20_000 })
    await expect(body).not.toHaveClass(/folded/)
    await expect(page.locator(`${COLUMN} .chat-prompt-more`)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('Find lands on a match in a folded Claude asked, and shows it', async () => {
  // the word is in the last paragraph only: the part a six-line fold hides
  const prompt = Array.from({ length: 8 }, (_, i) => (i === 7 ? 'Part 8 of the question: check the zebra crossing notes.' : `Part ${i + 1} of the question: check the sales folder.`)).join('\n\n')
  const { app, page } = await launchChatTab({ turns: { team: [{ task: framesTask('release-hidden', [{ text: 'Reading the files' }], 0, prompt) }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(`${COLUMN} .chat-prompt-body`)).toHaveClass(/folded/)
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('zebra')
    await expect.poll(() => page.evaluate(() => CSS.highlights.get('chat-find-current')?.size ?? 0)).toBe(1)
    // the match is drawn inside the box of its prompt, and that box is in the view
    expect(await page.evaluate(() => {
      const range = [...CSS.highlights.get('chat-find-current')!][0] as Range
      const parent = range.startContainer.parentElement!
      const box = range.getBoundingClientRect()
      const body = parent.closest('.chat-prompt-body')!.getBoundingClientRect()
      const scroll = parent.closest('.agent-scroll')!.getBoundingClientRect()
      return box.top >= Math.max(body.top, scroll.top) && box.bottom <= Math.min(body.bottom, scroll.bottom)
    })).toBe(true)
    await expect(page.locator(`${COLUMN} .chat-prompt-body`, { hasText: 'zebra' })).toBeInViewport()
  } finally {
    await app.close()
  }
})

test('closing the agent page clears the highlights Find painted on it', async () => {
  const { app, page } = await launchChatTab({ turns: { team: [{ task: framesTask('release-clear', [{ text: 'The release notes mention a zebra crossing.' }]) }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(`${COLUMN} .chat-text`)).toContainText('zebra')
    await page.keyboard.press(KEYS.find)
    await page.keyboard.type('zebra')
    await expect.poll(() => page.evaluate(() => CSS.highlights.get('chat-find')?.size ?? 0)).toBe(1)
    await page.locator(BACK).click()
    await expect(page.locator(PAGE)).toHaveCount(0)
    expect(await page.evaluate(() => CSS.highlights.has('chat-find') || CSS.highlights.has('chat-find-current'))).toBe(false)
  } finally {
    await app.close()
  }
})

/** an Agent call whose one agent ends at once, its conversation written to its transcript */
function finishedTask(description: string, text: string): FakeTask {
  return { description, result: 'Done with it.', agents: [{ type: 'Explore', description, ms: 300, frames: [{ text }] }] }
}

/** the Agent call's row of the given subject in the chat in front; its step is opened first when it is folded */
async function agentRow(page: Page, subject: string) {
  const row = page.locator('.chat-host:visible .chat-step-row', { has: page.locator('.chat-tool-subject', { hasText: subject }) }).first()
  if (!(await row.isVisible())) await page.locator('.chat-host:visible .chat-step-head').first().click()
  return row
}

test("an Agent call's row opens its page after the dock has closed", async () => {
  const { app, page } = await launchChatTab({ turns: { team: [{ task: finishedTask('Search the sales folder', 'Sales folder read') }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(MAIN_COLUMN)).toContainText('Done.')
    // the dock lingers for a while after its agents end; the row is opened once it has gone
    await expect(page.locator(DOCK)).not.toHaveClass(/shown/, { timeout: 15_000 })
    const row = await agentRow(page, 'Search the sales folder')
    await expect(row).toHaveAttribute('role', 'button')
    await expect(row).toHaveAttribute('tabindex', '0')
    await expect(row).toHaveClass(/\bagent\b/)
    await expect(row).toHaveAttribute('title', 'Open this agent')
    await expect(row.locator('.chat-step-open')).toHaveText('›')
    await row.click()
    await expect(page.locator(PAGE)).toBeVisible()
    await expect(page.locator(`${VPAGE} .agent-desc`)).toHaveText('Search the sales folder')
    await expect(page.locator(`${VPAGE} .chat-text`)).toContainText('Sales folder read')
    await page.locator(BACK).click()
    await expect(page.locator(PAGE)).toHaveCount(0)
    const again = await agentRow(page, 'Search the sales folder')
    await again.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator(PAGE)).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a call with no known agent is not a button', async () => {
  // an Agent call whose result names no agent: no agent is known for it, so its row is plain
  const call = { tool: { name: 'Agent', input: { description: 'Check the notes', prompt: 'Check the notes', subagent_type: 'Explore' }, result: 'Nothing to check.' } }
  const { app, page } = await launchChatTab({ turns: { team: [call, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(MAIN_COLUMN)).toContainText('Done.')
    const row = await agentRow(page, 'Check the notes')
    await expect(row).toBeVisible()
    await expect(row).not.toHaveAttribute('role', 'button')
    await expect(row).not.toHaveAttribute('tabindex', '0')
    await expect(row).not.toHaveAttribute('data-agent', /.*/)
    await expect(row).not.toHaveClass(/\bagent\b/)
    await expect(row.locator('.chat-step-open')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test("an agent started by an agent has its own page, opened from its row on the parent's page", async () => {
  const nested: FakeTask = { description: 'Look closer at the notes', result: 'unused', background: true, agents: [{ type: 'Explore', description: 'Look closer at the notes', ms: 60_000, gate: 'nested-release', frames: [{ text: 'Nested words from the notes' }] }] }
  const parent = framesTask('parent-release', [{ task: nested }, { text: 'Parent words' }])
  const { app, page } = await launchChatTab({ turns: { team: [{ task: parent }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(`${COLUMN} .chat-text`)).toContainText('Parent words')
    const row = await agentRow(page, 'Look closer at the notes')
    await expect(row).toHaveAttribute('role', 'button')
    await row.click()
    await expect(page.locator(`${VPAGE} .agent-desc`)).toHaveText('Look closer at the notes')
    await expect(page.locator(`${VPAGE} .chat-text`)).toContainText('Nested words from the notes')
  } finally {
    await app.close()
  }
})

test('a card waiting in the main conversation shows the bar, and Enter returns with the card focused', async () => {
  const { app, page, config } = await launchChatTab({
    turns: {
      team: [
        { task: liveTask('release-search') },
        { gate: 'ask-now' },
        { ask: { tool: 'Bash', input: { command: 'ls' } }, allowed: [{ text: 'listed' }], denied: [{ text: 'no' }] }
      ]
    }
  })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(PAGE)).toBeVisible()
    // the card comes while the page shows: the bar appears under the header, and it takes the focus the page had
    writeFileSync(join(config, 'ask-now'), '')
    const bar = page.locator(`${VPAGE} .agent-wait`)
    await expect(bar).toBeVisible()
    await expect(bar).toContainText('Claude is waiting for your answer')
    await expect(bar.locator('strong')).toHaveText('Back to the conversation')
    await expect(bar).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator(PAGE)).toHaveCount(0)
    await expect(page.locator('.chat-host:visible .chat-card [data-start]').first()).toBeFocused()
  } finally {
    await app.close()
  }
})

test("after a restart, a step's agent opens with its history from the transcript", async () => {
  const first = await launchChatTab({ turns: { team: [{ task: finishedTask('Read the notes', 'Notes read from the folder') }, { text: 'Done.' }] } })
  await sendMessage(first.page, 'team')
  await expect(first.page.locator(MAIN_COLUMN)).toContainText('Done.')
  await expect.poll(async () => (await first.page.evaluate((id) => window.ct.chatSnapshot(id), first.tabId))?.state.turn ?? null, { timeout: 30_000 }).toBe('idle')
  // the window closes and keeps its tabs in the session snapshot of the data folder, then a second window restores them
  const closed = first.app.waitForEvent('close')
  await first.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
  await closed
  const second = await launchApp({
    dataDir: first.dataDir,
    env: { CLAUDE_CONFIG_DIR: first.config, FAKE_CLAUDE_SCRIPT: join(first.work, '..', 'script.json'), FAKE_CLAUDE_LOG: join(first.work, '..', 'fake-claude.log') }
  })
  try {
    await expect.poll(() => second.page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
    await second.page.locator('.banner-restore').click()
    await second.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
    await expect(second.page.locator('.chat-host:visible .chat-column')).toContainText('Done.')
    const row = await agentRow(second.page, 'Read the notes')
    await row.click()
    await expect(second.page.locator(PAGE)).toBeVisible()
    await expect(second.page.locator(`${VPAGE} .chat-text`)).toContainText('Notes read from the folder')
  } finally {
    await second.app.close()
  }
})

/** a chat with a background agent that has ended: its page is open, and the person's message is typed into its composer and sent */
async function forwardFromPage(page: Page, config: string, gate: string, text: string): Promise<void> {
  await sendMessage(page, 'team')
  await expect(page.locator(ROWS)).toHaveCount(1)
  await page.locator(ROWS).click()
  await expect(page.locator(PAGE)).toBeVisible()
  writeFileSync(join(config, gate), '')
  await expect(page.locator(`${VPAGE} .agent-state`)).toHaveAttribute('data-state', 'done', { timeout: 20_000 })
  await page.locator(AGENT_INPUT).click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

test('a message to a finished agent: Delivered on the page, a note and no bubble in the main conversation, the stand-in forwards it, and the agent runs again', async () => {
  const { app, page, config, log } = await launchChatTab({ forward: 'deliver', turns: { team: [{ task: liveTask('release-forward') }, { text: 'Done.' }] } })
  try {
    await forwardFromPage(page, config, 'release-forward', 'Please check the totals')
    await expect(page.locator(FORWARD_BUBBLE)).toContainText('Please check the totals')
    await expect(page.locator(`${FORWARD_BUBBLE} .agent-mark`)).toHaveText('via Claude · Delivered', { timeout: 30_000 })
    // the stand-in got the forward, and the agent answered it on its page
    expect(log().some((line) => 'forwarded' in line)).toBe(true)
    await expect(page.locator(`${COLUMN} .chat-text`, { hasText: 'Got: Please check the totals' })).toHaveCount(1, { timeout: 30_000 })
    await page.locator(BACK).click()
    await expect(page.locator(PAGE)).toHaveCount(0)
    await expect(page.locator(FORWARD_NOTE)).toContainText('↗ To Explore agent · Search the sales folder: Please check the totals')
    await expect(page.locator('.chat-host:visible .chat-column .chat-user', { hasText: 'Please check the totals' })).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test("a forward Claude fails says Not delivered: agent was cancelled", async () => {
  const { app, page, config } = await launchChatTab({ forward: 'fail', turns: { team: [{ task: liveTask('release-fail') }, { text: 'Done.' }] } })
  try {
    await forwardFromPage(page, config, 'release-fail', 'Check the totals')
    const mark = page.locator(`${FORWARD_BUBBLE} .agent-mark`)
    await expect(mark).toHaveText('via Claude · Not delivered: agent was cancelled', { timeout: 30_000 })
    await expect(mark).toHaveClass(/\berror\b/)
  } finally {
    await app.close()
  }
})

test("a forward Claude ignores says Claude did not forward it", async () => {
  const { app, page, config } = await launchChatTab({ forward: 'ignore', turns: { team: [{ task: liveTask('release-ignore') }, { text: 'Done.' }] } })
  try {
    await forwardFromPage(page, config, 'release-ignore', 'Check the totals')
    await expect(page.locator(`${FORWARD_BUBBLE} .agent-mark`)).toHaveText('via Claude · Claude did not forward it', { timeout: 30_000 })
  } finally {
    await app.close()
  }
})

test("Enter and Space on the note open the agent's page", async () => {
  const { app, page, config } = await launchChatTab({ forward: 'deliver', turns: { team: [{ task: liveTask('release-note-key') }, { text: 'Done.' }] } })
  try {
    await forwardFromPage(page, config, 'release-note-key', 'Check the totals')
    await expect(page.locator(`${FORWARD_BUBBLE} .agent-mark`)).toHaveText('via Claude · Delivered', { timeout: 30_000 })
    await page.locator(BACK).click()
    await expect(page.locator(PAGE)).toHaveCount(0)
    const note = page.locator(FORWARD_NOTE)
    await expect(note).toHaveAttribute('role', 'button')
    await expect(note).toHaveAttribute('tabindex', '0')
    await note.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator(PAGE)).toBeVisible()
    await expect(page.locator(`${PAGE} .agent-desc`)).toHaveText('Search the sales folder')
    await page.locator(BACK).click()
    await expect(page.locator(PAGE)).toHaveCount(0)
    await note.focus()
    await page.keyboard.press(' ')
    await expect(page.locator(PAGE)).toBeVisible()
  } finally {
    await app.close()
  }
})

test("a click on the note opens the agent's page", async () => {
  const { app, page, config } = await launchChatTab({ forward: 'deliver', turns: { team: [{ task: liveTask('release-note') }, { text: 'Done.' }] } })
  try {
    await forwardFromPage(page, config, 'release-note', 'Check the totals')
    await expect(page.locator(`${FORWARD_BUBBLE} .agent-mark`)).toHaveText('via Claude · Delivered', { timeout: 30_000 })
    await page.locator(BACK).click()
    await expect(page.locator(PAGE)).toHaveCount(0)
    await page.locator(FORWARD_NOTE).click()
    await expect(page.locator(PAGE)).toBeVisible()
    await expect(page.locator(`${PAGE} .agent-desc`)).toHaveText('Search the sales folder')
  } finally {
    await app.close()
  }
})

test('in plan mode the page says Not sent: plan mode and keeps the draft', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { team: [{ task: liveTask('release-plan') }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(CHAT_INPUT).click()
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Shift+Tab')
    await expect.poll(async () => (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.state.mode).toBe('plan')
    await page.locator(ROWS).click()
    await page.locator(AGENT_INPUT).click()
    await page.keyboard.type('Check the totals')
    await page.keyboard.press('Enter')
    await expect(page.locator(AGENT_REFUSAL)).toHaveText('Not sent: plan mode')
    await expect(page.locator(AGENT_INPUT)).toHaveValue('Check the totals')
    await expect(page.locator(FORWARD_BUBBLE)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test("a stopped agent's composer warns that it may not resume", async () => {
  const task = { description: 'Check the sales', result: 'Checked.', agents: [{ type: 'general-purpose', description: 'Stopped check', ms: 4_000, end: 'stopped' as const }] }
  const { app, page } = await launchChatTab({ turns: { team: [{ task }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(`${VPAGE} .agent-state-text`)).toHaveText('Stopped', { timeout: 15_000 })
    await expect(page.locator(AGENT_HINT)).toHaveText('You stopped this agent: Claude may not be able to resume it')
  } finally {
    await app.close()
  }
})

test('a chat that has exited says Claude Code is not running in this tab', async () => {
  const { app, page } = await launchChatTab({ turns: { team: [{ task: liveTask('release-exit') }, { crash: 1 }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator('.chat-notice', { hasText: 'Claude Code stopped' })).toHaveCount(1)
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(AGENT_OFF)).toHaveText('Claude Code is not running in this tab')
  } finally {
    await app.close()
  }
})

test('a chat that exits while the message box has the focus leaves Esc working on the page', async () => {
  // the turn waits until the test writes the gate's file, once the box has the focus; then the turn crashes
  const exitGate = 'release-exit-focus'
  const { app, page, config } = await launchChatTab({ turns: { team: [{ task: liveTask('release-focus') }, { gate: exitGate }, { crash: 1 }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(PAGE)).toBeVisible()
    await page.locator(AGENT_INPUT).click()
    await expect(page.locator(AGENT_INPUT)).toBeFocused()
    writeFileSync(join(config, exitGate), '')
    await expect(page.locator(AGENT_OFF)).toHaveText('Claude Code is not running in this tab', { timeout: 30_000 })
    await page.keyboard.press('Escape')
    await expect(page.locator(PAGE)).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a send that does not reach Claude Code says Not sent and keeps the draft', async () => {
  const { app, page } = await launchChatTab({ turns: { team: [{ task: liveTask('release-unreached') }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(PAGE)).toBeVisible()
    // main's send fails, as it does when a guard throws or the window is closing
    await app.evaluate(({ ipcMain }, channel) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => Promise.reject(new Error('the window is closing')))
    }, IPC.chatAgentSend)
    await page.locator(AGENT_INPUT).click()
    await page.keyboard.type('Check the totals')
    await page.keyboard.press('Enter')
    await expect(page.locator(AGENT_REFUSAL)).toHaveText('Not sent: it could not reach Claude Code')
    await expect(page.locator(AGENT_INPUT)).toHaveValue('Check the totals')
  } finally {
    await app.close()
  }
})

test('a send still pending when its page closes leaves the draft that the reopened page edited', async () => {
  const { app, page } = await launchChatTab({ turns: { team: [{ task: liveTask('release-pending') }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(PAGE)).toBeVisible()
    // main holds the send until the test answers it, so the page can close while it is pending
    await app.evaluate(({ ipcMain }, channel) => {
      const state = globalThis as { answerSend?: (refusal: string | null) => void }
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => new Promise<string | null>((resolve) => {
        state.answerSend = resolve
      }))
    }, IPC.chatAgentSend)
    await page.locator(AGENT_INPUT).click()
    await page.keyboard.type('Check the totals')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await expect(page.locator(PAGE)).toHaveCount(0)
    await page.locator(ROWS).click()
    await expect(page.locator(AGENT_INPUT)).toHaveValue('Check the totals')
    await page.locator(AGENT_INPUT).click()
    await page.keyboard.type(' and the sales')
    // the answer waits until main holds the send: an answer given before that is no answer
    await expect.poll(() => app.evaluate(() => typeof (globalThis as { answerSend?: unknown }).answerSend === 'function')).toBe(true)
    await app.evaluate(() => (globalThis as { answerSend?: (refusal: string | null) => void }).answerSend?.(null))
    await expect(page.locator(AGENT_INPUT)).toHaveValue('Check the totals and the sales')
    await page.keyboard.press('Escape')
    await expect(page.locator(PAGE)).toHaveCount(0)
    await page.locator(ROWS).click()
    await expect(page.locator(AGENT_INPUT)).toHaveValue('Check the totals and the sales')
    await expect(page.locator(AGENT_REFUSAL)).toBeHidden()
  } finally {
    await app.close()
  }
})

test('a draft is kept per agent, and Esc keeps it', async () => {
  const { app, page } = await launchChatTab({ turns: { team: [{ task: twoAgentsTask(['release-a', 'release-b']) }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(2)
    await page.locator(ROWS).nth(0).click()
    await page.locator(AGENT_INPUT).click()
    await page.keyboard.type('For the sales search')
    await page.keyboard.press('Escape')
    await expect(page.locator(PAGE)).toHaveCount(0)
    await page.locator(ROWS).nth(1).click()
    await expect(page.locator(AGENT_INPUT)).toHaveValue('')
    await page.locator(AGENT_INPUT).click()
    await page.keyboard.type('For the totals')
    await page.keyboard.press('Escape')
    await page.locator(ROWS).nth(0).click()
    await expect(page.locator(AGENT_INPUT)).toHaveValue('For the sales search')
    await page.locator(ROWS).nth(1).click()
    await expect(page.locator(AGENT_INPUT)).toHaveValue('For the totals')
  } finally {
    await app.close()
  }
})

test('the forward turn is quiet: no done sound and no mark', async () => {
  // the app writes each sound it would play to this file instead; the done sound is on for every tab
  const sounds = join(mkdtempSync(join(tmpdir(), 'ct-sound-')), 'sounds.txt')
  const played = (): string => (existsSync(sounds) ? readFileSync(sounds, 'utf8') : '')
  const gate = 'release-quiet'
  const stand = chatStandIn({ forward: 'deliver', turns: { team: [{ task: liveTask(gate) }, { text: 'Done.' }], again: [{ text: 'Again.' }] } })
  const quiet = { sound: false, flash: false, tab: true }
  const loud = { sound: true, flash: false, tab: true }
  const settings = { ...stand.settings, notifications: { permission: quiet, question: quiet, done: loud, bell: quiet } }
  const { app, page, pipeName } = await launchApp({ settings, args: stand.args, env: { ...stand.env, CLAUDETERM_TEST_SOUND_LOG: sounds } })
  try {
    await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
    const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
    const claudeTab = page.locator(`[data-tab-id="${tabId}"]`)
    await forwardFromPage(page, stand.config, gate, 'Check the totals')
    await expect(page.locator(`${FORWARD_BUBBLE} .agent-mark`)).toHaveText('via Claude · Delivered', { timeout: 30_000 })
    await page.locator(BACK).click()
    await expect.poll(async () => (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.state.turn, { timeout: 30_000 }).toBe('idle')
    // a shell tab in front: the chat is in the background when its forward turn's done comes
    const shell = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), stand.work))!
    await page.waitForFunction((id) => window.__ct!.activeTabId() === id, shell.id)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: true })
    expect(played()).toBe('')
    await expect(claudeTab).not.toHaveClass(/\battention\b/)
    // a typed turn's done plays its sound
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await sendMessage(page, 'again')
    await expect.poll(async () => (await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.state.turn, { timeout: 30_000 }).toBe('idle')
    await page.evaluate((id) => window.ct.activateTab(id), shell.id)
    expect(await sendPipeMessage(pipeName, { v: 1, type: 'attention', tabId, sessionId: SID, reason: 'done' })).toEqual({ ok: true })
    expect(played()).toBe('system\n')
  } finally {
    await app.close()
  }
})

test('a restart keeps the page open while its agent is known', async () => {
  const { app, page, tabId } = await launchChatTab({ turns: { team: [{ task: liveTask('release-restart') }, { text: 'Done.' }] } })
  try {
    await sendMessage(page, 'team')
    await expect(page.locator(ROWS)).toHaveCount(1)
    await page.locator(ROWS).click()
    await expect(page.locator(PAGE)).toBeVisible()
    await expect(page.locator(`${VPAGE} .agent-desc`)).toHaveText('Search the sales folder')
    await chatReady(page)
    await page.locator('.tab').first().click({ button: 'right' })
    await page.locator('.menu-item', { hasText: 'Restart session' }).click()
    // the main column draws nothing while a page shows: the restart is read from the chat's own snapshot
    await expect.poll(async () => JSON.stringify((await page.evaluate((id) => window.ct.chatSnapshot(id), tabId))?.items ?? []), { timeout: 30_000 }).toContain('Session restarted')
    // the agent is still known to the restarted chat: its page stays, with the agent's header
    await expect(page.locator(PAGE)).toBeVisible()
    await expect(page.locator(`${VPAGE} .agent-desc`)).toHaveText('Search the sales folder')
    // back to the conversation: the restart's line is drawn there
    await page.locator(BACK).click()
    await expect(page.locator(PAGE)).toHaveCount(0)
    await expect(page.locator(MAIN_COLUMN)).toContainText('Session restarted')
  } finally {
    await app.close()
  }
})
