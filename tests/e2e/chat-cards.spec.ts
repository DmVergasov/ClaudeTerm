import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatReady, controlResponses, CHAT_INPUT, launchChatTab, sendMessage, userMessages } from './chat-helpers'
import { KEYS, openTabInFront } from './helpers'

// the tab-switch chord of the app (Ctrl+Alt+digit on Windows and Linux, ⌘ digit on macOS): on a card it answers nothing
const TAB_CHORD = process.platform === 'darwin' ? 'Meta+Digit2' : 'Control+Alt+Digit2'
const SUGGESTION = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'session' }

// the cards of the chat in front: the visible host's
const QUESTION = '.chat-host:visible .chat-card-question'
const PERMISSION = '.chat-host:visible .chat-card-permission'
const PLAN = '.chat-host:visible .chat-card-plan'
const ANSWERED = '.chat-host:visible .chat-card.answered'
const PULSE = '.chat-host:visible .chat-field-pulse'
const COLOR = 'Which color?'
const COLORS = {
  questions: [{
    question: COLOR,
    header: 'Color',
    multiSelect: false,
    options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }, { label: 'Green', description: 'fresh' }]
  }]
}
const BASH = { command: 'ls' }

/** records the URLs main hands to shell.openExternal, instead of opening a browser */
async function stubExternal(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const calls: string[] = []
    ;(globalThis as Record<string, unknown>).__externalCalls = calls
    shell.openExternal = (u: string) => { calls.push(u); return Promise.resolve() }
  })
}
const externalCalls = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as Record<string, unknown>).__externalCalls as string[])

/** the answers Claude Code got to its questions, in order */
function answersSent(log: () => Record<string, unknown>[]): unknown[] {
  return controlResponses(log).map((r) => (r.updatedInput as { answers?: unknown } | undefined)?.answers).filter((a) => a !== undefined)
}

/** the index, among the cards, of the one that holds the keyboard focus; -1 for none */
function focusedCard(page: Page): Promise<number> {
  return page.evaluate(() => [...document.querySelectorAll('.chat-card')].findIndex((card) => card.contains(document.activeElement)))
}

test('a question is answered with the keyboard', async () => {
  const { app, page, log } = await launchChatTab({
    turns: { pick: [{ ask: { tool: 'AskUserQuestion', input: COLORS }, allowed: [{ text: 'Blue it is.' }], denied: [] }] }
  })
  try {
    await sendMessage(page, 'pick')
    await expect(page.locator(QUESTION)).toHaveCount(1)
    await page.keyboard.press('2')
    await page.keyboard.press('Enter')
    await expect.poll(() => answersSent(log)).toEqual([{ [COLOR]: 'Blue' }])
  } finally {
    await app.close()
  }
})

test('a multi-select question sends every picked label', async () => {
  const input = { questions: [{ ...COLORS.questions[0], multiSelect: true }] }
  const { app, page, log } = await launchChatTab({
    turns: { pick: [{ ask: { tool: 'AskUserQuestion', input }, allowed: [{ text: 'Red and green.' }], denied: [] }] }
  })
  try {
    await sendMessage(page, 'pick')
    await expect(page.locator(`${QUESTION} input[type="checkbox"], ${QUESTION} .chat-card-check`)).toHaveCount(3)
    await page.keyboard.press('1')
    await page.keyboard.press('3')
    await page.keyboard.press('Enter')
    await expect.poll(() => answersSent(log)).toEqual([{ [COLOR]: 'Red, Green' }])
  } finally {
    await app.close()
  }
})

test('Esc dismisses a question', async () => {
  const { app, page, log } = await launchChatTab({
    turns: { pick: [{ ask: { tool: 'AskUserQuestion', input: COLORS }, allowed: [], denied: [{ text: 'No answer.' }] }] }
  })
  try {
    await sendMessage(page, 'pick')
    await expect(page.locator(QUESTION)).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect.poll(() => controlResponses(log).map((r) => r.behavior)).toEqual(['deny'])
    await expect(page.locator(ANSWERED)).toHaveText('You declined to answer')
  } finally {
    await app.close()
  }
})

test('Allow once allows; a suggestion allows for the session', async () => {
  const suggestion = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'session' }
  const { app, page, log } = await launchChatTab({
    turns: {
      once: [{ ask: { tool: 'Bash', input: BASH }, allowed: [{ text: 'Listed.' }], denied: [] }],
      always: [{ ask: { tool: 'Bash', input: BASH, suggestions: [suggestion] }, allowed: [{ text: 'Listed again.' }], denied: [] }]
    }
  })
  try {
    await sendMessage(page, 'once')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect.poll(() => controlResponses(log).map((r) => r.behavior)).toEqual(['allow'])
    expect(controlResponses(log)[0]!.updatedPermissions).toBeUndefined()
    await expect(page.locator('.chat-host:visible .chat-column')).toContainText('Listed.')

    await sendMessage(page, 'always')
    await expect(page.locator(PERMISSION, { hasText: 'Allow Bash(ls:*) for this session' })).toHaveCount(1)
    await page.keyboard.press('2')
    await expect.poll(() => controlResponses(log)[1]?.updatedPermissions).toEqual([suggestion])
  } finally {
    await app.close()
  }
})

test('a long suggestion label stays on its button, and the buttons do not overlap', async () => {
  // a Bash rule of about 300 characters: its "Always allow" label is far wider than a button
  const longRule = `sed -i 's/old/new/g' ${'src/module-name/'.repeat(20)}file.ts`
  const suggestion = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: longRule }], behavior: 'allow', destination: 'localSettings' }
  const label = `Always allow Bash(${longRule})`
  const { app, page, log } = await launchChatTab({
    turns: { run: [{ ask: { tool: 'Bash', input: BASH, suggestions: [suggestion] }, allowed: [], denied: [] }] }
  })
  try {
    await sendMessage(page, 'run')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    const buttons = page.locator(`${PERMISSION} .chat-card-actions .chat-card-btn`)
    await expect(buttons).toHaveCount(3)
    const long = page.locator(`${PERMISSION} .chat-card-actions .chat-card-btn`, { hasText: 'Always allow' })
    const boxes = await buttons.evaluateAll((els) => els.map((b) => {
      const r = b.getBoundingClientRect()
      const key = b.querySelector('.chat-card-key')!.getBoundingClientRect()
      return {
        fits: b.scrollHeight <= b.clientHeight && b.scrollWidth <= b.clientWidth,
        rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom },
        keyVisible: key.width > 0 && key.height > 0 && key.right <= r.right + 0.5 && key.left >= r.left - 0.5
      }
    }))
    expect(boxes.every((b) => b.fits)).toBe(true)
    expect(boxes.every((b) => b.keyVisible)).toBe(true)
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!.rect
        const b = boxes[j]!.rect
        const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
        expect(overlap, `buttons ${i} and ${j} overlap`).toBe(false)
      }
    }
    await expect(long).toHaveAttribute('title', label)
    expect(controlResponses(log)).toEqual([])
  } finally {
    await app.close()
  }
})

test('Deny with a message tells Claude what to do instead', async () => {
  const { app, page, log } = await launchChatTab({
    turns: { run: [{ ask: { tool: 'Bash', input: BASH }, allowed: [], denied: [{ text: 'Using grep then.' }] }] }
  })
  try {
    await sendMessage(page, 'run')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await page.locator(`${PERMISSION} .chat-card-message`).click()
    await page.keyboard.type('use grep')
    await page.keyboard.press('Enter')
    await expect.poll(() => controlResponses(log)).toEqual([expect.objectContaining({ behavior: 'deny', message: 'use grep' })])
  } finally {
    await app.close()
  }
})

test('a defaultToNo request starts on Deny and ignores 1', async () => {
  const { app, page, log } = await launchChatTab({
    turns: { run: [{ asks: [{ tool: 'Bash', input: BASH, defaultToNo: true }] }] }
  })
  try {
    await sendMessage(page, 'run')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await expect.poll(() => page.evaluate(() => document.activeElement?.textContent ?? '')).toContain('Deny')
    // 1 is no shortcut here: the Enter that follows answers Deny, the only answer sent
    await page.keyboard.press('1')
    await page.keyboard.press('Enter')
    await expect.poll(() => controlResponses(log).map((r) => r.behavior)).toEqual(['deny'])
  } finally {
    await app.close()
  }
})

test('approve a plan and accept edits', async () => {
  const { app, page, log } = await launchChatTab({
    turns: { plan: [{ ask: { tool: 'ExitPlanMode', input: { plan: '1. Read the code' } }, allowed: [{ text: 'Approved.' }], denied: [] }] }
  })
  try {
    await sendMessage(page, 'plan')
    await expect(page.locator(PLAN)).toContainText('Read the code')
    await page.locator(PLAN).getByRole('button', { name: 'Approve and accept edits' }).click()
    await expect.poll(() => controlResponses(log).map((r) => r.updatedPermissions)).toEqual([[{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]])
  } finally {
    await app.close()
  }
})

test('a stray Enter in the composer never answers a card', async () => {
  const { app, page, log, config } = await launchChatTab({
    turns: { go: [{ gate: 'release' }, { ask: { tool: 'Bash', input: BASH }, allowed: [], denied: [] }] }
  })
  try {
    // the draft is typed while the turn is held; the test releases it after the draft is there, so the card comes with the draft in it
    await sendMessage(page, 'go')
    await page.keyboard.type('hello')
    writeFileSync(join(config, 'release'), '')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect.poll(() => userMessages(log)).toContain('hello')
    expect(controlResponses(log)).toEqual([])
    await expect(page.locator(PULSE)).toHaveCount(1)
    await page.locator(CHAT_INPUT).focus()
    await page.keyboard.press('Tab')
    await expect.poll(() => focusedCard(page)).toBe(0)
  } finally {
    await app.close()
  }
})

test('two asks wait in order', async () => {
  const { app, page, log } = await launchChatTab({
    turns: {
      two: [{ asks: [{ tool: 'Bash', input: { command: 'ls' } }, { tool: 'Bash', input: { command: 'pwd' } }] }]
    }
  })
  try {
    await sendMessage(page, 'two')
    // the second waits folded under the first
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await expect(page.locator('.chat-host:visible .chat-card-waiting')).toHaveText('1 more question waiting')
    await expect.poll(() => focusedCard(page)).toBe(0)
    await page.keyboard.press('Enter')
    await expect(page.locator(ANSWERED)).toHaveCount(1)
    // the turn still waits for the second card: the working line says so, and the composer pulses
    await expect(page.locator('.chat-host:visible .chat-verb')).toHaveText('Waiting for you')
    await expect(page.locator(PULSE)).toHaveCount(1)
    // answering the first brings the second up, and it takes the keyboard
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await expect(page.locator('.chat-host:visible .chat-card-waiting')).toHaveCount(0)
    await expect.poll(() => focusedCard(page)).toBe(1)
    await page.keyboard.press('Escape')
    await expect.poll(() => controlResponses(log).map((r) => r.behavior)).toEqual(['allow', 'deny'])
  } finally {
    await app.close()
  }
})

test('an answered card is one line', async () => {
  const { app, page } = await launchChatTab({
    turns: { run: [{ ask: { tool: 'Bash', input: BASH }, allowed: [{ text: 'Listed.' }], denied: [] }] }
  })
  try {
    await sendMessage(page, 'run')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await page.locator(PERMISSION).getByRole('button', { name: 'Allow once' }).click()
    await expect(page.locator(ANSWERED)).toHaveText('Allowed: run a command')
    await expect(page.locator(`${ANSWERED} button`)).toHaveCount(0)
    const box = await page.locator(ANSWERED).boundingBox()
    expect(box!.height).toBeLessThan(40)
  } finally {
    await app.close()
  }
})

test('a link in a plan opens in the browser when it is web; a file link does nothing', async () => {
  // a file link is not a link: Markdown drops its address, so it is text
  const plan = '1. Read [the docs](https://example.com/docs) and [the notes](file:///C:/notes.md)'
  const { app, page } = await launchChatTab({
    turns: { plan: [{ ask: { tool: 'ExitPlanMode', input: { plan } }, allowed: [], denied: [] }] }
  })
  try {
    await stubExternal(app)
    await sendMessage(page, 'plan')
    await expect(page.locator(PLAN)).toContainText('the notes')
    await expect(page.locator(`${PLAN} a`)).toHaveCount(1)
    await page.locator(`${PLAN} a`, { hasText: 'the docs' }).click()
    await expect.poll(() => externalCalls(app)).toEqual(['https://example.com/docs'])
  } finally {
    await app.close()
  }
})

test("a code block in a plan copies with its Copy button, as in a message", async () => {
  const plan = ['1. Run the tests:', '', '```', 'npm test', '```'].join('\n')
  const { app, page } = await launchChatTab({
    turns: { plan: [{ ask: { tool: 'ExitPlanMode', input: { plan } }, allowed: [], denied: [] }] }
  })
  try {
    await sendMessage(page, 'plan')
    await page.locator(`${PLAN} .chat-copy`).click()
    await expect(page.locator(`${PLAN} .chat-copy`)).toHaveText('Copied')
  } finally {
    await app.close()
  }
})

test('the tab-switch chord on a focused card answers nothing', async () => {
  const { app, page, log } = await launchChatTab({
    turns: { run: [{ ask: { tool: 'Bash', input: BASH, suggestions: [SUGGESTION] }, allowed: [], denied: [] }] }
  })
  try {
    await sendMessage(page, 'run')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    // the chord would pick suggestion 2 (allow for the session); it must not
    await page.keyboard.press(TAB_CHORD)
    await page.keyboard.press('Escape')
    await expect.poll(() => controlResponses(log).map((r) => r.behavior)).toEqual(['deny'])
  } finally {
    await app.close()
  }
})

test('a repeated digit does not answer a card a second time', async () => {
  const { app, page, log } = await launchChatTab({
    turns: { run: [{ ask: { tool: 'Bash', input: BASH, suggestions: [SUGGESTION] }, allowed: [], denied: [] }] }
  })
  try {
    await sendMessage(page, 'run')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    // a held key repeats: the repeat of 2 is not a second press of it
    await page.evaluate(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: '2', repeat: true, bubbles: true })))
    await page.keyboard.press('Escape')
    await expect.poll(() => controlResponses(log).map((r) => r.behavior)).toEqual(['deny'])
  } finally {
    await app.close()
  }
})

test('a key pressed outside the card is not the card\'s', async () => {
  const { app, page, log } = await launchChatTab({
    turns: { run: [{ ask: { tool: 'Bash', input: BASH }, allowed: [], denied: [] }] }
  })
  try {
    await sendMessage(page, 'run')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await page.locator(CHAT_INPUT).click()
    await page.keyboard.type('1')
    await expect(page.locator(CHAT_INPUT)).toHaveValue('1')
    expect(controlResponses(log)).toEqual([])
  } finally {
    await app.close()
  }
})

test('an Enter that ends an IME composition in the deny box sends nothing', async () => {
  const { app, page, log } = await launchChatTab({
    turns: { run: [{ ask: { tool: 'Bash', input: BASH }, allowed: [], denied: [{ text: 'Not run.' }] }] }
  })
  try {
    await sendMessage(page, 'run')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    const box = page.locator(`${PERMISSION} .chat-card-message`)
    await box.click()
    await box.evaluate((el) => {
      ;(el as HTMLInputElement).value = 'use grep'
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
    })
    // the composition's Enter was not an answer: the next answer is the plain Esc, with no message
    await page.keyboard.press('Escape')
    await expect.poll(() => controlResponses(log).map((r) => r.message)).toEqual(['The user denied this.'])
  } finally {
    await app.close()
  }
})

test('a card that came while its tab was away has the keyboard when you come back', async () => {
  const { app, page, log, config, work } = await launchChatTab({
    turns: { run: [{ gate: 'release' }, { ask: { tool: 'Bash', input: BASH }, allowed: [], denied: [] }] }
  })
  try {
    await sendMessage(page, 'run')
    const tabId = await page.evaluate(() => window.__ct!.activeTabId())
    if (tabId === null) throw new Error('the chat tab has no id')
    await openTabInFront(page, 'shell', work)
    // the card comes while this tab is hidden
    writeFileSync(join(config, 'release'), '')
    await expect.poll(() => page.evaluate(async (id) => {
      const s = await window.ct.chatSnapshot(id)
      return s?.items.some((item) => item.kind === 'card') ?? false
    }, tabId)).toBe(true)
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await expect.poll(() => focusedCard(page)).toBe(0)
    await page.keyboard.press('Enter')
    await expect.poll(() => controlResponses(log).map((r) => r.behavior)).toEqual(['allow'])
  } finally {
    await app.close()
  }
})

test('a plan card is at most half the height of the conversation', async () => {
  const plan = Array.from({ length: 300 }, (_, i) => `${i + 1}. Step ${i + 1} of the plan`).join('\n')
  const { app, page } = await launchChatTab({
    turns: { plan: [{ ask: { tool: 'ExitPlanMode', input: { plan } }, allowed: [], denied: [] }] }
  })
  try {
    await sendMessage(page, 'plan')
    await expect(page.locator(PLAN)).toBeVisible()
    const half = await page.locator('.chat-host:visible .chat-scroll').evaluate((el) => el.clientHeight / 2)
    const box = await page.locator(`${PLAN} .chat-card-plan-text`).boundingBox()
    expect(box!.height).toBeLessThanOrEqual(half + 1)
  } finally {
    await app.close()
  }
})

test('a typed answer clears the picks in place: the own-answer box keeps its focus and its text', async () => {
  const { app, page, log } = await launchChatTab({
    turns: { pick: [{ ask: { tool: 'AskUserQuestion', input: COLORS }, allowed: [{ text: 'Typed.' }], denied: [] }] }
  })
  try {
    await sendMessage(page, 'pick')
    await expect(page.locator(QUESTION)).toHaveCount(1)
    await page.keyboard.press('1')
    await expect(page.locator(`${QUESTION} .chat-card-option.picked`)).toHaveCount(1)
    const own = page.locator(`${QUESTION} .chat-card-own`)
    await own.click()
    await page.keyboard.type('Violet')
    await expect(page.locator(`${QUESTION} .chat-card-option.picked`)).toHaveCount(0)
    await expect(own).toBeFocused()
    await expect(own).toHaveValue('Violet')
    await page.keyboard.press('Enter')
    await expect.poll(() => answersSent(log)).toEqual([{ [COLOR]: 'Violet' }])
  } finally {
    await app.close()
  }
})

test('Enter moves to the next question, Skip leaves one unanswered, and Submit sends every answer', async () => {
  const size = { question: 'Which size?', header: 'Size', multiSelect: false, options: [{ label: 'S', description: '' }, { label: 'M', description: '' }] }
  const { app, page, log } = await launchChatTab({
    turns: { pick: [{ ask: { tool: 'AskUserQuestion', input: { questions: [COLORS.questions[0], size] } }, allowed: [{ text: 'Done.' }], denied: [] }] }
  })
  try {
    await sendMessage(page, 'pick')
    await expect(page.locator(`${QUESTION} .chat-card-tab`)).toHaveCount(2)
    await page.keyboard.press('2')
    await page.keyboard.press('Enter')
    await expect(page.locator(`${QUESTION} .chat-card-question-text`)).toHaveText('Which size?')
    await page.locator(`${QUESTION} .chat-card-btn`, { hasText: 'Skip' }).click()
    await expect.poll(() => answersSent(log)).toEqual([{ [COLOR]: 'Blue', [size.question]: '' }])
  } finally {
    await app.close()
  }
})

test('three open cards: the second waits folded, and the pill counts the other one', async () => {
  const { app, page } = await launchChatTab({
    turns: { three: [{ asks: [{ tool: 'Bash', input: { command: 'ls' } }, { tool: 'Bash', input: { command: 'pwd' } }, { tool: 'Bash', input: { command: 'whoami' } }] }] }
  })
  try {
    await sendMessage(page, 'three')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await expect(page.locator('.chat-host:visible .chat-card-waiting')).toHaveText('2 more questions waiting')
  } finally {
    await app.close()
  }
})

test('Tab from the attach button does not jump to the card', async () => {
  const { app, page } = await launchChatTab({
    turns: { run: [{ ask: { tool: 'Bash', input: BASH }, allowed: [], denied: [] }] }
  })
  try {
    await sendMessage(page, 'run')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await page.locator('.chat-host:visible .chat-tool').first().focus()
    await page.keyboard.press('Tab')
    await expect.poll(() => focusedCard(page)).toBe(-1)
  } finally {
    await app.close()
  }
})

test('a path in an edit card opens its change in the Changes panel', async () => {
  const { app, page } = await launchChatTab({
    turns: { write: [{ ask: { tool: 'Write', input: { file_path: 'notes.md', content: 'one\ntwo\n' } }, allowed: [], denied: [] }] }
  })
  try {
    await sendMessage(page, 'write')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await expect(page.locator(`${PERMISSION} .chat-card-diff-view`)).toBeVisible()
    await page.locator(`${PERMISSION} .chat-card-path`).click()
    await expect(page.locator('.tab-changes-toggle')).toHaveClass(/active/)
  } finally {
    await app.close()
  }
})

test('a refused answer leaves the card live: the next Enter is sent', async () => {
  const { app, page, log } = await launchChatTab({
    turns: { run: [{ ask: { tool: 'Bash', input: BASH }, allowed: [], denied: [] }] }
  })
  try {
    // main refuses every answer, as it does for a card gone stale, and counts the refusals
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as { refused?: number }
      g.refused = 0
      ipcMain.removeHandler('chat:answer')
      ipcMain.handle('chat:answer', () => {
        g.refused = (g.refused ?? 0) + 1
        return false
      })
    })
    await sendMessage(page, 'run')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect.poll(() => app.evaluate(() => (globalThis as { refused?: number }).refused)).toBe(1)
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect.poll(() => app.evaluate(() => (globalThis as { refused?: number }).refused)).toBe(2)
    expect(controlResponses(log)).toEqual([])
  } finally {
    await app.close()
  }
})

test('a card that comes while Find has the focus does not take it: Enter walks Find and answers nothing', async () => {
  const { app, page, log, config } = await launchChatTab({
    turns: { go: [{ gate: 'release' }, { ask: { tool: 'Bash', input: BASH }, allowed: [], denied: [] }] }
  })
  try {
    await sendMessage(page, 'go')
    await page.keyboard.press(KEYS.find)
    const search = page.locator('#search input')
    await search.fill('go')
    writeFileSync(join(config, 'release'), '')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await expect(search).toBeFocused()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    expect(controlResponses(log)).toEqual([])
    await expect(search).toBeFocused()
  } finally {
    await app.close()
  }
})

test('a card that comes while the Note has the focus takes no digit: the digit is typed into the note', async () => {
  const { app, page, log, config } = await launchChatTab({
    turns: { go: [{ gate: 'release' }, { ask: { tool: 'Bash', input: BASH }, allowed: [], denied: [] }] }
  })
  try {
    await sendMessage(page, 'go')
    await page.keyboard.press(KEYS.note)
    const text = page.locator('#note .note-text')
    await expect(text).toBeFocused()
    writeFileSync(join(config, 'release'), '')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await page.keyboard.type('1')
    await expect(text).toHaveValue('1')
    expect(controlResponses(log)).toEqual([])
  } finally {
    await app.close()
  }
})

test("a card that waits in a tab takes the keyboard when the tab comes back by a switch made from another chat's field", async () => {
  const { app, page, log, config, work } = await launchChatTab({
    turns: { run: [{ gate: 'release' }, { ask: { tool: 'Bash', input: BASH }, allowed: [], denied: [] }] }
  })
  try {
    await sendMessage(page, 'run')
    const tabId = await page.evaluate(() => window.__ct!.activeTabId())
    if (tabId === null) throw new Error('the chat tab has no id')
    // a second chat in front, with a draft in its composer; the first chat's card comes while it is hidden
    await openTabInFront(page, 'claude', work)
    await chatReady(page)
    await page.locator(CHAT_INPUT).click()
    await page.keyboard.type('half a thought')
    writeFileSync(join(config, 'release'), '')
    await expect.poll(() => page.evaluate(async (id) => (await window.ct.chatSnapshot(id))?.items.some((item) => item.kind === 'card') ?? false, tabId)).toBe(true)
    // the switch back is made from the other chat's field: that field is left behind, and the card has the keyboard
    await page.evaluate((id) => window.ct.activateTab(id), tabId)
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await expect.poll(() => focusedCard(page)).toBe(0)
    await page.keyboard.press('Enter')
    await expect.poll(() => controlResponses(log).map((r) => r.behavior)).toEqual(['allow'])
  } finally {
    await app.close()
  }
})

test('a held Space in a card text box types its spaces: only the buttons and options take no repeat', async () => {
  const { app, page, log, config } = await launchChatTab({
    turns: { go: [{ gate: 'release' }, { ask: { tool: 'Bash', input: BASH }, allowed: [], denied: [] }] }
  })
  try {
    await sendMessage(page, 'go')
    writeFileSync(join(config, 'release'), '')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    const box = page.locator('.chat-host:visible .chat-card-message')
    await box.click()
    await page.keyboard.type('a')
    await page.keyboard.down(' ')
    await page.keyboard.down(' ')
    await page.keyboard.up(' ')
    await page.keyboard.type('b')
    await expect(box).toHaveValue('a  b')
    expect(controlResponses(log)).toEqual([])
  } finally {
    await app.close()
  }
})

test('a held Enter does not click a card button: the repeated key is no answer', async () => {
  const { app, page, log, config } = await launchChatTab({
    turns: { go: [{ gate: 'release' }, { ask: { tool: 'Bash', input: BASH }, allowed: [], denied: [] }] }
  })
  try {
    // the first Enter sends the draft from the composer; the key is still held when the card takes the focus, so its repeats come to the card
    await sendMessage(page, 'go')
    await page.keyboard.type('hello')
    await page.keyboard.down('Enter')
    await expect.poll(() => userMessages(log)).toContain('hello')
    writeFileSync(join(config, 'release'), '')
    await expect(page.locator(PERMISSION)).toHaveCount(1)
    await page.keyboard.down('Enter')
    await page.keyboard.up('Enter')
    await page.waitForTimeout(300)
    expect(controlResponses(log)).toEqual([])
    await expect(page.locator(PERMISSION)).toHaveCount(1)
  } finally {
    await app.close()
  }
})
