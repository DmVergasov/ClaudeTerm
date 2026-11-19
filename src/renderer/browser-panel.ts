import { MAX_PAGES, type BrowserControl, type BrowserPageView, type BrowserPanelAction, type BrowserPanelState } from '../shared/browser'
import type { BrowserRect, CtApi } from '../shared/ipc'
import { normalizeAddress } from '../shared/site'
import { el } from './dom'
import { showMenu, type MenuItem } from './menu'
import type { SidePanel } from './side-panel'

const EMPTY_TEXT = 'Claude can open pages here, or type an address above.'
/** the ClaudeTerm overlays that lie over a page: while one overlaps the panel, the page is replaced by a still image of it */
const OVERLAYS = '.menu, .remote-popover, .status-tasks, .account-scrim, .mcp-add-scrim, #lightbox:not([hidden]), #sessions:not([hidden]), #folder-dialog:not([hidden]), #plan-list:not([hidden]), #toasts .toast'
/** how long the address field shakes for an address that is no address; reduced motion has no animation, so the class goes at this time too */
const SHAKE_MS = 600

/** a page's name in the strip: its title, else its host, else its address */
function pageLabel(p: BrowserPageView): string {
  if (p.title.trim() !== '') return p.title.trim()
  try {
    const host = new URL(p.url).host
    return host !== '' ? host : p.url
  } catch {
    return p.url
  }
}

/** the address the field shows for a page: a blank page has none */
function addressOf(p: BrowserPageView | null): string {
  return p === null || p.url === 'about:blank' ? '' : p.url
}

function sameRect(a: BrowserRect, b: BrowserRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function button(label: string, className: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el('button', { type: 'button', className, textContent: label, title: title ?? '' })
  b.addEventListener('click', onClick)
  return b
}

/**
 * The Browser panel of a local Claude tab: the tab's pages (a strip), the navigation row, the card asking for a site and the
 * control line. The page itself is a native view that main lays over the stage, the empty box in the middle of the panel; the
 * panel reports the stage's place, and whether an overlay covers it, so that main can show a still image in its place.
 */
export class BrowserPanel {
  /** the tab in front: the browser the panel shows, when the panel shows Browser */
  private tab: string | null = null
  /** each Claude tab's browser state, as main last sent it (or answered the panel's ask) */
  private readonly states = new Map<string, BrowserPanelState>()
  /** whether an overlay covers the stage, as main was last told */
  private covered = false
  /** the tab and place last sent to main, or null when the last send was the hide's (null, null), or nothing was sent yet: a send equal to it is skipped, so a shown page is sent once per change of its place or tab, and a hidden panel sends its (null, null) once */
  private sent: { tabId: string; rect: BrowserRect } | null = null
  /** the address the field shows: it is written again only when the page's address changes, so a typed address stays */
  private shownAddress: string | null = null
  /** the width the body's variable holds, while the panel shows */
  private widthVar = ''
  /** whether the page is loading: the reload button then stops the load */
  private loading = false
  private shakeTimer: ReturnType<typeof setTimeout> | null = null
  private coverFrame = 0
  private readonly profile = button('Default', 'browser-profile', () => this.openProfiles(), 'Profile of this tab')
  private readonly strip = el('div', { className: 'browser-strip' })
  private readonly newPage = button('+', 'browser-new-page', () => this.act({ type: 'newPage' }), 'New page')
  private readonly expand = button('⤢', 'browser-expand', () => this.panel.setExpanded(!this.panel.expanded), 'Expand')
  private readonly back = button('←', 'browser-back', () => this.act({ type: 'back' }), 'Back')
  private readonly forward = button('→', 'browser-forward', () => this.act({ type: 'forward' }), 'Forward')
  private readonly reload = button('⟳', 'browser-reload', () => this.act({ type: this.loading ? 'stopLoading' : 'reload' }), 'Reload')
  private readonly address = el('input', { className: 'browser-address', type: 'text', spellcheck: false, placeholder: 'Address' })
  private readonly more = button('⋯', 'browser-more', () => this.openMenu(), 'More')
  private readonly stage = el('div', { className: 'browser-stage' })
  private readonly empty = el('div', { className: 'browser-empty', textContent: EMPTY_TEXT })
  /** the still image of a covered page: in the stage only while it shows */
  private still: HTMLImageElement | null = null
  /** Clear this profile's data…: an inline confirm row, above the page, since a native dialog would take the focus */
  private readonly clearRow = el('div', { className: 'browser-clear', hidden: true })
  private readonly card = el('div', { className: 'browser-card', hidden: true })
  private readonly control = el('div', { className: 'browser-control', hidden: true })
  /** the page's covers are looked for while the panel shows: the body changes often, so the look runs once per frame */
  private readonly observer = new MutationObserver(() => {
    if (this.coverFrame !== 0) return
    this.coverFrame = requestAnimationFrame(() => {
      this.coverFrame = 0
      this.checkCover()
    })
  })

  constructor(private readonly body: HTMLElement, private readonly panel: SidePanel, private readonly ct: CtApi) {
    const top = el('div', { className: 'browser-top' }, this.profile, this.strip, this.newPage, this.expand)
    const nav = el('div', { className: 'browser-nav' }, this.back, this.forward, this.reload, this.address, this.more)
    this.stage.append(this.empty)
    this.body.replaceChildren(top, nav, this.clearRow, this.stage, this.card, this.control)
    this.address.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return
      e.preventDefault()
      const url = normalizeAddress(this.address.value)
      if (url === null) {
        this.shake()
        return
      }
      // the field gives up the focus, so the page's address shows once the page has moved
      this.address.blur()
      this.act({ type: 'navigate', url })
    })
    this.address.addEventListener('blur', () => this.render())
    this.address.addEventListener('animationend', () => this.clearShake())
    // the stage's place and size: the page follows it; the body's width variable follows the panel's
    new ResizeObserver(() => this.report()).observe(this.stage)
    new ResizeObserver(() => this.syncWidth()).observe(this.body.parentElement!)
    window.addEventListener('resize', () => {
      this.report()
      this.checkCover()
    })
    this.render()
  }

  /** the tab in front changed: its browser is the one the panel shows (null: a tab with no browser is in front, or none) */
  show(tabId: string | null): void {
    if (tabId !== this.tab) {
      this.shownAddress = null
      // the field gives up the focus of the tab it was typing for: the new tab's address is written even when the field had the focus
      this.address.blur()
      this.hideClear()
    }
    this.tab = tabId
    this.fetchState()
    this.render()
    this.report()
    this.checkCover()
  }

  /** main sent a tab's browser state */
  setState(s: BrowserPanelState): void {
    const before = this.states.get(s.tabId)
    this.states.set(s.tabId, s)
    if (s.tabId !== this.tab) return
    // the clear row names the profile it was opened for: when the tab changes its profile, the row goes
    if (before !== undefined && before.profileId !== s.profileId) this.hideClear()
    this.render()
  }

  /** a page's still image came (a string), or the live page is back (null) */
  setStill(tabId: string, dataUrl: string | null): void {
    if (dataUrl === null) {
      this.still?.remove()
      this.still = null
      return
    }
    if (tabId !== this.tab) return
    if (this.still === null) {
      this.still = el('img', { className: 'browser-still', alt: '' })
      this.stage.append(this.still)
    }
    this.still.src = dataUrl
  }

  /** a Claude tab's browser closed: its state is dropped */
  closed(tabId: string): void {
    this.states.delete(tabId)
    if (tabId !== this.tab) return
    this.setStill(tabId, null)
    this.hideClear()
    this.tab = null
    this.render()
    this.report()
  }

  /** Claude's first navigation in a tab (main sends it once per tab): the panel opens on Browser when that tab is in front */
  opened(tabId: string): void {
    if (tabId === this.tab) this.panel.open('browser')
  }

  /** the side panel changed: its tab, its width or whether it shows */
  panelChanged(): void {
    const shown = this.panel.isShowing('browser')
    document.body.classList.toggle('browser-shown', shown)
    // the expand button is lit while the panel covers the sheet, and says what it does next
    this.expand.classList.toggle('active', this.panel.expanded)
    this.expand.title = this.panel.expanded ? 'Collapse' : 'Expand'
    if (shown) {
      this.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] })
      this.fetchState()
      this.syncWidth()
    } else {
      this.observer.disconnect()
      cancelAnimationFrame(this.coverFrame)
      this.coverFrame = 0
      document.body.style.removeProperty('--browser-panel-width')
      this.widthVar = ''
    }
    this.report()
    this.checkCover()
  }

  /** the state the panel shows: the tab in front's, null when it has none yet */
  private current(): BrowserPanelState | null {
    return this.tab === null ? null : this.states.get(this.tab) ?? null
  }

  /** the tab in front's state, asked of main while the panel shows that tab and main has not sent it yet */
  private fetchState(): void {
    const tabId = this.tab
    if (tabId === null || !this.panel.isShowing('browser') || this.states.has(tabId)) return
    void this.ct.browserState(tabId).then((s) => {
      if (s !== null && !this.states.has(tabId)) this.setState(s)
    }, () => undefined)
  }

  private act(a: BrowserPanelAction): void {
    if (this.tab !== null) this.ct.browserAction(this.tab, a)
  }

  private shake(): void {
    this.clearShake()
    // a reflow restarts the animation when the field is shaken again before it has ended
    void this.address.offsetWidth
    this.address.classList.add('shaking')
    this.shakeTimer = setTimeout(() => this.clearShake(), SHAKE_MS)
  }

  private clearShake(): void {
    if (this.shakeTimer !== null) clearTimeout(this.shakeTimer)
    this.shakeTimer = null
    this.address.classList.remove('shaking')
  }

  private render(): void {
    const s = this.current()
    const pages = s?.pages ?? []
    const page = s !== null && s.current !== null ? pages[s.current] ?? null : null
    const profile = s === null ? undefined : s.profiles.find((p) => p.id === s.profileId)
    this.profile.textContent = profile?.name ?? 'Default'
    this.renderStrip(s)
    this.back.disabled = !(s?.canBack ?? false)
    this.forward.disabled = !(s?.canForward ?? false)
    this.newPage.disabled = pages.length >= MAX_PAGES
    this.loading = page?.loading ?? false
    this.reload.textContent = this.loading ? '✕' : '⟳'
    this.reload.title = this.loading ? 'Stop loading' : 'Reload'
    // a field the person is typing in keeps its text: the page's address is written once the field lets go
    const address = addressOf(page)
    if (address !== this.shownAddress && document.activeElement !== this.address) {
      this.shownAddress = address
      this.address.value = address
    }
    this.empty.hidden = pages.length > 0
    this.renderCard(s)
    this.renderControl(s?.control ?? 'idle')
  }

  private renderStrip(s: BrowserPanelState | null): void {
    const tabs = (s?.pages ?? []).map((p, i) => {
      const tab = el('div', { className: i === s?.current ? 'browser-page-tab current' : 'browser-page-tab' })
      tab.append(
        button(pageLabel(p), 'browser-page', () => this.act({ type: 'selectPage', index: i }), p.url),
        button('×', 'browser-page-close', () => this.act({ type: 'closePage', index: i }), 'Close page')
      )
      return tab
    })
    this.strip.replaceChildren(...tabs)
  }

  private renderCard(s: BrowserPanelState | null): void {
    this.card.replaceChildren()
    this.card.hidden = s === null || s.card === null
    if (s === null || s.card === null) return
    const { tabId, card } = s
    const text = card.kind === 'open' ? `Claude wants to open ${card.site}` : `Claude wants to use ${card.site}`
    const answer = (label: string, a: 'tab' | 'always' | 'deny'): HTMLButtonElement => button(label, 'browser-btn', () => this.ct.browserAction(tabId, { type: 'answer', cardId: card.id, answer: a }))
    this.card.append(
      el('div', { className: 'browser-card-text', textContent: text }),
      el('div', { className: 'browser-card-actions' }, answer('Allow in this tab', 'tab'), ...(card.file ? [] : [answer('Always allow', 'always')]), answer('Deny', 'deny'))
    )
  }

  private renderControl(control: BrowserControl): void {
    this.control.replaceChildren()
    this.control.className = `browser-control ${control}`
    this.control.hidden = control === 'idle'
    if (control === 'claude') {
      this.control.append(el('span', { textContent: 'Claude is using the browser' }), button('Stop', 'browser-btn', () => this.act({ type: 'stop' })))
    } else if (control === 'person') {
      this.control.append(el('span', { textContent: 'You have control' }), button('Hand back to Claude', 'browser-btn', () => this.act({ type: 'handBack' })))
    }
  }

  /** the profile menu: every profile, the tab's own marked, then Import cookies… (the tab's profile's import sheet) and Manage profiles… (Settings › Browser) */
  private openProfiles(): void {
    const s = this.current()
    if (s === null) return
    const r = this.profile.getBoundingClientRect()
    const items: MenuItem[] = s.profiles.map((p) => (p.id === s.profileId
      ? { label: `✓ ${p.name}`, action: () => undefined }
      : { label: p.name, action: () => this.act({ type: 'setProfile', profileId: p.id }) }))
    // the import opens Settings › Browser at this tab's profile: the section names the profile
    items.push(
      { label: '', separator: true },
      { label: 'Import cookies…', action: () => this.ct.openSettingsWindow(`browser-import:${s.profileId}`) },
      { label: 'Manage profiles…', action: () => this.act({ type: 'manageProfiles' }) }
    )
    showMenu({ x: r.left, y: r.bottom + 4 }, items)
  }

  /** the ⋯ menu: Open DevTools, only while there is a page, and Clear this profile's data… */
  private openMenu(): void {
    const r = this.more.getBoundingClientRect()
    const items: MenuItem[] = []
    if (this.current()?.devtools) items.push({ label: 'Open DevTools', action: () => this.act({ type: 'devtools' }) })
    items.push({ label: 'Clear this profile\'s data…', action: () => this.askClear() })
    showMenu({ x: r.left, y: r.bottom + 4 }, items)
  }

  /** the confirm row for the tab's profile: its name, then Clear (main clears the profile's data) or Cancel */
  private askClear(): void {
    const s = this.current()
    const name = s?.profiles.find((p) => p.id === s.profileId)?.name ?? 'Default'
    this.clearRow.replaceChildren(
      el('span', { className: 'browser-clear-text', textContent: `Clear the cookies, storage and cache of ${name}? Sign-ins in it are lost.` }),
      button('Clear', 'browser-btn', () => {
        this.hideClear()
        this.act({ type: 'clearData' })
      }),
      button('Cancel', 'browser-btn', () => this.hideClear())
    )
    this.clearRow.hidden = false
  }

  private hideClear(): void {
    this.clearRow.hidden = true
    this.clearRow.replaceChildren()
  }

  /** the toasts sit left of the panel while it shows: the body's variable is the panel's width, written only while it shows and when it changes; an expanded panel covers the sheet, so the toasts stay where they are */
  private syncWidth(): void {
    if (!this.panel.isShowing('browser') || this.panel.expanded) {
      document.body.style.removeProperty('--browser-panel-width')
      this.widthVar = ''
      return
    }
    const width = `${this.body.parentElement!.getBoundingClientRect().width}px`
    if (width === this.widthVar) return
    this.widthVar = width
    document.body.style.setProperty('--browser-panel-width', width)
  }

  /** the stage's place goes to main in CSS pixels (main converts them to window pixels): the page is shown there while the panel shows Browser for a tab, and no page otherwise */
  private report(): void {
    const tabId = this.tab
    if (tabId === null || !this.panel.isShowing('browser')) {
      if (this.sent !== null) {
        this.sent = null
        this.ct.browserBounds(null, null)
      }
      return
    }
    const r = this.stage.getBoundingClientRect()
    const rect: BrowserRect = { x: r.x, y: r.y, width: r.width, height: r.height }
    if (this.sent !== null && this.sent.tabId === tabId && sameRect(this.sent.rect, rect)) return
    this.sent = { tabId, rect }
    this.ct.browserBounds(tabId, rect)
  }

  /** whether an overlay of ClaudeTerm covers the stage: main is told when that changes; nothing is measured while the panel does not show */
  private checkCover(): void {
    const shown = this.tab !== null && this.panel.isShowing('browser')
    const covered = shown && this.overlapped()
    if (covered === this.covered) return
    this.covered = covered
    this.ct.browserCovered(covered)
  }

  private overlapped(): boolean {
    const r = this.stage.getBoundingClientRect()
    return Array.from(document.querySelectorAll(OVERLAYS)).some((o) => {
      const b = o.getBoundingClientRect()
      return b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top
    })
  }
}
