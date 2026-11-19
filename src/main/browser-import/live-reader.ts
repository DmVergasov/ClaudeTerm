import { join } from 'node:path'
import type { CdpSocket } from './cdp-socket'
import { fromChromium, type CdpCookie, type ImportedCookie } from './cookie-map'
import type { ImportSource } from './sources'

// Reads the cookies of the open profiles of a running Chromium browser, over its remote debugging endpoint. The
// reader only reads: it never sends a command that changes the browser or its windows.

export interface OpenProfile {
  contextId: string
  label: string
}

export interface LiveReadDeps {
  readFile(path: string): Promise<string> // <userDataDir>/DevToolsActivePort
  connect(url: string, onPending: () => void, signal: AbortSignal): Promise<CdpSocket>
  openSetupPage(): void // runs the browser with inspectUrl(kind)
  onStatus(s: { state: 'setup' } | { state: 'allow' }): void
  pickProfile(profiles: OpenProfile[]): Promise<string> // the person's choice (a contextId); only when more than one
  signal: AbortSignal
  retryMs?: number
  setupTimeoutMs?: number
}

const DEFAULT_RETRY_MS = 1000
const DEFAULT_SETUP_TIMEOUT_MS = 600_000
const COOKIE_LIMIT_MS = 30_000
// the socket is closed right after the detach, so a browser that is slow to answer it does not hold the read
const DETACH_LIMIT_MS = 2000
const LABEL_NAMES = 3
const LABEL_TITLE_CHARS = 30

/** The cookies of one open profile of the running browser, and how many of them were skipped. */
export async function readLiveCookies(
  source: ImportSource,
  nowS: number,
  deps: LiveReadDeps,
): Promise<{ cookies: ImportedCookie[]; skipped: number }> {
  const sock = await connectLive(source, deps)
  try {
    return await readFrom(sock, source, nowS, deps)
  } catch (e) {
    // a cancel shows as a cancel, whichever step it reached
    if (deps.signal.aborted) throw new Error('cancelled')
    throw e
  } finally {
    sock.close()
  }
}

async function readFrom(
  sock: CdpSocket,
  source: ImportSource,
  nowS: number,
  deps: LiveReadDeps,
): Promise<{ cookies: ImportedCookie[]; skipped: number }> {
  const targets = await sock.send<unknown>('Target.getTargets')
  const groups = groupPages(targets)
  if (groups.length === 0) throw new Error(`Open a window of the profile in ${source.browser} first.`)
  let group = groups[0]
  if (groups.length > 1) {
    const contextId = await untilCancelled(
      deps.pickProfile(groups.map((g) => ({ contextId: g.contextId, label: profileLabel(g.pages) }))),
      deps.signal,
    )
    throwIfCancelled(deps.signal)
    const chosen = groups.find((g) => g.contextId === contextId)
    if (!chosen) throw new Error(`Open a window of the profile in ${source.browser} first.`)
    group = chosen
  }
  const page = group.pages.find((p) => /^https?:\/\//i.test(p.url)) ?? group.pages[0]
  const cookies = await readCookiesOf(sock, page.targetId)

  let skipped = 0
  const out: ImportedCookie[] = []
  for (const c of cookies) {
    // a cookie that does not have the shape of a CDP cookie is skipped, as a damaged row is
    const cookie = isRecord(c) ? fromChromium(c as unknown as CdpCookie, nowS) : null
    if (cookie) out.push(cookie)
    else skipped++
  }
  return { cookies: out, skipped }
}

/** The label of a profile in the picker: its tab count and the names of up to three of its web pages. */
export function profileLabel(pages: { title: string; url: string }[]): string {
  const count = pages.length
  const names: string[] = []
  for (const p of pages) {
    if (names.length >= LABEL_NAMES) break
    if (!/^https?:\/\//i.test(p.url)) continue
    const title = shortTitle(p.title)
    if (title !== '' && !names.includes(title)) names.push(title)
  }
  const tabs = `${count} ${count === 1 ? 'tab' : 'tabs'}`
  return names.length > 0 ? `${tabs}: ${names.join(', ')}` : tabs
}

function shortTitle(title: string): string {
  const text = title.replace(/\s+/g, ' ').trim()
  const chars = [...text]
  return chars.length > LABEL_TITLE_CHARS ? `${chars.slice(0, LABEL_TITLE_CHARS - 1).join('')}…` : text
}

// Connects to the browser's endpoint. When the browser is not offering one, the setup page is opened once and the
// connection is retried until it comes, the read is cancelled, or the setup time runs out.
async function connectLive(source: ImportSource, deps: LiveReadDeps): Promise<CdpSocket> {
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS
  const setupTimeoutMs = deps.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS
  const started = Date.now()
  let setupShown = false
  for (;;) {
    throwIfCancelled(deps.signal)
    const url = await devToolsUrl(source.userDataDir, deps)
    if (url !== null) {
      const asked = { value: false }
      try {
        return await deps.connect(
          url,
          () => {
            asked.value = true
            deps.onStatus({ state: 'allow' })
          },
          deps.signal,
        )
      } catch (e) {
        const message = e instanceof Error ? e.message : ''
        if (message === 'timeout') throw new Error(`${source.browser} did not answer. Try the import again.`)
        if (message !== 'refused') throw e
        // the person was asked and the connection was dropped: a no is final, so there is no retry and no setup page
        if (asked.value) throw new Error(`The connection was not allowed in ${source.browser}.`)
      }
    }
    if (!setupShown) {
      throwIfCancelled(deps.signal)
      setupShown = true
      deps.openSetupPage()
      deps.onStatus({ state: 'setup' })
    }
    if (Date.now() - started >= setupTimeoutMs) {
      throw new Error(`${source.browser} did not offer a connection. Check that remote debugging is on.`)
    }
    await sleep(retryMs, deps.signal)
  }
}

// The WebSocket URL in DevToolsActivePort: line 1 the port, line 2 the browser's endpoint path. Anything else is
// "remote debugging not on", and the host is always 127.0.0.1.
async function devToolsUrl(userDataDir: string, deps: LiveReadDeps): Promise<string | null> {
  let text: string
  try {
    text = await deps.readFile(join(userDataDir, 'DevToolsActivePort'))
  } catch {
    return null
  }
  const [portLine = '', pathLine = ''] = text.split(/\r?\n/)
  if (!/^\d{1,5}$/.test(portLine)) return null
  const port = Number(portLine)
  if (port < 1 || port > 65535) return null
  if (!/^\/devtools\/browser\/[A-Za-z0-9._-]+$/.test(pathLine)) return null
  return `ws://127.0.0.1:${port}${pathLine}`
}

interface PageRef {
  targetId: string
  title: string
  url: string
}

interface Group {
  contextId: string
  pages: PageRef[]
}

// The page targets of each profile (browser context), in the order the profiles first appear.
function groupPages(targets: unknown): Group[] {
  const infos = isRecord(targets) && Array.isArray(targets.targetInfos) ? targets.targetInfos : []
  const groups = new Map<string, Group>()
  for (const t of infos) {
    if (!isRecord(t) || t.type !== 'page') continue
    if (typeof t.targetId !== 'string' || typeof t.browserContextId !== 'string') continue
    const page: PageRef = {
      targetId: t.targetId,
      title: typeof t.title === 'string' ? t.title : '',
      url: typeof t.url === 'string' ? t.url : '',
    }
    const group = groups.get(t.browserContextId) ?? { contextId: t.browserContextId, pages: [] }
    group.pages.push(page)
    groups.set(t.browserContextId, group)
  }
  return [...groups.values()]
}

// Attaches to one page of the profile, reads its cookies, and detaches. Only these four methods are sent.
async function readCookiesOf(sock: CdpSocket, targetId: string): Promise<unknown[]> {
  const attached = await sock.send<unknown>('Target.attachToTarget', { targetId, flatten: true })
  const sessionId = isRecord(attached) && typeof attached.sessionId === 'string' ? attached.sessionId : null
  if (sessionId === null) throw new Error('The browser did not attach to the page.')
  try {
    const answer = await sock.send<unknown>('Network.getAllCookies', {}, sessionId, COOKIE_LIMIT_MS)
    if (!isRecord(answer) || !Array.isArray(answer.cookies)) throw new Error('The browser did not return the cookies.')
    return answer.cookies
  } finally {
    try {
      await sock.send('Target.detachFromTarget', { sessionId }, undefined, DETACH_LIMIT_MS)
    } catch {
      // the socket is closed by the caller either way
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('cancelled')
}

// The work's answer, or 'cancelled' as soon as the signal aborts, even when the work itself never settles.
function untilCancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'))
      return
    }
    const onAbort = (): void => reject(new Error('cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
