import type { TabPosition } from '../shared/types'
import { icon, type IconName } from './icons'
import { shortcutLabel } from './keymap'
import { button } from './tab-row'
import type { TabBarCallbacks } from './tabbar'

type HeaderCallbacks = Pick<TabBarCallbacks, 'newTab' | 'openMenu' | 'switchPosition' | 'openRecent' | 'openSettings' | 'openNotifications'>

/** the tabs are on top: the icon shows a split into a panel on the left */
const ICON_TO_LEFT = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="1.65" y="2.65" width="12.7" height="10.7" rx="1.5"/><path d="M5.65 2.65v10.7"/></svg>'
/** the tabs are on the left: the icon shows a split into a bar on top */
const ICON_TO_TOP = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="1.65" y="2.65" width="12.7" height="10.7" rx="1.5"/><path d="M1.65 5.65h12.7"/></svg>'

const textSpan = (cls: string, text: string): HTMLSpanElement => {
  const s = document.createElement('span')
  s.className = cls
  s.textContent = text
  return s
}

/** a button of the left panel's foot: its icon, and its words, which the narrow column hides (the title keeps them) */
function footButton(cls: string, glyph: IconName, text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = cls
  b.title = text
  b.innerHTML = icon(glyph, 14)
  b.append(textSpan('tp-label', text))
  b.addEventListener('click', onClick)
  return b
}

/** a button of the account row: an icon, named by its title */
function iconButton(cls: string, glyph: IconName, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = cls
  b.title = title
  b.setAttribute('aria-label', title)
  b.innerHTML = icon(glyph, 15)
  b.addEventListener('click', onClick)
  return b
}

/** the letters of an account's avatar: the first of its first two words, or the first two of a single word */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const letters = words.length === 1 ? [...words[0]!].slice(0, 2) : [[...words[0]!][0]!, [...words[1]!][0]!]
  return letters.join('').toUpperCase()
}

/**
 * The header buttons of a tab bar on top or of the left panel. On top: + and ▾, and the position button. On the left: a
 * wide New tab button and ▾ for the panel's head, and for its foot Recent sessions, then the account row: the account of
 * the tab in front with its plan, Notification settings, Settings and the position button. The panel toggles (Changes,
 * Media, Messages, Docs, Note) are in the sheet's header. Each bar has its own set, built once, so a re-render of the tabs
 * never drops a click or a tooltip.
 */
export class TabHeader {
  readonly plus: HTMLButtonElement
  readonly more: HTMLButtonElement
  readonly recent: HTMLButtonElement
  readonly notify: HTMLButtonElement
  readonly settings: HTMLButtonElement
  readonly position: HTMLButtonElement
  /** the account row of the left panel's foot */
  readonly account = document.createElement('div')
  private readonly avatar = textSpan('tp-avatar', '')
  private readonly accountName = textSpan('tp-account-name', '')
  private readonly accountPlan = textSpan('tp-account-plan', '')

  constructor(cb: HeaderCallbacks, platform: string, where: TabPosition) {
    const newTab = shortcutLabel('newTab', platform)
    if (where === 'left') {
      this.plus = document.createElement('button')
      this.plus.className = 'tab-new tp-new'
      this.plus.title = `New tab (${newTab})`
      this.plus.innerHTML = icon('plus', 15)
      this.plus.append(textSpan('tp-label', 'New tab'), textSpan('tp-key', newTab))
      this.plus.addEventListener('click', () => cb.newTab())
    } else {
      this.plus = button('+', 'tab-new', `New tab (${newTab})`, () => cb.newTab())
    }
    this.more = button('', 'tab-menu', 'Profiles', (e) => cb.openMenu(e.currentTarget as HTMLElement))
    this.more.innerHTML = icon('chevron-down', where === 'left' ? 14 : 13)
    this.recent = footButton('tp-recent', 'history', 'Recent sessions', () => cb.openRecent())
    this.notify = iconButton('tp-notify', 'bell', 'Notification settings', () => cb.openNotifications())
    this.settings = iconButton('tp-settings', 'settings', 'Settings', () => cb.openSettings())
    this.position = document.createElement('button')
    this.position.className = 'tab-position'
    this.position.title = where === 'top' ? 'Tabs on the left' : 'Tabs on top'
    this.position.innerHTML = where === 'top' ? ICON_TO_LEFT : ICON_TO_TOP
    this.position.addEventListener('click', () => cb.switchPosition())
    this.account.className = 'tp-account'
    this.avatar.setAttribute('aria-hidden', 'true')
    const text = document.createElement('span')
    text.className = 'tp-account-text'
    text.append(this.accountName, this.accountPlan)
    this.account.append(this.avatar, text, this.notify, this.settings, this.position)
  }

  /** the account the tab in front runs on, and its plan or where it runs */
  setAccount(name: string, detail: string): void {
    if (this.accountName.textContent === name && this.accountPlan.textContent === detail) return
    this.avatar.textContent = initials(name)
    this.accountName.textContent = name
    this.accountPlan.textContent = detail
    this.account.title = `${name} · ${detail}`
  }
}
