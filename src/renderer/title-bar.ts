import { icon } from './icons'
import { shortcutLabel } from './keymap'
import type { LimitMeter } from './limit-meters'

/** what the bar's controls do */
export interface TitleBarCallbacks {
  openRecent(): void
}

/**
 * The window's own title bar: the mark and the name, the search of past sessions, and the usage limits of the tab in
 * front. The bar is the window's drag strip, so every control in it opts out of dragging (CSS).
 */
export class TitleBar {
  private readonly meters: HTMLElement
  /** one element per limit, kept while the bar shows the same limits, so a tooltip under the mouse survives a refresh */
  private readonly meterEls = new Map<LimitMeter['key'], HTMLElement>()
  private shown = ''

  constructor(root: HTMLElement, platform: string, cb: TitleBarCallbacks) {
    const mark = document.createElement('span')
    mark.className = 'tb-mark'
    mark.textContent = '>_'
    const name = document.createElement('span')
    name.className = 'tb-name'
    name.textContent = 'ClaudeTerm'
    const search = document.createElement('button')
    search.type = 'button'
    search.className = 'tb-search'
    search.title = `Search past sessions (${shortcutLabel('recentSessions', platform)})`
    search.innerHTML = icon('search', 14)
    const text = document.createElement('span')
    text.className = 'tb-search-text'
    text.textContent = 'Search past sessions'
    const key = document.createElement('kbd')
    key.className = 'tb-search-key'
    key.textContent = shortcutLabel('recentSessions', platform)
    search.append(text, key)
    search.addEventListener('click', () => cb.openRecent())
    const center = document.createElement('div')
    center.className = 'tb-center'
    center.append(search)
    this.meters = document.createElement('div')
    this.meters.className = 'tb-meters'
    root.replaceChildren(mark, name, center, this.meters)
    this.render([])
  }

  /** the usage limits of the tab in front; the bar hides them when there are none (a shell tab) */
  render(meters: LimitMeter[]): void {
    this.meters.hidden = meters.length === 0
    // a meter is rebuilt only when its key or its bar comes or goes; otherwise its text, classes and variables are updated
    const shown = meters.map((m) => (m.bar ? `${m.key}+` : m.key)).join(',')
    if (shown !== this.shown) {
      this.shown = shown
      this.meterEls.clear()
      this.meters.replaceChildren(...meters.map((m) => {
        const el = buildMeter(m)
        this.meterEls.set(m.key, el)
        return el
      }))
    }
    for (const m of meters) fillMeter(this.meterEls.get(m.key)!, m)
  }
}

function buildMeter(m: LimitMeter): HTMLElement {
  const el = document.createElement('div')
  const head = document.createElement('div')
  head.className = 'meter-head'
  const label = document.createElement('span')
  label.className = 'meter-label'
  const reset = document.createElement('span')
  reset.className = 'meter-reset'
  head.append(label, reset)
  const pct = document.createElement('span')
  pct.className = 'meter-pct'
  el.append(head, pct)
  if (m.bar) {
    const bar = document.createElement('div')
    bar.className = 'meter-bar'
    el.append(bar)
  }
  return el
}

function fillMeter(el: HTMLElement, m: LimitMeter): void {
  const className = `meter meter-${m.key}${m.level === 'normal' ? '' : ` ${m.level}`}`
  if (el.className !== className) el.className = className
  if (el.title !== m.title) el.title = m.title
  const label = el.querySelector<HTMLElement>('.meter-label')!
  const reset = el.querySelector<HTMLElement>('.meter-reset')!
  const pct = el.querySelector<HTMLElement>('.meter-pct')!
  if (label.textContent !== m.label) label.textContent = m.label
  if (reset.textContent !== m.reset) reset.textContent = m.reset
  if (pct.textContent !== m.pct) pct.textContent = m.pct
  // the bar's element is there exactly when m.bar is set (buildMeter, and the key of render's rebuild)
  const bar = el.querySelector<HTMLElement>('.meter-bar')
  if (bar && m.bar) {
    bar.style.setProperty('--used', `${m.bar.used}%`)
    bar.style.setProperty('--elapsed', `${m.bar.elapsed}%`)
  }
}
