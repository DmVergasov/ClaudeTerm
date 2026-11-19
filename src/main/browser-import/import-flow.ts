import type { CookiesSetDetails } from 'electron'
import type { ImportStatus } from '../../shared/browser'
import { siteCount, toElectron, type ImportedCookie } from './cookie-map'
import type { LiveReadDeps, OpenProfile } from './live-reader'
import type { ImportSource } from './sources'

// The flow's dependencies: the readers, the writes into a profile and the way statuses reach the person.
export interface ImportFlowDeps {
  sources(): Promise<ImportSource[]>
  readFirefox(source: ImportSource): Promise<{ cookies: ImportedCookie[]; skipped: number }>
  readChromium(source: ImportSource, onWaiting: () => void, signal: AbortSignal): Promise<{ cookies: ImportedCookie[]; skipped: number }>
  // live sources (mode 'live'): the flow passes its own hooks through to readLiveCookies
  readLive(source: ImportSource, hooks: Pick<LiveReadDeps, 'onStatus' | 'pickProfile' | 'signal'>): Promise<{ cookies: ImportedCookie[]; skipped: number }>
  setCookie(profileId: string, details: CookiesSetDetails): Promise<boolean> // false: Electron refused it
  flush(profileId: string): Promise<void>
  status(s: ImportStatus): void
  platform: NodeJS.Platform
  now(): number
}

interface Reading {
  cookies: ImportedCookie[]
  skipped: number
}

interface PendingPick {
  ids: string[]
  resolve(contextId: string): void
  reject(e: Error): void
}

const NO_SOURCE = 'This browser is no longer available.'
const OUTSIDE_NOTE = 'Sites that keep their sign-in outside cookies need you to sign in again here.'
/** the note names the browser the cookies came from: Chrome, Edge, Brave (and Vivaldi, Chromium) keep Google's sign-ins tied to this computer */
const googleNote = (browser: string): string => `Google sign-ins are not carried over: ${browser} ties them to this computer.`
const DEBUGGING_NOTE = 'You can turn remote debugging off again on the same page.'
const FLUSH_NOTE = 'The cookies were added, but saving them to disk failed; they may be gone after ClaudeTerm restarts.'
// a write or a save that does not answer in time counts as failed: the import goes on, or ends with the note
const SET_COOKIE_LIMIT_MS = 10_000
const FLUSH_LIMIT_MS = 10_000

/** Imports the cookies of one browser profile into one of ClaudeTerm's profiles, and reports each step as a status. */
export class ImportFlow {
  private controller: AbortController | null = null
  private pending: PendingPick | null = null

  constructor(private readonly d: ImportFlowDeps) {}

  /** starts an import; a second start while one runs is ignored */
  start(sourceId: string, profileId: string): void {
    if (this.controller) return
    const controller = new AbortController()
    this.controller = controller
    void this.run(sourceId, profileId, controller.signal)
  }

  /** the person's answer to pick-profile; ignored when no profile is being asked for or the id is not one of the choices */
  pick(contextId: string): void {
    const pending = this.pending
    if (!pending || !pending.ids.includes(contextId)) return
    this.pending = null
    pending.resolve(contextId)
  }

  cancel(): void {
    const controller = this.controller
    if (!controller) return
    controller.abort()
    const pending = this.pending
    this.pending = null
    pending?.reject(new Error('cancelled'))
  }

  private async run(sourceId: string, profileId: string, signal: AbortSignal): Promise<void> {
    let outcome: ImportStatus
    try {
      outcome = await this.importCookies(sourceId, profileId, signal)
    } catch (e) {
      outcome = signal.aborted || isCancel(e) ? { state: 'cancelled' } : { state: 'failed', error: messageOf(e) }
    }
    // the flow is idle before its final status is reported, so a start made in answer to it is accepted
    this.controller = null
    this.pending = null
    try {
      this.d.status(outcome)
    } catch {
      // the status sink failed; the flow is idle either way
    }
  }

  private async importCookies(sourceId: string, profileId: string, signal: AbortSignal): Promise<ImportStatus> {
    const source = (await this.d.sources()).find((s) => s.id === sourceId)
    if (!source) return { state: 'failed', error: NO_SOURCE }
    if (signal.aborted) return { state: 'cancelled' }

    // a copy or a Firefox read is an import under way from its start, so the sheet shows its spinner and Cancel; a live read
    // reports its own setup and allow statuses first. The status the sheet shows last is kept, so importing is said once.
    let shown: ImportStatus['state'] | null = source.mode === 'live' ? null : 'importing'
    const report = (s: ImportStatus): void => {
      shown = s.state
      this.d.status(s)
    }
    if (shown !== null) report({ state: 'importing' })
    const reading = await untilCancelled(this.read(source, signal, report), signal)
    if (shown !== 'importing') report({ state: 'importing' })

    const nowS = Math.floor(this.d.now() / 1000)
    const written: ImportedCookie[] = []
    let refused = 0
    for (const cookie of reading.cookies) {
      if (signal.aborted) break
      // one bad cookie never aborts the import: a throw, a refusal or no answer in time counts as refused
      let ok = false
      try {
        ok = await limited(this.d.setCookie(profileId, toElectron(cookie, nowS)), SET_COOKIE_LIMIT_MS, signal)
      } catch {
        ok = false
      }
      if (ok) written.push(cookie)
      else refused++
    }
    // what was written is kept even when the person cancelled part way; a failed save does not fail the import
    let saved = true
    try {
      await limited(this.d.flush(profileId), FLUSH_LIMIT_MS, signal)
    } catch {
      saved = false
    }
    if (signal.aborted) return written.length > 0 ? { state: 'cancelled', imported: written.length } : { state: 'cancelled' }

    const notes = [OUTSIDE_NOTE]
    if (source.family === 'chromium' && this.d.platform === 'win32') notes.push(googleNote(source.browser))
    if (source.mode === 'live') notes.push(DEBUGGING_NOTE)
    if (!saved) notes.push(FLUSH_NOTE)
    return {
      state: 'done',
      imported: written.length,
      sites: siteCount(written),
      skipped: reading.skipped + refused,
      notes,
    }
  }

  private read(source: ImportSource, signal: AbortSignal, report: (s: ImportStatus) => void): Promise<Reading> {
    if (source.family === 'firefox') return this.d.readFirefox(source)
    if (source.mode === 'live') {
      return this.d.readLive(source, {
        onStatus: (s) => {
          if (signal.aborted) return
          report(s.state === 'setup' ? { state: 'setup', browser: source.browser } : { state: 'allow', browser: source.browser })
        },
        pickProfile: (profiles) => this.askProfile(source.browser, profiles, signal, report),
        signal,
      })
    }
    return this.d.readChromium(
      source,
      () => {
        if (!signal.aborted) report({ state: 'waiting-close', browser: source.browser })
      },
      signal,
    )
  }

  private askProfile(browser: string, profiles: OpenProfile[], signal: AbortSignal, report: (s: ImportStatus) => void): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('cancelled'))
        return
      }
      // the reader asks once; a question that comes while another waits supersedes it, and the first is refused
      this.pending?.reject(new Error('cancelled'))
      this.pending = { ids: profiles.map((p) => p.contextId), resolve, reject }
      report({
        state: 'pick-profile',
        browser,
        profiles: profiles.map((p) => ({ contextId: p.contextId, label: p.label })),
      })
    })
  }
}

// The work's answer, or 'cancelled' as soon as the signal aborts, even when the work itself never settles.
function untilCancelled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // handled even when the abort wins: a work that fails later must not be an unhandled rejection in main
  work.catch(() => undefined)
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

// The work's answer within ms, or an error as soon as the signal aborts or the time runs out.
function limited<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms)
  })
  return Promise.race([untilCancelled(work, signal), timeout]).finally(() => clearTimeout(timer))
}

function isCancel(e: unknown): boolean {
  return e instanceof Error && e.message === 'cancelled'
}

function messageOf(e: unknown): string {
  return e instanceof Error && e.message !== '' ? e.message : 'The import failed.'
}
