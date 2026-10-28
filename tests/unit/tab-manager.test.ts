import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtyHandle, SpawnOptions } from '../../src/main/pty-host'
import { TabManager, type LaunchRequest, type ResolvedLaunch, type TabEvents, type TabManagerDeps } from '../../src/main/tab-manager'

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
    exit: (id, code) => log.push(`exit:${id}:${code}`),
    reset: (id) => log.push(`reset:${id}`)
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
    expect(log).not.toContain(`reset:${tab.id}`)
    tm.write(tab.id, 'dir\r')
    expect(ptys[1].writes).toEqual(['dir\r'])
    // a second Enter that arrives after the restart leaves the new process alone
    tm.restart(tab.id)
    expect(ptys).toHaveLength(2)
    expect(ptys[1].killed).toBe(false)
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

  it('a tab opened muted stays muted through a restart', async () => {
    const { tm, ptys } = setup({ restartWaitMs: 0 })
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
      { kind: 'claude', profile: 'Windows PowerShell', cwd: 'D:\\same', title: null, claudeSessionId: SID_A, account: null, muted: false },
      { kind: 'claude', profile: 'Windows PowerShell', cwd: 'D:\\same', title: null, claudeSessionId: SID_B, account: null, muted: false },
      { kind: 'shell', profile: 'Windows PowerShell', cwd: 'D:\\same', title: null, claudeSessionId: null, account: null, muted: false }
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

  it('a restart, of a running or an exited tab, says so before the new process starts', async () => {
    const onTabRestarting = vi.fn()
    const { tm, ptys } = setup({ onTabRestarting })
    const tab = tm.open({ kind: 'claude', cwd: 'D:\\x' })
    const done = tm.restart(tab.id, { live: true })
    expect(onTabRestarting).toHaveBeenCalledWith(tab.id)
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
    const resumable = vi.fn(() => false)
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
    expect(ptys[0].killed).toBe(true)
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
