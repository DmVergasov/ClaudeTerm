import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtyHandle, SpawnOptions } from '../../src/main/pty-host'
import type { ClaudeLaunch } from '../../src/main/profiles'
import { TabManager, type ChatHandle, type ChatStartRequest, type LaunchRequest, type ResolvedLaunch, type TabEvents, type TabManagerDeps } from '../../src/main/tab-manager'

const SID_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID_B = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'

class FakePty implements PtyHandle {
  readonly pid = 1
  writes: string[] = []
  sizes: Array<[number, number]> = []
  killed = false
  /** a real process ends when it is killed; a test that wants it so sets this */
  exitsOnKill = false
  constructor(readonly opts: SpawnOptions) {}
  write(d: string): void { this.writes.push(d) }
  resize(c: number, r: number): void { this.sizes.push([c, r]) }
  kill(): void {
    this.killed = true
    if (this.exitsOnKill) this.opts.onExit(0)
  }
  emitData(d: string): void { this.opts.onData(d) }
  emitExit(code: number): void { this.opts.onExit(code) }
}

function setup(over: Partial<TabManagerDeps> = {}, opts: { exitOnKill?: boolean } = {}) {
  const ptys: FakePty[] = []
  const log: string[] = []
  const data: Array<[string, string]> = []
  const launches: LaunchRequest[] = []
  const folderChanged: Array<[string, string]> = []
  const tabFolderChanged: Array<[string, string]> = []
  const events: TabEvents = {
    opened: (t) => log.push(`opened:${t.id}`),
    updated: (t) => log.push(`updated:${t.id}:${t.exited}`),
    closed: (id) => log.push(`closed:${id}`),
    activated: (id) => log.push(`activated:${id}`),
    order: (ids) => log.push(`order:${ids.join(',')}`),
    data: (id, d) => data.push([id, d]),
    exit: (id, code) => log.push(`exit:${id}:${code}`),
    reset: (id) => log.push(`reset:${id}`)
  }
  const onStateChanged = vi.fn()
  const onTabStarted = vi.fn()
  const onTabClosed = vi.fn()
  const deps: TabManagerDeps = {
    spawn: (o) => {
      const p = new FakePty(o)
      p.exitsOnKill = opts.exitOnKill ?? false
      ptys.push(p)
      return p
    },
    resolveLaunch: (req) => {
      launches.push(req)
      return { profileName: req.profile ?? 'Windows PowerShell', spec: { file: 'powershell.exe', args: ['-NoLogo'] } }
    },
    baseEnv: () => ({ PATH: 'C:\\Windows' }),
    pipeName: '\\\\.\\pipe\\test',
    events,
    onStateChanged,
    onTabStarted,
    onTabClosed,
    onFolderChanged: (tabId, folder) => folderChanged.push([tabId, folder]),
    onTabFolderChanged: (tab) => tabFolderChanged.push([tab.id, tab.cwd]),
    ...over
  }
  return { tm: new TabManager(deps), ptys, log, data, launches, folderChanged, tabFolderChanged, onStateChanged, onTabStarted, onTabClosed }
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
    expect(log).not.toContain(`reset:${tab.id}`)
    tm.write(tab.id, 'dir\r')
    expect(ptys[1].writes).toEqual(['dir\r'])
    // a second Enter that arrives after the restart leaves the new process alone
    tm.restart(tab.id)
    expect(ptys).toHaveLength(2)
    expect(ptys[1].killed).toBe(false)
  })

  it('restart of a claude tab re-resolves the launch with the current session id', async () => {
    const resolveLaunch = vi.fn((req: { profile?: string | null }) => ({ profileName: 'Windows PowerShell', spec: { file: 'powershell.exe', args: ['-NoLogo'] } }))
    const { tm, ptys } = setup({ resolveLaunch })
    const A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
    const B = '6e3d2c8b-9f50-4b4c-c2d3-e4f5a6b7c8d9'
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: A })
    tm.setClaudeSession(tab.id, B)
    ptys[0].emitExit(0)
    resolveLaunch.mockClear()
    await tm.restart(tab.id)
    expect(resolveLaunch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: B }))
    expect(ptys).toHaveLength(2)
  })

  it('restart of a claude tab without a session id resumes nothing', async () => {
    const resolveLaunch = vi.fn((req: { profile?: string | null }) => ({ profileName: 'Windows PowerShell', spec: { file: 'powershell.exe', args: ['-NoLogo'] } }))
    const { tm, ptys } = setup({ resolveLaunch })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    ptys[0].emitExit(0)
    await tm.restart(tab.id)
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

  it('setMuted mutes and unmutes a tab, tells the window and saves the state; the snapshot keeps it', () => {
    const { tm, log, onStateChanged } = setup()
    const a = tm.open({ kind: 'shell', cwd: 'D:\\a' })
    expect(a.muted).toBe(false)
    log.length = 0
    onStateChanged.mockClear()
    tm.setMuted(a.id, true)
    expect(tm.get(a.id)?.muted).toBe(true)
    expect(log).toEqual([`updated:${a.id}:false`])
    expect(onStateChanged).toHaveBeenCalledTimes(1)
    expect(tm.snapshot()[0]).toMatchObject({ muted: true })
    tm.setMuted(a.id, true)
    expect(log).toHaveLength(1)
    tm.setMuted(a.id, false)
    expect(tm.get(a.id)?.muted).toBe(false)
    expect(onStateChanged).toHaveBeenCalledTimes(2)
    tm.setMuted('unknown', true)
    expect(onStateChanged).toHaveBeenCalledTimes(2)
  })

  it('setFolder follows the folder Claude moved to, tells the window, and leaves the folder the conversation resumes in', () => {
    const onFolderChanged = vi.fn()
    const { tm, log } = setup({ onFolderChanged })
    const t = tm.open({ kind: 'claude', cwd: 'D:\\repo', resumeSessionId: SID_A })
    expect(t.folder).toBe('D:\\repo')
    log.length = 0
    tm.setFolder(t.id, 'D:\\repo\\.claude\\worktrees\\feat')
    expect(tm.get(t.id)).toMatchObject({ cwd: 'D:\\repo', folder: 'D:\\repo\\.claude\\worktrees\\feat' })
    expect(log).toEqual([`updated:${t.id}:false`])
    expect(onFolderChanged).toHaveBeenCalledWith(t.id, 'D:\\repo\\.claude\\worktrees\\feat')
    expect(tm.snapshot()[0]).toMatchObject({ cwd: 'D:\\repo' })
    // the same folder again, or an unknown tab, changes nothing
    tm.setFolder(t.id, 'D:\\repo\\.claude\\worktrees\\feat')
    tm.setFolder('unknown', 'D:\\other')
    expect(log).toHaveLength(1)
    expect(onFolderChanged).toHaveBeenCalledTimes(1)
  })

  it('setFolder reports to onFolderChanged only; changeFolder reports to both, and a restart back to cwd to onFolderChanged only', async () => {
    const { tm, folderChanged, tabFolderChanged } = setup({ restartWaitMs: 0 }, { exitOnKill: true })
    const t = tm.open({ kind: 'claude', cwd: '/a', resumeSessionId: SID_A })
    tm.setFolder(t.id, '/a/sub')
    expect(folderChanged).toEqual([[t.id, '/a/sub']])
    expect(tabFolderChanged).toEqual([])
    expect(await tm.changeFolder(t.id, '/b')).toBe(true)
    expect(folderChanged).toEqual([[t.id, '/a/sub'], [t.id, '/b']])
    expect(tabFolderChanged).toEqual([[t.id, '/b']])
    // Claude Code moves back to the tab's folder: the tab's own reset does not run
    tm.setFolder(t.id, '/b/sub')
    await tm.restart(t.id, { live: true })
    expect(folderChanged.at(-1)).toEqual([t.id, '/b'])
    expect(tabFolderChanged).toEqual([[t.id, '/b']])
  })

  it('a restart starts Claude in the folder the tab was opened in, and the tab shows that folder again', async () => {
    const onFolderChanged = vi.fn()
    const { tm, ptys } = setup({ onFolderChanged, restartWaitMs: 0 }, { exitOnKill: true })
    const t = tm.open({ kind: 'claude', cwd: 'D:\\repo', resumeSessionId: SID_A })
    tm.setFolder(t.id, 'D:\\repo\\.claude\\worktrees\\feat')
    await tm.restart(t.id, { live: true })
    expect(ptys).toHaveLength(2)
    expect(ptys[1]!.opts.cwd).toBe('D:\\repo')
    expect(tm.get(t.id)?.folder).toBe('D:\\repo')
    expect(onFolderChanged).toHaveBeenLastCalledWith(t.id, 'D:\\repo')
  })

  it('a tab opened muted stays muted through a restart', async () => {
    const { tm, ptys } = setup({ restartWaitMs: 0 }, { exitOnKill: true })
    const t = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A, muted: true })
    expect(t.muted).toBe(true)
    await tm.restart(t.id, { live: true })
    expect(ptys).toHaveLength(2)
    expect(tm.get(t.id)?.muted).toBe(true)
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
      { kind: 'claude', profile: 'Windows PowerShell', cwd: 'D:\\same', title: null, claudeSessionId: SID_A, account: null, muted: false, working: false, background: false, fork: null, view: 'terminal' },
      { kind: 'claude', profile: 'Windows PowerShell', cwd: 'D:\\same', title: null, claudeSessionId: SID_B, account: null, muted: false, working: false, background: false, fork: null, view: 'terminal' },
      { kind: 'shell', profile: 'Windows PowerShell', cwd: 'D:\\same', title: null, claudeSessionId: null, account: null, muted: false, working: false, background: false, fork: null, view: null }
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

  it('restart of a running tab kills its process, resets the terminal, then starts again; the old process is ignored', async () => {
    const { tm, ptys, log, data } = setup({ flushMs: 0 })
    const tab = tm.open({ kind: 'shell', cwd: 'D:\\x', profile: 'Git Bash' })
    const done = tm.restart(tab.id, { live: true })
    expect(ptys[0].killed).toBe(true)
    expect(log).toContain(`reset:${tab.id}`)
    expect(ptys).toHaveLength(1)
    ptys[0].emitData('late output')
    ptys[0].emitExit(1)
    await done
    expect(ptys).toHaveLength(2)
    expect(ptys[1].opts).toMatchObject({ cwd: 'D:\\x', env: expect.objectContaining({ CLAUDETERM_TAB_ID: tab.id }) })
    expect(log).not.toContain(`exit:${tab.id}:1`)
    expect(tm.get(tab.id)).toMatchObject({ id: tab.id, exited: false, profile: 'Git Bash' })
    tm.write(tab.id, 'ls\r')
    expect(ptys[1].writes).toEqual(['ls\r'])
    await new Promise((r) => setTimeout(r, 5))
    expect(data).toEqual([])
  })

  it('whether Claude is working goes into the snapshot of a claude tab; a shell tab, or no change, saves nothing', () => {
    const { tm, onStateChanged } = setup()
    const claude = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    const shell = tm.open({ kind: 'shell', cwd: 'D:\\y' })
    expect(tm.snapshot().map((t) => t.working)).toEqual([false, false])
    onStateChanged.mockClear()
    tm.setWorking(claude.id, true)
    tm.setWorking(claude.id, true)
    tm.setWorking(shell.id, true)
    expect(onStateChanged).toHaveBeenCalledTimes(1)
    expect(tm.snapshot().map((t) => t.working)).toEqual([true, false])
    tm.setWorking(claude.id, false)
    expect(tm.snapshot().map((t) => t.working)).toEqual([false, false])
  })

  it('a Claude tab is working through a turn and while its agents outlast the turn, and idle after', () => {
    const { tm, log } = setup()
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    const shell = tm.open({ kind: 'shell', cwd: 'D:\\y' })
    const activity = (): string | null => tm.get(tab.id)!.activity
    const updates = (): number => log.filter((l) => l.startsWith(`updated:${tab.id}:`)).length
    expect(tab.activity).toBeNull()

    tm.setWorking(tab.id, true)
    expect(activity()).toBe('working')
    expect(updates()).toBe(1)
    // a subagent of the turn changes nothing the window shows
    tm.setAgentsRunning(tab.id, true)
    expect(activity()).toBe('working')
    expect(updates()).toBe(1)
    // the turn ended, and the agent it left still runs: Claude Code waits for it, and the work goes on
    tm.setWorking(tab.id, false)
    expect(activity()).toBe('working')
    expect(updates()).toBe(1)
    tm.setAgentsRunning(tab.id, false)
    expect(activity()).toBeNull()
    expect(updates()).toBe(2)

    // an agent Claude starts with no turn running (a task notification's turn already ended) is work too
    tm.setAgentsRunning(tab.id, true)
    expect(activity()).toBe('working')
    tm.setAgentsRunning(tab.id, false)
    expect(activity()).toBeNull()

    tm.setWorking(shell.id, true)
    tm.setAgentsRunning(shell.id, true)
    expect(tm.get(shell.id)!.activity).toBeNull()
  })

  it('a tab whose process exits in a turn is not working, nor is the process a restart starts', async () => {
    const { tm, ptys } = setup()
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    tm.setWorking(tab.id, true)
    tm.setAgentsRunning(tab.id, true)
    ptys[0].emitExit(1)
    expect(tm.get(tab.id)!.activity).toBeNull()
    // the snapshot still has the turn that was cut off: a restore goes on with it
    expect(tm.snapshot()[0].working).toBe(true)

    await tm.restart(tab.id)
    expect(ptys).toHaveLength(2)
    expect(tm.get(tab.id)!.activity).toBeNull()
    expect(tm.snapshot()[0].working).toBe(false)
  })

  it('whether work Claude left in the background still runs goes into the snapshot of a claude tab; a shell tab, or no change, saves nothing', () => {
    const { tm, onStateChanged } = setup()
    const claude = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    const shell = tm.open({ kind: 'shell', cwd: 'D:\\y' })
    expect(tm.snapshot().map((t) => t.background)).toEqual([false, false])
    onStateChanged.mockClear()
    tm.setBackgroundWork(claude.id, true)
    tm.setBackgroundWork(claude.id, true)
    tm.setBackgroundWork(shell.id, true)
    expect(onStateChanged).toHaveBeenCalledTimes(1)
    expect(tm.snapshot().map((t) => t.background)).toEqual([true, false])
    tm.setBackgroundWork(claude.id, false)
    expect(tm.snapshot().map((t) => t.background)).toEqual([false, false])
  })

  it('a restart, of a running or an exited tab, says so before the new process starts', async () => {
    const onTabRestarting = vi.fn()
    const { tm, ptys } = setup({ onTabRestarting })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    const done = tm.restart(tab.id, { live: true })
    // a Claude tab's conversation is checked on disk first: the restart is announced once that answers
    await vi.waitFor(() => expect(onTabRestarting).toHaveBeenCalledWith(tab.id))
    expect(ptys).toHaveLength(1)
    ptys[0].emitExit(0)
    await done
    ptys[1].emitExit(0)
    await tm.restart(tab.id)
    expect(onTabRestarting).toHaveBeenCalledTimes(2)
    expect(ptys).toHaveLength(3)
  })

  it('restart of a running claude tab resumes the current conversation', async () => {
    const resolveLaunch = vi.fn((req: { profile?: string | null }) => ({ profileName: 'Windows PowerShell', spec: { file: 'powershell.exe', args: ['-NoLogo'] } }))
    const { tm, ptys } = setup({ resolveLaunch })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A })
    tm.setClaudeSession(tab.id, SID_B)
    const done = tm.restart(tab.id, { live: true })
    ptys[0].emitExit(0)
    await done
    expect(resolveLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_B }))
    expect(ptys).toHaveLength(2)
  })

  it('restart waits at most restartWaitMs for a process that does not exit', async () => {
    vi.useFakeTimers()
    const { tm, ptys } = setup({ restartWaitMs: 3000 })
    const tab = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    const done = tm.restart(tab.id, { live: true })
    await vi.advanceTimersByTimeAsync(2999)
    expect(ptys).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(ptys).toHaveLength(2)
  })

  it('a second restart while one is under way does nothing, and a tab closed meanwhile is not started', async () => {
    const { tm, ptys } = setup()
    const tab = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    const first = tm.restart(tab.id, { live: true })
    const second = tm.restart(tab.id, { live: true })
    ptys[0].emitExit(0)
    await Promise.all([first, second])
    expect(ptys).toHaveLength(2)
    const again = tm.restart(tab.id, { live: true })
    tm.close(tab.id)
    ptys[1].emitExit(0)
    await again
    expect(ptys).toHaveLength(2)
  })

  it('a claude conversation that was never saved restarts as a new one', async () => {
    const resolveLaunch = vi.fn((req: { profile?: string | null }) => ({ profileName: 'Windows PowerShell', spec: { file: 'powershell.exe', args: ['-NoLogo'] } }))
    const resumable = vi.fn(async () => false)
    const { tm, ptys } = setup({ resolveLaunch, resumable })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    tm.setClaudeSession(tab.id, SID_A)
    const done = tm.restart(tab.id, { live: true })
    ptys[0].emitExit(0)
    await done
    expect(resumable).toHaveBeenCalledWith(tab.id, SID_A)
    expect(resolveLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'claude', resumeSessionId: null }))
  })

  it('disposeAll during a restart starts nothing', async () => {
    const { tm, ptys } = setup()
    const tab = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    const done = tm.restart(tab.id, { live: true })
    tm.disposeAll()
    ptys[0].emitExit(0)
    await done
    expect(ptys).toHaveLength(1)
  })

  it('changeFolder restarts the tab in the new folder; a Claude tab starts a new conversation', async () => {
    const { tm, ptys, launches, folderChanged, log } = setup({ restartWaitMs: 0 }, { exitOnKill: true })
    const t = tm.open({ kind: 'claude', cwd: '/a', resumeSessionId: SID_A })
    expect(await tm.changeFolder(t.id, '/b')).toBe(true)
    expect(ptys.at(-1)!.opts.cwd).toBe('/b')
    expect(launches.at(-1)).toMatchObject({ kind: 'claude', cwd: '/b', resumeSessionId: null })
    expect(tm.get(t.id)).toMatchObject({ cwd: '/b', claudeSessionId: null })
    expect(folderChanged).toEqual([[t.id, '/b']])
    expect(log).toContain(`reset:${t.id}`)
  })

  it('changeFolder of a shell tab keeps its profile; of an unknown tab answers false, and so does a tab that is restarting', async () => {
    const { tm, ptys, launches } = setup({ restartWaitMs: 0 }, { exitOnKill: true })
    const t = tm.open({ kind: 'shell', cwd: '/a', profile: 'Bash' })
    expect(await tm.changeFolder('nope', '/b')).toBe(false)
    const done = tm.restart(t.id, { live: true })
    expect(await tm.changeFolder(t.id, '/c')).toBe(false)
    await done
    expect(await tm.changeFolder(t.id, '/b')).toBe(true)
    expect(launches.at(-1)).toMatchObject({ kind: 'shell', cwd: '/b', profile: 'Bash' })
    expect(tm.get(t.id)).toMatchObject({ cwd: '/b', profile: 'Bash' })
    expect(ptys.at(-1)!.opts.cwd).toBe('/b')
  })

  it('changeFolder during a pending check of the conversation answers false and changes nothing (R8)', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((r) => { release = r })
    const { tm, launches } = setup({ restartWaitMs: 0, resumable: async () => { await gate; return true } })
    const t = tm.open({ kind: 'claude', cwd: '/a', resumeSessionId: SID_A })
    const pending = tm.restart(t.id, { live: true })
    const launchesBefore = launches.length
    expect(await tm.changeFolder(t.id, '/b')).toBe(false)
    expect(tm.get(t.id)).toMatchObject({ cwd: '/a', claudeSessionId: SID_A })
    expect(launches).toHaveLength(launchesBefore)
    release()
    await pending
  })

  it('a fork that moves to another folder starts a conversation of its own there: its from is null after the change (R8)', async () => {
    const { tm, launches } = setup({ restartWaitMs: 0 })
    const head = tm.open({ kind: 'claude', cwd: '/a', resumeSessionId: SID_A })
    const fork = tm.open({ kind: 'claude', cwd: '/a', fork: { of: head.id, from: SID_B } })
    expect(await tm.changeFolder(fork.id, '/b')).toBe(true)
    expect(tm.get(fork.id)?.fork).toEqual({ of: head.id, from: null })
    expect(launches.at(-1)).toMatchObject({ cwd: '/b', fork: { of: head.id, from: null } })
  })

  it('changeFolder reports the tab once to the window when the folder changes (R9)', async () => {
    const { tm, log } = setup({ restartWaitMs: 0 })
    const t = tm.open({ kind: 'claude', cwd: '/a', resumeSessionId: SID_A })
    log.length = 0
    expect(await tm.changeFolder(t.id, '/b')).toBe(true)
    expect(log.filter((l) => l === `updated:${t.id}:false`)).toHaveLength(1)
  })

  it('size and deactivate: deactivate tells nobody and leaves no tab in front', () => {
    const { tm, log } = setup()
    const t = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    expect(tm.size(t.id)).toEqual({ cols: 120, rows: 30 })
    tm.resize(t.id, 90, 20)
    expect(tm.size(t.id)).toEqual({ cols: 90, rows: 20 })
    expect(tm.size('nope')).toBeNull()
    tm.setWorking(t.id, true)
    log.length = 0
    tm.deactivate()
    expect(log).toEqual([])
    expect(tm.activeTabId()).toBeNull()
  })

  it('a resize to the size the PTY already has does not reach the PTY', () => {
    const { tm, ptys } = setup()
    const t = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    expect(ptys.at(-1)!.opts.cols).toBe(120)
    tm.resize(t.id, 100, 30)
    tm.resize(t.id, 100, 30)
    expect(ptys.at(-1)!.sizes).toEqual([[100, 30]])
    tm.resize(t.id, 101, 30)
    expect(ptys.at(-1)!.sizes).toEqual([[100, 30], [101, 30]])
  })
})

describe('TabManager accounts', () => {
  const SPEC = { file: 'powershell.exe', args: ['-NoLogo'] }
  /** knows the accounts "work" and "home" (unless gone); any other one falls back to the main account, or throws when strict */
  function accountLaunches(gone: Set<string> = new Set()) {
    return vi.fn((req: LaunchRequest): ResolvedLaunch => {
      const usable = req.account !== null && ['work', 'home'].includes(req.account) && !gone.has(req.account)
      if (req.account !== null && !usable && req.strict) throw new Error('account not available')
      const account = usable ? req.account : null
      return { profileName: 'Windows PowerShell', spec: SPEC, account, env: account ? { set: { CLAUDE_CODE_OAUTH_TOKEN: `token-${account}` }, unset: ['ANTHROPIC_API_KEY'] } : undefined }
    })
  }

  it('a claude tab on an account gets its token instead of the API key; the main account keeps the environment', () => {
    const { tm, ptys } = setup({ resolveLaunch: accountLaunches(), baseEnv: () => ({ PATH: 'C:\\Windows', ANTHROPIC_API_KEY: 'key' }) })
    const main = tm.open({ kind: 'claude', cwd: 'D:\\x', account: null })
    const work = tm.open({ kind: 'claude', cwd: 'D:\\x', account: 'work' })
    expect(main.account).toBeNull()
    expect(ptys[0].opts.env).toEqual({ PATH: 'C:\\Windows', ANTHROPIC_API_KEY: 'key', CLAUDETERM_TAB_ID: main.id, CLAUDETERM_PIPE: '\\\\.\\pipe\\test' })
    expect(work.account).toBe('work')
    expect(ptys[1].opts.env).toEqual({ PATH: 'C:\\Windows', CLAUDE_CODE_OAUTH_TOKEN: 'token-work', CLAUDETERM_TAB_ID: work.id, CLAUDETERM_PIPE: '\\\\.\\pipe\\test' })
  })

  it('a new claude tab takes the account of the active claude tab unless one is asked for', () => {
    const resolveLaunch = accountLaunches()
    const { tm } = setup({ resolveLaunch })
    const work = tm.open({ kind: 'claude', cwd: 'D:\\x', account: 'work' })
    expect(tm.open({ kind: 'claude', cwd: 'D:\\x' }).account).toBe('work')
    expect(tm.open({ kind: 'claude', cwd: 'D:\\x', account: null }).account).toBeNull()
    tm.activate(work.id)
    expect(tm.open({ kind: 'claude', cwd: 'D:\\x', account: 'home' }).account).toBe('home')
    // a shell tab in front: the main account
    tm.open({ kind: 'shell', cwd: 'D:\\x' })
    expect(tm.open({ kind: 'claude', cwd: 'D:\\x' }).account).toBeNull()
    expect(resolveLaunch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'shell', account: null }))
  })

  it('an account that cannot be used starts the tab on the main account', () => {
    const { tm, ptys } = setup({ resolveLaunch: accountLaunches() })
    const t = tm.open({ kind: 'claude', cwd: 'D:\\x', account: 'gone' })
    expect(t.account).toBeNull()
    expect(ptys[0].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  it('switchAccount restarts the tab on the new account and resumes the current conversation', async () => {
    const resolveLaunch = accountLaunches()
    const { tm, ptys, log } = setup({ resolveLaunch })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A, account: null })
    tm.setClaudeSession(tab.id, SID_B)
    const done = tm.switchAccount(tab.id, 'work')
    // the conversation is checked on disk first: the old process is stopped once that answers
    await vi.waitFor(() => expect(ptys[0].killed).toBe(true))
    expect(log).toContain(`reset:${tab.id}`)
    ptys[0].emitExit(0)
    expect(await done).toBe(true)
    expect(ptys).toHaveLength(2)
    expect(ptys[1].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-work')
    expect(resolveLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_B, account: 'work', strict: true }))
    expect(tm.get(tab.id)?.account).toBe('work')
    expect(tm.snapshot()[0]).toMatchObject({ account: 'work', claudeSessionId: SID_B })
  })

  it('switchAccount to an account that cannot be used leaves the tab running as it was', async () => {
    const { tm, ptys, onStateChanged } = setup({ resolveLaunch: accountLaunches() })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x', account: 'work' })
    onStateChanged.mockClear()
    expect(await tm.switchAccount(tab.id, 'gone')).toBe(false)
    expect(ptys).toHaveLength(1)
    expect(ptys[0].killed).toBe(false)
    expect(tm.get(tab.id)?.account).toBe('work')
    expect(onStateChanged).not.toHaveBeenCalled()
  })

  it('switchAccount of an exited tab starts it on the new account; a shell tab has no account to switch', async () => {
    const { tm, ptys } = setup({ resolveLaunch: accountLaunches() })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x', account: null })
    ptys[0].emitExit(0)
    expect(await tm.switchAccount(tab.id, 'home')).toBe(true)
    expect(ptys).toHaveLength(2)
    expect(tm.get(tab.id)).toMatchObject({ account: 'home', exited: false })
    const shell = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    expect(await tm.switchAccount(shell.id, 'work')).toBe(false)
    expect(ptys).toHaveLength(3)
  })

  it('a second switch while one is under way does nothing', async () => {
    const { tm, ptys } = setup({ resolveLaunch: accountLaunches() })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x', account: null })
    const first = tm.switchAccount(tab.id, 'work')
    const second = tm.switchAccount(tab.id, 'home')
    ptys[0].emitExit(0)
    expect(await Promise.all([first, second])).toEqual([true, false])
    expect(ptys).toHaveLength(2)
    expect(tm.get(tab.id)?.account).toBe('work')
  })

  it('restart keeps the account; an account gone meanwhile restarts the tab on the main one', async () => {
    const gone = new Set<string>()
    const { tm, ptys, log } = setup({ resolveLaunch: accountLaunches(gone) })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x', account: 'work' })
    const first = tm.restart(tab.id, { live: true })
    ptys[0].emitExit(0)
    await first
    expect(ptys[1].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-work')
    gone.add('work')
    log.length = 0
    const second = tm.restart(tab.id, { live: true })
    ptys[1].emitExit(0)
    await second
    expect(ptys[2].opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(tm.get(tab.id)?.account).toBeNull()
    expect(log).toContain(`updated:${tab.id}:false`)
  })

  it('the Get a token tab is asked for in the launch request', () => {
    const resolveLaunch = accountLaunches()
    const { tm } = setup({ resolveLaunch })
    const t = tm.open({ kind: 'shell', cwd: 'D:\\x', title: 'Get a token' }, { setupToken: true })
    expect(resolveLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'shell', setupToken: true, account: null }))
    expect(t).toMatchObject({ kind: 'shell', customTitle: 'Get a token', account: null })
  })
})

describe('TabManager forks', () => {
  const forkSetup = (over: Partial<TabManagerDeps> = {}) => {
    const resolveLaunch = vi.fn((req: LaunchRequest): ResolvedLaunch => ({ profileName: 'Windows PowerShell', spec: { file: 'powershell.exe', args: ['-NoLogo'] }, account: req.account }))
    return { ...setup({ resolveLaunch, resumable: async () => true, ...over }), resolveLaunch }
  }

  it('fork opens a Claude tab in the parent folder and account, with no session id, launched to fork the parent conversation', async () => {
    const { tm, resolveLaunch } = forkSetup()
    const parent = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A, account: 'work' })
    const fork = (await tm.fork(parent.id))
    expect(fork).toMatchObject({ kind: 'claude', cwd: 'D:\\x', account: 'work', claudeSessionId: null, fork: { of: parent.id, from: SID_A } })
    expect(resolveLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'claude', account: 'work', fork: { of: parent.id, from: SID_A } }))
    expect(resolveLaunch.mock.lastCall?.[0].resumeSessionId ?? null).toBeNull()
  })

  it('a fork of a renamed tab starts with its name and (fork); an unnamed parent gives an unnamed fork', async () => {
    const { tm } = forkSetup()
    const parent = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A, title: 'auth refactor' })
    expect((await tm.fork(parent.id))?.customTitle).toBe('auth refactor (fork)')
    const plain = tm.open({ kind: 'claude', cwd: 'D:\\y', resumeSessionId: SID_A })
    expect((await tm.fork(plain.id))?.customTitle).toBeNull()
  })

  it('a fork of a tab already named (fork) keeps that name, without a second (fork)', async () => {
    const { tm } = forkSetup()
    const parent = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A, title: 'auth refactor (fork)' })
    expect((await tm.fork(parent.id))?.customTitle).toBe('auth refactor (fork)')
  })

  it('canFork asks the transcript check about the conversation, and only for a Claude tab that has one', async () => {
    const check = vi.fn(async (_sessionId: string) => true)
    const { tm } = forkSetup({ resumable: check })
    const shell = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    const fresh = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    const saved = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A })
    expect(await tm.canFork(shell.id)).toBe(false)
    expect(await tm.canFork(fresh.id)).toBe(false)
    expect(check).not.toHaveBeenCalled()
    expect(await tm.canFork(saved.id)).toBe(true)
    expect(check).toHaveBeenCalledWith(saved.id, SID_A)
  })

  it('a fork asked with activate: false opens after its family and leaves the tab in front where it is', async () => {
    const { tm, log } = forkSetup()
    const A = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A })
    const B = tm.open({ kind: 'shell', cwd: 'D:\\y' })
    tm.activate(B.id)
    log.length = 0
    const A1 = (await tm.fork(A.id, { activate: false }))!
    expect(tm.list().map((t) => t.id)).toEqual([A.id, A1.id, B.id])
    expect(log.some((l) => l.startsWith('activated:'))).toBe(false)
    expect(tm.activeTabId()).toBe(B.id)
  })

  it('a fork stands right after its family, and a fork of a fork joins the family', async () => {
    const { tm, log } = forkSetup()
    const A = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A })
    const B = tm.open({ kind: 'claude', cwd: 'D:\\y' })
    const A1 = (await tm.fork(A.id))!
    expect(tm.list().map((t) => t.id)).toEqual([A.id, A1.id, B.id])
    expect(log).toContain(`order:${A.id},${A1.id},${B.id}`)
    tm.setClaudeSession(A1.id, SID_B)
    const A2 = (await tm.fork(A1.id))!
    expect(tm.list().map((t) => t.id)).toEqual([A.id, A1.id, A2.id, B.id])
    expect(A2.fork?.of).toBe(A.id)
  })

  it('a fork whose head is gone is an ordinary tab, and opens at the end', async () => {
    const { tm, log } = forkSetup()
    const A = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A })
    const B = tm.open({ kind: 'claude', cwd: 'D:\\y' })
    tm.close(A.id)
    const orphan = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A, fork: { of: 'gone', from: SID_A } }, { activate: false })
    expect(orphan.fork).toEqual({ of: null, from: SID_A })
    expect(tm.list().map((t) => t.id)).toEqual([B.id, orphan.id])
    expect(log.filter((l) => l.startsWith('order:'))).toEqual([])
  })

  it('canFork is false for a shell tab, a Claude tab without a session, and one whose conversation cannot be resumed', async () => {
    const { tm } = forkSetup()
    const shell = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    const fresh = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    const saved = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A })
    expect([(await tm.canFork(shell.id)), (await tm.canFork(fresh.id)), (await tm.canFork(saved.id))]).toEqual([false, false, true])
    expect((await tm.fork(shell.id))).toBeNull()
    expect((await tm.fork(fresh.id))).toBeNull()
    const { tm: unresumable } = forkSetup({ resumable: async () => false })
    const tab = unresumable.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A })
    expect((await unresumable.canFork(tab.id))).toBe(false)
    expect((await unresumable.fork(tab.id))).toBeNull()
  })

  it('closing the head turns its forks into ordinary tabs; closing a fork leaves the family', async () => {
    const { tm, log } = forkSetup()
    const A = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A })
    const A1 = (await tm.fork(A.id))!
    tm.setClaudeSession(A1.id, SID_A)
    const A2 = (await tm.fork(A1.id))!
    tm.close(A1.id)
    expect(tm.get(A2.id)?.fork).toEqual({ of: A.id, from: SID_A })
    log.length = 0
    tm.close(A.id)
    expect(tm.get(A2.id)?.fork).toEqual({ of: null, from: SID_A })
    expect(log).toContain(`updated:${A2.id}:false`)
  })

  it('restart of a fork without its own conversation forks again; with one it resumes it', async () => {
    const { tm, ptys, resolveLaunch } = forkSetup()
    const A = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A })
    const F = (await tm.fork(A.id))!
    ptys[1].emitExit(0)
    await tm.restart(F.id)
    expect(resolveLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'claude', fork: { of: A.id, from: SID_A } }))
    expect(resolveLaunch.mock.lastCall?.[0].resumeSessionId ?? null).toBeNull()
    tm.setClaudeSession(F.id, SID_B)
    ptys[2].emitExit(0)
    await tm.restart(F.id)
    expect(resolveLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'claude', resumeSessionId: SID_B }))
  })

  it('a fork that got a conversation of its own (/clear) is not forked again: a restart before its first message starts a new one', async () => {
    const SID_C = 'a3c2cf68-2929-4166-9a00-000000000001'
    // the cleared conversation has no transcript before its first message
    const { tm, ptys, resolveLaunch } = forkSetup({ resumable: async (_tabId, sessionId) => sessionId !== SID_C })
    const A = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A })
    const F = (await tm.fork(A.id))!
    // Claude's copy of the conversation keeps the fork able to fork again
    tm.setClaudeSession(F.id, SID_B, 'fork')
    expect(tm.get(F.id)?.fork).toEqual({ of: A.id, from: SID_A })
    tm.setClaudeSession(F.id, SID_C, 'clear')
    expect(tm.get(F.id)?.fork).toEqual({ of: A.id, from: null })
    expect(tm.snapshot()[1].fork).toEqual({ of: 0, from: null })
    ptys[1].emitExit(0)
    await tm.restart(F.id)
    expect(resolveLaunch.mock.lastCall?.[0]).toMatchObject({ kind: 'claude', resumeSessionId: null, fork: { of: A.id, from: null } })
  })

  it('a restored fork joins its head wherever the two stand, and keeps its place in the order', () => {
    const { tm, log } = forkSetup()
    // opened as Restore opens them: in the saved order, the forks without their head yet
    const F1 = tm.open({ kind: 'claude', cwd: 'D:\\x', fork: { of: null, from: SID_A } }, { activate: false })
    const S = tm.open({ kind: 'shell', cwd: 'D:\\x' }, { activate: false })
    const H = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A }, { activate: false })
    const F2 = tm.open({ kind: 'claude', cwd: 'D:\\x', fork: { of: null, from: SID_A } }, { activate: false })
    log.length = 0
    tm.joinFamily(F1.id, H.id)
    tm.joinFamily(F2.id, H.id)
    expect(tm.list().map((t) => t.id)).toEqual([F1.id, S.id, H.id, F2.id])
    expect([tm.get(F1.id)?.fork, tm.get(F2.id)?.fork]).toEqual([{ of: H.id, from: SID_A }, { of: H.id, from: SID_A }])
    expect(log).toContain(`updated:${F1.id}:false`)
    expect(tm.snapshot().map((t) => t.fork?.of ?? null)).toEqual([2, null, null, 2])
    // a shell tab, a fork with a head, the tab itself and a closed tab are no heads
    const F3 = tm.open({ kind: 'claude', cwd: 'D:\\x', fork: { of: null, from: SID_A } }, { activate: false })
    for (const head of [S.id, F1.id, F3.id, 'gone']) tm.joinFamily(F3.id, head)
    expect(tm.get(F3.id)?.fork).toEqual({ of: null, from: SID_A })
  })

  it('snapshot keeps a fork\'s head as an index', async () => {
    const { tm } = forkSetup()
    const A = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A })
    await tm.fork(A.id)
    expect(tm.snapshot()[1].fork).toEqual({ of: 0, from: SID_A })
    tm.close(A.id)
    expect(tm.snapshot()[0].fork).toEqual({ of: null, from: SID_A })
  })

  it('fork, restart and switchAccount wait for the transcript check: a conversation it finds missing is neither forked nor resumed', async () => {
    const { tm, ptys, resolveLaunch } = forkSetup({ resumable: async () => false, restartWaitMs: 0 })
    const A = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A })
    expect(await tm.fork(A.id)).toBeNull()
    expect(tm.list()).toHaveLength(1)

    ptys[0].emitExit(0)
    await tm.restart(A.id)
    expect(resolveLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'claude', resumeSessionId: null }))

    expect(await tm.switchAccount(A.id, 'work')).toBe(true)
    expect(resolveLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'claude', account: 'work', resumeSessionId: null }))
  })

  it('fork opens nothing when its parent is closed during the transcript check', async () => {
    const closing: { tm: TabManager | null } = { tm: null }
    const { tm, log } = forkSetup({ resumable: async (tabId) => { closing.tm!.close(tabId); return true } })
    closing.tm = tm
    const A = tm.open({ kind: 'claude', cwd: 'D:/x', resumeSessionId: SID_A })
    log.length = 0
    expect(await tm.fork(A.id)).toBeNull()
    expect(tm.list()).toEqual([])
    expect(log.filter((l) => l.startsWith('opened:'))).toEqual([])
  })

  it('restart and switchAccount start nothing when the check rejects after the tab closed', async () => {
    const closing: { tm: TabManager | null } = { tm: null }
    const { tm, ptys } = forkSetup({ restartWaitMs: 0, resumable: async (tabId) => { closing.tm!.close(tabId); throw new Error('transcript unreadable') } })
    closing.tm = tm
    const A = tm.open({ kind: 'claude', cwd: 'D:/x', resumeSessionId: SID_A })
    ptys[0].emitExit(0)
    await tm.restart(A.id)
    expect(tm.list()).toEqual([])
    expect(ptys).toHaveLength(1)

    const B = tm.open({ kind: 'claude', cwd: 'D:/y', resumeSessionId: SID_B })
    const started = ptys.length
    expect(await tm.switchAccount(B.id, 'work')).toBe(false)
    expect(ptys).toHaveLength(started)
  })
})

describe('TabManager views', () => {
  it('a Claude tab opens in the view the setting names, unless the request names one', () => {
    const { tm } = setup({ defaultView: () => 'chat' })
    expect(tm.open({ kind: 'claude', cwd: 'D:\\x' }).view).toBe('chat')
    expect(tm.open({ kind: 'claude', cwd: 'D:\\x', view: 'terminal' }).view).toBe('terminal')
  })

  it('a shell tab has no view', () => {
    const { tm } = setup({ defaultView: () => 'chat' })
    expect(tm.open({ kind: 'shell', cwd: 'D:\\x' }).view).toBeNull()
  })

  it('without a defaultView a Claude tab opens in the terminal view', () => {
    const { tm } = setup()
    expect(tm.open({ kind: 'claude', cwd: 'D:\\x' }).view).toBe('terminal')
  })

  it('snapshot carries the view of each tab', () => {
    const { tm } = setup({ defaultView: () => 'chat' })
    tm.open({ kind: 'claude', cwd: 'D:\\x' })
    tm.open({ kind: 'shell', cwd: 'D:\\y' })
    expect(tm.snapshot().map((t) => t.view)).toEqual(['chat', null])
    expect(tm.snapshot().map((t) => t.view)).toEqual(tm.list().map((t) => t.view))
  })
})

describe('TabManager chat view', () => {
  const CLAUDE: ClaudeLaunch = { command: 'claude', settingsPath: null, resumeSessionId: null, forkSession: false }

  /** a chat process the test ends by hand; stop() does nothing unless the test makes it exit */
  class FakeChat implements ChatHandle {
    stops = 0
    kills = 0
    exitOnStop = false
    constructor(readonly req: ChatStartRequest, private readonly calls: string[]) {}
    stop(): void {
      this.stops++
      this.calls.push('stop')
      if (this.exitOnStop) this.end(0, null)
    }
    kill(): void {
      this.kills++
      this.calls.push('kill')
    }
    end(code: number | null, fallback: string | null): void {
      this.req.exit(code, fallback)
    }
  }

  /** a Claude tab's launch carries its claude inputs, so the tab can start a chat process */
  function chatSetup(over: Partial<TabManagerDeps> = {}) {
    const chats: FakeChat[] = []
    const calls: string[] = []
    const startChat = vi.fn((req: ChatStartRequest): ChatHandle => {
      calls.push('start')
      const chat = new FakeChat(req, calls)
      chats.push(chat)
      return chat
    })
    const resolveLaunch = vi.fn((req: LaunchRequest): ResolvedLaunch => ({
      profileName: 'Windows PowerShell',
      spec: { file: 'powershell.exe', args: ['-NoLogo'] },
      ...(req.kind === 'claude' ? { claude: CLAUDE } : {})
    }))
    const base = setup({ resolveLaunch, startChat, ...over })
    return { ...base, chats, calls, startChat, resolveLaunch }
  }

  it('a chat tab starts its chat process, not a PTY', () => {
    const { tm, ptys, chats, startChat, log } = chatSetup({ defaultView: () => 'chat' })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    expect(startChat).toHaveBeenCalledTimes(1)
    expect(ptys).toEqual([])
    expect(startChat.mock.calls[0][0]).toMatchObject({ tab: expect.objectContaining({ id: tab.id, view: 'chat' }), claude: CLAUDE })
    expect(startChat.mock.calls[0][0].env).toEqual({ PATH: 'C:\\Windows', CLAUDETERM_TAB_ID: tab.id, CLAUDETERM_PIPE: '\\\\.\\pipe\\test' })
    chats[0].end(0, null)
    expect(log).toContain(`exit:${tab.id}:0`)
    expect(tm.get(tab.id)?.exited).toBe(true)
  })

  it('a chat tab without a chat process starts its PTY as before', () => {
    const { tm, ptys } = setup({ defaultView: () => 'chat', resolveLaunch: () => ({ profileName: 'Windows PowerShell', spec: { file: 'powershell.exe', args: ['-NoLogo'] }, claude: CLAUDE }) })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    expect(ptys).toHaveLength(1)
    expect(tm.get(tab.id)?.view).toBe('chat')
  })

  it('a fallback starts the PTY in the same tab and says why', () => {
    const fallbacks: Array<[string, string]> = []
    const { tm, ptys, chats, log } = chatSetup({ defaultView: () => 'chat', onChatFallback: (id, reason) => fallbacks.push([id, reason]) })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    chats[0].end(null, 'the chat engine did not start')
    expect(fallbacks).toEqual([[tab.id, 'the chat engine did not start']])
    expect(tm.get(tab.id)).toMatchObject({ view: 'terminal', exited: false })
    expect(ptys).toHaveLength(1)
    expect(ptys[0].opts.cwd).toBe('D:\\x')
    expect(log).toContain(`updated:${tab.id}:false`)
    expect(log).not.toContain(`exit:${tab.id}:-1`)
  })

  it('setView waits for the old process before starting the new one', async () => {
    vi.useFakeTimers()
    const { tm, ptys, startChat } = chatSetup()
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    expect(tab.view).toBe('terminal')
    const switched = tm.setView(tab.id, 'chat')
    vi.advanceTimersByTime(1000)
    expect(startChat).not.toHaveBeenCalled()
    ptys[0].emitExit(0)
    expect(await switched).toBe(true)
    expect(startChat).toHaveBeenCalledTimes(1)
    expect(ptys).toHaveLength(1)
  })

  it('setView kills a chat process that does not stop', async () => {
    vi.useFakeTimers()
    const { tm, ptys, chats, startChat } = chatSetup({ defaultView: () => 'chat' })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    const switched = tm.setView(tab.id, 'terminal')
    await vi.advanceTimersByTimeAsync(4999)
    expect(chats[0].stops).toBe(1)
    expect(chats[0].kills).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(chats[0].kills).toBe(1)
    expect(ptys).toEqual([])
    chats[0].end(null, null)
    expect(await switched).toBe(true)
    expect(ptys).toHaveLength(1)
    expect(startChat).toHaveBeenCalledTimes(1)
  })

  it('setView is refused while a turn runs', async () => {
    const { tm, chats, startChat } = chatSetup({ defaultView: () => 'chat' })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    tm.setWorking(tab.id, true)
    expect(await tm.setView(tab.id, 'terminal')).toBe(false)
    expect(tm.get(tab.id)?.view).toBe('chat')
    expect(chats[0].stops).toBe(0)
    expect(startChat).toHaveBeenCalledTimes(1)
  })

  it('setView is refused while agents run', async () => {
    const { tm, chats, startChat } = chatSetup({ defaultView: () => 'chat' })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    tm.setAgentsRunning(tab.id, true)
    expect(await tm.setView(tab.id, 'terminal')).toBe(false)
    expect(tm.get(tab.id)?.view).toBe('chat')
    expect(chats[0].stops).toBe(0)
    expect(startChat).toHaveBeenCalledTimes(1)
  })

  it('setView is refused for a shell tab, an unknown tab (a remote tab is none of this manager\'s) and the view the tab has', async () => {
    const { tm, ptys, startChat } = chatSetup()
    const shell = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    const claude = tm.open({ kind: 'claude', cwd: 'D:\\y' })
    expect(await tm.setView(shell.id, 'chat')).toBe(false)
    expect(await tm.setView('gone', 'chat')).toBe(false)
    expect(await tm.setView(claude.id, 'terminal')).toBe(false)
    expect(ptys).toHaveLength(2)
    expect(startChat).not.toHaveBeenCalled()
    expect(tm.get(claude.id)?.view).toBe('terminal')
  })

  it('setView is refused while the tab is preparing a restart', async () => {
    let release!: (ok: boolean) => void
    const gate = new Promise<boolean>((r) => { release = r })
    const { tm, ptys, startChat } = chatSetup({ resumable: () => gate })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A })
    ptys[0].emitExit(0)
    const restarted = tm.restart(tab.id)
    expect(await tm.setView(tab.id, 'chat')).toBe(false)
    release(true)
    await restarted
    expect(ptys).toHaveLength(2)
    expect(tm.get(tab.id)?.view).toBe('terminal')
    expect(startChat).not.toHaveBeenCalled()
  })

  it('setView is refused while the tab is restarting', async () => {
    vi.useFakeTimers()
    const { tm, ptys, startChat } = chatSetup()
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    const restarting = tm.restart(tab.id, { live: true })
    await vi.advanceTimersByTimeAsync(1)
    expect(await tm.setView(tab.id, 'chat')).toBe(false)
    ptys[0].emitExit(0)
    await restarting
    expect(ptys).toHaveLength(2)
    expect(startChat).not.toHaveBeenCalled()
  })

  it('closing a chat tab stops its process', () => {
    const { tm, chats } = chatSetup({ defaultView: () => 'chat' })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    tm.close(tab.id)
    expect(chats[0].stops).toBe(1)
    expect(chats[0].kills).toBe(0)
  })

  it('restarting a chat tab stops its process first', async () => {
    const { tm, chats, calls, startChat } = chatSetup({ defaultView: () => 'chat' })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    chats[0].exitOnStop = true
    await tm.restart(tab.id, { live: true })
    expect(startChat).toHaveBeenCalledTimes(2)
    expect(calls).toEqual(['start', 'stop', 'start'])
    expect(tm.get(tab.id)?.exited).toBe(false)
  })

  it('disposeAll kills chat processes', () => {
    const { tm, chats } = chatSetup({ defaultView: () => 'chat' })
    tm.open({ kind: 'claude', cwd: 'D:\\x' })
    tm.disposeAll()
    expect(chats[0].kills).toBe(1)
    expect(chats[0].stops).toBe(0)
  })

  it('write and resize ignore a chat tab', () => {
    const { tm, ptys, chats } = chatSetup({ defaultView: () => 'chat' })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    expect(() => {
      tm.write(tab.id, 'hello\r')
      tm.resize(tab.id, 100, 40)
    }).not.toThrow()
    expect(ptys).toEqual([])
    expect(chats[0].stops + chats[0].kills).toBe(0)
  })

  it('the snapshot keeps the new view', async () => {
    const { tm, ptys, chats } = chatSetup()
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    const switched = tm.setView(tab.id, 'chat')
    ptys[0].emitExit(0)
    expect(await switched).toBe(true)
    expect(tm.snapshot()[0].view).toBe('chat')
    expect(chats).toHaveLength(1)
  })
  it('a chat process that ignores stop is killed at 5 s, and the new one starts only after the old one exits', async () => {
    vi.useFakeTimers()
    const { tm, chats, startChat } = chatSetup({ defaultView: () => 'chat' })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    const restarted = tm.restart(tab.id, { live: true })
    await vi.advanceTimersByTimeAsync(4999)
    expect(chats[0].kills).toBe(0)
    expect(startChat).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(chats[0].kills).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(startChat).toHaveBeenCalledTimes(1)
    chats[0].end(null, null)
    await restarted
    expect(startChat).toHaveBeenCalledTimes(2)
    expect(tm.get(tab.id)?.exited).toBe(false)
  })

  it('a chat process that never exits is killed, and a restart starts nothing beside it', async () => {
    vi.useFakeTimers()
    const { tm, chats, startChat } = chatSetup({ defaultView: () => 'chat' })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    const restarted = tm.restart(tab.id, { live: true })
    await vi.advanceTimersByTimeAsync(7000)
    await restarted
    expect(chats[0].stops).toBe(1)
    expect(chats[0].kills).toBe(1)
    expect(startChat).toHaveBeenCalledTimes(1)
    expect(tm.get(tab.id)?.exited).toBe(true)
  })

  it('a chat process still alive after a switch is waited for by the next restart, which starts nothing until it exits', async () => {
    vi.useFakeTimers()
    const { tm, chats, ptys } = chatSetup({ defaultView: () => 'chat' })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    const switched = tm.setView(tab.id, 'terminal')
    await vi.advanceTimersByTimeAsync(7000)
    expect(await switched).toBe(false)
    expect(tm.get(tab.id)).toMatchObject({ view: 'terminal', exited: true })
    // the restart starts the terminal the tab now has, once the old chat process is gone
    const restarted = tm.restart(tab.id)
    await vi.advanceTimersByTimeAsync(4999)
    expect(ptys).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(chats[0].stops).toBe(2)
    expect(chats[0].kills).toBe(2)
    expect(ptys).toHaveLength(0)
    chats[0].end(null, null)
    await restarted
    expect(ptys).toHaveLength(1)
    expect(tm.get(tab.id)?.exited).toBe(false)
  })

  it('disposeAll kills a chat process that is still stopping during a switch', async () => {
    vi.useFakeTimers()
    const { tm, chats } = chatSetup({ defaultView: () => 'chat' })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    const switched = tm.setView(tab.id, 'terminal')
    await vi.advanceTimersByTimeAsync(1000)
    tm.disposeAll()
    expect(chats[0].kills).toBe(1)
    await vi.advanceTimersByTimeAsync(10000)
    expect(await switched).toBe(false)
  })

  it('a chat process reports its exit once: a second report from its handle does nothing', () => {
    const fallbacks: Array<[string, string]> = []
    const { tm, chats, ptys, log } = chatSetup({ defaultView: () => 'chat', onChatFallback: (id, reason) => fallbacks.push([id, reason]) })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    chats[0].end(0, null)
    chats[0].end(3, 'a late fallback')
    expect(log.filter((l) => l === `exit:${tab.id}:0`)).toHaveLength(1)
    expect(log).not.toContain(`exit:${tab.id}:3`)
    expect(fallbacks).toEqual([])
    expect(ptys).toEqual([])
    expect(tm.get(tab.id)).toMatchObject({ view: 'chat', exited: true })
  })
})

describe('TabManager resumeSession', () => {
  it('resumeSession restarts a Claude tab on the given conversation, and its fork is no copy any more', async () => {
    const resolveLaunch = vi.fn((req: LaunchRequest): ResolvedLaunch => ({ profileName: 'Windows PowerShell', spec: { file: 'powershell.exe', args: ['-NoLogo'] } }))
    const { tm, ptys } = setup({ resolveLaunch }, { exitOnKill: true })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: null, fork: { of: null, from: SID_A } })
    resolveLaunch.mockClear()

    expect(await tm.resumeSession(tab.id, SID_B)).toBe(true)
    expect(resolveLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_B }))
    expect(ptys).toHaveLength(2)
    expect(tm.get(tab.id)).toMatchObject({ claudeSessionId: SID_B, fork: { of: null, from: null } })
  })

  it('resumeSession is refused while the tab works, and changes nothing', async () => {
    const { tm, ptys } = setup({}, { exitOnKill: true })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A })
    tm.setWorking(tab.id, true)

    expect(await tm.resumeSession(tab.id, SID_B)).toBe(false)
    expect(ptys).toHaveLength(1)
    expect(tm.get(tab.id)?.claudeSessionId).toBe(SID_A)
  })

  it('resumeSession is refused for a shell tab and an unknown tab', async () => {
    const { tm, ptys } = setup({}, { exitOnKill: true })
    const shell = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    expect(await tm.resumeSession(shell.id, SID_B)).toBe(false)
    expect(await tm.resumeSession('no-such-tab', SID_B)).toBe(false)
    expect(ptys).toHaveLength(1)
  })

  it('a chat tab restarts its chat process on the new conversation', async () => {
    const chats: ChatHandle[] = []
    const startChat = vi.fn((req: ChatStartRequest): ChatHandle => {
      const chat: ChatHandle = { stop: () => req.exit(0, null), kill: () => undefined }
      chats.push(chat)
      return chat
    })
    const resolveLaunch = vi.fn((req: LaunchRequest): ResolvedLaunch => ({
      profileName: 'Windows PowerShell',
      spec: { file: 'powershell.exe', args: ['-NoLogo'] },
      ...(req.kind === 'claude' ? { claude: { command: 'claude', settingsPath: null, resumeSessionId: req.resumeSessionId ?? null, forkSession: false } } : {}),
    }))
    const { tm } = setup({ resolveLaunch, startChat, defaultView: () => 'chat' })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x', resumeSessionId: SID_A })
    resolveLaunch.mockClear()

    expect(await tm.resumeSession(tab.id, SID_B)).toBe(true)
    expect(resolveLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'claude', resumeSessionId: SID_B }))
    expect(startChat).toHaveBeenCalledTimes(2)
    expect(startChat.mock.calls[1][0].claude.resumeSessionId).toBe(SID_B)
  })
})
