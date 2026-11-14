import { changeFolderOf, folderListingOf, type TabFolderDeps } from '../../src/main/folder-browse'
import type { HostContext } from '../../src/main/remote-host'
import { typedPaths } from '../../src/main/profiles'
import type { CallArgs } from '../../src/main/sync/remote-shapes'
import { TabAttention } from '../../src/main/sync/tab-directory'
import { TabSizes } from '../../src/main/sync/tab-sizes'
import type { AccountView } from '../../src/shared/accounts'
import type { ReviewScope, ReviewSendState, ReviewUpdate } from '../../src/shared/review'
import type { ImageCard, MainStatus, PlanStatus, ProfileDef, RecentSession, TabInfo, TabPlace } from '../../src/shared/types'

/** the profile of the shell tab T2 runs */
const BASH_PROFILE: ProfileDef = { name: 'Bash', command: '/bin/bash', args: [] }

// Invented ids and names for the tests of this device's tabs (the host side of the tab calls).

/** the n-th of a series of tab ids */
export function tabId(n: number): string {
  return `d1000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

/** the n-th of a series of account ids (accounts keep their own ids) */
export function accountId(n: number): string {
  return `ac000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

/** the device that claims the size of a tab (a member of the group) */
export const B_ID = 'b1000000-0000-4000-8000-000000000001'

export const T1 = tabId(1)
export const T2 = tabId(2)
export const T3 = tabId(3)
export const T9 = tabId(9)
export const T_LONG_CWD = tabId(0x10)
export const ACC_WORK = accountId(1)

/** a tab of this device as the tab manager lists it */
export function tabInfo(id: string, over: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    kind: 'claude',
    profile: 'Claude',
    cwd: '/work/demo',
    folder: '/work/demo',
    customTitle: null,
    claudeSessionId: null,
    account: null,
    muted: false,
    fork: null,
    exited: false,
    activity: null,
    view: 'terminal',
    ...over
  }
}

/** a status line's main part, as the status hub keeps it */
export function mainStatus(displayName: string, usedPct: number | null): MainStatus {
  return {
    model: { id: 'claude-opus-4-1', displayName },
    effort: null,
    context: usedPct === null ? null : { usedTokens: 1000, size: 200000, usedPct },
    fiveHour: null,
    sevenDay: null
  }
}

/** an image card of T1, with an id made from n */
export function imageCard(n: number, over: Partial<ImageCard> = {}): ImageCard {
  return {
    id: n.toString(16).padStart(20, '0'),
    tabId: T1,
    path: `/work/demo/img-${n}.png`,
    name: `img-${n}.png`,
    relPath: `img-${n}.png`,
    source: 'created',
    kind: 'image',
    caption: null,
    touchedAt: 1,
    version: 1,
    updated: false,
    deleted: false,
    ...over
  }
}

/** a review update of a tab with nothing in it; `over` varies it */
export function reviewUpdate(tabId: string, over: Partial<ReviewUpdate> = {}): ReviewUpdate {
  return {
    tabId,
    view: { kind: 'request' },
    label: 'uncommitted',
    uncommitted: { available: true },
    files: [],
    additions: 0,
    deletions: 0,
    unviewed: 0,
    ignored: 0,
    hideTests: false,
    renderMarkdown: false,
    testsHidden: 0,
    testsSample: [],
    outside: 0,
    outsideSample: [],
    folder: '/work/demo',
    notice: null,
    send: { ok: true },
    counter: null,
    reveal: false,
    ...over
  }
}

/** what the fake host records of the calls it gets, and the data it answers with */
export interface FakeHost {
  ctx: HostContext
  renamed: [string, string | null][]
  muted: [string, boolean][]
  restarted: [string, boolean][]
  switched: [string, string | null][]
  closed: string[]
  opened: CallArgs['open-tab'][]
  inputs: [string, string, string | null][]
  claims: [string, string, number, number][]
  fronts: [string, string | null, boolean][]
  infos: Map<string, TabInfo>
  titles: Map<string, string>
  reviews: Map<string, ReviewUpdate>
  /** the rev of each tab's review; a tab with none here has rev 0 */
  reviewRevs: Map<string, number>
  plans: Map<string, PlanStatus>
  /** the cards of every tab; list, get and remove read them */
  cards: ImageCard[]
  /** the tabs whose media was marked seen, and the cards removed, in order */
  marked: string[]
  removedCards: string[]
  accounts: Pick<AccountView, 'id' | 'name' | 'addedAt' | 'readable'>[]
  /** what profiles() answers; a test may set something that is not a list */
  profilesAnswer: unknown
  attention: TabAttention
  sizes: TabSizes
  /** the Changes actions the tabs got, in order: viewed as [tab, path, hash, viewed], show and scope and clear and refresh by tab */
  viewed: [string, string, string, boolean][]
  shown: [string, string][]
  scoped: [string, ReviewScope][]
  cleared: string[]
  refreshed: string[]
  /** what canSend answers */
  sendState: ReviewSendState
  /** the place each tab has, as this device's place hub published it; null: none */
  places: Map<string, TabPlace | null>
  /** what canFork answers */
  canForkAnswer: boolean
  /** the tabs fork was asked of, in order; fork answers a new tab while forkAnswer is true, else null */
  forked: string[]
  /** the options each fork was asked with, in order */
  forkOptions: { activate?: boolean }[]
  forkAnswer: boolean
  /** the home folder the folder calls read `~` as; the folders the tabs were moved to, in order */
  home: string
  folderChanges: [string, string][]
  /** the sessions this device's history lists; openSession records the ids it is asked to open */
  sessionList: RecentSession[]
  openedSessions: string[]
  /** the members attached to each tab; clear-task-list is asked by a member that is one of them */
  watchers: Map<string, Set<string>>
  /** the tabs whose status bar shows the task list Claude keeps, not a superpowers plan */
  agentLists: Set<string>
  /** the tabs whose task list clear-task-list cleared, in order */
  clearedLists: string[]
}

/**
 * A device's tabs for the host side: T1 is a Claude tab on the Work account, titled "vim", with a note, a permission
 * attention and a size claimed by B_ID; T2 is a shell tab with no claim.
 */
export function fakeHost(): FakeHost {
  const attention = new TabAttention()
  attention.start(T1, 'permission')
  const sizes = new TabSizes()
  sizes.claim(T1, B_ID, 80, 24)
  const h = {
    renamed: [],
    muted: [],
    restarted: [],
    switched: [],
    closed: [],
    opened: [],
    inputs: [],
    claims: [],
    fronts: [],
    infos: new Map<string, TabInfo>([
      [T1, tabInfo(T1, { account: ACC_WORK, activity: 'working' })],
      [T2, tabInfo(T2, { kind: 'shell', profile: 'Bash' })]
    ]),
    titles: new Map<string, string>([[T1, 'vim']]),
    reviews: new Map<string, ReviewUpdate>(),
    reviewRevs: new Map<string, number>(),
    plans: new Map<string, PlanStatus>(),
    cards: [],
    marked: [],
    removedCards: [],
    accounts: [{ id: ACC_WORK, name: 'Work', addedAt: '2026-01-01T00:00:00.000Z', readable: true }],
    profilesAnswer: ['Bash', 'Zsh'],
    attention,
    sizes,
    viewed: [],
    shown: [],
    scoped: [],
    cleared: [],
    refreshed: [],
    sendState: { ok: true },
    places: new Map<string, TabPlace | null>(),
    canForkAnswer: true,
    forked: [],
    forkOptions: [],
    forkAnswer: true,
    home: '/nope-home',
    folderChanges: [],
    sessionList: [],
    openedSessions: [],
    watchers: new Map<string, Set<string>>([
      [T1, new Set([B_ID])],
      [T2, new Set([B_ID])]
    ]),
    agentLists: new Set<string>(),
    clearedLists: []
  } as Omit<FakeHost, 'ctx'>
  // what the folder calls read of this fake device: its tabs' folders, its name, no sessions, and a move that records the tab
  const folderDeps = (): TabFolderDeps => ({
    home: h.home,
    tabFolder: (id) => h.infos.get(id)?.folder ?? null,
    device: () => 'Studio',
    sessions: async () => [],
    changeFolder: async (id, path) => {
      if (!h.infos.has(id)) return false
      h.folderChanges.push([id, path])
      return true
    }
  })
  const ctx: HostContext = {
    tabs: {
      list: () => [...h.infos.values()].map((t) => ({ ...t })),
      get: (id) => {
        const t = h.infos.get(id)
        return t ? { ...t } : null
      },
      isTransient: () => false,
      close: (id) => {
        h.closed.push(id)
      },
      rename: (id, title) => {
        h.renamed.push([id, title])
      },
      setMuted: (id, muted) => {
        h.muted.push([id, muted])
      },
      restart: async (id, opts) => {
        h.restarted.push([id, opts?.live === true])
      },
      switchAccount: async (id, account) => {
        h.switched.push([id, account])
        return true
      },
      size: (id) => (h.infos.has(id) ? { cols: 100, rows: 30 } : null),
      canFork: async () => h.canForkAnswer,
      fork: async (id, opts) => {
        h.forked.push(id)
        h.forkOptions.push(opts ?? {})
        return h.forkAnswer ? tabInfo(T3, { kind: 'claude', fork: { of: id, from: null } }) : null
      }
    },
    images: {
      list: (id) => h.cards.filter((c) => c.tabId === id).map((c) => ({ ...c })),
      unseenCount: (id) => (id === T1 ? 3 : 0),
      notice: () => null,
      markSeen: (id) => {
        h.marked.push(id)
      },
      get: (id) => {
        const c = h.cards.find((x) => x.id === id)
        return c ? { ...c } : null
      },
      remove: (id) => {
        const c = h.cards.find((x) => x.id === id)
        h.cards = h.cards.filter((x) => x.id !== id)
        h.removedCards.push(id)
        return c ? { ...c } : null
      }
    },
    places: h.places,
    imageExtensions: () => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
    status: { get: (id) => ({ tabId: id, main: id === T1 ? mainStatus('Opus 4.1', 41.6) : null, agents: [], background: [] }) },
    shownPlan: (id) => ({ tabId: id, plan: h.plans.get(id) ?? null, agentList: h.agentLists.has(id) }),
    clearTaskList: (id) => {
      h.clearedLists.push(id)
      return true
    },
    notes: { get: (id) => (id === T1 ? { text: 'todo', shown: false, form: 'card' } : null) },
    accounts: {
      list: () => h.accounts.map((a) => ({ ...a, kind: 'token' as const, folder: null, created: false })),
      nameOf: (id) => h.accounts.find((a) => a.id === id)?.name ?? null
    },
    sizes,
    attention,
    titles: h.titles,
    reviews: h.reviews,
    reviewRevs: h.reviewRevs,
    review: {
      setScope: (id, scope) => {
        h.scoped.push([id, scope])
      },
      clearRequest: (id) => {
        h.cleared.push(id)
      },
      refresh: (id) => {
        h.refreshed.push(id)
      },
      setViewed: (id, path, hash, viewed) => {
        h.viewed.push([id, path, hash, viewed])
      },
      showFile: (id, path) => {
        h.shown.push([id, path])
      },
      canSend: () => h.sendState
    },
    // the folder calls are the real ones (folderListingOf, changeFolderOf), on the folders of the test; the device is Studio
    folders: (id, path) => folderListingOf(id, path, folderDeps()),
    changeFolder: (id, path) => changeFolderOf(id, path, folderDeps()),
    sessions: async () => h.sessionList.map((s) => ({ ...s })),
    openSession: async (id) => {
      h.openedSessions.push(id)
      return T3
    },
    // a stub that throws: a test that receives files gives its own receiver, and one that forgets it fails loudly
    receiver: {
      begin: async () => {
        throw new Error('this test gives its own receiver')
      },
      part: async () => {
        throw new Error('this test gives its own receiver')
      },
      end: async () => {
        throw new Error('this test gives its own receiver')
      }
    },
    profiles: () => h.profilesAnswer as string[],
    // the real quoting, with the fixture's profile of the tab: T2 runs 'Bash', the others are Claude tabs
    typedPaths: (id, paths) => {
      const info = h.infos.get(id)
      return typedPaths(info?.profile === 'Bash' ? BASH_PROFILE : null, info?.kind ?? 'claude', paths)
    },
    openTab: (req) => {
      h.opened.push(req)
      return tabInfo(T3, { kind: req.kind, profile: req.profile ?? 'Bash' })
    },
    writeInput: (id, data, from) => {
      h.inputs.push([id, data, from])
    },
    claim: (id, from, cols, rows) => {
      h.claims.push([id, from, cols, rows])
    },
    front: (from, id, present) => {
      h.fronts.push([from, id, present])
    }
  }
  return Object.assign(h, { ctx })
}
