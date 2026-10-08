import './styles.css'
import type { AppInfo, RestoreInfo, ImagesUpdate, StatusUpdate } from '../shared/ipc'
import { NOT_RUNNING, type ReviewCounter, type ReviewUpdate } from '../shared/review'
import type { Settings, TabInfo } from '../shared/types'
import { ImagePanel } from './image-panel'
import { SidePanel } from './side-panel'
import { Lightbox } from './lightbox'
import { RecentSessionsWindow } from './recent-sessions'
import { imagePasteInput, mapKey, type KeyAction } from './keymap'
import { SearchBar } from './search'
import { showMenu, type MenuItem } from './menu'
import { RestoreBanner } from './restore-banner'
import { ReviewPanel } from './review-panel'
import { StatusBar } from './status-bar'
import { UpdateBanner } from './update-banner'
import { TabBar } from './tabbar'
import { TerminalView } from './terminal-view'
import { resolveTheme } from './themes'
import { showToast } from './toasts'
import { folderName } from './util'

interface TabState {
  info: TabInfo
  view: TerminalView
  oscTitle: string | null
  bell: boolean
  attention: boolean
  images: number
}

const ct = window.ct
const tabs = new Map<string, TabState>()
let order: string[] = []
let activeId: string | null = null
let settings: Settings
let appInfo: AppInfo
let fontSize = 12
let tabBar: TabBar
let searchBar: SearchBar
let toggleImagePanel = (): void => {}
let restoreInfo: RestoreInfo | null = null
let banner: RestoreBanner
let imagePanel: ImagePanel
let sidePanel: SidePanel
let reviewPanel: ReviewPanel
const reviewUpdates = new Map<string, ReviewUpdate>()
/** tabs whose show_diff should open Changes when they come to the front */
const pendingReveal = new Set<string>()
/** what each tab was sent, in test runs: the e2e tests read what Send wrote */
const inputLog = new Map<string, string>()
let lightbox: Lightbox
let sessionsWindow: RecentSessionsWindow
const imageUpdates = new Map<string, ImagesUpdate>()
let statusBar: StatusBar
let updateBanner: UpdateBanner
const statusUpdates = new Map<string, StatusUpdate>()

const titleOf = (t: TabState): string => t.info.customTitle ?? t.oscTitle ?? folderName(t.info.cwd)

function renderTabs(): void {
  const items = order.flatMap((id) => {
    const t = tabs.get(id)
    return t ? [{ id, title: titleOf(t), kind: t.info.kind, bell: t.bell, attention: t.attention, images: t.images, exited: t.info.exited }] : []
  })
  tabBar.render(items, activeId)
  if (imagePanel) refreshPanelButtons()
  const active = activeId ? tabs.get(activeId) : undefined
  document.title = active ? `${titleOf(active)} — ClaudeTerm` : 'ClaudeTerm'
}

/** the Images and Changes buttons in the tab bar: which panel is shown, the badges, Changes only for a Claude tab */
function refreshPanelButtons(): void {
  const unseen = activeId ? imageUpdates.get(activeId)?.unseen ?? 0 : 0
  tabBar.setImages(sidePanel.isShowing('images'), unseen)
  const claude = !!activeId && tabs.get(activeId)?.info.kind === 'claude'
  tabBar.setChanges(claude, sidePanel.isShowing('changes'), claude && activeId ? reviewUpdates.get(activeId)?.unviewed ?? 0 : 0)
}

function logInput(tabId: string, data: string): void {
  if (appInfo.test) inputLog.set(tabId, (inputLog.get(tabId) ?? '') + data)
}

function handleInput(tabId: string, data: string): void {
  const t = tabs.get(tabId)
  if (!t) return
  logInput(tabId, data)
  if (t.info.exited) {
    if (data === '\r') ct.restartTab(tabId)
    return
  }
  ct.writePty(tabId, data)
}

/** the status bar counter for a tab, unless review.statusBar turned it off */
function counterOf(tabId: string | null): ReviewCounter | null {
  return tabId && settings.review.statusBar ? reviewUpdates.get(tabId)?.counter ?? null : null
}

/** why Send may not write into the tab now, or null */
async function sendRefusal(tabId: string): Promise<string | null> {
  const state = await ct.reviewCanSend(tabId)
  if (!state.ok) return state.reason
  const t = tabs.get(tabId)
  return !t || t.info.exited ? NOT_RUNNING : null
}

/**
 * Send: the same path as pasting text (bracketed when Claude Code asked for it), then Enter on its own. Everything is
 * checked again before the Enter: a dialog may have opened or the session ended meanwhile (the text stays in the prompt).
 * The Enter goes straight to the terminal: Enter in an exited tab would restart the session.
 */
async function sendToClaude(tabId: string, message: string): Promise<string | null> {
  const before = await sendRefusal(tabId)
  if (before !== null) return before
  tabs.get(tabId)?.view.term.paste(message)
  await new Promise((r) => setTimeout(r, 50))
  const refusal = await sendRefusal(tabId)
  if (refusal !== null) return refusal
  logInput(tabId, '\r')
  ct.writePty(tabId, '\r')
  if (tabId === activeId) tabs.get(tabId)?.view.term.focus()
  return null
}

function setFontSize(size: number): void {
  fontSize = Math.min(72, Math.max(6, size))
  for (const t of tabs.values()) t.view.setFont(settings.font.family, fontSize)
}

function cycleTabs(delta: number): void {
  if (order.length === 0) return
  const i = activeId ? order.indexOf(activeId) : -1
  const next = order[(i + delta + order.length) % order.length]
  if (next) ct.activateTab(next)
}

function copySelection(t: TabState): boolean {
  if (!t.view.term.hasSelection()) return false
  ct.writeClipboardText(t.view.term.getSelection())
  t.view.term.clearSelection()
  return true
}

async function paste(t: TabState, allowImage: boolean): Promise<void> {
  const clip = await ct.readClipboard()
  if (clip.text.length > 0) t.view.term.paste(clip.text)
  // image-only clipboard: Claude Code's image-paste key makes claude read the image from the clipboard itself
  else if (allowImage && clip.hasImage) handleInput(t.info.id, imagePasteInput(ct.platform))
}

function runAction(a: KeyAction, tabId: string | null): void {
  const t = tabId ? tabs.get(tabId) : undefined
  switch (a.type) {
    case 'newTab': void ct.openTab({ kind: 'shell', cwd: appInfo.homeDir }); break
    case 'newClaudeTab': void ct.openTab({ kind: 'claude', cwd: t?.info.cwd ?? appInfo.homeDir }); break
    case 'closeTab': if (tabId) ct.closeTab(tabId); break
    case 'nextTab': cycleTabs(1); break
    case 'prevTab': cycleTabs(-1); break
    case 'gotoTab': {
      const id = order[a.index]
      if (id) ct.activateTab(id)
      break
    }
    case 'copy': if (t) copySelection(t); break
    case 'paste': if (t) void paste(t, false); break
    case 'smartPaste': if (t) void paste(t, true); break
    case 'copyOrInterrupt': break
    case 'send': if (tabId) handleInput(tabId, a.data); break
    case 'find': searchBar.open(); break
    case 'toggleImages': toggleImagePanel(); break
    case 'toggleChanges': if (t?.info.kind === 'claude') sidePanel.toggle('changes'); break
    case 'zoomIn': setFontSize(fontSize + 1); break
    case 'zoomOut': setFontSize(fontSize - 1); break
    case 'zoomReset': setFontSize(settings.font.size); break
    case 'openSettings': ct.openSettingsWindow(); break
    case 'recentSessions': void sessionsWindow.open(); break
  }
}

function onTerminalKey(tabId: string, e: KeyboardEvent): boolean {
  const action = mapKey(e)
  if (!action) return true
  if (action.type === 'copyOrInterrupt') {
    const t = tabs.get(tabId)
    if (t && copySelection(t)) {
      e.preventDefault()
      return false
    }
    return true // no selection: let xterm send ^C
  }
  // preventDefault on keydown also suppresses keypress and the native paste event
  e.preventDefault()
  runAction(action, tabId)
  return false
}

function attachTerminalMouse(tabId: string, view: TerminalView): void {
  view.element.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    const t = tabs.get(tabId)
    if (t && !copySelection(t)) void paste(t, true)
  })
  view.element.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
  })
  view.element.addEventListener('drop', (e) => {
    e.preventDefault()
    const paths = Array.from(e.dataTransfer?.files ?? []).map((f) => ct.pathForFile(f)).filter((p) => p.length > 0)
    if (paths.length > 0) handleInput(tabId, paths.map((p) => `"${p}"`).join(' '))
  })
}

function addTab(info: TabInfo): void {
  const view = new TerminalView({
    tabId: info.id,
    container: document.getElementById('terminals')!,
    fontFamily: settings.font.family,
    fontSize,
    theme: resolveTheme(settings.theme),
    scrollback: settings.scrollback,
    windowsBuild: appInfo.windowsBuild,
    useWebgl: !appInfo.test,
    onKey: (e) => onTerminalKey(info.id, e),
    onInput: (data) => handleInput(info.id, data),
    onResize: (cols, rows) => ct.resizePty(info.id, cols, rows),
    onTitle: (title) => {
      const t = tabs.get(info.id)
      if (!t) return
      t.oscTitle = title.trim() || null
      renderTabs()
    },
    onBell: () => ct.bell(info.id),
    onLink: (uri) => ct.openExternal(uri)
  })
  view.show(false)
  attachTerminalMouse(info.id, view)
  tabs.set(info.id, { info, view, oscTitle: null, bell: false, attention: false, images: 0 })
  if (!order.includes(info.id)) order.push(info.id)
  renderTabs()
}

function activate(tabId: string): void {
  activeId = tabId
  const busy = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement
  const focus = !busy
  for (const [id, t] of tabs) t.view.show(id === tabId, focus)
  const t = tabs.get(tabId)
  if (t) {
    t.bell = false
    t.attention = false
  }
  renderTabs()
  const claude = t?.info.kind === 'claude'
  reviewPanel.show(claude ? reviewUpdates.get(tabId) ?? null : null)
  // the images first: setAvailable can switch a shown Changes panel to Images and fire onChange, which must find this tab's images
  imagePanel.show(imageUpdates.get(tabId) ?? { tabId, cards: [], unseen: 0, notice: null })
  sidePanel.setAvailable('changes', claude)
  if (pendingReveal.delete(tabId)) sidePanel.open('changes')
  statusBar.render(statusUpdates.get(tabId) ?? null, counterOf(tabId))
}

function newTabMenu(anchor: HTMLElement): void {
  void ct.listProfiles().then((names) => {
    const active = activeId ? tabs.get(activeId) : undefined
    const items: MenuItem[] = [
      ...names.map((name) => ({ label: name, action: () => void ct.openTab({ kind: 'shell', cwd: appInfo.homeDir, profile: name }) })),
      { label: '', separator: true },
      { label: 'Claude Code', action: () => void ct.openTab({ kind: 'claude', cwd: active?.info.cwd ?? appInfo.homeDir }) },
      { label: 'Recent sessions…', action: () => void sessionsWindow.open() },
      ...(restoreInfo ? [{ label: `Restore previous session (${restoreInfo.tabs})`, action: () => ct.runRestore() }] : []),
      { label: '', separator: true },
      { label: 'Settings…', action: () => ct.openSettingsWindow() },
      { label: `ClaudeTerm ${appInfo.version} — check for updates`, action: () => { updateBanner.reveal(); ct.checkForUpdates() } }
    ]
    const r = anchor.getBoundingClientRect()
    showMenu({ x: r.left, y: r.bottom }, items)
  })
}

function tabMenu(id: string, at: { x: number; y: number }): void {
  const t = tabs.get(id)
  if (!t) return
  showMenu(at, [
    { label: t.info.kind === 'claude' ? 'Restart session' : 'Restart shell', action: () => ct.restartTab(id, true) },
    { label: '', separator: true },
    { label: 'Close tab', action: () => ct.closeTab(id) }
  ])
}

function applySettings(s: Settings): void {
  const prev = settings
  settings = s
  // a change to some other setting keeps the Ctrl+= zoom
  if (s.font.family !== prev.font.family || s.font.size !== prev.font.size) {
    fontSize = s.font.size
    for (const t of tabs.values()) t.view.setFont(s.font.family, fontSize)
  }
  if (JSON.stringify(s.theme) !== JSON.stringify(prev.theme)) {
    const theme = resolveTheme(s.theme)
    for (const t of tabs.values()) t.view.setTheme(theme)
  }
  if (activeId) statusBar.render(statusUpdates.get(activeId) ?? null, counterOf(activeId))
}

async function boot(): Promise<void> {
  appInfo = await ct.appInfo()
  settings = await ct.getSettings()
  fontSize = settings.font.size
  tabBar = new TabBar(document.getElementById('tabbar')!, {
    activate: (id) => ct.activateTab(id),
    close: (id) => ct.closeTab(id),
    rename: (id, title) => ct.renameTab(id, title),
    reorder: (ids) => ct.reorderTabs(ids),
    newTab: () => void ct.openTab({ kind: 'shell', cwd: appInfo.homeDir }),
    openMenu: (anchor) => newTabMenu(anchor),
    tabMenu,
    toggleImages: () => {
      runAction({ type: 'toggleImages' }, activeId)
      if (activeId) tabs.get(activeId)?.view.term.focus()
    },
    toggleChanges: () => {
      runAction({ type: 'toggleChanges' }, activeId)
      if (activeId) tabs.get(activeId)?.view.term.focus()
    }
  })
  searchBar = new SearchBar(
    document.getElementById('search')!,
    () => (activeId ? tabs.get(activeId)?.view.search ?? null : null),
    () => { if (activeId) tabs.get(activeId)?.view.term.focus() }
  )
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null
    if (target?.closest('.xterm') || target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return
    const a = mapKey(e)
    if (!a || a.type === 'send' || a.type === 'copyOrInterrupt' || a.type === 'smartPaste' || a.type === 'paste' || a.type === 'copy') return
    e.preventDefault()
    runAction(a, activeId)
  })
  // a file dropped outside a terminal must not navigate the window
  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', (e) => e.preventDefault())
  lightbox = new Lightbox(document.getElementById('lightbox')!)
  sessionsWindow = new RecentSessionsWindow(document.getElementById('sessions')!, {
    load: () => ct.listSessions(),
    open: (id) => ct.openSession(id),
    closed: () => { if (activeId) tabs.get(activeId)?.view.term.focus() }
  })
  statusBar = new StatusBar(document.getElementById('statusbar')!, () => sidePanel.open('changes'))
  updateBanner = new UpdateBanner(document.getElementById('update-banner')!, () => ct.installUpdate())
  ct.onUpdate((s) => updateBanner.update(s))
  void ct.getUpdateState().then((s) => updateBanner.update(s))
  ct.onStatus((u) => {
    statusUpdates.set(u.tabId, u)
    if (u.tabId === activeId) statusBar.render(u, counterOf(u.tabId))
  })
  ct.onAttention((tabId, reason) => {
    const t = tabs.get(tabId)
    if (!t || tabId === activeId) return
    if (reason === 'bell') t.bell = true
    else t.attention = true
    renderTabs()
  })
  sidePanel = new SidePanel(document.getElementById('image-panel')!, { images: settings.imagePanel.width, changes: settings.review.width })
  imagePanel = new ImagePanel(
    sidePanel.bodies.images,
    sidePanel,
    {
      action: (id, action) => ct.imageAction(id, action),
      insertPath: (p) => {
        if (!activeId) return
        handleInput(activeId, `"${p}" `)
        tabs.get(activeId)?.view.term.focus()
      },
      open: (cards, index) => lightbox.open(cards, index),
      markSeen: (tabId) => ct.markImagesSeen(tabId)
    },
    () => settings.imagePanel.autoOpen
  )
  toggleImagePanel = () => imagePanel.toggle()
  reviewPanel = new ReviewPanel(
    sidePanel.bodies.changes,
    sidePanel,
    {
      setScope: (id, scope) => ct.setReviewScope(id, scope),
      clearRequest: (id) => ct.clearReviewRequest(id),
      refresh: (id) => ct.refreshReview(id),
      setViewed: (id, path, hash, viewed) => ct.setReviewViewed(id, path, hash, viewed),
      showFile: (id, path) => ct.showReviewFile(id, path),
      openEditor: (id, path, line) => ct.openInEditor(id, path, line),
      copyText: (text) => ct.writeClipboardText(text),
      send: (id, message) => sendToClaude(id, message)
    },
    ct.platform
  )
  sidePanel.onChange = () => {
    imagePanel.panelChanged()
    reviewPanel.panelChanged()
    refreshPanelButtons()
  }
  ct.onReview((u) => {
    reviewUpdates.set(u.tabId, u)
    if (u.reveal) pendingReveal.add(u.tabId)
    if (u.tabId !== activeId) return
    reviewPanel.show(u)
    refreshPanelButtons()
    if (pendingReveal.delete(u.tabId)) sidePanel.open('changes')
    statusBar.render(statusUpdates.get(u.tabId) ?? null, counterOf(u.tabId))
  })
  refreshPanelButtons()
  ct.onImages((u) => {
    imageUpdates.set(u.tabId, u)
    const t = tabs.get(u.tabId)
    if (t) {
      t.images = u.unseen
      renderTabs()
    }
    if (u.tabId === activeId) imagePanel.show(u)
    refreshPanelButtons()
  })
  ct.onTabOpened(addTab)
  ct.onTabUpdated((info) => {
    const t = tabs.get(info.id)
    if (!t) return
    t.info = info
    renderTabs()
  })
  ct.onTabClosed((id) => {
    const t = tabs.get(id)
    if (!t) return
    t.view.dispose()
    tabs.delete(id)
    imageUpdates.delete(id)
    statusUpdates.delete(id)
    reviewUpdates.delete(id)
    reviewPanel.dropTab(id)
    pendingReveal.delete(id)
    inputLog.delete(id)
    order = order.filter((x) => x !== id)
    if (activeId === id) {
      activeId = null
      statusBar.render(null)
    }
    renderTabs()
  })
  ct.onTabActivated(activate)
  ct.onTabsOrder((ids) => {
    order = ids.filter((id) => tabs.has(id))
    renderTabs()
  })
  ct.onPtyData((id, data) => tabs.get(id)?.view.write(data))
  ct.onPtyReset((id) => {
    const t = tabs.get(id)
    if (!t) return
    t.view.reset()
    // the stopped process's title and marks don't describe the new one
    t.oscTitle = null
    t.bell = false
    t.attention = false
    renderTabs()
  })
  ct.onPtyExit((id, code) => tabs.get(id)?.view.write(`\r\n\x1b[90m[process exited with code ${code}] Enter — restart, Ctrl+Shift+W — close\x1b[0m\r\n`))
  ct.onToast((m) => showToast(m))
  ct.onSettings(applySettings)
  window.addEventListener('focus', () => {
    if (sessionsWindow.isOpen) return
    if (document.activeElement?.closest('#image-panel')) return
    const t = activeId ? tabs.get(activeId) : undefined
    t?.view.term.focus()
  })
  banner = new RestoreBanner(document.getElementById('banner')!, () => ct.runRestore())
  restoreInfo = await ct.getRestoreInfo()
  banner.update(restoreInfo)
  ct.onRestore((info) => {
    restoreInfo = info
    banner.update(info)
  })
  if (appInfo.test) {
    window.__ct = {
      images: (id) => (imageUpdates.get(id ?? activeId ?? '')?.cards ?? []).map((c) => ({ name: c.name, source: c.source, caption: c.caption })),
      restoreVisible: () => !document.getElementById('banner')!.hidden,
      activeTabId: () => activeId,
      tabIds: () => [...order],
      tabTitle: (id) => {
        const t = tabs.get(id)
        return t ? titleOf(t) : null
      },
      ptyInput: (id) => inputLog.get(id ?? activeId ?? '') ?? '',
      bufferText: (id) => tabs.get(id ?? activeId ?? '')?.view.bufferText() ?? '',
      themeBackground: () => (activeId ? tabs.get(activeId)?.view.term.options.theme?.background ?? null : null)
    }
  }
  ct.rendererReady()
}

void boot()
