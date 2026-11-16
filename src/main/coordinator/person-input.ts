import { COORD_WORDS_MAX } from '../../shared/coordinator'

/** the submits kept per tab: the latest this many */
export const SUBMITS_KEPT = 64
/** the readings one draft may have at most; past that the draft is unknown */
export const READINGS_MAX = 8

/** one Enter (or composer Send) the window gave a tab: what the prompt held, in each reading of the keys, or null when a key the record does not follow changed it */
export interface Submit {
  at: number
  texts: readonly string[] | null
  /** the person wrote something: every reading holds text, or the draft grew past the longest message that can be relayed */
  wrote: boolean
}

/** a prompt's draft: its readings (null when unknown), whether a bracketed paste is open, and whether it grew past the longest message */
interface Draft {
  readings: string[] | null
  pasting: boolean
  overflow: boolean
}

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/** the length of the escape sequence that starts at data[i], an ESC: a CSI or SS3 sequence, or an ESC with one more character */
function escapeLength(data: string, i: number): number {
  if (i + 1 >= data.length) return 1
  const next = data[i + 1]!
  if (next === '[') {
    let j = i + 2
    while (j < data.length && /[0-9;?<>=]/.test(data[j]!)) j++
    // a CSI with no final byte is not read further: its parameters are not keys
    if (j < data.length && data[j]! >= '@' && data[j]! <= '~') return j + 1 - i
    return 2
  }
  if (next === 'O') return Math.min(3, data.length - i)
  return 2
}

/** a text without its last character; a surrogate pair is one character */
function withoutLast(text: string): string {
  if (text.length >= 2 && /[\udc00-\udfff]/.test(text[text.length - 1]!) && /[\ud800-\udbff]/.test(text[text.length - 2]!)) return text.slice(0, -2)
  return text.slice(0, -1)
}

/**
 * the keys the window sent into each tab, from this device or a paired one, followed like a line editor would: what the prompt held
 * at each Enter, and what the chat composer sent whole. The record of a tab is its submits, the latest ones, oldest first
 */
export class PersonInput {
  private readonly drafts = new Map<string, Draft>()
  private readonly submitted = new Map<string, Submit[]>()

  /** keys or a paste the window sent into the tab at `at`: `writeInput`'s data, from this device or a paired one */
  keys(tabId: string, data: string, at: number): void {
    const d = this.draftOf(tabId)
    let i = 0
    while (i < data.length) {
      if (d.pasting) {
        const end = data.indexOf(PASTE_END, i)
        const stop = end === -1 ? data.length : end
        this.appendText(d, data.slice(i, stop).replace(/\r\n?/g, '\n'))
        i = end === -1 ? data.length : end + PASTE_END.length
        if (end !== -1) d.pasting = false
        this.settle(d)
        continue
      }
      if (data.startsWith(PASTE_START, i)) {
        d.pasting = true
        i += PASTE_START.length
        continue
      }
      const c = data[i]!
      const code = c.charCodeAt(0)
      if (c === '\x1b') {
        const len = escapeLength(data, i)
        const seq = data.slice(i, i + len)
        if (seq === '\x1b\r') this.appendText(d, '\n')
        else if (seq === '\x1b') this.abandon(d)
        // Shift+Tab does nothing; any other escape sequence is a key the record does not follow
        else if (seq !== '\x1b[Z') d.readings = null
        i += len
      } else if (c === '\r') {
        this.enter(tabId, d, at)
        i++
      } else if (c === '\n') {
        this.appendText(d, '\n')
        i++
      } else if (c === '\x7f' || c === '\b') {
        if (d.readings !== null) d.readings = d.readings.map((t) => (t === '' ? t : withoutLast(t)))
        i++
      } else if (c === '\x03') {
        this.abandon(d)
        i++
      } else if (code < 0x20 || (code >= 0x80 && code <= 0x9f)) {
        d.readings = null
        i++
      } else {
        const ch = String.fromCodePoint(data.codePointAt(i)!)
        this.typeChar(d, ch)
        i += ch.length
      }
      this.settle(d)
    }
  }

  /** a whole message the window sent at once: the chat composer's Send. The draft is left alone */
  sent(tabId: string, text: string, at: number): void {
    if (text.trim() === '') return
    const texts = text.length > COORD_WORDS_MAX ? null : [text]
    this.push(tabId, { at, texts, wrote: true })
  }

  /** the tab's submits, oldest first */
  submits(tabId: string): readonly Submit[] {
    return this.submitted.get(tabId) ?? []
  }

  drop(tabId: string): void {
    this.drafts.delete(tabId)
    this.submitted.delete(tabId)
  }

  private draftOf(tabId: string): Draft {
    let d = this.drafts.get(tabId)
    if (d === undefined) {
      d = { readings: [''], pasting: false, overflow: false }
      this.drafts.set(tabId, d)
    }
    return d
  }

  /** text typed or pasted, appended to every reading */
  private appendText(d: Draft, text: string): void {
    if (d.readings !== null) d.readings = d.readings.map((t) => t + text)
  }

  /** a printable character: a digit 1-9 may answer a menu, so an empty reading stays too */
  private typeChar(d: Draft, ch: string): void {
    if (d.readings === null) return
    const digit = /^[1-9]$/.test(ch)
    const next: string[] = []
    for (const t of d.readings) {
      next.push(t + ch)
      if (digit && t === '') next.push(t)
    }
    d.readings = next
  }

  /** Esc or Ctrl+C: nothing on an empty prompt, else the prompt is unknown */
  private abandon(d: Draft): void {
    if (d.readings !== null && d.readings.every((t) => t === '')) return
    d.readings = null
  }

  /** the readings merged, and the draft unknown past READINGS_MAX readings or a reading longer than the longest message */
  private settle(d: Draft): void {
    if (d.readings === null) return
    const unique = [...new Set(d.readings)]
    if (unique.length > READINGS_MAX) {
      d.readings = null
      return
    }
    d.readings = unique
    if (unique.some((t) => t.length > COORD_WORDS_MAX)) {
      d.readings = null
      d.overflow = true
    }
  }

  /** an Enter: a backslash at the end of the longest reading is a line break (Claude Code's own), else the prompt is submitted */
  private enter(tabId: string, d: Draft, at: number): void {
    const r = d.readings
    if (r !== null) {
      const longest = r.reduce((a, b) => (b.length > a.length ? b : a))
      if (longest.endsWith('\\')) {
        d.readings = r.map((t) => (t.endsWith('\\') ? `${t.slice(0, -1)}\n` : t))
        return
      }
    }
    if (r === null || !r.every((t) => t.trim() === '')) {
      this.push(tabId, { at, texts: r, wrote: d.overflow || (r !== null && r.every((t) => t.trim() !== '')) })
    }
    d.readings = ['']
    d.pasting = false
    d.overflow = false
  }

  private push(tabId: string, s: Submit): void {
    let list = this.submitted.get(tabId)
    if (list === undefined) {
      list = []
      this.submitted.set(tabId, list)
    }
    list.push(s)
    if (list.length > SUBMITS_KEPT) list.shift()
  }
}
