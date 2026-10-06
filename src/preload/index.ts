import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC, type CtApi } from '../shared/ipc'

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

const api: CtApi = {
  platform: process.platform,
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  rendererReady: () => ipcRenderer.send(IPC.rendererReady),
  bell: (tabId) => ipcRenderer.send(IPC.bell, tabId),
  openTab: (req) => ipcRenderer.invoke(IPC.tabsOpen, req),
  closeTab: (id) => ipcRenderer.send(IPC.tabsClose, id),
  activateTab: (id) => ipcRenderer.send(IPC.tabsActivate, id),
  renameTab: (id, title) => ipcRenderer.send(IPC.tabsRename, id, title),
  reorderTabs: (ids) => ipcRenderer.send(IPC.tabsReorder, ids),
  restartTab: (id, live) => ipcRenderer.send(IPC.tabsRestart, id, live === true),
  writePty: (id, data) => ipcRenderer.send(IPC.ptyWrite, id, data),
  resizePty: (id, cols, rows) => ipcRenderer.send(IPC.ptyResize, id, cols, rows),
  listProfiles: () => ipcRenderer.invoke(IPC.profilesList),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  openSettingsFile: () => ipcRenderer.send(IPC.settingsOpen),
  openSettingsWindow: () => ipcRenderer.send(IPC.settingsOpenWindow),
  getSettingsView: () => ipcRenderer.invoke(IPC.settingsView),
  setSetting: (key, value) => ipcRenderer.invoke(IPC.settingsSet, key, value),
  pickSound: () => ipcRenderer.invoke(IPC.settingsPickSound),
  playSound: () => ipcRenderer.send(IPC.settingsPlaySound),
  readClipboard: () => ipcRenderer.invoke(IPC.clipboardRead),
  writeClipboardText: (text) => ipcRenderer.send(IPC.clipboardWriteText, text),
  listImages: (tabId) => ipcRenderer.invoke(IPC.imagesList, tabId),
  markImagesSeen: (tabId) => ipcRenderer.send(IPC.imagesMarkSeen, tabId),
  imageAction: (cardId, action) => ipcRenderer.send(IPC.imagesAction, cardId, action),
  getRestoreInfo: () => ipcRenderer.invoke(IPC.restoreGet),
  runRestore: () => ipcRenderer.send(IPC.restoreRun),
  listSessions: () => ipcRenderer.invoke(IPC.sessionsList),
  openSession: (id) => ipcRenderer.send(IPC.sessionsOpen, id),
  checkForUpdates: () => ipcRenderer.send(IPC.updateCheck),
  installUpdate: () => ipcRenderer.send(IPC.updateInstall),
  getUpdateState: () => ipcRenderer.invoke(IPC.updateGet),
  openExternal: (url) => ipcRenderer.send(IPC.openExternal, url),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onTabOpened: (cb) => on(IPC.evTabOpened, cb),
  onTabUpdated: (cb) => on(IPC.evTabUpdated, cb),
  onTabClosed: (cb) => on(IPC.evTabClosed, cb),
  onTabActivated: (cb) => on(IPC.evTabActivated, cb),
  onTabsOrder: (cb) => on(IPC.evTabsOrder, cb),
  onPtyData: (cb) => on(IPC.evPtyData, cb),
  onPtyExit: (cb) => on(IPC.evPtyExit, cb),
  onPtyReset: (cb) => on(IPC.evPtyReset, cb),
  onImages: (cb) => on(IPC.evImages, cb),
  onToast: (cb) => on(IPC.evToast, cb),
  onSettings: (cb) => on(IPC.evSettings, cb),
  onSettingsView: (cb) => on(IPC.evSettingsView, cb),
  onRestore: (cb) => on(IPC.evRestore, cb),
  onStatus: (cb) => on(IPC.evStatus, cb),
  onAttention: (cb) => on(IPC.evAttention, cb),
  onUpdate: (cb) => on(IPC.evUpdate, cb)
}

contextBridge.exposeInMainWorld('ct', api)
