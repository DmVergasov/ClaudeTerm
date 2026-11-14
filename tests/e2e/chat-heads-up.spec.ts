import { expect, test, type Page } from '@playwright/test'
import { HEADS_UP_EVERY } from '../../src/main/chat/heads-up'
import type { FakeStep } from '../fixtures/fake-claude/install'
import { launchChatTab, sendMessage, userMessages } from './chat-helpers'

const CARD = '.chat-host:visible .chat-heads-up'

const FINDING = [
  'topic: The cleanup script runs against the production database, so it deletes real orders.',
  'tag: Heads up',
  'title: The cleanup runs on production',
  'The `.env` the script reads points at the **production** database.'
].join('\n')
const MORE = 'Set `DATABASE_URL` to a test database before you run the cleanup again.'

/** a turn of `n` tool calls, then its answer */
const work = (n: number): FakeStep[] => [
  ...Array.from({ length: n }, (_, i): FakeStep => ({ tool: { name: 'Bash', input: { command: `echo step ${i + 1}` }, result: `step ${i + 1}` } })),
  { text: 'Cleaned up.' }
]

/** the command lines the stand-in Claude Code was started with, one per process */
const starts = (log: () => Record<string, unknown>[]): string[][] => (log() as { argv?: string[] }[]).filter((e) => Array.isArray(e.argv)).map((e) => e.argv!)
/** the processes Heads up started: its questions keep no session */
const sideStarts = (log: () => Record<string, unknown>[]): string[][] => starts(log).filter((argv) => argv.includes('--no-session-persistence'))
/** a flag's value in a command line, given as `--name value` or `--name=value`; undefined when the line has no such flag */
function flagOf(argv: string[], name: string): string | undefined {
  const at = argv.findIndex((a) => a === name || a.startsWith(`${name}=`))
  if (at < 0) return undefined
  return argv[at] === name ? argv[at + 1] : argv[at]!.slice(name.length + 1)
}

const turnIdle = (page: Page, tabId: string): Promise<boolean> =>
  page.evaluate((id) => window.ct.chatSnapshot(id).then((s) => s?.state.turn === 'idle'), tabId)

test(`a Heads up card shows above the message box after the ${HEADS_UP_EVERY}th tool call; Explain more brings more, and Got it closes it`, async () => {
  const { app, page, tabId, log } = await launchChatTab({ turns: { 'clean up': work(HEADS_UP_EVERY) }, headsUp: { check: FINDING, explain: MORE } }, { headsUp: true })
  try {
    await sendMessage(page, 'clean up')
    const card = page.locator(CARD)
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card.locator('.chat-heads-up-tag')).toHaveText('Heads up')
    await expect(card.locator('.chat-heads-up-title')).toHaveText('The cleanup runs on production')
    await expect(card.locator('.chat-heads-up-text')).toHaveText('The .env the script reads points at the production database.')
    // the card sits above the message box, in the composer's column
    const cardBox = (await card.boundingBox())!
    const fieldBox = (await page.locator('.chat-host:visible .chat-field').boundingBox())!
    expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(fieldBox.y)

    // the question went to a Claude Code process of its own: on Sonnet, one turn, no tools, no settings or MCP of the user, no session kept
    const side = sideStarts(log)
    expect(side).toHaveLength(1)
    const argv = side[0]!
    expect(flagOf(argv, '--model')).toBe('sonnet')
    expect(flagOf(argv, '--max-turns')).toBe('1')
    expect(flagOf(argv, '--tools')).toBe('')
    expect(flagOf(argv, '--setting-sources')).toBe('')
    expect(argv).toContain('--strict-mcp-config')
    expect(flagOf(argv, '--session-id')).toBeUndefined()
    expect(flagOf(argv, '--resume')).toBeUndefined()
    // the chat's own conversation got the person's message only
    await expect.poll(() => turnIdle(page, tabId)).toBe(true)
    expect(userMessages(log).filter((m) => !m.startsWith('Offered already'))).toEqual(['clean up'])

    await card.getByRole('button', { name: 'Explain more' }).click()
    await expect(card.locator('.chat-heads-up-more')).toHaveText('Set DATABASE_URL to a test database before you run the cleanup again.')
    await expect(card.getByRole('button', { name: 'Explain more' })).toHaveCount(0)
    expect(sideStarts(log)).toHaveLength(2)
    expect(userMessages(log).some((m) => m.startsWith('The card said (Heads up): The cleanup runs on production'))).toBe(true)

    await card.getByRole('button', { name: 'Got it' }).click()
    await expect(card).toBeHidden()
  } finally {
    await app.close()
  }
})

test("the side question gives the person's own messages apart, so the card comes in their language", async () => {
  const { app, page, log } = await launchChatTab({ turns: { 'почисти базу': work(HEADS_UP_EVERY) }, headsUp: { check: FINDING } }, { headsUp: true })
  try {
    await sendMessage(page, 'почисти базу')
    await expect(page.locator(CARD)).toBeVisible({ timeout: 20_000 })
    const question = userMessages(log).find((m) => m.startsWith('Offered already'))
    expect(question).toContain('<person>\nпочисти базу\n</person>')
  } finally {
    await app.close()
  }
})

test('Not relevant closes the card, and a turn of fewer tool calls asks nothing', async () => {
  const { app, page, tabId, log } = await launchChatTab({ turns: { 'clean up': work(HEADS_UP_EVERY), 'look': work(HEADS_UP_EVERY - 1) }, headsUp: { check: FINDING } }, { headsUp: true })
  try {
    await sendMessage(page, 'clean up')
    const card = page.locator(CARD)
    await expect(card).toBeVisible({ timeout: 20_000 })
    await card.getByRole('button', { name: 'Not relevant' }).click()
    await expect(card).toBeHidden()
    await expect.poll(() => turnIdle(page, tabId)).toBe(true)
    await sendMessage(page, 'look')
    await expect(page.locator('.chat-host:visible')).toContainText('Cleaned up.')
    await expect.poll(() => turnIdle(page, tabId)).toBe(true)
    expect(sideStarts(log)).toHaveLength(1)
    await expect(card).toBeHidden()
  } finally {
    await app.close()
  }
})

test('Ask Claude sends your words with the card to the conversation, and the card closes', async () => {
  const { app, page, log } = await launchChatTab({ turns: { 'clean up': work(HEADS_UP_EVERY) }, headsUp: { check: FINDING } }, { headsUp: true })
  try {
    await sendMessage(page, 'clean up')
    const card = page.locator(CARD)
    await expect(card).toBeVisible({ timeout: 20_000 })
    const field = card.getByRole('textbox', { name: 'Ask Claude about this card' })
    const ask = card.getByRole('button', { name: 'Ask Claude' })
    await expect(ask).toBeDisabled()
    await field.fill('Stop and use the test database')
    await expect(ask).toBeEnabled()
    await ask.click()
    await expect(card).toBeHidden()
    await expect.poll(() => userMessages(log).find((m) => m.startsWith('Stop and use the test database'))).toBe(
      'Stop and use the test database\n\n> Heads up: The cleanup runs on production\n>\n> The `.env` the script reads points at the **production** database.'
    )
    await expect(page.locator('.chat-host:visible .chat-user', { hasText: 'Stop and use the test database' })).toHaveCount(1)
  } finally {
    await app.close()
  }
})

test("text typed in the card's field stays when Explain more brings the explanation, and Enter sends it", async () => {
  const { app, page, log } = await launchChatTab({ turns: { 'clean up': work(HEADS_UP_EVERY) }, headsUp: { check: FINDING, explain: MORE } }, { headsUp: true })
  try {
    await sendMessage(page, 'clean up')
    const card = page.locator(CARD)
    await expect(card).toBeVisible({ timeout: 20_000 })
    const field = card.getByRole('textbox', { name: 'Ask Claude about this card' })
    await expect(card.getByRole('button', { name: 'Ask Claude' })).toBeDisabled()
    await field.fill('Why production?')
    await card.getByRole('button', { name: 'Explain more' }).click()
    await expect(card.locator('.chat-heads-up-more')).toHaveText('Set DATABASE_URL to a test database before you run the cleanup again.')
    await expect(field).toHaveValue('Why production?')
    // Shift+Enter starts a new line in the field and sends nothing
    await field.press('Shift+Enter')
    await expect(card).toBeVisible()
    await expect(field).toHaveValue('Why production?\n')
    await field.press('Enter')
    await expect(card).toBeHidden()
    await expect.poll(() => userMessages(log).find((m) => m.startsWith('Why production?'))).toBe(
      'Why production?\n\n> Heads up: The cleanup runs on production\n>\n> The `.env` the script reads points at the **production** database.\n>\n> Set `DATABASE_URL` to a test database before you run the cleanup again.'
    )
  } finally {
    await app.close()
  }
})

test('the field keeps its focus and caret when the card is updated under the person typing', async () => {
  const { app, page } = await launchChatTab({ turns: { 'clean up': work(HEADS_UP_EVERY) }, headsUp: { check: FINDING, explain: MORE } }, { headsUp: true })
  try {
    await sendMessage(page, 'clean up')
    const card = page.locator(CARD)
    await expect(card).toBeVisible({ timeout: 20_000 })
    const field = card.getByRole('textbox', { name: 'Ask Claude about this card' })
    await field.focus()
    await page.keyboard.type('Why pro')
    // Explain more is pressed without moving the focus: the card is rebuilt when the explanation comes, and the field must stay put
    await card.getByRole('button', { name: 'Explain more' }).evaluate((b: HTMLElement) => b.click())
    await expect(card.locator('.chat-heads-up-more')).toBeVisible()
    await expect(field).toBeFocused()
    await page.keyboard.type('duction?')
    await expect(field).toHaveValue('Why production?')
  } finally {
    await app.close()
  }
})

test('with Heads up turned off, a long turn asks no side question and shows no card', async () => {
  const { app, page, tabId, log } = await launchChatTab({ turns: { 'clean up': work(HEADS_UP_EVERY * 2) }, headsUp: { check: FINDING } }, { headsUp: false })
  try {
    await sendMessage(page, 'clean up')
    await expect(page.locator('.chat-host:visible')).toContainText('Cleaned up.')
    await expect.poll(() => turnIdle(page, tabId)).toBe(true)
    expect(sideStarts(log)).toHaveLength(0)
    await expect(page.locator(CARD)).toBeHidden()
  } finally {
    await app.close()
  }
})
