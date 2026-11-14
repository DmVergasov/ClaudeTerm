import { open } from 'node:fs/promises'
import { checkImageFile, MAX_IMAGE_BYTES } from '../shared/image-file'
import { hasText } from '../shared/note'
import { isUuid } from '../shared/protocol'
import type { AgentPatch, AgentSnapshot, ChatAnswer, ChatAttachment, ChatCommandInfo, ChatItem, ChatModelInfo, ChatPatch, ChatPermissionMode, ChatSend, ChatSnapshot, TabView } from '../shared/chat'
import type { DeviceResult } from '../shared/devices'
import { IMAGE_PART_BYTES, MAX_CHAT_PUSH_BYTES, MAX_PATH_TEXT, MAX_REVIEW_PARTS, REMOTE_COPY, REVIEW_FILE_BYTES, REVIEW_PART_BYTES, type FolderResult, type PushKind, type RemoteTab } from '../shared/remote'
import { MAX_HASH, type ReviewCounter, type ReviewUpdate } from '../shared/review'
import type { PlanUpdate } from '../shared/ipc'
import type { RecentSession, TabInfo, TabPlace } from '../shared/types'
import type { AccountView } from '../shared/accounts'
import { capItems, capSnapshot, itemForOlder, MAX_CHAT_PATCHES } from './chat/chat-mirror'
import type { ImageHub } from './image-hub'
import { isAbsPath, isHash } from './ipc-guards'
import { pathKey } from './path-key'
import type { NoteHub } from './note-hub'
import type { ReviewHub } from './review-hub'
import type { StatusHub } from './status-hub'
import type { TabManager } from './tab-manager'
import { CallError, type CallEntry } from './sync/calls'
import { CALL_ARGS, type CallArgs } from './sync/remote-shapes'
import { parsePlace } from './sync/remote-wire'
import { type HostTabs, nextTurn, type TabHost } from './sync/tab-host'
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
/** what a part's own keys (rev, i, of, head, files) take beyond its files, with room to spare */
const PART_SLACK_BYTES = 1024
/** what an object costs in a push beyond its strings: its keys, its braces and its numbers, rounded up */
const OBJECT_BYTES = 64

// NUL and the other C0 control characters
const C0_RE = /[\u0000-\u001f]/g
const NUL_RE = /\u0000/g

/** what a member's chat calls reach on this device: the tab's chat, and what a message needs here (files, the view, the terminal) */
export interface HostChat {
  /** the chat of the tab, cut to the chat push's cap; null for a tab with no chat */
  snapshot(tabId: string): ChatSnapshot | null
  /** a message: null when sent or queued; else why it was not sent */
  send(tabId: string, s: ChatSend): Promise<string | null>
  answer(tabId: string, cardId: string, a: ChatAnswer): boolean
  interrupt(tabId: string): void
  setMode(tabId: string, mode: ChatPermissionMode): Promise<void>
  setModel(tabId: string, model: string | null, effort: string | null): Promise<void>
  stopTask(tabId: string, taskId: string): Promise<void>
  older(tabId: string, beforeId: string): { items: ChatItem[]; hasOlder: boolean } | null
  /** an agent's page of the tab, cut to the chat push's cap, not writable; null for an agent the tab does not have */
  agentSnapshot(tabId: string, agentId: string): Promise<AgentSnapshot | null>
  /** the items of an agent's page before one of its items; null for an agent the tab does not have */
  agentOlder(tabId: string, agentId: string, beforeId: string): Promise<{ items: ChatItem[]; hasOlder: boolean } | null>
  /** the agent page a member watches on this device (null: none): its batches go to that member only */
  watchAgent(tabId: string, device: string, agentId: string | null): void
  /** the permission modes the tab offers on this device: a member may set only these */
  modes(tabId: string): ChatPermissionMode[]
  commands(tabId: string): Promise<ChatCommandInfo[]>
  models(tabId: string): Promise<ChatModelInfo[]>
  /** the project files that match a query, as the @ picker lists them */
  files(tabId: string, query: string): Promise<string[]>
  /** the files a member copied here, as attachments the tab's messages may carry (registered for the tab) */
  attach(tabId: string, paths: string[]): Promise<ChatAttachment[]>
  /** the tab's view: a Claude tab restarts in it; false when it does not change now */
  setView(tabId: string, view: TabView): Promise<boolean>
  /** a line typed into the tab's terminal once its prompt is empty (null: only the switch); false when it cannot go */
  openInTerminal(tabId: string, line: string | null): Promise<boolean>
}

/** what this device gives a member about its tabs: the directory and the hub updates each tab has */
export interface HostContext {
  tabs: Pick<TabManager, 'list' | 'get' | 'isTransient' | 'close' | 'rename' | 'setMuted' | 'restart' | 'switchAccount' | 'size' | 'canFork' | 'fork'>
  /** the chats of this device's Claude tabs; left out, no tab has a chat for a member */
  chat?: HostChat
  /** the app version of a linked member; null for an older device (or none): it gets the chat in the forms it has */
  memberApp?(device: string): string | null
  images: Pick<ImageHub, 'list' | 'unseenCount' | 'notice' | 'markSeen' | 'remove' | 'get'>
  /** the extensions of the image files this device shows: the ones the image panel takes */
  imageExtensions(): string[]
  status: Pick<StatusHub, 'get'>
  /** what the status bar of a tab shows of its plan: the plan, or the task list Claude keeps, with the flag that says which */
  shownPlan(tabId: string): PlanUpdate
  /** clears the task list a Claude tab of this device keeps; false when this device keeps no list for the tab */
  clearTaskList(tabId: string): boolean
  notes: Pick<NoteHub, 'get'>
  /** the accounts this device can start tabs on (readable), by id and name only */
  accounts: { list(): Pick<AccountView, 'id' | 'name' | 'readable'>[]; nameOf(id: string): string | null }
  sizes: TabSizes
  attention: TabAttention
  titles: ReadonlyMap<string, string>
  /** the last place TabPlaces published for each of this device's tabs; null: none */
  places: ReadonlyMap<string, TabPlace | null>
  /** the last review update published for each tab */
  reviews: ReadonlyMap<string, ReviewUpdate>
  /** the rev of each tab's last review: the counter of the publish, which only grows */
  reviewRevs: ReadonlyMap<string, number>
  /** the Changes actions a member asks of a tab; the hub acts on the tab's own view */
  review: Pick<ReviewHub, 'setScope' | 'clearRequest' | 'refresh' | 'setViewed' | 'showFile' | 'canSend'>
  profiles(): string[]
  /** the text typed for paths into one of this device's tabs: quoted for the tab's shell, double quotes for a Claude tab */
  typedPaths(tabId: string, paths: string[]): string
  /** opens a tab in this device's default folder without bringing it to the front of this window */
  openTab(req: CallArgs['open-tab']): TabInfo | null
  writeInput(tabId: string, data: string, from: string | null): void
  claim(tabId: string, from: string, cols: number, rows: number): void
  /** the tab a member has in front, and whether the member is present (see Presence); focused is a 0.15.0 member's flag, kept for its clearing */
  front(from: string, tabId: string | null, present: boolean, focused: boolean): void
  /** the subfolders of a tab's folder (null: the tab's own), read on this device */
  folders(tabId: string, path: string | null): Promise<FolderResult>
  /** moves a tab to another folder on this device; a refusal is its message */
  changeFolder(tabId: string, path: string): Promise<DeviceResult>
  /** this device's Recent sessions, newest first, as the sessions window lists them */
  sessions(): Promise<RecentSession[]>
  /**
   * The tab in a session's conversation when one is open (not brought forward), else a new Claude tab that resumes it,
   * opened without bringing it forward. Rejects with a CallError when this device no longer lists the session (no session of
   * the list it was asked for) or when the session's folder is gone.
   */
  openSession(id: string): Promise<string>
  /** the files a member sends for a tab of this device: a transfer is kept for the device that began it */
  receiver: Pick<FileReceiver, 'begin' | 'part' | 'end'>
}

/** This device's tabs as the host serves them: the directory, and the pushes of one tab. */
export function hostTabs(ctx: HostContext): HostTabs {
  return {
    list: () => directoryOf(ctx),
    has: (tabId) => ctx.tabs.get(tabId) !== null && !ctx.tabs.isTransient(tabId),
    input: (tabId, data, from) => {
      ctx.writeInput(tabId, data, from)
    },
    claim: (tabId, from, cols, rows) => {
      ctx.claim(tabId, from, cols, rows)
    },
    front: (from, tabId, present, focused) => {
      ctx.front(from, tabId, present, focused)
    },
    pushes: (tabId) => pushesOf(ctx, tabId)
  }
}

/** the sessions each member device was last answered with, by host context: open-session opens only these, for that member */
const listedByMember = new WeakMap<HostContext, Map<string, Set<string>>>()

/** the files each member copied to this device, by path key, by host context: a chat message may carry only these */
const copiedByMember = new WeakMap<HostContext, Map<string, Set<string>>>()
/** the most files a member's copies are remembered by, per member: the oldest are forgotten first */
const MAX_COPIED = 10_000
/** the text of the refusals of the chat calls */
const NOT_CHAT = 'not a chat tab'
const NOT_COPIED = 'not a file sent to this device'
const NO_VIEW = 'the tab cannot change its view now'
const NO_TERMINAL = 'the line cannot be typed into the terminal now'
const NO_MODE = 'the permission mode is not offered here'
const NO_AGENT = 'that agent is not on this device'
/** the chat-sends of each tab in the order they came: by host context, then tab id */
const chatOrder = new WeakMap<HostContext, Map<string, Promise<unknown>>>()

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
      run: async (a) => {
        const args = CALL_ARGS['open-session'](a)
        if (!args) throw new CallError('bad arguments')
        if (!sessionsOfMember.get(device)?.has(args.session)) throw new CallError(REMOTE_COPY.unknownSession)
        return { id: await ctx.openSession(args.session) }
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
    // the end of a transfer answers the paths; a sender that names its tab also gets the text to type, quoted for that tab's shell
    'recv-end': {
      run: async (a) => {
        const args = CALL_ARGS['recv-end'](a)
        if (!args) throw new CallError('bad arguments')
        // an older sender names no tab: it types the paths itself, as 0.15.0 did
        if (args.id === undefined) return { paths: await endTransfer(ctx, device, args.transfer) }
        const { id } = tabCall(ctx, { id: args.id })
        const paths = await endTransfer(ctx, device, args.transfer)
        return { paths, text: ctx.typedPaths(id, paths) }
      }
    },
    // the chats of this device's Claude tabs: each call runs on the tab's own chat; a tab that is not a Claude tab in its chat view is refused
    'chat-send': {
      run: (a) => {
        const { args, chat } = chatCall(ctx, CALL_ARGS['chat-send'](a), true)
        // in the tab's order: a message whose files are still attached is not overtaken by a later one
        return inChatOrder(ctx, args.id, async () => {
          // a message carries only the files this member copied here; they are registered for the tab as the window's are
          const copied = copiedOf(ctx, device)
          if (!args.attachments.every((f) => copied.has(pathKey(f.path)))) throw new CallError(NOT_COPIED)
          const attachments = await chat.attach(args.id, args.attachments.map((f) => f.path))
          const refused = await chat.send(args.id, { text: args.text, attachments })
          if (refused !== null) throw new CallError(refused)
          return {}
        })
      }
    },
    // the answer is { ok }: false when the card is answered already (the first answer wins)
    'chat-answer': {
      run: (a) => {
        const { args, chat } = chatCall(ctx, CALL_ARGS['chat-answer'](a), true)
        return { ok: chat.answer(args.id, args.cardId, args.answer) }
      }
    },
    'chat-interrupt': {
      run: (a) => {
        const { args, chat } = chatCall(ctx, CALL_ARGS['chat-interrupt'](a), true)
        chat.interrupt(args.id)
        return {}
      }
    },
    'chat-mode': {
      run: async (a) => {
        const { args, chat } = chatCall(ctx, CALL_ARGS['chat-mode'](a), true)
        // only the modes the window offers: a member does not set one the device's own chats do not show
        if (!chat.modes(args.id).includes(args.mode)) throw new CallError(NO_MODE)
        await chat.setMode(args.id, args.mode)
        return {}
      }
    },
    'chat-model': {
      run: async (a) => {
        const { args, chat } = chatCall(ctx, CALL_ARGS['chat-model'](a), true)
        await chat.setModel(args.id, args.model, args.effort)
        return {}
      }
    },
    'chat-stop-task': {
      run: async (a) => {
        const { args, chat } = chatCall(ctx, CALL_ARGS['chat-stop-task'](a), true)
        await chat.stopTask(args.id, args.taskId)
        return {}
      }
    },
    // bulk: a page of a long stretch of tools is megabytes, and it goes on the bulk lane, not ahead of the input
    'chat-older': {
      bulk: true,
      run: (a) => {
        const { args, chat } = chatCall(ctx, CALL_ARGS['chat-older'](a), true)
        const page = chat.older(args.id, args.beforeId)
        if (!page) throw new CallError(NOT_CHAT)
        // an older member has no forward or prompt: its page carries them as notices
        const older = ctx.memberApp?.(device) === null
        return cutPage(older ? { ...page, items: page.items.map(itemForOlder) } : page)
      }
    },
    // an agent's page: the newest items of it, as the window of a member gets it; a page is read-only here
    'chat-agent': {
      run: async (a) => {
        const { args, chat } = chatCall(ctx, CALL_ARGS['chat-agent'](a), true)
        const page = await chat.agentSnapshot(args.id, args.agentId)
        if (!page) throw new CallError(NO_AGENT)
        return page
      }
    },
    'chat-agent-older': {
      bulk: true,
      run: async (a) => {
        const { args, chat } = chatCall(ctx, CALL_ARGS['chat-agent-older'](a), true)
        const page = await chat.agentOlder(args.id, args.agentId, args.beforeId)
        if (!page) throw new CallError(NO_AGENT)
        return cutPage(page)
      }
    },
    // the agent page this member watches: its batches come to this device until it watches another page, or none (null)
    'chat-agent-watch': {
      run: (a) => {
        const { args, chat } = chatCall(ctx, CALL_ARGS['chat-agent-watch'](a), true)
        chat.watchAgent(args.id, device, args.agentId)
        return {}
      }
    },
    // a Claude tab in either view can switch view: the handoff of a command switches to the terminal on the same call
    'chat-view': {
      run: async (a) => {
        const { args, chat } = chatCall(ctx, CALL_ARGS['chat-view'](a), false)
        if (!(await chat.setView(args.id, args.view))) throw new CallError(NO_VIEW)
        return {}
      }
    },
    'chat-commands': {
      run: async (a) => {
        const { args, chat } = chatCall(ctx, CALL_ARGS['chat-commands'](a), true)
        return chat.commands(args.id)
      }
    },
    'chat-models': {
      run: async (a) => {
        const { args, chat } = chatCall(ctx, CALL_ARGS['chat-models'](a), true)
        return chat.models(args.id)
      }
    },
    // the modes the tab offers on this device, the ones a member's chip lists (at most the six there are)
    'chat-modes': {
      run: (a) => {
        const { args, chat } = chatCall(ctx, CALL_ARGS['chat-modes'](a), true)
        return chat.modes(args.id).slice(0, 6)
      }
    },
    'chat-files': {
      run: async (a) => {
        const { args, chat } = chatCall(ctx, CALL_ARGS['chat-files'](a), true)
        return chat.files(args.id, args.query)
      }
    },
    'chat-terminal': {
      run: async (a) => {
        const { args, chat } = chatCall(ctx, CALL_ARGS['chat-terminal'](a), false)
        if (!(await chat.openInTerminal(args.id, args.line === '' ? null : args.line))) throw new CallError(NO_TERMINAL)
        return {}
      }
    }
  }
}

/** runs a chat call of a tab after the ones of that tab that came before it, whatever they did: a chat-send's files may take a while */
function inChatOrder<T>(ctx: HostContext, tabId: string, run: () => Promise<T>): Promise<T> {
  let chains = chatOrder.get(ctx)
  if (!chains) {
    chains = new Map()
    chatOrder.set(ctx, chains)
  }
  const next = (chains.get(tabId) ?? Promise.resolve()).then(() => run(), () => run())
  const tail = next.then(() => undefined, () => undefined)
  chains.set(tabId, tail)
  void tail.then(() => {
    if (chains.get(tabId) === tail) chains.delete(tabId)
  })
  return next
}

/** the checked arguments of a chat call, and the chat of this device: a Claude tab, in its chat view when `inChat` is set */
function chatCall<A extends { id: string }>(ctx: HostContext, checked: A | null, inChat: boolean): { args: A; chat: HostChat } {
  if (!checked) throw new CallError('bad arguments')
  const info = ctx.tabs.get(checked.id)
  if (!ctx.chat || info?.kind !== 'claude' || (inChat && info.view !== 'chat')) throw new CallError(NOT_CHAT)
  return { args: checked, chat: ctx.chat }
}

/** the transfer's files, kept for the member that began it: their paths are remembered as copied by that member */
async function endTransfer(ctx: HostContext, device: string, transfer: string): Promise<string[]> {
  const paths = await ctx.receiver.end(transfer, device)
  let copied = copiedByMember.get(ctx)
  if (!copied) {
    copied = new Map()
    copiedByMember.set(ctx, copied)
  }
  let set = copied.get(device)
  if (!set) {
    set = new Set()
    copied.set(device, set)
  }
  for (const p of paths) {
    set.add(pathKey(p))
    if (set.size > MAX_COPIED) {
      const oldest = set.values().next().value
      if (oldest !== undefined) set.delete(oldest)
    }
  }
  return paths
}

/** a member that leaves: the files it copied here are no longer ones its messages may carry */
export function forgetCopiedBy(ctx: HostContext, device: string): void {
  copiedByMember.get(ctx)?.delete(device)
}

/** the paths, by path key, of the files this member copied to this device */
function copiedOf(ctx: HostContext, device: string): Set<string> {
  return copiedByMember.get(ctx)?.get(device) ?? new Set<string>()
}

/**
 * The push of a batch of a chat's patches to the members that watch it: the batch as it is, or the chat's snapshot when the
 * batch is over what the receiver takes (MAX_CHAT_PUSH_BYTES as JSON, or MAX_CHAT_PATCHES patches); null when neither can go
 */
export function chatBatchPush(
  batch: { fromRev: number; toRev: number; patches: ChatPatch[] },
  snapshot: () => ChatSnapshot | null
): { k: PushKind; v: unknown } | null {
  if (batch.patches.length <= MAX_CHAT_PATCHES && Buffer.byteLength(JSON.stringify(batch)) <= MAX_CHAT_PUSH_BYTES) return { k: 'chat-patch', v: batch }
  const s = snapshot()
  return s === null ? null : { k: 'chat', v: s }
}

/**
 * A batch of an agent's patches to the members that watch its page: the batch as it is, or the page as a snapshot when the batch is
 * over what the receiver takes (MAX_CHAT_PUSH_BYTES as JSON, or MAX_CHAT_PATCHES patches). The page is made first, so a device
 * that no longer watches it then gets nothing.
 */
export async function pushAgentBatch(
  host: Pick<TabHost, 'pushToDevice'>,
  tabId: string,
  batch: { agentId: string; fromRev: number; toRev: number; patches: AgentPatch[] },
  devices: string[],
  snapshot: () => Promise<AgentSnapshot | null>,
  watching: (device: string) => boolean
): Promise<void> {
  let push: { k: PushKind; v: unknown } | null
  if (batch.patches.length <= MAX_CHAT_PATCHES && Buffer.byteLength(JSON.stringify(batch)) <= MAX_CHAT_PUSH_BYTES) push = { k: 'chat-agent-patch', v: batch }
  else {
    const s = await snapshot()
    push = s === null ? null : { k: 'chat-agent', v: s }
  }
  if (push === null) return
  for (const device of devices) if (watching(device)) host.pushToDevice(device, tabId, push.k, push.v)
}

/** a page of items cut the way a snapshot is cut: the newest items that fit a push, and hasOlder when some were left out */
function cutPage(page: { items: ChatItem[]; hasOlder: boolean }): { items: ChatItem[]; hasOlder: boolean } {
  const cut = capItems(page.items, MAX_CHAT_PUSH_BYTES - Buffer.byteLength(JSON.stringify({ items: [], hasOlder: true })))
  return { items: cut.items, hasOlder: page.hasOlder || cut.cut }
}

/** the chat of a Claude tab in its chat view, as a push; null for any other tab, or a tab with no chat */
function chatPushOf(ctx: HostContext, tabId: string): { k: PushKind; v: unknown } | null {
  const info = ctx.tabs.get(tabId)
  if (!ctx.chat || info?.kind !== 'claude' || info.view !== 'chat') return null
  const s = ctx.chat.snapshot(tabId)
  return s === null ? null : { k: 'chat', v: s }
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
    case 'chat':
      return clampChat(v)
    default:
      return v
  }
}

/** a snapshot cut to the chat push's cap; a batch of patches is not cut here: the sender replaces one over the cap by a snapshot */
function clampChat(v: unknown): unknown {
  if (!isRecord(v) || !Array.isArray(v.items)) return v
  return capSnapshot(v as unknown as ChatSnapshot, MAX_CHAT_PUSH_BYTES)
}

// ---- the directory

function directoryOf(ctx: HostContext): RemoteTab[] {
  const list: RemoteTab[] = []
  for (const info of ctx.tabs.list()) {
    // a sign-in tab stays on this device: its output may hold an email or a code, and a member could type into it
    if (ctx.tabs.isTransient(info.id)) continue
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
    fork: info.fork !== null,
    // the view of a Claude tab; a shell tab has none, and the wire leaves it out
    ...(info.kind === 'claude' && info.view !== null ? { view: info.view } : {})
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

/** the pushes of a tab, in the order a member gets them: status, plan, images and the last review (in parts when it is large) */
async function pushesOf(ctx: HostContext, tabId: string): Promise<Array<{ k: PushKind; v: unknown }>> {
  const review = ctx.reviews.get(tabId)
  let reviewPushesOf: { k: PushKind; v: unknown }[] = []
  if (review) {
    const rev = ctx.reviewRevs.get(tabId) ?? 0
    // a newer review of the tab replaced this one while it was clamped: that one is pushed to the member, as it is attached
    reviewPushesOf = (await reviewPushes(withoutTabId(review), rev, {
      yieldNow: nextTurn,
      stale: () => (ctx.reviewRevs.get(tabId) ?? 0) !== rev
    })) ?? []
  }
  // read after the last turn of the clamp: a status, plan or images update pushed meanwhile is not followed by an older one.
  // The chat is read here too, and goes first: a batch of its patches sent while the pushes are sent is covered by it
  const chat = chatPushOf(ctx, tabId)
  const status = ctx.status.get(tabId)
  const out: Array<{ k: PushKind; v: unknown }> = [
    ...(chat === null ? [] : [chat]),
    { k: 'status', v: clampPush('status', { main: status.main, agents: status.agents, background: status.background }) },
    { k: 'plan', v: clampPush('plan', planPush(ctx.shownPlan(tabId))) },
    {
      k: 'images',
      v: clampPush('images', { cards: ctx.images.list(tabId), unseen: ctx.images.unseenCount(tabId), notice: ctx.images.notice(tabId) })
    }
  ]
  return [...out, ...reviewPushesOf]
}

/**
 * A review's pushes for the members of its tab: one `review` push carrying its rev when the whole fits REVIEW_PART_BYTES,
 * else `review-part` pushes in order, the head in part 0. The files are clamped one by one with a turn of the event loop
 * before each, so a large review does not hold up the process. Null once stale() says a newer review replaced this one.
 */
export async function reviewPushes(
  v: unknown,
  rev: number,
  o: { yieldNow(): Promise<void>; stale(): boolean }
): Promise<{ k: 'review' | 'review-part'; v: unknown }[] | null> {
  if (!isRecord(v) || !Array.isArray(v.files)) return [{ k: 'review', v: withRev(clampPush('review', v), rev) }]
  const budget = new FileBudget()
  const files = clampedFiles(v.files)
  for (;;) {
    await o.yieldNow()
    if (o.stale()) return null
    const next = files.next()
    if (next.done || !budget.add(next.value)) break
  }
  const head = clampPush('review', { ...v, files: [] }) as Record<string, unknown>
  delete head.files
  const groups = packFiles(head, budget.kept)
  if (groups.length === 1) return [{ k: 'review', v: { ...head, files: groups[0], rev } }]
  const of = groups.length
  return groups.map((files, i) => ({ k: 'review-part', v: i === 0 ? { rev, i, of, head, files } : { rev, i, of, files } }))
}

function withRev(v: unknown, rev: number): unknown {
  return isRecord(v) ? { ...v, rev } : v
}

/**
 * The files in order, cut into groups that each fit a part: part 0 takes the head too. A file that does not fit the rest of
 * a part starts the next one, and so a group may hold no file when the head alone is large. At MAX_REVIEW_PARTS parts, a file
 * that needs one more keeps its header only, in the last part; when even the headers do not fit, the list ends there.
 */
export function packFiles(head: Record<string, unknown>, kept: KeptFile[]): Record<string, unknown>[][] {
  const budget = REVIEW_PART_BYTES - PART_SLACK_BYTES
  const groups: Record<string, unknown>[][] = []
  let group: Record<string, unknown>[] = []
  let used = encodedBytes(head)
  for (const f of kept) {
    let item = f
    if (used + item.bytes + 1 > budget) {
      if (groups.length + 1 < MAX_REVIEW_PARTS) {
        groups.push(group)
        group = []
        used = 0
      } else {
        item = headerOf(f.file)
        if (used + item.bytes + 1 > budget) break
      }
    }
    group.push(item.file)
    used += item.bytes + 1
  }
  groups.push(group)
  return groups
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
  const { id, cwd, title, firstPrompt, lastPrompt, modifiedAt, open, starred, accountName } = x
  if (!isUuid(id) || typeof cwd !== 'string' || cwd.includes('\u0000') || !fits(cwd, MAX_PATH_TEXT)) return null
  if (typeof modifiedAt !== 'number' || !Number.isFinite(modifiedAt) || modifiedAt < 0) return null
  if (typeof open !== 'boolean' || typeof starred !== 'boolean') return null
  const t = sessionText(title)
  const f = sessionText(firstPrompt)
  const l = sessionText(lastPrompt)
  if (t === undefined || f === undefined || l === undefined) return null
  // the account's name only, cut and cleaned like a title: its id never leaves this device, and Main account has none (null)
  const name = typeof accountName === 'string' ? cut(stripC0(accountName), MAX_ACCOUNT_NAME) : ''
  return { id, cwd, title: t, firstPrompt: f, lastPrompt: l, modifiedAt, open, starred, accountName: name === '' ? null : name }
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
  if (ctx.tabs.get(checked.id) === null || ctx.tabs.isTransient(checked.id)) throw new CallError(REMOTE_COPY.unknownTab)
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

/** a clamped file, with its encoded size as the push sends it */
interface KeptFile {
  file: Record<string, unknown>
  bytes: number
}

/**
 * The files in order, within REVIEW_PUSH_BYTES of encoded size. A file is kept whole while it fits; the first one that does
 * not keeps its header only, with no hunks and the note too-many, and so does every later one. A header that does not
 * fit either ends the list.
 */
function clampFiles(list: unknown[]): Record<string, unknown>[] {
  const budget = new FileBudget()
  for (const f of clampedFiles(list)) if (!budget.add(f)) break
  return budget.kept.map((f) => f.file)
}

/**
 * The clamped files of a list, one at a time: at most MAX_FILES, and a file over REVIEW_FILE_BYTES encoded keeps its header
 * only. The clamp of each file runs when it is asked for, so a caller can wait between two files.
 */
function* clampedFiles(list: unknown[]): Generator<KeptFile> {
  let n = 0
  for (const x of list) {
    if (n >= MAX_FILES) return
    const f = clampFileWithin(x, REVIEW_FILE_BYTES)
    if (f === null) continue
    n++
    yield f.over ? headerOf(f.file) : { file: f.file, bytes: f.bytes }
  }
}

/** the file as a review keeps it: with its encoded size */
function keptOf(f: Record<string, unknown>): KeptFile {
  return { file: f, bytes: encodedBytes(f) }
}

/** a file as a review keeps its header only: no hunks, the note too-many */
function headerOf(f: Record<string, unknown>): KeptFile {
  return keptOf({ ...f, hunks: [], note: 'too-many' })
}

/** the files a review keeps, within REVIEW_PUSH_BYTES by the clamp's own estimate of their size */
class FileBudget {
  readonly kept: KeptFile[] = []
  private used = 0
  private full = false
  private open = true

  /** adds the next file; false once the list has ended, and no file after it is kept */
  add(f: KeptFile): boolean {
    if (!this.open) return false
    if (!this.full) {
      const size = fileBytes(f.file)
      if (this.used + size <= REVIEW_PUSH_BYTES) return this.keep(f, size)
      this.full = true
    }
    const header = headerOf(f.file)
    const size = ownBytes(header.file)
    if (this.used + size > REVIEW_PUSH_BYTES) {
      this.open = false
      return false
    }
    return this.keep(header, size)
  }

  private keep(f: KeptFile, size: number): boolean {
    this.kept.push(f)
    this.used += size
    return true
  }
}

/** the JSON-encoded size of a value, in bytes */
function encodedBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v))
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

/**
 * A file clamped as its fields and hunks are clamped, and stopped as soon as its encoded size is over `limit`: then `over` is
 * true and `file` has no hunks. The running size counts whole lines and hunk headers, so it is a lower bound of the file's
 * encoded size: a file stopped here is over the limit, and a file that is not stopped is measured exactly.
 */
function clampFileWithin(
  f: unknown,
  limit: number
): { file: Record<string, unknown>; over: boolean; bytes: number } | null {
  if (!isRecord(f) || !Array.isArray(f.hunks)) return null
  const path = cutText(f.path, MAX_PATH_TEXT)
  const relPath = cutText(f.relPath, MAX_PATH_TEXT)
  const hash = cutText(f.hash, MAX_HASH)
  if (path === null || relPath === null || hash === null) return null
  const base = { ...f, path, relPath, hash }
  let bytes = encodedBytes({ ...base, hunks: [] })
  if (bytes > limit) return { file: base, over: true, bytes }
  const hunks: Record<string, unknown>[] = []
  for (const h of f.hunks) {
    if (hunks.length >= MAX_HUNKS) break
    if (!isRecord(h) || !Array.isArray(h.lines)) continue
    const header = cutText(h.header, MAX_PATH_TEXT)
    if (header === null) continue
    bytes += encodedBytes({ header })
    const lines: Record<string, unknown>[] = []
    for (const l of h.lines) {
      if (lines.length >= MAX_LINES) break
      const line = clampLine(l)
      if (line === null) continue
      lines.push(line)
      bytes += encodedBytes(line)
      if (bytes > limit) return { file: base, over: true, bytes }
    }
    hunks.push({ header, lines })
  }
  const file = { ...base, hunks }
  // measured once, exactly: the caller keeps this size, and a file over the limit keeps its header only
  const exact = encodedBytes(file)
  return { file, over: exact > limit, bytes: exact }
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
