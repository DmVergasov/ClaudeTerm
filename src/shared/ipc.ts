import type { AccountResult, AccountsView } from './accounts'
import type { DocAction, DocRead, DocsUpdate } from './docs'
import type { MailConversationView, MailUnread } from './mail'
import type { DeviceResult, DevicesView } from './devices'
import type { Note, NoteForm } from './note'
import type { ReviewScope, ReviewSendState, ReviewUpdate } from './review'
import type { DeviceAnswer, DeviceChoices, FolderResult, RemoteDeviceView } from './remote'
import type { SettingKey, SettingValue } from './settings-keys'
import type { AgentStatus, BackgroundTask, ImageCard, MainStatus, NotificationCase, OpenTabRequest, PanelMode, PlanStatus, RecentSession, Settings, TabInfo, TabKind, TabLayout, TabPlace, UpdateState } from './types'

export const IPC = {
  appInfo: 'app:info',
  rendererReady: 'app:renderer-ready',
  bell: 'app:bell',
  tabsOpen: 'tabs:open',
  tabsClose: 'tabs:close',
  tabsActivate: 'tabs:activate',
  /** a click on a system notification: the window comes forward */
  windowFocus: 'window:focus',
  /** the main window entered or left full screen (or shows at start): the bar drops the space of the traffic lights */
  fullScreen: 'window:full-screen',
  /** how many tabs need the user: the app icon shows it */
  attentionCount: 'attention:count',
  tabsRename: 'tabs:rename',
  tabsReorder: 'tabs:reorder',
  tabsRestart: 'tabs:restart',
  tabsSwitchAccount: 'tabs:switch-account',
  tabsMute: 'tabs:mute',
  tabsCanFork: 'tabs:can-fork',
  tabsFork: 'tabs:fork',
  tabsChangeFolder: 'tabs:change-folder',
  foldersList: 'folders:list',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  promptAnswer: 'prompt:answer',
  profilesList: 'profiles:list',
  settingsGet: 'settings:get',
  settingsOpen: 'settings:open',
  settingsOpenWindow: 'settings:open-window',
  settingsView: 'settings:view',
  settingsSet: 'settings:set',
  settingsPickSound: 'settings:pick-sound',
  settingsPlaySound: 'settings:play-sound',
  clipboardRead: 'clipboard:read',
  clipboardWriteText: 'clipboard:write-text',
  clipboardImageAsFile: 'clipboard:image-as-file',
  clipboardSaveImage: 'clipboard:save-image',
  imagesList: 'images:list',
  imagesMarkSeen: 'images:mark-seen',
  imagesAction: 'images:action',
  docsRead: 'docs:read',
  docsStamp: 'docs:stamp',
  docsAction: 'docs:action',
  docsOpenEditor: 'docs:open-editor',
  restoreGet: 'restore:get',
  restoreRun: 'restore:run',
  sessionsList: 'sessions:list',
  sessionsOpen: 'sessions:open',
  sessionsStar: 'sessions:star',
  sessionsStarred: 'sessions:starred',
  notesSetText: 'notes:set-text',
  notesSetView: 'notes:set-view',
  tasksClear: 'tasks:clear',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateGet: 'update:get',
  openExternal: 'shell:open-external',
  reviewSetScope: 'review:set-scope',
  reviewClearRequest: 'review:clear-request',
  reviewRefresh: 'review:refresh',
  reviewSetViewed: 'review:set-viewed',
  reviewShowFile: 'review:show-file',
  reviewOpenEditor: 'review:open-editor',
  reviewReveal: 'review:reveal',
  reviewCanSend: 'review:can-send',
  reviewLines: 'review:lines',
  panelSet: 'panel:set',
  layoutGet: 'layout:get',
  layoutSet: 'layout:set',
  accountsList: 'accounts:list',
  accountsAdd: 'accounts:add',
  accountsRename: 'accounts:rename',
  accountsSetToken: 'accounts:set-token',
  accountsRemove: 'accounts:remove',
  accountsGetToken: 'accounts:get-token',
  devicesView: 'devices:view',
  devicesStartPairing: 'devices:start-pairing',
  devicesCancelPairing: 'devices:cancel-pairing',
  devicesJoin: 'devices:join',
  devicesRemove: 'devices:remove',
  devicesLeave: 'devices:leave',
  devicesSetAddress: 'devices:set-address',
  devicesRename: 'devices:rename',
  devicesChoices: 'devices:choices',
  remoteDevices: 'remote:devices',
  remoteOpenTab: 'remote:open-tab',
  remoteSessions: 'remote:sessions',
  remotePasteImage: 'remote:paste-image',
  remoteDropFiles: 'remote:drop-files',
  typedPaths: 'paths:typed',
  screenSeed: 'screen:seed',
  evTabOpened: 'ev:tab-opened',
  evTabUpdated: 'ev:tab-updated',
  evTabClosed: 'ev:tab-closed',
  evTabActivated: 'ev:tab-activated',
  evTabsOrder: 'ev:tabs-order',
  evTabPlace: 'ev:tab-place',
  evPtyData: 'ev:pty-data',
  evPtyExit: 'ev:pty-exit',
  evPtyReset: 'ev:pty-reset',
  evImages: 'ev:images',
  evToast: 'ev:toast',
  evSettings: 'ev:settings',
  evSettingsView: 'ev:settings-view',
  evSettingsSection: 'ev:settings-section',
  evRestore: 'ev:restore',
  evStatus: 'ev:status',
  evPlan: 'ev:plan',
  evAttention: 'ev:attention',
  evBanner: 'ev:banner',
  evUpdate: 'ev:update',
  evReview: 'ev:review',
  evPanelMode: 'ev:panel-mode',
  evAccounts: 'ev:accounts',
  evNote: 'ev:note',
  evPromptQuery: 'ev:prompt-query',
  evDocs: 'ev:docs',
  evDevices: 'ev:devices',
  evRemoteDevices: 'ev:remote-devices',
  evDeviceChoices: 'ev:device-choices',
  evRemoteSessions: 'ev:remote-sessions',
  evTabSize: 'ev:tab-size',
  evAttentionClear: 'ev:attention-clear',
  evScreenSeed: 'ev:screen-seed',
  /** the full set of starred session ids, sent when another device changes the set or sync restores it (not for a star set here): a listener replaces its set with it */
  evStarred: 'ev:starred',
  /** the unread agent messages per tab, local and remote, sent on every change of the mail and of the tabs */
  evMail: 'ev:mail',
  mailConversations: 'mail:conversations',
  mailRead: 'mail:read'
} as const

export interface AppInfo {
  /** Windows build number, for xterm's ConPTY handling; null elsewhere */
  windowsBuild: number | null
  test: boolean
  homeDir: string
  version: string
}

export interface ClipboardContent {
  text: string
  hasImage: boolean
}

export type ImageAction = 'open' | 'reveal' | 'copy-image' | 'copy-path' | 'remove'

export interface ImagesUpdate {
  tabId: string
  cards: ImageCard[]
  unseen: number
  notice: string | null
  /** the tab runs on another device: its cards are served from that device, and some actions are that device's alone */
  remote?: boolean
}

export interface StatusUpdate {
  tabId: string
  main: MainStatus | null
  agents: AgentStatus[]
  /** the background work still running when Claude's last turn ended */
  background: BackgroundTask[]
}

export interface PlanUpdate {
  tabId: string
  plan: PlanStatus | null
  /** the plan shown is the task list Claude keeps with set_task_list, which can be cleared, not a superpowers plan */
  agentList?: boolean
}

export interface RestoreInfo {
  tabs: number
  claudeTabs: number
  savedAt: string
}

/** what the settings window shows */
export interface SettingsView {
  settings: Settings
  /** profile names, in the order of the new tab menu */
  profiles: string[]
  /** settings.json */
  path: string
  /** notices from the last load of settings.json */
  problems: string[]
  /** settings.json cannot be read or is not a JSON object: the window does not edit it */
  locked: boolean
}

export type SetSettingResult = { ok: true } | { ok: false; error: string }

export type Unsubscribe = () => void

/** what Claude Code's prompt in a tab holds: only its placeholder, text the user typed and did not send, or no prompt on screen */
export type PromptState = 'empty' | 'draft' | 'none'
export const PROMPT_STATES: readonly PromptState[] = ['empty', 'draft', 'none']

export interface CtApi {
  /** process.platform of the app ('win32', 'linux'); known at once, without a round trip */
  readonly platform: string
  appInfo(): Promise<AppInfo>
  rendererReady(): void
  /** the terminal in that tab rang its bell (BEL) */
  bell(tabId: string): void
  openTab(req: OpenTabRequest): Promise<TabInfo | null>
  closeTab(tabId: string): void
  activateTab(tabId: string): void
  /** brings the window forward, as a click on a system notification does */
  focusWindow(): void
  /** how many tabs need the user now: the Dock icon, the launcher or the taskbar button shows it */
  setAttentionCount(count: number): void
  renameTab(tabId: string, title: string | null): void
  reorderTabs(ids: string[]): void
  /** `live` also restarts a tab whose process is still running */
  restartTab(tabId: string, live?: boolean): void
  /** restarts a Claude tab on another account (null: the main one), resuming its conversation */
  switchAccount(tabId: string, account: string | null): void
  /** a muted tab makes no notification sound; it is still marked and still flashes the taskbar */
  muteTab(tabId: string, muted: boolean): void
  /** a Claude tab with a saved conversation can be forked */
  canForkTab(tabId: string): Promise<boolean>
  /** opens a new Claude tab that forks the tab's conversation, after its family */
  forkTab(tabId: string): void
  /** the subfolders of the tab's folder (null: the tab's own folder), read on the tab's device, with the folders recently used there */
  listFolders(tabId: string, path: string | null): Promise<FolderResult>
  /** moves the tab to another folder on its device; a refusal is its message (a remote tab goes to its device) */
  changeFolder(tabId: string, path: string): Promise<DeviceResult>
  writePty(tabId: string, data: string): void
  resizePty(tabId: string, cols: number, rows: number): void
  /** the answer to a query of onPromptQuery */
  answerPrompt(queryId: number, state: PromptState): void
  /** the agent messages of a tab's conversation, or of every conversation (null), for the panel */
  getMailConversations(tabId: string | null): Promise<MailConversationView[]>
  /** marks the messages with these ids read */
  markMailRead(ids: string[]): Promise<void>
  listProfiles(): Promise<string[]>
  getSettings(): Promise<Settings>
  openSettingsFile(): void
  /** opens the settings window, or brings it forward */
  openSettingsWindow(): void
  getSettingsView(): Promise<SettingsView>
  /** writes one setting to settings.json and applies it */
  setSetting(key: SettingKey, value: SettingValue): Promise<SetSettingResult>
  /** asks for a .wav file; saves nothing */
  pickSound(): Promise<string | null>
  /** plays the notification sound now in use */
  playSound(): void
  readClipboard(): Promise<ClipboardContent>
  writeClipboardText(text: string): void
  /** Windows: whether Claude Code cannot read a clipboard image itself, so a pasted one goes to it as a file; checked once per run */
  imagePasteAsFile(): Promise<boolean>
  /** saves the clipboard's image to a PNG file in the temp folder and answers its path; null when there is no image */
  saveClipboardImage(): Promise<string | null>
  listImages(tabId: string): Promise<ImagesUpdate>
  markImagesSeen(tabId: string): void
  imageAction(cardId: string, action: ImageAction): void
  /** the text of a document of a Claude tab, and the stamp it was read at; an error when it cannot be read */
  readDoc(docId: string): Promise<DocRead>
  /** the document's stamp (a change means the file changed on disk); null when it is gone or unknown */
  docStamp(docId: string): Promise<string | null>
  /** an action from the Docs panel on one of its documents */
  docAction(docId: string, action: DocAction): void
  /** opens a Markdown document in review.editor at that line; main ignores other documents */
  openDocInEditor(docId: string, line: number): void
  getRestoreInfo(): Promise<RestoreInfo | null>
  runRestore(): void
  /** the most recent Claude Code sessions, newest first, and every starred one */
  listSessions(): Promise<RecentSession[]>
  /** the other devices' Recent sessions at once, from their last answers (without the sessions this device lists); asks every online device again in the background */
  listRemoteSessions(): Promise<DeviceAnswer<RecentSession[]>[]>
  /** go to the tab in that conversation, or resume it in a new Claude tab; device: the device of the section it was picked in */
  openSession(id: string, device?: string): void
  /** star or unstar a session; answers when the change is saved */
  setSessionStarred(id: string, starred: boolean): Promise<void>
  /** the ids of all starred sessions */
  getStarredSessions(): Promise<string[]>
  /**
   * the text of a Claude tab's note; main keeps it with the tab's conversation. `generation`: the number of the note it was
   * typed against (onNote; 0 before any)
   */
  setNoteText(tabId: string, text: string, generation: number): void
  /** whether a Claude tab's note is on show, and how it is drawn; `generation` as for setNoteText */
  setNoteView(tabId: string, shown: boolean, form: NoteForm, generation: number): void
  /** removes the task list Claude keeps in a Claude tab with set_task_list (the one the task box can clear) */
  clearTaskList(tabId: string): void
  checkForUpdates(): void
  installUpdate(): void
  getUpdateState(): Promise<UpdateState>
  openExternal(url: string): void
  pathForFile(file: File): string
  setReviewScope(tabId: string, scope: ReviewScope): void
  /** back from a show_diff request to the scope chosen before */
  clearReviewRequest(tabId: string): void
  refreshReview(tabId: string): void
  setReviewViewed(tabId: string, path: string, hash: string, viewed: boolean): void
  /** "show anyway" for a too large file */
  showReviewFile(tabId: string, path: string): void
  /** opens a file of that tab's Changes view in review.editor; main ignores a file the view does not show */
  openInEditor(tabId: string, path: string, line: number): void
  /** shows a file of that tab's Changes view in the file manager; main ignores a file the view does not show */
  revealFile(tabId: string, path: string): void
  /** whether Send may write into the tab now */
  reviewCanSend(tabId: string): Promise<ReviewSendState>
  /**
   * lines from..to (from 1, at most 1000) of a file of that tab's Changes view, the content with that hash: the lines its hunks
   * hide. Null when the view does not hold that content now
   */
  reviewLines(tabId: string, path: string, hash: string, from: number, to: number): Promise<string[] | null>
  /**
   * The side panel opened at `width` px, closed (0) or switched to a panel of another width: main widens or narrows the window
   * for it and answers how the panel is to be shown. `resize` false: its edge was dragged, the window stays as it is.
   */
  setPanel(width: number, resize: boolean): Promise<PanelMode>
  /** the left tab panel's width and folded groups */
  getTabLayout(): Promise<TabLayout>
  /** saves the part of the left tab panel's layout that is given; the width is kept within TAB_PANEL_WIDTH (110 to 480 px) */
  setTabLayout(change: Partial<TabLayout>): void
  /** the extra accounts, without their tokens */
  listAccounts(): Promise<AccountsView>
  addAccount(name: string, token: string): Promise<AccountResult>
  renameAccount(id: string, name: string): Promise<AccountResult>
  /** tabs on the account use the new token from their next start */
  setAccountToken(id: string, token: string): Promise<AccountResult>
  /** tabs on the account keep running, and start on the main account next time */
  removeAccount(id: string): Promise<AccountResult>
  /** opens a tab running `claude setup-token` in the main window */
  getToken(): void
  /** the device sync section: `enabled: false` while this device has no group yet */
  getDevicesView(): Promise<DevicesView>
  /** opens the group if there is none yet (this device gets its identity), then shows a pairing code */
  startDevicePairing(): Promise<DevicesView>
  cancelDevicePairing(): void
  /** opens the group if there is none yet, then joins the group of the device at `address` with the code it shows */
  joinDevice(address: string, code: string): Promise<DeviceResult>
  removeDevice(id: string): Promise<DeviceResult>
  /** the group hears of the leaving only while another device is connected */
  leaveDeviceGroup(): Promise<DeviceResult>
  /** the address typed on this device for another device; null clears it */
  setDeviceAddress(id: string, address: string | null): Promise<DeviceResult>
  renameThisDevice(name: string): Promise<DeviceResult>
  /** the tabs of the other devices of the group that this device shows, with each device's name and whether it is online */
  getRemoteDevices(): Promise<RemoteDeviceView[]>
  /** the new-tab menu's answers: this device's name in the group, and each online device's last answer to its profiles and accounts (at once; a refresh is started) */
  listDeviceChoices(): Promise<{ self: string; devices: DeviceAnswer<DeviceChoices>[] }>
  /** opens a tab on another device, in its default folder; answers its id, or null (the window is told why) */
  openRemoteTab(device: string, kind: TabKind, profile: string | null, account: string | null): Promise<string | null>
  /** the clipboard's image copied to the tab's device; answers the text to type for the path it was saved at there, or null (no image, or a refusal, which is toasted) */
  pasteImageToRemote(tabId: string): Promise<string | null>
  /** the files of this device copied to the tab's device; answers the text to type for their paths there, or null (a refusal is toasted) */
  dropFilesToRemote(tabId: string, paths: string[]): Promise<string | null>
  /** the text typed for paths dropped on a local tab, quoted for its shell; null for an unknown tab or bad paths */
  typedPaths(tabId: string, paths: string[]): Promise<string | null>
  /** the answer to onScreenSeed: the tab's screen, serialized (empty when the tab is unknown), with the token of the request */
  seedScreen(tabId: string, token: number, data: string): void
  onTabOpened(cb: (tab: TabInfo) => void): Unsubscribe
  onTabUpdated(cb: (tab: TabInfo) => void): Unsubscribe
  onTabClosed(cb: (tabId: string) => void): Unsubscribe
  onTabActivated(cb: (tabId: string) => void): Unsubscribe
  onTabsOrder(cb: (ids: string[]) => void): Unsubscribe
  /** a tab's project, worktree and branch changed; null when its folder is not in git */
  onTabPlace(cb: (tabId: string, place: TabPlace | null) => void): Unsubscribe
  onPtyData(cb: (tabId: string, data: string) => void): Unsubscribe
  onPtyExit(cb: (tabId: string, code: number) => void): Unsubscribe
  onPtyReset(cb: (tabId: string) => void): Unsubscribe
  onImages(cb: (update: ImagesUpdate) => void): Unsubscribe
  onToast(cb: (message: string) => void): Unsubscribe
  onSettings(cb: (settings: Settings) => void): Unsubscribe
  onSettingsView(cb: (view: SettingsView) => void): Unsubscribe
  /** the Settings window is asked to show a section while it is open: 'devices' */
  onSettingsSection(cb: (section: string) => void): Unsubscribe
  onRestore(cb: (info: RestoreInfo | null) => void): Unsubscribe
  onStatus(cb: (update: StatusUpdate) => void): Unsubscribe
  onPlan(cb: (update: PlanUpdate) => void): Unsubscribe
  /** mark that tab: the bell dot for 'bell', the pulse for the Claude cases */
  onAttention(cb: (tabId: string, reason: NotificationCase) => void): Unsubscribe
  /** show a system notification for that tab: the window is in the background */
  onBanner(cb: (tabId: string, reason: NotificationCase) => void): Unsubscribe
  onUpdate(cb: (state: UpdateState) => void): Unsubscribe
  onReview(cb: (update: ReviewUpdate) => void): Unsubscribe
  /** the window was maximized, restored, or entered or left full screen, or sidePanel.noRoom changed */
  onPanelMode(cb: (mode: PanelMode) => void): Unsubscribe
  /**
   * the note that comes to a tab from its conversation (null: none), with its number, which the tab's edits carry; not sent
   * for the tab's own edits
   */
  onNote(cb: (tabId: string, note: Note | null, generation: number) => void): Unsubscribe
  /** the extra accounts changed: every window gets the new list */
  onAccounts(cb: (view: AccountsView) => void): Unsubscribe
  /** main asks what Claude Code's prompt in the tab holds, from the terminal's screen; answer with answerPrompt */
  onPromptQuery(cb: (queryId: number, tabId: string) => void): Unsubscribe
  /** the documents of a Claude tab changed: the list, newest first, and the one show_document just showed */
  onDocs(cb: (update: DocsUpdate) => void): Unsubscribe
  /** the device sync section changed: every window gets the new view */
  onDevices(cb: (view: DevicesView) => void): Unsubscribe
  /** the ids of the sessions whose star another device changed */
  onStarred(cb: (ids: string[]) => void): Unsubscribe
  /** the size of a remote tab's PTY changed, from its device (null: back to this window's own size) */
  onTabSize(cb: (tabId: string, size: { cols: number; rows: number } | null) => void): Unsubscribe
  /** the other devices' tabs changed: the new view of the devices and their online state */
  onRemoteDevices(cb: (devices: RemoteDeviceView[]) => void): Unsubscribe
  /** a device's answer to the new-tab menu's lists changed: this device's name and each online device's last answer */
  onDeviceChoices(cb: (view: { self: string; devices: DeviceAnswer<DeviceChoices>[] }) => void): Unsubscribe
  /** another device's Recent sessions changed: each online device's last answer, as listRemoteSessions gives it */
  onRemoteSessions(cb: (list: DeviceAnswer<RecentSession[]>[]) => void): Unsubscribe
  /** a tab's attention was cleared on another device: this window clears its mark */
  onAttentionClear(cb: (tabId: string) => void): Unsubscribe
  /** main asks for the screen of a tab, to copy it on another device; answer with seedScreen, with the same token */
  onScreenSeed(cb: (tabId: string, token: number) => void): Unsubscribe
  /** the unread agent messages per tab changed: the whole map, keyed by tab id */
  onMail(cb: (unread: MailUnread) => void): Unsubscribe
  /** the main window's full-screen state changed (sent when it shows, too) */
  onFullScreen(cb: (on: boolean) => void): Unsubscribe
}
