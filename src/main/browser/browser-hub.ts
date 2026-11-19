import { existsSync, mkdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { session, View, type BrowserWindow, type DownloadItem, type Rectangle, type WebContents, type WebContentsView } from 'electron'
import { DEFAULT_PROFILE_ID, partitionOf, type BrowserPanelAction, type BrowserPanelState, type BrowserTabState, type SiteCard } from '../../shared/browser'
import type { BrowserRect, SettingsSection } from '../../shared/ipc'
import type { KeyAction } from '../../shared/keymap'
import type { BrowserMessage, PipeResponse } from '../../shared/protocol'
import type { BrowserProfilesStore } from './profiles-store'
import { pathKey } from '../path-key'
import { SiteGate } from './site-gate'
import { TabBrowser, type PageStage, type TabBrowserDeps } from './tab-browser'

export type Rect = BrowserRect

export interface BrowserHubDeps {
  /** the app's window, or null while there is none */
  window(): BrowserWindow | null
  profiles: BrowserProfilesStore
  isLocalClaudeTab(tabId: string): boolean
  /** the tab this one is a fork of, or null */
  forkParent(tabId: string): string | null
  /** the folder the tab works in, or null: a local file inside it is free for Claude */
  folderOf(tabId: string): string | null
  /** the tab asks for attention on this device only (never forwarded to paired devices) */
  signal(tabId: string): void
  sendState(state: BrowserPanelState): void
  sendClosed(tabId: string): void
  sendStill(tabId: string, dataUrl: string | null): void
  openPanel(tabId: string): void
  /** the saved state of the browsers changed: the session is saved again */
  sessionChanged(): void
  /** the profiles changed (added, renamed, removed, made default, or a site allowed always): every window gets the list, and the tabs their state */
  profilesChanged(): void
  /** opens the Settings window at a section */
  openSettings(section: SettingsSection): void
  downloadsDir(): string
  /** the window's background colour: the cover that hides the parked pages' corner takes it */
  coverColor(): string
  /** the platform, which the app's shortcuts depend on */
  platform: string
  /** an app shortcut pressed in a page: the window runs it */
  appKey(action: KeyAction): void
  /** the keyboard goes to a page's web contents, or to the window when null: where it goes when the page that had it leaves the screen */
  keyboardTo(target: WebContents | null): void
  answerMs?: number
  log: { info(m: string): void; warn(m: string): void }
}

const PAGE_WIDTH = 1024
const PAGE_HEIGHT = 768
const NOT_CLAUDE = 'The browser works only in a ClaudeTerm Claude tab.'
const NOT_RUNNING = 'ClaudeTerm is not running; the browser is not available.'

function roundRect(r: Rect): Rect {
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
}

/**
 * A file name in the folder that no file has yet, nor a download running for it: the suggested name, then `name (2).ext`,
 * `name (3).ext`, … `reserved` holds the path keys (pathKey) of the running downloads' files, so on Windows `A.txt` and `a.txt` are one file.
 */
export function uniquePath(dir: string, suggested: string, reserved: Set<string>): string {
  const base = basename(suggested)
  const name = base === '' || base === '.' || base === '..' ? 'download' : base
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let path = join(dir, name)
  for (let n = 2; existsSync(path) || reserved.has(pathKey(path)); n++) path = join(dir, `${stem} (${n})${ext}`)
  return path
}

/**
 * The Browser of every Claude tab: one TabBrowser per tab, the pages' gate, and the window's stage. A page's view is in the
 * window all the time: the shown page sits over the Browser panel's body, every other page is parked at the window's
 * corner under a 1×1 cover, where it keeps taking CDP input and screenshots.
 */
export class BrowserHub {
  private readonly tabs = new Map<string, TabBrowser>()
  private readonly gate: SiteGate
  /** the last card each tab showed: a new card opens the tab's Browser panel */
  private readonly lastCard = new Map<string, string>()
  /** the saved state of each tab as the session was last told: the session is saved again only when it changes */
  private readonly savedSent = new Map<string, string>()
  private readonly sessionsSet = new Set<string>()
  private readonly stage: PageStage
  private cover: View | null = null
  private coverWindow: BrowserWindow | null = null
  private wiredWindow: BrowserWindow | null = null
  private shownTab: string | null = null
  /** the shown tab's page that layout() last placed, covered or not: only its closing moves the keyboard when it leaves */
  private placed: WebContentsView | null = null
  private shownRect: Rect | null = null
  /** whether a cover is in effect: the shown page is parked */
  private covered = false
  /** what the panel asked for: a cover can be asked for while the still of the page is being taken */
  private wantCovered = false
  private coverSeq = 0
  /** the paths of the downloads running: two of one name get two files */
  private readonly reserved = new Set<string>()
  /** the last page-area size the panel sent: the parked pages keep it */
  private pageSize = { width: PAGE_WIDTH, height: PAGE_HEIGHT }

  constructor(private readonly d: BrowserHubDeps) {
    this.gate = new SiteGate({
      allowedAlways: (profileId) => d.profiles.allowed(profileId),
      allowAlways: (profileId, site) => {
        d.profiles.allow(profileId, site)
        d.profilesChanged()
      },
      allowAll: (profileId) => d.profiles.allowsAll(profileId),
      showCard: (tabId, card) => this.showCard(tabId, card),
      signal: (tabId) => d.signal(tabId),
      folderOf: (tabId) => d.folderOf(tabId),
      answerMs: d.answerMs
    })
    this.stage = {
      add: (view) => {
        const win = this.win()
        if (!win) return
        win.contentView.addChildView(view)
        this.layout()
      },
      remove: (view, tabId) => {
        // a page that had the keyboard leaves the window: the keyboard goes to the page the panel shows now, or else to the window.
        // A page that destroyed itself has no web contents left on its view (Electron clears them), so they are read as maybe absent:
        // the shown page of the tab then gives the keyboard on as well, as nothing else in the tab can have it
        const contents = view.webContents as WebContents | undefined
        const gone = contents === undefined || contents.isDestroyed()
        // only the view layout() placed as shown hands the keyboard on when it is gone: a background page closing leaves it be
        const wasPlaced = this.placed === view
        if (wasPlaced) this.placed = null
        if ((!gone && contents.isFocused()) || (gone && wasPlaced)) this.releaseKeyboard(tabId)
        // a page made while the window was gone was never added to it
        const win = this.win()
        if (win && win.contentView.children.includes(view)) win.contentView.removeChildView(view)
        this.layout()
      },
      layout: () => this.layout(),
      minimized: () => this.win()?.isMinimized() ?? false
    }
  }

  /** one command of a Claude tab, run by the tab's browser (commands of a tab run one at a time) */
  command(msg: BrowserMessage, closed: AbortSignal): Promise<PipeResponse> {
    if (!this.d.isLocalClaudeTab(msg.tabId)) return Promise.resolve({ ok: false, error: NOT_CLAUDE })
    if (this.win() === null) return Promise.resolve({ ok: false, error: NOT_RUNNING })
    return this.tabFor(msg.tabId).run(msg.command, closed)
  }

  /** the person's action in a tab's Browser panel */
  action(tabId: string, a: BrowserPanelAction): void {
    if (this.d.isLocalClaudeTab(tabId)) this.tabFor(tabId).personAction(a)
  }

  /** what the Browser panel shows for a local Claude tab; null for any other tab */
  state(tabId: string): BrowserPanelState | null {
    return this.d.isLocalClaudeTab(tabId) ? this.tabFor(tabId).state() : null
  }

  /** the tab whose current page the panel shows, and where (the body's rect in window pixels); null shows no page */
  setBounds(tabId: string | null, rect: Rect | null): void {
    const before = this.shownTab
    this.shownTab = tabId
    // a rect with no area shows no page: the page is parked
    const area = rect !== null && rect.width > 0 && rect.height > 0
    this.shownRect = area ? roundRect(rect) : null
    if (area) this.pageSize = { width: Math.round(rect.width), height: Math.round(rect.height) }
    // covered, the still of the tab shown before goes once the panel shows another tab
    if (this.covered && before !== null && before !== tabId) this.d.sendStill(before, null)
    // a restored tab's saved pages are made when its panel first shows a page
    if (area && tabId !== null) this.tabs.get(tabId)?.materialize()
    this.layout()
  }

  /** an overlay of ClaudeTerm covers the panel: the shown page is replaced by a still image of it; when the cover goes, the page comes back */
  setCovered(covered: boolean): void {
    if (covered === this.wantCovered) return
    this.wantCovered = covered
    const seq = ++this.coverSeq
    const tabId = this.shownTab
    if (!covered) {
      this.covered = false
      this.layout()
      if (tabId !== null) this.d.sendStill(tabId, null)
      return
    }
    // the page is captured while it is still shown; then its still goes out, and the page is parked
    const view = this.shownView()
    if (view === null || tabId === null) {
      this.covered = true
      this.layout()
      return
    }
    const park = (): void => {
      if (seq !== this.coverSeq) return
      this.covered = true
      this.layout()
    }
    view.webContents.capturePage().then((image) => {
      if (seq !== this.coverSeq) return
      // the still is for the page the panel shows: a tab shown no more, or removed meanwhile, gets none
      if (this.shownTab === tabId && this.tabs.has(tabId)) this.d.sendStill(tabId, image.toDataURL())
      park()
    }, park)
  }

  /** the Claude tab closed: its running commands stop, its pages close, and nothing about it is sent any more */
  removeTab(tabId: string): void {
    this.gate.removeTab(tabId)
    this.tabs.get(tabId)?.dispose()
    this.tabs.delete(tabId)
    this.lastCard.delete(tabId)
    this.savedSent.delete(tabId)
    if (this.shownTab === tabId) {
      this.shownTab = null
      this.shownRect = null
    }
    this.layout()
    this.d.sendClosed(tabId)
  }

  /** the saved state of a tab's browser, for the session; null when the tab has none */
  saved(tabId: string): BrowserTabState | null {
    return this.tabs.get(tabId)?.saved() ?? null
  }

  /**
   * A restored Claude tab's browser: its profile (Default when that profile no longer exists) and its saved pages, which are
   * made when the tab's panel first shows them or the tab's first command runs.
   */
  restore(tabId: string, s: BrowserTabState): void {
    if (!this.d.isLocalClaudeTab(tabId) || this.tabs.has(tabId)) return
    const profileId = this.d.profiles.has(s.profile) ? s.profile : DEFAULT_PROFILE_ID
    const tab = new TabBrowser(tabId, profileId, this.tabDeps(tabId))
    tab.restoreSaved(s.pages, s.current)
    this.tabs.set(tabId, tab)
    // the restored pages are part of the session now: saved at once, not only at the next change
    this.d.sessionChanged()
  }

  /** a profile was removed from the store: its tabs move to Default, their pages open there again, and its stored data is cleared */
  profileRemoved(id: string): void {
    for (const tab of this.tabs.values()) {
      if (tab.profile() === id) tab.setProfile(DEFAULT_PROFILE_ID)
    }
    void this.clearProfileData(id)
  }

  /** a profile's stored data: its cookies, storage and cache; the sign-ins in it are lost */
  clearProfileData(profileId: string): Promise<void> {
    const ses = session.fromPartition(partitionOf(profileId))
    return ses.clearStorageData()
      .then(() => ses.clearCache())
      .catch((e: unknown) => this.d.log.warn(`cannot clear a profile's data: ${String(e)}`))
  }

  /** the profiles changed: every tab's panel state is sent again, since it names the profiles, and the session is saved */
  profilesChanged(): void {
    for (const tab of this.tabs.values()) this.d.sendState(tab.state())
    this.d.sessionChanged()
  }

  dispose(): void {
    for (const tab of this.tabs.values()) tab.dispose()
    this.tabs.clear()
  }

  private tabFor(tabId: string): TabBrowser {
    const known = this.tabs.get(tabId)
    if (known) return known
    // a fork starts on its parent's profile; any other tab on the default one
    const parent = this.d.forkParent(tabId)
    const profileId = (parent === null ? undefined : this.tabs.get(parent)?.profile()) ?? this.d.profiles.defaultId()
    const tab = new TabBrowser(tabId, profileId, this.tabDeps(tabId))
    this.tabs.set(tabId, tab)
    return tab
  }

  private tabDeps(tabId: string): TabBrowserDeps {
    return {
      stage: this.stage,
      gate: this.gate,
      profiles: () => this.d.profiles.view().profiles.map((p) => ({ id: p.id, name: p.name })),
      configureSession: (profileId) => this.configureSession(profileId),
      manageProfiles: () => this.d.openSettings('browser'),
      defaultProfile: () => this.d.profiles.defaultId(),
      clearData: (profileId) => void this.clearProfileData(profileId),
      changed: () => this.emit(tabId),
      openPanel: () => this.d.openPanel(tabId),
      platform: this.d.platform,
      appKey: (action) => this.d.appKey(action)
    }
  }

  /**
   * The gate shows a card, or none, for a tab. A card the tab has not shown before opens its Browser panel: the person may
   * have closed the panel, and the panel is what answers the card.
   */
  private showCard(tabId: string, card: SiteCard | null): void {
    if (card === null) this.lastCard.delete(tabId)
    else if (this.lastCard.get(tabId) !== card.id) {
      this.lastCard.set(tabId, card.id)
      this.d.openPanel(tabId)
    }
    this.emit(tabId)
  }

  /**
   * The tab's state goes to the window. The session is saved again only when what the tab saves changed: a page's title or
   * a load's progress changes the state, not the session, and a page that changes its title often must not hold off the save.
   */
  private emit(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    this.d.sendState(tab.state())
    const saved = JSON.stringify(tab.saved())
    if (this.savedSent.get(tabId) === saved) return
    this.savedSent.set(tabId, saved)
    this.d.sessionChanged()
  }

  /** a profile's session: no permission but a clipboard write from a page, and every download saved to the downloads folder */
  private configureSession(profileId: string): void {
    if (this.sessionsSet.has(profileId)) return
    this.sessionsSet.add(profileId)
    const ses = session.fromPartition(partitionOf(profileId))
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'))
    ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write')
    ses.on('will-download', (_e, item, wc) => this.download(item, wc))
  }

  private download(item: DownloadItem, wc: WebContents): void {
    const owner = [...this.tabs.values()].find((t) => t.owns(wc))
    if (!owner) {
      item.cancel()
      return
    }
    const dir = this.d.downloadsDir()
    try {
      mkdirSync(dir, { recursive: true })
    } catch (e) {
      // the folder cannot be made: the download is cancelled, and the error is logged (the address is not)
      item.cancel()
      this.d.log.warn(`cannot make the downloads folder: ${String(e)}`)
      return
    }
    const path = uniquePath(dir, item.getFilename(), this.reserved)
    this.reserved.add(pathKey(path))
    item.setSavePath(path)
    item.once('done', () => this.reserved.delete(pathKey(path)))
    owner.trackDownload(item, basename(path))
    this.d.log.info('a page download started')
  }

  private win(): BrowserWindow | null {
    const win = this.d.window()
    return win && !win.isDestroyed() ? win : null
  }

  /** the shown page: the tab's current page, when a rect is set and no overlay covers the panel */
  private shownView(): WebContentsView | null {
    if (this.covered || this.shownTab === null || this.shownRect === null) return null
    return this.tabs.get(this.shownTab)?.currentView() ?? null
  }

  /**
   * Places every page: the parked ones at the window's bottom-right corner, one pixel inside it; the cover over that pixel;
   * the shown page last, on top, at the panel's rect. Re-adding a view moves it to the top.
   */
  private layout(): void {
    const win = this.win()
    if (!win) return
    this.wire(win)
    const [cw, ch] = win.getContentSize()
    const shown = this.shownView()
    const rect = this.shownRect
    const parked: Rectangle = { x: cw - 1, y: ch - 1, width: this.pageSize.width, height: this.pageSize.height }
    for (const tab of this.tabs.values()) {
      for (const view of tab.views()) {
        if (view === shown) continue
        view.setBounds(parked)
      }
    }
    const cover = this.coverOf(win)
    cover.setBounds({ x: cw - 1, y: ch - 1, width: 1, height: 1 })
    win.contentView.addChildView(cover)
    if (shown !== null && rect !== null) {
      shown.setBounds(rect)
      win.contentView.addChildView(shown)
    }
    // the tab's current page is remembered while the cover hides it too: when it closes, the keyboard is handed on from it
    this.placed = rect !== null && this.shownTab !== null ? this.tabs.get(this.shownTab)?.currentView() ?? null : null
    this.parkedKeyboard()
  }

  /**
   * A parked page that has the keyboard hands it on, as the page's tab decides. A covered page keeps it: a toast over the
   * panel must not take the keys of a half-typed field.
   */
  private parkedKeyboard(): void {
    const shown = this.shownView()
    for (const [tabId, tab] of this.tabs) {
      for (const view of tab.views()) {
        if (view === shown || view.webContents.isDestroyed() || !view.webContents.isFocused()) continue
        if (!(this.covered && tabId === this.shownTab)) this.releaseKeyboard(tabId)
        return
      }
    }
  }

  /** the keyboard of a tab's page that left the screen: the tab's page the panel shows now, or else the window */
  private releaseKeyboard(tabId: string): void {
    const next = this.shownTab === tabId ? this.shownView() : null
    this.d.keyboardTo(next === null || next.webContents.isDestroyed() ? null : next.webContents)
  }

  private coverOf(win: BrowserWindow): View {
    if (this.cover === null || this.coverWindow !== win) {
      this.cover = new View()
      this.cover.setBackgroundColor(this.d.coverColor())
      this.coverWindow = win
    }
    return this.cover
  }

  /** the window's resizes and its restores move the corner: the pages are placed again */
  private wire(win: BrowserWindow): void {
    if (this.wiredWindow === win) return
    this.wiredWindow = win
    win.on('resize', () => this.layout())
    win.on('restore', () => this.layout())
    win.on('maximize', () => this.layout())
    win.on('unmaximize', () => this.layout())
    // a page parked while the person was in another app may be refocused by Chromium: the window's focus checks it again, once the window is focused
    win.on('focus', () => setImmediate(() => this.parkedKeyboard()))
  }
}
