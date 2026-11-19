import { REQUEST_ID_RE } from '../../shared/browser'
import type { PipeImage } from '../../shared/protocol'
import { siteOf } from '../../shared/site'
import { keyEvents } from './keys'
import type { KeyEvent } from './keys'
import { cutText, formatSnapshot } from './snapshot'
import type { AXNode } from './snapshot'

/** What the driver needs from a page's debugger: CDP commands and their events */
export interface Cdp {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>
  on(event: string, fn: (params: any) => void): void
}

/** The ref Claude used is no longer on the page: a new snapshot is needed */
export class StaleRefError extends Error {
  constructor() {
    super('The page changed; take a new snapshot.')
  }
}

/** A dialog the page opened, and the answer it got */
export interface DialogNews {
  type: string
  message: string
  answer: string
}

/**
 * Pages are made with disableDialogs, so no alert, confirm or prompt window ever shows. This shim, run in the
 * page, answers them from the answer Claude armed with handleDialog and reports each one through console.debug.
 */
export const DIALOG_SHIM = `(() => {
  if (window.__ctDialogShim) return
  Object.defineProperty(window, '__ctDialogShim', { value: true })
  const report = (type, message, answer) =>
    console.debug('__ct_dialog__' + JSON.stringify({ type, message: String(message ?? ''), answer }))
  const take = () => { const a = window.__ctDialog; window.__ctDialog = undefined; return a }
  window.alert = function (m) { take(); report('alert', m, 'closed') }
  window.confirm = function (m) { const a = take(); const ok = !!(a && a.accept); report('confirm', m, ok ? 'OK' : 'Cancel'); return ok }
  window.prompt = function (m, d) {
    const a = take()
    const ok = !!(a && a.accept)
    report('prompt', m, ok ? 'OK' : 'Cancel')
    return ok ? String(a.text ?? d ?? '') : null
  }
})()`

/** The script that selects the options of a select element whose value or label is wanted */
const SELECT_FN = `function (wanted) {
  if (!(this instanceof HTMLSelectElement)) throw new Error('The element is not a select.')
  for (const option of Array.from(this.options)) option.selected = wanted.includes(option.value) || wanted.includes(option.label)
  this.dispatchEvent(new Event('input', { bubbles: true }))
  this.dispatchEvent(new Event('change', { bubbles: true }))
  return Array.from(this.selectedOptions, (option) => option.value)
}`

/** the CDP error messages that mean the node or its context is gone from the page */
const GONE_NODE = /No node|Could not find node|Node with given id|Cannot find context|does not belong|Could not compute box model/

const BODY_TEXT = 'document.body ? document.body.innerText : ""'
const DIALOG_PREFIX = '__ct_dialog__'
const ENTER = keyEvents('Enter') ?? []

const RING_SIZE = 500
const LINE_LIMIT = 2000
const URL_LIMIT = 500
const BODY_LIMIT = 100_000
const TEXT_LIMIT = 50_000
const ERROR_LIMIT = 2000
const DIALOG_NEWS_LIMIT = 20
const SCREENSHOT_LIMIT = 4_000_000
const SCREENSHOT_TIMEOUT = 10_000
const WAIT_POLL = 250
const WAIT_LIMIT = 60_000

type Obj = Record<string, unknown>

interface ConsoleLine { line: string; error: boolean }

interface NetworkEntry {
  id: string
  requestId: string
  method: string
  url: string
  /** every URL the request went through under its requestId (the redirects' hops and the final response's), in full: CDP keeps one body for them all */
  chain: string[]
  type?: string
  requestHeaders: Record<string, string>
  requestBody?: string
  responseHeaders: Record<string, string>
  status?: number
  errorText?: string
}

interface Layout {
  cssVisualViewport: { clientWidth: number; clientHeight: number; pageX: number; pageY: number }
  cssContentSize: { width: number; height: number }
}

interface Clip { x: number; y: number; width: number; height: number; scale: number }

interface EvalResult {
  result?: { value?: unknown }
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

function obj(v: unknown): Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {}
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** the event's value of a console argument: its value, else its description, else its type */
function argText(arg: unknown): string {
  const a = obj(arg)
  if (typeof a.value === 'string' || typeof a.value === 'number' || typeof a.value === 'boolean') return String(a.value)
  if (a.value === null) return 'null'
  if (typeof a.description === 'string') return a.description
  return str(a.type)
}

function headersOf(v: unknown): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(obj(v))) {
    if (typeof value === 'string') headers[name] = cutText(value, LINE_LIMIT)
  }
  return headers
}

/** a list kept at most RING_SIZE long: the oldest entries go first */
function pushRing<T>(list: T[], item: T): void {
  list.push(item)
  if (list.length > RING_SIZE) list.shift()
}

function networkLine(e: NetworkEntry): string {
  const state = e.errorText !== undefined ? `failed: ${e.errorText}` : e.status !== undefined ? String(e.status) : 'pending'
  return `${e.id} ${e.method} ${e.url} → ${state}${e.type ? ` ${e.type}` : ''}`
}

function headerLines(headers: Record<string, string>): string[] {
  const lines = Object.entries(headers).map(([name, value]) => `- ${name}: ${value}`)
  return lines.length > 0 ? lines : ['(none)']
}

/** the value of a Runtime result; an exception the script threw is an Error with its description */
function resultValue(r: EvalResult | undefined): unknown {
  const details = r?.exceptionDetails
  if (details) {
    const message = [details.exception?.description, details.text].find((s) => typeof s === 'string' && s !== '')
    throw new Error(cutText(message ?? 'The script threw an error.', ERROR_LIMIT))
  }
  return r?.result?.value
}

function cancelled(): Error {
  return new Error('The wait was cancelled.')
}

/** throws the cancelled error when the command's signal has stopped: a step does not act after its command answered */
function stopCheck(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelled()
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(cancelled())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** work that gives up with `message` when it takes longer than `ms` */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([work, expired]).finally(() => clearTimeout(timer))
}

/** work that stops at once with the cancelled error when the signal aborts while it is pending */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop = (): void => {}
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(cancelled())
    signal.addEventListener('abort', onAbort, { once: true })
    stop = () => signal.removeEventListener('abort', onAbort)
  })
  return Promise.race([work, aborted]).finally(stop)
}

function timeoutMessage(text: string | null, textGone: string | null): string {
  if (text !== null) return `Timed out waiting for "${text}".`
  if (textGone !== null) return `Timed out waiting for "${textGone}" to disappear.`
  return 'Timed out waiting.'
}

/**
 * Whether the page may read one hop's body: a data: URL always (the page holds its own data), a blob: URL when the origin it
 * names is readable (`blob:https://site/uuid` reads as `https://site/`), and any other URL when `readable` allows it.
 */
function hopReadable(url: string, readable: (url: string) => boolean): boolean {
  if (url.startsWith('data:')) return true
  if (url.startsWith('blob:')) {
    let origin: string
    try {
      origin = new URL(url.slice('blob:'.length)).origin
    } catch {
      return false
    }
    return origin !== 'null' && readable(`${origin}/`)
  }
  return readable(url)
}

/**
 * Runs the browser commands of one page on its CDP session and keeps what the page reports:
 * the console and network lists, the dialogs and the refs of the last snapshot.
 */
export class PageDriver {
  private readonly cdp: Cdp
  private refs = new Map<string, number>()
  private consoleLines: ConsoleLine[] = []
  private newErrors: string[] = []
  private networkEntries: NetworkEntry[] = []
  private networkByRequest = new Map<string, NetworkEntry>()
  private networkCount = 0
  private dialogNews: DialogNews[] = []
  /** the id of the page's main frame: its requested navigations are the ones kept */
  private mainFrameId: string | null = null
  /** the last navigation the main frame asked for, and why: a form POST shows as formSubmissionPost */
  private requested: { url: string; reason: string } | null = null
  /** how many navigations the main frame has asked for: an action that asks for one waits for it before it answers */
  private requests = 0

  constructor(cdp: Cdp) {
    this.cdp = cdp
    cdp.on('Page.frameNavigated', (p: unknown) => this.onFrameNavigated(p))
    cdp.on('Page.frameRequestedNavigation', (p: unknown) => this.onRequestedNavigation(p))
    cdp.on('Runtime.consoleAPICalled', (p: unknown) => this.onConsoleCall(p))
    cdp.on('Runtime.exceptionThrown', (p: unknown) => {
      const details = obj(obj(p).exceptionDetails)
      this.addConsole('error', str(obj(details.exception).description) || str(details.text) || 'Uncaught error')
    })
    cdp.on('Log.entryAdded', (p: unknown) => {
      const entry = obj(obj(p).entry)
      this.addConsole(str(entry.level, 'info'), str(entry.text))
    })
    cdp.on('Network.requestWillBeSent', (p: unknown) => this.onRequest(p))
    cdp.on('Network.responseReceived', (p: unknown) => this.onResponse(p))
    cdp.on('Network.loadingFailed', (p: unknown) => {
      const params = obj(p)
      const entry = typeof params.requestId === 'string' ? this.networkByRequest.get(params.requestId) : undefined
      if (entry) entry.errorText = str(params.errorText, 'failed')
    })
    cdp.on('Page.javascriptDialogOpening', (p: unknown) => {
      const params = obj(p)
      const type = str(params.type, 'alert')
      // a beforeunload guard is the tab's: the tab answers it and reports it (TabBrowser), so the driver neither records nor answers it
      if (type === 'beforeunload') return
      this.addDialog({ type, message: str(params.message), answer: type === 'alert' ? 'closed' : 'Cancel' })
    })
  }

  /** Turns on the CDP domains the driver reads, then installs the dialog shim in new and current documents */
  async enable(): Promise<void> {
    for (const domain of ['Page', 'Runtime', 'Network', 'Log', 'DOM', 'Accessibility']) {
      await this.cdp.send(`${domain}.enable`)
    }
    const tree = await this.cdp.send<{ frameTree?: { frame?: { id?: unknown } } }>('Page.getFrameTree')
    const mainId = obj(obj(obj(tree).frameTree).frame).id
    if (typeof mainId === 'string') this.mainFrameId = mainId
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: DIALOG_SHIM })
    await this.cdp.send('Runtime.evaluate', { expression: DIALOG_SHIM })
  }

  /** The page's accessibility tree as text; its refs replace the ones before */
  async snapshot(): Promise<string> {
    const tree = await this.cdp.send<{ nodes?: AXNode[] }>('Accessibility.getFullAXTree')
    const snap = formatSnapshot(Array.isArray(tree?.nodes) ? tree.nodes : [])
    this.refs = snap.refs
    return snap.text
  }

  /**
   * A click at the element's centre. A stopped `signal` is seen before a press, never between a press and its release:
   * a button that went down is always let up.
   */
  async click(ref: string, button: 'left' | 'right' | 'middle', doubleClick: boolean, signal?: AbortSignal): Promise<void> {
    const point = await this.centre(ref)
    stopCheck(signal)
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    const counts = doubleClick ? [1, 2] : [1]
    for (const clickCount of counts) {
      const at = { x: point.x, y: point.y, button, clickCount }
      stopCheck(signal)
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at })
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at })
    }
  }

  /**
   * Focuses the element and types the text, all at once or a key at a time; then Enter when submit is set. A stopped
   * `signal` ends it before the next character.
   */
  async type(ref: string, text: string, submit: boolean, slowly: boolean, signal?: AbortSignal): Promise<void> {
    const id = this.nodeOf(ref)
    await this.nodeCall('DOM.focus', id)
    if (slowly) {
      for (const ch of Array.from(text)) {
        stopCheck(signal)
        const events = keyEvents(ch)
        if (events) await this.dispatchKeys(events, signal)
        else await this.cdp.send('Input.insertText', { text: ch })
      }
    } else if (text !== '') {
      stopCheck(signal)
      await this.cdp.send('Input.insertText', { text })
    }
    if (submit) await this.dispatchKeys(ENTER, signal)
  }

  async pressKey(combo: string, signal?: AbortSignal): Promise<void> {
    const events = keyEvents(combo)
    if (!events) throw new Error(`Unknown key: ${combo}`)
    await this.dispatchKeys(events, signal)
  }

  async hover(ref: string): Promise<void> {
    const point = await this.centre(ref)
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  }

  /** Selects the options whose value or label is one of `values`; returns the values now selected */
  async selectOption(ref: string, values: string[]): Promise<string[]> {
    const resolved = await this.nodeCall<{ object?: { objectId?: unknown } }>('DOM.resolveNode', this.nodeOf(ref))
    const objectId = resolved?.object?.objectId
    if (typeof objectId !== 'string') throw new StaleRefError()
    const result = await this.cdp.send<EvalResult>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: SELECT_FN,
      arguments: [{ value: values }],
      returnByValue: true,
    })
    const selected = resultValue(result)
    return Array.isArray(selected) ? selected.filter((v): v is string => typeof v === 'string') : []
  }

  /** A mouse wheel turn at the element's centre, or at the centre of the visible page when no ref is given */
  async scroll(ref: string | null, direction: 'up' | 'down' | 'left' | 'right', amount: number, signal?: AbortSignal): Promise<void> {
    const point = ref === null ? await this.viewportCentre() : await this.centre(ref)
    stopCheck(signal)
    const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0
    const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX, deltaY })
  }

  /**
   * Waits until the page text has `text` and lacks `textGone`, and `time` seconds have passed; each part that is
   * absent does not wait. Gives up after 60 s; an aborted signal stops it at once.
   */
  async waitFor(text: string | null, textGone: string | null, time: number | null, signal: AbortSignal): Promise<void> {
    const start = Date.now()
    const seconds = time === null ? null : Math.min(time, WAIT_LIMIT / 1000)
    for (;;) {
      if (signal.aborted) throw cancelled()
      const elapsed = Date.now() - start
      const timeDone = seconds === null || elapsed >= seconds * 1000
      const textDone = text === null && textGone === null ? true : await this.pollText(text, textGone, start, signal)
      if (timeDone && textDone) return
      if (elapsed >= WAIT_LIMIT) throw new Error(timeoutMessage(text, textGone))
      await sleep(WAIT_POLL, signal)
    }
  }

  /** one read of the page text, given the time left of the wait and stopped by the signal */
  private pollText(text: string | null, textGone: string | null, start: number, signal: AbortSignal): Promise<boolean> {
    const left = Math.max(WAIT_LIMIT - (Date.now() - start), 0)
    const read = withTimeout(this.textMatches(text, textGone), left, timeoutMessage(text, textGone))
    return untilAborted(read, signal)
  }

  /** The page as a PNG, or as a JPEG when the PNG is too long to send; the element's box or the whole page when asked */
  async screenshot(fullPage: boolean, ref: string | null): Promise<PipeImage> {
    let clip: Clip | undefined
    if (ref !== null) clip = await this.elementClip(ref)
    else if (fullPage) {
      const layout = await this.layout()
      clip = { x: 0, y: 0, width: layout.cssContentSize.width, height: layout.cssContentSize.height, scale: 1 }
    }
    const params: Record<string, unknown> = { format: 'png', captureBeyondViewport: fullPage }
    if (clip) params.clip = clip
    const png = await this.capture(params)
    if (png.length <= SCREENSHOT_LIMIT) return { data: png, mimeType: 'image/png' }
    const jpeg = await this.capture({ ...params, format: 'jpeg', quality: 70 })
    return { data: jpeg, mimeType: 'image/jpeg' }
  }

  /** The function run in the page (given the element when a ref is set), its JSON result cut to 50 000 characters */
  async evaluate(fn: string, ref: string | null): Promise<string> {
    let result: EvalResult
    if (ref === null) {
      result = await this.cdp.send<EvalResult>('Runtime.evaluate', {
        expression: `(${fn}\n)()`,
        awaitPromise: true,
        returnByValue: true,
      })
    } else {
      const resolved = await this.nodeCall<{ object?: { objectId?: unknown } }>('DOM.resolveNode', this.nodeOf(ref))
      const objectId = resolved?.object?.objectId
      if (typeof objectId !== 'string') throw new StaleRefError()
      result = await this.cdp.send<EvalResult>('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: fn,
        arguments: [{ objectId }],
        awaitPromise: true,
        returnByValue: true,
      })
    }
    const value = resultValue(result)
    return cutText(JSON.stringify(value) ?? 'undefined', TEXT_LIMIT)
  }

  /** The console lines of the page, `[level] text` each; only the errors when onlyErrors is set */
  consoleText(onlyErrors: boolean): string {
    return this.consoleLines.filter((l) => !onlyErrors || l.error).map((l) => l.line).join('\n')
  }

  /** The requests of the page, one line each */
  networkText(): string {
    return this.networkEntries.map(networkLine).join('\n')
  }

  /**
   * One request's line, its request and response headers and its response body (cut to 100 000 characters). The body is read
   * only when `readable` allows the request's URL: CDP returns the body of an opaque response the page itself could not read.
   * The driver listens to no *ExtraInfo events, so the Cookie and Set-Cookie headers are never shown: keep it that way.
   */
  async requestText(id: string, readable: (url: string) => boolean): Promise<string> {
    const entry = REQUEST_ID_RE.test(id) ? this.networkEntries.find((e) => e.id === id) : undefined
    if (!entry) throw new Error(`No request ${id} in the list.`)
    // the body is the last hop's, and CDP keeps it under the requestId all hops share: every hop must be readable
    const unreadable = entry.chain.find((url) => !hopReadable(url, readable))
    const body = unreadable === undefined ? await this.responseBody(entry.requestId) : `(not shown: ${siteOf(unreadable) ?? 'another address'} is not allowed in this tab)`
    return [
      networkLine(entry),
      '### Request headers',
      ...headerLines(entry.requestHeaders),
      '### Request body',
      entry.requestBody ?? '(none)',
      '### Response headers',
      ...headerLines(entry.responseHeaders),
      '### Response body',
      body,
    ].join('\n')
  }

  /** The errors and the dialogs since the last call: each is given once */
  takeFooterNews(): { newErrors: string[]; dialogs: DialogNews[] } {
    const news = { newErrors: this.newErrors, dialogs: this.dialogNews }
    this.newErrors = []
    this.dialogNews = []
    return news
  }

  /** Arms the answer of the next dialog of the main frame: OK or Cancel, and the text for a prompt */
  async handleDialog(accept: boolean, promptText: string | null): Promise<void> {
    await this.cdp.send('Runtime.evaluate', { expression: `window.__ctDialog = ${JSON.stringify({ accept, text: promptText })}` })
  }

  private nodeOf(ref: string): number {
    const id = this.refs.get(ref)
    if (id === undefined) throw new StaleRefError()
    return id
  }

  /** a DOM command on a node: a CDP error saying the node is gone is a stale ref; any other error is passed on */
  private async nodeCall<T = unknown>(method: string, backendNodeId: number): Promise<T> {
    try {
      return await this.cdp.send<T>(method, { backendNodeId })
    } catch (e) {
      if (e instanceof Error && GONE_NODE.test(e.message)) throw new StaleRefError()
      throw e
    }
  }

  /** the content quad of an element, after it is scrolled into view: eight numbers, four corners */
  private async boxOf(ref: string): Promise<number[]> {
    const id = this.nodeOf(ref)
    await this.nodeCall('DOM.scrollIntoViewIfNeeded', id)
    const result = await this.nodeCall<{ model?: { content?: unknown } }>('DOM.getBoxModel', id)
    const content = result?.model?.content
    if (!Array.isArray(content) || content.length !== 8 || !content.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new StaleRefError()
    }
    return content as number[]
  }

  private async centre(ref: string): Promise<{ x: number; y: number }> {
    const q = await this.boxOf(ref)
    return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 }
  }

  private async viewportCentre(): Promise<{ x: number; y: number }> {
    const viewport = (await this.layout()).cssVisualViewport
    return { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }
  }

  private async layout(): Promise<Layout> {
    return this.cdp.send<Layout>('Page.getLayoutMetrics')
  }

  /** the element's box in page coordinates, so a clip of the document captures it */
  private async elementClip(ref: string): Promise<Clip> {
    const q = await this.boxOf(ref)
    const xs = [q[0], q[2], q[4], q[6]]
    const ys = [q[1], q[3], q[5], q[7]]
    const viewport = (await this.layout()).cssVisualViewport
    const x0 = Math.min(...xs)
    const y0 = Math.min(...ys)
    return {
      x: x0 + viewport.pageX,
      y: y0 + viewport.pageY,
      width: Math.max(...xs) - x0,
      height: Math.max(...ys) - y0,
      scale: 1,
    }
  }

  private async capture(params: Record<string, unknown>): Promise<string> {
    const result = await withTimeout(
      this.cdp.send<{ data?: unknown }>('Page.captureScreenshot', params),
      SCREENSHOT_TIMEOUT,
      'The page did not paint in time; try again.',
    )
    if (typeof result?.data !== 'string') throw new Error('The screenshot came back empty.')
    return result.data
  }

  private async textMatches(text: string | null, textGone: string | null): Promise<boolean> {
    const result = await this.cdp.send<EvalResult>('Runtime.evaluate', { expression: BODY_TEXT, returnByValue: true })
    const body = str(resultValue(result))
    return (text === null || body.includes(text)) && (textGone === null || !body.includes(textGone))
  }

  /**
   * A key or a combo, as keyEvents builds it: every key-down comes with its key-up, modifiers released last. A stopped
   * `signal` is seen before the first event only, so a key that went down is always let up.
   */
  private async dispatchKeys(events: KeyEvent[], signal?: AbortSignal): Promise<void> {
    stopCheck(signal)
    for (const event of events) await this.cdp.send('Input.dispatchKeyEvent', { ...event })
  }

  private async responseBody(requestId: string): Promise<string> {
    try {
      const r = await this.cdp.send<{ body?: unknown; base64Encoded?: unknown }>('Network.getResponseBody', { requestId })
      if (typeof r?.body !== 'string') return '(none)'
      if (r.base64Encoded === true) return `(binary, ${r.body.length} characters in base64; not shown)`
      return cutText(r.body, BODY_LIMIT)
    } catch {
      return '(not available)'
    }
  }

  private onFrameNavigated(p: unknown): void {
    const frame = obj(obj(p).frame)
    // a subframe's navigation leaves the page's lists and refs alone
    if (Object.keys(frame).length === 0 || (frame.parentId !== undefined && frame.parentId !== null)) return
    if (typeof frame.id === 'string') this.mainFrameId = frame.id
    // the navigation that commits is the one asked for: the request it made is no longer waiting
    this.requested = null
    this.refs = new Map()
    this.consoleLines = []
    this.newErrors = []
    this.dialogNews = []
    this.networkEntries = []
    this.networkByRequest = new Map()
  }

  /** a navigation the main frame asks for (a click, a form, a script); a subframe's request is not kept */
  private onRequestedNavigation(p: unknown): void {
    const params = obj(p)
    if (this.mainFrameId === null || params.frameId !== this.mainFrameId) return
    // a request for a new tab, a new window or a download starts no navigation of this page
    if (params.disposition !== undefined && params.disposition !== 'currentTab') return
    this.requested = { url: str(params.url), reason: str(params.reason) }
    this.requests += 1
  }

  /** the main frame's requests so far */
  requestCount(): number {
    return this.requests
  }

  /** the main frame's last requested navigation, or null when it asked for none */
  requestedNavigation(): { url: string; reason: string } | null {
    return this.requested
  }

  private onConsoleCall(p: unknown): void {
    const params = obj(p)
    const args = Array.isArray(params.args) ? params.args : []
    const first = obj(args[0]).value
    if (typeof first === 'string' && first.startsWith(DIALOG_PREFIX)) {
      this.onShimDialog(first.slice(DIALOG_PREFIX.length))
      return
    }
    this.addConsole(str(params.type, 'log'), args.map(argText).join(' '))
  }

  /** a dialog the shim reported; a line that does not parse or lacks a text field is ignored */
  private onShimDialog(json: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      return
    }
    const d = obj(parsed)
    if (typeof d.type !== 'string' || typeof d.message !== 'string' || typeof d.answer !== 'string') return
    this.addDialog({ type: d.type, message: d.message, answer: d.answer })
  }

  private addDialog(d: DialogNews): void {
    this.dialogNews.push({ type: d.type, message: cutText(d.message, LINE_LIMIT), answer: d.answer })
    if (this.dialogNews.length > DIALOG_NEWS_LIMIT) this.dialogNews.shift()
  }

  private addConsole(level: string, text: string): void {
    const line = `[${level}] ${cutText(text, LINE_LIMIT)}`
    const error = level === 'error'
    pushRing(this.consoleLines, { line, error })
    if (error) {
      this.newErrors.push(line)
      if (this.newErrors.length > RING_SIZE) this.newErrors.shift()
    }
  }

  private onRequest(p: unknown): void {
    const params = obj(p)
    if (typeof params.requestId !== 'string') return
    const request = obj(params.request)
    const redirect = obj(params.redirectResponse)
    const previous = this.networkByRequest.get(params.requestId)
    if (previous && typeof redirect.status === 'number') previous.status = redirect.status
    this.networkCount++
    const fullUrl = str(request.url)
    // a redirect's hop shares the requestId of the hops before it: they share one chain
    const chain = previous ? previous.chain : []
    chain.push(fullUrl)
    const entry: NetworkEntry = {
      id: `r${this.networkCount}`,
      requestId: params.requestId,
      method: str(request.method, 'GET'),
      url: cutText(fullUrl, URL_LIMIT),
      chain,
      type: optStr(params.type),
      requestHeaders: headersOf(request.headers),
      requestBody: typeof request.postData === 'string' ? cutText(request.postData, BODY_LIMIT) : undefined,
      responseHeaders: {},
    }
    this.networkByRequest.set(params.requestId, entry)
    this.networkEntries.push(entry)
    if (this.networkEntries.length > RING_SIZE) {
      const gone = this.networkEntries.shift()
      if (gone && this.networkByRequest.get(gone.requestId) === gone) this.networkByRequest.delete(gone.requestId)
    }
  }

  private onResponse(p: unknown): void {
    const params = obj(p)
    const entry = typeof params.requestId === 'string' ? this.networkByRequest.get(params.requestId) : undefined
    if (!entry) return
    const response = obj(params.response)
    if (typeof response.status === 'number') entry.status = response.status
    // the final response's URL is the last hop of the chain, unless the request was not redirected to it
    const finalUrl = str(response.url)
    if (finalUrl !== '' && entry.chain[entry.chain.length - 1] !== finalUrl) entry.chain.push(finalUrl)
    entry.responseHeaders = headersOf(response.headers)
    if (entry.type === undefined) entry.type = optStr(params.type)
  }
}
