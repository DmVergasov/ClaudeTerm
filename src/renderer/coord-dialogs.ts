// The Sessions panel's dialogs for a coordinator: New session starts a Claude tab, Attach… attaches a session of this device or a paired one

import { COORD_NAME_MAX, COORD_TASK_MAX, type CoordResult, type CoordStartRequest } from '../shared/coordinator'
import { el } from './dom'
import { openDialog, type DialogHandle } from './coord-dialog'
import { checkStartForm, folderPlaceholder, startDevices, startError, type AttachChoice, type StartForm } from './sessions-model'

/** a labelled field of the form: its label over its control, then the hint of the field, if any */
function field(id: string, label: string, control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, hint?: string): HTMLElement {
  control.id = id
  return el('div', { className: 'mcp-add-server' },
    el('label', { className: 'mcp-add-label', htmlFor: id, textContent: label }),
    control,
    ...(hint === undefined ? [] : [el('div', { className: 'coord-field-hint', textContent: hint })]))
}

/** the New session dialog: Task, Device (only when a paired device is online), Name, Folder (empty: the coordinator's), Worktree; Start asks main and closes on its yes */
export function openNewSessionDialog(o: { folder: string; project: string; paired: { name: string; online: boolean }[]; start(req: CoordStartRequest): Promise<CoordResult>; late(r: CoordResult): void }): void {
  const task = el('textarea', { className: 'mcp-add-field', name: 'task', placeholder: 'What should the new session do?', maxLength: COORD_TASK_MAX })
  const name = el('input', { className: 'mcp-add-name', name: 'name', type: 'text', placeholder: 'Optional', maxLength: COORD_NAME_MAX, spellcheck: false })
  const folder = el('input', { className: 'mcp-add-name', name: 'folder', type: 'text', placeholder: o.folder, spellcheck: false })
  const worktree = el('input', { className: 'mcp-add-name', name: 'worktree', type: 'text', placeholder: 'Optional', spellcheck: false })
  // the devices offered: this device first, and no choice at all when no paired device is online
  const devices = startDevices(o.paired)
  const device = devices.length === 0 ? null : el('select', { className: 'mcp-add-name', name: 'device' }, ...devices.map((d, i) => el('option', { value: String(i), textContent: d.label })))
  // the device chosen is the device of the option picked; this device when no choice is shown
  const chosenDevice = (): string | null => (device === null ? null : (devices[Number(device.value)]?.device ?? null))
  // the folder's placeholder follows the device chosen: this device's folder, or what an empty folder means on that device
  device?.addEventListener('change', () => {

    folder.placeholder = folderPlaceholder({ project: o.project, device: chosenDevice(), folder: o.folder })
  })
  // once the dialog is closed, a refusal main answers later is told as a toast
  let open = true
  let handle: DialogHandle
  handle = openDialog({
    id: 'new-session',
    title: 'New session',
    body: [
      field('coord-new-task', 'Task', task),
      ...(device === null ? [] : [field('coord-new-device', 'Device', device)]),
      field('coord-new-name', 'Name', name),
      field('coord-new-folder', 'Folder', folder),
      field('coord-new-worktree', 'Worktree', worktree, 'The session first enters a new git worktree of this name.')
    ],
    action: 'Start',
    ready: () => task.value.trim() !== '',
    submit: async () => {
      const form: StartForm = { task: task.value, name: name.value, folder: folder.value, worktree: worktree.value }
      const chosen = chosenDevice()
      // a folder for another device is that device's path: the form does not check it as a full path of this device
      const checked = checkStartForm(form, chosen !== null)
      if (!('req' in checked)) return checked.error
      handle.busy(true, 'Starting…')
      let r: CoordResult
      try {
        r = await o.start({ ...checked.req, device: chosen })
      } catch (e) {
        // a call that rejects is a refusal too: the dialog shows it, or late() tells it when the dialog is closed
        r = { ok: false, error: String(e) }
      }
      if (r.ok) return null
      if (!open) {
        o.late(r)
        return null
      }
      return startError(r)
    },
    closed: () => {
      open = false
    }
  })
}

/** Attach…: a list of the choices; a click attaches, and closes on main's yes */
export function openAttachDialog(o: { choices: AttachChoice[]; attach(tabId: string): Promise<CoordResult> }): void {
  const picks = o.choices.map((c) => {
    const pick = el('button', { className: 'coord-pick', type: 'button' },
      el('span', { className: 'coord-pick-title', textContent: c.title }),
      el('span', { className: 'coord-pick-where', textContent: c.where }),
      ...(c.note === null ? [] : [el('span', { className: 'coord-pick-note', textContent: c.note })]))
    pick.dataset.tabId = c.tabId
    pick.addEventListener('click', () => void attachNow(pick, c.tabId))
    return pick
  })
  const list = picks.length === 0
    ? el('div', { className: 'coord-picks-empty', textContent: 'No other Claude session is running.' })
    : el('div', { className: 'coord-picks' }, ...picks)
  let handle: DialogHandle
  async function attachNow(pick: HTMLButtonElement, tabId: string): Promise<void> {
    // the picks are off before the busy state: the focus leaves the clicked pick, and the dialog keeps the keys (see busy)
    for (const p of picks) p.disabled = true
    handle.busy(true)
    let r: CoordResult
    try {
      r = await o.attach(tabId)
    } catch (e) {
      r = { ok: false, error: String(e) }
    }
    if (r.ok) {
      handle.close()
      return
    }
    handle.error(r.error)
    handle.busy(false)
    for (const p of picks) p.disabled = false
    // after a refusal the keyboard is on the pick that was clicked, which is on again
    pick.focus()
  }
  handle = openDialog({
    id: 'attach',
    title: 'Attach a session',
    body: [el('div', { className: 'coord-dialog-text', textContent: 'Pick a Claude session, on this device or a paired one. It is not told and goes on as it is.' }), list],
    action: null
  })
}
