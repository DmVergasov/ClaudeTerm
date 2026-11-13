import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpLiveServer } from '../../src/main/chat/chat-engine'
import type { ConfiguredServer, InstalledPlugin, TabConfig } from '../../src/main/mcp/mcp-config'
import {
  RECHECK_MS,
  REPORT_LIMIT_MS,
  REPORT_POLL_MS,
  RestartCoordinator,
  SETTLE_MS,
  reloadView,
  type CoordinatorDeps,
  type ReloadCardView
} from '../../src/main/mcp/restart-coordinator'

const srv = (name: string, scope: ConfiguredServer['scope'] = 'user', config: Record<string, unknown> = { command: 'npx' }): ConfiguredServer =>
  ({ name, scope, config, approval: null, disabled: false })
const plug = (id: string, version: string, enabled: boolean): InstalledPlugin => ({ id, version, enabled })
const cfg = (servers: ConfiguredServer[] = [], plugins: InstalledPlugin[] = [], unreadable: TabConfig['unreadable'] = []): TabConfig =>
  ({ servers, plugins, unreadable })
const live = (name: string, status: McpLiveServer['status'], tools: string[] = [], error: string | null = null): McpLiveServer =>
  ({ name, status, error, version: null, scope: 'user', source: null, transport: 'stdio', target: null, tools })
const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** the fake deps: the files of each tab, its idle state and its status are plain fields the test sets */
function harness() {
  const h = {
    files: new Map<string, TabConfig>(),
    idle: new Map<string, boolean>(),
    background: new Map<string, number>(),
    touched: new Map<string, number | null>(),
    servers: new Map<string, () => Promise<McpLiveServer[] | null>>(),
    readFn: (tab: string): Promise<TabConfig | null> => Promise.resolve(h.files.get(tab) ?? cfg()),
    restarts: [] as string[],
    cards: [] as { tab: string; card: ReloadCardView | null }[],
    changed: [] as string[],
    reports: [] as { tab: string; divider: { text: string; good: string | null }; notices: { text: string; tone: 'info' | 'error' }[] }[]
  }
  const deps: CoordinatorDeps = {
    read: (tab) => h.readFn(tab),
    idle: (tab) => h.idle.get(tab) ?? true,
    background: (tab) => h.background.get(tab) ?? 0,
    touchedAt: (tab) => h.touched.get(tab) ?? null,
    restart: (tab) => {
      h.restarts.push(tab)
    },
    card: (tab, card) => {
      h.cards.push({ tab, card })
    },
    status: (tab) => (h.servers.get(tab) ?? (() => Promise.resolve([] as McpLiveServer[])))(),
    report: (tab, divider, notices) => {
      h.reports.push({ tab, divider, notices })
    },
    changed: (tab) => {
      h.changed.push(tab)
    },
    now: () => Date.now()
  }
  return { h, c: new RestartCoordinator(deps) }
}

/** the last card the coordinator gave the tab (null when it took the card away) */
function lastCard(h: ReturnType<typeof harness>['h'], tab: string): ReloadCardView | null | undefined {
  const calls = h.cards.filter((call) => call.tab === tab)
  return calls.length === 0 ? undefined : calls[calls.length - 1].card
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('RestartCoordinator', () => {
  it('a change made in this tab while it is idle restarts it once after the settle time', async () => {
    const { h, c } = harness()
    c.started('t1')
    await flush()
    h.files.set('t1', cfg([srv('context7')]))
    c.madeHere('t1')
    await flush()
    expect(h.restarts).toEqual([])
    expect(lastCard(h, 't1')).toEqual({ title: 'New MCP server: context7', text: 'The session restarts now to load it — the conversation goes on', action: 'not-now' })

    await vi.advanceTimersByTimeAsync(SETTLE_MS - 1)
    expect(h.restarts).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(h.restarts).toEqual(['t1'])
    expect(lastCard(h, 't1')).toEqual({ title: 'New MCP server: context7', text: 'The session restarts now to load it — the conversation goes on', action: null })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.restarts).toEqual(['t1'])
  })

  it('a change made by Claude during a turn waits for the turn, then restarts', async () => {
    const { h, c } = harness()
    c.started('t1')
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    h.touched.set('t1', Date.now())
    h.idle.set('t1', false)
    h.files.set('t1', cfg([srv('context7')]))
    await c.compareAll()
    await flush()
    expect(lastCard(h, 't1')).toEqual({ title: 'New MCP server: context7', text: 'The session restarts to load it when Claude finishes — the conversation goes on', action: 'not-now' })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.restarts).toEqual([])

    h.idle.set('t1', true)
    c.turnEnded('t1')
    await flush()
    expect(h.restarts).toEqual(['t1'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.restarts).toEqual(['t1'])
  })

  it('a touch of the configuration counts for the turn that made it only: a later change from outside gets the card with Restart', async () => {
    const { h, c } = harness()
    c.started('t1')
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    // Claude ran `claude mcp list` in this turn; the turn ends with no change of the configuration
    h.touched.set('t1', Date.now())
    c.turnEnded('t1')
    await flush()
    expect(h.restarts).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    // later, another chat's panel adds a server: this tab did not make it and no turn of its made it
    h.files.set('t1', cfg([srv('context7')]))
    await c.compareAll()
    await flush()
    expect(lastCard(h, 't1')).toEqual({ title: 'New MCP server: context7', text: 'Restart the session to load it — the conversation goes on', action: 'restart' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.restarts).toEqual([])
  })

  it('a tab with background tasks running gets the card with Restart and is not restarted by itself; Restart still restarts it', async () => {
    const { h, c } = harness()
    c.started('t1')
    await flush()
    h.background.set('t1', 1)
    h.files.set('t1', cfg([srv('context7')]))
    c.madeHere('t1')
    await flush()
    expect(lastCard(h, 't1')).toEqual({ title: 'New MCP server: context7', text: 'Restart the session to load it — the conversation goes on', action: 'restart' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.restarts).toEqual([])

    // the tasks end: the tab still waits for Restart
    h.background.set('t1', 0)
    c.turnEnded('t1')
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.restarts).toEqual([])

    expect(c.restartNow('t1')).toBe(true)
    await flush()
    expect(h.restarts).toEqual(['t1'])
  })

  it('several changes close together make one restart', async () => {
    const { h, c } = harness()
    c.started('t1')
    await flush()
    h.files.set('t1', cfg([srv('context7')]))
    c.madeHere('t1')
    await flush()
    await vi.advanceTimersByTimeAsync(1000)
    h.files.set('t1', cfg([srv('context7'), srv('docs')]))
    c.madeHere('t1')
    await flush()
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 1)
    expect(h.restarts).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(h.restarts).toEqual(['t1'])
    expect(lastCard(h, 't1')?.title).toBe('2 changes: context7, docs')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.restarts).toEqual(['t1'])
  })

  it('a waiting card, queued messages or a compaction keep the restart waiting', async () => {
    const { h, c } = harness()
    h.idle.set('t1', false)
    c.started('t1')
    await flush()
    h.files.set('t1', cfg([srv('context7')]))
    c.madeHere('t1')
    await flush()
    expect(lastCard(h, 't1')?.text).toBe('The session restarts to load it when Claude finishes — the conversation goes on')

    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.restarts).toEqual([])

    h.idle.set('t1', true)
    await vi.advanceTimersByTimeAsync(RECHECK_MS)
    expect(h.restarts).toEqual(['t1'])
  })

  it('another tab affected by the change gets the card with Restart and is not restarted', async () => {
    const { h, c } = harness()
    c.started('t1')
    c.started('t2')
    await flush()
    h.files.set('t1', cfg([srv('context7')]))
    h.files.set('t2', cfg([srv('context7')]))
    c.madeHere('t1')
    await flush()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(h.restarts).toEqual(['t1'])
    expect(lastCard(h, 't2')).toEqual({ title: 'New MCP server: context7', text: 'Restart the session to load it — the conversation goes on', action: 'restart' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.restarts).toEqual(['t1'])
  })

  it('a change undone before the restart takes the card away', async () => {
    const { h, c } = harness()
    c.started('t1')
    await flush()
    h.files.set('t1', cfg([srv('context7')]))
    c.madeHere('t1')
    await flush()
    await vi.advanceTimersByTimeAsync(500)
    h.files.set('t1', cfg())
    c.madeHere('t1')
    await flush()
    expect(lastCard(h, 't1')).toBeNull()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.restarts).toEqual([])
  })

  it('Not now keeps the card with Restart; restartNow restarts', async () => {
    const { h, c } = harness()
    c.started('t1')
    c.started('t2')
    await flush()
    h.files.set('t1', cfg([srv('context7')]))
    c.madeHere('t1')
    await flush()
    expect(c.notNow('t2')).toBe(false)
    expect(c.restartNow('t2')).toBe(false)

    expect(c.notNow('t1')).toBe(true)
    await flush()
    expect(lastCard(h, 't1')).toEqual({ title: 'New MCP server: context7', text: 'Restart the session to load it — the conversation goes on', action: 'restart' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.restarts).toEqual([])

    expect(c.restartNow('t1')).toBe(true)
    await flush()
    expect(h.restarts).toEqual(['t1'])
  })

  it('a restart that never starts the chat is settled to the card with Restart, and restartNow restarts again', async () => {
    const { h, c } = harness()
    c.started('t1')
    await flush()
    h.files.set('t1', cfg([srv('context7')]))
    c.madeHere('t1')
    await flush()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(h.restarts).toEqual(['t1'])

    c.restartSettled('t1')
    await flush()
    expect(lastCard(h, 't1')).toEqual({ title: 'New MCP server: context7', text: 'Restart the session to load it — the conversation goes on', action: 'restart' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.restarts).toEqual(['t1'])

    expect(c.restartNow('t1')).toBe(true)
    await flush()
    expect(h.restarts).toEqual(['t1', 't1'])
  })

  it('a restart followed by started is left alone by restartSettled', async () => {
    const { h, c } = harness()
    c.started('t1')
    await flush()
    h.files.set('t1', cfg([srv('context7')]))
    c.madeHere('t1')
    await flush()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(h.restarts).toEqual(['t1'])

    c.started('t1')
    await flush()
    const count = h.cards.length
    c.restartSettled('t1')
    await flush()
    expect(h.cards.length).toBe(count)
    expect(lastCard(h, 't1')).toBeNull()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.restarts).toEqual(['t1'])
  })

  it('a hold keeps the restart until it is released', async () => {
    const { h, c } = harness()
    c.started('t1')
    await flush()
    h.files.set('t1', cfg([srv('context7')]))
    c.hold('t1')
    c.madeHere('t1')
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.restarts).toEqual([])

    c.release('t1')
    await flush()
    expect(h.restarts).toEqual(['t1'])
  })

  it('after a restart the divider names what came up and failed servers get notices', async () => {
    const { h, c } = harness()
    c.started('t1')
    await flush()
    h.files.set('t1', cfg([srv('context7'), srv('docs')]))
    c.madeHere('t1')
    await flush()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(h.restarts).toEqual(['t1'])

    c.started('t1')
    await flush()
    expect(lastCard(h, 't1')).toBeNull()
    let call = 0
    const script = [
      [live('context7', 'pending'), live('docs', 'failed', [], 'boom')],
      [live('context7', 'pending'), live('docs', 'failed', [], 'boom')],
      [live('context7', 'connected', ['search', 'fetch']), live('docs', 'failed', [], 'boom')]
    ]
    h.servers.set('t1', () => Promise.resolve(script[Math.min(call++, script.length - 1)]))
    c.ready('t1')
    await flush()
    expect(h.reports).toEqual([])
    await vi.advanceTimersByTimeAsync(REPORT_POLL_MS)
    expect(h.reports).toEqual([])
    await vi.advanceTimersByTimeAsync(REPORT_POLL_MS)
    expect(h.reports).toEqual([
      {
        tab: 't1',
        divider: { text: 'Session restarted · context7 connected · 2 tools', good: 'context7 connected' },
        notices: [{ text: 'docs failed to start: boom', tone: 'error' }]
      }
    ])
    expect(h.changed).toContain('t1')
  })

  it('a server still pending after 20 s is still connecting', async () => {
    const { h, c } = harness()
    c.started('t1')
    await flush()
    h.files.set('t1', cfg([srv('context7')]))
    c.madeHere('t1')
    await flush()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    c.started('t1')
    await flush()
    h.servers.set('t1', () => Promise.resolve([live('context7', 'pending')]))
    c.ready('t1')
    await flush()

    await vi.advanceTimersByTimeAsync(REPORT_LIMIT_MS - 1)
    expect(h.reports).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(h.reports).toEqual([
      { tab: 't1', divider: { text: 'Session restarted', good: null }, notices: [{ text: 'context7 is still connecting', tone: 'info' }] }
    ])
  })

  it('a status that never answers gives the report at 20 s with the servers missing', async () => {
    const { h, c } = harness()
    c.started('t1')
    await flush()
    h.files.set('t1', cfg([srv('context7')]))
    c.madeHere('t1')
    await flush()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    c.started('t1')
    await flush()
    h.servers.set('t1', () => new Promise<McpLiveServer[] | null>(() => {}))
    c.ready('t1')
    await flush()

    await vi.advanceTimersByTimeAsync(REPORT_LIMIT_MS - 1)
    expect(h.reports).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(h.reports).toEqual([
      { tab: 't1', divider: { text: 'Session restarted', good: null }, notices: [{ text: 'context7 did not load', tone: 'error' }] }
    ])
  })

  it('a file change with nothing relevant shows nothing and restarts nothing', async () => {
    const { h, c } = harness()
    c.started('t1')
    await flush()
    h.files.set('t1', cfg([], [plug('docs@market', '1.0.0', false)]))
    await c.compareAll()
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.cards).toEqual([])
    expect(h.changed).toEqual([])
    expect(h.restarts).toEqual([])
  })

  it('an older read that answers last is ignored', async () => {
    const { h, c } = harness()
    c.started('t1')
    await flush()
    const older = deferred<TabConfig | null>()
    const newer = deferred<TabConfig | null>()
    const reads = [older, newer]
    h.readFn = () => reads.shift()!.promise
    c.madeHere('t1')
    c.madeHere('t1')
    newer.resolve(cfg([srv('context7')]))
    await flush()
    const shown = lastCard(h, 't1')
    expect(shown?.title).toBe('New MCP server: context7')
    const count = h.cards.length

    older.resolve(cfg())
    await flush()
    expect(h.cards.length).toBe(count)
    expect(lastCard(h, 't1')).toEqual(shown)
  })

  it('a status that answers null before the limit waits for the next answer, then reports once', async () => {
    const { h, c } = harness()
    c.started('t1')
    await flush()
    h.files.set('t1', cfg([srv('context7')]))
    c.madeHere('t1')
    await flush()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(h.restarts).toEqual(['t1'])

    c.started('t1')
    await flush()
    let call = 0
    const script: (McpLiveServer[] | null)[] = [null, [live('context7', 'connected', ['search', 'fetch'])]]
    h.servers.set('t1', () => Promise.resolve(script[Math.min(call++, script.length - 1)]))
    c.ready('t1')
    await flush()
    expect(h.reports).toEqual([])
    await vi.advanceTimersByTimeAsync(REPORT_POLL_MS)
    expect(h.reports).toEqual([
      { tab: 't1', divider: { text: 'Session restarted · context7 connected · 2 tools', good: 'context7 connected' }, notices: [] }
    ])
  })

  it('a maker comparison superseded by a file-watch comparison still restarts its tab once', async () => {
    const { h, c } = harness()
    c.started('t1')
    c.started('t2')
    await flush()
    const reads: { tab: string; answer: (config: TabConfig | null) => void }[] = []
    h.readFn = (tab) => new Promise<TabConfig | null>((resolve) => reads.push({ tab, answer: resolve }))
    c.madeHere('t1')
    const sweep = c.compareAll()
    for (const read of reads) read.answer(cfg([srv('context7')]))
    await sweep
    await flush()
    expect(h.restarts).toEqual([])

    await vi.advanceTimersByTimeAsync(SETTLE_MS - 1)
    expect(h.restarts).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(h.restarts).toEqual(['t1'])
    expect(lastCard(h, 't2')).toEqual({ title: 'New MCP server: context7', text: 'Restart the session to load it — the conversation goes on', action: 'restart' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.restarts).toEqual(['t1'])
  })

  it('a due restart whose settle time ends during an incomplete comparison restarts once the comparison is over', async () => {
    const { h, c } = harness()
    c.started('t1')
    await flush()
    h.files.set('t1', cfg([srv('context7')]))
    c.madeHere('t1')
    await flush()
    const sweep = deferred<TabConfig | null>()
    h.readFn = () => sweep.promise
    const comparing = c.compareAll()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(h.restarts).toEqual([])

    sweep.resolve(cfg([], [], ['userConfig']))
    await comparing
    await vi.advanceTimersByTimeAsync(RECHECK_MS)
    expect(h.restarts).toEqual(['t1'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.restarts).toEqual(['t1'])
  })

  it('reloadView words each kind', () => {
    const one = (kind: Parameters<typeof reloadView>[0][number]['kind'], name: string): Parameters<typeof reloadView>[0] => [{ kind, name }]
    expect(reloadView(one('server-added', 'context7'), 'manual').title).toBe('New MCP server: context7')
    expect(reloadView(one('server-removed', 'context7'), 'manual').title).toBe('MCP server removed: context7')
    expect(reloadView(one('server-changed', 'context7'), 'manual').title).toBe('MCP server changed: context7')
    expect(reloadView(one('server-approved', 'context7'), 'manual').title).toBe('MCP server approved: context7')
    expect(reloadView(one('plugin-installed', 'docs'), 'manual').title).toBe('New plugin: docs')
    expect(reloadView(one('plugin-removed', 'docs'), 'manual').title).toBe('Plugin removed: docs')
    expect(reloadView(one('plugin-updated', 'docs'), 'manual').title).toBe('Plugin updated: docs')
    expect(reloadView(one('plugin-enabled', 'docs'), 'manual').title).toBe('Plugin turned on: docs')
    expect(reloadView(one('plugin-disabled', 'docs'), 'manual').title).toBe('Plugin turned off: docs')

    expect(reloadView(one('server-removed', 'context7'), 'manual')).toEqual({ title: 'MCP server removed: context7', text: 'Restart the session to drop it — the conversation goes on', action: 'restart' })
    expect(reloadView(one('plugin-disabled', 'docs'), 'auto-later')).toEqual({ title: 'Plugin turned off: docs', text: 'The session restarts to drop it when Claude finishes — the conversation goes on', action: 'not-now' })
    expect(reloadView(one('server-added', 'context7'), 'restarting')).toEqual({ title: 'New MCP server: context7', text: 'The session restarts now to load it — the conversation goes on', action: null })

    const removals: Parameters<typeof reloadView>[0] = [
      { kind: 'server-removed', name: 'a' },
      { kind: 'plugin-disabled', name: 'b' }
    ]
    expect(reloadView(removals, 'manual')).toEqual({ title: '2 changes: a, b', text: 'Restart the session to drop them — the conversation goes on', action: 'restart' })
    const mixed: Parameters<typeof reloadView>[0] = [
      { kind: 'server-added', name: 'a' },
      { kind: 'plugin-removed', name: 'b' },
      { kind: 'plugin-updated', name: 'c' },
      { kind: 'server-changed', name: 'd' }
    ]
    expect(reloadView(mixed, 'manual')).toEqual({ title: '4 changes: a, b, c +1', text: 'Restart the session to load them — the conversation goes on', action: 'restart' })
  })

  describe('an incomplete read', () => {
    it('an unreadable file changes nothing', async () => {
      const { h, c } = harness()
      h.files.set('t1', cfg([srv('context7')]))
      c.started('t1')
      await flush()
      h.files.set('t1', cfg([srv('context7'), srv('docs')]))
      c.madeHere('t1')
      await flush()
      expect(lastCard(h, 't1')?.title).toBe('New MCP server: docs')
      const count = h.cards.length

      await vi.advanceTimersByTimeAsync(500)
      h.files.set('t1', cfg([], [], ['userConfig']))
      c.madeHere('t1')
      await flush()
      expect(h.cards.length).toBe(count)
      expect(lastCard(h, 't1')?.title).toBe('New MCP server: docs')

      await vi.advanceTimersByTimeAsync(SETTLE_MS - 500)
      expect(h.restarts).toEqual(['t1'])
    })

    it('a start read while a file was unreadable is replaced by the first complete read', async () => {
      const { h, c } = harness()
      h.files.set('t1', cfg([], [], ['userConfig']))
      c.started('t1')
      await flush()
      h.files.set('t1', cfg([srv('context7')]))
      c.madeHere('t1')
      await flush()
      expect(h.cards).toEqual([])
      await vi.advanceTimersByTimeAsync(SETTLE_MS * 2)
      expect(h.restarts).toEqual([])

      h.files.set('t1', cfg([srv('context7'), srv('docs')]))
      c.madeHere('t1')
      await flush()
      expect(lastCard(h, 't1')?.title).toBe('New MCP server: docs')
    })

    it('a read that rejects changes nothing and throws nothing', async () => {
      const { h, c } = harness()
      c.started('t1')
      await flush()
      h.readFn = () => Promise.reject(new Error('locked'))
      expect(() => c.madeHere('t1')).not.toThrow()
      await flush()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(h.cards).toEqual([])
      expect(h.restarts).toEqual([])
    })
  })
})
