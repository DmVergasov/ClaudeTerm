import { expect, type Page } from '@playwright/test'
import { WIN } from '../fixtures/platform'
import { bufferText } from './helpers'

// Claude Code's screen as it draws it, printed into a tab's shell by the fake claude's tests

const ESC = '\x1b'
const RULE = '─'.repeat(40)
export const DIM = (text: string): string => `${ESC}[2m${text}${ESC}[22m`
/** Claude Code's colours for its pill: white on dark grey */
export const PILL = (text: string): string => `${ESC}[38;2;255;255;255m${ESC}[48;2;55;55;55m${text}${ESC}[39;49m`

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
export async function show(page: Page, tabId: string, lines: string[], marker: string): Promise<void> {
  await page.evaluate(([id, data]) => window.ct.writePty(id, data), [tabId, printScreen(lines, marker)] as const)
  await expect.poll(() => bufferText(page, tabId), { timeout: 15_000 }).toContain(marker)
}

/** the bottom of Claude Code's screen: its prompt between two rules */
export const promptBox = (prompt: string): string[] => [RULE, `❯\u00a0${prompt}`, RULE, '  Opus 5.5']
