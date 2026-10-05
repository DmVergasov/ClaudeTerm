import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtyHandle, SpawnOptions } from '../../src/main/pty-host'
import { TabManager, type TabEvents, type TabManagerDeps } from '../../src/main/tab-manager'

const SID_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID_B = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'

class FakePty implements PtyHandle {
  readonly pid = 1
  writes: string[] = []
  sizes: Array<[number, number]> = []
  killed = false
  constructor(readonly opts: SpawnOptions) {}
  write(d: string): void { this.writes.push(d) }
  resize(c: number, r: number): void { this.sizes.push([c, r]) }
  kill(): void { this.killed = true }
  emitData(d: string): void { this.opts.onData(d) }
  emitExit(code: number): void { this.opts.onExit(code) }
}

function setup(over: Partial<TabManagerDeps> = {}) {
  const ptys: FakePty[] = []
  const log: string[] = []
  const data: Array<[string, string]> = []
  const events: TabEvents = {
    opened: (t) => log.push(`opened:${t.id}`),
    updated: (t) => log.push(`updated:${t.id}:${t.exited}`),
    closed: (id) => log.push(`closed:${id}`),
    activated: (id) => log.push(`activated:${id}`),
    order: (ids) => log.push(`order:${ids.join(',')}`),
    data: (id, d) => data.push([id, d]),
    exit: (id, code) => log.push(`exit:${id}:${code}`)
  }
  const onStateChanged = vi.fn()
  const onTabStarted = vi.fn()
  const onTabClosed = vi.fn()
  const deps: TabManagerDeps = {
    spawn: (o) => {
      const p = new FakePty(o)
      ptys.push(p)
      return p
    },
    resolveLaunch: (req) => ({ profileName: req.profile ?? 'Windows PowerShell', spec: { file: 'powershell.exe', args: ['-NoLogo'] } }),
    baseEnv: () => ({ PATH: 'C:\\Windows' }),
    pipeName: '\\\\.\\pipe\\test',
    events,
    onStateChanged,
    onTabStarted,
    onTabClosed,
    ...over
  }
  return { tm: new TabManager(deps), ptys, log, data, onStateChanged, onTabStarted, onTabClosed }
}

afterEach(() => { vi.useRealTimers() })

describe('TabManager', () => {
  it('open spawns a PTY with the tab env and activates the tab', () => {
    const { tm, ptys, log, onStateChanged, onTabStarted } = setup()
    const tab = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    expect(ptys[0].opts).toMatchObject({ file: 'powershell.exe', args: ['-NoLogo'], cwd: 'D:\\x' })
    expect(ptys[0].opts.env).toEqual({ PATH: 'C:\\Windows', CLAUDETERM_TAB_ID: tab.id, CLAUDETERM_PIPE: '\\\\.\\pipe\\test' })
    expect(log).toEqual([`opened:${tab.id}`, `activated:${tab.id}`])
    expect(tm.activeTabId()).toBe(tab.id)
    expect(onTabStarted).toHaveBeenCalledWith(expect.objectContaining({ id: tab.id, cwd: 'D:\\x' }))
    expect(onStateChanged).toHaveBeenCalled()
  })

  it('open with activate:false does not change the active tab', () => {
    const { tm } = setup()
    const a = tm.open({ kind: 'shell', cwd: 'D:\\a' })
    tm.open({ kind: 'shell', cwd: 'D:\\b' }, { activate: false })
    expect(tm.activeTabId()).toBe(a.id)
  })

  it('a resolveLaunch failure creates no tab', () => {
    const { tm, ptys } = setup({ resolveLaunch: () => { throw new Error('no profiles') } })
    expect(() => tm.open({ kind: 'shell', cwd: 'D:\\x' })).toThrow('no profiles')
    expect(tm.list()).toEqual([])
    expect(ptys).toEqual([])
  })

  it('coalesces PTY output', () => {
    vi.useFakeTimers()
    const { tm, ptys, data } = setup()
    const tab = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    ptys[0].emitData('a')
    ptys[0].emitData('b')
    vi.advanceTimersByTime(10)
    expect(data).toEqual([[tab.id, 'ab']])
  })

  it('exit marks the tab exited; restart spawns again; writes go to the live PTY only', () => {
    const { tm, ptys, log } = setup()
    const tab = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    ptys[0].emitExit(3)
    expect(log).toContain(`exit:${tab.id}:3`)
    expect(tm.get(tab.id)?.exited).toBe(true)
    tm.write(tab.id, 'ignored')
    expect(ptys[0].writes).toEqual([])
    tm.restart(tab.id)
    expect(ptys).toHaveLength(2)
    expect(tm.get(tab.id)?.exited).toBe(false)
    tm.write(tab.id, 'dir\r')
    expect(ptys[1].writes).toEqual(['dir\r'])
    tm.restart(tab.id)
    expect(ptys).toHaveLength(2)
  })

  it('restart of a claude tab re-resolves the launch with the current session id', () => {
    const resolveLaunch = vi.fn((req: { profile?: string | null }) => ({ profileName: 'Windows PowerShell', spec: { file: 'powershell.exe', args: ['-NoLogo'] } }))
    const { tm, ptys } = setup({ resolveLaunch })
    const A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
    const B = '6e3d2c8b-9f50-4b4c-c2d3-e4f5a6b7c8d9'
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: A })
    tm.setClaudeSession(tab.id, B)
    ptys[0].emitExit(0)
    resolveLaunch.mockClear()
    tm.restart(tab.id)
    expect(resolveLaunch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: B }))
    expect(ptys).toHaveLength(2)
  })

  it('restart of a claude tab without a session id resumes nothing', () => {
    const resolveLaunch = vi.fn((req: { profile?: string | null }) => ({ profileName: 'Windows PowerShell', spec: { file: 'powershell.exe', args: ['-NoLogo'] } }))
    const { tm, ptys } = setup({ resolveLaunch })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    ptys[0].emitExit(0)
    tm.restart(tab.id)
    expect(resolveLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'claude', resumeSessionId: null }))
  })

  it('a spawn failure shows a message and marks the tab exited', () => {
    vi.useFakeTimers()
    const { tm, data, log } = setup({ spawn: () => { throw new Error('ENOENT') } })
    const tab = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    expect(log).toContain(`exit:${tab.id}:-1`)
    expect(data[0][1]).toContain('ENOENT')
  })

  it('close kills the PTY, activates the neighbour and ignores late output', () => {
    vi.useFakeTimers()
    const { tm, ptys, data, onTabClosed } = setup()
    const a = tm.open({ kind: 'shell', cwd: 'D:\\a' })
    const b = tm.open({ kind: 'shell', cwd: 'D:\\b' })
    const c = tm.open({ kind: 'shell', cwd: 'D:\\c' })
    tm.activate(b.id)
    tm.close(b.id)
    expect(ptys[1].killed).toBe(true)
    expect(onTabClosed).toHaveBeenCalledWith(b.id)
    expect(tm.activeTabId()).toBe(c.id)
    ptys[1].emitData('late')
    vi.advanceTimersByTime(10)
    expect(data.filter(([id]) => id === b.id)).toEqual([])
    tm.close(c.id)
    expect(tm.activeTabId()).toBe(a.id)
    tm.close(a.id)
    expect(tm.activeTabId()).toBeNull()
  })

  it('reorder accepts only a permutation of the current tabs', () => {
    const { tm, log } = setup()
    const a = tm.open({ kind: 'shell', cwd: 'D:\\a' })
    const b = tm.open({ kind: 'shell', cwd: 'D:\\b' })
    tm.reorder([a.id])
    tm.reorder([a.id, a.id])
    expect(tm.list().map((t) => t.id)).toEqual([a.id, b.id])
    tm.reorder([b.id, a.id])
    expect(tm.list().map((t) => t.id)).toEqual([b.id, a.id])
    expect(log).toContain(`order:${b.id},${a.id}`)
  })

  it('rename trims and empty resets to automatic title', () => {
    const { tm } = setup()
    const a = tm.open({ kind: 'shell', cwd: 'D:\\a' })
    tm.rename(a.id, '  build  ')
    expect(tm.get(a.id)?.customTitle).toBe('build')
    tm.rename(a.id, '   ')
    expect(tm.get(a.id)?.customTitle).toBeNull()
  })

  it('session ids are tracked per tab, even for two claude tabs in the same folder', () => {
    const { tm } = setup()
    const a = tm.open({ kind: 'claude', cwd: 'D:\\same' })
    const b = tm.open({ kind: 'claude', cwd: 'D:\\same' })
    const s = tm.open({ kind: 'shell', cwd: 'D:\\same' })
    expect(tm.setClaudeSession(a.id, SID_A)).toBe(true)
    expect(tm.setClaudeSession(b.id, SID_B)).toBe(true)
    expect(tm.setClaudeSession(s.id, SID_A)).toBe(false)
    expect(tm.setClaudeSession('unknown', SID_A)).toBe(false)
    expect(tm.snapshot()).toEqual([
      { kind: 'claude', profile: 'Windows PowerShell', cwd: 'D:\\same', title: null, claudeSessionId: SID_A },
      { kind: 'claude', profile: 'Windows PowerShell', cwd: 'D:\\same', title: null, claudeSessionId: SID_B },
      { kind: 'shell', profile: 'Windows PowerShell', cwd: 'D:\\same', title: null, claudeSessionId: null }
    ])
  })

  it('open with resumeSessionId and title pre-fills the tab', () => {
    const { tm } = setup()
    const t = tm.open({ kind: 'claude', cwd: 'D:\\x', title: 'mine', resumeSessionId: SID_A })
    expect(t).toMatchObject({ customTitle: 'mine', claudeSessionId: SID_A })
  })

  it('disposeAll kills everything without reporting a state change', () => {
    const { tm, ptys, onStateChanged } = setup()
    tm.open({ kind: 'shell', cwd: 'D:\\a' })
    tm.open({ kind: 'claude', cwd: 'D:\\b' })
    onStateChanged.mockClear()
    tm.disposeAll()
    expect(ptys.every((p) => p.killed)).toBe(true)
    expect(onStateChanged).not.toHaveBeenCalled()
    expect(tm.list()).toEqual([])
  })
})
