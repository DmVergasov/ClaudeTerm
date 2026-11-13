// The view logic of the MCP · Plugins panel: which servers are where, what a row says and offers.
// Pure functions of the shared views: no DOM is touched at import or call time.

import type { McpEditScope, McpServerView, McpServersView, PluginView } from '../../shared/mcp'

export interface ServerGroup { label: 'Needs attention' | 'Connected' | 'Configured' | 'Off'; servers: McpServerView[] }

export type RowMenuItem = 'reconnect' | 'sign-out' | 'tools' | 'copy-config' | 'open-config' | 'remove'

const ICON_COLORS = ['#5E6AD2', '#8D7BD8', '#336791', '#63C08F', '#2EAD33', '#D97757', '#7FA7F5', '#E5B567']

function byName(a: McpServerView, b: McpServerView): number {
  const x = a.name.toLowerCase()
  const y = b.name.toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

/** The tools of the server that match the filter; null when there is no filter or the server's name matches it. */
export function matchedTools(s: McpServerView, filter: string): string[] | null {
  const query = filter.trim().toLowerCase()
  if (query === '' || s.name.toLowerCase().includes(query)) return null
  return s.tools.filter((tool) => tool.toLowerCase().includes(query))
}

/** The groups of the panel for the filter; a server stays when its name or one of its tools matches. */
export function serverGroups(view: McpServersView, filter: string): ServerGroup[] {
  const shown = view.servers.filter((s) => {
    const tools = matchedTools(s, filter)
    return tools === null || tools.length > 0
  })
  const pick = (statuses: McpServerView['status'][]) => shown.filter((s) => statuses.includes(s.status)).sort(byName)
  const groups: ServerGroup[] = [
    { label: 'Needs attention', servers: pick(['needs-auth', 'failed', 'pending-approval']) },
    { label: view.live ? 'Connected' : 'Configured', servers: pick(['connected', 'pending', 'configured']) },
    { label: 'Off', servers: pick(['disabled']) },
  ]
  return groups.filter((group) => group.servers.length > 0)
}

export function serverStats(view: McpServersView): { connected: number; needSignIn: number; failed: number } {
  const count = (status: McpServerView['status']) => view.servers.filter((s) => s.status === status).length
  return { connected: count('connected'), needSignIn: count('needs-auth'), failed: count('failed') }
}

export function badgeOf(s: McpServerView): string | null {
  switch (s.scope) {
    case 'user': return 'User'
    case 'project': return 'Project'
    case 'local': return 'Local'
    case 'plugin': return s.plugin ? `Plugin · ${s.plugin}` : 'Plugin'
    case 'claudeai': return 'claude.ai'
    case 'managed': return 'Managed'
    default: return null
  }
}

export function detailOf(s: McpServerView): string {
  switch (s.status) {
    case 'connected': {
      const tools = `${s.tools.length} ${s.tools.length === 1 ? 'tool' : 'tools'}`
      return s.version ? `${tools} · v${s.version}` : tools
    }
    case 'needs-auth': return 'Needs sign-in'
    case 'failed': return 'Failed to start'
    case 'pending': return 'Connecting…'
    case 'pending-approval': return 'Waiting for approval'
    case 'disabled': return 'Disabled'
    default: return s.target
  }
}

export function rowActions(s: McpServerView, live: boolean): { primary: 'sign-in' | 'retry' | 'approve' | null; reconnect: boolean; toggle: boolean | null; menu: RowMenuItem[] } {
  const primary = s.status === 'needs-auth' ? 'sign-in' : s.status === 'failed' ? 'retry' : s.status === 'pending-approval' ? 'approve' : null
  const reconnect = live && s.status === 'connected'
  let toggle: boolean | null = null
  if (live && ['connected', 'pending', 'needs-auth', 'failed'].includes(s.status)) toggle = true
  if (live && s.status === 'disabled') toggle = false
  const menu: RowMenuItem[] = []
  if (live && !reconnect) menu.push('reconnect')
  if ((s.transport === 'http' || s.transport === 'sse' || s.scope === 'claudeai') && (s.status === 'connected' || s.status === 'needs-auth')) menu.push('sign-out')
  if (s.tools.length > 0) menu.push('tools')
  if (editScope(s) !== null) menu.push('copy-config', 'open-config', 'remove')
  return { primary, reconnect, toggle, menu }
}

/** Two letters for the icon: the first letter, then the first letter of the next word (or the second letter). */
export function initials(name: string): string {
  const words = name.split(/[-_.]+/).filter((word) => word !== '').map((word) => Array.from(word))
  if (words.length === 0) return ''
  const second = words.length > 1 ? words[1][0] : words[0][1]
  return (words[0][0].toUpperCase() + (second ?? '').toLowerCase())
}

export function iconColor(name: string): string {
  let sum = 0
  for (let i = 0; i < name.length; i++) sum += name.charCodeAt(i)
  return ICON_COLORS[sum % ICON_COLORS.length]
}

export function countLabel(n: number): string {
  if (!Number.isFinite(n) || n < 1000) return String(n)
  if (n < 999_500) return short(n / 1000, 'k')
  return short(n / 1_000_000, 'M')
}

function short(value: number, unit: string): string {
  const text = value < 10 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value))
  return text + unit
}

export function pluginLine(p: PluginView): string {
  if (!p.enabled) return `${p.marketplace} · disabled`
  const servers = p.mcpServers > 0 ? ` · ${p.mcpServers} ${p.mcpServers === 1 ? 'MCP server' : 'MCP servers'}` : ''
  return `${p.marketplace} · ${p.version}${servers}`
}

export function editScope(s: McpServerView): McpEditScope | null {
  return s.scope === 'user' || s.scope === 'project' || s.scope === 'local' ? s.scope : null
}
