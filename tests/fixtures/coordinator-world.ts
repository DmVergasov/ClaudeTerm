import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoordinatorHub, type HubPeer, type HubRemoteTab, type HubTab, type RemoteOpened } from '../../src/main/coordinator/coordinator-hub'
import { CoordinatorStore, type StoredAttachment } from '../../src/main/coordinator/coordinator-store'
import { nameAgents, type Agent, type AgentTab } from '../../src/main/mail/agent-directory'
import { isShareable, MailStore } from '../../src/main/mail/mail-store'
import type { TabWaitsState } from '../../src/main/tab-waits'
import type { MailRecord } from '../../src/shared/mail'
import type { RemoteCoordFacts } from '../../src/shared/remote'
import type { OpenTabRequest, PlanStatus } from '../../src/shared/types'

// The coordinator hub's test world: one device's hub on a temp store, with fake tabs, waits, plans and agents.

export const NOW = 1_700_000_000_000
export const ACME = { key: 'd:\\work\\acme', name: 'acme' }
export const BETA = { key: 'd:\\work\\beta', name: 'beta' }
export const S = {
  coord: 'c0000000-0000-4000-8000-000000000001',
  one: 'a1000000-0000-4000-8000-000000000002',
  two: 'b2000000-0000-4000-8000-000000000003',
  beta: 'be000000-0000-4000-8000-000000000004'
}
export const TITLES: Record<string, string> = { 'tab-c': 'coord', 'tab-1': 'parser', 'tab-2': 'docs', 'tab-b': 'beta', 'tab-l1': 'parser', 'tab-l2': 'docs', 'tab-lc': 'lead' }

/** the two devices of the tests of rows of other devices: Studio runs the coordinator, Laptop the sessions */
export const DEV_C = 'c1000000-0000-4000-8000-0000000000c1'
export const DEV_S = '5a000000-0000-4000-8000-0000000000a1'
/** Laptop's project of the same name as Studio's, in its own folder */
export const ACME_L = { key: '/home/sam/acme', name: 'acme' }
/** Laptop's sessions: one and two are tabs in ACME_L, lead is the coordinator there */
export const L = { one: 'e1000000-0000-4000-8000-000000000011', two: 'e2000000-0000-4000-8000-000000000012', lead: 'e3000000-0000-4000-8000-000000000013', fresh: 'e4000000-0000-4000-8000-000000000014' }
/** ids of records and sessions the tests of later tasks make */
export const NEW = { coord: 'f1000000-0000-4000-8000-000000000021', one: 'f2000000-0000-4000-8000-000000000022' }
export const NO_FACTS: RemoteCoordFacts = { prompt: null, limit: null, progress: null, task: null, attachedTo: null, coordinator: false }

/** a paired device as the coordinator's hub sees it: linked, listed, knowing coordinator records, its mail watcher waking a session */
export const peerOf = (id: string, name: string, over: Partial<HubPeer> = {}): HubPeer => ({ id, name, online: true, listed: true, coord: true, mail: true, ...over })

/** a tab of another device as this window lists it: Laptop's parser, in ACME_L's folder on the main account */
export const remoteTab = (over: Partial<HubRemoteTab> = {}): HubRemoteTab =>
  ({ device: DEV_S, tabId: 'tab-l1', claude: true, session: L.one, name: 'parser · Laptop', folder: '/home/sam/acme', branch: 'main', project: 'acme', working: false, exited: false, coord: NO_FACTS, ...over })

/** the n-th id of a test, a UUID */
export const uid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

/** a world's ids for its records, counted up from a base of its own: two devices' records never share an id, as random ids never do */
export const idsFrom = (base: number): (() => string) => {
  let n = base
  return () => uid(++n)
}

export const tab = (tabId: string, session: string | null, project: { key: string; name: string } | null, over: Partial<HubTab> = {}): HubTab =>
  ({ tabId, session, account: null, folder: 'D:\\Work\\acme', exited: false, working: false, view: 'terminal', project, branch: 'main', ...over })

const tempDirs: string[] = []

/** removes the temp folders of the worlds made so far; a test file calls it in its afterEach */
export function cleanWorlds(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export interface WorldOptions {
  problem?: string | null
  /** this device's id: the hub's self(), and the device of this world's agents; null: none */
  self?: string | null
  /** this device's name: the hub's selfName(), and the device name of this world's agents */
  selfName?: string
  /** the tabs of this device, in place of the four default ones */
  tabs?: HubTab[]
  newId?: () => string
}

export function world(o: WorldOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ct-coord-'))
  tempDirs.push(dir)
  let ids = 0
  const warns: string[] = []
  const selfName = o.selfName ?? 'Desktop'
  const w = {
    now: NOW,
    tabs: o.tabs ?? [tab('tab-c', S.coord, ACME), tab('tab-1', S.one, ACME), tab('tab-2', S.two, ACME), tab('tab-b', S.beta, BETA, { folder: 'D:\\Work\\beta' })],
    waits: {} as Record<string, TabWaitsState>,
    progress: {} as Record<string, PlanStatus | null>,
    /** agents of other devices, listed with this device's */
    remote: [] as AgentTab[],
    /** the paired devices, and the tabs of them, as the hub's peers and remoteTabs deps give them */
    peers: [] as HubPeer[],
    remoteTabs: [] as HubRemoteTab[],
    /** how often the hub asked for the paired devices and their tabs */
    calls: { peers: 0, remoteTabs: 0 },
    opened: [] as OpenTabRequest[],
    /** the hub's openRemoteTab calls, in order: each gets remoteAnswer, or the default answer for its request */
    openedRemote: [] as { device: string; req: { cwd: string | null; email: string | null; title: string | null } }[],
    remoteAnswer: null as RemoteOpened | null,
    /** how far the clock moves while a paired device answers an open-tab */
    remoteDelayMs: 0,
    /** the email of this device's main account, and of the other accounts by id: what accountEmail gives */
    mainEmail: null as string | null,
    emails: {} as Record<string, string>,
    pokes: [] as string[],
    rechecks: 0,
    aliases: [] as [string, string][],
    warns,
    dir,
    /** the settle timers still waiting, as the hub asked for them */
    timers: [] as { ms: number; fn: () => void }[],
    /** the tabs that are not at rest now (every tab is, unless a test says otherwise) */
    resting: {} as Record<string, boolean>,
    /** the hub's calls to the window and the mail, in order */
    order: [] as string[],
    problem: o.problem ?? null,
    store: new CoordinatorStore(dir, { debounceMs: 100_000 }),
    mail: MailStore.open({ dir, now: () => NOW, debounceMs: 100_000 }),
    hub: null as unknown as CoordinatorHub,
    /** what the hub's agents dep returns: this device's Claude tabs with a session, then the agents of other devices */
    agentsOf: (): Agent[] =>
      nameAgents([
        ...w.tabs.flatMap((t): AgentTab[] =>
          t.session === null || t.exited
            ? []
            : [{ device: o.self || null, deviceName: selfName, tabId: t.tabId, session: t.session, customTitle: TITLES[t.tabId] ?? null, folder: t.folder, branch: t.branch, title: null, busy: t.working, wakes: true, claude: '2.1.300' }]
        ),
        ...w.remote
      ])
  }
  w.hub = new CoordinatorHub({
    store: w.store,
    mail: w.mail,
    self: () => o.self ?? null,
    selfName: () => selfName,
    problem: () => w.problem,
    tabs: () => w.tabs,
    agents: () => w.agentsOf(),
    waits: (tabId) => w.waits[tabId] ?? { prompt: null, limit: null },
    progress: (tabId) => w.progress[tabId] ?? null,
    peers: () => {
      w.calls.peers++
      return w.peers
    },
    remoteTabs: () => {
      w.calls.remoteTabs++
      return w.remoteTabs
    },
    taskList: () => null,
    restingNow: (tabId) => w.resting[tabId] ?? true,
    isDirectory: async (p) => p === 'D:\\Work\\acme',
    accountLabel: (a) => (a === null ? 'Main account' : `Account ${a}`),
    openTab: (req) => {
      w.opened.push(req)
      return `new-tab-${w.opened.length}`
    },
    openRemoteTab: async (device, req) => {
      w.openedRemote.push({ device, req })
      w.now += w.remoteDelayMs
      return w.remoteAnswer ?? { ok: true, tabId: 'rt-new', cwd: req.cwd ?? '/home/sam', accountName: 'Main account', defaulted: false }
    },
    accountEmail: (account) => (account === null ? w.mainEmail : (w.emails[account] ?? null)),
    recheckMail: () => {
      w.rechecks++
      w.order.push('recheck')
    },
    poke: (tabId) => {
      w.pokes.push(tabId)
      w.order.push(`poke:${tabId}`)
    },
    changed: () => {
      w.order.push('changed')
    },
    alias: (a, b) => {
      w.aliases.push([a, b])
    },
    clock: (ms) => new Date(ms).toISOString().slice(11, 16),
    now: () => w.now,
    later: (ms, fn) => {
      const timer = { ms, fn }
      w.timers.push(timer)
      return () => {
        w.timers = w.timers.filter((t) => t !== timer)
      }
    },
    newId: o.newId ?? (() => uid(++ids)),
    log: {
      info: () => {},
      warn: (m) => {
        warns.push(m)
      }
    }
  })
  for (const t of w.tabs) w.hub.tabSession(t.tabId, t.session)
  return w
}

export type World = ReturnType<typeof world>

export const records = (w: World, kind: MailRecord['kind']): MailRecord[] => w.mail.all().filter((r) => r.kind === kind)

/** runs the settle timers that wait now */
export const fire = (w: World): void => {
  const due = w.timers
  w.timers = []
  for (const t of due) t.fn()
}

/** an attachment of Laptop's parser to the coordinator S.coord, written straight into the store: the coordinator's attachments are these only; `pending` is the attach record it waits for */
export function attachDirect(w: World, pending: string | null = null): void {
  const c = w.store.coordinator(S.coord)
  if (!c) throw new Error('tab-c is not a coordinator: make it one first')
  const attachment: StoredAttachment = { device: DEV_S, session: L.one, name: 'parser · Laptop', attachedAt: NOW, resolved: false, failed: false, lastReport: null, pending }
  w.store.putCoordinator({ ...c, attachments: [attachment] })
}

/** a world's tabs as the other device lists them, with their agent names and their facts: the tabs of `device`, the id this world has for it */
export function listedTabs(w: World, device: string): HubRemoteTab[] {
  const names = new Map(w.agentsOf().map((a) => [a.tabId, a.name]))
  return w.tabs.map((t) => ({
    device,
    tabId: t.tabId,
    claude: true,
    session: t.session,
    name: names.get(t.tabId) ?? null,
    folder: t.folder,
    branch: t.branch,
    project: t.project?.name ?? null,
    working: t.working,
    exited: t.exited,
    coord: w.hub.facts(t.tabId)
  }))
}

/** Studio (c, part 1's four tabs) and Laptop (s: tab-l1 parser, tab-l2 docs, tab-lc lead, in ACME_L, folder /home/sam/acme), linked */
export function deviceWorlds(): { c: World; s: World } {
  const c = world({ self: DEV_C, selfName: 'Studio', newId: idsFrom(0x100000) })
  const laptopFolder = '/home/sam/acme'
  const s = world({
    self: DEV_S,
    selfName: 'Laptop',
    newId: idsFrom(0x200000),
    tabs: [
      tab('tab-l1', L.one, ACME_L, { folder: laptopFolder }),
      tab('tab-l2', L.two, ACME_L, { folder: laptopFolder }),
      tab('tab-lc', L.lead, ACME_L, { folder: laptopFolder })
    ]
  })
  c.peers = [peerOf(DEV_S, 'Laptop')]
  s.peers = [peerOf(DEV_C, 'Studio')]
  c.remoteTabs = listedTabs(s, DEV_S)
  s.remoteTabs = listedTabs(c, DEV_C)
  return { c, s }
}

/** what MailSync and the tab lists carry between the two: the shareable records each way, three rounds (an answer goes back), then each side's tabs listed to the other, and remoteChanged on both */
export function sync(c: World, s: World): void {
  for (let round = 0; round < 3; round++) {
    s.mail.merge(c.mail.all().filter(isShareable), { link: 'c' })
    c.mail.merge(s.mail.all().filter(isShareable), { link: 's' })
  }
  c.remoteTabs = listedTabs(s, DEV_S)
  s.remoteTabs = listedTabs(c, DEV_C)
  c.hub.remoteChanged()
  s.hub.remoteChanged()
}
