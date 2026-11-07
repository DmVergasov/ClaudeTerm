/** The operating systems a paired device can report about itself. */
export type DevicePlatform = 'windows' | 'macos' | 'linux'

export const DEVICE_PLATFORMS: readonly DevicePlatform[] = ['windows', 'macos', 'linux']

/** The longest device name a peer may announce, in characters. */
export const MAX_DEVICE_NAME = 64

/** The longest address a peer may announce, in characters. */
export const MAX_ADDRESS_LENGTH = 255

/** The port devices listen on unless settings.json says otherwise. */
export const DEFAULT_DEVICE_PORT = 47821

/** How long a pairing code is valid, in milliseconds. */
export const PAIR_CODE_TTL_MS = 300_000

/** How many wrong proofs cancel a pairing code. */
export const MAX_PAIR_FAILURES = 5

/** What a device is doing with one other device of the group. */
export type DeviceState =
  | { kind: 'connected' }
  | { kind: 'unreachable'; address: string }
  | { kind: 'offline'; since: number }
  | { kind: 'unknown' }

/** A pairing code being shown: the code, the addresses to type on the other device, and when the code runs out. */
export interface PairingView {
  code: string
  addresses: string[]
  port: number
  expiresAt: number
}

export type DeviceResult = { ok: true } | { ok: false; error: string }

/** Every UI string of device sync, in English, as the Settings window shows it. */
export const DEVICE_COPY = {
  section: 'Devices',
  connected: 'Connected',
  unreachable: (address: string) => `Not reachable at ${address}`,
  offline: (time: string) => `Offline since ${time}`,
  notTried: 'Not connected yet',
  addedBy: (name: string, date: string) => `Added by ${name}, ${date}`,
  removedBy: (name: string) => `Removed from the group by ${name}`,
  pairingHint: 'Enter this code on the other device, together with one of these addresses:',
  validFor: (left: string) => `Valid for ${left}`,
  joinNoAnswer: 'The address does not answer',
  joinBadCode: 'The code is wrong or has expired',
  joinNoCode: 'The other device is not showing a code',
  joinNotProved: 'The other device could not prove the code',
  unreachableByOthers: 'The other devices cannot connect to this one; to pair, show the code on the other device',
  leaveNeedsConnection: 'Leave needs another device connected, so that the group hears of it. A computer that is gone for good is removed from another device instead.',
  keyringMissing: 'No system keyring: this device\'s key is stored unencrypted, readable only by your user.',
  portInUse: (port: number) => `Port ${port} is in use by another program; set another devices.port in settings.json`,
  badAddress: 'Not an address: a name like macbook or an IP address, optionally with :port',
  badName: 'A name of 1 to 64 characters',
  unknownDevice: 'That device is not in the group',
  disabled: 'Device sync is off',
  syncStopped: 'Device sync stopped after an error; restart ClaudeTerm to try again'
} as const

/** A paired device as the Settings window lists it. */
export interface DeviceView {
  id: string
  name: string
  /** null while the device has not described itself yet */
  platform: DevicePlatform | null
  state: DeviceState
  /** the name of the device that paired it into the group */
  addedBy: string
  addedAt: number
  /** the address typed on this device for it, when one was typed */
  address: string | null
  /** the tabs of this device that this window lists, when the device is connected; absent otherwise */
  tabs?: number
}

/** The device sync section of the Settings window while device sync is on. */
export interface ActiveDevicesView {
  enabled: true
  self: { id: string; name: string; addresses: string[]; port: number | null }
  devices: DeviceView[]
  pairing: PairingView | null
  /** every device that reports on this one says it cannot reach it, and none says it can */
  unreachableByOthers: boolean
  /** the name of the device that removed this one, when it was removed */
  removedBy: string | null
  problem: string | null
  /** whether the private key is kept in the system keyring */
  keyring: boolean
  /** whether a device of the group is connected, so that this one can leave */
  canLeave: boolean
}

export type DevicesView = { enabled: false } | ActiveDevicesView

/** How long a device that removed another keeps its listener open after its latest removal, in milliseconds: a removed device hears of it when it next connects. */
export const REMOVAL_NOTICE_MS = 7 * 24 * 60 * 60 * 1000
