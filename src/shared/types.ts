export type TabKind = 'claude' | 'shell'
export type ShellFamily = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish' | 'wsl' | 'other'

export interface ProfileDef {
  name: string
  command: string
  args: string[]
}

/** a Claude tab that continues a copy of another tab's conversation */
export interface TabFork {
  /** the family's head while it is open */
  of: string | null
  /**
   * the session id the fork was made from: a fork with no conversation of its own saved yet is forked from it again.
   * Null once the tab has a conversation of its own (it was resumed, cleared or replaced): it is never forked again.
   */
  from: string | null
}

export interface TabInfo {
  id: string
  kind: TabKind
  profile: string
  /** the folder the tab was opened in: its process starts there, and a Claude conversation resumes there */
  cwd: string
  /** the folder the tab works in: cwd, until Claude Code reports another (a worktree it entered, a cd) */
  folder: string
  customTitle: string | null
  claudeSessionId: string | null
  /** the extra account a Claude tab runs on; null: the main account (and every shell tab) */
  account: string | null
  /** the user muted the tab: it makes no notification sound */
  muted: boolean
  /** the Claude tab is a fork of another tab's conversation; null: an ordinary tab */
  fork: TabFork | null
  exited: boolean
  /** what Claude is doing in the tab; null while it is idle, and in a shell tab */
  activity: TabActivity
}

/** working: Claude is in a turn, or an agent it started still runs (Claude Code waits for it past the end of the turn) */
export type TabActivity = 'working' | null

export interface OpenTabRequest {
  kind: TabKind
  cwd: string
  profile?: string | null
  title?: string | null
  resumeSessionId?: string | null
  /** a Claude tab's account, null the main one; left out: the account of the active Claude tab */
  account?: string | null
  /** start the tab muted, as it was when its session was saved */
  muted?: boolean
  /** a fork of another tab's conversation (a Claude tab) */
  fork?: TabFork | null
}

export type ImageSource = 'created' | 'shown' | 'read' | 'tool' | 'pasted'
export type CardKind = 'image' | 'audio' | 'video'

export interface ImageCard {
  id: string
  tabId: string
  path: string
  name: string
  relPath: string
  source: ImageSource
  kind: CardKind
  caption: string | null
  touchedAt: number
  version: number
  updated: boolean
  deleted: boolean
}

export interface SessionSnapshotTab {
  kind: TabKind
  profile: string
  cwd: string
  title: string | null
  claudeSessionId: string | null
  account: string | null
  muted: boolean
  /** Claude was in the middle of a turn: a prompt had started it, and it had neither ended nor been interrupted */
  working: boolean
  /**
   * the last turn had ended while work Claude left in the background (agents, background commands) still ran: Claude
   * waited for it to wake the conversation again
   */
  background: boolean
  /** a fork of a Claude tab: `of` is the head's index in this list, null when the head is not kept */
  fork: { of: number | null; from: string | null } | null
}

export interface SessionSnapshot {
  version: 1
  savedAt: string
  tabs: SessionSnapshotTab[]
}

/** peer: the end of a turn that a message from another Claude Code session started */
export type NotificationCase = 'permission' | 'question' | 'done' | 'peer' | 'bell'

export interface NotificationChannels {
  sound: boolean
  /** flash the taskbar button when the window is not focused */
  flash: boolean
  /** show a system notification when the window is not focused; a click on it opens the tab */
  banner: boolean
  /** mark the tab when it is not the active one */
  tab: boolean
  /** signal also while the tab is in front of the user (window focused, tab active): there only the sound can */
  front: boolean
}

/**
 * sound: 'system' or an absolute path to a .wav file; doneWithBackgroundWork: a turn that ends while background work Claude
 * started still runs gives the done signals too; autoUnread: a Claude tab left mid-reply or with an unsent prompt pulses as
 * one Claude waits in; then the signals each case gives
 */
export type NotificationSettings = { sound: string; doneWithBackgroundWork: boolean; autoUnread: boolean } & Record<NotificationCase, NotificationChannels>

/**
 * How the side panel sits by the terminal: beside it in a window widened for it, or, when the window had no room, over the
 * terminal's right side or narrowing it.
 */
export type PanelMode = 'beside' | 'overlay' | 'narrow'

export type NoRoomMode = Exclude<PanelMode, 'beside'>

/** where the tab bar sits: across the top, or as a column on the left */
export type TabPosition = 'top' | 'left'

export interface Settings {
  defaultProfile: string | null
  /** the folder new tabs open in, an absolute path; null: the home folder */
  defaultFolder: string | null
  /**
   * statusRefresh: Claude Code also re-runs a Claude tab's statusLine every statusRefreshInterval seconds; autoContinue: type a
   * nudge into a Claude tab whose response a dropped connection cut off, instead of calling the user; continueAfterRestore:
   * the same for a restored tab Claude was working in when ClaudeTerm closed
   */
  claude: { command: string; shellProfile: string | null; statusRefresh: boolean; statusRefreshInterval: number; autoContinue: boolean; continueAfterRestore: boolean }
  profiles: ProfileDef[]
  font: { family: string; size: number }
  theme: string | Record<string, string>
  scrollback: number
  imageWatch: { enabled: boolean; extensions: string[]; ignore: string[]; maxDepth: number }
  imagePanel: { autoOpen: boolean; width: number; maxItems: number }
  notifications: NotificationSettings
  /** the Changes panel */
  review: { editor: string | null; statusBar: boolean; hideIgnored: boolean; hideTests: boolean; testPatterns: string[]; width: number; fileTree: boolean; treeWidth: number
    /** Markdown files show formatted, not as plain diffs */
    renderMarkdown: boolean }
  /** where Images and Changes go when the window has no room to widen for them */
  sidePanel: { noRoom: NoRoomMode }
  tabs: { position: TabPosition }
  /** check GitHub for new versions in the background */
  autoUpdate: boolean
}

/** where a tab's folder is in git: its project, the linked worktree it is in (null for the main worktree), its branch */
export interface TabPlace {
  /** key: pathKey of the main worktree's (or bare repository's) path; name: its folder name (acme.git: acme); parent: the folder holding it */
  project: { key: string; name: string; parent: string }
  worktree: { path: string; color: number } | null
  branch: string
}

export interface MainStatus {
  model: { id: string; displayName: string }
  effort: string | null
  context: { usedTokens: number; size: number; usedPct: number } | null
  fiveHour: { usedPct: number; resetsAt: number } | null
  sevenDay: { usedPct: number; resetsAt: number } | null
}

/** background work Claude started (a shell command, a monitor, an agent) that still ran when its turn ended */
export interface BackgroundTask {
  id: string
  /** shell, monitor, agent, …: as Claude Code names it */
  type: string
  description: string | null
  command: string | null
}

export interface AgentStatus {
  agentId: string
  type: string
  description: string | null
  model: string | null
  effort: string | null
  startedAt: number
}

/** a task of the plan Claude is carrying out: finished, being worked on, or still ahead */
export type PlanTaskState = 'done' | 'current' | 'left'
export interface PlanTask { n: number; title: string; state: PlanTaskState }

/** the progress of a superpowers plan, for the status bar */
export interface PlanStatus { title: string; tasks: PlanTask[]; done: number; total: number; finished: boolean }

/** an item of a release's notes: the headline the update banner lists, and the whole item for its tooltip */
export interface ReleaseNote {
  title: string
  text: string
}

/** what changed in one version, as its section of CHANGELOG.md says */
export interface ReleaseNotes {
  version: string
  items: ReleaseNote[]
}

/**
 * `notes`: the versions after the installed one up to the new one, newest first; none when the feed has no notes.
 * ready: downloaded, installed by a restart. available: one this copy cannot install itself, downloaded from its
 * release page (macOS, when the app cannot replace its own bundle).
 */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'ready'; version: string; notes: ReleaseNotes[] }
  | { status: 'available'; version: string; notes: ReleaseNotes[] }

/** the left tab panel's width in px and the folded groups, kept in tab-layout.json */
export interface TabLayout {
  width: number
  /** the keys of the groups the user folded */
  folded: string[]
}

/**
 * The panel's header holds all its buttons in one row (+ and ▾, Changes, Docs, Media, Note and the position) from 220 px
 * on; a narrower panel puts them in two rows (styles.css)
 */
export const TAB_PANEL_WIDTH = { min: 110, max: 480, initial: 240 }

/** the left tab panel's width in whole px, within TAB_PANEL_WIDTH */
export const clampTabPanelWidth = (px: number): number => Math.min(TAB_PANEL_WIDTH.max, Math.max(TAB_PANEL_WIDTH.min, Math.round(px)))

/** the most folded groups tab-layout.json keeps: the groups folded longest ago, likely gone, give way to new ones */
export const MAX_FOLDED_GROUPS = 200

/** a linked worktree's color in the left tab panel: TabPlace.worktree.color is an index into this list */
export const WORKTREE_COLORS = ['#61afef', '#c678dd', '#56b6c2', '#98c379', '#e5c07b', '#be5046']

/** A Claude Code conversation found in Claude Code's transcripts. */
export interface SessionSummary {
  id: string
  cwd: string
  /** the /rename name, else Claude Code's generated title; null when neither is there */
  title: string | null
  firstPrompt: string | null
  lastPrompt: string | null
  /** ms since epoch: when the transcript last changed */
  modifiedAt: number
}

export interface RecentSession extends SessionSummary {
  /** a ClaudeTerm tab is in this conversation */
  open: boolean
  /** the user starred it: the Recent sessions window keeps it on top */
  starred: boolean
}
