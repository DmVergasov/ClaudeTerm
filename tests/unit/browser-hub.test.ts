import { EventEmitter } from 'node:events'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { BrowserHub, uniquePath, type BrowserHubDeps } from '../../src/main/browser/browser-hub'
import { BrowserProfilesStore } from '../../src/main/browser/profiles-store'
import { pathKey } from '../../src/main/path-key'
import type { BrowserMessage } from '../../src/shared/protocol'

/**
 * Electron's views, web contents and session, as far as the hub and its TabBrowsers use them. A capture waits in
 * `globalThis.__hubCaptures` until the test answers it.
 */
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const g = globalThis as unknown as {
    __hubCaptures: ((image: { toDataURL(): string }) => void)[]
    __hubViews: number
    __hubCleared: string[]
    __hubDownload: ((e: unknown, item: unknown, wc: unknown) => void) | null
  }
  g.__hubCaptures = []
  g.__hubViews = 0
  g.__hubCleared = []
  g.__hubDownload = null
  class FakeDebugger extends EventEmitter {
    isAttached(): boolean { return false }
    attach(): void { /* attached on demand */ }
    detach(): void { /* nothing to detach */ }
    sendCommand(): Promise<unknown> { return Promise.resolve({}) }
  }
  class FakeWebContents extends EventEmitter {
    destroyed = false
    focused = false
    url = ''
    isFocused(): boolean { return this.focused }
    debugger = new FakeDebugger()
    navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: () => undefined, goForward: () => undefined }
    getURL(): string { return this.url }
    getTitle(): string { return '' }
    isLoading(): boolean { return false }
    isDestroyed(): boolean { return this.destroyed }
    loadURL(url: string): Promise<void> {
      this.url = url
      return Promise.resolve()
    }
    setWindowOpenHandler(): void { /* popups are not used here */ }
    reload(): void { /* not used here */ }
    openDevTools(): void { /* not used here */ }
    close(): void {
      this.destroyed = true
      this.emit('destroyed')
    }
    capturePage(): Promise<{ toDataURL(): string }> {
      return new Promise((resolve) => g.__hubCaptures.push(resolve))
    }
  }
  class WebContentsView {
    webContents = new FakeWebContents()
    constructor() {
      g.__hubViews += 1
      // as Electron does, a view has no web contents once they are destroyed
      this.webContents.once('destroyed', () => {
        (this as unknown as { webContents: unknown }).webContents = undefined
      })
    }
    setBounds(): void { /* placement is the hub's */ }
  }
  class View {
    setBackgroundColor(): void { /* the cover's colour is not checked */ }
    setBounds(): void { /* placement is the hub's */ }
  }
  const session = {
    fromPartition: (partition: string) => ({
      setPermissionRequestHandler: () => undefined,
      setPermissionCheckHandler: () => undefined,
      // the tests run a download by calling the handler the hub set for will-download
      on: (event: string, fn: (e: unknown, item: unknown, wc: unknown) => void) => {
        if (event === 'will-download') g.__hubDownload = fn
      },
      // a profile's data is cleared: the partition's name is recorded
      clearStorageData: () => {
        g.__hubCleared.push(partition)
        return Promise.resolve()
      },
      clearCache: () => Promise.resolve()
    })
  }
  return { WebContentsView, View, session }
})

const URL_A = 'http://127.0.0.1:9/a'
const URL_B = 'http://127.0.0.1:9/b'
const STILL = 'data:image/png;base64,AAAA'

/** a window whose events the tests emit (the window's focus, say) */
function fakeWindow(): BrowserWindow {
  const children: unknown[] = []
  return Object.assign(new EventEmitter(), {
    contentView: {
      addChildView: (v: unknown) => children.push(v),
      removeChildView: () => undefined,
      children
    },
    getContentSize: () => [800, 600],
    isMinimized: () => false,
    isDestroyed: () => false
  }) as unknown as BrowserWindow
}

function hubDeps(win: BrowserWindow, sendStill: (tabId: string, dataUrl: string | null) => void): BrowserHubDeps {
  return {
    window: () => win,
    profiles: {
      view: () => ({ profiles: [{ id: 'default', name: 'Default' }] }),
      defaultId: () => 'default',
      allowed: () => [],
      allow: () => undefined
    } as unknown as BrowserHubDeps['profiles'],
    isLocalClaudeTab: () => true,
    forkParent: () => null,
    folderOf: () => null,
    signal: () => undefined,
    sendState: () => undefined,
    sendClosed: () => undefined,
    sendStill,
    openPanel: () => undefined,
    sessionChanged: () => undefined,
    downloadsDir: () => join(tmpdir(), 'ct-hub-downloads'),
    coverColor: () => '#000000',
    platform: 'win32',
    appKey: () => undefined,
    keyboardTo: () => undefined,
    profilesChanged: () => undefined,
    openSettings: () => undefined,
    log: { info: () => undefined, warn: () => undefined }
  }
}

function message(tabId: string, command: object): BrowserMessage {
  return { v: 1, type: 'browser', tabId, command } as unknown as BrowserMessage
}

/** lets the pending promises of the hub and its tabs run */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((done) => setTimeout(done, 0))
}

describe('BrowserHub cover', () => {
  it('a still taken for the cover goes out while the panel still shows its tab', async () => {
    const sendStill = vi.fn()
    const hub = new BrowserHub(hubDeps(fakeWindow(), sendStill))
    await hub.command(message('tab-still', { op: 'navigate', url: URL_A }), new AbortController().signal)
    hub.setBounds('tab-still', { x: 0, y: 0, width: 400, height: 300 })
    hub.setCovered(true)
    const captures = (globalThis as unknown as { __hubCaptures: ((image: { toDataURL(): string }) => void)[] }).__hubCaptures
    captures[captures.length - 1]({ toDataURL: () => STILL })
    await flush()
    expect(sendStill).toHaveBeenCalledWith('tab-still', STILL)
  })

  it('a still taken for the cover is dropped when the panel shows no tab by then', async () => {
    const sendStill = vi.fn()
    const hub = new BrowserHub(hubDeps(fakeWindow(), sendStill))
    await hub.command(message('tab-moved', { op: 'navigate', url: URL_A }), new AbortController().signal)
    hub.setBounds('tab-moved', { x: 0, y: 0, width: 400, height: 300 })
    hub.setCovered(true)
    hub.setBounds(null, null)
    const captures = (globalThis as unknown as { __hubCaptures: ((image: { toDataURL(): string }) => void)[] }).__hubCaptures
    captures[captures.length - 1]({ toDataURL: () => STILL })
    await flush()
    expect(sendStill).not.toHaveBeenCalledWith('tab-moved', STILL)
  })
})

/** the web contents of the page of this address, as the window holds it (the cover has none) */
type PageLike = { focused: boolean; getURL(): string }
function pageWith(win: BrowserWindow, url: string): PageLike {
  const children = win.contentView.children as unknown as { webContents?: PageLike }[]
  const page = children.find((v) => v.webContents?.getURL() === url)?.webContents
  if (!page) throw new Error(`no page shows ${url}`)
  return page
}

/** the still the hub's last capture answers with: the cover takes the page's place once it is in */
function answerCapture(): void {
  const captures = (globalThis as unknown as { __hubCaptures: ((image: { toDataURL(): string }) => void)[] }).__hubCaptures
  captures[captures.length - 1]({ toDataURL: () => STILL })
}

const RECT = { x: 0, y: 0, width: 400, height: 300 }
const SIGNAL = new AbortController().signal

describe('BrowserHub keyboard', () => {
  it('a covered page keeps the keyboard: a toast over the panel does not take it from a field', async () => {
    const keyboardTo = vi.fn()
    const win = fakeWindow()
    const hub = new BrowserHub({ ...hubDeps(win, vi.fn()), keyboardTo })
    await hub.command(message('tab-covered', { op: 'navigate', url: URL_A }), SIGNAL)
    hub.setBounds('tab-covered', RECT)
    pageWith(win, URL_A).focused = true
    // the cover takes the page's place: the page is parked, but only covered
    hub.setCovered(true)
    answerCapture()
    await flush()
    expect(keyboardTo).not.toHaveBeenCalled()
  })

  it("the same tab's page that the panel shows in its place gets the keyboard", async () => {
    const keyboardTo = vi.fn()
    const win = fakeWindow()
    const hub = new BrowserHub({ ...hubDeps(win, vi.fn()), keyboardTo })
    await hub.command(message('tab-two', { op: 'navigate', url: URL_A }), SIGNAL)
    hub.setBounds('tab-two', RECT)
    pageWith(win, URL_A).focused = true
    // a page Claude opens in the same tab becomes the shown one; the focused page is parked
    await hub.command(message('tab-two', { op: 'tabs', action: 'new', index: null, url: URL_B }), SIGNAL)
    await flush()
    const targets = keyboardTo.mock.calls.map((call) => call[0])
    expect(targets.length).toBeGreaterThan(0)
    expect(targets.every((target) => target === pageWith(win, URL_B))).toBe(true)
  })

  it('a focused page the panel hides gives the keyboard to the window', async () => {
    const keyboardTo = vi.fn()
    const win = fakeWindow()
    const hub = new BrowserHub({ ...hubDeps(win, vi.fn()), keyboardTo })
    await hub.command(message('tab-hidden', { op: 'navigate', url: URL_A }), SIGNAL)
    hub.setBounds('tab-hidden', RECT)
    pageWith(win, URL_A).focused = true
    // shown, the focused page keeps the keyboard
    expect(keyboardTo).not.toHaveBeenCalled()
    // the panel hides (a click on another toggle, say): the keyboard goes back to the window
    hub.setBounds(null, null)
    expect(keyboardTo).toHaveBeenCalledTimes(1)
    expect(keyboardTo).toHaveBeenCalledWith(null)
  })

  it("a focused page of a tab the panel no longer shows gives the keyboard to the window", async () => {
    const keyboardTo = vi.fn()
    const win = fakeWindow()
    const hub = new BrowserHub({ ...hubDeps(win, vi.fn()), keyboardTo })
    await hub.command(message('tab-one', { op: 'navigate', url: URL_A }), SIGNAL)
    await hub.command(message('tab-two', { op: 'navigate', url: URL_B }), SIGNAL)
    hub.setBounds('tab-one', RECT)
    pageWith(win, URL_A).focused = true
    // the panel shows another tab now: the page of tab-one is parked, and tab-two's page is not its tab's
    hub.setBounds('tab-two', RECT)
    expect(keyboardTo).toHaveBeenCalledTimes(1)
    expect(keyboardTo).toHaveBeenCalledWith(null)
  })

  it("a focused page closed in its tab gives the keyboard to the tab's page the panel shows next", async () => {
    const keyboardTo = vi.fn()
    const win = fakeWindow()
    const hub = new BrowserHub({ ...hubDeps(win, vi.fn()), keyboardTo })
    await hub.command(message('tab-close', { op: 'navigate', url: URL_A }), SIGNAL)
    hub.setBounds('tab-close', RECT)
    await hub.command(message('tab-close', { op: 'tabs', action: 'new', index: null, url: URL_B }), SIGNAL)
    await flush()
    pageWith(win, URL_B).focused = true
    keyboardTo.mockClear()
    // the page closed is the shown one: the page before it in the tab is shown now, and gets the keyboard
    await hub.command(message('tab-close', { op: 'tabs', action: 'close', index: 1, url: null }), SIGNAL)
    await flush()
    expect(keyboardTo).toHaveBeenLastCalledWith(pageWith(win, URL_A))
  })

  it('a parked page that does not have the keyboard leaves it alone', async () => {
    const keyboardTo = vi.fn()
    const win = fakeWindow()
    const hub = new BrowserHub({ ...hubDeps(win, vi.fn()), keyboardTo })
    await hub.command(message('tab-idle', { op: 'navigate', url: URL_A }), SIGNAL)
    hub.setBounds('tab-idle', RECT)
    hub.setBounds(null, null)
    expect(keyboardTo).not.toHaveBeenCalled()
  })

  it('the shown page keeps the keyboard through a layout while it is shown', async () => {
    const keyboardTo = vi.fn()
    const win = fakeWindow()
    const hub = new BrowserHub({ ...hubDeps(win, vi.fn()), keyboardTo })
    await hub.command(message('tab-shown', { op: 'navigate', url: URL_A }), SIGNAL)
    hub.setBounds('tab-shown', RECT)
    pageWith(win, URL_A).focused = true
    // another layout while the focused page is shown: it is placed again, and keeps the keyboard
    hub.setBounds('tab-shown', RECT)
    expect(keyboardTo).not.toHaveBeenCalled()
  })

  it('a window that gets the focus back hands a parked focused page its keyboard again', async () => {
    const keyboardTo = vi.fn()
    const win = fakeWindow()
    const hub = new BrowserHub({ ...hubDeps(win, vi.fn()), keyboardTo })
    await hub.command(message('tab-away', { op: 'navigate', url: URL_A }), SIGNAL)
    hub.setBounds('tab-away', RECT)
    pageWith(win, URL_A).focused = true
    // the page is parked while the person is in another app: the window does not have the focus, so the hand-over is not taken
    hub.setBounds(null, null)
    keyboardTo.mockClear()
    ;(win as unknown as EventEmitter).emit('focus')
    await flush()
    expect(keyboardTo).toHaveBeenCalledWith(null)
  })
})

describe('BrowserHub pages', () => {
  it('a page whose contents destroy themselves leaves the strip without an error, and the tab goes on', async () => {
    const win = fakeWindow()
    const hub = new BrowserHub(hubDeps(win, vi.fn()))
    await hub.command(message('tab-closes', { op: 'navigate', url: URL_A }), SIGNAL)
    const children = win.contentView.children as unknown as { webContents?: { getURL(): string; close(): void } }[]
    const page = children.find((v) => v.webContents?.getURL() === URL_A)!.webContents!
    // the page closes its own window: its contents are destroyed, and the view has none left
    expect(() => page.close()).not.toThrow()
    expect(await hub.command(message('tab-closes', { op: 'tabs', action: 'list' }), SIGNAL)).toEqual({ ok: true, info: 'No pages open.' })
  })

  it('a background page that closes while another page of its tab is shown does not move the keyboard', async () => {
    const win = fakeWindow()
    const keyboardTo = vi.fn()
    const hub = new BrowserHub({ ...hubDeps(win, vi.fn()), keyboardTo })
    await hub.command(message('tab-bg-kb', { op: 'navigate', url: URL_A }), SIGNAL)
    await hub.command(message('tab-bg-kb', { op: 'tabs', action: 'new', index: null, url: URL_B }), SIGNAL)
    hub.setBounds('tab-bg-kb', RECT)
    const children = win.contentView.children as unknown as { webContents?: { getURL(): string; close(): void } }[]
    const background = children.find((v) => v.webContents?.getURL() === URL_A)!.webContents!
    keyboardTo.mockClear()
    background.close()
    expect(keyboardTo).not.toHaveBeenCalled()
  })

  it('a covered shown page that closes itself hands the keyboard on to the window, though the cover hides it', async () => {
    const keyboardTo = vi.fn()
    const win = fakeWindow()
    const hub = new BrowserHub({ ...hubDeps(win, vi.fn()), keyboardTo })
    await hub.command(message('tab-covered-gone', { op: 'navigate', url: URL_A }), SIGNAL)
    hub.setBounds('tab-covered-gone', RECT)
    hub.setCovered(true)
    answerCapture()
    await flush()
    const children = win.contentView.children as unknown as { webContents?: { getURL(): string; close(): void } }[]
    const page = children.find((v) => v.webContents?.getURL() === URL_A)!.webContents!
    keyboardTo.mockClear()
    page.close()
    expect(keyboardTo).toHaveBeenCalledWith(null)
  })

  it('a shown page that destroys itself hands the keyboard on to the window, as its tab has no other page', async () => {
    const win = fakeWindow()
    const keyboardTo = vi.fn()
    const hub = new BrowserHub({ ...hubDeps(win, vi.fn()), keyboardTo })
    await hub.command(message('tab-kb-gone', { op: 'navigate', url: URL_A }), SIGNAL)
    hub.setBounds('tab-kb-gone', RECT)
    const children = win.contentView.children as unknown as { webContents?: { getURL(): string; close(): void } }[]
    const page = children.find((v) => v.webContents?.getURL() === URL_A)!.webContents!
    keyboardTo.mockClear()
    page.close()
    expect(keyboardTo).toHaveBeenCalledWith(null)
  })
})

describe('BrowserHub cards', () => {
  it('a new card opens the Browser panel for its tab', async () => {
    const openPanel = vi.fn()
    const hub = new BrowserHub({ ...hubDeps(fakeWindow(), vi.fn()), openPanel })
    const navigating = hub.command(message('tab-card', { op: 'navigate', url: 'http://site.test:9/a' }), SIGNAL)
    await flush()
    expect(openPanel).toHaveBeenCalledTimes(1)
    expect(openPanel).toHaveBeenCalledWith('tab-card')
    expect(hub.state('tab-card')?.card?.site).toBe('site.test')
    hub.action('tab-card', { type: 'answer', cardId: hub.state('tab-card')!.card!.id, answer: 'deny' })
    expect(await navigating).toMatchObject({ ok: false })
    // the card is gone: nothing opens the panel again
    expect(openPanel).toHaveBeenCalledTimes(1)
  })

  it('a card for another site, asked after the first is answered, opens the panel again', async () => {
    const openPanel = vi.fn()
    const hub = new BrowserHub({ ...hubDeps(fakeWindow(), vi.fn()), openPanel })
    const first = hub.command(message('tab-again', { op: 'navigate', url: 'http://site.test:9/a' }), SIGNAL)
    await flush()
    hub.action('tab-again', { type: 'answer', cardId: hub.state('tab-again')!.card!.id, answer: 'deny' })
    expect(await first).toMatchObject({ ok: false })
    expect(hub.state('tab-again')?.card).toBeNull()
    const second = hub.command(message('tab-again', { op: 'navigate', url: 'http://other.test:9/a' }), SIGNAL)
    await flush()
    expect(openPanel).toHaveBeenCalledTimes(2)
    hub.action('tab-again', { type: 'answer', cardId: hub.state('tab-again')!.card!.id, answer: 'deny' })
    expect(await second).toMatchObject({ ok: false })
  })
})

/** the web contents of the window's page on a URL, as the fake Electron has them: their events and their url */
function pageOf(win: BrowserWindow, url: string): { emit(event: string): void; url: string; getURL(): string } {
  const children = win.contentView.children as unknown as { webContents?: { getURL(): string } }[]
  return children.find((v) => v.webContents?.getURL() === url)!.webContents as unknown as { emit(event: string): void; url: string; getURL(): string }
}

describe('BrowserHub downloads and the session', () => {
  it('a download whose folder cannot be made is cancelled, and one line names the folder error, not the address', async () => {
    const win = fakeWindow()
    const warn = vi.fn()
    // a file where the downloads folder should be: the folder cannot be made
    const blocked = join(mkdtempSync(join(tmpdir(), 'ct-hub-blocked-')), 'downloads')
    writeFileSync(blocked, 'not a folder')
    const hub = new BrowserHub({ ...hubDeps(win, vi.fn()), downloadsDir: () => blocked, log: { info: () => undefined, warn } })
    await hub.command(message('tab-dl-fail', { op: 'navigate', url: URL_A }), SIGNAL)
    const download = (globalThis as unknown as { __hubDownload: (e: unknown, item: unknown, wc: unknown) => void }).__hubDownload
    const item = { getFilename: () => 'a.txt', cancel: vi.fn(), setSavePath: vi.fn(), once: vi.fn() }
    expect(() => download({}, item, pageOf(win, URL_A))).not.toThrow()
    expect(item.cancel).toHaveBeenCalledTimes(1)
    expect(item.setSavePath).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('downloads folder')
    expect(String(warn.mock.calls[0][0])).not.toContain(URL_A)
  })

  it('a title change of a page sends the state again, but saves the session only when what it keeps changed', async () => {
    const win = fakeWindow()
    const sessionChanged = vi.fn()
    const sendState = vi.fn()
    const hub = new BrowserHub({ ...hubDeps(win, vi.fn()), sessionChanged, sendState })
    await hub.command(message('tab-title', { op: 'navigate', url: URL_A }), SIGNAL)
    const page = pageOf(win, URL_A)
    sessionChanged.mockClear()
    sendState.mockClear()
    page.emit('page-title-updated')
    page.emit('page-title-updated')
    expect(sendState).toHaveBeenCalledTimes(2)
    expect(sessionChanged).not.toHaveBeenCalled()
  })

  it('a page that moves to another address in the page does save the session', async () => {
    const win = fakeWindow()
    const sessionChanged = vi.fn()
    const hub = new BrowserHub({ ...hubDeps(win, vi.fn()), sessionChanged })
    await hub.command(message('tab-move', { op: 'navigate', url: URL_A }), SIGNAL)
    const page = pageOf(win, URL_A)
    sessionChanged.mockClear()
    page.url = URL_B
    page.emit('did-navigate-in-page')
    expect(sessionChanged).toHaveBeenCalledTimes(1)
  })
})

describe('uniquePath', () => {
  it.runIf(process.platform === 'win32')('on Windows a name that differs only by case is taken by a running download', () => {
    const dir = join(tmpdir(), 'ct-hub-names-missing')
    const reserved = new Set([pathKey(join(dir, 'A.txt'))])
    expect(basename(uniquePath(dir, 'a.txt', reserved))).toBe('a (2).txt')
  })
})

function viewCount(): number {
  return (globalThis as unknown as { __hubViews: number }).__hubViews
}

function clearedPartitions(): string[] {
  return (globalThis as unknown as { __hubCleared: string[] }).__hubCleared
}

/** a real profiles store in a temp folder, with one profile named Work whose id is workwork */
function storeWithWork(): { store: BrowserProfilesStore; work: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ct-hub-profiles-'))
  const store = new BrowserProfilesStore(join(dir, 'browser-profiles.json'), { newId: () => 'workwork' })
  const work = store.add('Work')!
  return { store, work }
}

describe('BrowserHub profiles, restore and forks', () => {
  it('profileRemoved moves a tab on that profile to Default: its pages open there again, and the deleted data is cleared', async () => {
    const { store, work } = storeWithWork()
    const hub = new BrowserHub({ ...hubDeps(fakeWindow(), vi.fn()), profiles: store })
    hub.restore('tab-work', { profile: work, pages: [URL_A, URL_B], current: 1 })
    hub.setBounds('tab-work', RECT)
    await flush()
    expect(hub.state('tab-work')).toMatchObject({ profileId: work })
    store.remove(work)
    hub.profileRemoved(work)
    await flush()
    expect(hub.state('tab-work')).toMatchObject({ profileId: 'default', current: 1, pages: [{ url: URL_A }, { url: URL_B }] })
    expect(clearedPartitions()).toContain('persist:browser-workwork')
  })

  it('restore creates no page until the tab is first shown, then creates them all with the saved current page', () => {
    const { store } = storeWithWork()
    const hub = new BrowserHub({ ...hubDeps(fakeWindow(), vi.fn()), profiles: store })
    const before = viewCount()
    hub.restore('tab-lazy', { profile: 'default', pages: [URL_A, URL_B], current: 1 })
    expect(hub.state('tab-lazy')).toMatchObject({ current: 1, pages: [{ url: URL_A, title: '', loading: false }, { url: URL_B, title: '', loading: false }] })
    expect(viewCount() - before).toBe(0)
    hub.setBounds('tab-lazy', RECT)
    expect(viewCount() - before).toBe(2)
    expect(hub.state('tab-lazy')).toMatchObject({ current: 1, pages: [{ url: URL_A }, { url: URL_B }] })
  })

  it('the first command of a restored tab creates its pages, and the command sees them', async () => {
    const { store } = storeWithWork()
    const hub = new BrowserHub({ ...hubDeps(fakeWindow(), vi.fn()), profiles: store })
    const before = viewCount()
    hub.restore('tab-cmd', { profile: 'default', pages: [URL_A, URL_B], current: 0 })
    const reply = await hub.command(message('tab-cmd', { op: 'tabs', action: 'list' }), new AbortController().signal)
    expect(viewCount() - before).toBe(2)
    expect(reply).toMatchObject({ ok: true, info: expect.stringContaining(URL_B) })
  })

  it('a restored profile that no longer exists becomes Default', () => {
    const { store } = storeWithWork()
    const hub = new BrowserHub({ ...hubDeps(fakeWindow(), vi.fn()), profiles: store })
    hub.restore('tab-gone', { profile: 'gonegone', pages: [URL_A], current: 0 })
    expect(hub.state('tab-gone')).toMatchObject({ profileId: 'default' })
  })

  it('a fork starts with no pages, on its parent\'s profile', () => {
    const { store, work } = storeWithWork()
    const hub = new BrowserHub({ ...hubDeps(fakeWindow(), vi.fn()), profiles: store, forkParent: (id) => (id === 'tab-fork' ? 'tab-head' : null) })
    hub.restore('tab-head', { profile: work, pages: [], current: 0 })
    expect(hub.state('tab-fork')).toMatchObject({ profileId: work, pages: [] })
  })

  it('saved keeps a restored tab\'s pages before they are created; a tab with no page on the default profile saves nothing', () => {
    const { store, work } = storeWithWork()
    const hub = new BrowserHub({ ...hubDeps(fakeWindow(), vi.fn()), profiles: store })
    hub.restore('tab-saved', { profile: work, pages: [URL_A, URL_B], current: 1 })
    expect(hub.saved('tab-saved')).toEqual({ profile: work, pages: [URL_A, URL_B], current: 1 })
    hub.state('tab-empty')
    expect(hub.saved('tab-empty')).toBeNull()
    expect(hub.saved('tab-unknown')).toBeNull()
  })

  it('profilesChanged sends every tab its state again, with the new names, and saves the session', () => {
    const { store, work } = storeWithWork()
    const sendState = vi.fn()
    const sessionChanged = vi.fn()
    const hub = new BrowserHub({ ...hubDeps(fakeWindow(), vi.fn()), profiles: store, sendState, sessionChanged })
    hub.restore('tab-renamed', { profile: 'default', pages: [], current: 0 })
    store.rename('default', 'Main')
    hub.profilesChanged()
    expect(sendState).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab-renamed', profiles: [{ id: 'default', name: 'Main' }, { id: work, name: 'Work' }] }))
    expect(sessionChanged).toHaveBeenCalled()
  })

  it('an Always allow answer saves the site in the profile, and tells the windows the profiles changed', async () => {
    const { store } = storeWithWork()
    const profilesChanged = vi.fn()
    const hub = new BrowserHub({ ...hubDeps(fakeWindow(), vi.fn()), profiles: store, profilesChanged })
    const pending = hub.command(message('tab-always', { op: 'navigate', url: 'http://site.test:9/' }), new AbortController().signal)
    await flush()
    const card = hub.state('tab-always')?.card
    expect(card).not.toBeNull()
    hub.action('tab-always', { type: 'answer', cardId: card!.id, answer: 'always' })
    expect(await pending).toMatchObject({ ok: true })
    expect(store.allowed('default')).toEqual(['site.test'])
    expect(profilesChanged).toHaveBeenCalled()
  })

  it('a profile removed while its tab waits for a card: the card goes, the command stops, and the tab moves to Default', async () => {
    const { store, work } = storeWithWork()
    const hub = new BrowserHub({ ...hubDeps(fakeWindow(), vi.fn()), profiles: store })
    hub.restore('tab-card', { profile: work, pages: [URL_A], current: 0 })
    hub.setBounds('tab-card', RECT)
    await flush()
    const pending = hub.command(message('tab-card', { op: 'navigate', url: 'http://site.test:9/' }), new AbortController().signal)
    await flush()
    expect(hub.state('tab-card')?.card).not.toBeNull()
    store.remove(work)
    hub.profileRemoved(work)
    expect(await pending).toEqual({ ok: false, error: 'Stopped by the person.' })
    expect(hub.state('tab-card')).toMatchObject({ card: null, profileId: 'default' })
  })

  it('a restored tab moved to Default before its pages are made keeps them, and they open there', async () => {
    const { store, work } = storeWithWork()
    const hub = new BrowserHub({ ...hubDeps(fakeWindow(), vi.fn()), profiles: store })
    hub.restore('tab-pending', { profile: work, pages: [URL_A, URL_B], current: 1 })
    store.remove(work)
    hub.profileRemoved(work)
    expect(hub.state('tab-pending')).toMatchObject({ profileId: 'default', current: 1, pages: [{ url: URL_A }, { url: URL_B }] })
    const before = viewCount()
    hub.setBounds('tab-pending', RECT)
    expect(viewCount() - before).toBe(2)
    expect(hub.state('tab-pending')).toMatchObject({ profileId: 'default', current: 1, pages: [{ url: URL_A }, { url: URL_B }] })
  })

  it('restore saves the session, so the restored pages are kept without another change', () => {
    const { store, work } = storeWithWork()
    const sessionChanged = vi.fn()
    const hub = new BrowserHub({ ...hubDeps(fakeWindow(), vi.fn()), profiles: store, sessionChanged })
    hub.restore('tab-saves', { profile: work, pages: [URL_A], current: 0 })
    expect(sessionChanged).toHaveBeenCalled()
  })
})
