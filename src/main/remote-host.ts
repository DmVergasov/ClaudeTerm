import { open } from 'node:fs/promises'
import { checkImageFile, MAX_IMAGE_BYTES } from '../shared/image-file'
import { hasText } from '../shared/note'
import { isUuid } from '../shared/protocol'
import type { DeviceResult } from '../shared/devices'
import { IMAGE_PART_BYTES, MAX_PATH_TEXT, REMOTE_COPY, type FolderResult, type PushKind, type RemoteTab } from '../shared/remote'
import { MAX_HASH, type ReviewCounter, type ReviewUpdate } from '../shared/review'
import type { PlanUpdate } from '../shared/ipc'
import type { RecentSession, TabInfo, TabPlace } from '../shared/types'
import type { AccountStore } from './accounts'
import type { ImageHub } from './image-hub'
import { isAbsPath, isHash } from './ipc-guards'
import type { NoteHub } from './note-hub'
import type { ReviewHub } from './review-hub'
import type { StatusHub } from './status-hub'
import type { TabManager } from './tab-manager'
import { CallError, type CallEntry } from './sync/calls'
import { CALL_ARGS, type CallArgs } from './sync/remote-shapes'
import { parsePlace } from './sync/remote-wire'
import type { HostTabs } from './sync/tab-host'
import { statusSummary, type TabAttention } from './sync/tab-directory'
import type { TabSizes } from './sync/tab-sizes'
import type { FileReceiver } from './sync/file-receiver'

// What this device serves of its tabs to the other devices: the directory of its tabs and their pushes, and the calls
// a member makes about them. Every value sent is cut to the limit the receiver checks (clampPush, and the directory's
// own limits), so the receiver keeps all of it; every call is checked before anything is done.

/** the most profiles and accounts a list reply carries */
const MAX_LIST = 64
const MAX_PROFILE = 256
const MAX_ACCOUNT_ID = 64
const MAX_ACCOUNT_NAME = 256
const MAX_TITLE = 1000
const MAX_NAME = 255
const MAX_REASON = 500
const MAX_STATUS = 200
const MAX_AGENTS = 64
const MAX_BACKGROUND = 64
const MAX_PLAN_TITLE = 500
const MAX_PLAN_TASKS = 500
const MAX_CARDS = 10_000
const MAX_CAPTION = 1000
const MAX_NOTICE = 500
const MAX_FILES = 5000
const MAX_HUNKS = 10_000
const MAX_LINES = 100_000
const MAX_LINE_CHARS = 100_000
const MAX_SAMPLES = 10
/** the most sessions a sessions reply carries, and the most characters of a session's title or prompt */
const MAX_SESSIONS = 1000
const MAX_SESSION_TEXT = 2000
/** what the files of one review push may take, JSON-encoded: the push stays under a frame (MAX_FRAME_BYTES) with what else it holds */
const REVIEW_PUSH_BYTES = 12 * 1024 * 1024
/** what an object costs in a push beyond its strings: its keys, its braces and its numbers, rounded up */
const OBJECT_BYTES = 64

// NUL and the other C0 control characters
const C0_RE = /[\u0000-\u001f]/g
const NUL_RE = /\u0000/g

/** what this device gives a member about its tabs: the directory and the hub updates each tab has */
export interface HostContext {
  tabs: Pick<TabManager, 'list' | 'get' | 'close' | 'rename' | 'setMuted' | 'restart' | 'switchAccount' | 'size' | 'canFork' | 'fork'>
  images: Pick<ImageHub, 'list' | 'unseenCount' | 'notice' | 'markSeen' | 'remove' | 'get'>
  /** the extensions of the image files this device shows: the ones the image panel takes */
  imageExtensions(): string[]
  status: Pick<StatusHub, 'get'>
  /** what the status bar of a tab shows of its plan: the plan, or the task list Claude keeps, with the flag that says which */
  shownPlan(tabId: string): PlanUpdate
  /** clears the task list a Claude tab of this device keeps; false when this device keeps no list for the tab */
  clearTaskList(tabId: string): boolean
  notes: Pick<NoteHub, 'get'>
  accounts: Pick<AccountStore, 'list' | 'nameOf'>
  sizes: TabSizes
  attention: TabAttention
  titles: ReadonlyMap<string, string>
  /** the last place TabPlaces published for each of this device's tabs; null: none */
  places: ReadonlyMap<string, TabPlace | null>
  /** the last review update published for each tab */
  reviews: ReadonlyMap<string, ReviewUpdate>
  /** the Changes actions a member asks of a tab; the hub acts on the tab's own view */
  review: Pick<ReviewHub, 'setScope' | 'clearRequest' | 'refresh' | 'setViewed' | 'showFile' | 'canSend'>
  profiles(): string[]
  /** opens a tab in this device's default folder without bringing it to the front of this window */
  openTab(req: CallArgs['open-tab']): TabInfo | null
  writeInput(tabId: string, data: string, from: string | null): void
  claim(tabId: string, from: string, cols: number, rows: number): void
  /** the tab a member has in front, and whether the member's window has the focus */
  front(from: string, tabId: string | null, focused: boolean): void
  /** the subfolders of a tab's folder (null: the tab's own), read on this device */
  folders(tabId: string, path: string | null): Promise<FolderResult>
  /** moves a tab to another folder on this device; a refusal is its message */
  changeFolder(tabId: string, path: string): Promise<DeviceResult>
  /** this device's Recent sessions, newest first, as the sessions window lists them */
  sessions(): Promise<RecentSession[]>
  /**
   * The tab in a session's conversation when one is open (not brought forward), else a new Claude tab that resumes it,
   * opened without bringing it forward. Throws a CallError when this device no longer lists the session (no session of
   * the list it was asked for) or when the session's folder is gone.
   */
  openSession(id: string): string
  /** the files a member sends for a tab of this device: a transfer is kept for the device that began it */
  receiver: Pick<FileReceiver, 'begin' | 'part' | 'end'>
}

/** This device's tabs as the host serves them: the directory, and the pushes of one tab. */
export function hostTabs(ctx: HostContext): HostTabs {
  return {
    list: () => directoryOf(ctx),
    has: (tabId) => ctx.tabs.get(tabId) !== null,
    input: (tabId, data, from) => {
      ctx.writeInput(tabId, data, from)
    },
    claim: (tabId, from, cols, rows) => {
      ctx.claim(tabId, from, cols, rows)
    },
    front: (from, tabId, focused) => {
      ctx.front(from, tabId, focused)
    },
    pushes: (tabId) => pushesOf(ctx, tabId)
  }
}

/** the sessions each member device was last answered with, by host context: open-session opens only these, for that member */
const listedByMember = new WeakMap<HostContext, Map<string, Set<string>>>()

/** the sessions answered to a device that is no longer in the group are forgotten; the members that stay keep theirs, offline ones too */
export function pruneListedMembers(ctx: HostContext, members: string[]): void {
  const listed = listedByMember.get(ctx)
  if (!listed) return
  const keep = new Set(members)
  for (const device of [...listed.keys()]) if (!keep.has(device)) listed.delete(device)
}

/**
 * The calls a member makes about this device's tabs, and about its profiles and accounts. A call whose arguments do not
 * fit is refused, and so is one about a tab this device does not have. The answers fit the receiver's checks. `device` is
 * the member these handlers serve: the transfers it begins are its own.
 */
export function hostHandlers(ctx: HostContext, device: string): Record<string, CallEntry> {
  // the sessions each member device was last answered with, kept by member: a member that links again still opens them
  let members = listedByMember.get(ctx)
  if (!members) {
    members = new Map<string, Set<string>>()
    listedByMember.set(ctx, members)
  }
  const sessionsOfMember = members
  return {
    'open-tab': {
      run: (a) => {
        const req = CALL_ARGS['open-tab'](a)
        if (!req) throw new CallError('bad arguments')
        const tab = ctx.openTab(req)
        if (!tab) throw new CallError(REMOTE_COPY.openTabFailed)
        return { id: tab.id }
      }
    },
    close: {
      run: (a) => {
        ctx.tabs.close(tabCall(ctx, CALL_ARGS.close(a)).id)
        return {}
      }
    },
    restart: {
      run: async (a) => {
        const args = tabCall(ctx, CALL_ARGS.restart(a))
        await ctx.tabs.restart(args.id, { live: args.live })
        return {}
      }
    },
    rename: {
      run: (a) => {
        const args = tabCall(ctx, CALL_ARGS.rename(a))
        ctx.tabs.rename(args.id, args.title)
        return {}
      }
    },
    mute: {
      run: (a) => {
        const args = tabCall(ctx, CALL_ARGS.mute(a))
        ctx.tabs.setMuted(args.id, args.muted)
        return {}
      }
    },
    'switch-account': {
      run: async (a) => {
        const args = tabCall(ctx, CALL_ARGS['switch-account'](a))
        return { ok: await ctx.tabs.switchAccount(args.id, args.account) }
      }
    },
    // the task list of a Claude tab, cleared for the member that asks: pairing is the trust boundary, as for the other tab
    // calls; a refusal is an answer, not a failed call
    'clear-task-list': {
      run: (a) => {
        const args = tabCall(ctx, CALL_ARGS['clear-task-list'](a))
        if (ctx.tabs.get(args.id)?.kind !== 'claude') return { ok: false }
        return { ok: ctx.clearTaskList(args.id) }
      }
    },
    'can-fork': {
      run: async (a) => {
        const args = tabCall(ctx, CALL_ARGS['can-fork'](a))
        return { ok: await ctx.tabs.canFork(args.id) }
      }
    },
    // the fork goes after its family on this device, as a fork made here does; a fork that gives nothing is refused
    'fork-tab': {
      run: async (a) => {
        const args = tabCall(ctx, CALL_ARGS['fork-tab'](a))
        // a fork another device asks for opens in the background here, as a tab another device asks for does
        let tab: TabInfo | null
        try {
          tab = await ctx.tabs.fork(args.id, { activate: false })
        } catch (e) {
          throw e instanceof CallError ? e : new CallError(REMOTE_COPY.forkFailed)
        }
        if (!tab) throw new CallError(REMOTE_COPY.forkFailed)
        return { id: tab.id }
      }
    },
    profiles: {
      run: (a) => {
        if (!CALL_ARGS.profiles(a)) throw new CallError('bad arguments')
        return profileNames(ctx.profiles())
      }
    },
    accounts: {
      run: (a) => {
        if (!CALL_ARGS.accounts(a)) throw new CallError('bad arguments')
        return accountEntries(ctx.accounts.list())
      }
    },
    'images-seen': {
      run: (a) => {
        const args = tabCall(ctx, CALL_ARGS['images-seen'](a))
        ctx.images.markSeen(args.id)
        return {}
      }
    },
    // a card that is gone already, or is another tab's, is nothing to remove: the call is answered all the same
    'image-remove': {
      run: (a) => {
        const args = tabCall(ctx, CALL_ARGS['image-remove'](a))
        const card = ctx.images.get(args.card)
        if (card && card.tabId === args.id) ctx.images.remove(args.card)
        return {}
      }
    },
    // the checks are the local IPC's, made by this device: a path is absolute by this system's rules; the hub refreshes
    // in the background, so the call is answered without waiting for git
    review: {
      run: (a) => {
        const args = tabCall(ctx, CALL_ARGS.review(a))
        const { action } = args
        if (action.k === 'viewed') {
          if (!isAbsPath(action.path) || !isHash(action.hash)) throw new CallError('bad arguments')
          ctx.review.setViewed(args.id, action.path, action.hash, action.viewed)
        } else if (action.k === 'show') {
          if (!isAbsPath(action.path)) throw new CallError('bad arguments')
          ctx.review.showFile(args.id, action.path)
        } else if (action.k === 'scope') {
          ctx.review.setScope(args.id, action.scope)
        } else if (action.k === 'clear') {
          ctx.review.clearRequest(args.id)
        } else {
          ctx.review.refresh(args.id)
        }
        return {}
      }
    },
    'can-send': {
      run: (a) => ctx.review.canSend(tabCall(ctx, CALL_ARGS['can-send'](a)).id)
    },
    // the folder listing of a tab on this device, by this device's rules; the answer is a listing or the dialog's message
    folders: {
      run: async (a) => {
        const args = tabCall(ctx, CALL_ARGS.folders(a))
        return ctx.folders(args.id, args.path)
      }
    },
    'change-folder': {
      run: async (a) => {
        const args = tabCall(ctx, CALL_ARGS['change-folder'](a))
        const done = await ctx.changeFolder(args.id, args.path)
        if (!done.ok) throw new CallError(done.error)
        return {}
      }
    },
    // the Recent sessions of this device; the ids of the answer are the only sessions open-session opens for this member
    sessions: {
      bulk: true,
      run: async (a) => {
        if (!CALL_ARGS.sessions(a)) throw new CallError('bad arguments')
        const list = sessionsOf(await ctx.sessions())
        sessionsOfMember.set(device, new Set(list.map((s) => s.id)))
        return list
      }
    },
    // a session the member's last answer did not list is refused; the folder check and the tab are the context's
    'open-session': {
      run: (a) => {
        const args = CALL_ARGS['open-session'](a)
        if (!args) throw new CallError('bad arguments')
        if (!sessionsOfMember.get(device)?.has(args.session)) throw new CallError(REMOTE_COPY.unknownSession)
        return { id: ctx.openSession(args.session) }
      }
    },
    // bulk: the bytes of a card go on the bulk lane, so they never hold up input or output
    image: {
      bulk: true,
      run: async (a) => {
        const args = tabCall(ctx, CALL_ARGS.image(a))
        const card = ctx.images.get(args.card)
        if (!card || card.tabId !== args.id || card.kind !== 'image') throw new CallError(REMOTE_COPY.unknownTab)
        const check = await checkImageFile(card.path, ctx.imageExtensions())
        if (!check.ok) throw new CallError(REMOTE_COPY.unknownTab)
        const part = await readImagePart(card.path, args.offset, IMAGE_PART_BYTES)
        return { version: card.version, size: part.size, data: part.data.toString('base64') }
      }
    },
    // the files a member pastes or drops into a tab of this device: the tab must be here; the parts and the end are the transfer's own
    'recv-begin': {
      run: async (a) => {
        const args = tabCall(ctx, CALL_ARGS['recv-begin'](a))
        return { transfer: await ctx.receiver.begin(args.files, device) }
      }
    },
    'recv-part': {
      run: async (a) => {
        const args = CALL_ARGS['recv-part'](a)
        if (!args) throw new CallError('bad arguments')
        await ctx.receiver.part(args.transfer, args.file, args.offset, Buffer.from(args.data, 'base64'), device)
        return {}
      }
    },
    'recv-end': {
      run: async (a) => {
        const args = CALL_ARGS['recv-end'](a)
        if (!args) throw new CallError('bad arguments')
        return { paths: await ctx.receiver.end(args.transfer, device) }
      }
    }
  }
}

/**
 * The bytes of a file from `offset`, at most `max`, and the size of the whole file. The file is read with fs/promises and
 * closed whatever happens. An offset past the end, or a file over MAX_IMAGE_BYTES, is refused as bad arguments.
 */
export async function readImagePart(path: string, offset: number, max: number): Promise<{ size: number; data: Buffer }> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    if (offset > size || size > MAX_IMAGE_BYTES) throw new CallError('bad arguments')
    const buf = Buffer.alloc(Math.min(max, size - offset))
    const { bytesRead } = await file.read(buf, 0, buf.length, offset)
    return { size, data: buf.subarray(0, bytesRead) }
  } finally {
    await file.close()
  }
}

/**
 * A push of a kind, cut or capped to the limits its receiver checks: what parsePush accepts, with the data kept from the
 * start. A value that is not of the kind's shape is returned as it is, and the receiver refuses it.
 */
export function clampPush(k: PushKind, v: unknown): unknown {
  switch (k) {
    case 'status':
      return clampStatus(v)
    case 'plan':
      return clampPlan(v)
    case 'images':
      return clampImages(v)
    case 'review':
      return clampReview(v)
    default:
      return v
  }
}

// ---- the directory

function directoryOf(ctx: HostContext): RemoteTab[] {
  const list: RemoteTab[] = []
  for (const info of ctx.tabs.list()) {
    const tab = remoteTabOf(ctx, info)
    if (tab) list.push(tab)
  }
  return list
}

/** one tab as the directory shows it; null when its cwd or profile cannot fit the receiver's checks */
function remoteTabOf(ctx: HostContext, info: TabInfo): RemoteTab | null {
  const id = info.id
  const cwd = stripC0(info.cwd)
  // the folder comes from the pipe's cwd messages, which have no length limit: one that does not fit is the cwd, as the receiver reads it
  const strippedFolder = stripC0(info.folder)
  const folder = fits(strippedFolder, MAX_PATH_TEXT) ? strippedFolder : cwd
  const profile = stripC0(info.profile)
  if (!fits(cwd, MAX_PATH_TEXT) || !fits(profile, MAX_PROFILE)) return null
  const size = sizeOf(ctx, id)
  if (!size) return null
  const attention = ctx.attention.get(id)
  const account = accountOf(ctx, info.account)
  const head = info.fork?.of ?? null
  return {
    id,
    kind: info.kind,
    profile,
    cwd,
    folder,
    customTitle: optional(info.customTitle, MAX_TITLE),
    title: optional(ctx.titles.get(id) ?? null, MAX_TITLE),
    claudeSessionId: info.claudeSessionId !== null && isUuid(info.claudeSessionId) ? info.claudeSessionId : null,
    account: account.id,
    accountName: account.name,
    muted: info.muted,
    exited: info.exited,
    // what the window shows as the tab's activity: its turn, or an agent it left running past the turn
    working: info.activity === 'working',
    attention: attention.reason,
    attentionSeq: attention.seq,
    images: ctx.images.unseenCount(id),
    note: hasText(ctx.notes.get(id)),
    counter: counterOf(ctx.reviews.get(id)?.counter ?? null),
    status: statusSummary(ctx.status.get(id).main),
    size,
    place: parsePlace(ctx.places.get(id) ?? null),
    // until TabPlaces has answered for the tab, its place is not known here: the other devices wait for it
    placeKnown: ctx.places.has(id),
    forkOf: head !== null && isUuid(head) ? head : null,
    fork: info.fork !== null
  }
}

/** the size the tab's PTY has, and the device it is sized for: the window's own when nobody claimed it */
function sizeOf(ctx: HostContext, id: string): RemoteTab['size'] | null {
  const applied = ctx.sizes.get(id)
  if (applied) return { cols: applied.cols, rows: applied.rows, by: applied.by }
  const own = ctx.tabs.size(id)
  return own ? { cols: own.cols, rows: own.rows, by: null } : null
}

/** the account's id and name as the directory shows them; an id that cannot fit is left out with its name */
function accountOf(ctx: HostContext, id: string | null): { id: string | null; name: string | null } {
  if (id === null) return { id: null, name: null }
  const clean = stripC0(id)
  if (!fits(clean, MAX_ACCOUNT_ID)) return { id: null, name: null }
  const name = ctx.accounts.nameOf(id)
  return { id: clean, name: optional(name, MAX_ACCOUNT_NAME) }
}

function counterOf(counter: ReviewCounter | null): ReviewCounter | null {
  if (counter === null) return null
  return { files: counter.files, additions: counter.additions, deletions: counter.deletions, title: cut(stripC0(counter.title), MAX_TITLE) }
}

/** the pushes of a tab, in the order a member gets them: status, plan, images and the last review */
function pushesOf(ctx: HostContext, tabId: string): Array<{ k: PushKind; v: unknown }> {
  const status = ctx.status.get(tabId)
  const out: Array<{ k: PushKind; v: unknown }> = [
    { k: 'status', v: clampPush('status', { main: status.main, agents: status.agents, background: status.background }) },
    { k: 'plan', v: clampPush('plan', planPush(ctx.shownPlan(tabId))) },
    {
      k: 'images',
      v: clampPush('images', { cards: ctx.images.list(tabId), unseen: ctx.images.unseenCount(tabId), notice: ctx.images.notice(tabId) })
    }
  ]
  const review = ctx.reviews.get(tabId)
  if (review) out.push({ k: 'review', v: clampPush('review', withoutTabId(review)) })
  return out
}

export function withoutTabId(update: ReviewUpdate): Partial<ReviewUpdate> {
  const copy: Partial<ReviewUpdate> = { ...update }
  delete copy.tabId
  return copy
}

/**
 * This device's sessions as a member gets them: the titles and prompts cut to MAX_SESSION_TEXT with NUL removed. A session
 * whose id is not a UUID, whose folder is empty, holds NUL or is over MAX_PATH_TEXT, or whose time is no number, is left
 * out, and the others are kept: the receiver refuses a whole list over one bad entry.
 */
function sessionsOf(list: RecentSession[]): RecentSession[] {
  return fit(list, MAX_SESSIONS, clampSession)
}

function clampSession(x: unknown): RecentSession | null {
  if (!isRecord(x)) return null
  const { id, cwd, title, firstPrompt, lastPrompt, modifiedAt, open, starred } = x
  if (!isUuid(id) || typeof cwd !== 'string' || cwd.includes('\u0000') || !fits(cwd, MAX_PATH_TEXT)) return null
  if (typeof modifiedAt !== 'number' || !Number.isFinite(modifiedAt) || modifiedAt < 0) return null
  if (typeof open !== 'boolean' || typeof starred !== 'boolean') return null
  const t = sessionText(title)
  const f = sessionText(firstPrompt)
  const l = sessionText(lastPrompt)
  if (t === undefined || f === undefined || l === undefined) return null
  return { id, cwd, title: t, firstPrompt: f, lastPrompt: l, modifiedAt, open, starred }
}

/** a session's text: null stays null, a string is cut without NUL; anything else is undefined (the session is left out) */
function sessionText(v: unknown): string | null | undefined {
  if (v === null) return null
  return typeof v === 'string' ? cut(v.replace(NUL_RE, ''), MAX_SESSION_TEXT) : undefined
}

// ---- calls

/** the checked arguments of a call about one of this device's tabs: refused when they do not fit or the tab is not here */
function tabCall<A extends { id: string }>(ctx: HostContext, checked: A | null): A {
  if (!checked) throw new CallError('bad arguments')
  if (ctx.tabs.get(checked.id) === null) throw new CallError(REMOTE_COPY.unknownTab)
  return checked
}

/** the profile names, without the empty and the over-long ones; a list that is not a list is returned as it is */
function profileNames(list: unknown): unknown {
  if (!Array.isArray(list)) return list
  return fit(list, MAX_LIST, (x) => {
    const name = typeof x === 'string' ? stripC0(x) : ''
    return fits(name, MAX_PROFILE) ? name : null
  })
}

/** the accounts' ids and names, nothing else; an entry whose id or name cannot fit, or that this device cannot read, is left out */
function accountEntries(list: unknown): unknown {
  if (!Array.isArray(list)) return list
  return fit(list, MAX_LIST, (x) => {
    if (!isRecord(x) || x.readable === false) return null
    const id = typeof x.id === 'string' ? stripC0(x.id) : ''
    const name = typeof x.name === 'string' ? cut(stripC0(x.name), MAX_ACCOUNT_NAME) : ''
    return fits(id, MAX_ACCOUNT_ID) && fits(name, MAX_ACCOUNT_NAME) ? { id, name } : null
  })
}

// ---- clamps of the pushes

function clampStatus(v: unknown): unknown {
  if (!isRecord(v) || !Array.isArray(v.agents)) return v
  const background = Array.isArray(v.background) ? fit(v.background, MAX_BACKGROUND, clampBackground) : v.background
  return { main: clampMain(v.main), agents: fit(v.agents, MAX_AGENTS, clampAgent), background }
}

function clampMain(m: unknown): unknown {
  if (!isRecord(m) || !isRecord(m.model)) return m
  return {
    model: { id: text(m.model.id, MAX_STATUS), displayName: text(m.model.displayName, MAX_STATUS) },
    effort: nullableText(m.effort, MAX_STATUS),
    context: m.context,
    fiveHour: m.fiveHour,
    sevenDay: m.sevenDay
  }
}

function clampAgent(a: unknown): Record<string, unknown> | null {
  if (!isRecord(a)) return null
  return {
    agentId: text(a.agentId, MAX_STATUS),
    type: text(a.type, MAX_STATUS),
    description: nullableText(a.description, MAX_STATUS),
    model: nullableText(a.model, MAX_STATUS),
    effort: nullableText(a.effort, MAX_STATUS),
    startedAt: a.startedAt
  }
}

function clampBackground(t: unknown): Record<string, unknown> | null {
  if (!isRecord(t)) return null
  return {
    id: text(t.id, MAX_STATUS),
    type: text(t.type, MAX_STATUS),
    description: nullableText(t.description, MAX_STATUS),
    command: nullableText(t.command, MAX_STATUS)
  }
}

function clampPlan(v: unknown): unknown {
  if (!isRecord(v) || !Array.isArray(v.tasks)) return v
  const tasks = fit(v.tasks, MAX_PLAN_TASKS, clampTask)
  const plan = {
    title: text(v.title, MAX_PLAN_TITLE),
    tasks,
    done: tasks.filter((t) => t.state === 'done').length,
    total: tasks.length,
    finished: v.finished
  }
  // the list flag is kept as it is: a value that is not a boolean is for the receiver to refuse
  return v.agentList === undefined ? plan : { ...plan, agentList: v.agentList }
}

/** the plan push of what a tab's status bar shows: the plan with the flag that says it is the agent's task list, or null */
export function planPush(u: PlanUpdate): unknown {
  return u.plan ? { ...u.plan, agentList: u.agentList === true } : null
}

/** a task with a number that is not a safe integer is left out */
function clampTask(t: unknown): { n: unknown; title: unknown; state: unknown } | null {
  if (!isRecord(t) || !Number.isSafeInteger(t.n)) return null
  return { n: t.n, title: text(t.title, MAX_PLAN_TITLE), state: t.state }
}

function clampImages(v: unknown): unknown {
  if (!isRecord(v) || !Array.isArray(v.cards)) return v
  return { cards: fit(v.cards, MAX_CARDS, clampCard), unseen: v.unseen, notice: nullableText(v.notice, MAX_NOTICE) }
}

/** a card whose path or relPath is over MAX_PATH_TEXT characters is left out; the rest of it is cut */
function clampCard(c: unknown): Record<string, unknown> | null {
  if (!isRecord(c)) return null
  const path = fitting(c.path, MAX_PATH_TEXT)
  const relPath = fitting(c.relPath, MAX_PATH_TEXT)
  if (path === null || relPath === null) return null
  return { ...c, path, relPath, name: text(c.name, MAX_NAME), caption: nullableText(c.caption, MAX_CAPTION) }
}

function clampReview(v: unknown): unknown {
  if (!isRecord(v)) return v
  return {
    ...v,
    label: text(v.label, MAX_PATH_TEXT),
    folder: text(v.folder, MAX_PATH_TEXT),
    notice: nullableText(v.notice, MAX_PATH_TEXT),
    uncommitted: clampUncommitted(v.uncommitted),
    files: Array.isArray(v.files) ? clampFiles(v.files) : v.files,
    testsSample: Array.isArray(v.testsSample) ? fit(v.testsSample, MAX_SAMPLES, samplePath) : v.testsSample,
    outsideSample: Array.isArray(v.outsideSample) ? fit(v.outsideSample, MAX_SAMPLES, samplePath) : v.outsideSample,
    send: clampSend(v.send),
    counter: clampCounter(v.counter)
  }
}

/**
 * The files in order, within REVIEW_PUSH_BYTES of encoded size. A file is kept whole while it fits; the first one that does
 * not keeps its header only, with no hunks and the note too-many, and so does every later one. A header that does not
 * fit either ends the list.
 */
function clampFiles(list: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let used = 0
  let full = false
  for (const f of fit(list, MAX_FILES, clampFile)) {
    if (!full) {
      const size = fileBytes(f)
      if (used + size <= REVIEW_PUSH_BYTES) {
        out.push(f)
        used += size
        continue
      }
      full = true
    }
    const header = { ...f, hunks: [], note: 'too-many' }
    const size = ownBytes(header)
    if (used + size > REVIEW_PUSH_BYTES) break
    out.push(header)
    used += size
  }
  return out
}

/** the encoded size of a file with its hunks and their lines */
function fileBytes(f: Record<string, unknown>): number {
  let n = ownBytes(f)
  for (const h of f.hunks as Record<string, unknown>[]) {
    n += ownBytes(h)
    for (const l of h.lines as Record<string, unknown>[]) n += ownBytes(l)
  }
  return n
}

/** the encoded size of an object: its string values, quoted as JSON, and OBJECT_BYTES for the rest */
function ownBytes(o: Record<string, unknown>): number {
  let n = OBJECT_BYTES
  for (const v of Object.values(o)) if (typeof v === 'string') n += Buffer.byteLength(JSON.stringify(v))
  return n
}

function clampUncommitted(u: unknown): unknown {
  return isRecord(u) && u.available === false ? { available: false, reason: text(u.reason, MAX_PATH_TEXT) } : u
}

function clampSend(s: unknown): unknown {
  return isRecord(s) && s.ok === false ? { ok: false, reason: text(s.reason, MAX_REASON) } : s
}

function clampCounter(c: unknown): unknown {
  return isRecord(c) ? { ...c, title: text(c.title, MAX_TITLE) } : c
}

function samplePath(x: unknown): string | null {
  const s = cutText(x, MAX_PATH_TEXT)
  return s ? s : null
}

function clampFile(f: unknown): Record<string, unknown> | null {
  if (!isRecord(f) || !Array.isArray(f.hunks)) return null
  const path = cutText(f.path, MAX_PATH_TEXT)
  const relPath = cutText(f.relPath, MAX_PATH_TEXT)
  const hash = cutText(f.hash, MAX_HASH)
  if (path === null || relPath === null || hash === null) return null
  return { ...f, path, relPath, hash, hunks: fit(f.hunks, MAX_HUNKS, clampHunk) }
}

function clampHunk(h: unknown): Record<string, unknown> | null {
  if (!isRecord(h) || !Array.isArray(h.lines)) return null
  const header = cutText(h.header, MAX_PATH_TEXT)
  if (header === null) return null
  return { header, lines: fit(h.lines, MAX_LINES, clampLine) }
}

function clampLine(l: unknown): Record<string, unknown> | null {
  if (!isRecord(l)) return null
  const line = cutText(l.text, MAX_LINE_CHARS)
  if (line === null) return null
  return { ...l, text: line }
}

// ---- text helpers

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function fits(s: string, max: number): boolean {
  return s.length >= 1 && s.length <= max
}

/** the first `max` items `item` keeps; an item it does not keep (null) is left out */
function fit<T>(list: unknown[], max: number, item: (x: unknown) => T | null): T[] {
  const out: T[] = []
  for (const x of list) {
    if (out.length >= max) break
    const y = item(x)
    if (y !== null) out.push(y)
  }
  return out
}

/** the text without C0 control characters (a directory field) */
function stripC0(s: string): string {
  return s.replace(C0_RE, '')
}

/** the text cut to `max` characters, never leaving the high half of a surrogate pair; a cut that would is one unit earlier */
function cut(s: string, max: number): string {
  if (s.length <= max) return s
  let end = max
  if (isHighSurrogate(s.charCodeAt(end - 1))) end--
  return s.slice(0, end)
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/** a directory field that may be null: C0 stripped and cut to `max`; null stays null */
function optional(v: string | null, max: number): string | null {
  return v === null ? null : cut(stripC0(v), max)
}

/** a push's text: NUL removed and cut to `max`; a value that is not text is returned as it is */
function text(v: unknown, max: number): unknown {
  return cutText(v, max) ?? v
}

function nullableText(v: unknown, max: number): unknown {
  return v === null ? null : text(v, max)
}

/** a push's text: NUL removed and cut to `max`, or null when it is not text */
function cutText(v: unknown, max: number): string | null {
  return typeof v === 'string' ? cut(v.replace(NUL_RE, ''), max) : null
}

/** a push's text that must fit: NUL removed, and null when it is not text or is over `max` (it is not cut) */
function fitting(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(NUL_RE, '')
  return fits(s, max) ? s : null
}
