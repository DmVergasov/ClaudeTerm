import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { bundleOf, createMacUpdateBackend, feedFileUrl, pickZip, releasePage, selfUpdateBlocker, type MacUpdateDeps } from '../../src/main/mac-update'
import type { AutoUpdaterLike, UpdateInfoLike } from '../../src/main/update-backend'

const FILES = [
  { url: 'ClaudeTerm-0.6.0-arm64-mac.zip', sha512: 'arm-zip' },
  { url: 'ClaudeTerm-0.6.0-arm64.dmg', sha512: 'arm-dmg' },
  { url: 'ClaudeTerm-0.6.0-mac.zip', sha512: 'x64-zip' },
  { url: 'ClaudeTerm-0.6.0.dmg', sha512: 'x64-dmg' }
]

describe('bundleOf', () => {
  it('the .app the running program is in', () => {
    expect(bundleOf('/Applications/ClaudeTerm.app/Contents/MacOS/ClaudeTerm')).toBe('/Applications/ClaudeTerm.app')
    expect(bundleOf('/Users/dev/Apps/My Tools/ClaudeTerm.app/Contents/MacOS/ClaudeTerm')).toBe('/Users/dev/Apps/My Tools/ClaudeTerm.app')
    expect(bundleOf('/usr/local/bin/electron')).toBeNull()
  })
})

describe('pickZip', () => {
  it('the zip of this Mac\'s architecture', () => {
    expect(pickZip(FILES, 'arm64')?.sha512).toBe('arm-zip')
    expect(pickZip(FILES, 'x64')?.sha512).toBe('x64-zip')
    expect(pickZip(FILES.filter((f) => !f.url.includes('arm64')), 'arm64')).toBeNull()
    expect(pickZip([], 'x64')).toBeNull()
  })
})

describe('selfUpdateBlocker', () => {
  it('why this copy cannot replace its bundle, or null', () => {
    const can = () => true
    expect(selfUpdateBlocker('/Applications/ClaudeTerm.app', can)).toBeNull()
    expect(selfUpdateBlocker(null, can)).toMatch(/not an app bundle/)
    expect(selfUpdateBlocker('/private/var/folders/x1/T/AppTranslocation/0A1B/d/ClaudeTerm.app', can)).toMatch(/Applications/)
    expect(selfUpdateBlocker('/Volumes/ClaudeTerm 0.6.0/ClaudeTerm.app', () => false)).toMatch(/cannot write/)
  })
})

describe('release addresses', () => {
  it('the files of a GitHub release, or beside the test feed\'s latest-mac.yml', () => {
    expect(feedFileUrl('0.6.0', 'ClaudeTerm-0.6.0-mac.zip')).toBe('https://github.com/DmVergasov/ClaudeTerm/releases/download/v0.6.0/ClaudeTerm-0.6.0-mac.zip')
    expect(feedFileUrl('0.6.0', 'ClaudeTerm-0.6.0-mac.zip', 'http://127.0.0.1:8080/feed')).toBe('http://127.0.0.1:8080/feed/ClaudeTerm-0.6.0-mac.zip')
    expect(feedFileUrl('0.6.0', 'ClaudeTerm-0.6.0-mac.zip', 'http://127.0.0.1:8080/feed/')).toBe('http://127.0.0.1:8080/feed/ClaudeTerm-0.6.0-mac.zip')
    expect(releasePage('0.6.0')).toBe('https://github.com/DmVergasov/ClaudeTerm/releases/tag/v0.6.0')
  })
})

function fakeUpdater(info: UpdateInfoLike | null) {
  const events = new EventEmitter()
  const u = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    disableWebInstaller: false,
    logger: null as AutoUpdaterLike['logger'],
    feed: null as unknown,
    info,
    setFeedURL(o: unknown) { u.feed = o },
    checkForUpdates: async () => (u.info ? { isUpdateAvailable: true, updateInfo: u.info } : { isUpdateAvailable: false, updateInfo: { version: '0.5.0' } }),
    on: (event: string, cb: (...a: never[]) => void) => events.on(event, cb as (...a: unknown[]) => void),
    quitAndInstall() { throw new Error('Squirrel.Mac refuses a build without a Developer ID') },
    emit: (event: string, arg: unknown) => events.emit(event, arg)
  }
  return u
}

function setup(o: Partial<MacUpdateDeps> & { info?: UpdateInfoLike | null } = {}) {
  const u = fakeUpdater(o.info === undefined ? { version: '0.6.0', files: FILES, releaseNotes: '## 0.6.0\n\n- Mac.\n' } : o.info)
  const out: string[] = []
  const fetches: string[] = []
  let finish: (app: string) => void = () => {}
  let fail: (e: Error) => void = () => {}
  const d: MacUpdateDeps = {
    bundle: '/Applications/ClaudeTerm.app',
    arch: 'arm64',
    canReplace: () => true,
    failedVersion: null,
    fileUrl: (v, name) => `https://example.test/v${v}/${name}`,
    fetch: (v, url, sha512) => {
      fetches.push(`${v} ${url} ${sha512}`)
      return new Promise((res, rej) => { finish = res; fail = rej })
    },
    swap: (app, next, v) => out.push(`swap ${app} <- ${next} (${v})`),
    quit: () => out.push('quit'),
    ...o
  }
  const log = { info: (m: string) => out.push(`info:${m}`), warn: (m: string) => out.push(`warn:${m}`), error: (m: string) => out.push(`error:${m}`) }
  const b = createMacUpdateBackend(u as unknown as AutoUpdaterLike, d, { log })
  const seen: string[] = []
  b.onDownloaded((v, notes) => seen.push(`downloaded ${v} ${notes ?? ''}`))
  b.onOffered((v, notes) => seen.push(`offered ${v} ${notes ?? ''}`))
  return { u, b, out, fetches, seen, finish: (app: string) => finish(app), fail: (e: Error) => fail(e) }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('createMacUpdateBackend', () => {
  it('electron-updater only checks: it neither downloads nor installs, which Squirrel.Mac would refuse', () => {
    const { u } = setup()
    expect([u.autoDownload, u.autoInstallOnAppQuit, u.disableWebInstaller, u.feed]).toEqual([false, false, true, null])
  })

  it('a test feed is generic', () => {
    const u = fakeUpdater(null)
    createMacUpdateBackend(u as unknown as AutoUpdaterLike, {} as MacUpdateDeps, { testFeed: 'http://127.0.0.1:1/', log: { info() {}, warn() {}, error() {} } })
    expect(u.feed).toEqual({ provider: 'generic', url: 'http://127.0.0.1:1/' })
  })

  it('downloads this Mac\'s zip of a newer version and reports it downloaded; Restart swaps the bundles and quits', async () => {
    const { b, out, fetches, seen, finish } = setup()
    expect(await b.check()).toBe('0.6.0')
    expect(fetches).toEqual(['0.6.0 https://example.test/v0.6.0/ClaudeTerm-0.6.0-arm64-mac.zip arm-zip'])
    finish('/Users/dev/Library/Application Support/ClaudeTerm/update/0.6.0/ClaudeTerm.app')
    await flush()
    expect(seen).toEqual(['downloaded 0.6.0 ## 0.6.0\n\n- Mac.\n'])
    b.quitAndInstall()
    expect(out.filter((l) => !l.startsWith('info:'))).toEqual(['swap /Applications/ClaudeTerm.app <- /Users/dev/Library/Application Support/ClaudeTerm/update/0.6.0/ClaudeTerm.app (0.6.0)', 'quit'])
  })

  it('up to date: nothing is fetched', async () => {
    const { b, fetches } = setup({ info: null })
    expect(await b.check()).toBeNull()
    expect(fetches).toEqual([])
  })

  it('a check while the version downloads does not download it again', async () => {
    const { b, fetches } = setup()
    await b.check()
    await b.check()
    expect(fetches).toHaveLength(1)
  })

  it('a copy that cannot replace itself offers the version on its release page instead', async () => {
    const { b, fetches, seen } = setup({ bundle: '/private/var/folders/x1/T/AppTranslocation/0A1B/d/ClaudeTerm.app' })
    expect(await b.check()).toBe('0.6.0')
    expect(fetches).toEqual([])
    expect(seen).toEqual(['offered 0.6.0 ## 0.6.0\n\n- Mac.\n'])
  })

  it('a version the swap could not install last time, or a release without a zip for this Mac, is offered too', async () => {
    const failed = setup({ failedVersion: '0.6.0' })
    await failed.b.check()
    expect(failed.fetches).toEqual([])
    expect(failed.seen).toEqual(['offered 0.6.0 ## 0.6.0\n\n- Mac.\n'])
    const noZip = setup({ arch: 'x64', info: { version: '0.6.0', files: FILES.filter((f) => f.url.includes('arm64')) } })
    await noZip.b.check()
    expect(noZip.fetches).toEqual([])
    expect(noZip.seen).toEqual(['offered 0.6.0 '])
  })

  it('a failed download (network, checksum) is logged and the version offered; the next check tries again', async () => {
    const { b, out, fetches, seen, fail } = setup()
    await b.check()
    fail(new Error('the download does not match its checksum'))
    await flush()
    expect(out).toContain('warn:updater: cannot download 0.6.0: the download does not match its checksum')
    expect(seen).toEqual(['offered 0.6.0 ## 0.6.0\n\n- Mac.\n'])
    await b.check()
    expect(fetches).toHaveLength(2)
  })

  it('Restart before a download is ready does nothing', () => {
    const { b, out } = setup()
    b.quitAndInstall()
    expect(out).toEqual([])
  })
})
