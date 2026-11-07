import './styles.css'
import { MAIN_ACCOUNT, type AccountView } from '../shared/accounts'
import type { AppInfo, RestoreInfo, ImagesUpdate, PlanUpdate, StatusUpdate } from '../shared/ipc'
import type { DocsUpdate } from '../shared/docs'
import { NOT_RUNNING, type ReviewCounter, type ReviewUpdate } from '../shared/review'
import { deviceColor, MAX_SNAPSHOT_BYTES, REMOTE_COPY, type DeviceAnswer, type DeviceChoices, type RemoteDeviceView } from '../shared/remote'
import type { NotificationCase, Settings, TabInfo, TabPlace, TabPosition } from '../shared/types'
import { accountChoices, accountLabel, switchChoices } from './account-items'
import { DocPanel } from './doc-panel'
import { ImagePanel } from './image-panel'
import { SidePanel } from './side-panel'
import { Lightbox } from './lightbox'
import { PlanList } from './plan-list'
import { RecentSessionsWindow } from './recent-sessions'
import { imagePasteInput, imagePasteRoute, mapKey, shortcutLabel, type KeyAction } from './keymap'
import { SearchBar } from './search'
import { closeMenu, menuIsOpen, showMenu, type MenuItem } from './menu'
import { NoteOverlay } from './note-overlay'
import { RestoreBanner } from './restore-banner'
import { ReviewPanel } from './review-panel'
import { StatusBar } from './status-bar'
import { UpdateBanner } from './update-banner'
import { TabBar, type TabBarCallbacks, type TabBarGroup, type TabBarItem } from './tabbar'
import { shownActivity } from './tab-row'
import { TabPanel } from './tab-panel'
import { orderToWrite, tabBarOrder } from './tab-groups'
import { TerminalView } from './terminal-view'
import { resolveTheme } from './themes'
import { showToast } from './toasts'
import { promptText } from './claude-screen'
import { leftUnfinished } from './unread'
import { FrontFallback } from './front-fallback'
import { FolderDialog } from './folder-dialog'
import { claudeTitle, folderName } from './util'

interface TabState {
  info: TabInfo
  view: TerminalView
  oscTitle: string | null
  bell: boolean
  attention: boolean
  /** marked unread, or left unfinished: it pulses on this device until it is opened here, whatever the other devices do */
  unread: boolean
  /** Mark as unread on the tab in front: it pulses once it is left */
  unreadOnLeave: boolean
  images: number
}

const ct = window.ct
const tabs = new Map<string, TabState>()
let order: string[] = []
let activeId: string | null = null
/** the tab to bring to the front when the one in front closes and main activates none */
const frontFallback = new FrontFallback()
let settings: Settings
let appInfo: AppInfo
let fontSize = 12
let tabBar: TabBar
let tabPanel: TabPanel
/** where each tab's folder is in git, as main last published it: null for a folder outside git; no entry until git has answered */
const places = new Map<string, TabPlace | null>()
let noteOverlay: NoteOverlay
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
let docPanel: DocPanel
const docUpdates = new Map<string, DocsUpdate>()
/** tabs whose show_document should open Docs on the document it showed, when they come to the front: tab id → document id */
const pendingDocReveal = new Map<string, string>()
/** what each tab was sent, in test runs: the e2e tests read what Send wrote */
const inputLog = new Map<string, string>()
/** every size each tab's terminal gave its process, in test runs */
const sizeLog = new Map<string, string[]>()
/** every place event each tab got, in test runs: a null place is kept apart from no event */
const placeLog = new Map<string, (TabPlace | null)[]>()
let lightbox: Lightbox
let sessionsWindow: RecentSessionsWindow
let folderDialog: FolderDialog
let planList: PlanList
const imageUpdates = new Map<string, ImagesUpdate>()
let statusBar: StatusBar
let updateBanner: UpdateBanner
const statusUpdates = new Map<string, StatusUpdate>()
const planUpdates = new Map<string, PlanUpdate>()
/** the extra accounts, without their tokens */
let accounts: AccountView[] = []
/** the other devices of the group, by name: their tabs are groups of the tab bar, in this order */
let remoteDevices: RemoteDeviceView[] = []
/** whether the devices came in as an event: then the answer to the first request is older and is not applied */
let remoteDevicesSeen = false
/** the devices whose tabs are folded into their chip */
const folded = new Set<string>()
/** a remote device's tabs in the order this window dragged them to; the tabs that came since follow in arrival order */
const remoteOrder = new Map<string, string[]>()
/** this device's name, and each online device's last answer to the new-tab menu's lists (value null: not answered yet) */
let choices: { self: string; devices: DeviceAnswer<DeviceChoices>[] } = { self: '', devices: [] }
/** counts the answers that came as events: an answer to a request sent before the latest event is older and is not applied */
let choicesSeq = 0
// how many times the window asked the devices for their lists: the test hook counts them
let choiceAsks = 0
/** the latest request of a new-tab menu or a chip menu: an earlier one that answers later opens nothing */
let menuSeq = 0
/** the menu of the new tabs or of a device's chip, drawn again in place when the answers change while it is open */
let choiceMenu: { el: HTMLElement; at: { x: number; y: number }; build: () => MenuItem[] } | null = null

/** a tab pulses while Claude waits in it, or while it is marked unread */
const pulsing = (t: TabState | undefined): boolean => t !== undefined && (t.attention || t.unread)

/** a fork's title gets ` (fork)` after the usual one, unless the user named the tab */
const titleOf = (t: TabState): string => t.info.customTitle ?? `${t.oscTitle ?? t.info.remote?.title ?? folderName(t.info.folder)}${t.info.fork ? ' (fork)' : ''}`

/** where a new tab opens: the defaultFolder setting, else the home folder */
const defaultFolder = (): string => settings.defaultFolder ?? appInfo.homeDir

const remoteDeviceOf = (id: string): RemoteDeviceView | undefined => remoteDevices.find((d) => d.id === id)
const isOnline = (deviceId: string): boolean => remoteDeviceOf(deviceId)?.online === true

/** a remote device's tabs in this window's order: as dragged here, or with each fork after its family (tabBarOrder) */
function groupTabs(deviceId: string): string[] {
  const here = order.filter((id) => tabs.get(id)?.info.remote?.device === deviceId)
  return tabBarOrder(here.map((id) => ({ id, forkOf: tabs.get(id)?.info.fork?.of ?? null })), remoteOrder.get(deviceId) ?? [])
}

/** this device's tabs, then the tabs of the groups not folded: the order Next, Previous and Go to tab walk */
function visibleOrder(): string[] {
  const own = order.filter((id) => !tabs.get(id)?.info.remote)
  return [...own, ...remoteDevices.filter((d) => !folded.has(d.id)).flatMap((d) => groupTabs(d.id))]
}

function tabBarItem(id: string): TabBarItem | null {
  const t = tabs.get(id)
  if (!t) return null
  const remote = t.info.remote
  return {
    id,
    title: titleOf(t),
    folder: t.info.folder,
    kind: t.info.kind,
    muted: t.info.muted,
    bell: t.bell,
    attention: pulsing(t),
    activity: t.info.activity,
    // a remote tab's unseen Media count is its device's, as the directory gives it
    images: remote ? remote.images : t.images,
    exited: t.info.exited,
    note: noteOverlay.hasText(id),
    place: places.get(id) ?? null,
    forkOf: t.info.fork?.of ?? null,
    group: remote?.device ?? null,
    deviceName: remote ? remoteDeviceOf(remote.device)?.name ?? null : null,
    dim: remote !== undefined && !isOnline(remote.device)
  }
}

function renderTabs(): void {
  // this device's tabs first, then each device's group in the order of the devices
  const ids = [...order.filter((id) => !tabs.get(id)?.info.remote), ...remoteDevices.flatMap((d) => groupTabs(d.id))]
  const items = ids.flatMap((id) => {
    const item = tabBarItem(id)
    return item ? [item] : []
  })
  const itemOf = new Map(items.map((item) => [item.id, item]))
  const groups: TabBarGroup[] = remoteDevices.map((d) => {
    const tabsOf = groupTabs(d.id)
    return {
      id: d.id,
      name: d.name,
      color: deviceColor(d.id),
      online: d.online,
      folded: folded.has(d.id),
      count: tabsOf.length,
      attention: tabsOf.some((id) => pulsing(tabs.get(id))),
      working: tabsOf.some((id) => { const item = itemOf.get(id); return item !== undefined && shownActivity(item) !== null })
    }
  })
  tabBar.render(items, activeId, groups)
  // the left panel shows this device's groups, then a section per device with tabs: the same items and groups as the tab bar
  tabPanel.render(items, activeId, groups)
  // on the left, the order is the panel's: main takes it when it differs, so the tab order follows the groups (the next render finds them equal).
  // Not before every tab's place is known: until then a tab sits in No project and that temporary order must not reach main.
  // A remote tab's id never reaches main: its order is its device's
  if (settings.tabs.position === 'left') {
    const own = order.filter((id) => !tabs.get(id)?.info.remote)
    const next = orderToWrite(own, tabPanel.visualOrder, own.every((id) => places.has(id)))
    if (next) ct.reorderTabs(next)
  }
  if (imagePanel) refreshPanelButtons()
  renderTitle()
  reportAttentionCount()
}

/** the tab bar on top or the left panel, whichever the tabs.position setting names; the other one is hidden */
function showTabs(position: TabPosition): void {
  // the panel is shown only once its element is: the active row is revealed by scrolling, which a hidden element cannot do
  document.getElementById('tabbar')!.hidden = position !== 'top'
  document.getElementById('tabpanel')!.hidden = position !== 'left'
  tabBar.show(position === 'top')
  tabPanel.show(position === 'left')
}

/** the device a tab runs on, or null for this device's own tab */
const groupOf = (tabId: string | null): string | null => (tabId ? tabs.get(tabId)?.info.remote?.device ?? null : null)

/** folds or unfolds a device's chip; folding the group of the tab in front brings the first visible tab to the front */
function toggleGroup(deviceId: string): void {
  if (folded.has(deviceId)) {
    folded.delete(deviceId)
  } else {
    folded.add(deviceId)
    if (groupOf(activeId) === deviceId) {
      const next = visibleOrder()[0]
      // with no other tab to show, the group stays open: the tab in front must not be hidden
      if (next) ct.activateTab(next)
      else folded.delete(deviceId)
    }
  }
  renderTabs()
}

function renderTitle(): void {
  const active = activeId ? tabs.get(activeId) : undefined
  if (!active) {
    document.title = 'ClaudeTerm'
    return
  }
  // the folder's name tells the projects of several windows and tabs apart, in the taskbar and Alt+Tab too
  const title = titleOf(active)
  const folder = folderName(active.info.folder)
  // and an extra account the subscription; the main account is the usual one and is left out, a remote tab's too (its device's own title leaves it out)
  const account = active.info.remote ? active.info.remote.accountName : active.info.kind === 'claude' && active.info.account !== null ? accountLabel(active.info.account, accounts) : null
  document.title = [title, ...(folder === title ? [] : [folder]), ...(account === null ? [] : [account]), 'ClaudeTerm'].join(' — ')
}

/** the Media, Changes, Docs and Note buttons in the tab bar and the left panel: which panel or note is shown, the badges, Changes and Note only for a Claude tab */
function refreshPanelButtons(): void {
  const unseen = activeId ? imageUpdates.get(activeId)?.unseen ?? 0 : 0
  const claude = !!activeId && tabs.get(activeId)?.info.kind === 'claude'
  const unviewed = claude && activeId ? reviewUpdates.get(activeId)?.unviewed ?? 0 : 0
  const docs = claude && (docUpdates.get(activeId ?? '')?.docs.length ?? 0) > 0
  for (const bar of [tabBar, tabPanel]) {
    bar.setImages(sidePanel.isShowing('images'), unseen)
    bar.setChanges(claude, sidePanel.isShowing('changes'), unviewed)
    bar.setDocs(docs, sidePanel.isShowing('docs'))
    bar.setNote(claude, claude && noteOverlay.isShown())
  }
}

function logInput(tabId: string, data: string): void {
  if (appInfo.test) inputLog.set(tabId, (inputLog.get(tabId) ?? '') + data)
}

/** a tab on a device that is offline takes no input */
function writable(t: TabState): boolean {
  return !t.info.remote || isOnline(t.info.remote.device)
}

/** the one way the window writes into a tab: nothing is logged or sent to a tab that is not writable */
function writeToTab(tabId: string, data: string): void {
  const t = tabs.get(tabId)
  if (!t || !writable(t)) return
  logInput(tabId, data)
  ct.writePty(tabId, data)
}

function handleInput(tabId: string, data: string): void {
  const t = tabs.get(tabId)
  if (!t) return
  if (!t.info.exited) {
    writeToTab(tabId, data)
    return
  }
  if (!writable(t)) return
  logInput(tabId, data)
  if (data === '\r') ct.restartTab(tabId)
}

/** the status bar counter for a tab, unless review.statusBar turned it off */
function counterOf(tabId: string | null): ReviewCounter | null {
  return tabId && settings.review.statusBar ? reviewUpdates.get(tabId)?.counter ?? null : null
}

/** the status bar's account: a Claude tab's, once extra accounts exist, or while it still runs on one deleted since */
function accountOf(tabId: string | null): string | null {
  const t = tabId ? tabs.get(tabId) : undefined
  if (t?.info.kind !== 'claude') return null
  // a remote tab names the account of its own device: the main account's label when it runs on that
  // (the main account only when its device has extra accounts, as the device's own window shows it)
  if (t.info.remote) {
    const device = t.info.remote.device
    const extra = (choices.devices.find((d) => d.device === device)?.value?.accounts.length ?? 0) > 0
    return t.info.remote.accountName ?? (extra ? MAIN_ACCOUNT : null)
  }
  return accounts.length > 0 || t.info.account !== null ? accountLabel(t.info.account, accounts) : null
}

function renderStatus(tabId: string): void {
  statusBar.render(statusUpdates.get(tabId) ?? null, counterOf(tabId), accountOf(tabId), planUpdates.get(tabId)?.plan ?? null, settings.claude.limitPace)
}

/** Continue as …: the tab's conversation restarts on another account */
function continueItems(tabId: string): MenuItem[] {
  const t = tabs.get(tabId)
  if (t?.info.kind !== 'claude') return []
  // a remote tab continues on the accounts of its own device, as that device answered them
  const list = t.info.remote ? choices.devices.find((d) => d.device === t.info.remote!.device)?.value?.accounts.map((a) => ({ ...a, readable: true })) ?? [] : accounts
  return switchChoices(t.info.account, list).map((c) => ({ label: `Continue as ${c.label}`, disabled: c.disabled, action: () => ct.switchAccount(tabId, c.account) }))
}

/** why Send may not write into the tab now, or null */
async function sendRefusal(tabId: string): Promise<string | null> {
  const t = tabs.get(tabId)
  if (t && t.info.remote && !writable(t)) return REMOTE_COPY.deviceOffline(remoteDeviceOf(t.info.remote.device)?.name ?? t.info.remote.device)
  const state = await ct.reviewCanSend(tabId)
  if (!state.ok) return state.reason
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
  writeToTab(tabId, '\r')
  if (tabId === activeId) tabs.get(tabId)?.view.term.focus()
  return null
}

function setFontSize(size: number): void {
  fontSize = Math.min(72, Math.max(6, size))
  for (const t of tabs.values()) t.view.setFont(settings.font.family, fontSize)
}

/** the tab ids in the order the shown tab bar lists them: on the left, the panel's (this device's groups, then each unfolded device section) */
function shownOrder(): string[] {
  return settings.tabs.position === 'left' ? [...tabPanel.visualOrder, ...tabPanel.deviceOrder(folded)] : visibleOrder()
}

function cycleTabs(delta: number): void {
  const seq = shownOrder()
  if (seq.length === 0) return
  const i = activeId ? seq.indexOf(activeId) : -1
  const next = seq[(i + delta + seq.length) % seq.length]
  if (next) ct.activateTab(next)
}

/** the next tab after the active one, in the order shown, that needs the user; none: nothing changes */
function nextWaiting(): void {
  // the tabs of folded devices come last: the jump reaches every tab the app icon counts
  const seq = [...shownOrder(), ...remoteDevices.filter((d) => folded.has(d.id)).flatMap((d) => groupTabs(d.id))]
  const i = activeId ? seq.indexOf(activeId) : -1
  for (let k = 1; k <= seq.length; k++) {
    const id = seq[(i + k) % seq.length]!
    if (id !== activeId && pulsing(tabs.get(id))) {
      ct.activateTab(id)
      return
    }
  }
}

const BANNER_TEXT: Record<NotificationCase, string> = {
  permission: 'Claude is waiting for your permission',
  question: 'Claude has a question for you',
  done: 'Claude finished its turn',
  peer: 'Claude finished replying to another session',
  bell: 'The bell rang in this tab'
}

interface Banner {
  title: string
  body: string
  click(): void
  close(): void
}

/** the system notification of each tab, until the tab is opened or closed; a newer one of the tab takes its place */
const banners = new Map<string, Banner>()

function showBanner(tabId: string, reason: NotificationCase): void {
  const t = tabs.get(tabId)
  if (!t) return
  closeBanner(tabId)
  const title = titleOf(t)
  const body = BANNER_TEXT[reason]
  const click = (): void => {
    ct.focusWindow()
    ct.activateTab(tabId)
  }
  // a test run shows none on the desktop: it keeps them for the test to read and click
  if (appInfo.test) {
    banners.set(tabId, { title, body, click, close: () => {} })
    return
  }
  // silent: the sound, if any, is the one set for the case
  const n = new Notification(title, { body, silent: true })
  n.onclick = click
  banners.set(tabId, { title, body, click, close: () => n.close() })
}

function closeBanner(tabId: string): void {
  banners.get(tabId)?.close()
  banners.delete(tabId)
}

/** the count on the app icon, as main was last told it */
let attentionCount = 0

function reportAttentionCount(): void {
  let count = 0
  for (const t of tabs.values()) if (pulsing(t)) count++
  if (count === attentionCount) return
  attentionCount = count
  ct.setAttentionCount(count)
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
  else if (allowImage && clip.hasImage) await pasteImage(t)
}

/**
 * An image-only clipboard. Claude Code's image-paste key makes claude read the image from the clipboard itself, but on
 * Windows it reads it through PowerShell, which fails where a policy keeps PowerShell in Constrained Language mode. There
 * the image goes to Claude as the pasted path of a PNG file, which Claude Code attaches as the image itself. In a remote tab the
 * image is copied to the tab's device, and the path it was saved at there is typed.
 */
async function pasteImage(t: TabState): Promise<void> {
  const remote = t.info.remote !== undefined
  // the PNG file route is asked for a local tab on Windows only
  const asFile = !remote && ct.platform === 'win32' && (await ct.imagePasteAsFile())
  const route = imagePasteRoute({ platform: ct.platform, remote, asFile })
  if (route === 'remote') {
    const path = await ct.pasteImageToRemote(t.info.id)
    if (path) t.view.term.paste(`"${path}"`)
  } else if (route === 'file') {
    const file = await ct.saveClipboardImage()
    if (file) t.view.term.paste(`"${file}"`)
  } else {
    handleInput(t.info.id, imagePasteInput(ct.platform))
  }
}

function runAction(a: KeyAction, tabId: string | null): void {
  const t = tabId ? tabs.get(tabId) : undefined
  switch (a.type) {
    case 'newTab': void ct.openTab({ kind: 'shell', cwd: defaultFolder() }); break
    case 'newClaudeTab': void ct.openTab({ kind: 'claude', cwd: folderFor(t) }); break
    case 'closeTab': if (tabId) ct.closeTab(tabId); break
    case 'nextTab': cycleTabs(1); break
    case 'prevTab': cycleTabs(-1); break
    case 'gotoTab': {
      const id = shownOrder()[a.index]
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
    case 'toggleDocs': sidePanel.toggle('docs'); break
    case 'toggleNote': {
      if (t?.info.kind !== 'claude') break
      // a note shown under the Changes panel expanded over the whole window would be unseen: the panel takes its width back first
      if (!noteOverlay.isShown() && sidePanel.expanded) sidePanel.setExpanded(false)
      noteOverlay.toggle()
      break
    }
    case 'zoomIn': setFontSize(fontSize + 1); break
    case 'zoomOut': setFontSize(fontSize - 1); break
    case 'zoomReset': setFontSize(settings.font.size); break
    case 'openSettings': ct.openSettingsWindow(); break
    case 'recentSessions': void sessionsWindow.open(); break
    case 'nextWaiting': nextWaiting(); break
  }
}

function onTerminalKey(tabId: string, e: KeyboardEvent): boolean {
  const action = mapKey(e, ct.platform)
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
    if (paths.length === 0) return
    // a remote tab's files are copied to its device first: the paths typed are the ones they were saved at there
    if (tabs.get(tabId)?.info.remote) {
      void ct.dropFilesToRemote(tabId, paths).then((copied) => {
        if (copied) handleInput(tabId, copied.map((p) => `"${p}"`).join(' '))
      })
      return
    }
    handleInput(tabId, paths.map((p) => `"${p}"`).join(' '))
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
    onResize: (cols, rows) => {
      if (appInfo.test) sizeLog.set(info.id, [...sizeLog.get(info.id) ?? [], `${cols}x${rows}`])
      ct.resizePty(info.id, cols, rows)
    },
    onTitle: (title) => {
      const t = tabs.get(info.id)
      if (!t) return
      t.oscTitle = (t.info.kind === 'claude' ? claudeTitle(title.trim()) : title.trim()) || null
      renderTabs()
    },
    onBell: () => ct.bell(info.id),
    onLink: (uri) => ct.openExternal(uri),
    onClipboard: (text) => ct.writeClipboardText(text)
  })
  view.show(false)
  attachTerminalMouse(info.id, view)
  tabs.set(info.id, { info, view, oscTitle: null, bell: false, attention: false, unread: false, unreadOnLeave: false, images: 0 })
  if (!order.includes(info.id)) order.push(info.id)
  renderTabs()
}

/**
 * A tab left with something unfinished pulses as one Claude waits in: marked unread, or a Claude tab whose reply is not
 * read to its end or whose prompt holds a draft (notifications.autoUnread).
 */
function leave(t: TabState): void {
  const unfinished = settings.notifications.autoUnread && t.info.kind === 'claude' && !t.info.exited && leftUnfinished(t.view.screen())
  if (t.unreadOnLeave || unfinished) t.unread = true
  t.unreadOnLeave = false
}

function markUnread(tabId: string): void {
  const t = tabs.get(tabId)
  if (!t) return
  if (tabId === activeId) t.unreadOnLeave = true
  else t.unread = true
  renderTabs()
}

/** the Docs panel shows the tab's documents; a document show_document showed is selected, and the panel opens on it */
function showDocs(tabId: string, claude: boolean): void {
  const update = claude ? docUpdates.get(tabId) : undefined
  const reveal = pendingDocReveal.get(tabId) ?? null
  pendingDocReveal.delete(tabId)
  docPanel.show({ tabId, docs: update?.docs ?? [], reveal })
  sidePanel.setAvailable('docs', (update?.docs.length ?? 0) > 0)
  if (reveal !== null) sidePanel.open('docs')
}

function activate(tabId: string): void {
  const left = activeId !== null && activeId !== tabId ? tabs.get(activeId) : undefined
  if (left) leave(left)
  activeId = tabId
  frontFallback.activated(tabId)
  planList.close()
  const busy = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement
  const focus = !busy
  for (const [id, t] of tabs) t.view.show(id === tabId, focus)
  const t = tabs.get(tabId)
  if (t) {
    t.bell = false
    t.attention = false
    t.unread = false
  }
  closeBanner(tabId)
  // the tab in front is never under a folded chip: its device's group opens
  const device = groupOf(tabId)
  if (device !== null) folded.delete(device)
  const claude = t?.info.kind === 'claude'
  // before the tabs are drawn: the Note button shows whether this tab's note is shown
  noteOverlay.show(tabId, claude)
  renderTabs()
  // the left panel's group of a tab is known once git has answered for its folder (see onTabPlace)
  if (settings.tabs.position === 'left' && places.has(tabId)) tabPanel.unfoldFor(tabId)
  reviewPanel.show(claude ? reviewUpdates.get(tabId) ?? null : null)
  // the images first: setAvailable can switch a shown Changes panel to Images and fire onChange, which must find this tab's images
  imagePanel.show(imageUpdates.get(tabId) ?? { tabId, cards: [], unseen: 0, notice: null })
  sidePanel.setAvailable('changes', claude)
  if (pendingReveal.delete(tabId)) sidePanel.open('changes')
  showDocs(tabId, claude)
  renderStatus(tabId)
}

/** the folder a new Claude tab of this device opens in: the tab in front's when that is this device's; another device's path is never this machine's */
const folderFor = (t: TabState | undefined): string => (t && !t.info.remote ? t.info.cwd : defaultFolder())

/** the device answers, asked now: an answer that came as an event meanwhile is newer and is kept */
function requestChoices(then: () => void): void {
  const seq = choicesSeq
  choiceAsks++
  void ct.listDeviceChoices().then((view) => {
    if (seq === choicesSeq) choices = view
    then()
  })
}

/** a new-tab or chip menu: its own list (`more`) and the device answers are asked at once; a menu asked for later wins */
function menuRequest<T>(more: Promise<T>, show: (x: T) => void): void {
  const seq = ++menuSeq
  const answers = choicesSeq
  choiceAsks++
  void Promise.all([more, ct.listDeviceChoices()]).then(([x, view]) => {
    if (seq !== menuSeq) return
    if (answers === choicesSeq) choices = view
    show(x)
  })
}

/** an open new-tab or chip menu is drawn again with the answers as they are now: a device that came online gains its section */
function refreshChoiceMenu(): void {
  if (choiceMenu && menuIsOpen(choiceMenu.el)) requestChoices(redrawChoiceMenu)
}

/** shows a menu drawn from the answers it has, and draws it again in place when they change while it is open */
function showChoiceMenu(at: { x: number; y: number }, build: () => MenuItem[]): void {
  choiceMenu = { el: showMenu(at, build()), at, build }
}

function redrawChoiceMenu(): void {
  const m = choiceMenu
  if (!m) return
  if (!menuIsOpen(m.el)) {
    choiceMenu = null
    return
  }
  m.el = showMenu(m.at, m.build())
}

/** one device's entries of the new-tab menu: its name, its profiles, Claude Code and its accounts; loading until it answers */
function deviceSection(d: DeviceAnswer<DeviceChoices>): MenuItem[] {
  const head: MenuItem[] = [{ label: '', separator: true }, { label: d.name, disabled: true }]
  if (d.value === null) return [...head, { label: REMOTE_COPY.loading, disabled: true }]
  return [
    ...head,
    ...d.value.profiles.map((p) => ({ label: p, action: () => void ct.openRemoteTab(d.device, 'shell', p, null) })),
    { label: '', separator: true },
    { label: 'Claude Code', action: () => void ct.openRemoteTab(d.device, 'claude', null, null) },
    ...d.value.accounts.map((a) => ({ label: `Claude Code — ${a.name}`, action: () => void ct.openRemoteTab(d.device, 'claude', null, a.id) }))
  ]
}

/** the new-tab menu: this device's entries, then each online device's; without one, the menu is this device's alone */
function newTabItems(names: string[]): MenuItem[] {
  const folder = folderFor(activeId ? tabs.get(activeId) : undefined)
  const own: MenuItem[] = [
    ...names.map((name) => ({ label: name, action: () => void ct.openTab({ kind: 'shell', cwd: defaultFolder(), profile: name }) })),
    { label: '', separator: true },
    { label: 'Claude Code', action: () => void ct.openTab({ kind: 'claude', cwd: folder }) },
    ...accountChoices(accounts).map((c) => ({
      label: `Claude Code — ${c.label}`,
      disabled: c.disabled,
      action: () => void ct.openTab({ kind: 'claude', cwd: folder, account: c.account })
    }))
  ]
  const tail: MenuItem[] = [
    { label: 'Recent sessions…', action: () => void sessionsWindow.open() },
    ...(restoreInfo ? [{ label: `Restore previous session (${restoreInfo.tabs})`, action: () => ct.runRestore() }] : []),
    { label: '', separator: true },
    { label: 'Settings…', action: () => ct.openSettingsWindow() },
    { label: `ClaudeTerm ${appInfo.version} — check for updates`, action: () => { updateBanner.reveal(); ct.checkForUpdates() } }
  ]
  if (choices.devices.length === 0) return [...own, ...tail]
  return [{ label: choices.self, disabled: true }, ...own, ...choices.devices.flatMap(deviceSection), ...tail]
}

function newTabMenu(anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect()
  const at = { x: r.left, y: r.bottom }
  menuRequest(ct.listProfiles(), (names) => showChoiceMenu(at, () => newTabItems(names)))
}

/** a device's chip menu: its new Claude tab and one tab per profile (loading until it answers), then Fold or Unfold; offline, only that */
function chipItems(deviceId: string): MenuItem[] {
  const fold: MenuItem = { label: folded.has(deviceId) ? REMOTE_COPY.unfold : REMOTE_COPY.fold, action: () => toggleGroup(deviceId) }
  if (!isOnline(deviceId)) return [fold]
  const answer = choices.devices.find((d) => d.device === deviceId)?.value ?? null
  const profiles: MenuItem[] = answer
    ? answer.profiles.map((p) => ({ label: REMOTE_COPY.newProfileTab(p), action: () => void ct.openRemoteTab(deviceId, 'shell', p, null) }))
    : [{ label: REMOTE_COPY.loading, disabled: true }]
  return [{ label: REMOTE_COPY.newClaudeTab, action: () => void ct.openRemoteTab(deviceId, 'claude', null, null) }, ...profiles, { label: '', separator: true }, fold]
}

// the latest right-click wins when the star lookups of two of them overlap
let tabMenuSeq = 0

function tabMenu(id: string, at: { x: number; y: number }): void {
  const t = tabs.get(id)
  if (!t) return
  const seq = ++tabMenuSeq
  const sessionId = t.info.kind === 'claude' ? t.info.claudeSessionId : null
  const claude = t.info.kind === 'claude'
  // the star and the fork live in main: ask before showing, so the items say what the click does. A remote Claude tab forks on its
  // device (canForkTab and forkTab route it there), and a remote tab's Continue as … lists its device's accounts: the device's answer is asked before the menu is drawn
  const answers = t.info.remote ? new Promise<void>((resolve) => requestChoices(resolve)) : Promise.resolve()
  void Promise.all([
    sessionId ? ct.getStarredSessions().catch(() => [] as string[]) : Promise.resolve([] as string[]),
    claude ? ct.canForkTab(id).catch(() => false) : Promise.resolve(false),
    answers
  ]).then(([starred, canFork]) => {
    if (seq !== tabMenuSeq || !tabs.has(id)) return
    const isStarred = sessionId !== null && starred.includes(sessionId)
    const switches = continueItems(id)
    showMenu(at, [
      { label: claude ? 'Restart session' : 'Restart shell', action: () => ct.restartTab(id, true) },
      ...(claude ? [{ label: 'Fork session', disabled: !canFork, action: () => ct.forkTab(id) }] : []),
      ...(sessionId ? [{ label: isStarred ? 'Unstar session' : 'Star session', action: () => void ct.setSessionStarred(sessionId, !isStarred) }] : []),
      { label: t.info.muted ? 'Unmute sound' : 'Mute sound', action: () => ct.muteTab(id, !t.info.muted) },
      { label: 'Mark as unread', action: () => markUnread(id) },
      { label: REMOTE_COPY.changeFolder, action: () => openFolderDialog(id) },
      ...(switches.length > 0 ? [{ label: '', separator: true }, ...switches] : []),
      { label: '', separator: true },
      { label: 'Close tab', action: () => ct.closeTab(id) }
    ])
  })
}

/** Change folder…: a remote tab's folders are its device's, and the title names the device */
function openFolderDialog(id: string): void {
  const device = tabs.get(id)?.info.remote?.device
  const name = device === undefined ? undefined : remoteDeviceOf(device)?.name
  folderDialog.open(name === undefined ? REMOTE_COPY.changeFolderTitle : REMOTE_COPY.changeFolderOn(name), id, {
    list: (path) => ct.listFolders(id, path),
    open: (path) => ct.changeFolder(id, path),
    closed: () => { if (activeId) tabs.get(activeId)?.view.term.focus() }
  })
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
  if (activeId) renderStatus(activeId)
  reviewPanel.setTreeShown(s.review.fileTree)
  // only a change of the setting itself: another one must not undo a drag of the tree's edge
  if (s.review.treeWidth !== prev.review.treeWidth) reviewPanel.setTreeWidth(s.review.treeWidth)
  // only a change of the position re-attaches the panel: that would reset its scroll
  if (s.tabs.position !== prev.tabs.position) {
    showTabs(s.tabs.position)
    renderTabs()
    if (s.tabs.position === 'left' && activeId && places.has(activeId)) tabPanel.unfoldFor(activeId)
  }
}

async function boot(): Promise<void> {
  appInfo = await ct.appInfo()
  settings = await ct.getSettings()
  // the window must come up even when the accounts cannot be listed
  accounts = (await ct.listAccounts().catch(() => null))?.accounts ?? []
  fontSize = settings.font.size
  const layout = await ct.getTabLayout()
  // the tab bar and the left panel share these: each one shows the same tabs and does the same things
  const tabCallbacks: TabBarCallbacks = {
    activate: (id) => ct.activateTab(id),
    close: (id) => ct.closeTab(id),
    rename: (id, title) => ct.renameTab(id, title),
    // a remote group's order is this window's only; this device's own order is main's
    reorder: (ids, group) => {
      if (group === null) ct.reorderTabs(ids)
      else {
        remoteOrder.set(group, ids)
        renderTabs()
      }
    },
    newTab: () => void ct.openTab({ kind: 'shell', cwd: defaultFolder() }),
    openMenu: (anchor) => newTabMenu(anchor),
    tabMenu,
    toggleGroup,
    groupMenu: (id, at) => menuRequest(Promise.resolve(null), () => showChoiceMenu(at, () => chipItems(id))),
    toggleImages: () => {
      runAction({ type: 'toggleImages' }, activeId)
      if (activeId) tabs.get(activeId)?.view.term.focus()
    },
    toggleChanges: () => {
      runAction({ type: 'toggleChanges' }, activeId)
      if (activeId) tabs.get(activeId)?.view.term.focus()
    },
    toggleDocs: () => {
      runAction({ type: 'toggleDocs' }, activeId)
      if (activeId) tabs.get(activeId)?.view.term.focus()
    },
    toggleNote: () => {
      runAction({ type: 'toggleNote' }, activeId)
      // the keyboard goes back to the terminal, unless an empty note took it to be written in
      if (activeId && !document.activeElement?.closest('#note')) tabs.get(activeId)?.view.term.focus()
    },
    switchPosition: () => {
      const next: TabPosition = settings.tabs.position === 'top' ? 'left' : 'top'
      void ct.setSetting('tabs.position', next).then((r) => { if (!r.ok) showToast(r.error) }, (e: unknown) => showToast(`Cannot save tabs.position: ${String(e)}`))
    }
  }
  tabBar = new TabBar(document.getElementById('tabbar')!, tabCallbacks, ct.platform)
  tabPanel = new TabPanel(document.getElementById('tabpanel')!, tabCallbacks, ct.platform, layout, (change) => ct.setTabLayout(change))
  showTabs(settings.tabs.position)
  noteOverlay = new NoteOverlay(document.getElementById('note')!, {
    setText: (id, text, generation) => ct.setNoteText(id, text, generation),
    setView: (id, shown, form, generation) => ct.setNoteView(id, shown, form, generation),
    focusTerminal: () => { if (activeId) tabs.get(activeId)?.view.term.focus() },
    changed: () => renderTabs()
  }, ct.platform)
  ct.onTabPlace((id, place) => {
    // the group is known with the first answer for the tab: a later change of its branch keeps a group the user folded
    const first = !places.has(id)
    places.set(id, place)
    if (appInfo.test) placeLog.set(id, [...placeLog.get(id) ?? [], place])
    renderTabs()
    // a new active tab unfolds its group once its place is known: until then it is in No project, which must stay folded
    if (first && id === activeId && settings.tabs.position === 'left') tabPanel.unfoldFor(id)
  })
  searchBar = new SearchBar(
    document.getElementById('search')!,
    () => (activeId ? tabs.get(activeId)?.view.search ?? null : null),
    () => { if (activeId) tabs.get(activeId)?.view.term.focus() }
  )
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null
    if (target?.closest('.xterm') || (target?.tagName === 'INPUT' && !target.classList.contains('review-find-input')) || target?.tagName === 'TEXTAREA') return
    const a = mapKey(e, ct.platform)
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
    loadRemote: () => ct.listRemoteSessions(),
    open: (id) => ct.openSession(id),
    opening: closeMenu,
    setStarred: (id, starred) => void ct.setSessionStarred(id, starred),
    closed: () => { if (activeId) tabs.get(activeId)?.view.term.focus() }
  }, ct.platform)
  folderDialog = new FolderDialog(document.getElementById('folder-dialog')!)
  ct.onStarred((ids) => sessionsWindow.applyStars(new Set(ids)))
  ct.onRemoteSessions((list) => sessionsWindow.applyRemote(list))
  planList = new PlanList(document.getElementById('plan-list')!, () => { if (activeId) tabs.get(activeId)?.view.term.focus() }, () => { if (activeId) ct.clearTaskList(activeId) })
  statusBar =new StatusBar(document.getElementById('statusbar')!, () => sidePanel.open('changes'), (anchor) => {
    const r = anchor.getBoundingClientRect()
    // the menu opens over the status bar, kept inside the window; a remote tab's accounts are asked for first, a local tab's need no answer
    const id = activeId
    if (!id) return
    const show = (): void => { showMenu({ x: r.left, y: r.top }, continueItems(id)) }
    if (tabs.get(id)?.info.remote) requestChoices(show)
    else show()
  }, (anchor) => {
    const p = activeId ? planUpdates.get(activeId) : undefined
    if (p?.plan) planList.toggle(anchor, p.plan, !!p.agentList)
  })
  ct.onAccounts((v) => {
    accounts = v.accounts
    renderTitle()
    if (activeId) renderStatus(activeId)
  })
  updateBanner = new UpdateBanner(document.getElementById('update-banner')!, () => ct.installUpdate())
  ct.onUpdate((s) => updateBanner.update(s))
  void ct.getUpdateState().then((s) => updateBanner.update(s))
  ct.onStatus((u) => {
    statusUpdates.set(u.tabId, u)
    if (u.tabId === activeId) renderStatus(u.tabId)
  })
  ct.onPlan((u) => {
    if (u.plan) planUpdates.set(u.tabId, u)
    else planUpdates.delete(u.tabId)
    if (u.tabId === activeId) {
      renderStatus(u.tabId)
      planList.update(u.plan, !!u.agentList)
    }
  })
  ct.onAttention((tabId, reason) => {
    const t = tabs.get(tabId)
    if (!t || tabId === activeId) return
    if (reason === 'bell') t.bell = true
    else t.attention = true
    renderTabs()
  })
  ct.onBanner(showBanner)
  // another device's tab was answered: its pulse stops here; this device's unread mark is its own and stays
  ct.onAttentionClear((tabId) => {
    closeBanner(tabId)
    const t = tabs.get(tabId)
    if (!t) return
    t.attention = false
    t.bell = false
    renderTabs()
  })
  // before main types a continue into a Claude tab: only this window has the terminal's screen
  ct.onPromptQuery((queryId, tabId) => {
    const t = tabs.get(tabId)
    const text = t ? promptText(t.view.screen().rows) : null
    ct.answerPrompt(queryId, text === null ? 'none' : text === '' ? 'empty' : 'draft')
  })
  sidePanel = new SidePanel(document.getElementById('image-panel')!, document.getElementById('terminals')!, { images: settings.imagePanel.width, changes: settings.review.width, docs: settings.review.width }, (width, resize) => ct.setPanel(width, resize))
  ct.onPanelMode((mode) => sidePanel.setMode(mode))
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
  /** a checkbox of the Changes panel saves its setting; resolves to whether it was saved */
  const saveReviewBox = async (key: 'review.hideTests' | 'review.renderMarkdown', on: boolean): Promise<boolean> => {
    try {
      const r = await ct.setSetting(key, on)
      if (!r.ok) showToast(r.error)
      return r.ok
    } catch (e) {
      showToast(`Cannot save ${key}: ${String(e)}`)
      return false
    }
  }
  reviewPanel = new ReviewPanel(
    sidePanel.bodies.changes,
    sidePanel,
    {
      setScope: (id, scope) => ct.setReviewScope(id, scope),
      clearRequest: (id) => ct.clearReviewRequest(id),
      refresh: (id, auto) => {
        // opening Changes on an offline device's tab asks nothing: a background action, as marking images seen is; the button still asks
        const device = tabs.get(id)?.info.remote?.device
        if (auto && device !== undefined && !isOnline(device)) return
        ct.refreshReview(id)
      },
      setViewed: (id, path, hash, viewed) => ct.setReviewViewed(id, path, hash, viewed),
      showFile: (id, path) => ct.showReviewFile(id, path),
      openEditor: (id, path, line) => ct.openInEditor(id, path, line),
      reveal: (id, path) => ct.revealFile(id, path),
      copyText: (text) => ct.writeClipboardText(text),
      openLink: (url) => ct.openExternal(url),
      setHideTests: (on) => saveReviewBox('review.hideTests', on),
      setRenderMarkdown: (on) => saveReviewBox('review.renderMarkdown', on),
      setFileTree: (on) => {
        ct.setSetting('review.fileTree', on).then((r) => { if (!r.ok) showToast(r.error) }, (e: unknown) => showToast(`Cannot save review.fileTree: ${String(e)}`))
      },
      send: (id, message) => sendToClaude(id, message),
      contextLines: (id, path, hash, from, to) => ct.reviewLines(id, path, hash, from, to)
    },
    ct.platform
  )
  reviewPanel.setTreeShown(settings.review.fileTree)
  reviewPanel.setTreeWidth(settings.review.treeWidth)
  docPanel = new DocPanel(
    sidePanel.bodies.docs,
    sidePanel,
    {
      read: (id) => ct.readDoc(id),
      stamp: (id) => ct.docStamp(id),
      action: (id, action) => ct.docAction(id, action),
      openEditor: (id, line) => ct.openDocInEditor(id, line),
      copyText: (text) => ct.writeClipboardText(text),
      openLink: (url) => ct.openExternal(url),
      send: (id, message) => sendToClaude(id, message)
    },
    ct.platform
  )
  sidePanel.onChange = () => {
    imagePanel.panelChanged()
    reviewPanel.panelChanged()
    docPanel.panelChanged()
    refreshPanelButtons()
  }
  ct.onReview((u) => {
    reviewUpdates.set(u.tabId, u)
    if (u.reveal) pendingReveal.add(u.tabId)
    if (u.tabId !== activeId) return
    reviewPanel.show(u)
    refreshPanelButtons()
    if (pendingReveal.delete(u.tabId)) sidePanel.open('changes')
    renderStatus(u.tabId)
  })
  ct.onDocs((u) => {
    docUpdates.set(u.tabId, u)
    if (u.reveal) pendingDocReveal.set(u.tabId, u.reveal)
    if (u.tabId !== activeId) return
    showDocs(u.tabId, true)
    refreshPanelButtons()
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
  // a stored note comes to a tab with its conversation: Restore, Recent sessions, /resume
  ct.onNote((id, note, generation) => {
    noteOverlay.set(id, note, generation)
    renderTabs()
  })
  ct.onTabOpened((info) => {
    addTab(info)
    // a window that lists no tab of its own, and whose front closed with no other tab to ask for (a batch of closes from a
    // device that restarted): a remote tab that comes brings itself forward. A window with a local tab leaves the front to main
    const ownTab = [...tabs.values()].some((t) => !t.info.remote)
    if (info.remote && activeId === null && !ownTab) ct.activateTab(info.id)
  })
  ct.onTabUpdated((info) => {
    const t = tabs.get(info.id)
    if (!t) return
    t.info = info
    renderTabs()
    // a switch of the account shows at once
    if (info.id === activeId) renderStatus(info.id)
  })
  ct.onTabClosed((id) => {
    closeBanner(id)
    const t = tabs.get(id)
    if (!t) return
    const frontBefore = activeId
    const wasFront = id === activeId
    if (wasFront) planList.close()
    t.view.dispose()
    tabs.delete(id)
    places.delete(id)
    imageUpdates.delete(id)
    statusUpdates.delete(id)
    planUpdates.delete(id)
    reviewUpdates.delete(id)
    reviewPanel.dropTab(id)
    docUpdates.delete(id)
    docPanel.dropTab(id)
    noteOverlay.dropTab(id)
    pendingReveal.delete(id)
    pendingDocReveal.delete(id)
    inputLog.delete(id)
    sizeLog.delete(id)
    order = order.filter((x) => x !== id)
    if (activeId === id) {
      activeId = null
      statusBar.render(null)
      // the Docs panel has no tab's documents to show: it falls back to another panel
      sidePanel.setAvailable('docs', false)
    }
    renderTabs()
    // main activates the neighbor of a closed local tab that was in front; in the other cases it activates none, and the
    // window asks for the first tab left (FrontFallback repeats the ask while the asked tab closes first)
    const localLeft = [...tabs.values()].some((x) => !x.info.remote)
    if (wasFront && !t.info.remote && localLeft) return
    const ask = frontFallback.closed(id, visibleOrder(), frontBefore)
    if (ask) ct.activateTab(ask)
  })
  ct.onTabActivated(activate)
  ct.onTabsOrder((ids) => {
    // the device's own tabs in its order; the remote tabs in front of it, which the device does not list
    order = [...ids.filter((id) => tabs.has(id)), ...order.filter((id) => tabs.get(id)?.info.remote && !ids.includes(id))]
    renderTabs()
  })
  ct.onRemoteDevices((list) => {
    remoteDevicesSeen = true
    remoteDevices = list
    renderTabs()
    refreshChoiceMenu()
  })
  void ct.getRemoteDevices().then((list) => {
    if (remoteDevicesSeen) return
    remoteDevices = list
    renderTabs()
  })
  // a device's answer to the new-tab menu's lists: kept, and the menu on screen is drawn again with it
  ct.onDeviceChoices((view) => {
    choicesSeq++
    choices = view
    redrawChoiceMenu()
    // the account a remote tab names depends on its device's answer
    renderTitle()
    if (activeId) renderStatus(activeId)
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
    t.unread = false
    renderTabs()
  })
  ct.onPtyExit((id, code) => tabs.get(id)?.view.write(`\r\n\x1b[90m[process exited with code ${code}] Enter — restart, ${shortcutLabel('closeTab', ct.platform)} — close\x1b[0m\r\n`))
  // the size of a tab that another device typed into last; null: this window's own fit applies again
  ct.onTabSize((id, size) => tabs.get(id)?.view.setFixedSize(size))
  // a copy of this window's tab on another device: the screen, once the output before the request is written
  ct.onScreenSeed((id, token) => {
    const t = tabs.get(id)
    if (!t) ct.seedScreen(id, token, '')
    else t.view.term.write('', () => ct.seedScreen(id, token, t.view.serialize(MAX_SNAPSHOT_BYTES)))
  })
  ct.onToast((m) => showToast(m))
  ct.onSettings(applySettings)
  window.addEventListener('focus', () => {
    if (sessionsWindow.isOpen || folderDialog.isOpen) return
    if (document.activeElement?.closest('#image-panel, #note')) return
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
      ptySizes: (id) => [...sizeLog.get(id ?? activeId ?? '') ?? []],
      termSize: (id) => {
        const t = tabs.get(id ?? activeId ?? '')
        return t ? { cols: t.view.term.cols, rows: t.view.term.rows } : null
      },
      bufferText: (id) => tabs.get(id ?? activeId ?? '')?.view.bufferText() ?? '',
      themeBackground: () => (activeId ? tabs.get(activeId)?.view.term.options.theme?.background ?? null : null),
      banners: () => [...banners].map(([tabId, b]) => ({ tabId, title: b.title, body: b.body })),
      clickBanner: (id) => banners.get(id)?.click(),
      // what Send (the Changes panel, the note) does with a tab
      sendText: (id: string, message: string) => sendToClaude(id, message),
      choiceAsks: () => choiceAsks,
      placeOf: (id) => places.get(id),
      placeEvents: (id) => [...placeLog.get(id) ?? []],
      tabMarks: (id) => {
        const t = tabs.get(id)
        return t ? { attention: t.attention, unread: t.unread } : null
      }
    }
  }
  ct.rendererReady()
}

void boot()
