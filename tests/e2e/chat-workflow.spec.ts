import { expect, test, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FakeScript } from '../fixtures/fake-claude/install'
import { RUN_HINT } from '../../src/renderer/chat/agent-text'
import { launchChatTab, sendMessage } from './chat-helpers'

const DOCK = '.chat-host:visible .chat-agents-dock'
const RUN = `${DOCK} .chat-run`
const RUN_HEAD = `${DOCK} .chat-run-head`
const RUN_BODY = `${DOCK} .chat-run-body`
const RUN_AGENT = `${DOCK} .chat-run-agent`
/** the Workflow call's step row in the conversation */
const STEP = '.chat-host:visible .chat-column .chat-step-row'

/** the run: two agents in one phase; the first agent's first try fails, so it has two attempts */
const run = { name: 'crash-triage', phases: ['Triage'], agents: [{ label: 'triage-a', task: 'Look at crash 1', attempts: 2 }, { label: 'triage-b', task: 'Look at crash 2' }], gate: 'end' }

/** the rows of the dock's list that its edges cut: a row partly in view (by more than a pixel) */
const cutRows = (page: Page): Promise<string[]> => page.locator(`${DOCK} .chat-agents-list`).evaluate((list) => {
  const box = list.getBoundingClientRect()
  return [...list.querySelectorAll<HTMLElement>('.chat-agent, .chat-run-phase')].filter((row) => {
    const r = row.getBoundingClientRect()
    if (r.height === 0) return false
    const inView = Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top)
    return inView > 1 && inView < r.height - 1
  }).map((row) => row.textContent ?? '')
})

const flow = {
  turns: {
    flow: [
      { workflow: run },
      { text: 'Started.' }
    ]
  }
}

/** the same run, with an ordinary background agent that runs until <config>/keep exists: the dock stays open while the run ends */
const watched: FakeScript = {
  turns: {
    flow: [
      { task: { description: 'Keep watch', result: 'unused', background: true, agents: [{ type: 'Explore', description: 'Keep the dock open', ms: 60_000, gate: 'keep' }] } },
      { workflow: run },
      { text: 'Started.' }
    ]
  }
}

test('a run shows live in the dock as a group: head, phase, rows and the attempt chip', async () => {
  const { app, page } = await launchChatTab(flow)
  try {
    await sendMessage(page, 'flow')
    await expect(page.locator(RUN_HEAD).locator('.chat-agent-type')).toContainText('crash-triage')
    await expect(page.locator(RUN_HEAD).locator('.chat-agent-desc')).toHaveText(/^Triage · \d of 2 done$/)
    await expect(page.locator(`${DOCK} .chat-run-phase`)).toHaveText('Triage')
    await expect(page.locator(RUN_AGENT)).toHaveCount(2)
    await expect(page.locator(RUN_AGENT).locator('.chat-agent-type')).toHaveText(['triage-a', 'triage-b'])
    await expect(page.locator(`${DOCK} .chat-agent-attempt`)).toHaveText('attempt 2')
    await expect(page.locator(`${DOCK} .chat-agents-head`)).toHaveText('2 agents · 0 done')
    await expect(page.locator(STEP).filter({ has: page.locator('.chat-tool-subject', { hasText: 'crash-triage' }) }).locator('.chat-tool-detail')).toHaveText('2 agents')
  } finally {
    await app.close()
  }
})

test('the group folds when the run ends, and a click unfolds it', async () => {
  const { app, page, config } = await launchChatTab(watched)
  try {
    await sendMessage(page, 'flow')
    await expect(page.locator(RUN_AGENT)).toHaveCount(2)
    writeFileSync(join(config, 'end'), '')
    // the watch agent runs until <config>/keep exists, so the dock stays open and the group is in view
    await expect(page.locator(RUN)).toBeVisible()
    await expect(page.locator(RUN)).toHaveAttribute('data-folded', '')
    await expect(page.locator(RUN_HEAD).locator('.chat-agent-state')).toHaveText(/^done · /)
    await expect(page.locator(RUN_BODY)).toBeHidden()
    await page.locator(RUN_HEAD).click()
    await expect(page.locator(RUN)).not.toHaveAttribute('data-folded', '')
    await expect(page.locator(RUN_BODY)).toBeVisible()
    await expect(page.locator(RUN_AGENT)).toHaveCount(2)
    await expect(page.locator(RUN_AGENT).nth(0)).toBeVisible()
    await expect(page.locator(RUN_AGENT).nth(1)).toBeVisible()
    writeFileSync(join(config, 'keep'), '')
  } finally {
    await app.close()
  }
})

test("a run agent's row opens its page", async () => {
  const { app, page } = await launchChatTab(flow)
  try {
    await sendMessage(page, 'flow')
    await page.locator(RUN_AGENT, { hasText: 'triage-b' }).click()
    await expect(page.locator('.agent-page')).toBeVisible()
  } finally {
    await app.close()
  }
})

/** the same run, with a later line for triage-a: its page shows the line once <config>/later exists, and the run stays open until <config>/end */
const laterRun = { ...run, agents: [{ label: 'triage-a', task: 'Look at crash 1', attempts: 2, later: { gate: 'later', text: 'Second look' } }, { label: 'triage-b', task: 'Look at crash 2' }] }
const laterFlow = { turns: { flow: [{ workflow: laterRun }, { text: 'Started.' }] } }

test("a workflow agent's page: header, the workflow's prompt, the hint, and new lines while it runs", async () => {
  const { app, page, config } = await launchChatTab(laterFlow)
  const VPAGE = '.chat-host:visible .agent-page'
  const FOOTER = '.chat-host:visible .agent-footer'
  try {
    await sendMessage(page, 'flow')
    await page.locator(RUN_AGENT, { hasText: 'triage-a' }).click()
    await expect(page.locator(`${VPAGE} .agent-type`)).toHaveText('crash-triage · Triage')
    await expect(page.locator(`${VPAGE} .agent-desc`)).toHaveText('triage-a — Look at crash 1')
    await expect(page.locator(`${VPAGE} .agent-attempt`)).toHaveText('attempt 2')
    await expect(page.locator(`${VPAGE} .chat-prompt-head`).first()).toHaveText('The workflow asked')
    await expect(page.locator(`${FOOTER} .agent-hint-run`)).toHaveText(RUN_HINT)
    await expect(page.locator(`${FOOTER} .agent-input`)).toHaveAttribute('placeholder', 'Message the triage-a agent…')
    const first = await page.locator(`${VPAGE} .chat-prompt`).first().elementHandle()
    writeFileSync(join(config, 'later'), '')
    await expect(page.locator(`${VPAGE} .agent-column`)).toContainText('Second look', { timeout: 10_000 })
    expect(await first?.evaluate((n) => n.isConnected)).toBe(true)
    writeFileSync(join(config, 'end'), '')
  } finally {
    await app.close()
  }
})

test('the dock grows to show a run group and an agent beside it whole: no row is cut, nothing scrolls', async () => {
  const script: FakeScript = {
    turns: {
      flow: [
        { task: { description: 'Keep watch', result: 'unused', background: true, agents: [{ type: 'Explore', description: 'Keep the dock open', ms: 60_000, gate: 'keep' }] } },
        { workflow: { name: 'crash-triage', phases: ['Triage'], agents: [{ label: 'triage-android', task: 'Look at Android crashes', attempts: 2 }, { label: 'triage-ios', task: 'Look at iOS crashes' }, { label: 'triage-web', task: 'Look at web crashes' }], gate: 'end' } },
        { text: 'Started.' }
      ]
    }
  }
  const { app, page } = await launchChatTab(script)
  try {
    await sendMessage(page, 'flow')
    await expect(page.locator(RUN_AGENT)).toHaveCount(3)
    await expect(page.locator(`${DOCK} .chat-agent-attempt`)).toHaveText('attempt 2')
    await expect.poll(() => page.locator(`${DOCK} .chat-agents-list`).evaluate((list) => list.scrollHeight - list.clientHeight)).toBeLessThanOrEqual(1)
    await expect.poll(() => cutRows(page)).toEqual([])
  } finally {
    await app.close()
  }
})

test('a dock with more rows than it holds shows whole rows at its end', async () => {
  const agents = Array.from({ length: 10 }, (_, i) => ({ label: `crawl-${i + 1}`, task: `Crawl section ${i + 1}` }))
  const script: FakeScript = {
    turns: {
      flow: [
        { task: { description: 'Keep watch', result: 'unused', background: true, agents: [{ type: 'Explore', description: 'Keep the dock open', ms: 60_000, gate: 'keep' }] } },
        { workflow: { name: 'crawl', phases: ['Crawl'], agents, gate: 'end' } },
        { text: 'Started.' }
      ]
    }
  }
  const { app, page } = await launchChatTab(script)
  try {
    await sendMessage(page, 'flow')
    await expect(page.locator(RUN_AGENT)).toHaveCount(10)
    const list = page.locator(`${DOCK} .chat-agents-list`)
    await expect.poll(() => list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(2)
    await expect.poll(() => cutRows(page)).toEqual([])
  } finally {
    await app.close()
  }
})
