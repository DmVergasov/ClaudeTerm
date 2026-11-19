import { describe, expect, it, vi } from 'vitest'
import { ImportFlow, type ImportFlowDeps } from '../../src/main/browser-import/import-flow'
import type { ImportedCookie } from '../../src/main/browser-import/cookie-map'
import type { ImportSource } from '../../src/main/browser-import/sources'
import type { ImportStatus } from '../../src/shared/browser'

const NOW_MS = 1_800_000_000_000
const OUTSIDE = 'Sites that keep their sign-in outside cookies need you to sign in again here.'
const GOOGLE = 'Google sign-ins are not carried over: Chrome ties them to this computer.'
const DEBUGGING = 'You can turn remote debugging off again on the same page.'
const FLUSH_NOTE = 'The cookies were added, but saving them to disk failed; they may be gone after ClaudeTerm restarts.'

function cookie(name: string, domain: string): ImportedCookie {
  return { name, value: 'test-value-1', domain, hostOnly: true, path: '/', secure: false, httpOnly: false, sameSite: 'unspecified', expires: null }
}

function source(over: Partial<ImportSource>): ImportSource {
  return {
    id: 'chrome-default',
    kind: 'chrome',
    browser: 'Chrome',
    label: 'Chrome · Default',
    family: 'chromium',
    userDataDir: '/data/chrome',
    profileDir: '/data/chrome/Default',
    profileName: 'Default',
    email: null,
    hasCookies: true,
    binary: null,
    mode: 'copy',
    ...over,
  }
}

const firefoxSource = source({ id: 'firefox-default', kind: 'firefox', browser: 'Firefox', family: 'firefox', label: 'Firefox · default' })
const chromeCopy = source({})
const chromeLive = source({ id: 'chrome-live', mode: 'live', label: 'Chrome · open profiles' })

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined)
}

// The fake dependencies: every reader is a stub the test replaces, and the statuses and writes are recorded.
function fakes(over: Partial<ImportFlowDeps> = {}) {
  const statuses: ImportStatus[] = []
  const writes: { profileId: string; name: string }[] = []
  const flushes: string[] = []
  const deps: ImportFlowDeps = {
    sources: async () => [firefoxSource, chromeCopy, chromeLive],
    readFirefox: async () => ({ cookies: [cookie('sid', 'example.com'), cookie('pref', 'example.org'), cookie('refused', 'example.net')], skipped: 0 }),
    readChromium: async () => ({ cookies: [], skipped: 0 }),
    readLive: async () => ({ cookies: [], skipped: 0 }),
    setCookie: async (profileId, details) => {
      writes.push({ profileId, name: details.name ?? '' })
      return details.name !== 'refused'
    },
    flush: async (profileId) => {
      flushes.push(profileId)
    },
    status: (s) => statuses.push(s),
    platform: 'win32',
    now: () => NOW_MS,
    ...over,
  }
  return { deps, statuses, writes, flushes, flow: new ImportFlow(deps) }
}

// The run is asynchronous: wait until the flow has reported a final status.
async function untilFinal(statuses: ImportStatus[]): Promise<void> {
  await vi.waitFor(() => {
    const last = statuses[statuses.length - 1]
    expect(last && ['done', 'failed', 'cancelled'].includes(last.state)).toBe(true)
  })
}

describe('ImportFlow: Firefox', () => {
  it('imports the cookies that Electron takes and reports the refused one as skipped', async () => {
    const { statuses, writes, flushes, flow } = fakes()
    flow.start('firefox-default', 'p1')
    await untilFinal(statuses)
    expect(statuses).toEqual([
      { state: 'importing' },
      { state: 'done', imported: 2, sites: 2, skipped: 1, notes: [OUTSIDE] },
    ])
    expect(writes.map((w) => w.profileId)).toEqual(['p1', 'p1', 'p1'])
    expect(flushes).toEqual(['p1'])
  })

  it('adds the reader skips to the skipped count', async () => {
    const { statuses, flow } = fakes({ readFirefox: async () => ({ cookies: [cookie('sid', 'example.com')], skipped: 4 }) })
    flow.start('firefox-default', 'p1')
    await untilFinal(statuses)
    expect(statuses[statuses.length - 1]).toEqual({ state: 'done', imported: 1, sites: 1, skipped: 4, notes: [OUTSIDE] })
  })

  it('counts a setCookie that throws as skipped and goes on with the next cookie', async () => {
    const { statuses, flow } = fakes({
      setCookie: async (_profileId, details) => {
        if (details.name === 'sid') throw new Error('refused by the store')
        return true
      },
    })
    flow.start('firefox-default', 'p1')
    await untilFinal(statuses)
    expect(statuses[statuses.length - 1]).toEqual({ state: 'done', imported: 2, sites: 2, skipped: 1, notes: [OUTSIDE] })
  })

  it('reports a reader error as failed with its message', async () => {
    const { statuses, flow } = fakes({
      readFirefox: async () => {
        throw new Error('Could not read Firefox cookies from "abc.default" (EBUSY).')
      },
    })
    flow.start('firefox-default', 'p1')
    await untilFinal(statuses)
    expect(statuses).toEqual([{ state: 'importing' }, { state: 'failed', error: 'Could not read Firefox cookies from "abc.default" (EBUSY).' }])
  })

  it('reports an unknown source as failed and reads nothing', async () => {
    const readFirefox = vi.fn(async () => ({ cookies: [], skipped: 0 }))
    const { statuses, flow } = fakes({ readFirefox })
    flow.start('no-such-source', 'p1')
    await untilFinal(statuses)
    expect(statuses).toEqual([{ state: 'failed', error: 'This browser is no longer available.' }])
    expect(readFirefox).not.toHaveBeenCalled()
  })

  it('ignores a second start while an import runs, and accepts a start after done', async () => {
    const gate: { release?: () => void } = {}
    const readFirefox = vi.fn(
      () =>
        new Promise<{ cookies: ImportedCookie[]; skipped: number }>((resolve) => {
          gate.release = () => resolve({ cookies: [cookie('sid', 'example.com')], skipped: 0 })
        }),
    )
    const { statuses, flow } = fakes({ readFirefox })
    flow.start('firefox-default', 'p1')
    flow.start('firefox-default', 'p2')
    await vi.waitFor(() => expect(gate.release).toBeDefined())
    expect(readFirefox).toHaveBeenCalledTimes(1)
    gate.release?.()
    await untilFinal(statuses)
    expect(statuses.filter((s) => s.state === 'done')).toHaveLength(1)

    flow.start('firefox-default', 'p1')
    await vi.waitFor(() => expect(readFirefox).toHaveBeenCalledTimes(2))
  })
})

describe('ImportFlow: the sheet shows importing from the start of a copy or a Firefox read', () => {
  it('a Firefox read reports importing before the read ends, and Cancel stops it', async () => {
    const { statuses, flow } = fakes({ readFirefox: () => never() })
    flow.start('firefox-default', 'p1')
    await vi.waitFor(() => expect(statuses).toEqual([{ state: 'importing' }]))
    flow.cancel()
    await untilFinal(statuses)
    expect(statuses).toEqual([{ state: 'importing' }, { state: 'cancelled' }])
  })

  it('a Chromium copy reports importing before the copy is read, and Cancel stops it', async () => {
    const { statuses, flow } = fakes({ readChromium: () => never() })
    flow.start('chrome-default', 'p1')
    await vi.waitFor(() => expect(statuses).toEqual([{ state: 'importing' }]))
    flow.cancel()
    await untilFinal(statuses)
    expect(statuses).toEqual([{ state: 'importing' }, { state: 'cancelled' }])
  })
})

describe('ImportFlow: Chromium copy', () => {
  it('reports waiting-close with the browser name when the browser holds its cookie file', async () => {
    const { statuses, flow } = fakes({
      readChromium: async (_source, onWaiting) => {
        onWaiting()
        return never()
      },
    })
    flow.start('chrome-default', 'p1')
    await vi.waitFor(() => expect(statuses).toEqual([{ state: 'importing' }, { state: 'waiting-close', browser: 'Chrome' }]))
    flow.cancel()
    await untilFinal(statuses)
  })

  it('cancel while waiting reports cancelled', async () => {
    const { statuses, flow } = fakes({
      readChromium: async (_source, onWaiting) => {
        onWaiting()
        return never()
      },
    })
    flow.start('chrome-default', 'p1')
    await vi.waitFor(() => expect(statuses.length).toBe(2))
    flow.cancel()
    await untilFinal(statuses)
    expect(statuses).toEqual([{ state: 'importing' }, { state: 'waiting-close', browser: 'Chrome' }, { state: 'cancelled' }])
  })

  it('adds the Google note on win32 and not on darwin', async () => {
    const readChromium = async () => ({ cookies: [cookie('sid', 'example.com')], skipped: 0 })
    const win = fakes({ readChromium })
    win.flow.start('chrome-default', 'p1')
    await untilFinal(win.statuses)
    expect(win.statuses[win.statuses.length - 1]).toEqual({ state: 'done', imported: 1, sites: 1, skipped: 0, notes: [OUTSIDE, GOOGLE] })

    const mac = fakes({ readChromium, platform: 'darwin' })
    mac.flow.start('chrome-default', 'p1')
    await untilFinal(mac.statuses)
    expect(mac.statuses[mac.statuses.length - 1]).toEqual({ state: 'done', imported: 1, sites: 1, skipped: 0, notes: [OUTSIDE] })
  })

  it('names the source browser in the Google note, Edge here', async () => {
    const edge = source({ id: 'edge-default', browser: 'Edge', label: 'Edge · Default' })
    const { statuses, flow } = fakes({
      sources: async () => [edge],
      readChromium: async () => ({ cookies: [cookie('sid', 'example.com')], skipped: 0 }),
    })
    flow.start('edge-default', 'p1')
    await untilFinal(statuses)
    expect(statuses[statuses.length - 1]).toEqual({
      state: 'done',
      imported: 1,
      sites: 1,
      skipped: 0,
      notes: [OUTSIDE, 'Google sign-ins are not carried over: Edge ties them to this computer.'],
    })
  })
})

describe('ImportFlow: Chromium live', () => {
  it('shows setup, allow and the profile picker, then imports the chosen profile', async () => {
    let picked: string | null = null
    const { statuses, flow } = fakes({
      readLive: async (_source, hooks) => {
        hooks.onStatus({ state: 'setup' })
        hooks.onStatus({ state: 'allow' })
        picked = await hooks.pickProfile([
          { contextId: 'c1', label: '2 tabs: Docs, Mail' },
          { contextId: 'c2', label: '1 tab: Shop' },
        ])
        return { cookies: [cookie('live', '127.0.0.1')], skipped: 0 }
      },
    })
    flow.start('chrome-live', 'p1')
    await vi.waitFor(() => expect(statuses.length).toBe(3))
    expect(statuses).toEqual([
      { state: 'setup', browser: 'Chrome' },
      { state: 'allow', browser: 'Chrome' },
      {
        state: 'pick-profile',
        browser: 'Chrome',
        profiles: [
          { contextId: 'c1', label: '2 tabs: Docs, Mail' },
          { contextId: 'c2', label: '1 tab: Shop' },
        ],
      },
    ])
    flow.pick('nope')
    flow.pick('c2')
    await untilFinal(statuses)
    expect(picked).toBe('c2')
    expect(statuses.slice(3)).toEqual([
      { state: 'importing' },
      { state: 'done', imported: 1, sites: 1, skipped: 0, notes: [OUTSIDE, GOOGLE, DEBUGGING] },
    ])
  })

  it('a pick while no profile is asked for is ignored', async () => {
    const { statuses, flow } = fakes({ readLive: async () => ({ cookies: [], skipped: 0 }) })
    flow.pick('c1')
    flow.start('chrome-live', 'p1')
    await untilFinal(statuses)
    expect(statuses).toEqual([{ state: 'importing' }, { state: 'done', imported: 0, sites: 0, skipped: 0, notes: [OUTSIDE, GOOGLE, DEBUGGING] }])
  })

  it('cancel during pick-profile reports cancelled', async () => {
    const { statuses, flow } = fakes({
      readLive: async (_source, hooks) => {
        await hooks.pickProfile([{ contextId: 'c1', label: '1 tab' }])
        return { cookies: [], skipped: 0 }
      },
    })
    flow.start('chrome-live', 'p1')
    await vi.waitFor(() => expect(statuses.length).toBe(1))
    flow.cancel()
    await untilFinal(statuses)
    expect(statuses[statuses.length - 1]).toEqual({ state: 'cancelled' })
  })

  it('a live import on darwin has the remote-debugging note without the Google note', async () => {
    const { statuses, flow } = fakes({
      platform: 'darwin',
      readLive: async () => ({ cookies: [], skipped: 0 }),
    })
    flow.start('chrome-live', 'p1')
    await untilFinal(statuses)
    expect(statuses[statuses.length - 1]).toEqual({ state: 'done', imported: 0, sites: 0, skipped: 0, notes: [OUTSIDE, DEBUGGING] })
  })
})

describe('ImportFlow: darwin and the Google note', () => {
  it('does not add the Google note on darwin for a Chromium source', async () => {
    const { statuses, flow } = fakes({
      platform: 'darwin',
      readChromium: async () => ({ cookies: [cookie('sid', 'example.com')], skipped: 0 }),
    })
    flow.start('chrome-default', 'p1')
    await untilFinal(statuses)
    expect(statuses[statuses.length - 1]).toEqual({ state: 'done', imported: 1, sites: 1, skipped: 0, notes: [OUTSIDE] })
  })
})

describe('ImportFlow: limits, cancel and late answers', () => {
  it('a cancel during the write loop stops at the next cookie, still flushes, and reports the count', async () => {
    const names: string[] = []
    const { statuses, flushes, flow } = fakes({
      // the first write is confirmed; the second never answers, so the cancel arrives while it is in progress
      setCookie: (_profileId, details) => {
        names.push(details.name ?? '')
        return names.length === 1 ? Promise.resolve(true) : never<boolean>()
      },
    })
    flow.start('firefox-default', 'p1')
    await vi.waitFor(() => expect(names).toEqual(['sid', 'pref']))
    flow.cancel()
    await untilFinal(statuses)
    expect(names).toEqual(['sid', 'pref'])
    expect(flushes).toEqual(['p1'])
    expect(statuses).toEqual([{ state: 'importing' }, { state: 'cancelled', imported: 1 }])
  })

  it('a cancel before any cookie is written reports cancelled without a count', async () => {
    const { statuses, flow } = fakes({ readFirefox: () => never<{ cookies: ImportedCookie[]; skipped: number }>() })
    flow.start('firefox-default', 'p1')
    flow.cancel()
    await untilFinal(statuses)
    expect(statuses).toEqual([{ state: 'cancelled' }])
    expect('imported' in (statuses[0] as object)).toBe(false)
  })

  it('a cancel while the sources are listed starts no reader', async () => {
    const gate: { resolve?: (s: ImportSource[]) => void } = {}
    const readFirefox = vi.fn(async () => ({ cookies: [cookie('sid', 'example.com')], skipped: 0 }))
    const { statuses, flow } = fakes({
      sources: () =>
        new Promise<ImportSource[]>((resolve) => {
          gate.resolve = resolve
        }),
      readFirefox,
    })
    flow.start('firefox-default', 'p1')
    await vi.waitFor(() => expect(gate.resolve).toBeDefined())
    flow.cancel()
    gate.resolve?.([firefoxSource])
    await untilFinal(statuses)
    expect(statuses).toEqual([{ state: 'cancelled' }])
    expect(readFirefox).not.toHaveBeenCalled()
  })

  it('a setCookie that never answers counts as skipped after 10 seconds and the import goes on', async () => {
    vi.useFakeTimers()
    try {
      const { statuses, flow } = fakes({
        readFirefox: async () => ({ cookies: [cookie('sid', 'example.com'), cookie('pref', 'example.org')], skipped: 0 }),
        setCookie: async (_profileId, details) => (details.name === 'sid' ? never<boolean>() : true),
      })
      flow.start('firefox-default', 'p1')
      await vi.advanceTimersByTimeAsync(9_999)
      expect(statuses).toEqual([{ state: 'importing' }])
      await vi.advanceTimersByTimeAsync(1)
      expect(statuses[statuses.length - 1]).toEqual({ state: 'done', imported: 1, sites: 1, skipped: 1, notes: [OUTSIDE] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a flush that never answers is limited to 10 seconds, and the import is done with the note', async () => {
    vi.useFakeTimers()
    try {
      const { statuses, flow } = fakes({ flush: () => never<void>() })
      flow.start('firefox-default', 'p1')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(statuses[statuses.length - 1]).toEqual({ state: 'done', imported: 2, sites: 2, skipped: 1, notes: [OUTSIDE, FLUSH_NOTE] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a flush that rejects reports done with the note, not failed', async () => {
    const { statuses, flow } = fakes({
      flush: async () => {
        throw new Error('disk full')
      },
    })
    flow.start('firefox-default', 'p1')
    await untilFinal(statuses)
    expect(statuses[statuses.length - 1]).toEqual({ state: 'done', imported: 2, sites: 2, skipped: 1, notes: [OUTSIDE, FLUSH_NOTE] })
  })

  it('a reader that ignores the cancel and fails late reports nothing more', async () => {
    const gate: { reject?: (e: Error) => void } = {}
    const writes: string[] = []
    const { statuses, flow } = fakes({
      readFirefox: () =>
        new Promise<{ cookies: ImportedCookie[]; skipped: number }>((_resolve, reject) => {
          gate.reject = reject
        }),
      setCookie: async (_profileId, details) => {
        writes.push(details.name ?? '')
        return true
      },
    })
    flow.start('firefox-default', 'p1')
    await vi.waitFor(() => expect(gate.reject).toBeDefined())
    flow.cancel()
    await untilFinal(statuses)
    gate.reject?.(new Error('late failure'))
    await new Promise((r) => setTimeout(r, 0))
    expect(statuses).toEqual([{ state: 'importing' }, { state: 'cancelled' }])
    expect(writes).toEqual([])
  })

  it('a reader that ignores the cancel and succeeds late writes nothing and reports nothing more', async () => {
    const gate: { resolve?: (r: { cookies: ImportedCookie[]; skipped: number }) => void } = {}
    const writes: string[] = []
    const { statuses, flow } = fakes({
      readFirefox: () =>
        new Promise<{ cookies: ImportedCookie[]; skipped: number }>((resolve) => {
          gate.resolve = resolve
        }),
      setCookie: async (_profileId, details) => {
        writes.push(details.name ?? '')
        return true
      },
    })
    flow.start('firefox-default', 'p1')
    await vi.waitFor(() => expect(gate.resolve).toBeDefined())
    flow.cancel()
    await untilFinal(statuses)
    gate.resolve?.({ cookies: [cookie('sid', 'example.com')], skipped: 0 })
    await new Promise((r) => setTimeout(r, 0))
    expect(statuses).toEqual([{ state: 'importing' }, { state: 'cancelled' }])
    expect(writes).toEqual([])
  })

  it('a start is accepted after a cancel', async () => {
    let calls = 0
    const { statuses, flow } = fakes({
      readFirefox: async () => {
        calls++
        return calls === 1 ? never<{ cookies: ImportedCookie[]; skipped: number }>() : { cookies: [cookie('sid', 'example.com')], skipped: 0 }
      },
    })
    flow.start('firefox-default', 'p1')
    await vi.waitFor(() => expect(calls).toBe(1))
    flow.cancel()
    await untilFinal(statuses)
    flow.start('firefox-default', 'p1')
    await vi.waitFor(() => expect(statuses[statuses.length - 1]).toEqual({ state: 'done', imported: 1, sites: 1, skipped: 0, notes: [OUTSIDE] }))
    expect(statuses[1]).toEqual({ state: 'cancelled' })
  })

  it('a second profile choice rejects the first one, which does not wait forever', async () => {
    let firstOutcome = ''
    let chosen = ''
    const { statuses, flow } = fakes({
      readLive: async (_source, hooks) => {
        const first = hooks.pickProfile([{ contextId: 'c1', label: 'one' }]).then(
          () => 'picked',
          (e: Error) => e.message,
        )
        chosen = await hooks.pickProfile([{ contextId: 'c2', label: 'two' }])
        firstOutcome = await first
        return { cookies: [], skipped: 0 }
      },
    })
    flow.start('chrome-live', 'p1')
    await vi.waitFor(() => expect(statuses.length).toBe(2))
    flow.pick('c2')
    await untilFinal(statuses)
    expect(firstOutcome).toBe('cancelled')
    expect(chosen).toBe('c2')
  })
})

describe('ImportFlow: a flush that fails after a cancel', () => {
  it('a flush that rejects after the cancel reports cancelled with the count and leaves no unhandled rejection', async () => {
    const names: string[] = []
    const gate: { reject?: (e: Error) => void } = {}
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const { statuses, flow } = fakes({
        // the first write is confirmed; the second never answers, so the cancel arrives while it is in progress
        setCookie: (_profileId, details) => {
          names.push(details.name ?? '')
          return names.length === 1 ? Promise.resolve(true) : never<boolean>()
        },
        // the flush starts after the cancel and fails later
        flush: () =>
          new Promise<void>((_resolve, reject) => {
            gate.reject = reject
          }),
      })
      flow.start('firefox-default', 'p1')
      await vi.waitFor(() => expect(names).toEqual(['sid', 'pref']))
      flow.cancel()
      await vi.waitFor(() => expect(gate.reject).toBeDefined())
      gate.reject?.(new Error('late flush failure'))
      await new Promise((r) => setTimeout(r, 10))
      expect(statuses).toEqual([{ state: 'importing' }, { state: 'cancelled', imported: 1 }])
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
