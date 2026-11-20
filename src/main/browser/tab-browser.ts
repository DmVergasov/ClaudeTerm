import { WebContentsView, type DownloadItem, type WebContents } from 'electron'
import { MAX_PAGES, partitionOf, type BrowserCommand, type BrowserControl, type BrowserPageView, type BrowserPanelAction, type BrowserPanelState, type BrowserTabState } from '../../shared/browser'
import type { PipeImage, PipeResponse } from '../../shared/protocol'
import { canonicalUrl, isFileUrl, isWebUrl, siteOf } from '../../shared/site'
import { PageDriver, viewShot, type Cdp, type DialogNews } from './page-driver'
import { subjectOf, type GateResult, type SiteGate } from './site-gate'
import { withFooter, type PageFooter } from './result-text'
import { appKeyFor } from './app-keys'
import type { KeyAction } from '../../shared/keymap'

/** the window the pages are shown in: the hub places each page's view (shown, or parked out of sight) */
export interface PageStage {
  /** adds a page's view to the window, then places the pages */
  add(view: WebContentsView): void
  /** takes a page's view out of the window, then places the pages; the tab's keyboard is handed on from it */
  remove(view: WebContentsView, tabId: string): void
  /** puts every page where it belongs: the shown page on top, the others parked */
  layout(): void
  /** whether the window is minimized: a screenshot cannot be taken then */
  minimized(): boolean
}

export interface TabBrowserDeps {
  stage: PageStage
  gate: SiteGate
  profiles(): { id: string; name: string }[]
  /** sets up a profile's session once: permissions and downloads */
  configureSession(profileId: string): void
  /** the tab's browser state changed: the panel gets it */
  changed(): void
  /** Claude's first navigation in the tab: the Browser panel may open */
  openPanel(): void
  /** the platform, which the app's shortcuts depend on */
  platform: string
  /** an app shortcut pressed in a page: the window runs it, the page does not get the key */
  appKey(action: KeyAction): void
  /** the person asked to manage the profiles: Settings opens on Browser */
  manageProfiles(): void
  /** the person cleared a profile's data: its cookies, storage and cache */
  clearData(profileId: string): void
  /** the store's default profile: a tab on it with no page has nothing to save */
  defaultProfile(): string
}

/** the panel's actions that show or act on a page: the saved pages are made for them, and for no other action */
const PAGE_ACTIONS: ReadonlySet<BrowserPanelAction['type']> = new Set(['navigate', 'back', 'forward', 'reload', 'stopLoading', 'selectPage', 'closePage', 'newPage', 'devtools'])

const REFUSED_URL = 'The ClaudeTerm browser opens only http, https and file addresses.'
/** how a local file outside the tab's folder is named where its path must not show: the footers, the list and the messages to Claude */
const LOCAL_FILE_MASK = 'a local file outside the tab\'s folder'
const NO_PAGE = 'There is no page in this tab. Navigate to an address first, or open a page with browser_tabs.'
const TOOK_CONTROL = 'The person took control of the browser. Ask them before using it again.'
const STOPPED = 'Stopped by the person.'
const PAGE_CLOSED = 'The page closed.'
const MINIMIZED = 'The ClaudeTerm window is minimized; ask the person to restore it, then take the screenshot again.'
const NAV_LIMIT = 60_000
const NAV_SETTLE_LIMIT = 5_000
const WAIT_LIMIT = 65_000
const COMMAND_LIMIT = 30_000
/** how long the panel says Claude is using the browser after a command ends */
const LINGER_MS = 5_000
/** how long after a command ends the tab still holds the navigations its pages start */
const HOLD_MS = 3_000
/** the time a page's debugger has to turn its domains on */
const ENABLE_LIMIT = 15_000
/** the time a command waits, in all, for the downloads that start during it to end */
const DOWNLOAD_LIMIT = 20_000
/** the time a navigation on an open page waits for a download to start, when its load ends with no page committed */
const DOWNLOAD_START_LIMIT = 1_000
const ERR_ABORTED = -3
/** how many dialogs main answered for a page, and no footer has shown yet, the page keeps */
const ANSWERED_LIMIT = 20

/** what a command shows: its text, and an image for a screenshot */
interface Done {
  text: string
  image?: PipeImage
}

/** a page: its view, its driver once the debugger is attached, and the CDP events its driver listens to */
interface Page {
  view: WebContentsView
  /** the address the page was made for: its web contents has no address until the first navigation commits */
  firstUrl: string
  driver: PageDriver | null
  handlers: Map<string, ((params: unknown) => void)[]>
  /** the first load is done and the debugger is attached (or failed): resolves to the load's error text, or null; never rejects */
  ready: Promise<string | null>
  /** the page left the strip (or its contents were destroyed): a command that still uses it answers that the page closed */
  closed: boolean
  /** the debugger's attach in progress, if any: a command that needs the driver waits for it instead of starting another */
  attaching: Promise<PageDriver> | null
  /** the load the person started in the page, while it runs: its own redirects are the person's and are never held; a new load of the page replaces it */
  personLoad: symbol | null
  /** how many main-frame navigations of the page main has decided (held, refused or let through): a command checks the count */
  checks: number
  /** a load allowed after a hold is in progress: its own redirects are checked the same way */
  heldLoad: boolean
  /** the navigation of the page that waits for the person's answer, if any: one hold per page */
  hold: Hold | null
  /** the commands waiting for a navigation of the page to pass main's check or become a hold: each is woken by the next one */
  settles: Set<() => void>
  /** the dialogs main answered for the page itself (a beforeunload guard the unload went past): the page's next footer shows them */
  answered: DialogNews[]
}

/** the message when the person allowed a form's submission: Claude submits it again, as ClaudeTerm never sends it */
function formNotSent(site: string): string {
  return `The person allowed ${site}; the form was not sent. Submit it again.`
}

/** how a load ended: the Chromium error text when the main frame failed, and whether a navigation committed in the page */
interface LoadResult {
  failure: string | null
  committed: boolean
}

/** a download running in the tab's pages: its file name, and the promise that settles when it ends */
interface Download {
  name: string
  ended: Promise<void>
}

/**
 * A navigation of a page that the tab holds: the address it goes to (a newer one replaces it while the card waits), the
 * stop that ends its check, and the promise that settles once it is decided and any load it allows has ended.
 */
interface Hold {
  page: Page
  /** the address the person is asked about now; a newer one replaces it while the card waits */
  url: string
  /** how the navigation came: a form's POST is not sent again once allowed */
  kind: 'navigate' | 'redirect'
  stop: AbortController
  done: Promise<void>
}

/**
 * What a command runs with: its abort signal, and its own time limit, which pauses only while this command waits for the
 * person's answer.
 */
interface Run {
  stop: AbortController
  signal: AbortSignal
  limit: Limit
}

/**
 * A command's time limit. It runs while the command works and stops while the command waits for a gate check or a held
 * navigation: the person's time to answer a card is not the command's time.
 */
class Limit {
  private left: number
  private since = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private pauses = 0
  private over = false

  constructor(ms: number, private readonly expire: () => void) {
    this.left = ms
    this.run()
  }

  pause(): void {
    this.pauses += 1
    this.halt()
  }

  resume(): void {
    this.pauses = Math.max(0, this.pauses - 1)
    this.run()
  }

  /** the command is over: the limit never fires again */
  clear(): void {
    this.over = true
    this.halt()
  }

  private run(): void {
    if (this.over || this.pauses > 0 || this.timer !== null) return
    this.since = Date.now()
    this.timer = setTimeout(() => {
      this.timer = null
      this.over = true
      this.expire()
    }, this.left)
  }

  private halt(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
    this.left -= Date.now() - this.since
  }
}

function fail(error: string): PipeResponse {
  return { ok: false, error }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** the message for a gate check that did not allow the URL; null when it did */
/**
 * The message for a check that did not allow the URL. A local file is named by its path when Claude asked for it by its URL
 * (`open`); a page Claude did not ask for by URL (`use`) is a local file outside the tab's folder, as the list names it.
 */
function gateError(result: GateResult, url: string, kind: 'open' | 'use'): string | null {
  const subject = subjectOf(url)
  const site = kind === 'use' && isFileUrl(url) ? LOCAL_FILE_MASK : (subject?.site ?? 'this page')
  switch (result) {
    case 'allowed': return null
    case 'denied': return `The person did not allow ${site}.`
    case 'timeout': return `The person did not answer about ${site}. Let them know you are waiting for the Browser panel in ClaudeTerm.`
    case 'stopped': return STOPPED
  }
}

/** how long a command may run: navigation 60 s, a wait 60 s and its 5 s, the rest 30 s */
function timeLimit(command: BrowserCommand): number {
  switch (command.op) {
    case 'navigate':
    case 'back':
    case 'forward':
    case 'reload': return NAV_LIMIT
    case 'wait_for': return WAIT_LIMIT
    default: return COMMAND_LIMIT
  }
}

/** the command's name as a message starts it: `Navigate`, `Press key` */
function titleOf(command: BrowserCommand): string {
  const words = command.op.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** the text of a navigation's result: the load's error text when the page did not load */
function navigatedText(failure: string | null): string {
  return failure === null ? 'Navigated.' : `Navigated, but the page did not load: ${failure}.`
}

/** work that gives up with `message` after `ms`; the work itself is left to finish or fail on its own */
function withLimit<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([work, expired]).finally(() => clearTimeout(timer))
}

/**
 * Starts a navigation with `start` and resolves when it ends, with the Chromium error text when the main frame failed to
 * load (else null), and whether the navigation committed in the page. A load ends when its own promise settles (a
 * navigation that becomes a download aborts it, and fails no frame), when its main frame fails or stops, when the page is
 * destroyed, or at the limit.
 */
function loadEnd(wc: WebContents, limitMs: number, start: () => Promise<unknown> | void): Promise<LoadResult> {
  return new Promise((resolve) => {
    let failure: string | null = null
    let committed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      clearTimeout(timer)
      wc.removeListener('did-finish-load', finish)
      wc.removeListener('did-stop-loading', finish)
      wc.removeListener('did-navigate-in-page', onInPage)
      wc.removeListener('did-navigate', onCommit)
      wc.removeListener('did-fail-load', onFail)
      wc.removeListener('destroyed', finish)
      resolve({ failure, committed })
    }
    const onCommit = (): void => {
      committed = true
    }
    const onInPage = (): void => {
      committed = true
      finish()
    }
    const onFail = (_e: unknown, code: number, description: string, _url: string, isMainFrame: boolean): void => {
      if (!isMainFrame || code === ERR_ABORTED) return
      failure = description
      finish()
    }
    timer = setTimeout(finish, limitMs)
    wc.on('did-finish-load', finish)
    wc.on('did-stop-loading', finish)
    wc.on('did-navigate', onCommit)
    wc.on('did-navigate-in-page', onInPage)
    wc.on('did-fail-load', onFail)
    wc.on('destroyed', finish)
    const started = start()
    if (started instanceof Promise) started.then(finish, finish)
  })
}

/** the address a page has now: the last committed one, or the address it was made for while its first load has not committed */
function urlNow(page: Page): string {
  return page.view.webContents.getURL() || page.firstUrl
}

/** closes a page for good: its debugger is detached and its web contents destroyed */
function destroy(page: Page): void {
  const wc = page.view.webContents
  if (wc.isDestroyed()) return
  if (wc.debugger.isAttached()) wc.debugger.detach()
  wc.close()
}

/**
 * The browser of one Claude tab: its pages (each a WebContentsView in the window, in the tab's profile), the commands
 * Claude sends, one at a time, and the person's own actions in the Browser panel.
 */
export class TabBrowser {
  private readonly pages: Page[] = []
  /** the index of the current page; null while the tab has no page */
  private cur: number | null = null
  private profileId: string
  private control: 'idle' | 'person' = 'idle'
  private queue: Promise<unknown> = Promise.resolve()
  /** the commands that run: stopping the tab aborts them */
  private readonly running = new Set<Run>()
  private lingerUntil = 0
  private lingerTimer: ReturnType<typeof setTimeout> | null = null
  private opened = false
  /** the completed downloads of the tab's pages since the last footer: their file names */
  private downloads: string[] = []
  /** the downloads running in the tab's pages now */
  private readonly downloading = new Set<Download>()
  /** the downloads running when the current command started: the command does not wait for them */
  private downloadsBefore = new Set<Download>()
  /** when the current command stops waiting for the downloads it started: its start plus DOWNLOAD_LIMIT */
  private downloadDeadline = 0
  /** how many downloads have started in the tab, and who waits for the next one to start */
  private downloadStarts = 0
  private readonly startWaiters = new Set<() => void>()
  /** the tab holds Claude's navigations until this time: HOLD_MS after Claude's last command ended */
  private holdUntil = 0
  /** the navigations held now: each waits for the person's answer to its card, then loads if allowed */
  private readonly holds = new Set<Hold>()
  /** the stops of the holds and of the popups waiting for a card: Stop and the tab's end abort them all */
  private readonly stops = new Set<AbortController>()
  /** the denial of the first held navigation since the current command started: it answers that command */
  private denial: string | null = null
  /** the sites the person denied, or whose card timed out, during the current command: a navigation to one of them is refused without a card */
  private readonly deniedSites = new Map<string, 'denied' | 'timeout'>()
  private disposed = false
  /** the pages the session saved and no one has shown yet: they are created by materialize(), on the panel's first show or the tab's first command */
  private pending: { pages: string[]; current: number } | null = null

  constructor(private readonly tabId: string, profileId: string, private readonly d: TabBrowserDeps) {
    this.profileId = profileId
  }

  /** the profile the tab's pages are in */
  profile(): string {
    return this.profileId
  }

  /** runs one command of Claude's, after the commands before it; the result text carries the page's footer */
  run(command: BrowserCommand, closed: AbortSignal): Promise<PipeResponse> {
    const next = this.queue.then(() => this.execute(command, closed))
    // a command that failed does not stop the commands after it
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  /** the person's action in the Browser panel: a navigation, a page, the profile, a card's answer or the control */
  personAction(a: BrowserPanelAction): void {
    if (this.disposed) return
    if (PAGE_ACTIONS.has(a.type)) this.materialize()
    switch (a.type) {
      case 'navigate':
        if (isWebUrl(a.url)) this.personNavigate(a.url)
        break
      case 'back':
      case 'forward':
      case 'reload':
        this.personHistory(a.type)
        break
      case 'stopLoading':
        // the page's load ends where it is; a page that is not loading is left as it is
        this.currentPage()?.view.webContents.stop()
        break
      case 'newPage':
        if (this.pages.length < MAX_PAGES) this.addPage('about:blank', true)
        break
      case 'selectPage':
        if (a.index < this.pages.length) this.setCurrent(a.index)
        break
      case 'closePage':
        if (a.index < this.pages.length) this.removePage(a.index)
        break
      case 'setProfile':
        this.setProfile(a.profileId)
        break
      case 'stop':
        this.control = 'person'
        // the hold window ends with Stop. The cards go first: a card queued behind a running command is then never shown
        this.holdUntil = 0
        this.d.gate.stop(this.tabId)
        this.stopHolds()
        this.stopRunning()
        break
      case 'handBack':
        this.control = 'idle'
        break
      case 'answer':
        this.d.gate.answer(this.tabId, a.cardId, a.answer)
        break
      case 'devtools':
        this.currentPage()?.view.webContents.openDevTools({ mode: 'detach' })
        break
      case 'manageProfiles': this.d.manageProfiles(); break
      case 'clearData': this.d.clearData(this.profileId); break
    }
    this.changed()
  }

  /** what the Browser panel shows for the tab */
  state(): BrowserPanelState {
    const page = this.currentPage()?.view.webContents ?? null
    return {
      tabId: this.tabId,
      profileId: this.profileId,
      profiles: this.d.profiles(),
      pages: this.shownPages(),
      current: this.pending ? (this.pending.pages.length > 0 ? this.pending.current : null) : this.cur,
      control: this.controlNow(),
      card: this.d.gate.card(this.tabId),
      canBack: page?.navigationHistory.canGoBack() ?? false,
      canForward: page?.navigationHistory.canGoForward() ?? false,
      devtools: page !== null
    }
  }

  /** the saved state: the profile, the pages' URLs and the current one; null for a tab with no page on the default profile */
  saved(): BrowserTabState | null {
    const pages = this.pending ? [...this.pending.pages] : this.pages.map((p) => urlNow(p))
    const current = this.pending ? this.pending.current : this.cur ?? 0
    if (pages.length === 0 && this.profileId === this.d.defaultProfile()) return null
    return { profile: this.profileId, pages, current }
  }

  /** the pages the session saved for this tab: they stay unmade until materialize() (the panel's first show, or the tab's first command) */
  restoreSaved(pages: string[], current: number): void {
    this.pending = { pages: [...pages], current }
  }

  /** creates the saved pages, once: each loads in the tab's profile, and the saved current page is selected */
  materialize(): void {
    const saved = this.pending
    if (saved === null) return
    this.pending = null
    for (const url of saved.pages) this.addPage(url, true)
    if (this.pages.length > 0) this.setCurrent(Math.min(saved.current, this.pages.length - 1))
  }

  /** every page's view: the hub places them */
  views(): WebContentsView[] {
    return this.pages.map((p) => p.view)
  }

  /** the view of the current page, or null */
  currentView(): WebContentsView | null {
    return this.currentPage()?.view ?? null
  }

  /** whether one of the tab's pages is this web contents (a download comes from one) */
  owns(wc: WebContents): boolean {
    return this.pages.some((p) => p.view.webContents === wc)
  }

  /**
   * A download of one of the tab's pages, saved under `fileName`: the next footer shows it once it has completed. A
   * command waits for the downloads still running (up to a limit) before its footer.
   */
  trackDownload(item: DownloadItem, fileName: string): void {
    const ended = new Promise<void>((resolve) => {
      item.once('done', (_e, state) => {
        this.downloading.delete(entry)
        if (state === 'completed') this.downloads.push(fileName)
        resolve()
      })
    })
    const entry: Download = { name: fileName, ended }
    this.downloading.add(entry)
    this.downloadStarts += 1
    for (const wake of [...this.startWaiters]) wake()
  }

  /** the tab closes or is removed: running commands stop, every page is closed, and no change is sent any more */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopRunning()
    this.stopHolds()
    // a navigation waiting for a download to start ends now, and its command is stopped already
    for (const wake of [...this.startWaiters]) wake()
    if (this.lingerTimer !== null) clearTimeout(this.lingerTimer)
    this.lingerTimer = null
    for (const page of this.pages.splice(0)) {
      this.d.stage.remove(page.view, this.tabId)
      destroy(page)
    }
    this.cur = null
  }

  private async execute(command: BrowserCommand, closed: AbortSignal): Promise<PipeResponse> {
    if (this.disposed || closed.aborted) return fail(STOPPED)
    if (this.control === 'person') return fail(TOOK_CONTROL)
    // the saved pages come up with the tab's first command
    this.materialize()
    const stop = new AbortController()
    const onClosed = (): void => stop.abort()
    closed.addEventListener('abort', onClosed, { once: true })
    this.downloadsBefore = new Set(this.downloading)
    this.downloadDeadline = Date.now() + DOWNLOAD_LIMIT
    // the time limit and a stop both end the wait at once; the work they leave behind stops at its next wait
    let onLimit: () => void = () => undefined
    const limit = new Limit(timeLimit(command), () => onLimit())
    const run: Run = { stop, signal: stop.signal, limit }
    this.running.add(run)
    this.changed()
    const limited = new Promise<PipeResponse>((resolve) => {
      onLimit = () => {
        resolve(fail(`${titleOf(command)} took too long.`))
        stop.abort()
      }
    })
    const stopped = new Promise<PipeResponse>((resolve) => {
      stop.signal.addEventListener('abort', () => resolve(fail(STOPPED)), { once: true })
    })
    // a navigation held by an earlier command is answered first: this command waits for the person's answer to it
    const work = (async (): Promise<PipeResponse> => {
      await this.paused(run, this.holdsDone())
      this.denial = null
      this.deniedSites.clear()
      return stop.signal.aborted ? fail(STOPPED) : this.perform(command, run)
    })().catch((e: unknown) => (stop.signal.aborted ? fail(STOPPED) : fail(messageOf(e))))
    try {
      return await Promise.race([work, limited, stopped])
    } finally {
      limit.clear()
      closed.removeEventListener('abort', onClosed)
      this.running.delete(run)
      // after the tab is disposed nothing may be armed again: a timer would outlive the tab
      if (!this.disposed) {
        // a command that ended under the person's control opens no hold window: Hand back does not reopen one
        if (this.controlNow() !== 'person') this.holdUntil = Date.now() + HOLD_MS
        this.lingerUntil = Date.now() + LINGER_MS
        if (this.lingerTimer !== null) clearTimeout(this.lingerTimer)
        this.lingerTimer = setTimeout(() => {
          this.lingerTimer = null
          // the linger is over: the state sent next says idle, whatever the clock says
          this.lingerUntil = 0
          this.changed()
        }, LINGER_MS)
      }
      this.changed()
    }
  }

  private async perform(command: BrowserCommand, run: Run): Promise<PipeResponse> {
    const signal = run.signal
    switch (command.op) {
      case 'navigate': return this.navigate(command.url, run)
      case 'back':
      case 'forward': return this.onPage(run, async (page) => {
        const history = page.view.webContents.navigationHistory
        const back = command.op === 'back'
        if (back ? !history.canGoBack() : !history.canGoForward()) throw new Error(back ? 'There is no earlier page to go back to.' : 'There is no later page to go forward to.')
        // a history step raises no will-navigate, so the entry it goes to is checked here, as a navigation of Claude's would be
        const entry = history.getEntryAtIndex(history.getActiveIndex() + (back ? -1 : 1))
        const denied = gateError(await this.checkGate(run, entry.url, 'open'), entry.url, 'open')
        if (denied !== null) throw new Error(denied)
        signal.throwIfAborted()
        await this.settleAfter(page, () => (back ? history.goBack() : history.goForward()))
        return { text: back ? 'Went back.' : 'Went forward.' }
      })
      case 'reload': return this.onPage(run, async (page) => {
        await this.settleAfter(page, () => page.view.webContents.reload())
        return { text: 'Reloaded.' }
      })
      case 'snapshot': return this.onPage(run, async (_page, d) => ({ text: await d.snapshot() }))
      case 'click': return this.onPage(run, async (_page, d) => {
        await d.click(command.ref, command.button, command.doubleClick, signal)
        return { text: `Clicked ${command.element}.` }
      })
      case 'type': return this.onPage(run, async (_page, d) => {
        await d.type(command.ref, command.text, command.submit, command.slowly, signal)
        return { text: `Typed into ${command.element}.` }
      })
      case 'press_key': return this.onPage(run, async (_page, d) => {
        await d.pressKey(command.key, signal)
        return { text: `Pressed ${command.key}.` }
      })
      case 'hover': return this.onPage(run, async (_page, d) => {
        await d.hover(command.ref)
        return { text: `Hovered ${command.element}.` }
      })
      case 'select_option': return this.onPage(run, async (_page, d) => {
        const selected = await d.selectOption(command.ref, command.values)
        return { text: `Selected ${selected.join(', ') || 'nothing'}.` }
      })
      case 'scroll': return this.onPage(run, async (_page, d) => {
        await d.scroll(command.ref, command.direction, command.amount, signal)
        return { text: `Scrolled ${command.direction}.` }
      })
      case 'wait_for': return this.onPage(run, async (_page, d) => {
        await d.waitFor(command.text, command.textGone, command.time, signal)
        return { text: 'Waited.' }
      })
      case 'screenshot': {
        if (this.d.stage.minimized()) return fail(MINIMIZED)
        // the page beyond the viewport is a CDP capture, which needs the window to draw; the view or an element in it is Electron's own capture, which draws it even while the window is hidden
        return this.onPage(run, async (page, d) => ({
          text: 'Screenshot taken.',
          image: command.fullPage
            ? await d.fullShot(command.ref)
            : await viewShot(page.view.webContents, command.ref === null ? null : await d.elementRect(command.ref))
        }))
      }
      case 'evaluate': return this.onPage(run, async (_page, d) => ({ text: await d.evaluate(command.function, command.ref) }))
      case 'console': return this.onPage(run, async (_page, d) => ({
        text: d.consoleText(command.onlyErrors) || (command.onlyErrors ? 'No console errors.' : 'No console messages.')
      }))
      case 'network': return this.onPage(run, async (_page, d) => ({ text: d.networkText() || 'No requests.' }))
      case 'network_request': return this.onPage(run, async (_page, d) => ({
        text: await d.requestText(command.id, (url) => this.d.gate.isAllowed(this.tabId, this.profileId, url))
      }))
      case 'handle_dialog': return this.onPage(run, async (_page, d) => {
        await d.handleDialog(command.accept, command.promptText)
        return { text: `The next dialog will be ${command.accept ? 'accepted' : 'dismissed'}.` }
      })
      case 'tabs': return this.tabsOp(command.action, command.index, command.url, run)
    }
  }

  private async navigate(text: string, run: Run): Promise<PipeResponse> {
    const signal = run.signal
    // the URL is canonicalized once: the gate checks that string, and the page loads it
    const url = canonicalUrl(text)
    if (url === null || !isWebUrl(url)) return fail(REFUSED_URL)
    const denied = gateError(await this.checkGate(run, url, 'open'), url, 'open')
    if (denied !== null) return fail(denied)
    if (!this.opened) {
      this.opened = true
      this.d.openPanel()
    }
    signal.throwIfAborted()
    const page = this.currentPage()
    if (page === null) {
      const fresh = this.addPage(url)
      return this.reply(fresh, { text: navigatedText(await fresh.ready) }, run)
    }
    await page.ready
    // a command stopped or timed out while the page loaded does not navigate after its answer
    signal.throwIfAborted()
    try {
      const startsBefore = this.downloadStarts
      const load = await this.load(page, url)
      // a load that ends with no page committed and no error may be a download that has not started yet: its reply waits a moment for it
      if (!load.committed && load.failure === null && !page.closed && this.downloadStarts === startsBefore && page.hold === null && !page.heldLoad) {
        await this.downloadStarted(DOWNLOAD_START_LIMIT)
      }
      // a stopped command's late answer is not sent, and takes no footer news from the next command
      signal.throwIfAborted()
      return await this.reply(page, { text: navigatedText(load.failure) }, run)
    } catch (e) {
      if (page.closed) return fail(PAGE_CLOSED)
      throw e
    }
  }

  /** resolves when the next download of the tab starts, or after `ms` */
  private downloadStarted(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer)
        this.startWaiters.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, ms)
      this.startWaiters.add(wake)
    })
  }

  /** the tabs command: the list of pages, a new page, the current page changed, or a page closed */
  private async tabsOp(action: 'list' | 'new' | 'select' | 'close', index: number | null, url: string | null, run: Run): Promise<PipeResponse> {
    const signal = run.signal
    switch (action) {
      case 'list': return this.replyTab(this.listText(), run)
      case 'new': {
        if (this.pages.length >= MAX_PAGES) return fail(`At most ${MAX_PAGES} pages per tab.`)
        let href: string | null = null
        if (url !== null) {
          href = canonicalUrl(url)
          if (href === null || !isWebUrl(href)) return fail(REFUSED_URL)
          const denied = gateError(await this.checkGate(run, href, 'open'), href, 'open')
          if (denied !== null) return fail(denied)
        }
        signal.throwIfAborted()
        const page = this.addPage(href ?? 'about:blank')
        await page.ready
        signal.throwIfAborted()
        return this.reply(page, { text: 'Opened a new page.' }, run)
      }
      case 'select': {
        if (index === null || index >= this.pages.length) return fail(`There is no page ${index}.`)
        this.setCurrent(index)
        return this.replyTab(`Selected page ${index}.`, run)
      }
      case 'close': {
        if (index === null || index >= this.pages.length) return fail(`There is no page ${index}.`)
        this.removePage(index)
        return this.replyTab(`Closed page ${index}.`, run)
      }
    }
  }

  /** a page command: the current page's URL is checked first, then the command runs on the page's driver */
  private async onPage(run: Run, act: (page: Page, driver: PageDriver) => Promise<Done>): Promise<PipeResponse> {
    const signal = run.signal
    const page = this.currentPage()
    if (page === null) return fail(NO_PAGE)
    const url = urlNow(page) || 'about:blank'
    const denied = gateError(await this.checkGate(run, url, 'use'), url, 'use')
    if (denied !== null) return fail(denied)
    signal.throwIfAborted()
    try {
      const driver = await this.driverOf(page)
      // stopped or timed out while the page was being readied: the command answered already, so it does not act
      signal.throwIfAborted()
      // a first load that committed on another address while the page was readied is checked for that address too
      const now = urlNow(page) || 'about:blank'
      if (now !== url) {
        const refused = gateError(await this.checkGate(run, now, 'use'), now, 'use')
        if (refused !== null) return fail(refused)
        signal.throwIfAborted()
      }
      const requests = driver.requestCount()
      const checks = page.checks
      const out = await act(page, driver)
      // stopped while it acted: its late reply takes no footer news from the next command
      signal.throwIfAborted()
      // the page's round trip: a navigation the action requested reaches main around now, and it is seen before the reply
      await this.fence(page)
      // a request the action made, whose navigation main has not seen yet: the reply waits for that navigation to pass main's check
      if (driver.requestCount() !== requests && page.checks === checks) await this.navigationSettled(page, signal)
      signal.throwIfAborted()
      return await this.reply(page, out, run, true)
    } catch (e) {
      if (page.closed) return fail(PAGE_CLOSED)
      throw e
    }
  }

  /** the tool's text with the page's footer: the URL, the title and what changed since the last footer */
  private async reply(page: Page, out: Done, run: Run, fenced = false): Promise<PipeResponse> {
    try {
      await this.downloadsSettled()
      // the page's own navigation reaches main before the hold check, so a reply that is not fenced fences first
      if (!fenced && this.d.gate.isAllowed(this.tabId, this.profileId, urlNow(page))) await this.fence(page)
      // a navigation the page started during the command and the person has not allowed answers the command with its denial
      const denial = await this.paused(run, this.holdsDone())
      if (denial !== null) return fail(denial)
      const before = urlNow(page)
      const readable = this.d.gate.isAllowed(this.tabId, this.profileId, before)
      const titled = readable ? await this.titleOf(page) : undefined
      // a page that closed while the command ran has no footer to give
      if (page.closed) return fail(PAGE_CLOSED)
      // the page may have moved while its title was read: the footer then gives the address it has now and its own title, with no
      // news (the news may be the old page's); an address the tab may not use is masked
      const url = urlNow(page)
      const moved = url !== before
      const nowReadable = this.d.gate.isAllowed(this.tabId, this.profileId, url)
      const shown = readable && !moved
      const title = !moved ? titled : nowReadable ? await this.titleOf(page) : undefined
      const news = page.driver ? page.driver.takeFooterNews() : { newErrors: [], dialogs: [] }
      const answered = page.answered.splice(0)
      const footer: PageFooter = {
        url: nowReadable ? url : this.addressOf(url),
        title,
        newErrors: shown ? news.newErrors : [],
        dialogs: shown ? [...answered, ...news.dialogs] : [],
        downloads: this.downloads.splice(0),
        running: [...this.downloading].map((d) => d.name)
      }
      return { ok: true, info: withFooter(out.text, footer), ...(out.image ? { image: out.image } : {}) }
    } catch (e) {
      if (page.closed || page.view.webContents.isDestroyed()) return fail(PAGE_CLOSED)
      throw e
    }
  }

  /**
   * A command's footer waits for the downloads that started during the command and are still running, until the command's
   * deadline (DOWNLOAD_LIMIT after it started). A download that started before the command does not hold it.
   */
  private async downloadsSettled(): Promise<void> {
    const waiting = [...this.downloading].filter((d) => !this.downloadsBefore.has(d))
    if (waiting.length === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, this.downloadDeadline - Date.now()))
    })
    await Promise.race([Promise.all(waiting.map((d) => d.ended)), limit]).finally(() => clearTimeout(timer))
  }

  /**
   * A round trip on the page's debugger, before its news is taken: the page's console and dialog reports reach main on the
   * debugger's channel, after the input that caused them has been acknowledged, and the round trip lets them arrive.
   */
  private async fence(page: Page): Promise<void> {
    if (page.driver === null) return
    try {
      await page.driver.evaluate('() => 0', null)
    } catch {
      // the page is busy or gone: its news is taken as it is
    }
  }

  /** the page's title as its document has it now: the browser's own title can trail a script's change by a moment */
  private async titleOf(page: Page): Promise<string> {
    if (page.driver) {
      try {
        const title: unknown = JSON.parse(await page.driver.evaluate('() => document.title', null))
        if (typeof title === 'string') return title
      } catch {
        // the browser's title is the next best
      }
    }
    return page.view.webContents.getTitle()
  }

  /** a tab command's text: with the footer of the current page, when there is one */
  private replyTab(text: string, run: Run): Promise<PipeResponse> | PipeResponse {
    const page = this.currentPage()
    return page === null ? { ok: true, info: text } : this.reply(page, { text }, run)
  }

  /** `<i>: <title> — <url>` per page, `*` on the current one; a page on a site the tab may not use shows only the site */
  private listText(): string {
    if (this.pages.length === 0) return 'No pages open.'
    return this.pages.map((p, i) => {
      const url = urlNow(p)
      const shown = this.d.gate.isAllowed(this.tabId, this.profileId, url) ? `${p.view.webContents.getTitle()} — ${url}` : this.addressOf(url)
      return `${i === this.cur ? '* ' : '  '}${i}: ${shown}`
    }).join('\n')
  }

  /** the address of a page the tab may not use, as the list and the footers give it: its site only, or a local file's place */
  private addressOf(url: string): string {
    if (isFileUrl(url)) return LOCAL_FILE_MASK
    return `a page on ${siteOf(url) ?? 'another address'}`
  }

  /** the person's address: the current page goes there, or a new page opens there */
  private personNavigate(url: string): void {
    const page = this.currentPage()
    if (page === null) this.addPage(url, true)
    else void this.personLoadOf(page, () => page.view.webContents.loadURL(url))
  }

  private personHistory(type: 'back' | 'forward' | 'reload'): void {
    const page = this.currentPage()
    if (page === null) return
    const wc = page.view.webContents
    if (type === 'reload') void this.personLoadOf(page, () => wc.reload())
    else if (type === 'back' && wc.navigationHistory.canGoBack()) void this.personLoadOf(page, () => wc.navigationHistory.goBack())
    else if (type === 'forward' && wc.navigationHistory.canGoForward()) void this.personLoadOf(page, () => wc.navigationHistory.goForward())
  }

  /**
   * Another profile: the pages close and open again, with the same URLs, in the new profile. Pages the session saved and no one
   * has shown yet only change their profile: they are made in it when they come up.
   */
  setProfile(profileId: string): void {
    if (profileId === this.profileId || !this.d.profiles().some((p) => p.id === profileId)) return
    // what runs in the tab ends with its profile: the card goes, the holds and the commands stop. The grants stay, and control does not change
    this.d.gate.stop(this.tabId)
    this.stopHolds()
    this.stopRunning()
    if (this.pending !== null) {
      this.profileId = profileId
      this.changed()
      return
    }
    const urls = this.pages.map((p) => urlNow(p) || 'about:blank')
    const at = this.cur
    while (this.pages.length > 0) this.removePage(0)
    this.profileId = profileId
    for (const url of urls) this.addPage(url, true)
    if (at !== null && this.pages.length > 0) this.setCurrent(Math.min(at, this.pages.length - 1))
  }

  /** the pages the panel lists: the saved ones before they are made (their titles are not known yet), else the tab's pages */
  private shownPages(): BrowserPageView[] {
    if (this.pending !== null) return this.pending.pages.map((url) => ({ url, title: '', loading: false }))
    return this.pages.map((p) => ({ url: urlNow(p), title: p.view.webContents.getTitle(), loading: p.view.webContents.isLoading() }))
  }

  private currentPage(): Page | null {
    return this.cur === null ? null : this.pages[this.cur] ?? null
  }

  private setCurrent(index: number): void {
    this.cur = index
    this.d.stage.layout()
    this.changed()
  }

  /** a new page in the strip, made current: its view goes into the window, and its first load starts */
  private addPage(url: string, person = false): Page {
    this.d.configureSession(this.profileId)
    const view = new WebContentsView({
      webPreferences: {
        partition: partitionOf(this.profileId),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        disableDialogs: true
      }
    })
    const wc = view.webContents
    const page: Page = { view, firstUrl: url, driver: null, handlers: new Map(), ready: Promise.resolve(null), closed: false, attaching: null, personLoad: null, checks: 0, heldLoad: false, hold: null, settles: new Set(), answered: [] }
    wc.on('will-navigate', (e) => this.pageNavigates(page, e, 'navigate'))
    wc.on('will-redirect', (e) => this.pageNavigates(page, e, 'redirect'))
    wc.setWindowOpenHandler(({ url: to }) => {
      this.openFromPage(to)
      return { action: 'deny' }
    })
    wc.on('did-start-loading', () => this.changed())
    wc.on('did-stop-loading', () => this.changed())
    wc.on('page-title-updated', () => this.changed())
    wc.on('did-navigate', () => this.changed())
    wc.on('did-navigate-in-page', () => this.changed())
    // a page's beforeunload guard asks "Leave site?", and nobody answers it: the unload goes ahead, so the navigation happens
    wc.on('will-prevent-unload', (e) => {
      e.preventDefault()
      page.answered.push({ type: 'beforeunload', message: 'Leave site?', answer: 'OK' })
      if (page.answered.length > ANSWERED_LIMIT) page.answered.shift()
    })
    // about:blank, and an address Chromium starts without a network load, has no will-navigate that main decides on: their
    // start is main's decision. Any other start comes just before its will-navigate, and the command waits for that one
    // (a form's POST is decided there)
    wc.on('did-start-navigation', (details) => {
      const decidedAtStart = details.url === 'about:blank' || !isWebUrl(details.url)
      if (details.isMainFrame && !details.isSameDocument && decidedAtStart) this.navigationSeen(page)
    })
    // a key the app takes for its own shortcut never reaches the page: the window runs it.
    // Electron raises before-input-event only for the person's input, never for CDP Input.dispatchKeyEvent, and Claude's
    // press_key relies on that: its keys reach the page and no app action runs (the e2e test pins it)
    wc.on('before-input-event', (e, input) => {
      const action = appKeyFor(input, this.d.platform)
      if (action === null) return
      e.preventDefault()
      this.d.appKey(action)
    })
    wc.debugger.on('message', (_e, method, params) => {
      for (const fn of page.handlers.get(method) ?? []) fn(params)
    })
    wc.debugger.on('detach', () => {
      page.driver = null
    })
    wc.once('destroyed', () => this.pageGone(page))
    this.pages.push(page)
    this.cur = this.pages.length - 1
    this.d.stage.add(view)
    page.ready = this.prepare(page, url, person)
    this.changed()
    return page
  }

  /**
   * A page's window.open. While the tab holds its navigations (Claude's command runs in it, or has just ended), the popup is
   * Claude's doing: it joins the strip only when the gate allows the URL. Otherwise it is the person's own click, and it
   * joins without a card.
   */
  private openFromPage(url: string): void {
    if (!isWebUrl(url) || this.pages.length >= MAX_PAGES) return
    if (!this.holding()) {
      this.addPage(url)
      return
    }
    // the popup waits for its card under the same signal as a held navigation: Stop and a closed pipe end it
    const stop = this.newStop()
    this.d.gate.check(this.tabId, this.profileId, url, 'open', this.checkSignal(stop))
      .then((result) => {
        if (result === 'allowed' && !this.disposed && this.pages.length < MAX_PAGES) this.addPage(url)
      })
      .catch(() => undefined)
      .finally(() => this.stops.delete(stop))
  }

  /** the first load of a new page, then its debugger: the debugger attaches only after the first load */
  private async prepare(page: Page, url: string, person: boolean): Promise<string | null> {
    const { failure } = await this.load(page, url, person)
    try {
      await this.attach(page)
    } catch {
      // the page cannot be driven yet: a command tries again, and reports the error then
    }
    return failure
  }

  /** loads the URL and resolves when the load ends: the error text when the page did not load, and whether it committed */
  private load(page: Page, url: string, person = false): Promise<LoadResult> {
    const wc = page.view.webContents
    if (person) return this.personLoadOf(page, () => wc.loadURL(url))
    page.personLoad = null
    return loadEnd(wc, NAV_LIMIT, () => wc.loadURL(url))
  }

  /**
   * A load the person started in the page (the address field, back, forward, reload, a page the person opens): its redirects
   * are the person's own, and are never held. The flag ends with the load.
   */
  private personLoadOf(page: Page, start: () => void | Promise<unknown>): Promise<LoadResult> {
    // the person's load replaces the page's held navigation: its card goes, and the held address does not load over the page
    page.hold?.stop.abort()
    const token = Symbol('person load')
    page.personLoad = token
    return loadEnd(page.view.webContents, NAV_LIMIT, start).finally(() => {
      // a load that started after this one (Claude's, or the person's) owns the flag now
      if (page.personLoad === token) page.personLoad = null
    })
  }

  /** starts a navigation with `start` and resolves when it ends */
  private settleAfter(page: Page, start: () => void): Promise<LoadResult> {
    page.personLoad = null
    return loadEnd(page.view.webContents, NAV_LIMIT, start)
  }

  /**
   * Attaches the debugger to the page and turns on the domains its driver reads, once at a time per page: a command that
   * needs the driver while an attach runs (one a stopped command started, say) waits for that attach. The driver is kept
   * only once that has worked: a page whose enable failed or stalled is detached, and the next command attaches it again.
   */
  private attach(page: Page): Promise<PageDriver> {
    if (page.attaching === null) {
      page.attaching = this.attachNow(page).finally(() => {
        page.attaching = null
      })
    }
    return page.attaching
  }

  private async attachNow(page: Page): Promise<PageDriver> {
    const wc = page.view.webContents
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    page.handlers.clear()
    const cdp: Cdp = {
      send: (method, params) => wc.debugger.sendCommand(method, params),
      on: (event, fn) => {
        page.handlers.set(event, [...(page.handlers.get(event) ?? []), fn])
      }
    }
    const driver = new PageDriver(cdp)
    try {
      await withLimit(driver.enable(), ENABLE_LIMIT, 'The page did not answer in time; try again.')
    } catch (e) {
      if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
      throw e
    }
    page.driver = driver
    return driver
  }

  /** the page's driver: waits for its first load, and attaches again when the debugger has detached */
  private async driverOf(page: Page): Promise<PageDriver> {
    await page.ready
    return page.driver ?? this.attach(page)
  }

  /** takes a page out of the strip and the window, and keeps the current page in range */
  private dropPage(index: number): Page {
    const [page] = this.pages.splice(index, 1)
    page.closed = true
    // the navigation the page holds ends with it: its card is dropped and nothing loads
    page.hold?.stop.abort()
    if (this.cur !== null) {
      if (this.pages.length === 0) this.cur = null
      else if (index < this.cur) this.cur = this.cur - 1
      else if (index === this.cur) this.cur = Math.min(index, this.pages.length - 1)
    }
    this.d.stage.remove(page.view, this.tabId)
    return page
  }

  private removePage(index: number): void {
    destroy(this.dropPage(index))
    this.changed()
  }

  /** the page's contents destroyed themselves (a page that closes its window): the page leaves the strip, the tab goes on */
  private pageGone(page: Page): void {
    const index = this.pages.indexOf(page)
    if (index < 0 || this.disposed) return
    this.dropPage(index)
    this.changed()
  }

  private stopRunning(): void {
    for (const run of this.running) run.stop.abort()
  }

  /** the gate's answer for a URL; the run's time limit does not run while the person answers the card */
  private checkGate(run: Run, url: string, kind: 'open' | 'use'): Promise<GateResult> {
    return this.paused(run, this.d.gate.check(this.tabId, this.profileId, url, kind, run.signal))
  }

  /** waits for work that the person's answer ends: the time limit of this command, and only this one, is paused meanwhile */
  private async paused<T>(run: Run, work: Promise<T>): Promise<T> {
    run.limit.pause()
    try {
      return await work
    } finally {
      run.limit.resume()
    }
  }

  /** whether the tab holds Claude's navigations: while Claude's command runs, or HOLD_MS after it; never while the person has control */
  private holding(): boolean {
    return this.control !== 'person' && (this.running.size > 0 || Date.now() < this.holdUntil)
  }

  /** a stop for a card the tab waits for: Stop and the tab's end abort it, and it leaves the set when its card is decided */
  private newStop(): AbortController {
    const stop = new AbortController()
    this.stops.add(stop)
    return stop
  }

  /** the signal of a check made in the tab: its own stop, and the stops of the commands running now (a closed pipe ends one) */
  private checkSignal(stop: AbortController): AbortSignal {
    return AbortSignal.any([stop.signal, ...[...this.running].map((c) => c.signal)])
  }

  /**
   * A navigation the page starts itself: a click, a script, a redirect of any navigation. The person's own loads are never
   * held. While the tab holds Claude's navigations, or while a load allowed after a hold runs, an address the gate does not
   * allow is held: the page stays where it is until the person allows the site. A non-web address is refused outright.
   */
  private pageNavigates(page: Page, e: { url: string; isMainFrame: boolean; preventDefault(): void }, kind: 'navigate' | 'redirect'): void {
    if (!e.isMainFrame) return
    this.navigationSeen(page)
    if (!isWebUrl(e.url)) {
      e.preventDefault()
      return
    }
    // the person's own redirect is not held; a navigation of the page is the page's own, and ends the person's load's exemption
    if (kind === 'redirect' && page.personLoad !== null) return
    if (kind === 'navigate') page.personLoad = null
    if (this.control === 'person') return
    if (this.d.gate.isAllowed(this.tabId, this.profileId, e.url)) return
    if (!this.holding() && !page.heldLoad) return
    e.preventDefault()
    // a site the person denied, or whose card timed out, in this command is refused again, without a card
    const site = subjectOf(e.url)?.site ?? null
    const known = site === null ? undefined : this.deniedSites.get(site)
    if (known !== undefined) {
      this.denial ??= gateError(known, e.url, 'open')
      return
    }
    this.holdNavigation(page, e.url, kind)
  }

  /** a navigation of the page was decided by main (held, refused or let through): the commands that wait for it go on */
  private navigationSeen(page: Page): void {
    page.checks += 1
    for (const wake of [...page.settles]) wake()
  }

  /**
   * Waits for a navigation the page requested during a command to pass main's check or to become a hold. Bounded by the
   * command's stop and by NAV_SETTLE_LIMIT: a request that never reaches main does not hold the command.
   */
  private navigationSettled(page: Page, signal: AbortSignal): Promise<void> {
    // a command stopped meanwhile does not wait: no timer is left to outlive it
    if (signal.aborted) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        page.settles.delete(done)
        signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, NAV_SETTLE_LIMIT)
      page.settles.add(done)
      signal.addEventListener('abort', done, { once: true })
    })
  }

  /**
   * Holds a navigation of a page until the person answers the card of its site. One hold per page: a navigation that comes
   * while the card waits takes the place of the waiting address, and no second load follows.
   */
  private holdNavigation(page: Page, url: string, kind: 'navigate' | 'redirect'): void {
    if (page.hold !== null) {
      page.hold.url = url
      page.hold.kind = kind
      return
    }
    const stop = this.newStop()
    const hold: Hold = { page, url, kind, stop, done: Promise.resolve() }
    page.hold = hold
    this.holds.add(hold)
    hold.done = this.decideHeld(hold, this.checkSignal(stop))
      .catch(() => undefined)
      .finally(() => {
        this.holds.delete(hold)
        if (page.hold === hold) page.hold = null
        this.stops.delete(stop)
      })
  }

  /**
   * Decides a held navigation: the gate asks about its site (again when the address was replaced meanwhile), and the load
   * follows when the person allows it. The first answer that did not allow it is the command's answer, and a denied site
   * stays denied for the command. A form submission that the person allows is not sent again: Claude submits it again.
   */
  private async decideHeld(hold: Hold, signal: AbortSignal): Promise<void> {
    const { page } = hold
    let result: GateResult
    let asked: string
    for (;;) {
      asked = hold.url
      result = await this.d.gate.check(this.tabId, this.profileId, asked, 'open', signal)
      if (result !== 'allowed' || hold.url === asked) break
    }
    if (result !== 'allowed') {
      // the answer is about the address the card asked about, and its site stays refused for the command
      // keyed as the read in pageNavigates keys it: a local file by its path, a site by its host
      const site = subjectOf(asked)?.site ?? null
      if ((result === 'denied' || result === 'timeout') && site !== null) this.deniedSites.set(site, result)
      // a page closed while its card waited has no answer for its command: the command answers that the page closed
      if (!(result === 'stopped' && page.closed)) this.denial ??= gateError(result, asked, 'open')
      return
    }
    const url = hold.url
    if (hold.kind === 'navigate' && this.isFormPost(page, url)) {
      this.denial ??= formNotSent(isFileUrl(url) ? LOCAL_FILE_MASK : (siteOf(url) ?? 'this page'))
      return
    }
    // the decided hold is over: a redirect of the load it allows is a new navigation, and gets its own hold
    if (page.hold === hold) page.hold = null
    if (page.closed || this.disposed) return
    page.heldLoad = true
    try {
      await this.load(page, url)
    } finally {
      page.heldLoad = false
    }
  }

  /** whether the page's main frame asked for this URL as a form submission by POST, as the page's CDP session reported it: the request came long before the person's answer */
  private isFormPost(page: Page, url: string): boolean {
    const request = page.driver?.requestedNavigation() ?? null
    return request !== null && request.url === url && request.reason === 'formSubmissionPost'
  }

  /** waits until no navigation is held, and returns the denial of the first held navigation the person did not allow, or null */
  private async holdsDone(): Promise<string | null> {
    while (this.holds.size > 0) await [...this.holds][0].done
    return this.denial
  }

  /** Stop and the tab's end: every card that waits for a hold or a popup stops */
  private stopHolds(): void {
    for (const stop of this.stops) stop.abort()
    this.stops.clear()
  }

  private controlNow(): BrowserControl {
    if (this.control === 'person') return 'person'
    return this.running.size > 0 || Date.now() < this.lingerUntil ? 'claude' : 'idle'
  }

  /** tells the panel the state changed; a failure here never reaches a command, and the next change sends it again */
  private changed(): void {
    if (this.disposed) return
    try {
      this.d.changed()
    } catch {
      // the panel's state is sent again on the next change
    }
  }
}
