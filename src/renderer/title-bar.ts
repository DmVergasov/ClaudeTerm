import type { LimitMeter } from './limit-meters'

/**
 * The window's own title bar: the mark and the name on the left, and the usage limits of the tab in front in the middle.
 * Recent sessions has its own buttons with the tabs. The bar is the window's drag strip, so the limits opt out of dragging
 * (CSS) to show their tooltips.
 */
export class TitleBar {
  private readonly meters: HTMLElement
  /** one element per limit, kept while the bar shows the same limits, so a tooltip under the mouse survives a refresh */
  private readonly meterEls = new Map<LimitMeter['key'], HTMLElement>()
  private shown = ''

  constructor(root: HTMLElement) {
    const mark = document.createElement('span')
    mark.className = 'tb-mark'
    mark.textContent = '>_'
    const name = document.createElement('span')
    name.className = 'tb-name'
    name.textContent = 'ClaudeTerm'
    const left = document.createElement('div')
    left.className = 'tb-left'
    left.append(mark, name)
    this.meters = document.createElement('div')
    this.meters.className = 'tb-meters'
    // the right column is the window buttons' room, as wide as the left one at most, so the limits stay in the middle
    const right = document.createElement('div')
    right.className = 'tb-right'
    root.replaceChildren(left, this.meters, right)
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
  const pct = document.createElement('span')
  pct.className = 'meter-pct'
  const reset = document.createElement('span')
  reset.className = 'meter-reset'
  // the name and the percent on one line, the reset at its right end, the bar under them
  head.append(label, pct, reset)
  el.append(head)
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
