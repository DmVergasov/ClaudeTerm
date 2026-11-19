import { execFile, type ChildProcess, type spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { CdpPipe, CdpTimeoutError } from './cdp-pipe'
import { fromChromium, type CdpCookie, type ImportedCookie } from './cookie-map'
import type { BrowserBinary, ImportSource } from './sources'
import { TEMP_PREFIX, copyIfExists, makePrivateTemp, removeTemp } from './temp-copy'

// The time the browser has to answer Storage.getCookies, and the time it has to exit after Browser.close.
const CALL_LIMIT_MS = 10_000
const EXIT_LIMIT_MS = 3_000
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_RETRY_MS = 1_000
// The codes a browser that holds its cookie file open gives for it.
const HELD_CODES = ['EBUSY', 'EPERM', 'EACCES']
const SIDECARS = ['Cookies-journal', 'Cookies-wal', 'Cookies-shm']

export interface ChromiumReadDeps {
  spawn: typeof spawn
  copyFile(src: string, dst: string): Promise<void> // rejects with code EBUSY/EPERM while the browser holds the file
  onWaiting(): void // the browser holds its cookie file: ask the person to close it
  signal: AbortSignal
  retryMs?: number // default 1000
  timeoutMs?: number // default 120_000, counted after the copy is made
}

interface RunningBrowser {
  child: ChildProcess
  pipe: CdpPipe
  exited: Promise<void>
  hasExited(): boolean
}

/**
 * The cookies of a Chromium profile, read by a browser started on a private copy of the profile. The copy is
 * deleted on every path, and the browser is ended on every path it was started on.
 */
export async function readChromiumCookies(
  source: ImportSource,
  nowS: number,
  deps: ChromiumReadDeps,
): Promise<{ cookies: ImportedCookie[]; skipped: number }> {
  const binary = source.binary
  if (!binary) throw new Error(notInstalled(source.browser))
  const tmp = await makePrivateTemp(TEMP_PREFIX)
  let running: RunningBrowser | null = null
  try {
    await copyProfile(source, tmp, deps)
    running = startBrowser(binary, source, tmp, deps)
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const list = await within(requestCookies(running, source.browser, timeoutMs), timeoutMs, deps.signal, new Error(`${source.browser} did not answer in time`))
    return mapCookies(list, nowS)
  } finally {
    if (running) await endBrowser(running)
    await removeTemp(tmp)
  }
}

function notInstalled(browser: string): string {
  return `${browser} is not installed where ClaudeTerm looks for it`
}

// The profile's Local State and its cookie files, into the private folder with the layout the browser expects.
async function copyProfile(source: ImportSource, tmp: string, deps: ChromiumReadDeps): Promise<void> {
  const netDir = join(tmp, basename(source.profileDir), 'Network')
  await mkdir(netDir, { recursive: true })
  await copyIfExists(join(source.userDataDir, 'Local State'), join(tmp, 'Local State'))
  await copyCookieFile(join(source.profileDir, 'Network', 'Cookies'), join(netDir, 'Cookies'), source.browser, deps)
  for (const name of SIDECARS) await copyIfExists(join(source.profileDir, 'Network', name), join(netDir, name))
}

// The cookie file is the one a running browser holds: wait for it to be released, then copy.
async function copyCookieFile(src: string, dst: string, browser: string, deps: ChromiumReadDeps): Promise<void> {
  let waited = false
  for (;;) {
    if (deps.signal.aborted) throw new Error('cancelled')
    try {
      await deps.copyFile(src, dst)
      return
    } catch (e) {
      if (hasCode(e, 'ENOENT')) throw new Error(`${browser} has no cookies in this profile`)
      if (!HELD_CODES.some((code) => hasCode(e, code))) throw e
      if (!waited) {
        waited = true
        deps.onWaiting()
      }
      await sleep(deps.retryMs ?? DEFAULT_RETRY_MS, deps.signal)
    }
  }
}

// The window switch: on Windows a headless browser; on macOS and Linux a normal browser with no window, which
// unlocks its key store as the person's own browser does.
function windowSwitch(): string {
  return process.platform === 'win32' ? '--headless=new' : '--no-startup-window'
}

function startBrowser(binary: BrowserBinary, source: ImportSource, tmp: string, deps: ChromiumReadDeps): RunningBrowser {
  const args = [
    ...binary.args,
    `--user-data-dir=${tmp}`,
    `--profile-directory=${basename(source.profileDir)}`,
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    windowSwitch(),
  ]
  const child = deps.spawn(binary.file, args, {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...binary.env },
    windowsHide: true,
  })
  let exitedFlag = false
  const exited = new Promise<void>((resolve) => {
    const done = (): void => {
      exitedFlag = true
      resolve()
    }
    child.once('exit', done)
    // a browser that could not be started emits 'error' and never 'exit'
    child.on('error', () => {
      if (child.pid === undefined) done()
    })
  })
  // a file that does not exist or cannot run gives no pid at once
  if (child.pid === undefined) throw new Error(notInstalled(source.browser))
  const write = child.stdio[3] as NodeJS.WritableStream | null | undefined
  const read = child.stdio[4] as NodeJS.ReadableStream | null | undefined
  if (!write || !read) {
    child.kill('SIGKILL')
    throw new Error(`${source.browser} could not be started`)
  }
  return { child, pipe: new CdpPipe(write, read), exited, hasExited: () => exitedFlag }
}

// The first answer, Browser.getVersion, may wait for the browser to start (a keyring prompt), so it has the whole
// limit. Storage.getCookies then has its own, shorter one. The browser connection serves both.
async function requestCookies(running: RunningBrowser, browser: string, timeoutMs: number): Promise<unknown[]> {
  await call(running, browser, 'Browser.getVersion', {}, timeoutMs)
  const result = await call(running, browser, 'Storage.getCookies', {}, CALL_LIMIT_MS)
  if (!isRecord(result) || !Array.isArray(result.cookies)) throw new Error(`${browser} sent no cookie list`)
  return result.cookies
}

// One call. It fails when the browser does not answer in time, or when the browser exits or closes the pipe first.
function call(running: RunningBrowser, browser: string, method: string, params: Record<string, unknown>, limitMs: number): Promise<unknown> {
  const answer = running.pipe.send<unknown>(method, params, limitMs).catch((e: unknown) => {
    if (e instanceof CdpTimeoutError) throw new Error(`${browser} did not answer in time`)
    if (e instanceof Error && e.message === 'closed') throw new Error(`${browser} closed before it answered`)
    throw e
  })
  const gone = running.exited.then(() => {
    throw new Error(`${browser} closed before it answered`)
  })
  return Promise.race([answer, gone])
}

// Asks the browser to close, gives it a few seconds, then kills it. Only the browser this reader started gets it.
async function endBrowser(running: RunningBrowser): Promise<void> {
  try {
    if (!running.hasExited()) {
      running.pipe.send('Browser.close').catch(() => undefined)
      await waitUpTo(running.exited, EXIT_LIMIT_MS)
      if (!running.hasExited()) await forceKill(running.child)
      await waitUpTo(running.exited, EXIT_LIMIT_MS)
    }
  } finally {
    running.pipe.close()
  }
}

// SIGKILL cannot be ignored on POSIX. On Windows, taskkill /T also ends the browser's helper processes, which a kill of
// the main process would leave running.
async function forceKill(child: ChildProcess): Promise<void> {
  if (process.platform === 'win32' && child.pid !== undefined) {
    const pid = String(child.pid)
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/pid', pid, '/T', '/F'], { windowsHide: true, timeout: EXIT_LIMIT_MS }, () => resolve())
    })
  }
  child.kill('SIGKILL')
}

function mapCookies(list: unknown[], nowS: number): { cookies: ImportedCookie[]; skipped: number } {
  const cookies: ImportedCookie[] = []
  let skipped = 0
  for (const item of list) {
    const cookie = isRecord(item) ? fromChromium(item as unknown as CdpCookie, nowS) : null
    if (cookie) cookies.push(cookie)
    else skipped++
  }
  return { cookies, skipped }
}

// Settles with the work, or with the limit, or with the abort signal, whichever comes first.
function within<T>(work: Promise<T>, ms: number, signal: AbortSignal, limit: Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let detach = (): void => {}
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(limit), ms)
    const onAbort = (): void => reject(new Error('cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    detach = () => signal.removeEventListener('abort', onAbort)
  })
  return Promise.race([work, stop]).finally(() => {
    clearTimeout(timer)
    detach()
  })
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'))
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

function waitUpTo(p: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  return Promise.race([p, limit]).finally(() => clearTimeout(timer))
}

function hasCode(e: unknown, code: string): boolean {
  return isRecord(e) && e.code === code
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
