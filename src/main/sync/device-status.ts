import { DEVICE_COPY, MAX_ADDRESS_LENGTH, type ActiveDevicesView, type DeviceState, type DeviceView } from '../../shared/devices'
import type { RemoteTab } from '../../shared/remote'

// The text of device_status: what Claude reads of device sync. Device names and tab titles come from other devices and
// go into Claude's conversation, so every name, title and folder is cleaned and cut here, and the whole text is bounded.

/** the most characters a name or a title keeps, and a folder, a problem */
const MAX_NAME = 100
const MAX_FOLDER = 300
const MAX_PROBLEM = 300
/** the most tabs of one device the text lists */
const MAX_TABS = 50
/** the text stays under this many characters; the last line says where it stopped */
const MAX_TEXT = 16_000
const CUT_LINE = '… (cut)'
const NOT_SET_UP = 'Device sync is not set up: in Settings → Devices, show a code or join a device.'
const NO_TABS = '  (none)'
const NO_NAME = '(no name)'
const PLATFORM_NAMES = { windows: 'Windows', macos: 'macOS', linux: 'Linux' } as const

/** the C0 and C1 control characters, the line and paragraph separators, the bidi controls (the Arabic letter mark too) and the zero-width characters (the word joiner and the invisible operators too) */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2064\u2066-\u2069\ufeff]/g

/** what device_status reads of this device and the others */
export interface DeviceStatusSource {
  view: ActiveDevicesView | null
  selfTabs: RemoteTab[]
  /** the tabs of a connected device; null when it is not connected now */
  tabsOf(device: string): RemoteTab[] | null
}

/** a device as its line reads it: its id for the tab call, its cleaned name, whether it is connected, and its line */
interface DeviceEntry {
  id: string
  name: string
  /** the platform as the device line shows it, in brackets, or an empty text when it is not known */
  platform: string
  connected: boolean
  head: string
}

export function formatDeviceStatus(s: DeviceStatusSource): string {
  const v = s.view
  if (!v) return NOT_SET_UP
  return fit(statusLines(v, s))
}

/**
 * The lines in the order the cut keeps them: this device, every device's state, this device's tabs, then each connected
 * device's tabs. The cut works from the end, so the tabs go before a device line does. Built lazily: nothing past the
 * budget is read.
 */
function* statusLines(v: ActiveDevicesView, s: DeviceStatusSource): Generator<string> {
  yield selfLine(v)
  if (v.unreachableByOthers) yield 'The other devices cannot connect to this one.'
  if (v.problem) yield `Problem: ${cut(plain(v.problem), MAX_PROBLEM)}`
  if (v.removedBy) yield `${DEVICE_COPY.removedBy(nameText(v.removedBy))}.`
  if (v.pairing) yield 'A pairing code is shown.'
  yield 'Devices:'
  const devices = v.devices.flatMap((d) => {
    const entry = attempt(() => entryOf(d), null)
    return entry ? [entry] : []
  })
  if (devices.length === 0) yield NO_TABS
  for (const e of devices) yield e.head
  yield 'Tabs of this device:'
  yield* attempt(() => tabLines(s.selfTabs), ['  tabs could not be read'])
  for (const e of devices) {
    if (!e.connected) continue
    yield `Tabs of ${e.name}${e.platform}:`
    yield* tabSection(e.id, s.tabsOf)
  }
}

function selfLine(v: ActiveDevicesView): string {
  const port = v.self.port === null ? 'not listening' : `port ${v.self.port}`
  return `This device: ${nameText(v.self.name)} (${port}).`
}

function entryOf(d: DeviceView): DeviceEntry {
  const name = nameText(d.name)
  const platform = d.platform ? ` (${PLATFORM_NAMES[d.platform]})` : ''
  return { id: d.id, name, platform, connected: d.state.kind === 'connected', head: `${name}${platform}: ${stateText(d.state)}` }
}

function stateText(state: DeviceState): string {
  switch (state.kind) {
    case 'connected': return DEVICE_COPY.connected
    case 'unreachable': return DEVICE_COPY.unreachable(cut(plain(state.address), MAX_ADDRESS_LENGTH))
    case 'offline': return DEVICE_COPY.offline(timeText(state.since))
    default: return DEVICE_COPY.notTried
  }
}

function timeText(since: number): string {
  const when = new Date(since)
  return Number.isNaN(when.getTime()) ? 'an unknown time' : when.toISOString()
}

/** the tabs of one connected device: a device whose list cannot be read says so, and the rest of the answer goes on */
function* tabSection(device: string, tabsOf: DeviceStatusSource['tabsOf']): Generator<string> {
  let tabs: RemoteTab[] | null | undefined
  try {
    tabs = tabsOf(device)
  } catch {
    tabs = undefined
  }
  if (tabs === undefined) {
    yield '  tabs could not be read'
    return
  }
  if (tabs === null) {
    yield '  tabs not listed now'
    return
  }
  yield* attempt(() => tabLines(tabs as RemoteTab[]), ['  tabs could not be read'])
}

/** the tabs as lines; a tab that cannot be read is left out, and the rest of the list is kept */
function tabLines(tabs: RemoteTab[]): string[] {
  if (tabs.length === 0) return [NO_TABS]
  const lines: string[] = []
  for (const t of tabs.slice(0, MAX_TABS)) {
    const line = attempt(() => tabText(t), null)
    if (line !== null) lines.push(`  ${line}`)
  }
  if (tabs.length > MAX_TABS) lines.push(`  … and ${tabs.length - MAX_TABS} more tabs`)
  return lines
}

function tabText(t: RemoteTab): string {
  const what = [t.kind === 'claude' ? 'Claude' : 'shell']
  if (t.working) what.push('working')
  // a turn another session of the device ended reads as such: "peer" alone says nothing to the reader
  if (t.attention) what.push(`waiting: ${t.attention === 'peer' ? "another session's turn ended" : t.attention}`)
  return `"${tabNameOf(t)}" (${what.join(', ')}) in ${cut(plain(t.folder), MAX_FOLDER)}`
}

/** the name the tab bar shows: the renamed title, else the program's title, else the folder's last part; a double quote becomes a single one */
function tabNameOf(t: RemoteTab): string {
  for (const candidate of [t.customTitle, t.title]) {
    if (!candidate) continue
    const name = noDoubleQuote(cut(plain(candidate), MAX_NAME))
    if (name !== '') return name
  }
  return noDoubleQuote(cut(lastPart(plain(t.folder)), MAX_NAME)) || NO_NAME
}

/** a name of this device or of a device, cleaned and cut; NO_NAME when nothing is left */
function nameText(text: string): string {
  return cut(plain(text), MAX_NAME) || NO_NAME
}

/** the folder's last part, as the tab bar reads it (the same rule as the renderer's folderName) */
function lastPart(folder: string): string {
  const parts = folder.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || folder
}

function plain(text: string): string {
  return text.replace(CONTROL_RE, '')
}

function noDoubleQuote(text: string): string {
  return text.replace(/"/g, "'")
}

/** the text cut to `max` characters with an ellipsis, never through a surrogate pair */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max - 1
  const before = text.charCodeAt(end - 1)
  if (before >= 0xd800 && before <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}

/** what a piece of the answer needs in order to be left out when it cannot be read */
function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/** the lines joined in order, stopping before the limit with the cut line as the last one */
function fit(lines: Iterable<string>): string {
  let out = ''
  for (const line of lines) {
    const next = out === '' ? line : `${out}\n${line}`
    if (next.length + 1 + CUT_LINE.length >= MAX_TEXT) return out === '' ? CUT_LINE : `${out}\n${CUT_LINE}`
    out = next
  }
  return out
}
