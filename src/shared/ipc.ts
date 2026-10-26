import type { AccountResult, AccountsView } from './accounts'
import type { ReviewScope, ReviewSendState, ReviewUpdate } from './review'
import type { SettingKey, SettingValue } from './settings-keys'
import type { AgentStatus, ImageCard, MainStatus, NotificationCase, OpenTabRequest, PanelMode, PlanStatus, RecentSession, Settings, TabInfo, UpdateState } from './types'

export const IPC = {
  appInfo: 'app:info',
  rendererReady: 'app:renderer-ready',
  bell: 'app:bell',
  tabsOpen: 'tabs:open',
  tabsClose: 'tabs:close',
  tabsActivate: 'tabs:activate',
  tabsRename: 'tabs:rename',
  tabsReorder: 'tabs:reorder',
  tabsRestart: 'tabs:restart',
  tabsSwitchAccount: 'tabs:switch-account',
  tabsMute: 'tabs:mute',
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
  restoreGet: 'restore:get',
  restoreRun: 'restore:run',
  sessionsList: 'sessions:list',
  sessionsOpen: 'sessions:open',
  sessionsStar: 'sessions:star',
  sessionsStarred: 'sessions:starred',
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
  panelSet: 'panel:set',
  accountsList: 'accounts:list',
  accountsAdd: 'accounts:add',
  accountsRename: 'accounts:rename',
  accountsSetToken: 'accounts:set-token',
  accountsRemove: 'accounts:remove',
  accountsGetToken: 'accounts:get-token',
  evTabOpened: 'ev:tab-opened',
  evTabUpdated: 'ev:tab-updated',
  evTabClosed: 'ev:tab-closed',
  evTabActivated: 'ev:tab-activated',
  evTabsOrder: 'ev:tabs-order',
  evPtyData: 'ev:pty-data',
  evPtyExit: 'ev:pty-exit',
  evPtyReset: 'ev:pty-reset',
  evImages: 'ev:images',
  evToast: 'ev:toast',
  evSettings: 'ev:settings',
  evSettingsView: 'ev:settings-view',
  evRestore: 'ev:restore',
  evStatus: 'ev:status',
  evPlan: 'ev:plan',
  evAttention: 'ev:attention',
  evUpdate: 'ev:update',
  evReview: 'ev:review',
  evPanelMode: 'ev:panel-mode',
  evAccounts: 'ev:accounts',
  evPromptQuery: 'ev:prompt-query'
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
}

export interface StatusUpdate {
  tabId: string
  main: MainStatus | null
  agents: AgentStatus[]
}

export interface PlanUpdate {
  tabId: string
  plan: PlanStatus | null
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
  renameTab(tabId: string, title: string | null): void
  reorderTabs(ids: string[]): void
  /** `live` also restarts a tab whose process is still running */
  restartTab(tabId: string, live?: boolean): void
  /** restarts a Claude tab on another account (null: the main one), resuming its conversation */
  switchAccount(tabId: string, account: string | null): void
  /** a muted tab makes no notification sound; it is still marked and still flashes the taskbar */
  muteTab(tabId: string, muted: boolean): void
  writePty(tabId: string, data: string): void
  resizePty(tabId: string, cols: number, rows: number): void
  /** the answer to a query of onPromptQuery */
  answerPrompt(queryId: number, state: PromptState): void
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
  getRestoreInfo(): Promise<RestoreInfo | null>
  runRestore(): void
  /** the most recent Claude Code sessions, newest first, and every starred one */
  listSessions(): Promise<RecentSession[]>
  /** go to the tab in that conversation, or resume it in a new Claude tab */
  openSession(id: string): void
  /** star or unstar a session; answers when the change is saved */
  setSessionStarred(id: string, starred: boolean): Promise<void>
  /** the ids of all starred sessions */
  getStarredSessions(): Promise<string[]>
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
   * The side panel opened at `width` px, closed (0) or switched to a panel of another width: main widens or narrows the window
   * for it and answers how the panel is to be shown. `resize` false: its edge was dragged, the window stays as it is.
   */
  setPanel(width: number, resize: boolean): Promise<PanelMode>
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
  onTabOpened(cb: (tab: TabInfo) => void): Unsubscribe
  onTabUpdated(cb: (tab: TabInfo) => void): Unsubscribe
  onTabClosed(cb: (tabId: string) => void): Unsubscribe
  onTabActivated(cb: (tabId: string) => void): Unsubscribe
  onTabsOrder(cb: (ids: string[]) => void): Unsubscribe
  onPtyData(cb: (tabId: string, data: string) => void): Unsubscribe
  onPtyExit(cb: (tabId: string, code: number) => void): Unsubscribe
  onPtyReset(cb: (tabId: string) => void): Unsubscribe
  onImages(cb: (update: ImagesUpdate) => void): Unsubscribe
  onToast(cb: (message: string) => void): Unsubscribe
  onSettings(cb: (settings: Settings) => void): Unsubscribe
  onSettingsView(cb: (view: SettingsView) => void): Unsubscribe
  onRestore(cb: (info: RestoreInfo | null) => void): Unsubscribe
  onStatus(cb: (update: StatusUpdate) => void): Unsubscribe
  onPlan(cb: (update: PlanUpdate) => void): Unsubscribe
  /** mark that tab: the bell dot for 'bell', the pulse for the Claude cases */
  onAttention(cb: (tabId: string, reason: NotificationCase) => void): Unsubscribe
  onUpdate(cb: (state: UpdateState) => void): Unsubscribe
  onReview(cb: (update: ReviewUpdate) => void): Unsubscribe
  /** the window was maximized, restored, or entered or left full screen, or sidePanel.noRoom changed */
  onPanelMode(cb: (mode: PanelMode) => void): Unsubscribe
  /** the extra accounts changed: every window gets the new list */
  onAccounts(cb: (view: AccountsView) => void): Unsubscribe
  /** main asks what Claude Code's prompt in the tab holds, from the terminal's screen; answer with answerPrompt */
  onPromptQuery(cb: (queryId: number, tabId: string) => void): Unsubscribe
}
