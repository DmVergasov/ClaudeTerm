import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createUpdateBackend, type AutoUpdaterLike } from '../../src/main/update-backend'

function fakeUpdater(result: Awaited<ReturnType<AutoUpdaterLike['checkForUpdates']>>) {
  const events = new EventEmitter()
  const u = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    disableWebInstaller: false,
    logger: null as AutoUpdaterLike['logger'],
    feed: null as unknown,
    installs: [] as [boolean, boolean][],
    setFeedURL(o: unknown) { u.feed = o },
    checkForUpdates: async () => result,
    on: (event: string, cb: (...a: never[]) => void) => events.on(event, cb as (...a: unknown[]) => void),
    quitAndInstall(silent: boolean, runAfter: boolean) { u.installs.push([silent, runAfter]) },
    emit: (event: string, arg: unknown) => events.emit(event, arg)
  }
  return u
}

const log = { info: () => {}, warn: () => {}, error: () => {} }

describe('createUpdateBackend', () => {
  it('configures electron-updater: download automatically, install on quit, no web installer, silent restart', () => {
    const u = fakeUpdater(null)
    const b = createUpdateBackend(u as unknown as AutoUpdaterLike, { log })
    expect([u.autoDownload, u.autoInstallOnAppQuit, u.disableWebInstaller, u.feed]).toEqual([true, true, true, null])
    b.quitAndInstall()
    expect(u.installs).toEqual([[true, true]])
  })

  it('a test feed is generic and never installs on quit', () => {
    const u = fakeUpdater(null)
    createUpdateBackend(u as unknown as AutoUpdaterLike, { log, testFeed: 'http://127.0.0.1:1/' })
    expect(u.feed).toEqual({ provider: 'generic', url: 'http://127.0.0.1:1/' })
    expect(u.autoInstallOnAppQuit).toBe(false)
  })

  it('check resolves the newer version, or null when up to date', async () => {
    expect(await createUpdateBackend(fakeUpdater(null) as unknown as AutoUpdaterLike, { log }).check()).toBeNull()
    const none = fakeUpdater({ isUpdateAvailable: false, updateInfo: { version: '0.1.3' } })
    expect(await createUpdateBackend(none as unknown as AutoUpdaterLike, { log }).check()).toBeNull()
    const some = fakeUpdater({ isUpdateAvailable: true, updateInfo: { version: '0.1.4' }, downloadPromise: Promise.resolve([]) })
    expect(await createUpdateBackend(some as unknown as AutoUpdaterLike, { log }).check()).toBe('0.1.4')
  })

  it('a download that fails later (network drop, bad checksum) is not an unhandled rejection', async () => {
    const seen: unknown[] = []
    const onRejection = (e: unknown): void => { seen.push(e) }
    process.on('unhandledRejection', onRejection)
    try {
      const u = fakeUpdater({ isUpdateAvailable: true, updateInfo: { version: '0.1.4' }, downloadPromise: Promise.reject(new Error('net::ERR_NETWORK_CHANGED')) })
      expect(await createUpdateBackend(u as unknown as AutoUpdaterLike, { log }).check()).toBe('0.1.4')
      await new Promise((r) => setTimeout(r, 20))
    } finally {
      process.off('unhandledRejection', onRejection)
    }
    expect(seen).toEqual([])
  })

  it('forwards downloaded and error events', () => {
    const u = fakeUpdater(null)
    const b = createUpdateBackend(u as unknown as AutoUpdaterLike, { log })
    const got: string[] = []
    b.onDownloaded((v) => got.push(`ready ${v}`))
    b.onError((m) => got.push(`error ${m}`))
    u.emit('update-downloaded', { version: '0.1.4' })
    u.emit('error', new Error('sha512 checksum mismatch'))
    expect(got).toEqual(['ready 0.1.4', 'error sha512 checksum mismatch'])
  })
})
