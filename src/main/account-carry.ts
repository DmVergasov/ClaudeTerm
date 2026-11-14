import { posix, win32 } from 'node:path'
import { CARRY_ITEMS, type CarryCount, type CarryItem } from '../shared/accounts'
import { isWindowsPath, pathKey } from './path-key'

/** settings keys that never leave the source: hooks and plugins come with their own items, the rest are credentials or cloud routing */
export const SETTINGS_DROPPED = [
  'hooks',
  'enabledPlugins',
  'extraKnownMarketplaces',
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'forceLoginMethod',
  'forceLoginOrgUUID',
] as const

/** env variables that never leave the source: credentials, and the switches that send Claude Code to another provider */
export const ENV_DROPPED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const

/** the items copied from a folder of the source */
export type FolderItem = 'skills' | 'agents' | 'commands' | 'output-styles' | 'memory' | 'keybindings'

/** what each folder item copies, relative to the config folder */
export const ITEM_PATHS: Record<FolderItem, string[]> = {
  skills: ['skills/'],
  agents: ['agents/'],
  commands: ['commands/'],
  'output-styles': ['output-styles/'],
  memory: ['CLAUDE.md', 'rules/'],
  keybindings: ['keybindings.json'],
}

type Obj = Record<string, unknown>

/** the MCP server name ClaudeTerm registers for itself: never carried */
const OWN_SERVER = 'claudeterm'
const SERVER_NAME = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,63}$/
const ENV_DROPPED_KEYS = new Set<string>(ENV_DROPPED.map((name) => name.toUpperCase()))

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** a server name Claude Code and the `claude mcp` command take: 1 to 64 letters, digits, _, - or ., not starting with - */
export function isServerName(name: unknown): name is string {
  return typeof name === 'string' && SERVER_NAME.test(name)
}

/** the env of a carried settings file: string values only, credential variables left out */
function carriedEnv(env: unknown): Obj {
  if (!isObject(env)) return {}
  return Object.fromEntries(
    Object.entries(env).filter(([name, value]) => typeof value === 'string' && !ENV_DROPPED_KEYS.has(name.toUpperCase())),
  )
}

/** the settings of the source that may be carried: a JSON object without the dropped keys; nothing else of it */
export function carriedSettings(settings: unknown): Record<string, unknown> {
  if (!isObject(settings)) return {}
  const dropped: readonly string[] = SETTINGS_DROPPED
  const kept: [string, unknown][] = []
  for (const [key, value] of Object.entries(settings)) {
    if (dropped.includes(key)) continue
    if (key === 'env') {
      const env = carriedEnv(value)
      if (Object.keys(env).length > 0) kept.push([key, env])
      continue
    }
    kept.push([key, value])
  }
  return Object.fromEntries(kept)
}

/** the hooks of a settings file, or null when it has none */
export function hooksOf(settings: unknown): Record<string, unknown> | null {
  return isObject(settings) && isObject(settings.hooks) ? settings.hooks : null
}

/** the hook commands of a hooks object: each matcher group's hooks array, a group without one counts 1 */
export function countHooks(hooks: unknown): number {
  if (!isObject(hooks)) return 0
  let count = 0
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      count += isObject(group) && Array.isArray(group.hooks) ? group.hooks.length : 1
    }
  }
  return count
}

/** the account's settings with the carried keys applied: they replace the account's, env merged per variable */
export function mergeSettings(account: Record<string, unknown>, carried: Record<string, unknown>): Record<string, unknown> {
  const merged = new Map<string, unknown>(Object.entries(account))
  for (const [key, value] of Object.entries(carried)) {
    const current = merged.get(key)
    merged.set(key, key === 'env' && isObject(value) && isObject(current) ? { ...current, ...value } : value)
  }
  return Object.fromEntries(merged)
}

/** the account's settings with its hooks replaced as a whole */
export function withHooks(account: Record<string, unknown>, hooks: Record<string, unknown>): Record<string, unknown> {
  return { ...account, hooks }
}

/** the user-scope MCP servers of a .claude.json, by name, without ClaudeTerm's own server */
export function userServers(claudeJson: unknown): { name: string; config: Record<string, unknown> }[] {
  if (!isObject(claudeJson) || !isObject(claudeJson.mcpServers)) return []
  return Object.entries(claudeJson.mcpServers)
    .flatMap(([name, config]) => (name !== OWN_SERVER && isServerName(name) && isObject(config) ? [{ name, config }] : []))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
}

/** the values of a server's env and headers that are not empty: what a server keeps as its secrets */
export function serverSecrets(config: Record<string, unknown>): string[] {
  return ['env', 'headers'].flatMap((field) => {
    const values = config[field]
    return isObject(values) ? Object.values(values).filter((value): value is string => typeof value === 'string' && value !== '') : []
  })
}

export interface PluginPlan {
  plugins: { id: string; name: string; marketplace: string; enabled: boolean }[]
  /** the marketplaces of the user-scope plugins; source null when claude.ai hosts it */
  marketplaces: { name: string; source: string | null }[]
}

/** where a marketplace is added from: repo, url or path by its kind, else null */
function marketplaceSource(entry: unknown): string | null {
  if (!isObject(entry) || !isObject(entry.source)) return null
  const source = entry.source
  const field =
    source.source === 'github' ? source.repo : source.source === 'git' || source.source === 'url' ? source.url : source.source === 'directory' || source.source === 'file' ? source.path : undefined
  return typeof field === 'string' && field !== '' ? field : null
}

/** the user-scope plugins of the source, their marketplaces, and which plugins are on */
export function pluginPlan(installed: unknown, known: unknown, settings: unknown): PluginPlan {
  const plugins = isObject(installed) && isObject(installed.plugins) ? installed.plugins : {}
  const enabled: Obj = isObject(settings) && isObject(settings.enabledPlugins) ? settings.enabledPlugins : {}
  const markets: Obj = isObject(known) ? known : {}

  const items: PluginPlan['plugins'] = []
  for (const [id, entries] of Object.entries(plugins)) {
    const at = id.indexOf('@')
    if (at <= 0 || at === id.length - 1 || !Array.isArray(entries)) continue
    if (!entries.some((entry) => isObject(entry) && entry.scope === 'user')) continue
    items.push({ id, name: id.slice(0, at), marketplace: id.slice(at + 1), enabled: enabled[id] === true })
  }
  items.sort((a, b) => (a.id < b.id ? -1 : 1))

  const names = Array.from(new Set(items.map((item) => item.marketplace))).sort()
  return {
    plugins: items,
    marketplaces: names.map((name) => ({ name, source: marketplaceSource(markets[name]) })),
  }
}

/**
 * The text of .claude.json with `hasTrustDialogAccepted` set for each folder: an entry whose key is the same folder
 * (pathKey, win32 rules for a Windows folder) gets the flag, else an entry with the folder as its only key.
 * Nothing else changes. Null when every folder is trusted already. Throws on text that is not a JSON object.
 */
export function addTrust(text: string | null, folders: string[]): string | null {
  let data: unknown = {}
  if (text !== null) {
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error('.claude.json is not JSON')
    }
  }
  if (!isObject(data)) throw new Error('.claude.json is not a JSON object')

  // a value that is there but cannot be read is never overwritten: the item fails and the file stays as it is
  if (Object.hasOwn(data, 'projects') && !isObject(data.projects)) throw new Error('.claude.json projects is not an object')
  const projects: Obj = isObject(data.projects) ? data.projects : {}
  let changed = false
  for (const folder of folders) {
    const path = isWindowsPath(folder) ? win32 : posix
    const key = pathKey(folder, path)
    const matches = Object.keys(projects).filter((project) => pathKey(project, path) === key)
    if (matches.length === 0) {
      setOwn(projects, folder, { hasTrustDialogAccepted: true })
      changed = true
      continue
    }
    for (const project of matches) {
      const entry = projects[project]
      if (!isObject(entry)) throw new Error(`.claude.json projects entry for ${project} is not an object`)
      if (entry.hasTrustDialogAccepted === true) continue
      setOwn(projects, project, { ...entry, hasTrustDialogAccepted: true })
      changed = true
    }
  }
  if (!changed) return null
  setOwn(data, 'projects', projects)
  return JSON.stringify(data, null, 2)
}

/** sets an own property, so a key such as `__proto__` is data and never the prototype */
function setOwn(target: Obj, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true })
}

/** the counts the helper shows for each item, in CARRY_ITEMS order; names only for the first three MCP servers */
export function previewCounts(
  read: { settings: unknown; claudeJson: unknown; installed: unknown; known: unknown },
  files: Record<FolderItem, number>,
): CarryCount[] {
  const settings = carriedSettings(read.settings)
  const servers = userServers(read.claudeJson)
  const plan = pluginPlan(read.installed, read.known, read.settings)
  const projects = isObject(read.claudeJson) && isObject(read.claudeJson.projects) ? Object.values(read.claudeJson.projects) : []
  const trusted = projects.filter((entry) => isObject(entry) && entry.hasTrustDialogAccepted === true).length

  const count = (item: CarryItem, value: number, names: string[] = [], marketplaces = 0): CarryCount => ({ item, count: value, names, marketplaces })
  const byItem: Record<CarryItem, CarryCount> = {
    settings: count('settings', Object.keys(settings).length),
    hooks: count('hooks', countHooks(hooksOf(read.settings))),
    mcp: count('mcp', servers.length, servers.slice(0, 3).map((server) => server.name)),
    plugins: count('plugins', plan.plugins.length, [], plan.marketplaces.length),
    skills: count('skills', files.skills),
    agents: count('agents', files.agents),
    commands: count('commands', files.commands),
    memory: count('memory', files.memory),
    trust: count('trust', trusted),
    keybindings: count('keybindings', files.keybindings),
    'output-styles': count('output-styles', files['output-styles']),
  }
  return CARRY_ITEMS.map((item) => byItem[item])
}
