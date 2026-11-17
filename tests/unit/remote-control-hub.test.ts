import { describe, expect, it } from 'vitest'
import type { RemoteAccountKind } from '../../src/main/remote-control/account-rules'
import type { BridgeTarget } from '../../src/main/remote-control/bridge-host'
import { RemoteControlHub, type RemoteControlDeps, type RemoteTab } from '../../src/main/remote-control/remote-control-hub'
import type { RemoteState } from '../../src/shared/remote-control'

const TAB = 'tab-1'
const ID = 'session_01abc'

/** the hub with fake dependencies; `report` does what StatusHub does: keeps the id and tells the hub of a change */
function world(o: { view?: 'terminal' | 'chat'; kind?: RemoteAccountKind; env?: Record<string, string>; choice?: boolean } = {}) {
  const w = {
    tab: { view: o.view ?? 'terminal', account: null, exited: false } as RemoteTab | null,
    kind: o.kind ?? ('main' as RemoteAccountKind),
    env: o.env ?? {},
    choice: o.choice ?? false,
    reported: null as string | null,
    changes: 0,
    typed: [] as string[],
    toasts: [] as string[],
    timers: [] as { ms: number; run: () => void; on: boolean }[],
    typing: null as null | { wait: (waiting: boolean) => void; done: (ok: boolean) => void; cancelled: () => boolean },
    attached: [] as BridgeTarget[], detached: [] as string[], hostState: null as RemoteState | null
  }
  const deps: RemoteControlDeps = {
    tab: (id) => (id === TAB ? w.tab : null),
    host: {
      attach: (t) => { w.attached.push(t) },
      detach: async (id) => { w.detached.push(id) },
      state: () => w.hostState
    },
    target: (id, sid) => ({ tabId: id, sessionId: sid, folder: '/cfg', env: {}, title: 'work', cwd: '/w', model: null }),
    accountKind: () => w.kind,
    env: () => w.env,
    choice: () => w.choice,
    setChoice: (_id, on) => { w.choice = on },
    reportedId: () => w.reported,
    forgetReported: () => { w.reported = null },
    onChange: () => { w.changes++ },
    type: (_id, line, onWait, cancelled) => new Promise<boolean>((done) => { w.typed.push(line); w.typing = { wait: onWait, done, cancelled } }),
    name: () => 'work',
    title: () => 'work',
    toast: (text) => { w.toasts.push(text) },
    later: (ms, run) => { const t = { ms, run, on: true }; w.timers.push(t); return () => { t.on = false } }
  }
  const hub = new RemoteControlHub(deps)
  const report = (id: string | null): void => {
    const previous = w.reported
    w.reported = id
    if (previous !== id) hub.reported(TAB, id, previous)
  }
  /** the typed line's answer, then the microtasks that carry it into the hub */
  const typedOk = async (ok = true): Promise<void> => {
    w.typing!.done(ok)
    for (let i = 0; i < 5; i++) await Promise.resolve()
  }
  /** the connect timers that were started and not cancelled run now */
  const fire = (): void => {
    for (const t of w.timers.splice(0)) if (t.on) t.run()
  }
  return { hub, w, report, typedOk, fire }
}

describe('RemoteControlHub: terminal reports', () => {
  it('a terminal tab is on with its link while its Claude Code reports an id, and off without one', () => {
    const { hub, report } = world()
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    report(ID)
    expect(hub.state(TAB)).toEqual({ kind: 'on', url: `https://claude.ai/code/${ID}` })
    report(null)
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
  })
  it('an id the person brought up by typing /remote-control sets the choice; the id going away clears it', () => {
    const { w, report } = world()
    report(ID)
    expect(w.choice).toBe(true)
    report(null)
    expect(w.choice).toBe(false)
  })
  it('a token account, or a sign-in from the environment, is unavailable with its reason whatever is reported', () => {
    const token = world({ kind: 'token' })
    token.report(ID)
    expect(token.hub.state(TAB)).toEqual({ kind: 'unavailable', reason: 'This account signs in with a token: Remote Control needs a claude.ai sign-in' })
    expect(world({ env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' } }).hub.state(TAB)).toEqual({ kind: 'unavailable', reason: "Remote Control needs Anthropic's own service: this account uses ANTHROPIC_BASE_URL" })
  })
  it('a chat-view tab ignores the terminal reports', () => {
    const { hub, w, report } = world({ view: 'chat' })
    report(ID)
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.choice).toBe(false)
  })
  it('an exited tab is off; Claude Code ending keeps the choice for the next start', () => {
    const { hub, w, report } = world()
    report(ID)
    w.tab = { ...w.tab!, exited: true }
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.choice).toBe(true)
  })
  it('a shell tab, another device’s tab and an unknown id have no state', () => {
    const { hub, w } = world()
    w.tab = null
    expect(hub.state(TAB)).toBeNull()
    expect(hub.state('other')).toBeNull()
  })
  it('a new process forgets what the old one reported, and the window hears of it', () => {
    const { hub, w, report } = world()
    report(ID)
    const before = w.changes
    hub.processStarted(TAB)
    expect(w.reported).toBeNull()
    expect(hub.state(TAB)).toEqual({ kind: 'connecting' })
    expect(w.changes).toBeGreaterThan(before)
  })
})

describe('RemoteControlHub: the terminal switch', () => {
  it('on types /remote-control with the name and connects until the id comes', async () => {
    const { hub, w, report, typedOk, fire } = world()
    hub.set(TAB, true)
    expect(w.typed).toEqual(['/remote-control work'])
    expect(w.choice).toBe(true)
    expect(hub.state(TAB)).toEqual({ kind: 'connecting' })
    await typedOk()
    report(ID)
    expect(hub.state(TAB)).toEqual({ kind: 'on', url: `https://claude.ai/code/${ID}` })
    fire()
    expect(w.toasts).toEqual([])
  })
  it('while the prompt holds a draft, the state says it waits for an empty prompt', () => {
    const { hub, w } = world()
    hub.set(TAB, true)
    w.typing!.wait(true)
    expect(hub.state(TAB)).toEqual({ kind: 'connecting', waits: true })
    w.typing!.wait(false)
    expect(hub.state(TAB)).toEqual({ kind: 'connecting' })
  })
  it('30 s after the line is typed without an id: off, the toast, and the choice cleared', async () => {
    const { hub, w, typedOk, fire } = world()
    hub.set(TAB, true)
    await typedOk()
    expect(w.timers.map((t) => t.ms)).toEqual([30_000])
    fire()
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.choice).toBe(false)
    expect(w.toasts).toEqual(['Remote Control did not connect in work: see the terminal'])
  })
  it('an id that comes after the timeout turns the tab on and sets the choice again', async () => {
    const { hub, w, report, typedOk, fire } = world()
    hub.set(TAB, true)
    await typedOk()
    fire()
    report(ID)
    expect(hub.state(TAB)).toMatchObject({ kind: 'on' })
    expect(w.choice).toBe(true)
  })
  it('a prompt that never came up: off and the choice cleared, with no toast of the hub’s own', async () => {
    const { hub, w, typedOk } = world()
    hub.set(TAB, true)
    await typedOk(false)
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.choice).toBe(false)
    expect(w.toasts).toEqual([])
  })
  it('a second on while one waits types nothing more', () => {
    const { hub, w } = world()
    hub.set(TAB, true)
    hub.set(TAB, true)
    expect(w.typed).toEqual(['/remote-control work'])
  })
  it('off on a connected tab types /remote-control and stays on, leaving, until the report without an id', async () => {
    const { hub, w, report, typedOk } = world()
    report(ID)
    hub.set(TAB, false)
    expect(w.typed).toEqual(['/remote-control'])
    expect(w.choice).toBe(false)
    expect(hub.state(TAB)).toEqual({ kind: 'on', url: `https://claude.ai/code/${ID}`, leaving: true })
    await typedOk()
    report(null)
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.choice).toBe(false)
  })
  it('30 s after the off line, an id still there means the person kept Remote Control: the choice is set again', async () => {
    const { hub, w, report, typedOk, fire } = world()
    report(ID)
    hub.set(TAB, false)
    await typedOk()
    fire()
    expect(w.choice).toBe(true)
    expect(hub.state(TAB)).toEqual({ kind: 'on', url: `https://claude.ai/code/${ID}` })
  })
  it('off while connecting types nothing and stops connecting', () => {
    const { hub, w } = world()
    hub.set(TAB, true)
    hub.set(TAB, false)
    expect(w.typed).toEqual(['/remote-control work'])
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.choice).toBe(false)
  })
  it('off while the on line still waits for an empty prompt: the hub tells the typing to stop', () => {
    const { hub, w } = world()
    hub.set(TAB, true)
    expect(w.typing!.cancelled()).toBe(false)
    hub.set(TAB, false)
    expect(w.typing!.cancelled()).toBe(true)
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
  })
  it('on while the id is reported drops an off line that is still open: leaving goes at once, its timer stops', async () => {
    const { hub, w, report, typedOk } = world()
    report(ID)
    hub.set(TAB, false)
    await typedOk()
    expect(hub.state(TAB)).toMatchObject({ kind: 'on', leaving: true })
    hub.set(TAB, true)
    expect(hub.state(TAB)).toEqual({ kind: 'on', url: `https://claude.ai/code/${ID}` })
    expect(w.timers.map((t) => t.on)).toEqual([false])
    expect(w.choice).toBe(true)
  })
  it('a tab started with its choice on connects: a report without an id meanwhile keeps it connecting and keeps the choice', () => {
    const { hub, w, report } = world({ choice: true })
    w.reported = 'session_old' // what the old process reported
    hub.processStarted(TAB)
    expect(w.reported).toBeNull()
    expect(hub.state(TAB)).toEqual({ kind: 'connecting' })
    expect(w.timers.map((t) => t.ms)).toEqual([30_000])
    hub.reported(TAB, null, 'session_old') // a late report of the old id going away
    report(null)
    expect(hub.state(TAB)).toEqual({ kind: 'connecting' })
    expect(w.choice).toBe(true)
    report(ID)
    expect(hub.state(TAB)).toMatchObject({ kind: 'on' })
  })
  it('a launch that does not connect in 30 s: off, the toast, the choice cleared', () => {
    const { hub, w, fire } = world({ choice: true })
    hub.processStarted(TAB)
    fire()
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.choice).toBe(false)
    expect(w.toasts).toEqual(['Remote Control did not connect in work: see the terminal'])
  })
  it('on in a chat-view tab, or in an unavailable one, types nothing', () => {
    const chat = world({ view: 'chat' })
    chat.hub.set(TAB, true)
    expect(chat.w.typed).toEqual([])
    expect(chat.w.choice).toBe(true)
    const token = world({ kind: 'token' })
    token.hub.set(TAB, true)
    expect([token.w.typed, token.w.choice]).toEqual([[], false])
  })
})

describe('RemoteControlHub: chat tabs', () => {
  const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
  const SID_2 = '6e3d2c8b-9f5a-4b4c-a2d3-e4f5a6b7c8d9'
  it('a chat whose choice is off never attaches: not when ready, not on a new session', () => {
    const { hub, w } = world({ view: 'chat' })
    hub.processStarted(TAB)
    hub.chatReady(TAB, SID)
    hub.chatSessionChanged(TAB, SID_2)
    expect(w.attached).toEqual([])
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
  })
  it('a chat whose choice is on shows connecting from its start, and attaches when its session is ready', () => {
    const { hub, w } = world({ view: 'chat', choice: true })
    hub.processStarted(TAB)
    expect(hub.state(TAB)).toEqual({ kind: 'connecting' })
    expect(w.attached).toEqual([])
    hub.chatReady(TAB, SID)
    expect(w.attached.map((t) => t.sessionId)).toEqual([SID])
  })
  it('the switch attaches a ready chat and detaches it', async () => {
    const { hub, w } = world({ view: 'chat' })
    hub.processStarted(TAB)
    hub.chatReady(TAB, SID)
    hub.set(TAB, true)
    expect([w.choice, w.attached.map((t) => t.sessionId)]).toEqual([true, [SID]])
    hub.set(TAB, false)
    await Promise.resolve()
    expect([w.choice, w.detached]).toEqual([false, [TAB]])
  })
  it('a new conversation in the tab (/clear) detaches, then attaches for the new session', async () => {
    const { hub, w } = world({ view: 'chat', choice: true })
    hub.processStarted(TAB)
    hub.chatReady(TAB, SID)
    hub.chatSessionChanged(TAB, SID_2)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(w.detached).toEqual([TAB])
    expect(w.attached.map((t) => t.sessionId)).toEqual([SID, SID_2])
  })
  it('the host’s state is the tab’s state while it has one; the chat ending detaches and keeps the choice', async () => {
    const { hub, w } = world({ view: 'chat', choice: true })
    hub.processStarted(TAB)
    hub.chatReady(TAB, SID)
    w.hostState = { kind: 'on', url: 'https://claude.ai/code/cse_1' }
    expect(hub.state(TAB)).toEqual({ kind: 'on', url: 'https://claude.ai/code/cse_1' })
    hub.chatEnded(TAB)
    w.hostState = null
    expect(w.detached).toEqual([TAB])
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.choice).toBe(true)
  })
  it('a chat that goes to the terminal detaches; a token account never attaches', () => {
    const moved = world({ view: 'chat', choice: true })
    moved.hub.processStarted(TAB)
    moved.hub.chatReady(TAB, SID)
    moved.w.tab = { ...moved.w.tab!, view: 'terminal' }
    moved.hub.processStarted(TAB)
    expect(moved.w.detached).toEqual([TAB])
    const token = world({ view: 'chat', choice: true, kind: 'token' })
    token.hub.processStarted(TAB)
    token.hub.chatReady(TAB, SID)
    expect(token.w.attached).toEqual([])
  })
})
