import type { SettingKey, SettingValue } from './settings-keys'
import type { AgentStatus, ImageCard, MainStatus, NotificationCase, OpenTabRequest, RecentSession, Settings, TabInfo, UpdateState } from './types'

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
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
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
  imagesList: 'images:list',
  imagesMarkSeen: 'images:mark-seen',
  imagesAction: 'images:action',
  restoreGet: 'restore:get',
  restoreRun: 'restore:run',
  sessionsList: 'sessions:list',
  sessionsOpen: 'sessions:open',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  updateGet: 'update:get',
  openExternal: 'shell:open-external',
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
  evAttention: 'ev:attention',
  evUpdate: 'ev:update'
} as const

export interface AppInfo {
  windowsBuild: number
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

export interface CtApi {
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
  writePty(tabId: string, data: string): void
  resizePty(tabId: string, cols: number, rows: number): void
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
  listImages(tabId: string): Promise<ImagesUpdate>
  markImagesSeen(tabId: string): void
  imageAction(cardId: string, action: ImageAction): void
  getRestoreInfo(): Promise<RestoreInfo | null>
  runRestore(): void
  /** the most recent Claude Code sessions, newest first */
  listSessions(): Promise<RecentSession[]>
  /** go to the tab in that conversation, or resume it in a new Claude tab */
  openSession(id: string): void
  checkForUpdates(): void
  installUpdate(): void
  getUpdateState(): Promise<UpdateState>
  openExternal(url: string): void
  pathForFile(file: File): string
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
  /** mark that tab: the bell dot for 'bell', the pulse for the Claude cases */
  onAttention(cb: (tabId: string, reason: NotificationCase) => void): Unsubscribe
  onUpdate(cb: (state: UpdateState) => void): Unsubscribe
}
