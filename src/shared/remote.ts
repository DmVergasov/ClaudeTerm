import type { TabView } from './chat'
import type { DevicePlatform } from './devices'
import type { ReviewCounter } from './review'
import type { NotificationCase, TabKind, TabPlace } from './types'

// The shapes of remote tabs: one device's tabs as another device shows them, and the calls and messages that carry them.

/** A tab of a device as the other devices of the group show it. */
export interface RemoteTab {
  id: string
  kind: TabKind
  profile: string
  cwd: string
  customTitle: string | null
  /** the title the program set (OSC), from the device's screen copy */
  title: string | null
  claudeSessionId: string | null
  /** the extra account's id and name on that device; null: its main account */
  account: string | null
  accountName: string | null
  muted: boolean
  exited: boolean
  working: boolean
  /** what the tab waits with ('bell' too); null once it was opened on any device */
  attention: NotificationCase | null
  /** raised by every attention that starts */
  attentionSeq: number
  /** unseen Media cards */
  images: number
  note: boolean
  counter: ReviewCounter | null
  /** statusSummary (Task 5) of a Claude tab's status bar */
  status: string | null
  /** the PTY's size and the device it is sized for; by null: the tab device's own window */
  size: { cols: number; rows: number; by: string | null }
  /** the place the tab's device published for it; null: outside git, or not known yet */
  place: TabPlace | null
  /** whether the device has published the place yet (null included): false until its TabPlaces has answered for the tab */
  placeKnown: boolean
  /** the folder the tab works in on its device now (its cwd until Claude Code reports another) */
  folder: string
  /** the id of the family's head, while that tab is open on the same device; null otherwise */
  forkOf: string | null
  /** the tab is a fork, even after its head closed (its title keeps " (fork)") */
  fork: boolean
  /** the view a Claude tab shows on its device; an older device leaves it out, and null is a shell tab or no view */
  view?: TabView | null
}

export interface RemoteDeviceView {
  id: string
  name: string
  platform: DevicePlatform | null
  online: boolean
}

/** a review part is one of the parts of a review too large for one push; an older device drops the kind. chat: a chat's snapshot; chat-patch: a batch of its patches */
export type PushKind = 'status' | 'plan' | 'review' | 'review-part' | 'images' | 'chat' | 'chat-patch'

export const PUSH_KINDS: readonly PushKind[] = ['status', 'plan', 'review', 'review-part', 'images', 'chat', 'chat-patch']

export interface RemoteSnapshot {
  data: string
  seq: number
  cols: number
  rows: number
}

export interface FolderListing {
  device: string
  path: string
  sep: '/' | '\\'
  parent: string | null
  folders: string[]
  recent: string[]
}

export type FolderResult = { ok: true; listing: FolderListing } | { ok: false; error: string }

export interface DeviceChoices {
  profiles: string[]
  accounts: { id: string; name: string }[]
}

/** what a device last answered; value null: it has not answered yet (the UI shows REMOTE_COPY.loading) */
export interface DeviceAnswer<T> {
  device: string
  name: string
  value: T | null
}

export const MAX_REMOTE_TABS = 256
export const MAX_OUT_CHARS = 256 * 1024
export const MAX_INPUT_CHARS = 1024 * 1024

export const CALL_TIMEOUT_MS = 10_000
export const ATTACH_TIMEOUT_MS = 15_000
export const LIST_TIMEOUT_MS = 3_000
export const REATTACH_MS = 1_000

/** the JSON-encoded size of a snapshot's text */
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
export const DETACH_BACKLOG_BYTES = 4 * 1024 * 1024

export const MAX_TRANSFER_BYTES = 50 * 1024 * 1024
export const MAX_TRANSFER_FILES = 100
export const TRANSFER_PART_BYTES = 1024 * 1024

/** a review push over this many bytes of JSON goes in parts of at most this size, so that no message holds up a device */
export const REVIEW_PART_BYTES = 2 * 1024 * 1024
/** the most encoded bytes one file of a review keeps: a bigger file keeps its header, and its lines are not shown on another device */
export const REVIEW_FILE_BYTES = REVIEW_PART_BYTES - 64 * 1024
export const MAX_REVIEW_PARTS = 16

/** the JSON size of one chat push: a snapshot keeps its newest items that fit, and a batch over it is replaced by a snapshot */
export const MAX_CHAT_PUSH_BYTES = 2 * 1024 * 1024

export const IMAGE_PART_BYTES = 4 * 1024 * 1024
export const IMAGE_CACHE_BYTES = 64 * 1024 * 1024
/** the image part calls out at once to one device: the other reads wait their turn in RemoteActions */
export const IMAGE_READS_AT_ONCE = 2
/** the time limit of one image part call: a part is up to 5.6 MiB on a slow link, and may wait behind the device's bulk */
export const IMAGE_PART_TIMEOUT_MS = 30_000

export const AWAKE_INPUT_MS = 30 * 60 * 1000
export const COPY_TOAST_MS = 1_000

export const MAX_FOLDER_ENTRIES = 500
export const RECENT_FOLDER_COUNT = 10
export const MAX_PATH_TEXT = 4096
/** the text typed for the files of a transfer: each path quoted in full by bash or zsh (each ' is written as '\'', 4 characters), with its outer quotes and its space */
export const MAX_TYPED_TEXT = MAX_TRANSFER_FILES * (4 * MAX_PATH_TEXT + 3)

export const DEVICE_COLORS = ['#e8a33d', '#4fa3e0', '#9b7be8', '#4cbf8a', '#e86b6b', '#d97bc4', '#c9c14a', '#5fc4c4'] as const

const DEVICE_HEAD_RE = /^[0-9a-f]{8}$/i

/** the same colour for a device everywhere: DEVICE_COLORS[parseInt(first 8 hex digits of the id, 16) % 8]; DEVICE_COLORS[0] when they are not hex */
export function deviceColor(id: string): string {
  const head = id.slice(0, 8)
  if (!DEVICE_HEAD_RE.test(head)) return DEVICE_COLORS[0]
  return DEVICE_COLORS[parseInt(head, 16) % 8]
}

export const REMOTE_COPY = {
  offline: '· offline',
  tabTooltip: (title: string, device: string, folder: string) => `${title}\n${device}: ${folder}`,
  newClaudeTab: 'New Claude Code tab',
  newProfileTab: (profile: string) => `New ${profile} tab`,
  newTabOn: (device: string) => `New tab on ${device}`,
  fold: 'Fold',
  unfold: 'Unfold',
  loading: 'Loading…',
  changeFolder: 'Change folder…',
  changeFolderTitle: 'Change folder',
  changeFolderOn: (device: string) => `Change folder on ${device}`,
  recentOn: (device: string) => `Recent on ${device}`,
  openHere: 'Open here',
  cancel: 'Cancel',
  folderMissing: 'This folder does not exist',
  folderUnreadable: 'This folder cannot be read',
  folderNotAbsolute: 'Enter the full path of a folder',
  folderChangeFailed: 'The folder could not be changed',
  copying: (device: string) => `Copying to ${device}…`,
  copyTooLarge: (device: string) => `Too large to copy to ${device}: at most 50 MB at a time`,
  copyFailed: (device: string, error: string) => `Could not copy to ${device}: ${error}`,
  imageUnavailable: 'The image could not be read from its device',
  deviceOffline: (device: string) => `${device} is not connected`,
  noAnswer: (device: string) => `${device} did not answer`,
  unknownTab: 'That tab is not open on this device',
  unknownSession: 'That session is not listed on this device',
  openTabFailed: 'The tab could not be opened',
  clearTaskListFailed: 'The task list could not be cleared',
  forkFailed: 'Cannot fork the session',
  tabCount: (n: number) => (n === 0 ? 'No tabs open' : n === 1 ? '1 tab open' : `${n} tabs open`),
  keepAwake: 'Keep this computer awake while another device uses it',
  copyReadFailed: 'A file could not be read to copy it',
  copyTooManyFiles: 'At most 100 files can be copied at a time',
  receiveUnsafe: 'The folder for received files is not safe to use',
  receiveBusy: 'Too many transfers are arriving at once: try again shortly',
  receiveTooLarge: 'Too large to copy: at most 50 MB at a time',
  receiveUnknown: 'That transfer is not open on this device',
  receiveTimedOut: 'The transfer took too long and was stopped',
  receiveFailed: 'The files could not be saved on this device'
} as const
