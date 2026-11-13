// MCP servers and plugins as the MCP · Plugins panel shows them, shared by main and the window

export type McpStatus = 'connected' | 'needs-auth' | 'failed' | 'pending' | 'pending-approval' | 'disabled' | 'configured' // configured: known from the files only, no running session
export type McpScope = 'user' | 'project' | 'local' | 'plugin' | 'claudeai' | 'managed' | 'other'
export type McpTransport = 'stdio' | 'http' | 'sse' | 'ws' | 'other'
export interface McpServerView {
  name: string; status: McpStatus; scope: McpScope; plugin: string | null   // plugin: the plugin's name for scope 'plugin'
  transport: McpTransport; target: string   // the URL (secret query values masked) or the command line; '' unknown
  tools: string[]; error: string | null; version: string | null
}
export interface McpServersView { live: boolean; servers: McpServerView[] }   // live false: no running session in the tab
export type McpEditScope = 'user' | 'project' | 'local'
export const MCP_EDIT_SCOPES: readonly McpEditScope[] = ['user', 'project', 'local']
export type McpSection = 'servers' | 'plugins'
export type McpAction =
  | { kind: 'reconnect'; name: string } | { kind: 'toggle'; name: string; enabled: boolean }
  | { kind: 'remove'; name: string; scope: McpEditScope }
  | { kind: 'login'; name: string } | { kind: 'cancel-login'; name: string } | { kind: 'logout'; name: string }
  | { kind: 'copy-config'; name: string; scope: McpEditScope } | { kind: 'open-config'; scope: McpEditScope }
export interface McpAddRequest { text: string; names: string[]; scope: McpEditScope; clientSecret: string | null }
export interface PluginView { id: string; name: string; marketplace: string; version: string; scope: string; enabled: boolean; update: string | null; description: string; mcpServers: number; errors: string[] }
export interface PluginOffer { id: string; name: string; marketplace: string; description: string; version: string | null; installs: number | null }
export interface MarketplaceView { name: string; source: string }
export interface PluginsView { installed: PluginView[]; available: PluginOffer[]; marketplaces: MarketplaceView[] }
export interface PluginOption { key: string; title: string; description: string; sensitive: boolean }
export type PluginAction =
  | { kind: 'install' | 'uninstall' | 'enable' | 'disable' | 'update' | 'configure-later'; id: string }
  | { kind: 'configure'; id: string; values: Record<string, string> }
  | { kind: 'marketplace-add'; source: string } | { kind: 'marketplace-remove' | 'marketplace-update'; name: string }
/** options: required plugin options still unset after an install; marketplace: the name a marketplace-add added */
export type McpResult = { ok: true; options?: PluginOption[]; marketplace?: string } | { ok: false; error: string }
export type ReloadAction = 'not-now' | 'restart'
/** a marketplace source as `claude plugin marketplace add` takes it: a GitHub repository link (https://github.com/o/r, with .git, /tree/…, or without the scheme) becomes `o/r`; anything else trimmed as typed; null for empty, multi-line, a control character or a leading '-' */
export function marketplaceSource(text: string): string | null {
  const source = text.trim()
  if (source === '' || /[\u0000-\u001f\u007f]/.test(source) || source.startsWith('-')) return null
  const link = /^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/.*)?$/i.exec(source)
  return link ? `${link[1]}/${link[2]}` : source
}
