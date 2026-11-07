import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { osc52Text } from './osc52'
import type { Screen, ScreenRow } from './claude-screen'
import { windowsPtyOption } from './util'
import { boundedSerialize, scrollbackLines } from '../shared/screen-serialize'

// Font sizes are in points, like Windows Terminal; xterm.js takes CSS pixels (1pt = 96/72 px)
const ptToPx = (pt: number): number => (pt * 96) / 72

const usable = (n: number): boolean => Number.isFinite(n) && n > 0

export interface TerminalViewOptions {
  tabId: string
  container: HTMLElement
  fontFamily: string
  /** points */
  fontSize: number
  theme: ITheme
  scrollback: number
  windowsBuild: number | null
  useWebgl: boolean
  onInput(data: string): void
  onResize(cols: number, rows: number): void
  onTitle(title: string): void
  onBell(): void
  onLink(uri: string): void
  /** a program copied text with OSC 52, as Claude Code does with its own mouse selection */
  onClipboard(text: string): void
  onKey?(e: KeyboardEvent): boolean
}

export class TerminalView {
  readonly term: Terminal
  readonly search: SearchAddon
  readonly element: HTMLDivElement
  private readonly fit: FitAddon
  private readonly serializer: SerializeAddon
  private readonly ro: ResizeObserver
  private readonly onSize: (cols: number, rows: number) => void
  /** the size the device last typed into holds this terminal at; null: the terminal fits its element */
  private fixed: { cols: number; rows: number } | null = null
  /** the size last reported to the window, so that each change is reported once */
  private reported: { cols: number; rows: number } | null = null

  constructor(o: TerminalViewOptions) {
    this.onSize = o.onResize
    this.element = document.createElement('div')
    this.element.className = 'terminal-host'
    o.container.appendChild(this.element)
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: o.fontFamily,
      fontSize: ptToPx(o.fontSize),
      theme: o.theme,
      scrollback: o.scrollback,
      cursorBlink: true,
      // on macOS xterm selects the word under a right click, which the right click would then copy instead of pasting
      rightClickSelectsWord: false,
      // ⌥-drag selects while a program (Claude Code) has the mouse, as Shift-drag does on Windows and Linux
      macOptionClickForcesSelection: true,
      ...windowsPtyOption(o.windowsBuild)
    })
    this.fit = new FitAddon()
    this.search = new SearchAddon()
    this.term.loadAddon(this.fit)
    this.term.loadAddon(this.search)
    this.serializer = new SerializeAddon()
    this.term.loadAddon(this.serializer)
    this.term.loadAddon(new WebLinksAddon((_e, uri) => o.onLink(uri)))
    this.term.loadAddon(new Unicode11Addon())
    this.term.unicode.activeVersion = '11'
    this.term.open(this.element)
    if (o.useWebgl) {
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        this.term.loadAddon(webgl)
      } catch {
        // DOM renderer fallback
      }
    }
    if (o.onKey) this.term.attachCustomKeyEventHandler(o.onKey)
    this.term.onData(o.onInput)
    this.term.onTitleChange(o.onTitle)
    this.term.onBell(o.onBell)
    this.term.parser.registerOscHandler(52, (data) => {
      const text = osc52Text(data)
      if (text !== null) o.onClipboard(text)
      return true
    })
    this.term.onResize(() => this.report())
    this.refit()
    this.report()
    this.ro = new ResizeObserver(() => this.refit())
    this.ro.observe(this.element)
  }

  refit(): void {
    if (this.element.offsetParent === null) return
    // a fixed terminal keeps its size: the window's fit is only reported, and the device's size still applies
    if (this.fixed === null) {
      try { this.fit.fit() } catch { /* not measurable yet */ }
    }
    this.report()
  }

  /** this window's size for the tab: the size that fits the element, reported once per change and never an unusable one */
  private report(): void {
    let d: { cols: number; rows: number } | undefined
    try { d = this.fit.proposeDimensions() } catch { return }
    if (!d || !usable(d.cols) || !usable(d.rows)) return
    if (this.reported?.cols === d.cols && this.reported.rows === d.rows) return
    this.reported = { cols: d.cols, rows: d.rows }
    this.onSize(d.cols, d.rows)
  }

  /**
   * The size of the device that last typed into this tab, or null for the window's own fit. Fixed, the terminal takes
   * that size (also while hidden) and its element scrolls it sideways, or shows margins when it is smaller.
   */
  setFixedSize(size: { cols: number; rows: number } | null): void {
    if (size === null) {
      if (this.fixed === null) return
      this.fixed = null
      this.element.classList.remove('fixed')
      this.refit()
      return
    }
    if (this.fixed?.cols === size.cols && this.fixed.rows === size.rows) return
    this.fixed = { cols: size.cols, rows: size.rows }
    this.element.classList.add('fixed')
    this.term.resize(size.cols, size.rows)
  }

  write(data: string): void { this.term.write(data) }

  /**
   * A fresh terminal for a restarted process: a killed one may have left the alternate screen or mouse modes on.
   * RIS goes through the write queue, so output still waiting to be parsed cannot land after the reset.
   */
  reset(): void { this.term.write('\x1bc') }

  show(visible: boolean, focus = true): void {
    this.element.style.display = visible ? 'block' : 'none'
    if (visible) {
      // a device-sized terminal reports its fit again: its first report may have come before the tab was ever in front
      // here, and the viewer keeps no fit for such a tab; a tab sized for this window is claimed again from the fit the
      // viewer kept
      if (this.fixed !== null) this.reported = null
      this.refit()
      if (focus) this.term.focus()
    }
  }

  setFont(family: string, size: number): void {
    this.term.options.fontFamily = family
    this.term.options.fontSize = ptToPx(size)
    this.refit()
  }

  setTheme(theme: ITheme): void { this.term.options.theme = theme }

  bufferText(): string {
    const b = this.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i)
      const text = line?.translateToString(true) ?? ''
      if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text
      else lines.push(text)
    }
    return lines.join('\n')
  }

  /** the rows in view now, each also with its dim cells blanked and with only its cells that have a background */
  screen(): Screen {
    const b = this.term.buffer.active
    const rows: ScreenRow[] = []
    for (let y = 0; y < this.term.rows; y++) {
      const line = b.getLine(b.viewportY + y)
      if (!line) break
      let text = ''
      let bright = ''
      let shaded = ''
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x)
        // the second half of a wide character has no text of its own
        if (!cell || cell.getWidth() === 0) continue
        const ch = cell.getChars() || ' '
        const blank = ' '.repeat(ch.length)
        text += ch
        bright += cell.isDim() ? blank : ch
        shaded += cell.isBgDefault() ? blank : ch
      }
      rows.push({ text: text.trimEnd(), bright: bright.trimEnd(), shaded: shaded.trimEnd() })
    }
    return { rows, scrolledBack: b.type === 'normal' && b.viewportY < b.baseY }
  }

  /**
   * The screen as a string that writes it back onto a fresh terminal: the scrollback and the modes, within maxBytes (as JSON).
   * The buffer's real length bounds the scrollback, so a short session does not ask for the whole setting.
   */
  serialize(maxBytes: number): string {
    const finite = (n: number | undefined): number => (n !== undefined && Number.isFinite(n) ? n : 0)
    const bufferLines = scrollbackLines(this.term)
    return boundedSerialize((n) => this.serializer.serialize({ scrollback: n }), finite(this.term.options.scrollback), maxBytes, finite(bufferLines))
  }

  dispose(): void {
    this.ro.disconnect()
    this.term.dispose()
    this.element.remove()
  }
}
