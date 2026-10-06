import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { windowsPtyOption } from './util'

// Font sizes are in points, like Windows Terminal; xterm.js takes CSS pixels (1pt = 96/72 px)
const ptToPx = (pt: number): number => (pt * 96) / 72

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
  onKey?(e: KeyboardEvent): boolean
}

export class TerminalView {
  readonly term: Terminal
  readonly search: SearchAddon
  readonly element: HTMLDivElement
  private readonly fit: FitAddon
  private readonly ro: ResizeObserver

  constructor(o: TerminalViewOptions) {
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
      ...windowsPtyOption(o.windowsBuild)
    })
    this.fit = new FitAddon()
    this.search = new SearchAddon()
    this.term.loadAddon(this.fit)
    this.term.loadAddon(this.search)
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
    this.term.onResize(({ cols, rows }) => o.onResize(cols, rows))
    this.refit()
    o.onResize(this.term.cols, this.term.rows)
    this.ro = new ResizeObserver(() => this.refit())
    this.ro.observe(this.element)
  }

  refit(): void {
    if (this.element.offsetParent === null) return
    try { this.fit.fit() } catch { /* not measurable yet */ }
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

  dispose(): void {
    this.ro.disconnect()
    this.term.dispose()
    this.element.remove()
  }
}
