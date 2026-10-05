import type { UpdaterBackend } from './updater'

/** The part of electron-updater's autoUpdater that ClaudeTerm uses. */
export interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  disableWebInstaller: boolean
  logger: { info(m?: unknown): void; warn(m?: unknown): void; error(m?: unknown): void; debug?(m: string): void } | null
  setFeedURL(options: { provider: 'generic'; url: string }): void
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string }; downloadPromise?: Promise<unknown> | null } | null>
  on(event: 'update-downloaded', cb: (info: { version: string }) => void): unknown
  on(event: 'error', cb: (e: Error) => void): unknown
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void
}

export interface UpdateBackendOptions {
  /** a generic feed for testing (CLAUDETERM_UPDATE_URL); it never installs on quit */
  testFeed?: string
  log: { info(m: string): void; warn(m: string): void; error(m: string): void }
}

export function createUpdateBackend(u: AutoUpdaterLike, o: UpdateBackendOptions): UpdaterBackend {
  if (o.testFeed) u.setFeedURL({ provider: 'generic', url: o.testFeed })
  u.autoDownload = true
  u.disableWebInstaller = true
  // a test feed must never install over the real installation when the app quits
  u.autoInstallOnAppQuit = !o.testFeed
  u.logger = {
    info: (m) => o.log.info(`updater: ${String(m)}`),
    warn: (m) => o.log.warn(`updater: ${String(m)}`),
    error: (m) => o.log.error(`updater: ${String(m)}`),
    debug: () => {}
  }
  return {
    check: async () => {
      const r = await u.checkForUpdates()
      // with autoDownload the download runs on after the check; its failure (a network drop, a bad checksum)
      // also reaches the 'error' event, which logs it. Unobserved, the promise would crash into an error dialog.
      r?.downloadPromise?.catch(() => {})
      return r?.isUpdateAvailable ? r.updateInfo.version : null
    },
    onDownloaded: (cb) => { u.on('update-downloaded', (info) => cb(info.version)) },
    onError: (cb) => { u.on('error', (e) => cb(e.message)) },
    quitAndInstall: () => u.quitAndInstall(true, true)
  }
}
