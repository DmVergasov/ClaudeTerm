import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nameAgents, formatAgentList, type AgentTab } from '../../src/main/mail/agent-directory'
import { checkMailRecord } from '../../src/main/mail/mail-record'
import { MailHub, type CallerTab, type MailHubDeps } from '../../src/main/mail/mail-hub'
import { MailStore } from '../../src/main/mail/mail-store'
import { wakeText } from '../../src/main/mail/wake-text'
import { MAIL_TEXT_MAX, type MailAddress, type MailConversationView, type MailRecord } from '../../src/shared/mail'

const SELF = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const DEV_B = '9a1e2f3c-4d5b-4e6f-8a7b-1c2d3e4f5a6b'
const DEV_C = 'e7f81a2b-3c4d-4e5f-9a6b-7c8d9e0f1a2b'
const DEV_D = 'd1c2b3a4-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const SES_CALLER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const SES_LOCAL = '3be5d1f0-7c2a-4e9b-8d1f-6a5b4c3d2e1f'
const SES_MAC = 'c5df49a2-1b3c-4d5e-9f8a-7b6c5d4e3f2a'
const SES_GONE = '0a000000-0000-4000-8000-000000000001'
const SES_OFF = '0b000000-0000-4000-8000-000000000002'
const SES_NOACC = '0c000000-0000-4000-8000-000000000003'
const SES_OLD = '0d000000-0000-4000-8000-000000000004'
const SES_NEW = '0e000000-0000-4000-8000-000000000005'
const SES_A = '0f000000-0000-4000-8000-000000000006'
const SES_B = '10000000-0000-4000-8000-000000000007'
const SES_C = '11000000-0000-4000-8000-000000000008'
const NOW = 1700000000000

const CALLER: MailAddress = { device: null, session: SES_CALLER, name: 'api-server · Desktop' }
const LOCAL: MailAddress = { device: null, session: SES_LOCAL, name: 'parser · Desktop' }
const MAC: MailAddress = { device: DEV_B, session: SES_MAC, name: 'acme-dashboard · MacBook' }

const dirs: string[] = []
const stores: MailStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.flush()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

let seq = 0
const nextId = (): string => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`

const record = (over: Partial<MailRecord> = {}): MailRecord => ({
  v: 1,
  id: nextId(),
  from: CALLER,
  to: MAC,
  replyTo: null,
  text: 'hello',
  sentAt: NOW,
  delivered: false,
  read: false,
  ...over
})

const tab = (over: Partial<AgentTab>): AgentTab => ({
  device: null,
  deviceName: 'Desktop',
  tabId: 'tab-x',
  session: SES_LOCAL,
  customTitle: null,
  folder: 'D:\\Work\\parser',
  branch: null,
  title: null,
  busy: false,
  wakes: true,
  claude: '2.1.300',
  ...over
})

interface World {
  enabled: boolean
  callers: Record<string, CallerTab>
  agentTabs: AgentTab[]
  notAccepting: string[]
  online: Set<string>
  accepting: Set<string>
  localTabs: Record<string, string>
  closedTabs: Set<string>
  working: Record<string, boolean>
  names: Record<string, string>
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-hub-'))
  dirs.push(dir)
  const store = MailStore.open({ dir, now: () => NOW, debounceMs: 100000 })
  stores.push(store)
  const world: World = {
    enabled: true,
    callers: {
      'tab-1': { tabId: 'tab-1', device: null, session: SES_CALLER, name: 'api-server · Desktop' }
    },
    agentTabs: [
      tab({ tabId: 'tab-1', session: SES_CALLER, folder: 'D:\\Work\\api-server', branch: 'feat/revenue-units' }),
      tab({ tabId: 'tab-2', session: SES_LOCAL }),
      tab({ tabId: 'tab-3', device: DEV_B, deviceName: 'MacBook', session: SES_MAC, folder: '/Users/sam/acme-dashboard', branch: 'main' })
    ],
    notAccepting: [],
    online: new Set([DEV_B, DEV_D]),
    accepting: new Set([DEV_B]),
    localTabs: { [SES_CALLER]: 'tab-1', [SES_LOCAL]: 'tab-2', [SES_MAC]: 'tab-3' },
    closedTabs: new Set(),
    working: {},
    names: { [DEV_B]: 'MacBook', [DEV_D]: 'Workstation' }
  }
  const onUnread = vi.fn()
  let ids = 0
  const deps: MailHubDeps = {
    store,
    enabled: () => world.enabled,
    caller: tabId => world.callers[tabId] ?? null,
    agents: () => nameAgents(world.agentTabs),
    notAccepting: () => world.notAccepting,
    deviceOnline: device => device === null || world.online.has(device),
    deviceAccepts: device => device === null || world.accepting.has(device),
    localTab: session => world.localTabs[session] ?? null,
    tabOpen: tabId => !world.closedTabs.has(tabId),
    working: tabId => world.working[tabId] ?? true,
    sender: () => ({ folder: null, branch: null }),
    self: () => SELF,
    deviceName: device => (device === null ? 'Desktop' : (world.names[device] ?? null)),
    onUnread,
    now: () => NOW,
    newId: () => `20000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`
  }
  const hub = new MailHub(deps)
  return { hub, store, world, onUnread }
}

const settledOf = (p: Promise<unknown>): { done: boolean } => {
  const state = { done: false }
  void p.then(() => {
    state.done = true
  })
  return state
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

describe('MailHub.send', () => {
  it('answers "Delivered to <name>." and writes the record when the target device is online and a tab runs the session', () => {
    const { hub, store } = setup()
    expect(hub.send('tab-1', 'acme-dashboard · MacBook', 'Ready?', null)).toEqual({
      ok: true,
      info: 'Delivered to acme-dashboard · MacBook.'
    })
    const [r] = store.all()
    expect(r).toEqual({
      v: 1,
      id: '20000000-0000-4000-8000-000000000001',
      from: CALLER,
      to: MAC,
      replyTo: null,
      text: 'Ready?',
      sentAt: NOW,
      delivered: false,
      read: false
    })
  })

  it('answers "Delivered to <name>." for a tab on this device that runs the session', () => {
    const { hub, store } = setup()
    expect(hub.send('tab-1', 'parser · Desktop', 'Look at this', null)).toEqual({
      ok: true,
      info: 'Delivered to parser · Desktop.'
    })
    expect(store.all()).toHaveLength(1)
    expect(store.all()[0].to).toEqual(LOCAL)
  })

  it('answers "Waiting: <device> is not connected; ..." for an offline device, and writes the record', () => {
    const { hub, store } = setup()
    // no device name is known for DEV_C, so the name is taken from the address: "Laptop #2" becomes "Laptop"
    const offline: MailAddress = { device: DEV_C, session: SES_OFF, name: 'laptop-tab · Laptop #2' }
    store.add(record({ from: CALLER, to: offline, text: 'earlier', read: true, delivered: true }))
    expect(hub.send('tab-1', 'laptop-tab · Laptop #2', 'hi', null)).toEqual({
      ok: true,
      info: 'Waiting: Laptop is not connected; the message goes out when it connects.'
    })
    const written = store.all().find(r => r.text === 'hi')
    expect(written?.to).toEqual(offline)
    expect(written?.delivered).toBe(false)
  })

  it('answers "<name> is closed." and writes nothing when an online device runs no tab for that session', () => {
    const { hub, store } = setup()
    const gone: MailAddress = { device: DEV_B, session: SES_GONE, name: 'old-tab · MacBook' }
    store.add(record({ to: gone, read: true, delivered: true }))
    const before = store.all().length
    expect(hub.send('tab-1', 'old-tab · MacBook', 'hi', null)).toEqual({
      ok: false,
      error: 'old-tab · MacBook is closed.'
    })
    expect(store.all()).toHaveLength(before)
  })

  it('answers "<device> does not accept agent messages." and writes nothing', () => {
    const { hub, store, world } = setup()
    const noAcc: MailAddress = { device: DEV_D, session: SES_NOACC, name: 'desk-tab · Workstation' }
    store.add(record({ to: noAcc, read: true, delivered: true }))
    const before = store.all().length
    expect(hub.send('tab-1', 'desk-tab · Workstation', 'hi', null)).toEqual({
      ok: false,
      error: 'Workstation does not accept agent messages.'
    })
    expect(store.all()).toHaveLength(before)
    expect(world.accepting.has(DEV_D)).toBe(false)
  })

  it('answers "Agent messages are turned off in ClaudeTerm on this device." when messages are off', () => {
    const { hub, store, world } = setup()
    world.enabled = false
    expect(hub.send('tab-1', 'parser · Desktop', 'hi', null)).toEqual({
      ok: false,
      error: 'Agent messages are turned off in ClaudeTerm on this device.'
    })
    expect(store.all()).toHaveLength(0)
  })

  it('answers "A message is at most 8000 characters." over the limit, and takes exactly the limit', () => {
    const { hub, store } = setup()
    expect(hub.send('tab-1', 'parser · Desktop', 'x'.repeat(MAIL_TEXT_MAX + 1), null)).toEqual({
      ok: false,
      error: 'A message is at most 8000 characters.'
    })
    expect(store.all()).toHaveLength(0)
    expect(hub.send('tab-1', 'parser · Desktop', 'x'.repeat(MAIL_TEXT_MAX), null)).toEqual({
      ok: true,
      info: 'Delivered to parser · Desktop.'
    })
  })

  it('refuses an empty text', () => {
    const { hub, store } = setup()
    expect(hub.send('tab-1', 'parser · Desktop', '  \n\t ', null)).toEqual({
      ok: false,
      error: 'A message needs a text.'
    })
    expect(store.all()).toHaveLength(0)
  })

  it('refuses a reply_to that names an unknown message, and stores a known one as replyTo', () => {
    const { hub, store } = setup()
    const unknown = '0a0a0a0a-0000-4000-8000-000000000000'
    expect(hub.send('tab-1', 'parser · Desktop', 'answer', unknown)).toEqual({
      ok: false,
      error: `No message with id "${unknown}".`
    })
    const asked = record({ from: MAC, to: CALLER, text: 'question', read: true, delivered: true })
    store.add(asked)
    expect(hub.send('tab-1', 'acme-dashboard · MacBook', 'answer', asked.id)).toEqual({
      ok: true,
      info: 'Delivered to acme-dashboard · MacBook.'
    })
    expect(store.all().find(r => r.text === 'answer')?.replyTo).toBe(asked.id)
  })

  it('refuses a caller that is not a Claude tab with a session', () => {
    const { hub, store } = setup()
    expect(hub.send('tab-9', 'parser · Desktop', 'hi', null)).toEqual({
      ok: false,
      error: 'Only a Claude tab with a session can send agent messages.'
    })
    expect(store.all()).toHaveLength(0)
  })

  it('does not resolve the caller itself as a target', () => {
    const { hub } = setup()
    expect(hub.send('tab-1', 'api-server · Desktop', 'hi', null)).toEqual({
      ok: false,
      error: 'No agent named "api-server · Desktop"; call list_agents.'
    })
  })

  it('stores the text as given, not trimmed', () => {
    const { hub, store } = setup()
    hub.send('tab-1', 'parser · Desktop', '  spaced  ', null)
    expect(store.all()[0].text).toBe('  spaced  ')
  })
})

describe('MailHub.list', () => {
  it('lists the agents without the caller, and the devices that do not accept messages', () => {
    const { hub, world } = setup()
    world.notAccepting = ['Workstation']
    const agents = nameAgents(world.agentTabs.filter(t => t.tabId !== 'tab-1'))
    expect(hub.list('tab-1')).toEqual({ ok: true, info: formatAgentList(agents, ['Workstation']) })
    const info = hub.list('tab-1')
    expect(info).toMatchObject({ ok: true })
    expect((info as { info: string }).info).not.toContain('api-server · Desktop [')
    expect((info as { info: string }).info).toContain('acme-dashboard · MacBook [c5df49]')
  })

  it('answers the error when messages are off or the caller is not a Claude tab', () => {
    const { hub, world } = setup()
    expect(hub.list('tab-9')).toEqual({ ok: false, error: 'Only a Claude tab with a session can list agents.' })
    world.enabled = false
    expect(hub.list('tab-1')).toEqual({ ok: false, error: 'Agent messages are turned off in ClaudeTerm on this device.' })
  })
})

describe('MailHub.wait', () => {
  it('resolves with the wake text as info when mail for that session is waiting, and marks it delivered', async () => {
    const { hub, store } = setup()
    const mail = record({ from: MAC, to: LOCAL, text: 'Ready for review.' })
    store.add(mail)
    const res = await hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    expect(res).toEqual({
      ok: true,
      info: wakeText([mail], () => ({ folder: null, branch: null }))
    })
    expect(store.get(mail.id)?.delivered).toBe(true)
  })

  it("a device id equal to this device's own id counts as this device", async () => {
    const { hub, store } = setup()
    const mail = record({ from: MAC, to: { device: SELF, session: SES_LOCAL, name: LOCAL.name }, text: 'Via own id.' })
    store.add(mail)
    const res = await hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    expect(res).toMatchObject({ ok: true, info: expect.stringContaining('Via own id.') })
  })

  it('holds until mail arrives (a merge from a link), then resolves', async () => {
    const { hub, store } = setup()
    const p = hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    const state = settledOf(p)
    await tick()
    expect(state.done).toBe(false)
    const mail = record({ from: MAC, to: LOCAL, text: 'From the link.' })
    store.merge([mail], { link: 'peer' })
    const res = await p
    expect(res).toMatchObject({ ok: true, info: expect.stringContaining('From the link.') })
    expect(store.get(mail.id)?.delivered).toBe(true)
  })

  it('a second wait of the same tab answers the first one { ok: true } at once, and holds the new one', async () => {
    const { hub, store } = setup()
    const first = hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    const second = hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    expect(await first).toEqual({ ok: true })
    const mail = record({ from: MAC, to: LOCAL, text: 'For the newest watcher.' })
    store.merge([mail], { link: 'peer' })
    expect(await second).toMatchObject({ ok: true, info: expect.stringContaining('For the newest watcher.') })
  })

  it('answers { ok: true } at once when messages are off', async () => {
    const { hub, store, world } = setup()
    world.enabled = false
    store.add(record({ from: MAC, to: LOCAL }))
    expect(await hub.wait('tab-2', SES_LOCAL, new AbortController().signal)).toEqual({ ok: true })
  })

  it('a wait whose signal aborts is dropped: later mail is not marked delivered, and the next watcher gets it', async () => {
    const { hub, store } = setup()
    const ac = new AbortController()
    const p = hub.wait('tab-2', SES_LOCAL, ac.signal)
    ac.abort()
    expect(await p).toEqual({ ok: true })
    const mail = record({ from: MAC, to: LOCAL, text: 'After the watcher died.' })
    store.merge([mail], { link: 'peer' })
    expect(store.get(mail.id)?.delivered).toBe(false)
    const next = await hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    expect(next).toMatchObject({ ok: true, info: expect.stringContaining('After the watcher died.') })
    expect(store.get(mail.id)?.delivered).toBe(true)
  })

  it('a wait that starts with its signal already aborted answers ok and takes no mail', async () => {
    const { hub, store } = setup()
    const mail = record({ from: MAC, to: LOCAL, text: 'Left for later.' })
    store.add(mail)
    const ac = new AbortController()
    ac.abort()
    expect(await hub.wait('tab-2', SES_LOCAL, ac.signal)).toEqual({ ok: true })
    expect(store.get(mail.id)?.delivered).toBe(false)
  })

  it('mail for a session no tab runs stays undelivered; after alias(old, new) and tabsChanged it goes to the tab running new', async () => {
    const { hub, store, world } = setup()
    world.localTabs = { [SES_NEW]: 'tab-2' }
    const mail = record({ from: MAC, to: { device: null, session: SES_OLD, name: 'parser · Desktop' }, text: 'Sent to the old id.' })
    store.add(mail)
    const p = hub.wait('tab-2', SES_NEW, new AbortController().signal)
    const state = settledOf(p)
    await tick()
    expect(state.done).toBe(false)
    expect(store.get(mail.id)?.delivered).toBe(false)

    hub.alias(SES_OLD, SES_NEW)
    hub.tabsChanged()
    expect(await p).toMatchObject({ ok: true, info: expect.stringContaining('Sent to the old id.') })
    expect(store.get(mail.id)?.delivered).toBe(true)
  })

  it('alias follows a chain: A to B and B to C reaches the tab running C', async () => {
    const { hub, store, world } = setup()
    world.localTabs = { [SES_C]: 'tab-2' }
    const mail = record({ from: MAC, to: { device: null, session: SES_A, name: 'parser · Desktop' }, text: 'Down the chain.' })
    store.add(mail)
    hub.alias(SES_A, SES_B)
    hub.alias(SES_B, SES_C)
    hub.tabsChanged()
    expect(await hub.wait('tab-2', SES_C, new AbortController().signal)).toMatchObject({
      ok: true,
      info: expect.stringContaining('Down the chain.')
    })
  })

  it('takeMailTurn is true once after mail was handed over, and false after userTurn', async () => {
    const { hub, store } = setup()
    store.add(record({ from: MAC, to: LOCAL }))
    await hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    expect(hub.takeMailTurn('tab-2')).toBe(true)
    expect(hub.takeMailTurn('tab-2')).toBe(false)

    store.add(record({ from: MAC, to: LOCAL }))
    await hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    hub.userTurn('tab-2')
    expect(hub.takeMailTurn('tab-2')).toBe(false)
  })
})

describe('MailHub mail turns', () => {
  const signal = (): AbortSignal => new AbortController().signal

  it('mail handed to an idle tab starts a mail turn, and only the next done is a mail turn', async () => {
    const { hub, store } = setup()
    store.add(record({ from: MAC, to: LOCAL }))
    await hub.wait('tab-2', SES_LOCAL, signal())
    expect(hub.takeMailTurn('tab-2')).toBe(true)
    expect(hub.takeMailTurn('tab-2')).toBe(false)
  })

  it('mail handed to a watcher armed before the user\'s turn does not make the user\'s turn a mail turn', async () => {
    const { hub, store } = setup()
    // the watcher of the previous Stop holds; the user types a prompt; then mail comes to that watcher
    const held = hub.wait('tab-2', SES_LOCAL, signal())
    hub.userTurn('tab-2')
    store.add(record({ from: MAC, to: LOCAL, text: 'during the user turn' }))
    expect(await held).toMatchObject({ ok: true, info: expect.stringContaining('during the user turn') })
    expect(hub.takeMailTurn('tab-2')).toBe(false)
  })

  it('a wait that arrives after the Stop of the user\'s turn starts the next turn: that done is a mail turn, the one after is not', async () => {
    const { hub, store } = setup()
    hub.userTurn('tab-2')
    store.add(record({ from: MAC, to: LOCAL, text: 'pending at the Stop' }))
    expect(hub.takeMailTurn('tab-2')).toBe(false)
    expect(await hub.wait('tab-2', SES_LOCAL, signal())).toMatchObject({ ok: true, info: expect.stringContaining('pending at the Stop') })
    expect(hub.takeMailTurn('tab-2')).toBe(true)
    expect(hub.takeMailTurn('tab-2')).toBe(false)
  })

  it('a wait that arrives during the user\'s turn, before its Stop, starts the turn after it: the user\'s done is not a mail turn, the next done is', async () => {
    const { hub, store } = setup()
    hub.userTurn('tab-2')
    store.add(record({ from: MAC, to: LOCAL, text: 'pending during the turn' }))
    expect(await hub.wait('tab-2', SES_LOCAL, signal())).toMatchObject({ ok: true, info: expect.stringContaining('pending during the turn') })
    expect(hub.takeMailTurn('tab-2')).toBe(false)
    expect(hub.takeMailTurn('tab-2')).toBe(true)
    expect(hub.takeMailTurn('tab-2')).toBe(false)
  })

  it('two hand-overs over two turns are counted separately', async () => {
    const { hub, store } = setup()
    store.add(record({ from: MAC, to: LOCAL, text: 'first' }))
    await hub.wait('tab-2', SES_LOCAL, signal())
    expect(hub.takeMailTurn('tab-2')).toBe(true)
    store.add(record({ from: MAC, to: LOCAL, text: 'second' }))
    await hub.wait('tab-2', SES_LOCAL, signal())
    expect(hub.takeMailTurn('tab-2')).toBe(true)
    expect(hub.takeMailTurn('tab-2')).toBe(false)
  })

  it('the tabs count their turns apart', async () => {
    const { hub, store } = setup()
    store.add(record({ from: MAC, to: LOCAL }))
    await hub.wait('tab-2', SES_LOCAL, signal())
    expect(hub.takeMailTurn('tab-1')).toBe(false)
    expect(hub.takeMailTurn('tab-2')).toBe(true)
  })
})

describe('MailHub turns interrupted with Esc', () => {
  const signal = (): AbortSignal => new AbortController().signal

  it('a turn the user interrupted (no Stop) is not busy: mail that then arrives starts a mail turn', async () => {
    const { hub, store, world } = setup()
    // the watcher of the previous Stop holds; the user types a prompt and presses Esc, so no Stop comes
    const held = hub.wait('tab-2', SES_LOCAL, signal())
    hub.userTurn('tab-2')
    world.working['tab-2'] = false
    store.add(record({ from: MAC, to: LOCAL, text: 'after the Esc' }))
    expect(await held).toMatchObject({ ok: true, info: expect.stringContaining('after the Esc') })
    expect(hub.takeMailTurn('tab-2')).toBe(true)
    expect(hub.takeMailTurn('tab-2')).toBe(false)
  })

  it('the same while the tab is still working: the mail goes into the running turn, which is not a mail turn', async () => {
    const { hub, store, world } = setup()
    const held = hub.wait('tab-2', SES_LOCAL, signal())
    hub.userTurn('tab-2')
    world.working['tab-2'] = true
    store.add(record({ from: MAC, to: LOCAL, text: 'during the turn' }))
    expect(await held).toMatchObject({ ok: true, info: expect.stringContaining('during the turn') })
    expect(hub.takeMailTurn('tab-2')).toBe(false)
  })
})

describe('MailHub turn state of a closed tab', () => {
  it('a tab that closed and comes back under its id starts with no turn state', async () => {
    const { hub, store, world } = setup()
    store.add(record({ from: MAC, to: LOCAL, text: 'handed before the close' }))
    await hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    world.closedTabs.add('tab-2')
    hub.tabsChanged()
    world.closedTabs.delete('tab-2')
    expect(hub.takeMailTurn('tab-2')).toBe(false)
  })
})

describe('MailHub held waits of a closed tab', () => {
  it('a tab that closed releases its held wait { ok: true } at the next tabsChanged', async () => {
    const { hub, world } = setup()
    const p = hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    world.closedTabs.add('tab-2')
    hub.tabsChanged()
    const state = settledOf(p)
    await tick()
    expect(state.done).toBe(true)
    expect(await p).toEqual({ ok: true })
  })

  it('a session no tab runs yet keeps its held wait: the watcher can come before the session message', async () => {
    const { hub, world } = setup()
    world.localTabs = {}
    const p = hub.wait('tab-2', SES_NEW, new AbortController().signal)
    hub.tabsChanged()
    const state = settledOf(p)
    await tick()
    expect(state.done).toBe(false)
    hub.close()
    expect(await p).toEqual({ ok: true })
  })
})

describe('MailHub wake text size', () => {
  it('one wait gets the oldest messages that fit in 9500 characters; the next wait gets the rest', async () => {
    const { hub, store } = setup()
    const first = record({ from: MAC, to: LOCAL, text: 'a'.repeat(8000), sentAt: NOW })
    const second = record({ from: MAC, to: LOCAL, text: 'b'.repeat(8000), sentAt: NOW + 1 })
    store.add(first)
    store.add(second)
    const one = await hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    expect(one).toMatchObject({ ok: true, info: expect.stringContaining('a'.repeat(8000)) })
    expect((one as { info: string }).info).not.toContain('b'.repeat(10))
    expect((one as { info: string }).info.length).toBeLessThanOrEqual(9500)
    expect(store.get(first.id)?.delivered).toBe(true)
    expect(store.get(second.id)?.delivered).toBe(false)

    const two = await hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    expect(two).toMatchObject({ ok: true, info: expect.stringContaining('b'.repeat(8000)) })
    expect(store.get(second.id)?.delivered).toBe(true)
  })
})

describe('MailHub names and record check', () => {
  it('a caller with a long name whose record the check refuses writes nothing and answers the store error', () => {
    const { hub, store, world } = setup()
    world.callers['tab-1'] = { ...world.callers['tab-1'], name: 'z'.repeat(300) }
    expect(hub.send('tab-1', 'parser · Desktop', 'hi', null)).toEqual({
      ok: false,
      error: 'ClaudeTerm could not store this message.'
    })
    expect(store.all()).toHaveLength(0)
  })

  it('a caller named from a 500-character title and a title with control characters is stored, and its record passes checkMailRecord', () => {
    const { hub, store, world } = setup()
    world.agentTabs[0] = tab({
      tabId: 'tab-1',
      session: SES_CALLER,
      customTitle: `Line one\n\u0007${'y'.repeat(500)}`,
      folder: 'D:\\Work\\api-server',
      branch: 'feat/revenue-units'
    })
    const [caller] = nameAgents(world.agentTabs)
    world.callers['tab-1'] = { tabId: 'tab-1', device: null, session: SES_CALLER, name: caller.name }
    expect(hub.send('tab-1', 'parser · Desktop', 'hi', null)).toEqual({ ok: true, info: 'Delivered to parser · Desktop.' })
    const [r] = store.all()
    expect(checkMailRecord(r)).not.toBeNull()
    expect(r.from.name.length).toBeLessThanOrEqual(200)
  })
})

describe('MailHub hold rules', () => {
  it('messages turned off release a held wait with { ok: true }, and no mail is handed over', async () => {
    const { hub, store, world } = setup()
    const p = hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    world.enabled = false
    const mail = record({ from: MAC, to: LOCAL, text: 'While off.' })
    store.add(mail)
    expect(await p).toEqual({ ok: true })
    expect(store.get(mail.id)?.delivered).toBe(false)
  })

  it('messages turned off release a held wait on tabsChanged too, and nothing is marked delivered', async () => {
    const { hub, store, world } = setup()
    const p = hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    world.enabled = false
    hub.tabsChanged()
    expect(await p).toEqual({ ok: true })
    const mail = record({ from: MAC, to: LOCAL, text: 'Still off.' })
    store.add(mail)
    expect(store.get(mail.id)?.delivered).toBe(false)
  })

  it('after messages are turned on again, a new wait gets the mail', async () => {
    const { hub, store, world } = setup()
    const p = hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    world.enabled = false
    const mail = record({ from: MAC, to: LOCAL, text: 'Waited while off.' })
    store.add(mail)
    expect(await p).toEqual({ ok: true })
    world.enabled = true
    expect(await hub.wait('tab-2', SES_LOCAL, new AbortController().signal)).toMatchObject({
      ok: true,
      info: expect.stringContaining('Waited while off.')
    })
    expect(store.get(mail.id)?.delivered).toBe(true)
  })

  it('a new wait supersedes the held one even with messages off', async () => {
    const { hub, world } = setup()
    const first = hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    const state = settledOf(first)
    await tick()
    expect(state.done).toBe(false)
    world.enabled = false
    expect(await hub.wait('tab-2', SES_LOCAL, new AbortController().signal)).toEqual({ ok: true })
    await tick()
    expect(state.done).toBe(true)
    expect(await first).toEqual({ ok: true })
  })

  it('aborting a superseded wait later does not touch the newer watcher', async () => {
    const { hub, store } = setup()
    const old = new AbortController()
    const first = hub.wait('tab-2', SES_LOCAL, old.signal)
    const second = hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    expect(await first).toEqual({ ok: true })
    old.abort()
    const mail = record({ from: MAC, to: LOCAL, text: 'For the newer watcher.' })
    store.merge([mail], { link: 'peer' })
    expect(await second).toMatchObject({ ok: true, info: expect.stringContaining('For the newer watcher.') })
    expect(store.get(mail.id)?.delivered).toBe(true)
  })

  it('aborting a wait after it resolved does nothing', async () => {
    const { hub, store } = setup()
    const ac = new AbortController()
    store.add(record({ from: MAC, to: LOCAL, text: 'Handed at once.' }))
    expect(await hub.wait('tab-2', SES_LOCAL, ac.signal)).toMatchObject({
      ok: true,
      info: expect.stringContaining('Handed at once.')
    })
    expect(() => ac.abort()).not.toThrow()
    const next = hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    const mail = record({ from: MAC, to: LOCAL, text: 'Later.' })
    store.add(mail)
    expect(await next).toMatchObject({ ok: true, info: expect.stringContaining('Later.') })
    expect(store.get(mail.id)?.delivered).toBe(true)
  })

  it('mail is handed over once across two tabsChanged calls, and not again to a later wait', async () => {
    const { hub, store, world } = setup()
    world.localTabs = { [SES_NEW]: 'tab-2' }
    const mail = record({ from: MAC, to: { device: null, session: SES_OLD, name: 'parser · Desktop' }, text: 'Once only.' })
    store.add(mail)
    const first = hub.wait('tab-2', SES_NEW, new AbortController().signal)
    hub.alias(SES_OLD, SES_NEW)
    hub.tabsChanged()
    expect(await first).toMatchObject({ ok: true, info: expect.stringContaining('Once only.') })
    hub.tabsChanged()
    const again = hub.wait('tab-2', SES_NEW, new AbortController().signal)
    const state = settledOf(again)
    await tick()
    expect(state.done).toBe(false)
    expect(store.get(mail.id)?.delivered).toBe(true)
    hub.close()
    expect(await again).toEqual({ ok: true })
  })

  it('close answers the held waits { ok: true } and stops the store listener', async () => {
    const { hub, store, onUnread } = setup()
    const p = hub.wait('tab-2', SES_LOCAL, new AbortController().signal)
    hub.close()
    expect(await p).toEqual({ ok: true })
    onUnread.mockClear()
    store.add(record())
    expect(onUnread).not.toHaveBeenCalled()
  })

  it('markRead that changes a message calls onUnread exactly once', () => {
    const { hub, store, onUnread } = setup()
    const r = record()
    store.add(r)
    onUnread.mockClear()
    hub.markRead([r.id])
    expect(onUnread).toHaveBeenCalledTimes(1)
  })

  it('markRead of a message already read does not call onUnread', () => {
    const { hub, store, onUnread } = setup()
    const r = record({ read: true })
    store.add(r)
    onUnread.mockClear()
    hub.markRead([r.id])
    expect(onUnread).not.toHaveBeenCalled()
  })
})

describe('MailHub unread and conversations', () => {
  it("unreadByTab counts unread messages addressed to or from each tab's session; markRead clears them", () => {
    const { hub, store, onUnread } = setup()
    const r1 = record({ from: CALLER, to: MAC })
    const r2 = record({ from: LOCAL, to: MAC })
    const r3 = record({ from: MAC, to: CALLER, read: true })
    store.add(r1)
    store.add(r2)
    store.add(r3)
    const tabs = [
      { tabId: 'tab-1', device: null, session: SES_CALLER },
      { tabId: 'tab-2', device: null, session: SES_LOCAL },
      { tabId: 'tab-3', device: DEV_B, session: SES_MAC },
      { tabId: 'tab-4', device: null, session: null }
    ]
    expect(hub.unreadByTab(tabs)).toEqual({ 'tab-1': 1, 'tab-2': 1, 'tab-3': 2 })

    onUnread.mockClear()
    hub.markRead([r1.id, r2.id])
    expect(onUnread).toHaveBeenCalled()
    expect(hub.unreadByTab(tabs)).toEqual({})
  })

  it('onUnread fires on every store change', () => {
    const { store, onUnread } = setup()
    store.add(record())
    expect(onUnread).toHaveBeenCalledTimes(1)
  })

  it('conversations groups messages by the pair of addresses, newest conversation first, messages oldest first', () => {
    const { hub, store } = setup()
    store.add(record({ from: CALLER, to: MAC, text: 'one', sentAt: NOW }))
    store.add(record({ from: MAC, to: CALLER, text: 'two', sentAt: NOW + 1000 }))
    store.add(record({ from: { ...CALLER, device: SELF }, to: LOCAL, text: 'three', sentAt: NOW + 2000 }))

    const all = hub.conversations(null)
    expect(all.map(c => c.lastAt)).toEqual([NOW + 2000, NOW + 1000])
    const mac = all[1]
    expect(mac.messages.map(m => m.text)).toEqual(['one', 'two'])
    expect(mac.messages[0].from.name).toBe('api-server · Desktop')
    expect(mac.messages[0].from.device).toBeNull()
    expect(mac.messages[1].from.name).toBe('acme-dashboard · MacBook')
    expect(mac.messages[1].from.device).toBe(DEV_B)
    expect([mac.a.name, mac.b.name].sort()).toEqual(['acme-dashboard · MacBook', 'api-server · Desktop'])
    expect(mac.key.split('|')).toHaveLength(2)
    expect(all[0].messages.map(m => m.text)).toEqual(['three'])
    // this device's own id is shown as this device (null)
    expect(all[0].a.device).toBeNull()
    expect(all[0].b.device).toBeNull()
  })

  it('conversations(of) keeps only the conversations with that address on one end', () => {
    const { hub, store } = setup()
    store.add(record({ from: CALLER, to: MAC, text: 'to mac' }))
    store.add(record({ from: CALLER, to: LOCAL, text: 'to local', sentAt: NOW + 1 }))
    expect(hub.conversations({ device: null, session: SES_CALLER })).toHaveLength(2)
    const mac = hub.conversations({ device: DEV_B, session: SES_MAC })
    expect(mac).toHaveLength(1)
    expect(mac[0].messages.map(m => m.text)).toEqual(['to mac'])
    expect(hub.conversations({ device: null, session: SES_GONE })).toEqual([])
  })

  it('mine is the end of the asked address, and null when every conversation is asked for', () => {
    const { hub, store } = setup()
    store.add(record({ from: CALLER, to: MAC, text: 'to mac' }))
    const [asCaller] = hub.conversations({ device: null, session: SES_CALLER })
    const [asMac] = hub.conversations({ device: DEV_B, session: SES_MAC })
    const mineName = (c: MailConversationView): string | undefined => (c.mine === 'a' ? c.a : c.mine === 'b' ? c.b : undefined)?.name
    expect(asCaller.mine).not.toBeNull()
    expect(mineName(asCaller)).toBe(CALLER.name)
    expect(asMac.mine).not.toBeNull()
    expect(mineName(asMac)).toBe(MAC.name)
    expect(hub.conversations(null).map(c => c.mine)).toEqual([null])
  })

  it('names a device with no known name after the address, without its " #n"', () => {
    const { hub, store } = setup()
    const other: MailAddress = { device: DEV_C, session: SES_OFF, name: 'laptop-tab · Laptop #2' }
    store.add(record({ from: CALLER, to: other, text: 'unknown device' }))
    const [conv] = hub.conversations({ device: DEV_C, session: SES_OFF })
    const end = conv.a.device === DEV_C ? conv.a : conv.b
    expect(end.deviceName).toBe('Laptop')
  })
})

describe("MailHub messages of Claude Code's own messaging", () => {
  const MSG = '30000000-0000-4000-8000-000000000001'
  const sent = (o: Partial<{ id: string; peer: string; text: string; at: number | null; read: boolean }> = {}) =>
    ({ kind: 'sent' as const, id: MSG, peer: 'Build session', text: 'The build is green', at: NOW - 5000, read: false, ...o })
  const received = (o: Partial<{ id: string; peer: string; text: string; at: number | null; read: boolean }> = {}) =>
    ({ ...sent(o), kind: 'received' as const })
  const tabs = [
    { tabId: 'tab-1', device: null, session: SES_CALLER },
    { tabId: 'tab-2', device: null, session: SES_LOCAL }
  ]
  const twoTabs = () => {
    const s = setup()
    s.world.callers['tab-2'] = { tabId: 'tab-2', device: null, session: SES_LOCAL, name: 'parser · Desktop' }
    return s
  }

  it('a message a tab sent is kept as delivered, from the tab to the session it went to, by its name, and is unread', async () => {
    const { hub, store } = setup()
    hub.peerMail('tab-1', sent())
    const [r] = store.all()
    expect(r).toMatchObject({ id: MSG, text: 'The build is green', sentAt: NOW - 5000, delivered: true, read: false })
    expect(r.from).toMatchObject({ session: SES_CALLER, name: 'api-server · Desktop' })
    expect(r.to.name).toBe('Build session')
    expect(hub.unreadByTab(tabs)).toEqual({ 'tab-1': 1 })
    const [conv] = hub.conversations({ device: null, session: SES_CALLER })
    expect(conv.messages.map(m => [m.from.name, m.text])).toEqual([['api-server · Desktop', 'The build is green']])
    // delivered by Claude Code: a watcher of ClaudeTerm is not handed it again, it keeps waiting
    const closed = new AbortController()
    const waiting = settledOf(hub.wait('tab-1', SES_CALLER, closed.signal))
    await tick()
    expect(waiting.done).toBe(false)
    closed.abort()
  })

  it('the message the other tab received too is one message between the two tabs, whichever transcript shows it first', () => {
    for (const order of [['tab-1', 'tab-2'], ['tab-2', 'tab-1']]) {
      const { hub, store } = twoTabs()
      for (const tabId of order) hub.peerMail(tabId, tabId === 'tab-1' ? sent({ peer: 'parser' }) : received({ peer: 'api-server' }))
      expect(store.all()).toHaveLength(1)
      const [r] = store.all()
      expect([r.from.session, r.to.session]).toEqual([SES_CALLER, SES_LOCAL])
      expect(hub.unreadByTab(tabs)).toEqual({ 'tab-1': 1, 'tab-2': 1 })
      const all = hub.conversations(null)
      expect(all).toHaveLength(1)
      expect([all[0].a.name, all[0].b.name].sort()).toEqual(['api-server · Desktop', 'parser · Desktop'])
    }
  })

  it('messages to and from a session outside ClaudeTerm are one conversation under its name', () => {
    const { hub } = setup()
    hub.peerMail('tab-1', received({ id: '30000000-0000-4000-8000-000000000002', text: 'Is the build green?', at: NOW - 9000 }))
    hub.peerMail('tab-1', sent())
    const [conv, ...rest] = hub.conversations({ device: null, session: SES_CALLER })
    expect(rest).toEqual([])
    expect(conv.messages.map(m => [m.from.name, m.text])).toEqual([['Build session', 'Is the build green?'], ['api-server · Desktop', 'The build is green']])
  })

  it('a message the transcript held before the tab read it is read; a copy seen unread later does not make it unread', () => {
    const { hub, store } = twoTabs()
    hub.peerMail('tab-1', sent({ peer: 'parser', read: true }))
    hub.peerMail('tab-2', received({ peer: 'api-server' }))
    expect(store.all()[0].read).toBe(true)
    expect(hub.unreadByTab(tabs)).toEqual({})
  })

  it('a message seen again is not written again', () => {
    const { hub, onUnread } = setup()
    hub.peerMail('tab-1', sent())
    onUnread.mockClear()
    hub.peerMail('tab-1', sent())
    expect(onUnread).not.toHaveBeenCalled()
  })

  it('nothing is kept with messages off, for a tab with no session, or for a message older than the keep time; a long text is cut', () => {
    const { hub, store, world } = setup()
    world.enabled = false
    hub.peerMail('tab-1', sent())
    world.enabled = true
    hub.peerMail('tab-9', sent())
    hub.peerMail('tab-1', sent({ at: NOW - 31 * 24 * 60 * 60 * 1000 }))
    hub.peerMail('tab-1', sent({ id: 'msg-7' }))
    expect(store.all()).toEqual([])
    hub.peerMail('tab-1', sent({ text: 'x'.repeat(MAIL_TEXT_MAX + 50), at: null }))
    const [r] = store.all()
    expect(r.text).toHaveLength(MAIL_TEXT_MAX)
    expect(r.sentAt).toBe(NOW)
  })

  it('a session known only by its Claude Code name is no address for message_agent', () => {
    const { hub } = setup()
    hub.peerMail('tab-1', received())
    expect(hub.send('tab-1', 'Build session', 'hi', null)).toEqual({ ok: false, error: 'No agent named "Build session"; call list_agents.' })
  })
})
