import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { spawnPty } from '../../src/main/pty-host'
import { useGraphemeWidths } from '../../src/shared/grapheme-widths'
import { WIN } from '../fixtures/platform'

const env = process.env as Record<string, string>

// a program draws a screen with emoji, then changes words in place by cursor position, as Claude Code's renderer does:
// it counts ⚠️, 1️⃣, 👨‍💻 and 🇷🇺 two cells wide, as does the console host
const PROGRAM = [
  "process.stdout.write('\\x1b[2J\\x1b[H')",
  "process.stdout.write('\\u26a0\\ufe0f abcdef\\r\\n1\\ufe0f\\u20e3 one 2\\ufe0f\\u20e3 two\\r\\n\\ud83d\\udc68\\u200d\\ud83d\\udcbb dev \\ud83c\\uddf7\\ud83c\\uddfa ok\\r\\n')",
  "setTimeout(() => { process.stdout.write('\\x1b[1;7HD\\x1b[2;4HONE\\x1b[3;4HDEV\\x1b[3;11HOK\\x1b[5;1Hdrawn'); setTimeout(() => process.exit(0), 300) }, 300)"
].join(';')

/** the first rows of what a terminal with ClaudeTerm's widths shows of the program, run in the given console host */
async function screen(bundledConpty: boolean): Promise<string[]> {
  const t = new Terminal({ cols: 40, rows: 6, allowProposedApi: true })
  useGraphemeWidths(t)
  let out = ''
  await new Promise<void>((resolve) => {
    const h = spawnPty({
      file: process.execPath, args: ['-e', PROGRAM], cwd: process.cwd(), env, cols: 40, rows: 6, bundledConpty,
      onData: (d) => { out += d; t.write(d) },
      onExit: () => resolve()
    })
    // the terminal answers what the console host asks it, as in the app
    t.onData((d) => h.write(d))
  })
  await new Promise<void>((resolve) => t.write('', resolve))
  expect(out).toContain('drawn')
  return [0, 1, 2].map((y) => t.buffer.active.getLine(y)!.translateToString(true))
}

describe.runIf(WIN)('cells of emoji through ConPTY', () => {
  it('changes a program writes in place after an emoji land on their characters, in the bundled console host', async () => {
    expect(await screen(true)).toEqual(['⚠️ abcDef', '1️⃣ ONE 2️⃣ two', '👨‍💻 DEV 🇷🇺 OK'])
  }, 30_000)

  // Windows' own console host counts graphemes by their parts (a keycap three cells, a ZWJ sequence five): only an
  // emoji made so by U+FE0F can match there
  it("and after ⚠️ in Windows' own", async () => {
    expect((await screen(false))[0]).toBe('⚠️ abcDef')
  }, 30_000)
})
