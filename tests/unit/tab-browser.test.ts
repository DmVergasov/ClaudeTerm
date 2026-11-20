import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadItem } from 'electron'
import type { BrowserCommand } from '../../src/shared/browser'
import type { PipeResponse } from '../../src/shared/protocol'
import { TabBrowser, type TabBrowserDeps } from '../../src/main/browser/tab-browser'
import { SiteGate } from '../../src/main/browser/site-gate'

/**
 * Electron's WebContentsView, WebContents and debugger, as far as a TabBrowser uses them. A page's load is whatever
 * `globalThis.__ctLoad` says it is; a destroyed page throws on every read, as Electron's does.
 */
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  type Load = (wc: unknown, url: string) => Promise<void>
  const g = globalThis as unknown as { __ctLoad: Load; __ctViews: { webContents: FakeWebContents }[]; __ctStalls: number; __ctHold: string | null; __ctRelease: () => void }
  g.__ctViews = []
  g.__ctStalls = 0
  g.__ctHold = null
  class FakeDebugger extends EventEmitter {
    attached = false
    calls: string[] = []
    isAttached(): boolean { return this.attached }
    attach(): void {
      this.calls.push('attach')
      this.attached = true
    }
    detach(): void {
      this.attached = false
      this.emit('detach')
    }
    sendCommand(method: string): Promise<unknown> {
      this.calls.push(method)
      // the command named by `__ctHold` answers when the test releases it (`__ctRelease`)
      if (g.__ctHold === method) return new Promise((resolve) => {
        g.__ctRelease = () => resolve({ nodes: [] })
      })
      // the next commands stall while `__ctStalls` says so: a page's debugger that does not answer
      if (g.__ctStalls > 0) {
        g.__ctStalls -= 1
        return new Promise(() => undefined)
      }
      return Promise.resolve({})
    }
  }
  class FakeWebContents extends EventEmitter {
    destroyed = false
    url = ''
    debugger = new FakeDebugger()
    navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack: () => undefined, goForward: () => undefined }
    private guard(): void {
      if (this.destroyed) throw new Error('Object has been destroyed')
    }
    loadURL(url: string): Promise<void> {
      this.guard()
      this.url = url
      return g.__ctLoad(this, url)
    }
    getURL(): string { this.guard(); return this.url }
    getTitle(): string { this.guard(); return '' }
    isLoading(): boolean { this.guard(); return false }
    isDestroyed(): boolean { return this.destroyed }
    close(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('destroyed')
    }
    openHandler: ((details: { url: string }) => unknown) | null = null
    setWindowOpenHandler(handler: (details: { url: string }) => unknown): void { this.openHandler = handler }
    reload(): void {
      // a reload loads the page again, as the test's load says; its end is announced as a finished load
      void g.__ctLoad(this, this.url).then(() => this.emit('did-finish-load'))
    }
    openDevTools(): void { /* not used here */ }
    capturePage(): Promise<never> { return Promise.reject(new Error('no capture in tests')) }
  }
  class WebContentsView {
    webContents = new FakeWebContents()
    constructor() {
      g.__ctViews.push(this)
      // as Electron does, a view has no web contents once they are destroyed
      this.webContents.once('destroyed', () => {
        (this as unknown as { webContents: unknown }).webContents = undefined
      })
    }
    setBounds(): void { /* placement is the hub's */ }
  }
  return { WebContentsView }
})

type Load = (wc: { emit(event: string, ...args: unknown[]): boolean }, url: string) => Promise<void>
const g = globalThis as unknown as { __ctLoad: Load; __ctViews: { webContents: FakeWebContents }[]; __ctStalls: number; __ctHold: string | null; __ctRelease: () => void }
interface FakeWebContents {
  destroyed: boolean
  url: string
  debugger: { calls: string[]; isAttached(): boolean; detach(): void; emit(event: string, ...args: unknown[]): boolean }
  close(): void
  emit(event: string, ...args: unknown[]): boolean
}

const URL_A = 'http://127.0.0.1:9/a'

function deps(): TabBrowserDeps {
  return {
    stage: { add: () => undefined, remove: () => undefined, layout: () => undefined, minimized: () => false },
    gate: new SiteGate({ allowedAlways: () => [], allowAlways: () => undefined, allowAll: () => false, showCard: () => undefined, signal: () => undefined, folderOf: () => null }),
    profiles: () => [{ id: 'default', name: 'Default' }],
    configureSession: () => undefined,
    changed: () => undefined,
    openPanel: () => undefined,
    platform: 'win32',
    appKey: () => undefined,
    manageProfiles: () => undefined,
    clearData: () => undefined,
    defaultProfile: () => 'default'
  }
}

/** a page that loads at once, as a finished load does */
const loadsAtOnce: Load = () => Promise.resolve()

function run(tab: TabBrowser, command: object): Promise<PipeResponse> {
  return tab.run(command as BrowserCommand, new AbortController().signal)
}

describe('TabBrowser with fake pages', () => {
  beforeEach(() => {
    g.__ctStalls = 0
    g.__ctHold = null
  })

  it('a navigation whose load is aborted (it became a download) ends at once, not at the time limit', async () => {
    g.__ctLoad = () => Promise.reject(new Error('ERR_ABORTED (-3)'))
    const tab = new TabBrowser('tab-download', 'default', deps())
    const reply = await run(tab, { op: 'navigate', url: URL_A })
    expect(reply).toMatchObject({ ok: true })
    expect(reply.ok && reply.info).toContain('- URL:')
  })

  it('a navigation whose main frame fails to load says so with the error text, and never names the address', async () => {
    g.__ctLoad = (wc, url) => {
      wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', url, true)
      return Promise.reject(new Error(`ERR_CONNECTION_REFUSED (-102) loading '${url}'`))
    }
    const tab = new TabBrowser('tab-refused', 'default', deps())
    const reply = await run(tab, { op: 'navigate', url: URL_A })
    expect(reply.ok && reply.info).toContain('Navigated, but the page did not load: ERR_CONNECTION_REFUSED.')
    expect(reply.ok && reply.info?.split('\n')[0]).not.toContain(URL_A)
  })

  it('a page destroyed by itself leaves the strip, and the tab goes on with its commands', async () => {
    g.__ctLoad = loadsAtOnce
    const tab = new TabBrowser('tab-closer', 'default', deps())
    expect(await run(tab, { op: 'navigate', url: URL_A })).toMatchObject({ ok: true })
    const page = g.__ctViews[g.__ctViews.length - 1].webContents
    page.close()
    const listed = await run(tab, { op: 'tabs', action: 'list', index: null, url: null })
    expect(listed).toEqual({ ok: true, info: 'No pages open.' })
    expect(await run(tab, { op: 'snapshot' })).toMatchObject({ ok: false, error: expect.stringContaining('There is no page') })
  })

  it('a command stopped while it waits for its page does not act once the page is ready', async () => {
    let release: () => void = () => undefined
    // the first load is pending until the test lets it finish, as a page's load does
    g.__ctLoad = (wc) => new Promise<void>((resolve) => {
      release = () => {
        wc.emit('did-finish-load')
        resolve()
      }
    })
    const tab = new TabBrowser('tab-stopped', 'default', deps())
    const first = new AbortController()
    const navigating = tab.run({ op: 'navigate', url: URL_A } as BrowserCommand, first.signal)
    await new Promise((done) => setTimeout(done, 10))
    first.abort()
    expect(await navigating).toEqual({ ok: false, error: 'Stopped by the person.' })
    const second = new AbortController()
    const pressing = tab.run({ op: 'press_key', key: 'Enter' } as BrowserCommand, second.signal)
    await new Promise((done) => setTimeout(done, 10))
    second.abort()
    expect(await pressing).toEqual({ ok: false, error: 'Stopped by the person.' })
    release()
    await new Promise((done) => setTimeout(done, 20))
    const page = g.__ctViews[g.__ctViews.length - 1].webContents
    expect(page.debugger.calls.filter((c) => c === "Input.dispatchKeyEvent")).toEqual([])
  })

  it('a download that started before a command does not hold the command: it is listed as running in the footer', async () => {
    g.__ctLoad = loadsAtOnce
    const tab = new TabBrowser('tab-running', 'default', deps())
    await run(tab, { op: 'navigate', url: URL_A })
    tab.trackDownload(new EventEmitter() as unknown as DownloadItem, 'old.txt')
    const listed = await Promise.race([
      run(tab, { op: 'tabs', action: 'list', index: null, url: null }),
      wait(500).then(() => 'held')
    ])
    expect(listed).not.toBe('held')
    expect(listed).toMatchObject({ ok: true, info: expect.stringContaining('- Downloading: old.txt') })
  })

  it('a download that starts during a command is waited for up to 20 s, shown as running, and reported by the next footer once done', async () => {
    g.__ctLoad = loadsAtOnce
    const tab = new TabBrowser('tab-cap', 'default', deps())
    await run(tab, { op: 'navigate', url: URL_A })
    let loaded = false
    let release: () => void = () => undefined
    g.__ctLoad = (wc) => new Promise<void>((resolve) => {
      loaded = true
      release = () => {
        wc.emit('did-navigate')
        wc.emit('did-finish-load')
        resolve()
      }
    })
    const item = new EventEmitter()
    vi.useFakeTimers()
    try {
      let reply: PipeResponse | undefined
      const navigating = run(tab, { op: 'navigate', url: URL_A }).then((r) => {
        reply = r
      })
      for (let i = 0; i < 100 && !loaded; i++) await vi.advanceTimersByTimeAsync(0)
      tab.trackDownload(item as unknown as DownloadItem, 'a.txt')
      release()
      await vi.advanceTimersByTimeAsync(19_000)
      expect(reply).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1_000)
      await navigating
      expect(reply).toMatchObject({ ok: true, info: expect.stringContaining('- Downloading: a.txt') })
      item.emit('done', {}, 'completed')
      const next = await run(tab, { op: 'tabs', action: 'list', index: null, url: null })
      expect(next).toMatchObject({ ok: true, info: expect.stringContaining('- Downloaded: a.txt') })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a navigation that becomes a download on an open page shows the download in its own reply', async () => {
    g.__ctLoad = loadsAtOnce
    const tab = new TabBrowser('tab-form-download', 'default', deps())
    await run(tab, { op: 'navigate', url: URL_A })
    const item = new EventEmitter()
    // the load ends with no page committed, as a download's does; the download starts a moment later
    g.__ctLoad = (wc) => {
      wc.emit('did-finish-load')
      setTimeout(() => {
        tab.trackDownload(item as unknown as DownloadItem, 'a.txt')
        item.emit('done', {}, 'completed')
      }, 300)
      return Promise.resolve()
    }
    const reply = await run(tab, { op: 'navigate', url: URL_A })
    expect(reply).toMatchObject({ ok: true, info: expect.stringContaining('- Downloaded: a.txt') })
  })

  it('a page destroyed while a command uses it answers that the page closed', async () => {
    g.__ctLoad = loadsAtOnce
    const tab = new TabBrowser('tab-mid-close', 'default', deps())
    await run(tab, { op: 'navigate', url: URL_A })
    const page = g.__ctViews[g.__ctViews.length - 1].webContents
    let loaded = false
    g.__ctLoad = () => new Promise<void>(() => {
      loaded = true
    })
    const navigating = run(tab, { op: 'navigate', url: URL_A })
    while (!loaded) await wait(1)
    page.close()
    expect(await navigating).toEqual({ ok: false, error: 'The page closed.' })
  })

  it('a page has one attach in flight: the command after a stopped one waits for it and starts no second attach', async () => {
    vi.useFakeTimers()
    try {
      g.__ctLoad = loadsAtOnce
      const tab = new TabBrowser('tab-attach', 'default', deps())
      await tab.run({ op: 'navigate', url: URL_A } as BrowserCommand, new AbortController().signal)
      const page = g.__ctViews[g.__ctViews.length - 1].webContents
      // the driver is dropped, as a detach drops it: the next command attaches again, and that attach stalls
      page.debugger.detach()
      g.__ctStalls = 1
      const first = new AbortController()
      const stopped = tab.run({ op: 'console' } as BrowserCommand, first.signal)
      await vi.advanceTimersByTimeAsync(10)
      first.abort()
      expect(await stopped).toEqual({ ok: false, error: 'Stopped by the person.' })
      const second = tab.run({ op: 'console' } as BrowserCommand, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(10)
      expect(page.debugger.calls.filter((c) => c === 'attach')).toHaveLength(2)
      expect(page.debugger.calls.filter((c) => c === 'Page.enable')).toHaveLength(2)
      // the stalled attach gives up at its limit; the waiting command answers with that
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await second).toMatchObject({ ok: false, error: expect.stringContaining('did not answer') })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a debugger that stalls on enable is given up after 15 s and detached, and the next command attaches again', async () => {
    vi.useFakeTimers()
    try {
      g.__ctLoad = loadsAtOnce
      g.__ctStalls = 1
      const tab = new TabBrowser('tab-enable-stall', 'default', deps())
      const navigating = tab.run({ op: 'navigate', url: URL_A } as BrowserCommand, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await navigating).toMatchObject({ ok: true })
      const page = g.__ctViews[g.__ctViews.length - 1].webContents
      expect(page.debugger.isAttached()).toBe(false)
      const next = tab.run({ op: 'console' } as BrowserCommand, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(10)
      expect(await next).toMatchObject({ ok: true, info: expect.stringContaining('No console messages.') })
      expect(page.debugger.isAttached()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a tab disposed while its command waits leaves no timer running', async () => {
    vi.useFakeTimers()
    try {
      let release: () => void = () => undefined
      let loaded = false
      g.__ctLoad = (wc) => new Promise<void>((resolve) => {
        loaded = true
        release = () => {
          wc.emit('did-finish-load')
          resolve()
        }
      })
      const tab = new TabBrowser('tab-disposed', 'default', deps())
      const navigating = tab.run({ op: 'navigate', url: URL_A } as BrowserCommand, new AbortController().signal)
      for (let i = 0; i < 100 && !loaded; i++) await vi.advanceTimersByTimeAsync(0)
      tab.dispose()
      expect(await navigating).toEqual({ ok: false, error: 'Stopped by the person.' })
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a navigation on an open page stopped while the page is still loading does not load the new address', async () => {
    let release: () => void = () => undefined
    let loadingFirst = false
    g.__ctLoad = (wc) => new Promise<void>((resolve) => {
      loadingFirst = true
      release = () => {
        wc.emit('did-finish-load')
        resolve()
      }
    })
    const tab = new TabBrowser('tab-pending-nav', 'default', deps())
    const first = new AbortController()
    const opening = tab.run({ op: 'navigate', url: URL_A } as BrowserCommand, first.signal)
    while (!loadingFirst) await wait(1)
    first.abort()
    expect(await opening).toEqual({ ok: false, error: 'Stopped by the person.' })
    const second = new AbortController()
    const navigating = tab.run({ op: 'navigate', url: 'http://127.0.0.1:9/b' } as BrowserCommand, second.signal)
    await wait(10)
    second.abort()
    expect(await navigating).toEqual({ ok: false, error: 'Stopped by the person.' })
    release()
    await wait(20)
    const page = g.__ctViews[g.__ctViews.length - 1].webContents
    expect(page.url).toBe(URL_A)
  })

  it('a committed navigation on an open page does not wait for a download to start', async () => {
    g.__ctLoad = loadsAtOnce
    const tab = new TabBrowser('tab-committed', 'default', deps())
    await run(tab, { op: 'navigate', url: URL_A })
    g.__ctLoad = (wc) => {
      wc.emit('did-navigate')
      wc.emit('did-finish-load')
      return Promise.resolve()
    }
    vi.useFakeTimers()
    try {
      let reply: PipeResponse | undefined
      const navigating = run(tab, { op: 'navigate', url: URL_A }).then((r) => {
        reply = r
      })
      // the clock stays at zero: the reply resolves without the 1 s download-start wait
      for (let i = 0; i < 100 && reply === undefined; i++) await vi.advanceTimersByTimeAsync(0)
      expect(reply).toMatchObject({ ok: true })
      await navigating
    } finally {
      vi.useRealTimers()
    }
  })

  it('a navigation whose load ends uncommitted, with no error, still waits for a download to start (control)', async () => {
    g.__ctLoad = loadsAtOnce
    const tab = new TabBrowser('tab-uncommitted', 'default', deps())
    await run(tab, { op: 'navigate', url: URL_A })
    g.__ctLoad = (wc) => {
      wc.emit('did-finish-load')
      return Promise.resolve()
    }
    vi.useFakeTimers()
    try {
      let reply: PipeResponse | undefined
      const navigating = run(tab, { op: 'navigate', url: URL_A }).then((r) => {
        reply = r
      })
      for (let i = 0; i < 100; i++) await vi.advanceTimersByTimeAsync(0)
      expect(reply).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1_000)
      await navigating
      expect(reply).toMatchObject({ ok: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a navigation whose main frame failed answers without waiting for a download to start', async () => {
    g.__ctLoad = loadsAtOnce
    const tab = new TabBrowser('tab-failed', 'default', deps())
    await run(tab, { op: 'navigate', url: URL_A })
    g.__ctLoad = (wc, url) => {
      wc.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', url, true)
      return Promise.reject(new Error('ERR_CONNECTION_REFUSED (-102)'))
    }
    vi.useFakeTimers()
    try {
      let reply: PipeResponse | undefined
      const navigating = run(tab, { op: 'navigate', url: URL_A }).then((r) => {
        reply = r
      })
      // the clock stays at zero: the failed load answers without the 1 s download-start wait
      for (let i = 0; i < 100 && reply === undefined; i++) await vi.advanceTimersByTimeAsync(0)
      expect(reply && reply.ok && reply.info).toContain('Navigated, but the page did not load: ERR_CONNECTION_REFUSED.')
      await navigating
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose clears the wait for a download to start, so no timer outlives the tab', async () => {
    g.__ctLoad = loadsAtOnce
    const tab = new TabBrowser('tab-wait-dispose', 'default', deps())
    await run(tab, { op: 'navigate', url: URL_A })
    g.__ctLoad = (wc) => {
      wc.emit('did-finish-load')
      return Promise.resolve()
    }
    vi.useFakeTimers()
    try {
      const navigating = tab.run({ op: 'navigate', url: URL_A } as BrowserCommand, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(10)
      tab.dispose()
      expect(await navigating).toEqual({ ok: false, error: 'Stopped by the person.' })
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a stopped snapshot that finishes late does not take the console error the next footer should show', async () => {
    g.__ctLoad = loadsAtOnce
    const tab = new TabBrowser('tab-stale', 'default', deps())
    await run(tab, { op: 'navigate', url: URL_A })
    const page = g.__ctViews[g.__ctViews.length - 1].webContents
    // the snapshot's accessibility read answers only when the test releases it
    g.__ctHold = 'Accessibility.getFullAXTree'
    const snapping = new AbortController()
    const stopped = tab.run({ op: 'snapshot' } as BrowserCommand, snapping.signal)
    await wait(10)
    snapping.abort()
    expect(await stopped).toEqual({ ok: false, error: 'Stopped by the person.' })
    page.debugger.emit('message', {}, 'Runtime.exceptionThrown', { exceptionDetails: { text: 'boom' } })
    g.__ctRelease()
    await wait(10)
    const listed = await run(tab, { op: 'tabs', action: 'list', index: null, url: null })
    expect(listed.ok && listed.info).toContain('- New console errors (1):')
    expect(listed.ok && listed.info).toContain('boom')
  })
})

/** a site no local page covers: a navigation to it needs the person's card */
const SITE_A = 'http://site.test:9/a'
const OTHER = 'http://other.test:9/page'
/** a local page whose load is redirected to OTHER when the test asks for it */
const REDIRECTING = 'http://127.0.0.1:9/away'

/** a gate whose cards the test sees: the sites of the cards shown, in order */
function cardGate(answerMs?: number): { gate: SiteGate; shown: string[] } {
  const shown: string[] = []
  const gate = new SiteGate({
    allowedAlways: () => [],
    allowAlways: () => undefined,
    allowAll: () => false,
    showCard: (_tabId, card) => {
      if (card !== null) shown.push(card.site)
    },
    signal: () => undefined,
    folderOf: () => null,
    answerMs
  })
  return { gate, shown }
}

/** announces a main-frame redirect of a page to `url` as Electron does; true when a listener prevented it */
function redirect(wc: { emit(event: string, ...args: unknown[]): boolean }, url: string): boolean {
  let prevented = false
  wc.emit('will-redirect', { url, isMainFrame: true, isSameDocument: false, preventDefault: () => { prevented = true } })
  return prevented
}

describe('TabBrowser time limit and cards', () => {
  beforeEach(() => {
    g.__ctStalls = 0
    g.__ctHold = null
  })

  it('the time limit does not run while a card waits: a navigation allowed after 90 s is not too slow', async () => {
    vi.useFakeTimers()
    try {
      g.__ctLoad = loadsAtOnce
      const { gate } = cardGate()
      const tab = new TabBrowser('tab-card-wait', 'default', { ...deps(), gate })
      const navigating = tab.run({ op: 'navigate', url: SITE_A } as BrowserCommand, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(90_000)
      const card = gate.card('tab-card-wait')
      expect(card?.site).toBe('site.test')
      gate.answer('tab-card-wait', card!.id, 'tab')
      expect(await navigating).toMatchObject({ ok: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a card the person does not answer in time ends with the did-not-answer message, not with the time limit', async () => {
    vi.useFakeTimers()
    try {
      g.__ctLoad = loadsAtOnce
      const { gate } = cardGate(120_000)
      const tab = new TabBrowser('tab-card-timeout', 'default', { ...deps(), gate })
      const navigating = tab.run({ op: 'navigate', url: SITE_A } as BrowserCommand, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(await navigating).toEqual({
        ok: false,
        error: 'The person did not answer about site.test. Let them know you are waiting for the Browser panel in ClaudeTerm.'
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('TabBrowser held navigations', () => {
  beforeEach(() => {
    g.__ctStalls = 0
    g.__ctHold = null
  })

  /** a page whose load to REDIRECTING is redirected to OTHER, as a server's redirect does; the other loads finish at once */
  function redirectingLoads(): void {
    g.__ctLoad = (wc, url) => {
      if (url === REDIRECTING) {
        if (redirect(wc, OTHER)) wc.emit('did-stop-loading')
        else {
          wc.emit('did-navigate')
          wc.emit('did-finish-load')
        }
      } else {
        wc.emit('did-finish-load')
      }
      return Promise.resolve()
    }
  }

  it('a redirect to a site the person did not allow, during a command, raises one card, and a denial answers the command', async () => {
    const { gate, shown } = cardGate()
    const tab = new TabBrowser('tab-held-deny', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    expect(await run(tab, { op: 'navigate', url: URL_A })).toMatchObject({ ok: true })
    redirectingLoads()
    const navigating = run(tab, { op: 'navigate', url: REDIRECTING })
    await wait(20)
    expect(shown).toEqual(['other.test'])
    gate.answer('tab-held-deny', gate.card('tab-held-deny')!.id, 'deny')
    expect(await navigating).toEqual({ ok: false, error: 'The person did not allow other.test.' })
    expect(shown).toEqual(['other.test'])
  })

  it('an allowed redirect is loaded, the command answers ok, and the redirect chain raises no second card', async () => {
    const { gate, shown } = cardGate()
    const tab = new TabBrowser('tab-held-allow', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    redirectingLoads()
    const navigating = run(tab, { op: 'navigate', url: REDIRECTING })
    await wait(20)
    gate.answer('tab-held-allow', gate.card('tab-held-allow')!.id, 'tab')
    expect(await navigating).toMatchObject({ ok: true })
    expect(g.__ctViews[g.__ctViews.length - 1].webContents.url).toBe(OTHER)
    expect(shown).toEqual(['other.test'])
  })

  it('Stop answers a command that waits for a held navigation and drops its card', async () => {
    const { gate } = cardGate()
    const tab = new TabBrowser('tab-held-stop', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    redirectingLoads()
    const navigating = run(tab, { op: 'navigate', url: REDIRECTING })
    await wait(20)
    tab.personAction({ type: 'stop' })
    expect(await navigating).toEqual({ ok: false, error: 'Stopped by the person.' })
    expect(gate.card('tab-held-stop')).toBeNull()
  })

  it('a redirect held after a command ends makes the tab next command wait for its card', async () => {
    const { gate, shown } = cardGate()
    const tab = new TabBrowser('tab-held-after', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    const page = g.__ctViews[g.__ctViews.length - 1].webContents
    expect(redirect(page, OTHER)).toBe(true)
    const next = run(tab, { op: 'tabs', action: 'list', index: null, url: null })
    const early = await Promise.race([next.then(() => 'answered'), wait(100).then(() => 'waiting')])
    expect(early).toBe('waiting')
    expect(shown).toEqual(['other.test'])
    gate.answer('tab-held-after', gate.card('tab-held-after')!.id, 'deny')
    expect(await next).toMatchObject({ ok: true })
  })
})

const URL_B = 'http://127.0.0.1:9/b'
const THIRD = 'http://third.test:9/page'
const OTHER2 = 'http://other.test:9/redirect'
const POPUP = 'http://popup.test:9/a'

/** the last page of the fake browser: its web contents, with the window-open handler the test can call */
function lastPage(): FakeWebContents & { openHandler: ((details: { url: string }) => unknown) | null } {
  return g.__ctViews[g.__ctViews.length - 1].webContents as unknown as FakeWebContents & { openHandler: ((details: { url: string }) => unknown) | null }
}

describe('TabBrowser fix round 1: the person, holds, limits and Stop', () => {
  beforeEach(() => {
    g.__ctStalls = 0
    g.__ctHold = null
  })

  it("a person's reload whose redirect leaves the site is not held while a command runs", async () => {
    const { gate, shown } = cardGate()
    const tab = new TabBrowser('tab-person-reload', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    // Claude's own load stays pending until the test lets it finish: the command runs meanwhile
    const prevented: boolean[] = []
    let finishClaude: () => void = () => undefined
    g.__ctLoad = (wc, url) => {
      if (url === URL_A) return new Promise<void>((resolve) => {
        finishClaude = () => {
          wc.emit('did-finish-load')
          resolve()
        }
      })
      prevented.push(redirect(wc, OTHER))
      if (prevented[prevented.length - 1]) wc.emit('did-stop-loading')
      else wc.emit('did-finish-load')
      return Promise.resolve()
    }
    const command = run(tab, { op: 'navigate', url: URL_A })
    await wait(20)
    lastPage().url = REDIRECTING
    tab.personAction({ type: 'reload' })
    await wait(20)
    expect(prevented).toEqual([false])
    expect(shown).toEqual([])
    finishClaude()
    await command
  })

  it('a page redirect is not held by another page card once the window has passed (only Claude holds)', async () => {
    const { gate, shown } = cardGate()
    const tab = new TabBrowser('tab-only-claude', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    expect(redirect(lastPage(), OTHER)).toBe(true)
    vi.useFakeTimers()
    try {
      await vi.advanceTimersByTimeAsync(3_500)
      tab.personAction({ type: 'newPage' })
      await vi.advanceTimersByTimeAsync(10)
      expect(redirect(lastPage(), THIRD)).toBe(false)
      expect(shown).toEqual(['other.test'])
      gate.answer('tab-only-claude', gate.card('tab-only-claude')!.id, 'deny')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a held navigation allowed more than three seconds after the command: its load redirect to a site not allowed is still held', async () => {
    const { gate, shown } = cardGate()
    const tab = new TabBrowser('tab-late-load', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    expect(redirect(lastPage(), OTHER)).toBe(true)
    vi.useFakeTimers()
    try {
      await vi.advanceTimersByTimeAsync(3_500)
      const held: boolean[] = []
      g.__ctLoad = (wc, url) => {
        if (url === OTHER) held.push(redirect(wc, THIRD))
        wc.emit('did-finish-load')
        return Promise.resolve()
      }
      gate.answer('tab-late-load', gate.card('tab-late-load')!.id, 'tab')
      await vi.advanceTimersByTimeAsync(10)
      expect(held).toEqual([true])
      expect(shown).toEqual(['other.test', 'third.test'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('two held navigations of one page are loaded once on Allow: the newer address, with one card', async () => {
    const { gate, shown } = cardGate()
    const tab = new TabBrowser('tab-one-hold', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    const loads: string[] = []
    g.__ctLoad = (wc, url) => {
      loads.push(url)
      wc.emit('did-finish-load')
      return Promise.resolve()
    }
    redirect(lastPage(), OTHER)
    redirect(lastPage(), OTHER2)
    await wait(20)
    expect(shown).toEqual(['other.test'])
    gate.answer('tab-one-hold', gate.card('tab-one-hold')!.id, 'tab')
    await wait(20)
    expect(loads).toEqual([OTHER2])
  })

  it('a re-navigation to a site denied in the same command raises no second card, and the command answers the denial', async () => {
    const { gate, shown } = cardGate()
    const tab = new TabBrowser('tab-denied-again', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    let release: () => void = () => undefined
    g.__ctLoad = (wc, url) => new Promise<void>((resolve) => {
      if (url !== URL_B) {
        wc.emit('did-finish-load')
        resolve()
        return
      }
      redirect(wc, OTHER)
      release = () => {
        wc.emit('did-stop-loading')
        resolve()
      }
    })
    const navigating = run(tab, { op: 'navigate', url: URL_B })
    await wait(20)
    gate.answer('tab-denied-again', gate.card('tab-denied-again')!.id, 'deny')
    await wait(20)
    expect(redirect(lastPage(), OTHER)).toBe(true)
    await wait(20)
    expect(shown).toEqual(['other.test'])
    release()
    expect(await navigating).toEqual({ ok: false, error: 'The person did not allow other.test.' })
  })

  it('after Stop, a page navigation within three seconds is not held, and the next command runs at once', async () => {
    const { gate } = cardGate()
    const tab = new TabBrowser('tab-stop-window', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    expect(redirect(lastPage(), OTHER)).toBe(true)
    tab.personAction({ type: 'stop' })
    tab.personAction({ type: 'handBack' })
    expect(gate.card('tab-stop-window')).toBeNull()
    expect(redirect(lastPage(), THIRD)).toBe(false)
    const next = await Promise.race([run(tab, { op: 'tabs', action: 'list', index: null, url: null }), wait(300).then(() => 'waiting')])
    expect(next).not.toBe('waiting')
  })

  it('a snapshot whose debugger never answers gives up at 30 s, not before', async () => {
    g.__ctLoad = loadsAtOnce
    const tab = new TabBrowser('tab-snap-limit', 'default', deps())
    await run(tab, { op: 'navigate', url: URL_A })
    vi.useFakeTimers()
    try {
      g.__ctHold = 'Accessibility.getFullAXTree'
      let answered: PipeResponse | undefined
      const snapping = tab.run({ op: 'snapshot' } as BrowserCommand, new AbortController().signal).then((r) => {
        answered = r
      })
      await vi.advanceTimersByTimeAsync(29_900)
      expect(answered).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)
      expect(answered).toEqual({ ok: false, error: 'Snapshot took too long.' })
      await snapping
    } finally {
      vi.useRealTimers()
    }
  })

  it('a navigate allowed by its card at 90 s whose load never ends gives up 60 s after the card', async () => {
    g.__ctLoad = loadsAtOnce
    const { gate } = cardGate()
    const tab = new TabBrowser('tab-nav-after-card', 'default', { ...deps(), gate })
    vi.useFakeTimers()
    try {
      let answered: PipeResponse | undefined
      const navigating = tab.run({ op: 'navigate', url: SITE_A } as BrowserCommand, new AbortController().signal).then((r) => {
        answered = r
      })
      await vi.advanceTimersByTimeAsync(90_000)
      g.__ctLoad = () => new Promise<void>(() => undefined)
      gate.answer('tab-nav-after-card', gate.card('tab-nav-after-card')!.id, 'tab')
      await vi.advanceTimersByTimeAsync(59_900)
      expect(answered).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)
      expect(answered).toEqual({ ok: false, error: 'Navigate took too long.' })
      await navigating
    } finally {
      vi.useRealTimers()
    }
  })

  it('a page command whose use card is answered at 50 s, then stalls, gives up 30 s after the card', async () => {
    const { gate } = cardGate()
    const tab = new TabBrowser('tab-use-after-card', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    // the page is on another site now: its commands ask the person first
    lastPage().url = SITE_A
    vi.useFakeTimers()
    try {
      let answered: PipeResponse | undefined
      const snapping = tab.run({ op: 'snapshot' } as BrowserCommand, new AbortController().signal).then((r) => {
        answered = r
      })
      await vi.advanceTimersByTimeAsync(50_000)
      const card = gate.card('tab-use-after-card')!
      expect(card.kind).toBe('use')
      g.__ctHold = 'Accessibility.getFullAXTree'
      gate.answer('tab-use-after-card', card.id, 'tab')
      await vi.advanceTimersByTimeAsync(29_900)
      expect(answered).toBeUndefined()
      await vi.advanceTimersByTimeAsync(200)
      expect(answered).toEqual({ ok: false, error: 'Snapshot took too long.' })
      await snapping
    } finally {
      vi.useRealTimers()
    }
  })

  it('Stop drops the cards before a queued card is shown: the queued site is never announced', async () => {
    const { gate, shown } = cardGate()
    const tab = new TabBrowser('tab-stop-order', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    let release: () => void = () => undefined
    g.__ctLoad = (wc, url) => new Promise<void>((resolve) => {
      if (url !== URL_B) {
        wc.emit('did-finish-load')
        resolve()
        return
      }
      redirect(wc, OTHER)
      release = () => {
        wc.emit('did-stop-loading')
        resolve()
      }
    })
    const navigating = run(tab, { op: 'navigate', url: URL_B })
    await wait(20)
    // a second page's held navigation queues behind the command's card
    tab.personAction({ type: 'newPage' })
    await wait(20)
    expect(redirect(lastPage(), THIRD)).toBe(true)
    await wait(20)
    expect(shown).toEqual(['other.test'])
    tab.personAction({ type: 'stop' })
    await wait(20)
    expect(shown).toEqual(['other.test'])
    expect(gate.card('tab-stop-order')).toBeNull()
    release()
    expect(await navigating).toEqual({ ok: false, error: 'Stopped by the person.' })
  })

  it('a popup inside the window raises a card; Stop drops it, and the popup is not added', async () => {
    const { gate, shown } = cardGate()
    const tab = new TabBrowser('tab-popup-stop', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    lastPage().openHandler!({ url: POPUP })
    await wait(20)
    expect(shown).toEqual(['popup.test'])
    tab.personAction({ type: 'stop' })
    await wait(20)
    expect(gate.card('tab-popup-stop')).toBeNull()
    expect(tab.saved()?.pages).toEqual([URL_A])
  })

  it('a closed pipe drops a popup card that a running command opened', async () => {
    const { gate } = cardGate()
    const tab = new TabBrowser('tab-popup-pipe', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    let finish: () => void = () => undefined
    g.__ctLoad = (wc) => new Promise<void>((resolve) => {
      finish = () => {
        wc.emit('did-finish-load')
        resolve()
      }
    })
    const pipe = new AbortController()
    const navigating = tab.run({ op: 'navigate', url: URL_A } as BrowserCommand, pipe.signal)
    await wait(20)
    lastPage().openHandler!({ url: POPUP })
    await wait(20)
    expect(gate.card('tab-popup-pipe')?.site).toBe('popup.test')
    pipe.abort()
    await wait(20)
    expect(gate.card('tab-popup-pipe')).toBeNull()
    finish()
    await navigating
  })

  it('a closed pipe aborts a held navigation of the running command, and its card goes', async () => {
    const { gate } = cardGate()
    const tab = new TabBrowser('tab-held-pipe', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    g.__ctLoad = (wc, url) => {
      if (url === URL_B) {
        redirect(wc, OTHER)
        wc.emit('did-stop-loading')
      } else {
        wc.emit('did-finish-load')
      }
      return Promise.resolve()
    }
    const pipe = new AbortController()
    const navigating = tab.run({ op: 'navigate', url: URL_B } as BrowserCommand, pipe.signal)
    await wait(20)
    expect(gate.card('tab-held-pipe')?.site).toBe('other.test')
    pipe.abort()
    await wait(20)
    expect(gate.card('tab-held-pipe')).toBeNull()
    expect(await navigating).toEqual({ ok: false, error: 'Stopped by the person.' })
  })

  it('closing a page while its held navigation waits removes the card, and the command answers that the page closed', async () => {
    const { gate } = cardGate()
    const tab = new TabBrowser('tab-close-hold', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    const page = lastPage()
    g.__ctLoad = (wc, url) => {
      if (url === URL_B) {
        redirect(wc, OTHER)
        wc.emit('did-stop-loading')
      } else {
        wc.emit('did-finish-load')
      }
      return Promise.resolve()
    }
    const navigating = tab.run({ op: 'navigate', url: URL_B } as BrowserCommand, new AbortController().signal)
    await wait(20)
    expect(gate.card('tab-close-hold')?.site).toBe('other.test')
    page.close()
    await wait(20)
    expect(gate.card('tab-close-hold')).toBeNull()
    expect(await Promise.race([navigating, wait(3_000).then(() => 'still waiting')])).toEqual({ ok: false, error: 'The page closed.' })
  })

  it('a navigation held by a card does not wait a second for a download to start', async () => {
    const { gate } = cardGate()
    const tab = new TabBrowser('tab-no-download-wait', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    g.__ctLoad = (wc, url) => {
      if (url === URL_B) {
        redirect(wc, OTHER)
        wc.emit('did-stop-loading')
      } else {
        wc.emit('did-finish-load')
      }
      return Promise.resolve()
    }
    vi.useFakeTimers()
    try {
      let reply: PipeResponse | undefined
      const navigating = tab.run({ op: 'navigate', url: URL_B } as BrowserCommand, new AbortController().signal).then((r) => {
        reply = r
      })
      for (let i = 0; i < 20 && gate.card('tab-no-download-wait') === null; i++) await vi.advanceTimersByTimeAsync(0)
      gate.answer('tab-no-download-wait', gate.card('tab-no-download-wait')!.id, 'tab')
      for (let i = 0; i < 20 && reply === undefined; i++) await vi.advanceTimersByTimeAsync(0)
      expect(reply).toMatchObject({ ok: true })
      await navigating
    } finally {
      vi.useRealTimers()
    }
  })

  it('a will-redirect to a non-web address is refused while the tab holds', async () => {
    const { gate, shown } = cardGate()
    const tab = new TabBrowser('tab-non-web', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    expect(redirect(lastPage(), 'ftp://other.test/file')).toBe(true)
    expect(shown).toEqual([])
  })
})

describe('TabBrowser fix round 2: the panel hears a command start', () => {
  it('the state sent when a command starts says claude, so the Stop button shows while the command waits for a card', async () => {
    const { gate } = cardGate()
    const controls: string[] = []
    const tab = new TabBrowser('tab-push-start', 'default', { ...deps(), gate, changed: () => controls.push(tab.state().control) })
    g.__ctLoad = loadsAtOnce
    const navigating = run(tab, { op: 'navigate', url: OTHER })
    await wait(20)
    expect(controls).toContain('claude')
    gate.answer('tab-push-start', gate.card('tab-push-start')!.id, 'deny')
    expect(await navigating).toMatchObject({ ok: false })
  })

  it('a command whose page requested a navigation waits for it: the hold it makes is the answer, though the request came before the action answered', async () => {
    const { gate, shown } = cardGate()
    const tab = new TabBrowser('tab-request-wait', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    const wc = lastPage()
    wc.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main-frame' } })
    // the snapshot's action waits for the debugger; the page asks for a form's submission while it waits
    g.__ctHold = 'Accessibility.getFullAXTree'
    const snapping = run(tab, { op: 'snapshot' })
    await wait(10)
    wc.debugger.emit('message', {}, 'Page.frameRequestedNavigation', { frameId: 'main-frame', reason: 'formSubmissionPost', url: OTHER })
    let answered = false
    void snapping.then(() => { answered = true })
    g.__ctRelease()
    g.__ctHold = null
    // the navigation reaches main only after the action has answered
    setTimeout(() => {
      let prevented = false
      wc.emit('will-navigate', { url: OTHER, isMainFrame: true, isSameDocument: false, preventDefault: () => { prevented = true } })
      expect(prevented).toBe(true)
    }, 30)
    await wait(15)
    expect(answered).toBe(false)
    await wait(40)
    expect(shown).toEqual(['other.test'])
    gate.answer('tab-request-wait', gate.card('tab-request-wait')!.id, 'deny')
    expect(await snapping).toEqual({ ok: false, error: 'The person did not allow other.test.' })
  })

  it('a command whose page requested nothing answers at once, without waiting for a navigation', async () => {
    const { gate } = cardGate()
    const tab = new TabBrowser('tab-no-request', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    const started = Date.now()
    expect(await run(tab, { op: 'snapshot' })).toMatchObject({ ok: true })
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('TabBrowser fix round 3: the navigation wait, the person\'s redirects, holds and popups', () => {
  /** a snapshot whose debugger answer the test releases; the page's request and navigation start are the test's */
  async function heldSnapshot(id: string, gate: SiteGate): Promise<{ tab: TabBrowser; wc: FakeWebContents; snapping: Promise<PipeResponse> }> {
    const tab = new TabBrowser(id, 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    const wc = lastPage()
    wc.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main-frame' } })
    g.__ctHold = 'Accessibility.getFullAXTree'
    const snapping = run(tab, { op: 'snapshot' })
    await wait(10)
    g.__ctHold = null
    return { tab, wc, snapping }
  }

  it('a command whose page navigation starts before its action answers does not wait the 5 s bound for it', async () => {
    const { gate } = cardGate()
    const { tab, wc, snapping } = await heldSnapshot('tab-start-early', gate)
    vi.useFakeTimers()
    try {
      await vi.advanceTimersByTimeAsync(10)
      wc.debugger.emit('message', {}, 'Page.frameRequestedNavigation', { frameId: 'main-frame', reason: 'anchorClick', url: URL_B })
      let prevented = false
      // the page's navigation reaches main before the action answers: its start is seen before the fence
      wc.emit('will-navigate', { url: URL_B, isMainFrame: true, isSameDocument: false, preventDefault: () => { prevented = true } })
      wc.emit('did-start-navigation', { url: URL_B, isMainFrame: true, isSameDocument: false, isInPlace: false })
      let answered = false
      void snapping.then(() => { answered = true })
      g.__ctRelease()
      await vi.advanceTimersByTimeAsync(100)
      expect(answered).toBe(true)
      expect(prevented).toBe(false)
      expect(await snapping).toMatchObject({ ok: true })
    } finally {
      vi.useRealTimers()
      tab.dispose()
    }
  })

  it('a command whose page requests about:blank answers without the 5 s bound: no will-navigate comes for it, its start does', async () => {
    const { gate } = cardGate()
    const { tab, wc, snapping } = await heldSnapshot('tab-blank-request', gate)
    vi.useFakeTimers()
    try {
      await vi.advanceTimersByTimeAsync(10)
      wc.debugger.emit('message', {}, 'Page.frameRequestedNavigation', { frameId: 'main-frame', reason: 'anchorClick', url: 'about:blank' })
      // a page address is never held, so main announces only the start of the navigation
      wc.emit('did-start-navigation', { url: 'about:blank', isMainFrame: true, isSameDocument: false, isInPlace: false })
      let answered = false
      void snapping.then(() => { answered = true })
      g.__ctRelease()
      await vi.advanceTimersByTimeAsync(100)
      expect(answered).toBe(true)
      expect(await snapping).toMatchObject({ ok: true })
    } finally {
      vi.useRealTimers()
      tab.dispose()
    }
  })

  it('a request for a new tab does not make the command wait for a navigation', async () => {
    const { gate } = cardGate()
    const { tab, wc, snapping } = await heldSnapshot('tab-new-tab-request', gate)
    vi.useFakeTimers()
    try {
      await vi.advanceTimersByTimeAsync(10)
      wc.debugger.emit('message', {}, 'Page.frameRequestedNavigation', { frameId: 'main-frame', reason: 'anchorClick', url: POPUP, disposition: 'newTab' })
      let answered = false
      void snapping.then(() => { answered = true })
      g.__ctRelease()
      await vi.advanceTimersByTimeAsync(100)
      expect(answered).toBe(true)
    } finally {
      vi.useRealTimers()
      tab.dispose()
    }
  })

  it('during a person reload, the page\'s own navigation to a site that is not allowed is held', async () => {
    const { gate, shown } = cardGate()
    const { tab, wc, snapping } = await heldSnapshot('tab-person-own', gate)
    // the reload stays pending: the page's navigation starts while the person's load runs
    g.__ctLoad = () => new Promise<void>(() => undefined)
    tab.personAction({ type: 'reload' })
    let prevented = false
    wc.emit('will-navigate', { url: OTHER, isMainFrame: true, isSameDocument: false, preventDefault: () => { prevented = true } })
    await wait(10)
    expect(prevented).toBe(true)
    expect(shown).toEqual(['other.test'])
    gate.answer('tab-person-own', gate.card('tab-person-own')!.id, 'deny')
    g.__ctRelease()
    expect(await snapping).toEqual({ ok: false, error: 'The person did not allow other.test.' })
    tab.dispose()
  })

  it('a Claude navigation that starts while a person\'s load still runs has its redirect to a site not allowed held', async () => {
    const { gate, shown } = cardGate()
    const tab = new TabBrowser('tab-claude-after-person', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    g.__ctLoad = () => new Promise<void>(() => undefined)
    tab.personAction({ type: 'reload' })
    let prevented: boolean | null = null
    g.__ctLoad = (wc, url) => {
      if (url === URL_B) prevented = redirect(wc, OTHER)
      wc.emit('did-finish-load')
      return Promise.resolve()
    }
    const navigating = run(tab, { op: 'navigate', url: URL_B })
    await wait(20)
    expect(prevented).toBe(true)
    expect(shown).toEqual(['other.test'])
    gate.answer('tab-claude-after-person', gate.card('tab-claude-after-person')!.id, 'deny')
    expect(await navigating).toEqual({ ok: false, error: 'The person did not allow other.test.' })
    tab.dispose()
  })

  it('a held navigation replaced by another site keeps the site it asked about: the denial names the first site', async () => {
    const { gate, shown } = cardGate()
    const { tab, wc, snapping } = await heldSnapshot('tab-replace-site', gate)
    const navigate = (url: string): void => { wc.emit('will-navigate', { url, isMainFrame: true, isSameDocument: false, preventDefault: () => undefined }) }
    navigate(OTHER)
    await wait(10)
    navigate(THIRD)
    await wait(10)
    expect(shown).toEqual(['other.test'])
    gate.answer('tab-replace-site', gate.card('tab-replace-site')!.id, 'deny')
    g.__ctRelease()
    expect(await snapping).toEqual({ ok: false, error: 'The person did not allow other.test.' })
    expect(shown).toEqual(['other.test'])
    tab.dispose()
  })

  it('a timeout is remembered for the command like a denial: the same site raises no second card', async () => {
    const { gate, shown } = cardGate(50)
    const { tab, wc, snapping } = await heldSnapshot('tab-timeout-again', gate)
    const navigate = (url: string): void => { wc.emit('will-navigate', { url, isMainFrame: true, isSameDocument: false, preventDefault: () => undefined }) }
    navigate(OTHER)
    // the card times out at 50 ms: the wait ends once the card was announced and is gone
    for (let i = 0; i < 200 && (shown.length === 0 || gate.card('tab-timeout-again') !== null); i++) await wait(10)
    expect(shown).toEqual(['other.test'])
    expect(gate.card('tab-timeout-again')).toBeNull()
    navigate(OTHER)
    await wait(10)
    expect(shown).toEqual(['other.test'])
    g.__ctRelease()
    expect(await snapping).toEqual({ ok: false, error: expect.stringMatching(/^The person did not answer about other\.test\./) })
    tab.dispose()
  })

  it('a popup card denied while the next command runs does not fail that command', async () => {
    const { gate } = cardGate()
    const tab = new TabBrowser('tab-popup-late', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    lastPage().openHandler?.({ url: POPUP })
    await wait(10)
    let finish: () => void = () => undefined
    g.__ctLoad = (wc, url) => new Promise<void>((resolve) => {
      if (url !== URL_B) {
        wc.emit('did-finish-load')
        resolve()
        return
      }
      finish = () => {
        wc.emit('did-finish-load')
        resolve()
      }
    })
    const navigating = run(tab, { op: 'navigate', url: URL_B })
    await wait(20)
    gate.answer('tab-popup-late', gate.card('tab-popup-late')!.id, 'deny')
    await wait(10)
    finish()
    expect(await navigating).toMatchObject({ ok: true })
    tab.dispose()
  })

  it('a Stop, then Hand back within a second: a navigation a second later is not held, as no hold window runs under the person\'s control', async () => {
    const { gate, shown } = cardGate()
    const tab = new TabBrowser('tab-stop-window', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    const wc = lastPage()
    g.__ctHold = 'Accessibility.getFullAXTree'
    vi.useFakeTimers()
    try {
      const snapping = tab.run({ op: 'snapshot' } as BrowserCommand, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(10)
      g.__ctHold = null
      tab.personAction({ type: 'stop' })
      expect(await snapping).toEqual({ ok: false, error: 'Stopped by the person.' })
      tab.personAction({ type: 'handBack' })
      await vi.advanceTimersByTimeAsync(1_000)
      let prevented = false
      wc.emit('will-navigate', { url: OTHER, isMainFrame: true, isSameDocument: false, preventDefault: () => { prevented = true } })
      expect(prevented).toBe(false)
      expect(shown).toEqual([])
    } finally {
      vi.useRealTimers()
      tab.dispose()
    }
  })

  it('the last state sent after the linger says idle, even when the linger timer fires a millisecond before its end', async () => {
    const controls: string[] = []
    const tab = new TabBrowser('tab-linger-end', 'default', { ...deps(), changed: () => controls.push(tab.state().control) })
    g.__ctLoad = loadsAtOnce
    vi.useFakeTimers()
    try {
      const navigating = run(tab, { op: 'navigate', url: URL_A })
      await vi.advanceTimersByTimeAsync(10)
      expect(await navigating).toMatchObject({ ok: true })
      // the clock reads one millisecond before the linger's end when its five seconds are up
      vi.setSystemTime(Date.now() - 1)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(controls.at(-1)).toBe('idle')
    } finally {
      vi.useRealTimers()
      tab.dispose()
    }
  })
})

describe('TabBrowser task 10b: a guarded unload, and the person\'s load over a held navigation', () => {
  beforeEach(() => {
    g.__ctStalls = 0
    g.__ctHold = null
  })

  /** a page's beforeunload guard, as Electron announces a prevented unload; true when a listener prevented the unload */
  function guardedUnload(wc: { emit(event: string, ...args: unknown[]): boolean }): boolean {
    let prevented = false
    wc.emit('will-prevent-unload', { preventDefault: () => { prevented = true } })
    return prevented
  }

  it('a page whose unload is guarded is left: the unload goes ahead, and the footer of the command names the dialog it answered', async () => {
    g.__ctLoad = loadsAtOnce
    const tab = new TabBrowser('tab-guard-command', 'default', deps())
    await run(tab, { op: 'navigate', url: URL_A })
    let prevented: boolean | null = null
    g.__ctLoad = (wc, url) => {
      if (url === URL_B) prevented = guardedUnload(wc)
      wc.emit('did-finish-load')
      return Promise.resolve()
    }
    const reply = await run(tab, { op: 'navigate', url: URL_B })
    expect(prevented).toBe(true)
    expect(reply).toMatchObject({ ok: true, info: expect.stringContaining('- Dialog: beforeunload "Leave site?" → OK') })
    tab.dispose()
  })

  it('a guarded unload outside a command is reported by the next footer of the page', async () => {
    g.__ctLoad = loadsAtOnce
    const tab = new TabBrowser('tab-guard-next', 'default', deps())
    await run(tab, { op: 'navigate', url: URL_A })
    expect(guardedUnload(lastPage())).toBe(true)
    const listed = await run(tab, { op: 'tabs', action: 'list', index: null, url: null })
    expect(listed).toMatchObject({ ok: true, info: expect.stringContaining('- Dialog: beforeunload "Leave site?" → OK') })
    tab.dispose()
  })

  it('a person\'s load drops the page\'s waiting hold: its card goes, the command answers that it was stopped, and the held address never loads', async () => {
    const { gate } = cardGate()
    const tab = new TabBrowser('tab-person-drops-hold', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    const loads: string[] = []
    g.__ctLoad = (wc, url) => {
      loads.push(url)
      if (url === URL_B) {
        redirect(wc, OTHER)
        wc.emit('did-stop-loading')
      } else {
        wc.emit('did-finish-load')
      }
      return Promise.resolve()
    }
    const navigating = run(tab, { op: 'navigate', url: URL_B })
    await wait(20)
    expect(gate.card('tab-person-drops-hold')?.site).toBe('other.test')
    tab.personAction({ type: 'navigate', url: URL_A })
    expect(await Promise.race([navigating, wait(300).then(() => 'still waiting')])).toEqual({ ok: false, error: 'Stopped by the person.' })
    expect(gate.card('tab-person-drops-hold')).toBeNull()
    await wait(20)
    expect(loads).toEqual([URL_B, URL_A])
    tab.dispose()
  })
})

describe('TabBrowser: a page whose first load has not committed', () => {
  beforeEach(() => {
    // the load never commits: the page's web contents has no address yet, as before a page's first navigation commits
    g.__ctLoad = (wc) => {
      (wc as unknown as { url: string }).url = ''
      return new Promise<void>(() => undefined)
    }
  })

  it('saved keeps the address the page was made for', () => {
    const tab = new TabBrowser('tab-uncommitted-saved', 'default', deps())
    tab.restoreSaved([URL_A], 0)
    tab.personAction({ type: 'selectPage', index: 0 })
    expect(tab.saved()).toEqual({ profile: 'default', pages: [URL_A], current: 0 })
    tab.dispose()
  })

  it('the list and the footer give that address; a page the tab may not use is named by its site only', async () => {
    const tab = new TabBrowser('tab-uncommitted-list', 'default', deps())
    tab.restoreSaved([URL_A, OTHER], 0)
    tab.personAction({ type: 'selectPage', index: 0 })
    const reply = await run(tab, { op: 'tabs', action: 'list', index: null, url: null })
    expect(reply.ok && reply.info).toContain(`- URL: ${URL_A}`)
    expect(reply.ok && reply.info).toContain(`0:  — ${URL_A}`)
    expect(reply.ok && reply.info).toContain('1: a page on other.test')
    expect(reply.ok && reply.info).not.toContain(OTHER)
    tab.dispose()
  })
})

describe('TabBrowser: a first load that redirects', () => {
  it('a page made for a local address whose first load commits on another site asks before the command reads it', async () => {
    const { gate, shown } = cardGate(20)
    // the first load has no address until it commits, and it commits on other.test a moment later: a redirect of the load
    g.__ctLoad = (wc) => {
      (wc as unknown as { url: string }).url = ''
      return new Promise<void>((resolve) => setTimeout(() => {
        (wc as unknown as { url: string }).url = OTHER
        resolve()
      }, 10))
    }
    const tab = new TabBrowser('tab-redirect-first', 'default', { ...deps(), gate })
    tab.restoreSaved([URL_A], 0)
    tab.personAction({ type: 'selectPage', index: 0 })
    const reply = await run(tab, { op: 'snapshot' })
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('other.test') })
    expect(shown).toEqual(['other.test'])
    tab.dispose()
  })
})

describe('TabBrowser profiles', () => {
  const withWork: Pick<TabBrowserDeps, 'profiles'> = { profiles: () => [{ id: 'default', name: 'Default' }, { id: 'work', name: 'Work' }] }

  beforeEach(() => {
    g.__ctLoad = loadsAtOnce
  })

  it('setProfile keeps the URLs and the current page in the new profile, and saves the change', async () => {
    const changed = vi.fn()
    const tab = new TabBrowser('tab-profile', 'default', { ...deps(), ...withWork, changed })
    await run(tab, { op: 'navigate', url: URL_A })
    await run(tab, { op: 'tabs', action: 'new', url: URL_B })
    changed.mockClear()
    tab.personAction({ type: 'setProfile', profileId: 'work' })
    expect(tab.profile()).toBe('work')
    expect(tab.state()).toMatchObject({ profileId: 'work', current: 1, pages: [{ url: URL_A }, { url: URL_B }] })
    expect(tab.saved()).toEqual({ profile: 'work', pages: [URL_A, URL_B], current: 1 })
    expect(changed).toHaveBeenCalled()
    tab.dispose()
  })

  it('a tab with no page on the default profile saves nothing; one on another profile saves its profile', () => {
    expect(new TabBrowser('tab-none', 'default', deps()).saved()).toBeNull()
    expect(new TabBrowser('tab-work', 'work', deps()).saved()).toEqual({ profile: 'work', pages: [], current: 0 })
  })

  it('clearData and manageProfiles go to the deps: clearData with the tab\'s profile', () => {
    const clearData = vi.fn()
    const manageProfiles = vi.fn()
    const tab = new TabBrowser('tab-data', 'work', { ...deps(), clearData, manageProfiles })
    tab.personAction({ type: 'clearData' })
    tab.personAction({ type: 'manageProfiles' })
    expect(clearData).toHaveBeenCalledWith('work')
    expect(manageProfiles).toHaveBeenCalledTimes(1)
  })

  it('a profile change ends what the tab waits for: its card goes and its command stops; the tab is on the new profile', async () => {
    const d = deps()
    const tab = new TabBrowser('tab-switch', 'default', { ...d, ...withWork })
    const pending = run(tab, { op: 'navigate', url: 'http://site.test:9/' })
    await wait(20)
    expect(d.gate.card('tab-switch')).not.toBeNull()
    tab.personAction({ type: 'setProfile', profileId: 'work' })
    expect(await pending).toEqual({ ok: false, error: 'Stopped by the person.' })
    expect(d.gate.card('tab-switch')).toBeNull()
    expect(tab.profile()).toBe('work')
    tab.dispose()
  })

  it('saved keeps a tab moved to Default: when the store default is Work, a Default tab with no page is saved, a Work tab with none is not', () => {
    const withWorkDefault = { ...deps(), defaultProfile: () => 'work' }
    expect(new TabBrowser('tab-moved', 'default', withWorkDefault).saved()).toEqual({ profile: 'default', pages: [], current: 0 })
    expect(new TabBrowser('tab-on-work', 'work', withWorkDefault).saved()).toBeNull()
  })

  it('manageProfiles on a restored tab makes no page: only the actions that show a page make the saved ones', () => {
    const tab = new TabBrowser('tab-manage', 'default', deps())
    tab.restoreSaved([URL_A, URL_B], 1)
    const before = g.__ctViews.length
    tab.personAction({ type: 'manageProfiles' })
    expect(g.__ctViews.length - before).toBe(0)
    expect(tab.saved()).toEqual({ profile: 'default', pages: [URL_A, URL_B], current: 1 })
    tab.dispose()
  })

  it('a profile change on a restored tab keeps its saved pages for the new profile', () => {
    const tab = new TabBrowser('tab-keep', 'default', { ...deps(), ...withWork })
    tab.restoreSaved([URL_A, URL_B], 1)
    tab.personAction({ type: 'setProfile', profileId: 'work' })
    expect(tab.saved()).toEqual({ profile: 'work', pages: [URL_A, URL_B], current: 1 })
    tab.dispose()
  })
})

/** round 2: the footer when the address changes while it is read; the news of a masked page; the names of a local file */
describe('TabBrowser round 2: footers, masked news and local files', () => {
  beforeEach(() => {
    g.__ctStalls = 0
    g.__ctHold = null
  })

  it('a page whose address changes while its title is read gets a masked footer: the site only, and no title', async () => {
    g.__ctLoad = loadsAtOnce
    const tab = new TabBrowser('tab-reread', 'default', deps())
    await run(tab, { op: 'navigate', url: URL_A })
    const wc = lastPage()
    // the page's own title read (the second evaluate of the command: the first is the fence) waits; the page moves to another site meanwhile
    const debuggerOf = wc.debugger as unknown as { sendCommand(method: string, params?: unknown): Promise<unknown> }
    const send = debuggerOf.sendCommand.bind(wc.debugger)
    let evaluates = 0
    let release: () => void = () => undefined
    debuggerOf.sendCommand = (method: string, params?: unknown) => {
      if (method !== 'Runtime.evaluate') return send(method, params)
      evaluates += 1
      if (evaluates !== 2) return send(method, params)
      wc.url = OTHER
      return new Promise((resolve) => {
        release = () => resolve(send(method, params))
      })
    }
    const listing = run(tab, { op: 'tabs', action: 'list', index: null, url: null })
    await wait(10)
    release()
    const reply = await listing
    const footer = reply.ok ? reply.info!.split('### Page')[1] : ''
    expect(footer).toContain('- URL: a page on other.test')
    expect(footer).not.toContain('- Title:')
    expect(footer).not.toContain('/page')
  })

  it('a masked footer shows no console error and no dialog, and the news it drops does not show once the page is allowed again', async () => {
    g.__ctLoad = loadsAtOnce
    const tab = new TabBrowser('tab-masked-news', 'default', deps())
    await run(tab, { op: 'navigate', url: URL_A })
    const wc = lastPage()
    // the page moves to another site in place, with no new document; its errors and dialogs are reported meanwhile
    wc.url = OTHER
    wc.debugger.emit('message', {}, 'Runtime.exceptionThrown', { exceptionDetails: { text: 'masked boom' } })
    wc.debugger.emit('message', {}, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: '__ct_dialog__{"type":"alert","message":"masked dialog","answer":"OK"}' }] })
    const masked = await run(tab, { op: 'tabs', action: 'list', index: null, url: null })
    expect(masked.ok && masked.info).toContain('- URL: a page on other.test')
    expect(masked.ok && masked.info).not.toContain('New console errors')
    expect(masked.ok && masked.info).not.toContain('Dialog:')
    expect(masked.ok && masked.info).not.toContain('masked boom')
    // the page is on an allowed address again, in place: the news taken while it was masked does not show
    wc.url = URL_A
    const allowed = await run(tab, { op: 'tabs', action: 'list', index: null, url: null })
    expect(allowed.ok && allowed.info).toContain('- Title:')
    expect(allowed.ok && allowed.info).not.toContain('masked boom')
    expect(allowed.ok && allowed.info).not.toContain('masked dialog')
  })

  it('a file the person opened outside the folder is named by its masked form when Claude uses it and the person denies it; Claude\'s own navigate keeps the path', async () => {
    const { gate, shown } = cardGate()
    const tab = new TabBrowser('tab-local-use', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    const file = join(tmpdir(), 'ct-round2', 'person.html')
    tab.personAction({ type: 'navigate', url: pathToFileURL(file).href })
    await wait(10)
    const snapping = run(tab, { op: 'snapshot' })
    await wait(10)
    expect(shown).toContain(file)
    gate.answer('tab-local-use', gate.card('tab-local-use')!.id, 'deny')
    expect(await snapping).toEqual({ ok: false, error: 'The person did not allow a local file outside the tab\'s folder.' })
    const own = join(tmpdir(), 'ct-round2', 'claude.html')
    const navigating = run(tab, { op: 'navigate', url: pathToFileURL(own).href })
    await wait(10)
    gate.answer('tab-local-use', gate.card('tab-local-use')!.id, 'deny')
    expect(await navigating).toEqual({ ok: false, error: `The person did not allow ${own}.` })
  })

  it('a file the person denied in a command is refused again without a card for the rest of that command', async () => {
    const { gate } = cardGate()
    const tab = new TabBrowser('tab-denied-file', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    const wc = lastPage()
    const file = join(tmpdir(), 'ct-round2', 'denied.html')
    const waiting = run(tab, { op: 'wait_for', text: null, textGone: null, time: 1 })
    await wait(10)
    const navigate = (): boolean => {
      let prevented = false
      wc.emit('will-navigate', { url: pathToFileURL(file).href, isMainFrame: true, isSameDocument: false, preventDefault: () => { prevented = true } })
      return prevented
    }
    expect(navigate()).toBe(true)
    await wait(10)
    expect(gate.card('tab-denied-file')?.file).toBe(true)
    gate.answer('tab-denied-file', gate.card('tab-denied-file')!.id, 'deny')
    expect(navigate()).toBe(true)
    await wait(10)
    expect(gate.card('tab-denied-file')).toBeNull()
    // the command answers at its time limit, with the denial: a command left waiting is reported as 'hung', not as a timeout of the test
    expect(await Promise.race([waiting, wait(3_000).then(() => 'hung')])).toEqual({ ok: false, error: `The person did not allow ${file}.` })
  })

  it('a form posted to a file the person allowed in this tab is not sent again, and the reply names the file by its masked form', async () => {
    const { gate } = cardGate()
    const tab = new TabBrowser('tab-form-file', 'default', { ...deps(), gate })
    g.__ctLoad = loadsAtOnce
    await run(tab, { op: 'navigate', url: URL_A })
    const wc = lastPage()
    wc.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main-frame' } })
    const file = join(tmpdir(), 'ct-round2', 'form.html')
    wc.debugger.emit('message', {}, 'Page.frameRequestedNavigation', { frameId: 'main-frame', reason: 'formSubmissionPost', url: pathToFileURL(file).href })
    const waiting = run(tab, { op: 'wait_for', text: null, textGone: null, time: 1 })
    await wait(10)
    wc.emit('will-navigate', { url: pathToFileURL(file).href, isMainFrame: true, isSameDocument: false, preventDefault: () => undefined })
    await wait(10)
    gate.answer('tab-form-file', gate.card('tab-form-file')!.id, 'tab')
    expect(await Promise.race([waiting, wait(3_000).then(() => 'hung')])).toEqual({ ok: false, error: 'The person allowed a local file outside the tab\'s folder; the form was not sent. Submit it again.' })
  })
})

function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

