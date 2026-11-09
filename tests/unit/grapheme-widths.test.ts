import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import { useGraphemeWidths } from '../../src/shared/grapheme-widths'

function terminal(): Terminal {
  const t = new Terminal({ cols: 40, rows: 4, allowProposedApi: true })
  useGraphemeWidths(t)
  return t
}

const write = (t: Terminal, data: string): Promise<void> => new Promise((resolve) => t.write(data, resolve))

/** the cells a text takes from the start of a line */
async function cells(text: string): Promise<number> {
  const t = terminal()
  await write(t, text)
  return t.buffer.active.cursorX
}

const lineOf = (t: Terminal, y: number): string => t.buffer.active.getLine(y)!.translateToString(true)

describe('grapheme widths', () => {
  it('an emoji made so by U+FE0F, a keycap, a ZWJ sequence, a skin tone and a flag take two cells, as ConPTY and Claude Code count them', async () => {
    for (const g of ['⚠️', '✔️', '✳️', '1️⃣', '#️⃣', '👨‍💻', '🏳️‍🌈', '👍🏽', '👩🏽‍💻', '🇷🇺', '✅️']) {
      expect([g, await cells(g)]).toEqual([g, 2])
    }
  })

  it('other characters keep their Unicode 11 widths', async () => {
    const widths: [string, number][] = [['a', 1], ['1', 1], ['⚠', 1], ['⏺', 1], ['⎿', 1], ['✻', 1], ['❯', 1], ['✅', 2], ['🔄', 2], ['中', 2], ['й', 1], ['é', 1], ['a️', 1]]
    for (const [g, w] of widths) expect([g, await cells(g)]).toEqual([g, w])
  })

  it('graphemes side by side stay apart: two flags, two emoji, an emoji after a ZWJ sequence', async () => {
    expect(await cells('🇷🇺🇺🇦')).toBe(4)
    expect(await cells('⚠️⚠️')).toBe(4)
    expect(await cells('👨‍💻✅')).toBe(4)
  })

  it('a change written in place after such an emoji lands on its character', async () => {
    const t = terminal()
    await write(t, '⚠️ abcdef\r\x1b[6CD')
    await write(t, '\r\n1️⃣ one\r\x1b[3CONE')
    expect([lineOf(t, 0), lineOf(t, 1)]).toEqual(['⚠️ abcDef', '1️⃣ ONE'])
  })
})
