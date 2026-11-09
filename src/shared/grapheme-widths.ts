import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { IUnicodeVersionProvider, Terminal } from '@xterm/xterm'

/*
 * How many cells a character takes, counted as the ConPTY bundled with node-pty (Windows Terminal's) and Claude Code
 * count them: Unicode 11 widths, with the characters of one grapheme in one cell. An emoji made so by U+FE0F (⚠️) and a
 * keycap (1️⃣) take two cells; a ZWJ sequence (👨‍💻), a skin tone (👍🏽) and a flag (🇷🇺) take the cells of one emoji.
 * ConPTY sends a program's screen as changes to the cells it holds. A terminal that counts one of these otherwise puts
 * every later change on that line a cell off, and the line keeps leftovers of the text before it.
 */
export const GRAPHEME_WIDTHS = 'graphemes'

// xterm's character properties: a 24-bit kind (what the character can still join with), its width, whether it joins
// the character before
const pack = (kind: number, width: number, join: boolean): number => ((kind & 0xffffff) << 3) | ((width & 3) << 1) | (join ? 1 : 0)
const widthOf = (p: number): number => (p >> 1) & 3
const kindOf = (p: number): number => p >> 3

const OTHER = 0
/** a pictograph shown as text until U+FE0F follows (⚠) */
const PICTOGRAPH = 1
/** an emoji two cells wide */
const EMOJI = 2
/** an emoji and a ZWJ: the next pictograph joins them */
const JOINER = 3
/** a regional indicator waiting for the second of its flag */
const REGIONAL = 4
/** a digit, # or *: U+FE0F makes it a keycap */
const KEYCAP = 5

/** not a pictograph */
const NONE = 0
/** a pictograph shown as text by default */
const TEXT = 1
/** a pictograph shown as an emoji by default: two cells, also when it is newer than Unicode 11's widths */
const WIDE = 2

const pictographs = new Map<number, number>()
function pictograph(cp: number): number {
  // Extended_Pictographic lies in these ranges only: letters, digits and CJK answer at once
  if (!(cp === 0xa9 || cp === 0xae || (cp >= 0x203c && cp <= 0x3299) || (cp >= 0x1f000 && cp <= 0x1fffd))) return NONE
  let p = pictographs.get(cp)
  if (p === undefined) {
    const s = String.fromCodePoint(cp)
    p = !/\p{Extended_Pictographic}/u.test(s) ? NONE : /\p{Emoji_Presentation}/u.test(s) ? WIDE : TEXT
    pictographs.set(cp, p)
  }
  return p
}

const isRegional = (cp: number): boolean => cp >= 0x1f1e6 && cp <= 0x1f1ff
const isSkinTone = (cp: number): boolean => cp >= 0x1f3fb && cp <= 0x1f3ff
const isKeycapBase = (cp: number): boolean => (cp >= 0x30 && cp <= 0x39) || cp === 0x23 || cp === 0x2a

/** Unicode 11 widths (`base`), with the graphemes above joined */
export function graphemeWidths(base: IUnicodeVersionProvider): IUnicodeVersionProvider {
  return {
    version: GRAPHEME_WIDTHS,
    wcwidth: (cp) => base.wcwidth(cp),
    charProperties(cp, preceding) {
      if (preceding !== 0) {
        const kind = kindOf(preceding)
        const width = widthOf(preceding)
        const emoji = kind === PICTOGRAPH || kind === EMOJI
        if (cp === 0xfe0f && (emoji || kind === KEYCAP)) return pack(EMOJI, 2, true)
        if (cp === 0x200d && emoji) return pack(JOINER, width, true)
        if ((kind === JOINER && pictograph(cp) !== NONE) || (isSkinTone(cp) && emoji)) return pack(EMOJI, Math.max(width, 2), true)
        if (kind === REGIONAL && isRegional(cp)) return pack(EMOJI, 2, true)
      }
      const p = base.charProperties(cp, preceding)
      // a combining mark joins as in Unicode 11
      if (p & 1) return p
      const pict = pictograph(cp)
      if (pict === WIDE) return pack(EMOJI, 2, false)
      const width = widthOf(p)
      const kind = isKeycapBase(cp) ? KEYCAP : isRegional(cp) ? REGIONAL : pict === TEXT ? (width === 2 ? EMOJI : PICTOGRAPH) : OTHER
      return pack(kind, width, false)
    }
  }
}

/** the part of a terminal (xterm or xterm headless) that counts cells */
interface UnicodeHost {
  unicode: { register(provider: IUnicodeVersionProvider): void; activeVersion: string }
}

/** Makes a terminal count cells as ConPTY and Claude Code do */
export function useGraphemeWidths(term: UnicodeHost): void {
  const registered: IUnicodeVersionProvider[] = []
  // the Unicode 11 addon only registers its provider: it is taken as the base
  new Unicode11Addon().activate({ unicode: { register: (p: IUnicodeVersionProvider) => registered.push(p) } } as unknown as Terminal)
  const v11 = registered[0]
  if (!v11) throw new Error('the Unicode 11 addon registered no provider')
  term.unicode.register(graphemeWidths(v11))
  term.unicode.activeVersion = GRAPHEME_WIDTHS
}
