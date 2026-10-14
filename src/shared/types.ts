export type TabKind = 'claude' | 'shell'
export type ShellFamily = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish' | 'wsl' | 'other'

export interface ProfileDef {
  name: string
  command: string
  args: string[]
}

export interface TabInfo {
  id: string
  kind: TabKind
  profile: string
  cwd: string
  customTitle: string | null
  claudeSessionId: string | null
  exited: boolean
}

export interface OpenTabRequest {
  kind: TabKind
  cwd: string
  profile?: string | null
  title?: string | null
  resumeSessionId?: string | null
}

export type ImageSource = 'created' | 'shown' | 'read' | 'tool' | 'pasted'

export interface ImageCard {
  id: string
  tabId: string
  path: string
  name: string
  relPath: string
  source: ImageSource
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
}

export interface SessionSnapshot {
  version: 1
  savedAt: string
  tabs: SessionSnapshotTab[]
}

export type NotificationCase = 'permission' | 'question' | 'done' | 'bell'

export interface NotificationChannels {
  sound: boolean
  /** flash the taskbar button when the window is not focused */
  flash: boolean
  /** mark the tab when it is not the active one */
  tab: boolean
}

/** sound: 'system' or an absolute path to a .wav file; then the signals each case gives */
export type NotificationSettings = { sound: string } & Record<NotificationCase, NotificationChannels>

/**
 * How the side panel sits by the terminal: beside it in a window widened for it, or, when the window had no room, over the
 * terminal's right side or narrowing it.
 */
export type PanelMode = 'beside' | 'overlay' | 'narrow'

export type NoRoomMode = Exclude<PanelMode, 'beside'>

export interface Settings {
  defaultProfile: string | null
  claude: { command: string; shellProfile: string | null }
  profiles: ProfileDef[]
  font: { family: string; size: number }
  theme: string | Record<string, string>
  scrollback: number
  imageWatch: { enabled: boolean; extensions: string[]; ignore: string[]; maxDepth: number }
  imagePanel: { autoOpen: boolean; width: number; maxItems: number }
  notifications: NotificationSettings
  /** the Changes panel */
  review: { editor: string | null; statusBar: boolean; hideIgnored: boolean; hideTests: boolean; testPatterns: string[]; width: number; fileTree: boolean }
  /** where Images and Changes go when the window has no room to widen for them */
  sidePanel: { noRoom: NoRoomMode }
  /** check GitHub for new versions in the background */
  autoUpdate: boolean
}

export interface MainStatus {
  model: { id: string; displayName: string }
  effort: string | null
  context: { usedTokens: number; size: number; usedPct: number } | null
  fiveHour: { usedPct: number; resetsAt: number } | null
  sevenDay: { usedPct: number; resetsAt: number } | null
}

export interface AgentStatus {
  agentId: string
  type: string
  description: string | null
  model: string | null
  effort: string | null
  startedAt: number
}

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

/** `notes`: the versions after the installed one up to the downloaded one, newest first; none when the feed has no notes */
export type UpdateState = { status: 'idle' } | { status: 'ready'; version: string; notes: ReleaseNotes[] }

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
