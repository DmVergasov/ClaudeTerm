import {
  DEVICE_COPY,
  type DevicePlatform,
  type DeviceState,
  type DeviceView,
  type DevicesView,
  type PairingView
} from '../shared/devices'
import { REMOTE_COPY } from '../shared/remote'
import { el, section } from './dom'

const ct = window.ct

/** labels of the Devices section that DEVICE_COPY does not hold */
const LABEL = {
  thisDevice: 'This device',
  joinHeading: 'Join a device',
  nameOfThisDevice: 'Name of this device'
}

const PLATFORM_NAMES: Record<DevicePlatform, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' }

/** an error line under a form */
function errorLine(): { line: HTMLElement; show(m: string | null): void } {
  const line = el('div', { className: 'field-error', hidden: true })
  return {
    line,
    show: (m) => {
      line.hidden = m === null
      line.textContent = m ?? ''
    }
  }
}

/** an address as another device types it: an IPv6 address goes in brackets before the port */
function withPort(address: string, port: number): string {
  return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`
}

/** the time left as m:ss, rounded up: a new code shows 5:00 and the last second shows 0:01 */
function clockText(ms: number): string {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** when a device went away: the time alone when it was today, the date and the time otherwise */
function offlineText(since: number): string {
  const d = new Date(since)
  const today = d.toDateString() === new Date().toDateString()
  return DEVICE_COPY.offline(today ? d.toLocaleTimeString() : d.toLocaleString())
}

function stateText(s: DeviceState): string {
  switch (s.kind) {
    case 'connected': return DEVICE_COPY.connected
    case 'unreachable': return DEVICE_COPY.unreachable(s.address)
    case 'offline': return offlineText(s.since)
    case 'unknown': return DEVICE_COPY.notTried
  }
}

interface Row {
  el: HTMLElement
  update(d: DeviceView): void
}

/** one device of the group: its state, its address (saved on Enter or when the field loses focus) and Remove, which asks first */
function deviceRow(id: string): Row {
  let shown: DeviceView | null = null
  const row = el('div', { className: 'device-row' })
  const nameText = el('span', { className: 'device-name' })
  const system = el('span', { className: 'hint' })
  const state = el('span', { className: 'device-state' })
  const tabs = el('span', { className: 'hint' })
  const added = el('div', { className: 'hint' })
  const address = el('input', { type: 'text', spellcheck: false, className: 'text-input device-address' })
  const err = errorLine()
  const question = el('span', { className: 'device-question' })
  const removeBtn = el('button', { type: 'button', textContent: 'Remove' })
  const confirmBtn = el('button', { type: 'button', textContent: 'Remove' })
  const cancelBtn = el('button', { type: 'button', textContent: 'Cancel' })
  const actions = el('span', { className: 'device-actions' }, removeBtn)

  /** saves the typed address; when refused, the field keeps what is typed if `keep`, else the saved address comes back */
  // the last value sent: the blur that follows an Enter which saved it sends nothing; a refused value may be sent again
  let sent: string | null = null
  const save = async (keep: boolean): Promise<void> => {
    const typed = address.value.trim()
    if (typed === (shown?.address ?? '')) {
      err.show(null)
      return
    }
    if (typed === sent) return
    sent = typed
    const r = await ct.setDeviceAddress(id, typed === '' ? null : typed)
    if (!r.ok) sent = null
    err.show(r.ok ? null : r.error)
    if (!r.ok && !keep) address.value = shown?.address ?? ''
  }
  address.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void save(true)
    // Escape cancels the edit; it must not reach the window, which it would close
    if (e.key === 'Escape') {
      e.stopPropagation()
      address.value = shown?.address ?? ''
      err.show(null)
      address.blur()
    }
  })
  address.addEventListener('blur', () => void save(false))

  removeBtn.addEventListener('click', () => {
    question.textContent = `Remove ${shown?.name ?? ''}?`
    actions.replaceChildren(question, confirmBtn, cancelBtn)
  })
  cancelBtn.addEventListener('click', () => actions.replaceChildren(removeBtn))
  confirmBtn.addEventListener('click', () => void ct.removeDevice(id).then((r) => {
    // on success the view drops the row
    if (!r.ok) {
      err.show(r.error)
      actions.replaceChildren(removeBtn)
    }
  }))

  row.replaceChildren(
    el('div', { className: 'device-top' }, nameText, system, state, tabs),
    added,
    el('div', { className: 'device-line' }, address, actions),
    err.line
  )

  const update = (d: DeviceView): void => {
    shown = d
    nameText.textContent = d.name
    system.textContent = d.platform === null ? '' : PLATFORM_NAMES[d.platform]
    system.hidden = d.platform === null
    state.textContent = stateText(d.state)
    state.className = `device-state ${d.state.kind}`
    // the tab count is shown only for a connected device; a device that is gone shows none
    tabs.textContent = d.tabs === undefined ? '' : REMOTE_COPY.tabCount(d.tabs)
    tabs.hidden = d.tabs === undefined
    added.textContent = DEVICE_COPY.addedBy(d.addedBy, new Date(d.addedAt).toLocaleDateString())
    address.setAttribute('aria-label', `Address of ${d.name}`)
    // the address being typed keeps what is typed; a field the view replaces starts over with nothing sent
    if (document.activeElement !== address) {
      address.value = d.address ?? ''
      sent = null
    }
  }
  return { el: row, update }
}

/** Settings → Devices: this device's name and addresses, the devices of the group, Add a device and Join a device. `extra` is shown while the device is in a group */
export function devicesSection(extra: HTMLElement[] = []): HTMLElement {
  const removedNote = el('div', { className: 'device-notice', hidden: true })
  const unreachableNote = el('div', { className: 'device-notice', hidden: true, textContent: DEVICE_COPY.unreachableByOthers })
  const problemNote = el('div', { className: 'device-notice', hidden: true })
  const keyringNote = el('div', { className: 'device-notice', hidden: true, textContent: DEVICE_COPY.keyringMissing })

  // this device: its name is saved on Enter or when the field loses focus; a refused name goes back to the name in use
  // no maxLength: a name too long is refused by the group, and the refusal shows under the field
  const nameInput = el('input', { type: 'text', spellcheck: false, className: 'text-input' })
  nameInput.setAttribute('aria-label', LABEL.nameOfThisDevice)
  const nameErr = errorLine()
  const addresses = el('span', { className: 'hint' })
  // Leave is final for this device's group, so it asks first, as Remove does
  const leave = el('button', { type: 'button', textContent: 'Leave the group' })
  const leaveQuestion = el('span', { className: 'device-question', textContent: 'Leave the group?' })
  const leaveYes = el('button', { type: 'button', textContent: 'Leave' })
  const leaveNo = el('button', { type: 'button', textContent: 'Cancel' })
  const leaveActions = el('span', { className: 'device-actions' }, leave)
  const leaveHint = el('div', { className: 'hint', textContent: DEVICE_COPY.leaveNeedsConnection, hidden: true })
  const leaveErr = errorLine()
  leave.addEventListener('click', () => leaveActions.replaceChildren(leaveQuestion, leaveYes, leaveNo))
  leaveNo.addEventListener('click', () => leaveActions.replaceChildren(leave))
  leaveYes.addEventListener('click', () => void ct.leaveDeviceGroup().then((r) => {
    // on success the view drops the group
    if (!r.ok) {
      leaveErr.show(r.error)
      leaveActions.replaceChildren(leave)
    }
  }))
  let selfName = ''
  // the last name sent: the blur that follows an Enter which saved it sends nothing; a refused name may be sent again
  let sentName: string | null = null
  // keep: a refused name stays in the field (Enter); otherwise the name in use comes back (blur). A refusal that comes after
  // the field lost focus goes back too: nobody is typing into it any more
  const saveName = (keep: boolean): void => {
    const typed = nameInput.value.trim()
    if (typed === selfName) {
      nameErr.show(null)
      return
    }
    if (typed === sentName) return
    sentName = typed
    void ct.renameThisDevice(typed).then((r) => {
      if (!r.ok) sentName = null
      nameErr.show(r.ok ? null : r.error)
      if (!r.ok && (!keep || document.activeElement !== nameInput)) nameInput.value = selfName
    })
  }
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveName(true)
    // Escape cancels the edit; it must not reach the window, which it would close
    if (e.key === 'Escape') {
      e.stopPropagation()
      nameInput.value = selfName
      nameErr.show(null)
      nameInput.blur()
    }
  })
  nameInput.addEventListener('blur', () => saveName(false))
  const self = el('div', { className: 'device-self' },
    el('div', { className: 'device-subhead', textContent: LABEL.thisDevice }),
    el('div', { className: 'device-line' }, nameInput, addresses),
    nameErr.line,
    el('div', { className: 'device-line' }, leaveActions),
    leaveHint,
    leaveErr.line)

  // the devices of the group, one row each; a row is kept while its device stays, so what is typed in it stays
  const rows = new Map<string, Row>()
  const list = el('div', { className: 'device-list' })
  // the settings that only mean something in a group: shown while this device is in one
  const groupOnly = el('div', { hidden: true }, ...extra)
  const syncRows = (devices: DeviceView[]): void => {
    const keep = list.contains(document.activeElement) ? document.activeElement : null
    const ids = new Set(devices.map((d) => d.id))
    for (const id of [...rows.keys()]) if (!ids.has(id)) rows.delete(id)
    const next = devices.map((d) => {
      const row = rows.get(d.id) ?? deviceRow(d.id)
      rows.set(d.id, row)
      row.update(d)
      return row.el
    })
    if (next.length !== list.children.length || next.some((n, i) => list.children[i] !== n)) {
      list.replaceChildren(...next)
      // moving a row takes the focus away: it goes back to the field that had it
      if (keep instanceof HTMLElement) keep.focus()
    }
  }

  // the code being shown: a countdown that runs only while a code is on screen
  const pairing = el('div', { className: 'device-pairing', hidden: true })
  let pairingKey = ''
  let timer: number | undefined
  const stopCountdown = (): void => {
    window.clearInterval(timer)
    timer = undefined
  }
  window.addEventListener('pagehide', stopCountdown)
  const showPairing = (p: PairingView | null): void => {
    const key = p === null ? '' : `${p.code}|${p.expiresAt}|${p.port}|${p.addresses.join(' ')}`
    if (key === pairingKey) return
    pairingKey = key
    stopCountdown()
    pairing.replaceChildren()
    pairing.hidden = p === null
    if (p === null) return
    const left = el('div', { className: 'hint' })
    const tick = (): void => {
      const ms = p.expiresAt - Date.now()
      left.textContent = DEVICE_COPY.validFor(clockText(Math.max(ms, 0)))
      if (ms <= 0) stopCountdown()
    }
    const cancel = el('button', { type: 'button', textContent: 'Cancel' })
    cancel.addEventListener('click', () => {
      ct.cancelDevicePairing()
      refresh()
    })
    pairing.append(
      el('div', { className: 'hint', textContent: DEVICE_COPY.pairingHint }),
      el('div', { className: 'device-code', textContent: p.code }),
      el('div', { className: 'device-addresses' }, ...p.addresses.map((a) => el('div', { textContent: withPort(a, p.port) }))),
      left,
      cancel
    )
    tick()
    timer = window.setInterval(tick, 1000)
  }
  const add = el('button', { type: 'button', textContent: 'Add a device' })
  add.addEventListener('click', () => void ct.startDevicePairing().then(render))

  // join a device: the group opens with it, so the form works without a group too
  const joinAddress = el('input', { type: 'text', spellcheck: false, className: 'text-input', placeholder: 'Address' })
  const joinCode = el('input', { type: 'text', spellcheck: false, autocomplete: 'off', className: 'text-input device-code-input', placeholder: 'Code' })
  const join = el('button', { type: 'button', textContent: 'Join' })
  const joinErr = errorLine()
  const submitJoin = (): void => {
    const address = joinAddress.value.trim()
    const code = joinCode.value.trim()
    if (address === '') {
      joinErr.show(DEVICE_COPY.badAddress)
      return
    }
    if (code === '') {
      joinErr.show(DEVICE_COPY.joinBadCode)
      return
    }
    void ct.joinDevice(address, code).then((r) => {
      joinErr.show(r.ok ? null : r.error)
      if (r.ok) {
        joinAddress.value = ''
        joinCode.value = ''
      }
    })
  }
  join.addEventListener('click', submitJoin)
  for (const input of [joinAddress, joinCode]) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitJoin() })
  const joinBox = el('div', { className: 'device-join' },
    el('div', { className: 'device-subhead', textContent: LABEL.joinHeading }),
    el('div', { className: 'device-line' }, joinAddress, joinCode, join),
    joinErr.line)

  function render(v: DevicesView): void {
    if (!v.enabled) {
      self.hidden = true
      for (const n of [removedNote, unreachableNote, problemNote, keyringNote]) n.hidden = true
      syncRows([])
      showPairing(null)
      add.hidden = false
      groupOnly.hidden = true
      return
    }
    self.hidden = false
    groupOnly.hidden = false
    selfName = v.self.name
    // the name being typed keeps what is typed
    if (document.activeElement !== nameInput) {
      nameInput.value = v.self.name
      sentName = null
    }
    const port = v.self.port
    addresses.textContent = v.self.addresses.map((a) => (port === null ? a : withPort(a, port))).join(', ')
    leave.disabled = !v.canLeave
    leaveHint.hidden = v.canLeave
    // a question left open when nothing is connected any more goes back to the button
    if (!v.canLeave) leaveActions.replaceChildren(leave)
    syncRows(v.devices)
    removedNote.hidden = v.removedBy === null
    removedNote.textContent = v.removedBy === null ? '' : DEVICE_COPY.removedBy(v.removedBy)
    unreachableNote.hidden = !v.unreachableByOthers
    problemNote.hidden = v.problem === null
    problemNote.textContent = v.problem ?? ''
    keyringNote.hidden = v.keyring
    showPairing(v.pairing)
    add.hidden = v.pairing !== null
  }

  // a reply to getDevicesView is drawn only when no view arrived since it was asked for: a newer view is not overwritten by an older reply
  let views = 0
  const refresh = (): void => {
    const asked = views
    void ct.getDevicesView().then((v) => {
      if (views === asked) render(v)
    })
  }
  ct.onDevices((v) => {
    views++
    render(v)
  })
  refresh()
  // the order on the page: notices, this device, the devices, the group's settings, Add a device with its code, then Join a device
  const root = section(DEVICE_COPY.section, null,
    removedNote, unreachableNote, problemNote, keyringNote,
    self,
    list,
    groupOnly,
    add,
    pairing,
    joinBox)
  // the section a Settings window opens at (open_device_settings, or #devices)
  root.id = 'devices'
  return root
}
