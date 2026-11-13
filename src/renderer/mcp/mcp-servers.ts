import type { McpServerView, McpServersView } from '../../shared/mcp'
import { el } from '../dom'
import { badgeOf, detailOf, iconColor, initials, matchedTools, rowActions, serverGroups, type RowMenuItem } from './mcp-view-model'

/** the tools a row lists at most; the rest is one chip with their count */
const TOOL_CAP = 200

/** what a row's controls do: the panel runs each one (a menu item's name is the command it runs, except Remove, which asks first) */
export type RowCommand =
  | 'sign-in' | 'cancel-sign-in' | 'reconnect' | 'toggle' | 'approve' | 'menu' | 'close-menu'
  | 'sign-out' | 'tools' | 'copy-config' | 'open-config' | 'ask-remove' | 'cancel-remove' | 'remove'

/** what the panel keeps per tab and server: a sign-in waiting for the browser, an action running, its error, a removal asked for */
export interface RowState {
  busy: boolean
  signingIn: boolean
  /** Cancel was pressed in the sign-in: its Cancelled answer is no error */
  cancelled: boolean
  asking: boolean
  error: string | null
}

export interface ServerListOptions {
  /** the filter as typed: a server stays when its name or one of its tools matches */
  filter: string
  /** the rows whose tools are listed */
  unfolded: ReadonlySet<string>
  /** a click on a row's name: its tools open or close */
  fold(name: string): void
  /** the state the panel keeps for a row */
  state(name: string): RowState
  /** the server whose ··· menu is open, if any */
  menu: string | null
  /** a control of a row was used */
  command(s: McpServerView, c: RowCommand): void
}

const MENU_LABEL: Record<RowMenuItem, string> = {
  reconnect: 'Reconnect',
  'sign-out': 'Sign out',
  tools: 'Show tools',
  'copy-config': 'Copy config',
  'open-config': 'Open config file',
  remove: 'Remove'
}

const MENU_COMMAND: Record<RowMenuItem, RowCommand> = {
  reconnect: 'reconnect',
  'sign-out': 'sign-out',
  tools: 'tools',
  'copy-config': 'copy-config',
  'open-config': 'open-config',
  remove: 'ask-remove'
}

/** the groups of the servers list for the filter: a head, then the rows of each group */
export function serverList(view: McpServersView, o: ServerListOptions): HTMLElement[] {
  return serverGroups(view, o.filter).map((group) => {
    const box = el('section', { className: 'mcp-group' })
    box.append(el('div', { className: 'mcp-group-head', textContent: group.label.toUpperCase() }))
    for (const s of group.servers) box.append(serverRow(s, o, view.live))
    return box
  })
}

/** a server's row: its status dot, icon, name, badge and detail, its controls; then its errors, the Remove ask, the ··· menu and an unfolded row's tools */
function serverRow(s: McpServerView, o: ServerListOptions, live: boolean): HTMLElement {
  const matched = matchedTools(s, o.filter)
  // a filter that matches one of the tools lists those tools: the row opens by itself
  const open = matched !== null || o.unfolded.has(s.name)
  const row = o.state(s.name)
  const actions = rowActions(s, live)
  const item = el('div', { className: 'mcp-item' })
  const line = el('div', { className: 'mcp-row' })
  item.dataset.name = s.name
  line.dataset.status = s.status
  const icon = el('span', { className: 'mcp-icon', textContent: initials(s.name) })
  if (s.status !== 'disabled') icon.style.background = iconColor(s.name)
  const main = el('button', { className: 'mcp-main', type: 'button' })
  main.setAttribute('aria-expanded', String(open))
  // a repaint of the list draws the row again: the control with this key gets the focus back (each control of a row has its own key)
  main.dataset.focusKey = 'name'
  main.addEventListener('click', () => o.fold(s.name))
  const sub = el('span', { className: 'mcp-sub' })
  const badge = badgeOf(s)
  if (badge !== null) sub.append(el('span', { className: 'mcp-badge', textContent: badge }))
  sub.append(el('span', { className: 'mcp-detail', textContent: row.signingIn ? 'Waiting for the browser…' : detailOf(s) }))
  main.append(el('span', { className: 'mcp-name', textContent: s.name }), sub)
  line.append(el('span', { className: 'mcp-dot' }), icon, main, rowControls(s, o, row, actions))
  item.append(line)
  if (s.status === 'failed' && s.error !== null) item.append(el('div', { className: 'mcp-error', textContent: s.error }))
  if (row.error !== null) item.append(el('div', { className: 'mcp-error', textContent: row.error }))
  if (row.asking) item.append(removeAsk(s, o))
  if (o.menu === s.name && actions.menu.length > 0) item.append(menuBox(s, o, actions.menu))
  const tools = matched ?? s.tools
  if (open && tools.length > 0) item.append(toolChips(tools))
  // while an action runs, or a sign-in waits, the row's controls are off; the Cancel of a sign-in stays on
  const frozen = row.busy || row.signingIn
  for (const b of item.querySelectorAll<HTMLButtonElement>('button:not(.mcp-main)')) {
    b.disabled = frozen && b.dataset.focusKey !== 'cancel'
  }
  return item
}

/** the row's controls after its name: the primary button, the ↻ ghost, the switch and the ··· button */
function rowControls(s: McpServerView, o: ServerListOptions, row: RowState, actions: ReturnType<typeof rowActions>): HTMLElement {
  const box = el('div', { className: 'mcp-actions' })
  if (row.signingIn) {
    box.append(control('Cancel', 'mcp-btn', 'cancel', () => o.command(s, 'cancel-sign-in')))
  } else if (actions.primary === 'sign-in') {
    box.append(control('Sign in', 'mcp-btn warn', 'sign-in', () => o.command(s, 'sign-in')))
  } else if (actions.primary === 'retry') {
    box.append(control('↻ Retry', 'mcp-btn', 'retry', () => o.command(s, 'reconnect')))
  } else if (actions.primary === 'approve') {
    box.append(control('Approve in the terminal', 'mcp-btn', 'approve', () => o.command(s, 'approve')))
  }
  if (actions.reconnect) box.append(control('↻', 'mcp-ghost', 'reconnect', () => o.command(s, 'reconnect'), `Reconnect ${s.name}`))
  if (actions.toggle !== null) box.append(switchControl(s, o, actions.toggle))
  if (actions.menu.length > 0) {
    const more = control('···', 'mcp-ghost', 'more', () => o.command(s, 'menu'), `More for ${s.name}`)
    more.setAttribute('aria-expanded', String(o.menu === s.name))
    box.append(more)
  }
  return box
}

/** the on/off switch: a button with role switch; its label names the change a click makes */
function switchControl(s: McpServerView, o: ServerListOptions, on: boolean): HTMLElement {
  const sw = el('button', { className: 'mcp-switch', type: 'button' })
  sw.setAttribute('role', 'switch')
  sw.setAttribute('aria-checked', String(on))
  sw.setAttribute('aria-label', on ? `Turn ${s.name} off` : `Turn ${s.name} on`)
  sw.dataset.focusKey = 'switch'
  sw.addEventListener('click', () => o.command(s, 'toggle'))
  return sw
}

/** the Remove ask under the row: the name, Remove in red and Cancel */
function removeAsk(s: McpServerView, o: ServerListOptions): HTMLElement {
  const box = el('div', { className: 'mcp-confirm' })
  box.append(
    el('span', { className: 'mcp-confirm-text', textContent: `Remove ${s.name}?` }),
    control('Remove', 'mcp-btn mcp-red', 'confirm-remove', () => o.command(s, 'remove')),
    control('Cancel', 'mcp-btn', 'cancel-remove', () => o.command(s, 'cancel-remove'))
  )
  return box
}

/** the ··· menu: a list of buttons; Esc closes it (the panel gives the focus back to the ··· button) */
function menuBox(s: McpServerView, o: ServerListOptions, items: RowMenuItem[]): HTMLElement {
  const box = el('div', { className: 'mcp-menu' })
  for (const item of items) {
    const label = item === 'tools' && o.unfolded.has(s.name) ? 'Hide tools' : MENU_LABEL[item]
    const b = el('button', { className: 'mcp-menu-item', type: 'button', textContent: label })
    b.dataset.focusKey = `menu-${item}`
    b.addEventListener('click', () => o.command(s, MENU_COMMAND[item]))
    box.append(b)
  }
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    o.command(s, 'close-menu')
  })
  return box
}

function control(text: string, className: string, key: string, onClick: () => void, label?: string): HTMLButtonElement {
  const b = el('button', { className, type: 'button', textContent: text })
  b.dataset.focusKey = key
  if (label !== undefined) b.setAttribute('aria-label', label)
  b.addEventListener('click', onClick)
  return b
}

function toolChips(tools: string[]): HTMLElement {
  const box = el('div', { className: 'mcp-tools' })
  for (const tool of tools.slice(0, TOOL_CAP)) box.append(el('span', { className: 'mcp-chip', textContent: tool }))
  if (tools.length > TOOL_CAP) box.append(el('span', { className: 'mcp-chip', textContent: `+${tools.length - TOOL_CAP}` }))
  return box
}
