import { COORD_WORDS_MAX } from '../../shared/coordinator'

/** the submits kept per tab: the latest this many */
export const SUBMITS_KEPT = 64
/** the readings one draft may have at most; past that only the longest and the empty one are kept */
export const READINGS_MAX = 8

/** one Enter (or composer Send) the window gave a tab: what the prompt held in each reading of the keys, without the command lines; null when a key the record does not follow changed it, or when no reading is left */
export interface Submit {
  at: number
  texts: readonly string[] | null
  /** the person wrote something: a reading holds text, or the prompt was typed into (or pasted into) while its readings are unknown, or it grew past the longest message that can be relayed. A dialog answer the person wrote is texts null with wrote true */
  wrote: boolean
}

/** a prompt's draft: its readings (null when unknown), whether a bracketed paste is open and whether it began in a dialog, whether it grew past the longest message,
 * whether the person typed or pasted text into it since its last submit;
 * and, while a dialog shows, whether the person wrote in it, and the keys of a split marker or a CR that the next call completes */
interface Draft {
  readings: string[] | null
  pasting: boolean
  pasteDialog: boolean
  overflow: boolean
  typed: boolean
  dialogWrote: boolean
  carry: string
}

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

/** how many characters at the end of `input`, from `from` on, begin `marker` (at least `min` of them, fewer than all of it): 0 when none */
function trailingPrefix(input: string, from: number, marker: string, min: number): number {
  for (let k = Math.min(marker.length - 1, input.length - from); k >= min; k--) {
    if (input.endsWith(marker.slice(0, k))) return k
  }
  return 0
}

/** whether the text from `i` to the end of `input` is a split `marker` (at least `min` of it, fewer than all of it) */
function splitMarkerAt(input: string, i: number, marker: string, min: number): boolean {
  const rest = input.length - i
  return rest >= min && rest < marker.length && marker.startsWith(input.slice(i))
}

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

  /**
   * keys or a paste the window sent into the tab at `at`: `writeInput`'s data, from this device or a paired one, followed like a line
   * editor would. While `dialog` (a permission prompt or a question) shows in the tab, the draft is left as it is: only what the person
   * writes in the dialog is noted, as a submit with no text
   */
  keys(tabId: string, data: string, at: number, dialog = false): void {
    const d = this.draftOf(tabId)
    // a key of the draft ends the dialog's answer: an Enter in a later dialog pushes nothing for it
    if (!dialog) d.dialogWrote = false
    // a paste keeps the mode it began in: a piece of it in the other mode leaves the draft unknown
    if (d.pasting && d.pasteDialog !== dialog) {
      d.readings = null
      d.dialogWrote = true
      d.pasteDialog = dialog
    }
    const input = d.carry + data
    d.carry = ''
    let i = 0
    while (i < input.length) {
      if (d.pasting) {
        const end = input.indexOf(PASTE_END, i)
        // the end marker may be split across two calls, and a CR at the end may be the first half of a CRLF: the piece that begins either waits for the next call
        const held = end === -1 ? Math.max(trailingPrefix(input, i, PASTE_END, 1), input.endsWith('\r') ? 1 : 0) : 0
        const stop = end === -1 ? input.length - held : end
        this.pasted(d, input.slice(i, stop).replace(/\r\n?/g, '\n'), dialog)
        if (end === -1) {
          d.carry = input.slice(stop)
          break
        }
        d.pasting = false
        i = end + PASTE_END.length
        if (!dialog) this.settle(d)
        continue
      }
      if (input.startsWith(PASTE_START, i)) {
        d.pasting = true
        d.pasteDialog = dialog
        i += PASTE_START.length
        continue
      }
      // a start marker split across two calls: its beginning waits for the next call
      if (splitMarkerAt(input, i, PASTE_START, 2)) {
        d.carry = input.slice(i)
        break
      }
      if (dialog) {
        i = this.dialogKey(tabId, d, input, i, at)
        continue
      }
      const c = input[i]!
      const code = c.charCodeAt(0)
      if (c === '\x1b') {
        const len = escapeLength(input, i)
        const seq = input.slice(i, i + len)
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
        const ch = String.fromCodePoint(input.codePointAt(i)!)
        // a printable character other than a digit: a digit alone may only answer a menu
        if (!/^[0-9]$/.test(ch)) d.typed = true
        this.typeChar(d, ch)
        i += ch.length
      }
      this.settle(d)
    }
  }

  /**
   * one key while a dialog shows, from `i`: an Enter after the person wrote in the dialog is a submit with no text; a printable character
   * other than a digit says the person wrote; every other key does nothing. Returns the index after the key
   */
  private dialogKey(tabId: string, d: Draft, input: string, i: number, at: number): number {
    const c = input[i]!
    if (c === '\x1b') return i + escapeLength(input, i)
    if (c === '\r') {
      if (d.dialogWrote) {
        this.push(tabId, { at, texts: null, wrote: true })
        d.dialogWrote = false
      }
      return i + 1
    }
    const ch = String.fromCodePoint(input.codePointAt(i)!)
    const code = c.charCodeAt(0)
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f)
    if (!control && !/^[0-9]$/.test(ch)) d.dialogWrote = true
    return i + ch.length
  }

  /** pasted text: appended to the readings, or noted as the person's answer while a dialog shows */
  private pasted(d: Draft, text: string, dialog: boolean): void {
    if (dialog) {
      if (text !== '') d.dialogWrote = true
      return
    }
    if (text !== '') d.typed = true
    this.appendText(d, text)
    this.settle(d)
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
      d = { readings: [''], pasting: false, pasteDialog: false, overflow: false, typed: false, dialogWrote: false, carry: '' }
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

  /**
   * the readings merged; past READINGS_MAX of them only the longest (every digit typed into the prompt) and the empty one (every digit
   * answered a menu) are kept, which can only refuse a message. The draft is unknown when a reading is longer than the longest message
   */
  private settle(d: Draft): void {
    if (d.readings === null) return
    let unique = [...new Set(d.readings)]
    if (unique.length > READINGS_MAX) {
      const longest = unique.reduce((a, b) => (b.length > a.length ? b : a))
      unique = unique.filter((t) => t === longest || t === '')
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
      // a command line (Claude Code's bash mode, or a slash command) is not a message the coordinator can relay: each reading that is one is dropped
      const kept = r === null ? null : r.filter((t) => !/^[!/]/.test(t.trimStart()))
      const texts = kept === null || kept.length === 0 ? null : kept
      // with unknown readings, what was typed or pasted since the last submit says whether the person wrote
      this.push(tabId, { at, texts, wrote: d.overflow || (r === null ? d.typed : r.every((t) => t.trim() !== '')) })
    }
    d.readings = ['']
    d.pasting = false
    d.overflow = false
    d.typed = false
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
