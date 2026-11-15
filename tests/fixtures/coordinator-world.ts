import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoordinatorHub, type HubTab } from '../../src/main/coordinator/coordinator-hub'
import { CoordinatorStore } from '../../src/main/coordinator/coordinator-store'
import { nameAgents, type Agent, type AgentTab } from '../../src/main/mail/agent-directory'
import { MailStore } from '../../src/main/mail/mail-store'
import type { TabWaitsState } from '../../src/main/tab-waits'
import type { MailRecord } from '../../src/shared/mail'
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
export const TITLES: Record<string, string> = { 'tab-c': 'coord', 'tab-1': 'parser', 'tab-2': 'docs', 'tab-b': 'beta' }

/** the n-th id of a test, a UUID */
export const uid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

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
    opened: [] as OpenTabRequest[],
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
    taskList: () => null,
    restingNow: (tabId) => w.resting[tabId] ?? true,
    isDirectory: async (p) => p === 'D:\\Work\\acme',
    accountLabel: (a) => (a === null ? 'Main account' : `Account ${a}`),
    openTab: (req) => {
      w.opened.push(req)
      return `new-tab-${w.opened.length}`
    },
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
