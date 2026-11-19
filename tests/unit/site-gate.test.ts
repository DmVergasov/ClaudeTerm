import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SITE_ANSWER_MS, SiteGate } from '../../src/main/browser/site-gate'
import type { SiteCard } from '../../src/shared/browser'

/** the gate with fakes; `folder` is the tab's folder, null for a tab with none */
function setup(folder: string | null = null) {
  const shown: { tabId: string; card: SiteCard | null }[] = []
  const signals: string[] = []
  const always: [string, string][] = []
  let ids = 0
  const gate = new SiteGate({
    allowedAlways: (profileId) => always.filter(([p]) => p === profileId).map(([, site]) => site),
    allowAlways: (profileId, site) => { always.push([profileId, site]) },
    showCard: (tabId, card) => { shown.push({ tabId, card }) },
    signal: (tabId) => { signals.push(tabId) },
    folderOf: () => folder,
    newId: () => `card${++ids}`
  })
  return { gate, shown, signals, always }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('SiteGate', () => {
  it('a local URL is allowed with no card', async () => {
    const { gate, shown, signals } = setup()
    expect(gate.isAllowed('t1', 'p1', 'http://localhost:3000/')).toBe(true)
    await expect(gate.check('t1', 'p1', 'http://localhost:3000/', 'open')).resolves.toBe('allowed')
    expect(shown).toEqual([])
    expect(signals).toEqual([])
  })

  it('another site shows a card for its site and signals the tab once', () => {
    const { gate, signals } = setup()
    void gate.check('t1', 'p1', 'https://github.com/x', 'open')
    expect(gate.card('t1')).toEqual({ id: 'card1', site: 'github.com', kind: 'open', file: false })
    expect(signals).toEqual(['t1'])
  })

  it('answer tab allows the site in that tab only, subdomains included', async () => {
    const { gate } = setup()
    const first = gate.check('t1', 'p1', 'https://github.com/x', 'open')
    gate.answer('t1', 'card1', 'tab')
    await expect(first).resolves.toBe('allowed')
    await expect(gate.check('t1', 'p1', 'https://api.github.com', 'use')).resolves.toBe('allowed')
    expect(gate.card('t1')).toBeNull()
    void gate.check('t2', 'p1', 'https://api.github.com', 'use')
    expect(gate.card('t2')).toEqual({ id: 'card2', site: 'api.github.com', kind: 'use', file: false })
  })

  it('answer always stores the site for the profile', async () => {
    const { gate, always } = setup()
    const p = gate.check('t1', 'p1', 'https://github.com/x', 'open')
    gate.answer('t1', 'card1', 'always')
    await expect(p).resolves.toBe('allowed')
    expect(always).toEqual([['p1', 'github.com']])
    expect(gate.isAllowed('t2', 'p1', 'https://github.com/y')).toBe(true)
    expect(gate.isAllowed('t2', 'p2', 'https://github.com/y')).toBe(false)
  })

  it('answer deny resolves the check denied', async () => {
    const { gate } = setup()
    const p = gate.check('t1', 'p1', 'https://github.com/x', 'open')
    gate.answer('t1', 'card1', 'deny')
    await expect(p).resolves.toBe('denied')
    expect(gate.card('t1')).toBeNull()
    expect(gate.isAllowed('t1', 'p1', 'https://github.com/x')).toBe(false)
  })

  it('an unanswered card times out after SITE_ANSWER_MS and clears the tab', async () => {
    const { gate, shown } = setup()
    const p = gate.check('t1', 'p1', 'https://github.com/x', 'open')
    await vi.advanceTimersByTimeAsync(SITE_ANSWER_MS - 1)
    expect(gate.card('t1')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).resolves.toBe('timeout')
    expect(shown[shown.length - 1]).toEqual({ tabId: 't1', card: null })
    expect(gate.card('t1')).toBeNull()
  })

  it('stop resolves every pending check stopped', async () => {
    const { gate } = setup()
    const a = gate.check('t1', 'p1', 'https://a.com/', 'open')
    const b = gate.check('t1', 'p1', 'https://b.com/', 'open')
    gate.stop('t1')
    await expect(a).resolves.toBe('stopped')
    await expect(b).resolves.toBe('stopped')
    expect(gate.card('t1')).toBeNull()
  })

  it('an already aborted signal resolves stopped at once, with no card', async () => {
    const { gate, shown } = setup()
    const ac = new AbortController()
    ac.abort()
    await expect(gate.check('t1', 'p1', 'https://github.com/x', 'open', ac.signal)).resolves.toBe('stopped')
    expect(shown).toEqual([])
  })

  it('an abort while the card is shown resolves stopped and moves on to the next card', async () => {
    const { gate } = setup()
    const ac = new AbortController()
    const a = gate.check('t1', 'p1', 'https://a.com/', 'open', ac.signal)
    const b = gate.check('t1', 'p1', 'https://b.com/', 'open')
    ac.abort()
    await expect(a).resolves.toBe('stopped')
    expect(gate.card('t1')).toEqual({ id: 'card2', site: 'b.com', kind: 'open', file: false })
    gate.answer('t1', 'card2', 'deny')
    await expect(b).resolves.toBe('denied')
  })

  it('two concurrent checks for the same site share one card', async () => {
    const { gate, signals, shown } = setup()
    const a = gate.check('t1', 'p1', 'https://github.com/a', 'open')
    const b = gate.check('t1', 'p1', 'https://github.com/b', 'use')
    expect(signals).toEqual(['t1'])
    expect(shown.filter((s) => s.card !== null)).toHaveLength(1)
    gate.answer('t1', 'card1', 'tab')
    await expect(a).resolves.toBe('allowed')
    await expect(b).resolves.toBe('allowed')
  })

  it('checks for a.com then b.com show a.com first, then b.com after the answer', async () => {
    const { gate, signals } = setup()
    const a = gate.check('t1', 'p1', 'https://a.com/', 'open')
    const b = gate.check('t1', 'p1', 'https://b.com/', 'open')
    expect(gate.card('t1')).toEqual({ id: 'card1', site: 'a.com', kind: 'open', file: false })
    gate.answer('t1', 'card1', 'deny')
    await expect(a).resolves.toBe('denied')
    expect(gate.card('t1')).toEqual({ id: 'card2', site: 'b.com', kind: 'open', file: false })
    expect(signals).toEqual(['t1', 't1'])
    gate.answer('t1', 'card2', 'deny')
    await expect(b).resolves.toBe('denied')
  })

  it('a queued check that a grant now covers is allowed without a card', async () => {
    const { gate } = setup()
    const a = gate.check('t1', 'p1', 'https://a.com/', 'open')
    const sub = gate.check('t1', 'p1', 'https://docs.a.com/', 'open')
    gate.answer('t1', 'card1', 'tab')
    await expect(a).resolves.toBe('allowed')
    await expect(sub).resolves.toBe('allowed')
    expect(gate.card('t1')).toBeNull()
  })

  it('removeTab resolves pending checks stopped', async () => {
    const { gate } = setup()
    const a = gate.check('t1', 'p1', 'https://a.com/', 'open')
    const b = gate.check('t1', 'p1', 'https://b.com/', 'open')
    gate.removeTab('t1')
    await expect(a).resolves.toBe('stopped')
    await expect(b).resolves.toBe('stopped')
    expect(gate.card('t1')).toBeNull()
  })

  it('removeTab forgets the tab grants', async () => {
    const { gate } = setup()
    const p = gate.check('t1', 'p1', 'https://a.com/', 'open')
    gate.answer('t1', 'card1', 'tab')
    await p
    expect(gate.isAllowed('t1', 'p1', 'https://a.com/')).toBe(true)
    gate.removeTab('t1')
    expect(gate.isAllowed('t1', 'p1', 'https://a.com/')).toBe(false)
  })

  it('a stale card id changes nothing', async () => {
    const { gate, always } = setup()
    const p = gate.check('t1', 'p1', 'https://github.com/x', 'open')
    gate.answer('t1', 'old-card', 'tab')
    gate.answer('t1', 'card99', 'always')
    expect(gate.card('t1')).toEqual({ id: 'card1', site: 'github.com', kind: 'open', file: false })
    expect(gate.isAllowed('t1', 'p1', 'https://github.com/x')).toBe(false)
    expect(always).toEqual([])
    gate.answer('t1', 'card1', 'deny')
    await expect(p).resolves.toBe('denied')
  })
})

describe('SiteGate: local files', () => {
  let root: string | null = null
  const ROOT = (): string => {
    if (root === null) root = mkdtempSync(join(tmpdir(), 'ct-gate-files-'))
    return root
  }

  /** a file of a temp folder, written now */
  const fileIn = (dir: string, name: string): { path: string; url: string } => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, name)
    writeFileSync(path, '<p>page</p>')
    return { path, url: pathToFileURL(path).href }
  }

  afterEach(() => {
    if (root !== null) rmSync(root, { recursive: true, force: true })
    root = null
  })

  it('a file inside the tab folder is allowed with no card', async () => {
    const folder = join(ROOT(), 'project')
    const { url } = fileIn(folder, 'page.html')
    const { gate, shown } = setup(folder)
    expect(gate.isAllowed('t1', 'p1', url)).toBe(true)
    await expect(gate.check('t1', 'p1', url, 'open')).resolves.toBe('allowed')
    expect(shown).toEqual([])
  })

  it('a file outside the tab folder asks, with its path and no Always button', () => {
    const folder = join(ROOT(), 'project')
    const { path, url } = fileIn(join(ROOT(), 'elsewhere'), 'page.html')
    const { gate } = setup(folder)
    void gate.check('t1', 'p1', url, 'open')
    expect(gate.card('t1')).toEqual({ id: 'card1', site: path, kind: 'open', file: true })
  })

  it('a tab with no folder asks for every file', () => {
    const { path, url } = fileIn(join(ROOT(), 'anywhere'), 'page.html')
    const { gate } = setup(null)
    expect(gate.isAllowed('t1', 'p1', url)).toBe(false)
    void gate.check('t1', 'p1', url, 'use')
    expect(gate.card('t1')).toEqual({ id: 'card1', site: path, kind: 'use', file: true })
  })

  it('answer tab covers that exact file in that tab, and not its neighbour', async () => {
    const dir = join(ROOT(), 'elsewhere')
    const first = fileIn(dir, 'page.html')
    const neighbour = fileIn(dir, 'other.html')
    const { gate } = setup(join(ROOT(), 'project'))
    const p = gate.check('t1', 'p1', first.url, 'open')
    gate.answer('t1', 'card1', 'tab')
    await expect(p).resolves.toBe('allowed')
    expect(gate.isAllowed('t1', 'p1', first.url)).toBe(true)
    expect(gate.isAllowed('t2', 'p1', first.url)).toBe(false)
    expect(gate.isAllowed('t1', 'p1', neighbour.url)).toBe(false)
    void gate.check('t1', 'p1', neighbour.url, 'open')
    expect(gate.card('t1')).toEqual({ id: 'card2', site: neighbour.path, kind: 'open', file: true })
  })

  it('a file URL padded with a space, a tab or a newline is still a file: outside the folder it asks and is not allowed', () => {
    const folder = join(ROOT(), 'project')
    const { path, url } = fileIn(join(ROOT(), 'elsewhere'), 'page.html')
    const { gate } = setup(folder)
    for (const padded of [` ${url}`, `\t${url}`, url.replace('file:', 'fi\nle:')]) {
      expect(gate.isAllowed('t1', 'p1', padded)).toBe(false)
    }
    void gate.check('t1', 'p1', ` ${url}`, 'open')
    expect(gate.card('t1')).toEqual({ id: 'card1', site: path, kind: 'open', file: true })
  })

  it('always is ignored for a file: no grant is stored and the card stays', async () => {
    const { path, url } = fileIn(join(ROOT(), 'elsewhere'), 'page.html')
    const { gate, always } = setup(join(ROOT(), 'project'))
    const p = gate.check('t1', 'p1', url, 'open')
    gate.answer('t1', 'card1', 'always')
    expect(always).toEqual([])
    expect(gate.card('t1')).toEqual({ id: 'card1', site: path, kind: 'open', file: true })
    expect(gate.isAllowed('t1', 'p1', url)).toBe(false)
    gate.answer('t1', 'card1', 'deny')
    await expect(p).resolves.toBe('denied')
  })
})
