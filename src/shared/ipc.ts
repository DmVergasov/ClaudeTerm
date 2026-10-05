import type { AgentStatus, ImageCard, MainStatus, OpenTabRequest, Settings, TabInfo } from './types'

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
  clipboardRead: 'clipboard:read',
  clipboardWriteText: 'clipboard:write-text',
  imagesList: 'images:list',
  imagesMarkSeen: 'images:mark-seen',
  imagesAction: 'images:action',
  restoreGet: 'restore:get',
  restoreRun: 'restore:run',
  openExternal: 'shell:open-external',
  evTabOpened: 'ev:tab-opened',
  evTabUpdated: 'ev:tab-updated',
  evTabClosed: 'ev:tab-closed',
  evTabActivated: 'ev:tab-activated',
  evTabsOrder: 'ev:tabs-order',
  evPtyData: 'ev:pty-data',
  evPtyExit: 'ev:pty-exit',
  evImages: 'ev:images',
  evToast: 'ev:toast',
  evSettings: 'ev:settings',
  evRestore: 'ev:restore',
  evStatus: 'ev:status',
  evAttention: 'ev:attention'
} as const

export interface AppInfo {
  windowsBuild: number
  test: boolean
  homeDir: string
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

export type Unsubscribe = () => void

export interface CtApi {
  appInfo(): Promise<AppInfo>
  rendererReady(): void
  bell(): void
  openTab(req: OpenTabRequest): Promise<TabInfo | null>
  closeTab(tabId: string): void
  activateTab(tabId: string): void
  renameTab(tabId: string, title: string | null): void
  reorderTabs(ids: string[]): void
  restartTab(tabId: string): void
  writePty(tabId: string, data: string): void
  resizePty(tabId: string, cols: number, rows: number): void
  listProfiles(): Promise<string[]>
  getSettings(): Promise<Settings>
  openSettingsFile(): void
  readClipboard(): Promise<ClipboardContent>
  writeClipboardText(text: string): void
  listImages(tabId: string): Promise<ImagesUpdate>
  markImagesSeen(tabId: string): void
  imageAction(cardId: string, action: ImageAction): void
  getRestoreInfo(): Promise<RestoreInfo | null>
  runRestore(): void
  openExternal(url: string): void
  pathForFile(file: File): string
  onTabOpened(cb: (tab: TabInfo) => void): Unsubscribe
  onTabUpdated(cb: (tab: TabInfo) => void): Unsubscribe
  onTabClosed(cb: (tabId: string) => void): Unsubscribe
  onTabActivated(cb: (tabId: string) => void): Unsubscribe
  onTabsOrder(cb: (ids: string[]) => void): Unsubscribe
  onPtyData(cb: (tabId: string, data: string) => void): Unsubscribe
  onPtyExit(cb: (tabId: string, code: number) => void): Unsubscribe
  onImages(cb: (update: ImagesUpdate) => void): Unsubscribe
  onToast(cb: (message: string) => void): Unsubscribe
  onSettings(cb: (settings: Settings) => void): Unsubscribe
  onRestore(cb: (info: RestoreInfo | null) => void): Unsubscribe
  onStatus(cb: (update: StatusUpdate) => void): Unsubscribe
  /** Claude in a background tab is waiting for the user */
  onAttention(cb: (tabId: string) => void): Unsubscribe
}
