// The Sessions panel's dialogs for a coordinator: New session starts a Claude tab, Attach… attaches a session of this device

import { COORD_NAME_MAX, COORD_TASK_MAX, type CoordResult, type CoordStartRequest } from '../shared/coordinator'
import { el } from './dom'
import { openDialog, type DialogHandle } from './coord-dialog'
import { checkStartForm, startError, type AttachChoice, type StartForm } from './sessions-model'

/** a labelled field of the form: its label over its control, then the hint of the field, if any */
function field(id: string, label: string, control: HTMLInputElement | HTMLTextAreaElement, hint?: string): HTMLElement {
  control.id = id
  return el('div', { className: 'mcp-add-server' },
    el('label', { className: 'mcp-add-label', htmlFor: id, textContent: label }),
    control,
    ...(hint === undefined ? [] : [el('div', { className: 'coord-field-hint', textContent: hint })]))
}

/** the New session dialog: Task, Name, Folder (empty: the coordinator's), Worktree; Start asks main and closes on its yes */
export function openNewSessionDialog(o: { folder: string; start(req: CoordStartRequest): Promise<CoordResult>; late(r: CoordResult): void }): void {
  const task = el('textarea', { className: 'mcp-add-field', name: 'task', placeholder: 'What should the new session do?', maxLength: COORD_TASK_MAX })
  const name = el('input', { className: 'mcp-add-name', name: 'name', type: 'text', placeholder: 'Optional', maxLength: COORD_NAME_MAX, spellcheck: false })
  const folder = el('input', { className: 'mcp-add-name', name: 'folder', type: 'text', placeholder: o.folder, spellcheck: false })
  const worktree = el('input', { className: 'mcp-add-name', name: 'worktree', type: 'text', placeholder: 'Optional', spellcheck: false })
  // once the dialog is closed, a refusal main answers later is told as a toast
  let open = true
  let handle: DialogHandle
  handle = openDialog({
    id: 'new-session',
    title: 'New session',
    body: [
      field('coord-new-task', 'Task', task),
      field('coord-new-name', 'Name', name),
      field('coord-new-folder', 'Folder', folder),
      field('coord-new-worktree', 'Worktree', worktree, 'The session first enters a new git worktree of this name.')
    ],
    action: 'Start',
    ready: () => task.value.trim() !== '',
    submit: async () => {
      const form: StartForm = { task: task.value, name: name.value, folder: folder.value, worktree: worktree.value }
      const checked = checkStartForm(form)
      if (!('req' in checked)) return checked.error
      handle.busy(true, 'Starting…')
      const r = await o.start(checked.req)
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
    pick.addEventListener('click', () => void attachNow(c.tabId))
    return pick
  })
  const list = picks.length === 0
    ? el('div', { className: 'coord-picks-empty', textContent: 'No other Claude session runs on this device.' })
    : el('div', { className: 'coord-picks' }, ...picks)
  let handle: DialogHandle
  async function attachNow(tabId: string): Promise<void> {
    handle.busy(true)
    for (const p of picks) p.disabled = true
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
  }
  handle = openDialog({
    id: 'attach',
    title: 'Attach a session',
    body: [el('div', { className: 'coord-dialog-text', textContent: 'Pick a Claude session of this device. It is not told and goes on as it is.' }), list],
    action: null
  })
}
