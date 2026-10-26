import { expect, test, type Page } from '@playwright/test'
import { WIN } from '../fixtures/platform'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchClaudeTab } from './helpers'

const OFF = { sound: false, flash: false, tab: true }
// the mark is what these tests check; keep the desktop quiet while they run
const QUIET = { ...FAKE_CLAUDE_SETTINGS, notifications: { permission: OFF, question: OFF, done: OFF, bell: OFF } }
const ESC = '\x1b'
const RULE = '─'.repeat(40)
const DIM = (text: string): string => `${ESC}[2m${text}${ESC}[22m`
/** Claude Code's colours for its pill: white on dark grey */
const PILL = (text: string): string => `${ESC}[38;2;255;255;255m${ESC}[48;2;55;55;55m${text}${ESC}[39;49m`

/**
 * A command line for the tab's shell that clears the screen and prints the lines, as Claude Code draws its screen. The
 * shell echoes the command itself; non-ASCII characters and escapes are spelled out in it, so the echo never looks like
 * what it prints. `marker` is printed split by an escape: found in the buffer, it shows the output arrived.
 */
function printScreen(lines: string[], marker: string): string {
  const text = `${ESC}[H${ESC}[2J${lines.join('\n')}\n${marker.slice(0, 1)}${ESC}[0m${marker.slice(1)}\n`
  if (WIN) {
    const ps = [...text].map((ch) => {
      const code = ch.codePointAt(0)!
      if (ch === '\n') return '`n'
      if (code < 32 || code > 126) return `$([char]0x${code.toString(16)})`
      return ch === '"' || ch === '`' || ch === '$' ? `\`${ch}` : ch
    }).join('')
    return `Write-Host -NoNewline "${ps}"\r`
  }
  const sh = [...Buffer.from(text, 'utf8')].map((b) => {
    const ch = String.fromCharCode(b)
    if (b < 32 || b > 126) return `\\${b.toString(8).padStart(3, '0')}`
    return ch === '%' ? '%%' : ch === '\\' ? '\\\\' : ch === "'" ? "'\\''" : ch
  }).join('')
  return `printf '${sh}'\r`
}

/** prints the screen into the tab and waits until it is there */
async function show(page: Page, tabId: string, lines: string[], marker: string): Promise<void> {
  await page.evaluate(([id, data]) => window.ct.writePty(id, data), [tabId, printScreen(lines, marker)] as const)
  await expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).toContain(marker)
}

async function activate(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => window.ct.activateTab(id), tabId)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tabId)
}

/** the bottom of Claude Code's screen: its prompt between two rules */
const promptBox = (prompt: string): string[] => [RULE, `❯ ${prompt}`, RULE, '  Opus 5.5']

test('Mark as unread makes a background tab pulse, and the open tab once it is left; opening it clears the mark', async () => {
  const { app, page, tabId, work } = await launchClaudeTab(QUIET)
  const claudeTab = page.locator(`[data-tab-id="${tabId}"]`)
  await claudeTab.click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Mark as unread' }).click()
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  const shell = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work))!.id
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, shell)
  await expect(claudeTab).toHaveClass(/\battention\b/)
  await activate(page, tabId)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)

  await activate(page, shell)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  await claudeTab.click({ button: 'right' })
  await page.locator('.menu-item', { hasText: 'Mark as unread' }).click()
  await expect(claudeTab).toHaveClass(/\battention\b/)
  await app.close()
})

test('a Claude tab left with an unsent prompt or a reply scrolled up pulses, unless autoUnread is off', async () => {
  const { app, page, tabId, work } = await launchClaudeTab(QUIET)
  const claudeTab = page.locator(`[data-tab-id="${tabId}"]`)
  await expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).toMatch(/fake-claude/)
  const shell = (await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), work))!.id
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, shell)

  // an empty prompt shows its placeholder dim: nothing is left
  await activate(page, tabId)
  await show(page, tabId, promptBox(DIM('Try "fix lint errors"')), 'step1')
  await activate(page, shell)
  await page.waitForTimeout(300)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)

  await activate(page, tabId)
  await show(page, tabId, promptBox('half a question'), 'step2')
  await activate(page, shell)
  await expect(claudeTab).toHaveClass(/\battention\b/)

  // the pill's words quoted in the conversation have no background: not the pill
  await activate(page, tabId)
  await show(page, tabId, ['● it shows Jump to bottom (ctrl+End) ↓ on screen', ...promptBox(DIM('Try "x"'))], 'step3')
  await activate(page, shell)
  await page.waitForTimeout(300)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)

  await activate(page, tabId)
  await show(page, tabId, [`● a long reply ${PILL(' Jump to bottom (ctrl+End) ↓ ')} goes on`, ...promptBox(DIM('Try "x"'))], 'step4')
  await activate(page, shell)
  await expect(claudeTab).toHaveClass(/\battention\b/)

  await activate(page, tabId)
  expect(await page.evaluate(() => window.ct.setSetting('notifications.autoUnread', false))).toEqual({ ok: true })
  await activate(page, shell)
  await page.waitForTimeout(300)
  await expect(claudeTab).not.toHaveClass(/\battention\b/)
  await app.close()
})
