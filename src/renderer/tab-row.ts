import type { TabActivity } from '../shared/types'
import { shortcutLabel } from './keymap'
import { noteIcon } from './note-overlay'
import type { TabBarCallbacks, TabBarItem } from './tabbar'

/** one full fade in and out of the attention pulse: 2 × the 1.2 s alternate animation in styles.css */
const PULSE_CYCLE_MS = 2400
/** one round of the spinning icon's glyphs, as styles.css runs it */
const SPIN_CYCLE_MS = 1200

export const MUTED_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M1.65 5.65h2.7l3.5-3v10.7l-3.5-3h-2.7z"/><path d="M10.5 5.5l4 4M14.5 5.5l-4 4"/></svg>'

export function button(text: string, cls: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = cls
  b.textContent = text
  b.title = title
  b.addEventListener('click', onClick)
  return b
}

/**
 * The animation delay of a tab that pulses. render() rebuilds every tab, which would restart the pulse each time (a busy
 * Claude retitles its tab every second); a negative delay from one shared clock makes a rebuilt tab carry on in the same phase.
 */
export function pulseDelay(): string {
  return `${-(performance.now() % PULSE_CYCLE_MS)}ms`
}

/**
 * The icon that spins while Claude works: Claude Code's own spinner glyphs. Like the pulse it carries on in phase when
 * render() rebuilds it (a working Claude retitles its tab every second).
 */
export function spinner(cls: string): HTMLElement {
  const el = document.createElement('span')
  el.className = `${cls} spin`
  el.setAttribute('aria-hidden', 'true')
  el.style.setProperty('--spin-delay', `${-(performance.now() % SPIN_CYCLE_MS)}ms`)
  return el
}

/** a tab's activity as its icon shows it: none while Claude waits for the user, whose pulse says more */
export const shownActivity = (item: Pick<TabBarItem, 'activity' | 'attention'>): TabActivity => item.attention ? null : item.activity

export interface TabParts {
  icon: HTMLElement
  label: HTMLElement
  /** the note, muted, bell and images marks, in this order */
  marks: HTMLElement[]
  close: HTMLButtonElement
}

/** what a tab shows of itself, on the tab bar and in the left panel alike: the kind icon, the title, the marks and × */
export function tabParts(item: TabBarItem, platform: string, cb: Pick<TabBarCallbacks, 'close'>): TabParts {
  let icon: HTMLElement
  if (shownActivity(item)) icon = spinner('tab-icon')
  else {
    icon = document.createElement('span')
    icon.className = 'tab-icon'
    icon.textContent = item.kind === 'claude' ? '✳' : '>'
  }
  const label = document.createElement('span')
  label.className = 'tab-title'
  label.textContent = item.title
  const marks: HTMLElement[] = []
  if (item.note) {
    const n = document.createElement('span')
    n.className = 'tab-note'
    n.title = 'Has a note'
    n.innerHTML = noteIcon(12)
    marks.push(n)
  }
  if (item.muted) {
    const m = document.createElement('span')
    m.className = 'tab-muted'
    m.title = 'Sound muted'
    m.innerHTML = MUTED_ICON
    marks.push(m)
  }
  if (item.bell) {
    const b = document.createElement('span')
    b.className = 'tab-bell'
    b.textContent = '●'
    marks.push(b)
  }
  if (item.images > 0) {
    const b = document.createElement('span')
    b.className = 'tab-images'
    b.textContent = `🖼${item.images}`
    marks.push(b)
  }
  const close = button('×', 'tab-close', `Close (${shortcutLabel('closeTab', platform)})`, (e) => {
    e.stopPropagation()
    cb.close(item.id)
  })
  return { icon, label, marks, close }
}

/**
 * The tab whose primary button went down last. A press and a release on the same tab activate it, even when the
 * element was built again between the two (the tab bar redraws while a press is held), so the tracking is by id.
 */
let pressed: string | null = null
// a press that starts elsewhere activates no tab, whatever it is released over
document.addEventListener('mousedown', () => { pressed = null }, true)
document.addEventListener('mouseup', () => { pressed = null })

/** the mouse on a tab: a press and release activate, a middle click closes, a right click opens its menu, a double click renames */
export function bindTab(
  el: HTMLElement,
  item: TabBarItem,
  cb: Pick<TabBarCallbacks, 'activate' | 'close' | 'tabMenu'>,
  beginRename: () => void
): void {
  el.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
      e.preventDefault()
      cb.close(item.id)
    } else if (e.button === 0) pressed = item.id
  })
  el.addEventListener('mouseup', (e) => {
    // the close button is part of the tab: releasing on it closes the tab, it does not activate it
    const onClose = e.target instanceof Element && e.target.closest('.tab-close') !== null
    if (e.button === 0 && pressed === item.id && !onClose) cb.activate(item.id)
  })
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    cb.tabMenu(item.id, { x: e.clientX, y: e.clientY })
  })
  el.addEventListener('dblclick', beginRename)
}

/**
 * Renames a tab in place: its title turns into an input. Enter or leaving the input commits, Escape keeps the title.
 * `rename` runs only for a changed title (null: an empty one, which gives back the automatic title); `end` runs once.
 */
export function beginRename(label: HTMLElement, current: string, rename: (title: string | null) => void, end: () => void): void {
  const input = document.createElement('input')
  input.className = 'tab-rename'
  input.value = current
  label.replaceWith(input)
  input.focus()
  input.select()
  let done = false
  const finish = (commit: boolean): void => {
    if (done) return
    done = true
    const value = input.value.trim()
    if (commit && value !== current) rename(value === '' ? null : value)
    end()
  }
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') finish(true)
    else if (e.key === 'Escape') finish(false)
  })
  input.addEventListener('blur', () => finish(true))
}
