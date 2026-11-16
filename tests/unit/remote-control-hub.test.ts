import { describe, expect, it } from 'vitest'
import type { RemoteAccountKind } from '../../src/main/remote-control/account-rules'
import { RemoteControlHub, type RemoteControlDeps, type RemoteTab } from '../../src/main/remote-control/remote-control-hub'

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
    changes: 0
  }
  const deps: RemoteControlDeps = {
    tab: (id) => (id === TAB ? w.tab : null),
    accountKind: () => w.kind,
    env: () => w.env,
    choice: () => w.choice,
    setChoice: (_id, on) => { w.choice = on },
    reportedId: () => w.reported,
    forgetReported: () => { w.reported = null },
    onChange: () => { w.changes++ }
  }
  const hub = new RemoteControlHub(deps)
  const report = (id: string | null): void => {
    const previous = w.reported
    w.reported = id
    if (previous !== id) hub.reported(TAB, id, previous)
  }
  return { hub, w, report }
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
    expect(hub.state(TAB)).toEqual({ kind: 'off' })
    expect(w.changes).toBeGreaterThan(before)
  })
})
