import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import type { SiteAnswer, SiteCard } from '../../shared/browser'
import { isFileUrl, isLocalUrl, siteCovers, siteOf } from '../../shared/site'
import { pathKey } from '../path-key'
import { fileInside, filePathOf } from './local-file'

export type GateResult = 'allowed' | 'denied' | 'timeout' | 'stopped'
/** how long the person has to answer a card before its checks time out */
export const SITE_ANSWER_MS = 600_000

export interface SiteGateDeps {
  allowedAlways(profileId: string): string[]
  allowAlways(profileId: string, site: string): void
  /** the profile's Always allow all sites switch: every http and https site is allowed in it */
  allowAll(profileId: string): boolean
  showCard(tabId: string, card: SiteCard | null): void
  /** the tab asks for attention on this device only (never forwarded to paired devices) */
  signal(tabId: string): void
  /** the tab's own folder, the one its tab bar groups it by: a local file inside it is free; null when the tab has none */
  folderOf(tabId: string): string | null
  answerMs?: number
  newId?(): string
}

/** what a check asks about: a web site, or a local file (its path in the OS form) */
export interface Subject {
  site: string
  file: boolean
}

/** the subject of a URL the gate decides on: its site, or a local file's path; null for a URL with neither */
export function subjectOf(url: string): Subject | null {
  if (isFileUrl(url)) {
    const path = filePathOf(url)
    return path !== null && isLocalUrl(url) ? { site: path, file: true } : null
  }
  const site = siteOf(url)
  return site === null ? null : { site, file: false }
}

/** the card is about this subject: the same site, or the same file (as pathKey compares paths) */
function sameSubject(card: SiteCard, subject: Subject): boolean {
  if (card.file !== subject.file) return false
  return subject.file ? pathKey(card.site) === pathKey(subject.site) : card.site === subject.site
}

/** one check waiting for the answer to its card */
interface Pending {
  profileId: string
  resolve(result: GateResult): void
  detach(): void
}

/** a card and the checks it answers, shown or queued */
interface Slot {
  card: SiteCard
  profileId: string
  checks: Pending[]
}

interface TabGate {
  grants: string[]
  /** the files the person allowed in this tab, as pathKey has them */
  files: string[]
  shown: Slot | null
  queue: Slot[]
  timer: ReturnType<typeof setTimeout> | null
}

/** settles one check: stops listening for its abort, then resolves it */
function end(check: Pending, result: GateResult): void {
  check.detach()
  check.resolve(result)
}

/** Decides whether Claude may use a site in a tab: local pages always, other sites once the person says yes in the Browser panel. One card per tab; the rest wait in order. */
export class SiteGate {
  private readonly tabs = new Map<string, TabGate>()
  private readonly answerMs: number
  private readonly newId: () => string

  constructor(private readonly d: SiteGateDeps) {
    this.answerMs = d.answerMs ?? SITE_ANSWER_MS
    this.newId = d.newId ?? randomUUID
  }

  /**
   * true for a local page, when the profile allows all sites, or when the tab's grants or the profile's always list cover the URL's site. A file is free in the
   * tab's folder; elsewhere it is allowed only when the person allowed that file in this tab.
   */
  isAllowed(tabId: string, profileId: string, url: string): boolean {
    if (isFileUrl(url)) return this.fileAllowed(tabId, url)
    if (isLocalUrl(url)) return true
    const site = siteOf(url)
    if (site === null) return false
    return this.d.allowAll(profileId) || this.covered(tabId, profileId, { site, file: false })
  }

  /** resolves once the URL may be used: at once when allowed, else after the person answers its card (or it times out, or stops) */
  check(tabId: string, profileId: string, url: string, kind: 'open' | 'use', signal?: AbortSignal): Promise<GateResult> {
    if (this.isAllowed(tabId, profileId, url)) return Promise.resolve('allowed')
    const subject = subjectOf(url)
    if (subject === null) return Promise.resolve('denied')
    if (signal?.aborted) return Promise.resolve('stopped')
    return new Promise<GateResult>((resolve) => {
      const t = this.tabOf(tabId)
      const pending: Pending = { profileId, resolve, detach: () => {} }
      const slot = this.slotFor(t, subject, kind, profileId)
      slot.checks.push(pending)
      if (signal) {
        const onAbort = (): void => this.settle(tabId, t, slot, pending, 'stopped')
        signal.addEventListener('abort', onAbort, { once: true })
        pending.detach = () => signal.removeEventListener('abort', onAbort)
      }
      if (t.shown === null) this.promote(tabId, t)
    })
  }

  /** the person's answer to a card; a stale card id is ignored */
  answer(tabId: string, cardId: string, answer: SiteAnswer): void {
    const t = this.tabs.get(tabId)
    if (!t || !t.shown || t.shown.card.id !== cardId) return
    const slot = t.shown
    // a file is never allowed for every tab or every visit: an Always answer to its card changes nothing
    if (slot.card.file && answer === 'always') return
    if (answer === 'tab') {
      if (slot.card.file) t.files.push(pathKey(slot.card.site))
      else t.grants.push(slot.card.site)
    }
    if (answer === 'always') this.d.allowAlways(slot.profileId, slot.card.site)
    this.finish(tabId, t, slot, answer === 'deny' ? 'denied' : 'allowed')
  }

  /** resolves every check of the tab as stopped; the tab keeps its grants */
  stop(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    const wasShown = t.shown !== null
    this.drain(t, 'stopped')
    if (wasShown) this.d.showCard(tabId, null)
  }

  /** resolves the tab's checks as stopped and forgets its grants */
  removeTab(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    this.drain(t, 'stopped')
    this.tabs.delete(tabId)
  }

  /** the card the tab shows, or null */
  card(tabId: string): SiteCard | null {
    return this.tabs.get(tabId)?.shown?.card ?? null
  }

  private tabOf(tabId: string): TabGate {
    let t = this.tabs.get(tabId)
    if (!t) {
      t = { grants: [], files: [], shown: null, queue: [], timer: null }
      this.tabs.set(tabId, t)
    }
    return t
  }

  /** a local file is free in the tab's folder, and elsewhere only when the person allowed it in this tab */
  private fileAllowed(tabId: string, url: string): boolean {
    if (!isLocalUrl(url)) return false
    const path = filePathOf(url)
    if (path === null) return false
    const folder = this.d.folderOf(tabId)
    if (folder !== null && fileInside(path, folder, realpathSync.native)) return true
    return this.covered(tabId, '', { site: path, file: true })
  }

  private covered(tabId: string, profileId: string, subject: Subject): boolean {
    const t = this.tabs.get(tabId)
    if (subject.file) return t !== undefined && t.files.includes(pathKey(subject.site))
    if (t && t.grants.some((g) => siteCovers(g, subject.site))) return true
    return this.d.allowedAlways(profileId).some((a) => siteCovers(a, subject.site))
  }

  /** the card for the subject if one is shown or queued, else a new queued card */
  private slotFor(t: TabGate, subject: Subject, kind: 'open' | 'use', profileId: string): Slot {
    const existing = [t.shown, ...t.queue].find((s) => s !== null && sameSubject(s.card, subject))
    if (existing) return existing
    const slot: Slot = { card: { id: this.newId(), site: subject.site, kind, file: subject.file }, profileId, checks: [] }
    t.queue.push(slot)
    return slot
  }

  /** shows the next queued card that still needs an answer; false when none is left */
  private promote(tabId: string, t: TabGate): boolean {
    let slot = t.queue.shift()
    while (slot !== undefined) {
      const open: Pending[] = []
      for (const check of slot.checks) {
        if (this.covered(tabId, check.profileId, slot.card)) end(check, 'allowed')
        else open.push(check)
      }
      slot.checks = open
      if (open.length > 0) {
        t.shown = slot
        t.timer = setTimeout(() => this.timeout(tabId), this.answerMs)
        this.d.showCard(tabId, slot.card)
        this.d.signal(tabId)
        return true
      }
      slot = t.queue.shift()
    }
    t.shown = null
    return false
  }

  /** the shown card is over: show the next one, or none */
  private close(tabId: string, t: TabGate): void {
    if (t.timer !== null) clearTimeout(t.timer)
    t.timer = null
    t.shown = null
    if (!this.promote(tabId, t)) this.d.showCard(tabId, null)
  }

  /** resolves all checks of the shown card with one result, then moves on */
  private finish(tabId: string, t: TabGate, slot: Slot, result: GateResult): void {
    for (const check of slot.checks) end(check, result)
    slot.checks = []
    if (t.shown === slot) this.close(tabId, t)
  }

  /** resolves one check (its signal aborted); a card left without checks is dropped */
  private settle(tabId: string, t: TabGate, slot: Slot, pending: Pending, result: GateResult): void {
    end(pending, result)
    slot.checks = slot.checks.filter((c) => c !== pending)
    if (slot.checks.length > 0) return
    if (t.shown === slot) this.close(tabId, t)
    else t.queue = t.queue.filter((s) => s !== slot)
  }

  private timeout(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t || !t.shown) return
    this.finish(tabId, t, t.shown, 'timeout')
  }

  /** resolves every check of the tab with one result and empties its cards */
  private drain(t: TabGate, result: GateResult): void {
    if (t.timer !== null) clearTimeout(t.timer)
    t.timer = null
    const slots = t.shown ? [t.shown, ...t.queue] : t.queue
    t.shown = null
    t.queue = []
    for (const slot of slots) {
      for (const check of slot.checks) end(check, result)
      slot.checks = []
    }
  }
}
