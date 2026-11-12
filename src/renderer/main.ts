import '@fontsource-variable/inter'
import './styles.css'
import { MAIN_ACCOUNT, type AccountView } from '../shared/accounts'
import type { AppInfo, RestoreInfo, ImagesUpdate, PlanUpdate, StatusUpdate } from '../shared/ipc'
import type { DocsUpdate } from '../shared/docs'
import type { MailUnread } from '../shared/mail'
import type { TabView } from '../shared/chat'
import { NOT_RUNNING, type ReviewCounter, type ReviewUpdate } from '../shared/review'
import { deviceColor, MAX_SNAPSHOT_BYTES, REMOTE_COPY, type DeviceAnswer, type DeviceChoices, type RemoteDeviceView } from '../shared/remote'
import type { NotificationCase, Settings, TabInfo, TabPlace, TabPosition } from '../shared/types'
import { accountChoices, accountLabel, switchChoices } from './account-items'
import { DocPanel } from './doc-panel'
import { MailPanel } from './mail-panel'
import { ImagePanel } from './image-panel'
import { SidePanel } from './side-panel'
import { SheetHeader } from './sheet-header'
import { Lightbox } from './lightbox'
import { PlanList } from './plan-list'
import { RecentSessionsWindow } from './recent-sessions'
import { imagePasteInput, imagePasteRoute, isImagePasteKey, isPrimaryKey, mapKey, shortcutLabel, type KeyAction } from './keymap'
import { SearchBar, type FindTarget } from './search'
import { loadInter } from './dom'
import { closeMenu, menuIsOpen, showMenu, type MenuItem } from './menu'
import { NoteOverlay } from './note-overlay'
import { RestoreBanner } from './restore-banner'
import { ReviewPanel } from './review-panel'
import { StatusBar } from './status-bar'
import { UpdateBanner } from './update-banner'
import { TabBar, type TabBarCallbacks, type TabBarGroup, type TabBarItem, type TabWaiting } from './tabbar'
import { shownActivity } from './tab-row'
import { TabPanel } from './tab-panel'
import { orderToWrite, tabBarOrder } from './tab-groups'
import { TerminalView } from './terminal-view'
import { ChatView } from './chat/chat-view'
import { ChatFind } from './chat/chat-find'
import { resolveTheme } from './themes'
import { showToast } from './toasts'
import { promptText } from './claude-screen'
import { leftUnfinished } from './unread'
import { FrontFallback } from './front-fallback'
import { FolderDialog } from './folder-dialog'
import { TitleBar } from './title-bar'
import { limitMeters } from './limit-meters'
import { claudeTitle, folderName } from './util'

interface TabState {
  info: TabInfo
  /** the tab's terminal: null while a Claude tab is in its chat view, which has no process of its own to show */
  view: TerminalView | null
  /** the chat of a Claude tab, local or another device's; null for a shell or a setup-token tab */
  chat: ChatView | null
  oscTitle: string | null
  /** the session's title as its transcript gives it; null while the session has none */
  sessionTitle: string | null
  bell: boolean
  attention: boolean
  /** what the attention is for: the last case that started it; null with no attention */
  waitReason: NotificationCase | null
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
let sheetHeader: SheetHeader
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
let mailPanel: MailPanel
/** the unread agent messages per tab, as main last counted them */
let mailUnread: MailUnread = {}
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
let titleBar: TitleBar
let updateBanner: UpdateBanner
const statusUpdates = new Map<string, StatusUpdate>()
const planUpdates = new Map<string, PlanUpdate>()
/** the extra accounts, without their tokens */
let accounts: AccountView[] = []
/** the plan of the main account's login, as Claude Code keeps it; null until read, or when it names none */
let mainPlan: string | null = null
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

/** what a waiting tab's row names: the question or permission Claude waits on, or its finished turn (a peer's too); null while
 * nothing waits, or the tab is only marked unread */
const waitingOf = (t: TabState): TabWaiting | null => {
  if (!t.attention || t.waitReason === null || t.waitReason === 'bell') return null
  return t.waitReason === 'question' || t.waitReason === 'permission' ? t.waitReason : 'done'
}

/** a fork's title gets ` (fork)` after the usual one, unless the user named the tab */
/** a chat tab is named by its session's title, a terminal tab by its program's; each falls back to the other, then to the folder */
const titleOf = (t: TabState): string => {
  const own = t.info.view === 'chat' ? t.sessionTitle ?? t.oscTitle : t.oscTitle ?? t.sessionTitle
  return t.info.customTitle ?? `${own ?? t.info.remote?.title ?? folderName(t.info.folder)}${t.info.fork ? ' (fork)' : ''}`
}

/** where a new tab opens: the defaultFolder setting, else the home folder */
const defaultFolder = (): string => settings.defaultFolder ?? appInfo.homeDir

const remoteDeviceOf = (id: string): RemoteDeviceView | undefined => remoteDevices.find((d) => d.id === id)

/**
 * The account row at the foot of the left panel: the account the tab in front runs on. A remote tab names its device's
 * account and the device; an extra account says so; the main account (a shell tab's too) names its plan when Claude Code
 * keeps one.
 */
function footAccount(): { name: string; detail: string } {
  const t = activeId === null ? undefined : tabs.get(activeId)
  const remote = t?.info.remote
  if (remote) return { name: remote.accountName ?? MAIN_ACCOUNT, detail: `On ${remoteDeviceOf(remote.device)?.name ?? 'another device'}` }
  if (t && t.info.kind === 'claude' && t.info.account !== null) return { name: accountLabel(t.info.account, accounts), detail: 'Extra account' }
  return { name: MAIN_ACCOUNT, detail: mainPlan ?? 'Claude Code login' }
}
const isOnline = (deviceId: string): boolean => remoteDeviceOf(deviceId)?.online === true

/** a remote device's tabs in this window's order: as dragged here, or with each fork after its family (tabBarOrder) */
function groupTabs(deviceId: string): string[] {
  const here = order.filter((id) => tabs.get(id)?.info.remote?.device === deviceId)
  return tabBarOrder(here.map((id) => ({ id, forkOf: tabs.get(id)?.info.fork?.of ?? null })), remoteOrder.get(deviceId) ?? [])
}

/** this device's tabs in the order the shown tab bar or panel lists them, then the tabs of the groups not folded: the order Next, Previous and Go to tab walk */
function visibleOrder(): string[] {
  const own = settings.tabs.position === 'left' ? tabPanel.visualOrder : tabBar.visualOrder
  return [...own, ...remoteDevices.filter((d) => !folded.has(d.id)).flatMap((d) => groupTabs(d.id))]
}

/** a tab shows an envelope for its unread agent messages only while messages and their marks are on */
function mailMarked(tabId: string): boolean {
  return settings.agentMessages.enabled && settings.agentMessages.marks && (mailUnread[tabId] ?? 0) > 0
}

/** the tabs that show an envelope, as one string: a change of it is what the tab bar and the left panel redraw for */
function mailMarks(): string {
  return Object.keys(mailUnread).filter(mailMarked).sort().join(' ')
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
    mail: mailMarked(id),
    attention: pulsing(t),
    waiting: waitingOf(t),
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
      mail: tabsOf.some((id) => itemOf.get(id)?.mail === true),
      working: tabsOf.some((id) => { const item = itemOf.get(id); return item !== undefined && shownActivity(item) !== null })
    }
  })
  tabBar.render(items, activeId, groups)
  // the left panel shows this device's groups, then a section per device with tabs: the same items and groups as the tab bar
  tabPanel.render(items, activeId, groups)
  // the sheet's header names the active tab; a remote tab shows its device's color
  const active = items.find((item) => item.id === activeId)
  sheetHeader.render(active ?? null, active?.group ? deviceColor(active.group) : undefined)
  refreshModes()
  const foot = footAccount()
  tabPanel.setAccount(foot.name, foot.detail)
  // the order is the shown bar's or panel's grouping: main takes it when it differs, so the tab order follows the groups (the next render finds them equal).
  // Not before every tab's place is known: until then a tab sits in No project and that temporary order must not reach main.
  // A remote tab's id never reaches main: its order is its device's
  const own = order.filter((id) => !tabs.get(id)?.info.remote)
  const shownOwn = settings.tabs.position === 'left' ? tabPanel.visualOrder : tabBar.visualOrder
  const next = orderToWrite(own, shownOwn, own.every((id) => places.has(id)))
  if (next) ct.reorderTabs(next)
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

/** the Media, Changes, Messages, Docs and Note buttons in the sheet's header: which panel or note is shown, the badges, Changes and Note only for a Claude tab */
function refreshPanelButtons(): void {
  const unseen = activeId ? imageUpdates.get(activeId)?.unseen ?? 0 : 0
  const claude = !!activeId && tabs.get(activeId)?.info.kind === 'claude'
  const unviewed = claude && activeId ? reviewUpdates.get(activeId)?.unviewed ?? 0 : 0
  const docs = claude && (docUpdates.get(activeId ?? '')?.docs.length ?? 0) > 0
  // the badge counts nothing while the marks are off: the panel still lists the messages
  const unreadMail = activeId && settings.agentMessages.marks ? mailUnread[activeId] ?? 0 : 0
  // the counts are the active tab's: the header may still show the tab before, so the badges are told which tab they count
  sheetHeader.setImages(sidePanel.isShowing('images'), unseen, activeId)
  sheetHeader.setChanges(claude, sidePanel.isShowing('changes'), unviewed, activeId)
  sheetHeader.setDocs(docs, sidePanel.isShowing('docs'))
  sheetHeader.setMessages(settings.agentMessages.enabled, sidePanel.isShowing('messages'), unreadMail, activeId)
  sheetHeader.setNote(claude, claude && noteOverlay.isShown())
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
  // the background tasks of the status decide whether the view switch asks first
  refreshModes()
  // a chat-view tab's status bar leaves the model to the composer, and stops its background tasks through the chat
  const t = tabs.get(tabId)
  const chat = t && isChatView(t) ? { tab: tabId, stopTask: (taskId: string) => stopTaskOf(tabId, taskId) } : undefined
  statusBar.render(statusUpdates.get(tabId) ?? null, counterOf(tabId), accountOf(tabId), planUpdates.get(tabId)?.plan ?? null, Date.now(), chat)
  titleBar.render(limitMeters(statusUpdates.get(tabId) ?? null, Date.now(), settings.claude.limitPace))
}

/**
 * A background task stopped from the status bar: once main has sent the stop, the task leaves the tab's status, so its list and
 * the count drop it. A stop main did not send (a remote tab, a refusal) leaves the task where it is.
 */
async function stopTaskOf(tabId: string, taskId: string): Promise<boolean> {
  const stopped = await ct.chatStopTask(tabId, taskId)
  const u = statusUpdates.get(tabId)
  if (stopped && u) {
    statusUpdates.set(tabId, { ...u, background: u.background.filter((task) => task.id !== taskId) })
    // the bar shows the tab in front only: another tab's list is drawn when it comes to the front
    if (tabId === activeId) renderStatus(tabId)
  }
  return stopped
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
  const t = tabs.get(tabId)
  // a tab in its chat view takes the message as a message of the conversation
  if (t && isChatView(t)) return ct.chatSend(tabId, { text: message, attachments: [], from: 'review' })
  const before = await sendRefusal(tabId)
  if (before !== null) return before
  tabs.get(tabId)?.view?.term.paste(message)
  await new Promise((r) => setTimeout(r, 50))
  const refusal = await sendRefusal(tabId)
  if (refusal !== null) return refusal
  writeToTab(tabId, '\r')
  if (tabId === activeId) focusTab(tabId)
  return null
}

/** a Claude tab whose conversation is shown in the chat view */
const isChatView = (t: TabState): boolean => t.info.view === 'chat' && t.chat !== null

/** whether a tab has a chat: a Claude tab, local or another device's; the chat of a remote tab is its device's host's */
const hasChat = (info: TabInfo): boolean => info.kind === 'claude' && info.view !== null

/** the tab's own view takes the keyboard: its composer in the chat view, its terminal otherwise */
function focusTab(tabId: string): void {
  const t = tabs.get(tabId)
  if (!t) return
  if (isChatView(t)) t.chat?.focus()
  else t.view?.term.focus()
}

function setFontSize(size: number): void {
  fontSize = Math.min(72, Math.max(6, size))
  for (const t of tabs.values()) t.view?.setFont(settings.font.family, fontSize)
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
  const term = t.view?.term
  if (!term || !term.hasSelection()) return false
  ct.writeClipboardText(term.getSelection())
  term.clearSelection()
  return true
}

/** the text selected in the chat in front goes to the clipboard; false when no text of that chat is selected */
function copyChatSelection(): boolean {
  const t = activeId ? tabs.get(activeId) : undefined
  if (!t || !isChatView(t) || !t.chat) return false
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.anchorNode === null || !t.chat.element.contains(selection.anchorNode)) return false
  // a selection in the composer's text area is not in the page's selection text: nothing is copied over the clipboard then
  const text = selection.toString()
  if (text === '') return false
  ct.writeClipboardText(text)
  return true
}

/** where the page's selection starts and ends */
interface SelectionEnds { anchor: Node | null; anchorOffset: number; focus: Node | null; focusOffset: number }

function selectionEnds(): SelectionEnds {
  const s = window.getSelection()
  return { anchor: s?.anchorNode ?? null, anchorOffset: s?.anchorOffset ?? -1, focus: s?.focusNode ?? null, focusOffset: s?.focusOffset ?? -1 }
}

const sameEnds = (a: SelectionEnds, b: SelectionEnds): boolean =>
  a.anchor === b.anchor && a.anchorOffset === b.anchorOffset && a.focus === b.focus && a.focusOffset === b.focusOffset

/** the chats' finds: one per chat, so a Find keeps its place while its chat is in front */
const chatFinds = new WeakMap<ChatView, ChatFind>()

/** the find target of the tab in front: its chat's find in the chat view, its terminal's search otherwise */
function findTarget(): FindTarget | null {
  const t = activeId ? tabs.get(activeId) : undefined
  if (!t) return null
  if (t.chat && isChatView(t)) {
    let find = chatFinds.get(t.chat)
    if (!find) {
      find = new ChatFind(t.chat)
      chatFinds.set(t.chat, find)
    }
    return find
  }
  return t.view?.search ?? null
}

async function paste(t: TabState, allowImage: boolean): Promise<void> {
  const clip = await ct.readClipboard()
  if (clip.text.length > 0) t.view?.term.paste(clip.text)
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
    // the text is the path the image was saved at on the tab's device, quoted for that tab's shell
    const text = await ct.pasteImageToRemote(t.info.id)
    if (text) t.view?.term.paste(text)
  } else if (route === 'file') {
    const file = await ct.saveClipboardImage()
    if (file) t.view?.term.paste(`"${file}"`)
  } else {
    handleInput(t.info.id, imagePasteInput(ct.platform))
  }
}

/** Claude Code's image-paste key in another device's Claude tab: an image-only clipboard is pasted as its path there, anything else reaches the tab as the key */
async function pasteImageKey(t: TabState): Promise<void> {
  // a clipboard that cannot be read is no image: the key goes to the tab as it is
  const clip = await ct.readClipboard().catch(() => null)
  if (clip?.hasImage && clip.text.length === 0) await pasteImage(t)
  else handleInput(t.info.id, imagePasteInput(ct.platform))
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
    // an expanded panel covers the terminal: a find box would open under it, taking keys nobody sees
    case 'find': if (!sidePanel.expanded) searchBar.open(); break
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
  const t = tabs.get(tabId)
  if (t?.info.remote && t.info.kind === 'claude' && isImagePasteKey(e, ct.platform)) {
    e.preventDefault()
    void pasteImageKey(t)
    return false
  }
  const action = mapKey(e, ct.platform)
  if (!action) return true
  if (action.type === 'copyOrInterrupt') {
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
    // a remote tab's files are copied to its device first: the text typed is for the paths they were saved at there
    if (tabs.get(tabId)?.info.remote) {
      void ct.dropFilesToRemote(tabId, paths).then((text) => {
        if (text) handleInput(tabId, text)
      })
      return
    }
    // a local tab's paths are quoted for its shell, which main knows
    void ct.typedPaths(tabId, paths).then((text) => {
      if (text) handleInput(tabId, text)
    })
  })
}

/** a tab's terminal: its xterm, drawn in the terminals' area, hidden until the tab is in front */
function makeTerminal(info: TabInfo): TerminalView {
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
  return view
}

/** a Claude tab's chat: its conversation and composer, hidden until the tab is in its chat view and in front */
function makeChat(tabId: string): ChatView {
  const chat = new ChatView({
    tabId,
    container: document.getElementById('terminals')!,
    platform: ct.platform,
    // a refusal or a failure shows under the composer's field, and the composer keeps the draft
    send: (s) => ct.chatSend(tabId, s),
    interrupt: () => ct.chatInterrupt(tabId),
    attach: (paths) => ct.chatAttach(tabId, paths),
    pickFiles: () => ct.chatPickFiles(tabId),
    pasteImage: () => ct.saveClipboardImage(),
    pathForFile: (file) => ct.pathForFile(file),
    setMode: (mode) => ct.chatSetMode(tabId, mode),
    modes: () => ct.chatModes(tabId),
    models: () => ct.chatModels(tabId),
    commands: () => ct.chatCommands(tabId),
    files: (query) => ct.chatFiles(tabId, query),
    setModel: (model, effort) => ct.chatSetModel(tabId, model, effort),
    // a session picked in the window resumes here, or opens in a tab of its own (main routes it); a pick the chat cannot take
    // (main answers null) is said under the composer
    resume: (refused) => { void sessionsWindow.open((s) => resumePicked(tabId, s, refused)) },
    // a notice's line, or null for a dialog: the terminal is switched to, and nothing typed
    openInTerminal: (line) => ct.chatOpenInTerminal(tabId, line),
    // a view switch that would stop the tab's background tasks asks in the sheet header first, with this tab's own count
    askSwitch: (go, cancel) => sheetHeader.askBeforeSwitch(tabId, backgroundOf(tabId), go, cancel),
    answer: (cardId, a) => ct.chatAnswer(tabId, cardId, a),
    restart: () => ct.restartTab(tabId, false),
    older: (beforeId) => ct.chatOlder(tabId, beforeId),
    // a card the Media panel marked deleted is no card: its picture is not drawn, as one with no card is not
    imageCard: (cardId) => imageUpdates.get(tabId)?.cards.find((c) => c.id === cardId && !c.deleted) ?? null,
    openImages: (cards, index) => lightbox.open(cards, index),
    revealChange: (path) => {
      sidePanel.open('changes')
      reviewPanel.revealFile(tabId, path)
    },
    openExternal: (url) => ct.openExternal(url),
    copy: (text) => ct.writeClipboardText(text)
  })
  chat.setTheme(resolveTheme(settings.theme))
  chat.setFullWidth(settings.chat.fullWidth)
  return chat
}

function addTab(info: TabInfo): void {
  const chat = hasChat(info) ? makeChat(info.id) : null
  // a tab in its chat view has no terminal: its process is the chat's, and it gets one when the view changes
  const view = chat !== null && info.view === 'chat' ? null : makeTerminal(info)
  tabs.set(info.id, { info, view, chat, oscTitle: null, sessionTitle: null, bell: false, attention: false, waitReason: null, unread: false, unreadOnLeave: false, images: 0 })
  if (!order.includes(info.id)) order.push(info.id)
  renderTabs()
}

/** the tab's terminal, made when it is missing: a terminal tab's output can come before anything else has asked for it */
function ensureTerminal(t: TabState): TerminalView {
  if (!t.view) {
    t.view = makeTerminal(t.info)
    showTab(t, t.info.id === activeId, false)
  }
  return t.view
}

/** shows a tab's view: its chat in the chat view, its terminal otherwise; neither while the tab is not in front */
function showTab(t: TabState, visible: boolean, focus: boolean): void {
  const chat = visible && t.info.view === 'chat' && t.chat !== null
  t.view?.show(visible && !chat, focus)
  t.chat?.show(chat, focus)
  // a chat left, or out of its chat view, takes its Find's highlights and walk with it: a Find in another tab searches that tab
  if (!chat && t.chat) chatFinds.get(t.chat)?.clearDecorations()
}

/** the tab's view changed: its terminal is made before the process's first output can come, or goes with the chat */
function applyView(t: TabState): void {
  if (t.info.view === 'chat') {
    t.view?.dispose()
    t.view = null
  } else if (t.info.view === 'terminal') {
    ensureTerminal(t)
  }
  if (t.info.id !== activeId) return
  showTab(t, true, true)
  if (isChatView(t)) loadChat(t.info.id)
}

/** a chat's snapshot requests: whether one is pending, and whether a patch came that the view could not take while it was */
interface ChatLoad { pending: boolean; stale: boolean }
const chatLoads = new Map<string, ChatLoad>()

/**
 * The chat in front is drawn from main's snapshot of it. One request at a time per tab: a patch the view cannot take while
 * a request is pending marks the chat stale, and the reply asks once more. A reply for a tab that is not in front is not drawn.
 */
function loadChat(tabId: string): void {
  let load = chatLoads.get(tabId)
  if (!load) {
    load = { pending: false, stale: false }
    chatLoads.set(tabId, load)
  }
  if (load.pending) {
    load.stale = true
    return
  }
  load.pending = true
  const pending = load
  // a rejected request ends too: the flag must not stay set, or the chat would never be loaded again
  const settled = (): void => {
    pending.pending = false
    if (pending.stale) {
      pending.stale = false
      loadChat(tabId)
    }
  }
  void ct.chatSnapshot(tabId).then((s) => {
    const t = tabs.get(tabId)
    if (s && t && isChatView(t) && activeId === tabId) t.chat?.load(s)
    settled()
  }, settled)
}

/** the Chat | Terminal switch of the tab in front: a Claude tab's, with a chat; a shell tab has none */
function refreshModes(): void {
  const t = activeId ? tabs.get(activeId) : undefined
  if (!t || t.info.view === null || !hasChat(t.info)) {
    sheetHeader.setModes(null)
    return
  }
  sheetHeader.setModes({ tab: t.info.id, view: t.info.view, busy: t.info.activity === 'working', background: backgroundOf(t.info.id) })
}

/** the background tasks a tab's status names: its own count, which a question about its switch goes by */
const backgroundOf = (tabId: string): number => statusUpdates.get(tabId)?.background.length ?? 0

/**
 * A session picked in the sessions window for a chat. Main says where the pick goes: a restart of the tab's own process stops the
 * background tasks, so that asks in the sheet header first (Resume runs it, Cancel keeps the chat). A session held by another tab,
 * or of another folder, opens without a question.
 */
function resumePicked(tabId: string, s: { id: string; cwd: string }, refused: () => void): void {
  void ct.chatResumePlan(tabId, s.id).then((where) => {
    const go = (): void => {
      void ct.chatResume(tabId, s.id, s.cwd).then((r) => { if (r === null) refused() })
    }
    const background = backgroundOf(tabId)
    if (where !== 'restart' || background === 0) {
      go()
      return
    }
    sheetHeader.askBeforeSwitch(tabId, background, go, () => undefined, { question: 'Resume here anyway?', action: 'Resume' })
  })
}

/** a tab's view is main's to change: it refuses while Claude works, and the tab then stays in its view */
function switchTo(tabId: string, view: TabView): void {
  void ct.setTabView(tabId, view).then((ok) => { if (!ok) showToast(`Cannot switch to ${view === 'chat' ? 'Chat' : 'Terminal'} now`) })
}

/**
 * A tab left with something unfinished pulses as one Claude waits in: marked unread, or a Claude tab whose reply is not
 * read to its end or whose prompt holds a draft (notifications.autoUnread).
 */
function leave(t: TabState): void {
  // a chat has no screen to read: only a terminal can be left unfinished
  const unfinished = settings.notifications.autoUnread && t.info.kind === 'claude' && !t.info.exited && t.view !== null && leftUnfinished(t.view.screen())
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
  // the focus inside the tab being left goes with it: a field there is no field in front, so the card of the tab that comes may take the keyboard
  const at = document.activeElement
  if (left && at instanceof HTMLElement && (left.chat?.element.contains(at) || left.view?.element.contains(at))) at.blur()
  activeId = tabId
  frontFallback.activated(tabId)
  planList.close()
  const busy = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement
  const focus = !busy
  for (const [id, t] of tabs) showTab(t, id === tabId, focus)
  const t = tabs.get(tabId)
  if (t) {
    t.bell = false
    t.attention = false
    t.waitReason = null
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
  // a chat in front is drawn from its snapshot, as it is now
  if (t && isChatView(t)) loadChat(tabId)
  reviewPanel.show(claude ? reviewUpdates.get(tabId) ?? null : null)
  // the images first: setAvailable can switch a shown Changes panel to Images and fire onChange, which must find this tab's images
  imagePanel.show(imageUpdates.get(tabId) ?? { tabId, cards: [], unseen: 0, notice: null })
  sidePanel.setAvailable('changes', claude)
  if (pendingReveal.delete(tabId)) sidePanel.open('changes')
  showDocs(tabId, claude)
  mailPanel.show(tabId)
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
  // drawn again in place: the menu on screen does not pop in a second time
  m.el = showMenu(m.at, m.build(), { animate: false })
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
    { label: 'Recent sessions…', hint: shortcutLabel('recentSessions', ct.platform), action: () => void sessionsWindow.open() },
    ...(restoreInfo ? [{ label: `Restore previous session (${restoreInfo.tabs})`, action: () => ct.runRestore() }] : []),
    { label: '', separator: true },
    { label: 'Settings…', hint: shortcutLabel('openSettings', ct.platform), action: () => ct.openSettingsWindow() },
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

/**
 * A device's chip menu: its new Claude tab and one tab per profile (loading until it answers), then Fold or Unfold;
 * offline, only that. A device with no tab has nothing to fold: its menu is the new tabs alone.
 */
function chipItems(deviceId: string): MenuItem[] {
  const fold: MenuItem[] = groupTabs(deviceId).length === 0 ? [] : [{ label: folded.has(deviceId) ? REMOTE_COPY.unfold : REMOTE_COPY.fold, action: () => toggleGroup(deviceId) }]
  if (!isOnline(deviceId)) return fold
  const answer = choices.devices.find((d) => d.device === deviceId)?.value ?? null
  const profiles: MenuItem[] = answer
    ? answer.profiles.map((p) => ({ label: REMOTE_COPY.newProfileTab(p), action: () => void ct.openRemoteTab(deviceId, 'shell', p, null) }))
    : [{ label: REMOTE_COPY.loading, disabled: true }]
  const tail: MenuItem[] = fold.length === 0 ? [] : [{ label: '', separator: true }, ...fold]
  return [{ label: REMOTE_COPY.newClaudeTab, action: () => void ct.openRemoteTab(deviceId, 'claude', null, null) }, ...profiles, ...tail]
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
    closed: () => { if (activeId) focusTab(activeId) }
  })
}

/** the chat's code is set in the terminal's font setting as it is written (a list of families), with a generic monospace after it */
function setCodeFont(family: string): void {
  document.documentElement.style.setProperty('--mono', `${family}, monospace`)
}

function applySettings(s: Settings): void {
  const prev = settings
  settings = s
  // a change to some other setting keeps the Ctrl+= zoom
  if (s.font.family !== prev.font.family || s.font.size !== prev.font.size) {
    fontSize = s.font.size
    for (const t of tabs.values()) t.view?.setFont(s.font.family, fontSize)
  }
  if (s.font.family !== prev.font.family) setCodeFont(s.font.family)
  // the conversation's width follows the setting in every open chat, at once
  if (s.chat.fullWidth !== prev.chat.fullWidth) for (const t of tabs.values()) t.chat?.setFullWidth(s.chat.fullWidth)
  if (JSON.stringify(s.theme) !== JSON.stringify(prev.theme)) {
    const theme = resolveTheme(s.theme)
    for (const t of tabs.values()) t.view?.setTheme(theme)
    for (const t of tabs.values()) t.chat?.setTheme(theme)
    // the sheet's surround in the terminal's own background: the gutter reads as part of the terminal in every theme
    document.documentElement.style.setProperty('--term-bg', resolveTheme(s.theme).background ?? '')
  }
  if (activeId) renderStatus(activeId)
  // the Messages panel closes with its setting: setAvailable alone would show Media in its place
  if (s.agentMessages.enabled !== prev.agentMessages.enabled) {
    if (!s.agentMessages.enabled && sidePanel.isShowing('messages')) sidePanel.hide()
    sidePanel.setAvailable('messages', s.agentMessages.enabled)
    refreshPanelButtons()
  }
  // the envelope marks follow the messages' setting and the marks setting
  if (s.agentMessages.enabled !== prev.agentMessages.enabled || s.agentMessages.marks !== prev.agentMessages.marks) {
    refreshPanelButtons()
    renderTabs()
  }
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
  // the platform and the full-screen state style the window's own bar; the state is subscribed before the first wait,
  // so the value main sends as the window shows is seen early. The window never starts in full screen, so a missed
  // first value still leaves the right state
  document.body.classList.add(`platform-${ct.platform}`)
  ct.onFullScreen((on) => document.body.classList.toggle('fullscreen', on))
  // the bundled Inter is a local file: the wait is a frame or two, and nothing reflows once the window is built. The title bar
  // is built after it, as is every subscription below
  await loadInter()
  titleBar = new TitleBar(document.getElementById('titlebar')!)
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
    openRecent: () => void sessionsWindow.open(),
    openSettings: () => ct.openSettingsWindow(),
    openNotifications: () => ct.openSettingsWindow('notifications'),
    openMenu: (anchor) => newTabMenu(anchor),
    tabMenu,
    toggleGroup,
    groupMenu: (id, at) => menuRequest(Promise.resolve(null), () => showChoiceMenu(at, () => chipItems(id))),
    toggleImages: () => {
      runAction({ type: 'toggleImages' }, activeId)
      if (activeId) focusTab(activeId)
    },
    toggleChanges: () => {
      runAction({ type: 'toggleChanges' }, activeId)
      if (activeId) focusTab(activeId)
    },
    toggleDocs: () => {
      runAction({ type: 'toggleDocs' }, activeId)
      if (activeId) focusTab(activeId)
    },
    toggleMessages: () => {
      sidePanel.toggle('messages')
      if (activeId) focusTab(activeId)
    },
    toggleNote: () => {
      runAction({ type: 'toggleNote' }, activeId)
      // the keyboard goes back to the terminal, unless an empty note took it to be written in
      if (activeId && !document.activeElement?.closest('#note')) focusTab(activeId)
    },
    switchPosition: () => {
      const next: TabPosition = settings.tabs.position === 'top' ? 'left' : 'top'
      void ct.setSetting('tabs.position', next).then((r) => { if (!r.ok) showToast(r.error) }, (e: unknown) => showToast(`Cannot save tabs.position: ${String(e)}`))
    }
  }
  tabBar = new TabBar(document.getElementById('tabbar')!, tabCallbacks, ct.platform)
  tabPanel = new TabPanel(document.getElementById('tabpanel')!, tabCallbacks, ct.platform, layout, (change) => ct.setTabLayout(change))
  sheetHeader = new SheetHeader(document.getElementById('sheet-header')!, {
    ...tabCallbacks,
    switchView: (view) => { if (activeId) switchTo(activeId, view) },
    // files dropped on the header go to the chat in front, as a drop on the sheet does
    drop: (files) => {
      const t = activeId ? tabs.get(activeId) : undefined
      if (t && isChatView(t)) t.chat?.dropFiles(files)
    }
  }, ct.platform)
  document.documentElement.style.setProperty('--term-bg', resolveTheme(settings.theme).background ?? '')
  setCodeFont(settings.font.family)
  showTabs(settings.tabs.position)
  noteOverlay = new NoteOverlay(document.getElementById('note')!, {
    setText: (id, text, generation) => ct.setNoteText(id, text, generation),
    setView: (id, shown, form, generation) => ct.setNoteView(id, shown, form, generation),
    focusTerminal: () => { if (activeId) focusTab(activeId) },
    changed: () => renderTabs()
  }, ct.platform)
  ct.onTabSessionTitle((id, title) => {
    const t = tabs.get(id)
    if (!t) return
    t.sessionTitle = title
    renderTabs()
    renderTitle()
  })
  ct.onTabPlace((id, place) => {
    // the group is known with the first answer for the tab: a later change of its branch keeps a group the user folded
    const first = !places.has(id)
    places.set(id, place)
    if (appInfo.test) placeLog.set(id, [...placeLog.get(id) ?? [], place])
    renderTabs()
    // a new active tab unfolds its group once its place is known: until then it is in No project, which must stay folded;
    // a group the user folded in the meantime stays folded
    if (first && id === activeId && settings.tabs.position === 'left') tabPanel.unfoldFor(id, true)
  })
  searchBar = new SearchBar(
    document.getElementById('search')!,
    findTarget,
    () => {
      // a closed Find leaves no highlight on any chat, whichever tab its search was in
      for (const t of tabs.values()) if (t.chat) chatFinds.get(t.chat)?.clearDecorations()
      if (activeId) focusTab(activeId)
    }
  )
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null
    const onComposer = target?.classList.contains('chat-input') === true
    // AltGr types a character on many layouts (AltGr+7 is { on German). Windows sends it as Ctrl+Alt, so a character key with
    // Ctrl+Alt stays with the composer; a digit is still a tab switch
    if (onComposer && (e.getModifierState('AltGraph') || (e.ctrlKey && e.altKey && [...e.key].length === 1 && !/^\d$/.test(e.key)))) return
    // the chat composer keeps its keys (typing, Enter, Esc, arrows), but an app chord still runs with it focused; its copy
    // and paste are left to the textarea by the checks below
    const composer = onComposer && (e.ctrlKey || e.metaKey || e.altKey)
    if (!composer && (target?.closest('.xterm') || (target?.tagName === 'INPUT' && !target.classList.contains('review-find-input')) || target?.tagName === 'TEXTAREA')) return
    // a chat has no terminal to pass Ctrl+F to: the plain key finds in it, as ⌘F does on macOS (a shell tab keeps Ctrl+Shift+F)
    const front = activeId ? tabs.get(activeId) : undefined
    const chatFind = isPrimaryKey(e, ct.platform) && e.code === 'KeyF' && front !== undefined && isChatView(front)
    const a: KeyAction | null = chatFind ? { type: 'find' } : mapKey(e, ct.platform)
    // a chat's selected text is copied from the page; the terminal copies its own selection in its key handler
    if (a?.type === 'copy' && copyChatSelection()) {
      e.preventDefault()
      return
    }
    if (!a || a.type === 'send' || a.type === 'copyOrInterrupt' || a.type === 'smartPaste' || a.type === 'paste' || a.type === 'copy') return
    e.preventDefault()
    runAction(a, activeId)
  })
  // a chat's selected text goes to the clipboard as the mouse lets go of it, once per gesture (a drag, a double or triple click):
  // only a press that began in the chat in front, a release that changed the selection, and a selection whose focus is in the
  // chat too. So a click on another control with the selection still there, or a drag out to the status bar, copies nothing
  let press: SelectionEnds | null = null
  document.addEventListener('mousedown', (e) => {
    const t = activeId ? tabs.get(activeId) : undefined
    const target = e.target as Element | null
    press = e.button === 0 && t?.chat && isChatView(t) && t.chat.element.contains(target) && !target?.closest?.('textarea, input')
      ? selectionEnds()
      : null
  }, true)
  document.addEventListener('mouseup', (e) => {
    const before = press
    press = null
    if (!before || e.button !== 0 || (e.target as Element | null)?.closest?.('textarea, input')) return
    const now = selectionEnds()
    if (sameEnds(before, now)) return
    // the conversation, not the whole chat: the composer is in the chat's element too, and a drag can end in it
    const body = (activeId ? tabs.get(activeId) : undefined)?.chat?.element.querySelector(':scope > .chat-body')
    if (!body || !body.contains(now.anchor) || !body.contains(now.focus)) return
    // the setting is read here, so a change applies to the next selection with no restart
    if (!settings.chat.copyOnSelect) return
    copyChatSelection()
  })
  // a file dropped outside a terminal must not navigate the window
  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', (e) => e.preventDefault())
  lightbox = new Lightbox(document.getElementById('lightbox')!)
  sessionsWindow = new RecentSessionsWindow(document.getElementById('sessions')!, {
    load: () => ct.listSessions(),
    loadRemote: () => ct.listRemoteSessions(),
    open: (id, device) => ct.openSession(id, device),
    opening: closeMenu,
    setStarred: (id, starred) => void ct.setSessionStarred(id, starred),
    closed: () => { if (activeId) focusTab(activeId) }
  }, ct.platform)
  folderDialog = new FolderDialog(document.getElementById('folder-dialog')!)
  ct.onStarred((ids) => sessionsWindow.applyStars(new Set(ids)))
  ct.onRemoteSessions((list) => sessionsWindow.applyRemote(list))
  planList = new PlanList(document.getElementById('plan-list')!, () => { if (activeId) focusTab(activeId) }, () => { if (activeId) ct.clearTaskList(activeId) })
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
  statusBar.alignTo(document.getElementById('terminals')!)
  ct.onAccounts((v) => {
    accounts = v.accounts
    renderTitle()
    if (activeId) renderStatus(activeId)
    renderTabs()
  })
  // the plan is read once, after the window is up: the foot names the login until then
  void ct.accountPlan().catch(() => null).then((plan) => {
    mainPlan = plan
    renderTabs()
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
    else {
      t.attention = true
      t.waitReason = reason
    }
    renderTabs()
  })
  ct.onBanner(showBanner)
  // another device's tab was answered: its pulse stops here; this device's unread mark is its own and stays
  ct.onAttentionClear((tabId) => {
    closeBanner(tabId)
    const t = tabs.get(tabId)
    if (!t) return
    t.attention = false
    t.waitReason = null
    t.bell = false
    renderTabs()
  })
  // before main types a continue into a Claude tab: only this window has the terminal's screen
  ct.onPromptQuery((queryId, tabId) => {
    const t = tabs.get(tabId)
    // a chat-view tab has no terminal screen: its prompt is the composer's, and a draft in it holds the continue back
    if (t && isChatView(t)) {
      ct.answerPrompt(queryId, t.chat?.hasDraft() === true ? 'draft' : 'empty')
      return
    }
    const text = t?.view ? promptText(t.view.screen().rows) : null
    ct.answerPrompt(queryId, text === null ? 'none' : text === '' ? 'empty' : 'draft')
  })
  sidePanel = new SidePanel(document.getElementById('image-panel')!, document.getElementById('terminals')!, { images: settings.imagePanel.width, changes: settings.review.width, docs: settings.review.width, messages: settings.review.width }, (width, resize) => ct.setPanel(width, resize))
  sidePanel.setAvailable('messages', settings.agentMessages.enabled)
  ct.onPanelMode((mode) => sidePanel.setMode(mode))
  imagePanel = new ImagePanel(
    sidePanel.bodies.images,
    sidePanel,
    {
      action: (id, action) => ct.imageAction(id, action),
      insertPath: (p) => {
        if (!activeId) return
        handleInput(activeId, `"${p}" `)
        focusTab(activeId)
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
      activeTabId: () => (activeId && tabs.get(activeId)?.info.kind === 'claude' ? activeId : null),
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
  mailPanel = new MailPanel(sidePanel.bodies.messages, sidePanel.tools.messages, sidePanel, {
    conversations: (tabId) => ct.getMailConversations(tabId),
    markRead: (ids) => ct.markMailRead(ids)
  })
  sidePanel.onChange = () => {
    imagePanel.panelChanged()
    reviewPanel.panelChanged()
    docPanel.panelChanged()
    mailPanel.refresh()
    refreshPanelButtons()
  }
  // the unread counts change with the mail: the badges, and the panel when it shows the messages
  ct.onMail((unread) => {
    const marksBefore = mailMarks()
    mailUnread = unread
    refreshPanelButtons()
    mailPanel.refresh()
    // the envelope marks of the tabs and the device chips follow the unread counts; the tabs are redrawn only when
    // a mark comes or goes, since a redraw replaces the group heads and can swallow a click on one
    if (mailMarks() !== marksBefore) renderTabs()
  })
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
    // a chat's bubble whose image card comes now shows its thumbnail
    tabs.get(u.tabId)?.chat?.imagesChanged()
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
    const viewChanged = t.info.view !== info.view
    t.info = info
    if (viewChanged) applyView(t)
    renderTabs()
    // a switch of the account shows at once
    if (info.id === activeId) renderStatus(info.id)
  })
  // the patches of the chat in front; a patch that does not follow the chat's revision asks for its snapshot again
  ct.onChatPatch((tabId, fromRev, toRev, patches) => {
    const t = tabs.get(tabId)
    if (!t || tabId !== activeId || !isChatView(t)) return
    if (!t.chat?.patch(fromRev, toRev, patches)) loadChat(tabId)
  })
  // a remote chat's snapshot came (a member attached its tab): the chat in front is drawn from it again
  ct.onChatReload((tabId) => {
    const t = tabs.get(tabId)
    if (t && tabId === activeId && isChatView(t)) loadChat(tabId)
  })
  ct.onTabClosed((id) => {
    closeBanner(id)
    const t = tabs.get(id)
    if (!t) return
    const frontBefore = activeId
    const wasFront = id === activeId
    if (wasFront) planList.close()
    t.view?.dispose()
    // the closed chat's Find clears the page's highlights when it painted them last
    if (t.chat) chatFinds.get(t.chat)?.clearDecorations()
    t.chat?.dispose()
    chatLoads.delete(id)
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
      titleBar.render([])
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
  // a tab without its terminal yet gets one first: its process's output can come before the view change is drawn. A chat
  // tab has no terminal: output still in flight from its terminal is dropped, so no hidden xterm is built for it
  ct.onPtyData((id, data) => {
    const t = tabs.get(id)
    if (t && !isChatView(t)) ensureTerminal(t).write(data)
  })
  ct.onPtyReset((id) => {
    const t = tabs.get(id)
    if (!t) return
    t.view?.reset()
    // the stopped process's title and marks don't describe the new one
    t.oscTitle = null
    t.bell = false
    t.attention = false
    t.waitReason = null
    t.unread = false
    renderTabs()
  })
  ct.onPtyExit((id, code) => tabs.get(id)?.view?.write(`\r\n\x1b[90m[process exited with code ${code}] Enter — restart, ${shortcutLabel('closeTab', ct.platform)} — close\x1b[0m\r\n`))
  // the size of a tab that another device typed into last; null: this window's own fit applies again
  ct.onTabSize((id, size) => tabs.get(id)?.view?.setFixedSize(size))
  // a copy of this window's tab on another device: the screen, once the output before the request is written
  ct.onScreenSeed((id, token) => {
    const view = tabs.get(id)?.view
    if (!view) ct.seedScreen(id, token, '')
    else view.term.write('', () => ct.seedScreen(id, token, view.serialize(MAX_SNAPSHOT_BYTES)))
  })
  ct.onToast((m) => showToast(m))
  ct.onSettings(applySettings)
  window.addEventListener('focus', () => {
    if (sessionsWindow.isOpen || folderDialog.isOpen) return
    if (document.activeElement?.closest('#image-panel, #note')) return
    if (activeId) focusTab(activeId)
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
        const view = tabs.get(id ?? activeId ?? '')?.view
        return view ? { cols: view.term.cols, rows: view.term.rows } : null
      },
      bufferText: (id) => tabs.get(id ?? activeId ?? '')?.view?.bufferText() ?? '',
      themeBackground: () => (activeId ? tabs.get(activeId)?.view?.term.options.theme?.background ?? null : null),
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
