export type TabKind = 'claude' | 'shell'
export type ShellFamily = 'powershell' | 'cmd' | 'bash' | 'wsl' | 'other'

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

export interface Settings {
  defaultProfile: string | null
  claude: { command: string; shellProfile: string | null }
  profiles: ProfileDef[]
  font: { family: string; size: number }
  theme: string | Record<string, string>
  scrollback: number
  imageWatch: { enabled: boolean; extensions: string[]; ignore: string[]; maxDepth: number }
  imagePanel: { autoOpen: boolean; width: number; maxItems: number }
  /** sound: 'system', 'none' or an absolute path to a .wav file */
  attention: { sound: string; flash: boolean }
  /** check GitHub for new versions in the background */
  autoUpdate: boolean
}

export interface MainStatus {
  model: { id: string; displayName: string }
  effort: string | null
  context: { usedTokens: number; size: number; usedPct: number } | null
  fiveHour: { usedPct: number; resetsAt: number } | null
}

export interface AgentStatus {
  agentId: string
  type: string
  description: string | null
  model: string | null
  effort: string | null
  startedAt: number
}

export type UpdateState = { status: 'idle' } | { status: 'ready'; version: string }
