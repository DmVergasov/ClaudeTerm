import type { McpServerView, McpServersView } from '../../shared/mcp'
import { el } from '../dom'
import { badgeOf, detailOf, iconColor, initials, matchedTools, serverGroups } from './mcp-view-model'

/** the tools a row lists at most; the rest is one chip with their count */
const TOOL_CAP = 200

export interface ServerListOptions {
  /** the filter as typed: a server stays when its name or one of its tools matches */
  filter: string
  /** the rows whose tools are listed */
  unfolded: ReadonlySet<string>
  /** a click on a row's name: its tools open or close */
  fold(name: string): void
}

/** the groups of the servers list for the filter: a head, then the rows of each group */
export function serverList(view: McpServersView, o: ServerListOptions): HTMLElement[] {
  return serverGroups(view, o.filter).map((group) => {
    const box = el('section', { className: 'mcp-group' })
    box.append(el('div', { className: 'mcp-group-head', textContent: group.label.toUpperCase() }))
    for (const s of group.servers) box.append(serverRow(s, o))
    return box
  })
}

/** a server's row: its status dot, icon, name, badge and detail; a failed server's error and an unfolded row's tools below it */
function serverRow(s: McpServerView, o: ServerListOptions): HTMLElement {
  const matched = matchedTools(s, o.filter)
  // a filter that matches one of the tools lists those tools: the row opens by itself
  const open = matched !== null || o.unfolded.has(s.name)
  const item = el('div', { className: 'mcp-item' })
  const line = el('div', { className: 'mcp-row' })
  item.dataset.name = s.name
  line.dataset.status = s.status
  const icon = el('span', { className: 'mcp-icon', textContent: initials(s.name) })
  if (s.status !== 'disabled') icon.style.background = iconColor(s.name)
  const main = el('button', { className: 'mcp-main', type: 'button' })
  main.setAttribute('aria-expanded', String(open))
  main.addEventListener('click', () => o.fold(s.name))
  const sub = el('span', { className: 'mcp-sub' })
  const badge = badgeOf(s)
  if (badge !== null) sub.append(el('span', { className: 'mcp-badge', textContent: badge }))
  sub.append(el('span', { className: 'mcp-detail', textContent: detailOf(s) }))
  main.append(el('span', { className: 'mcp-name', textContent: s.name }), sub)
  line.append(el('span', { className: 'mcp-dot' }), icon, main)
  item.append(line)
  if (s.status === 'failed' && s.error !== null) item.append(el('div', { className: 'mcp-error', textContent: s.error }))
  const tools = matched ?? s.tools
  if (open && tools.length > 0) item.append(toolChips(tools))
  return item
}

function toolChips(tools: string[]): HTMLElement {
  const box = el('div', { className: 'mcp-tools' })
  for (const tool of tools.slice(0, TOOL_CAP)) box.append(el('span', { className: 'mcp-chip', textContent: tool }))
  if (tools.length > TOOL_CAP) box.append(el('span', { className: 'mcp-chip', textContent: `+${tools.length - TOOL_CAP}` }))
  return box
}
