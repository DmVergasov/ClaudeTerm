import { join, win32, type PlatformPath } from 'node:path'
import type { McpEditScope } from '../../shared/mcp'
import { isWindowsPath, nativePath, pathKey } from '../path-key'

/** a configuration file bigger than this is not read: it is not one Claude Code wrote, and it configures nothing */
export const MAX_CONFIG_BYTES = 16 * 1024 * 1024

/** a file that exists but could not be read or parsed now: it is not an empty file, so it is not a removal of what it configured */
export const UNREADABLE: unique symbol = Symbol('unreadable')

export interface ConfigPaths {
  userConfig: string
  userSettings: string
  installedPlugins: string
  projectMcp: string
  projectSettings: string
  localSettings: string
}

/** userConfig: <CLAUDE_CONFIG_DIR || home>/.claude.json; the others under <CLAUDE_CONFIG_DIR || home/.claude>: settings.json, plugins/installed_plugins.json; in the folder: .mcp.json, .claude/settings.json, .claude/settings.local.json */
export function configPaths(env: Record<string, string | undefined>, home: string, folder: string): ConfigPaths {
  const configDir = env.CLAUDE_CONFIG_DIR || undefined
  const settingsDir = configDir || join(home, '.claude')
  return {
    userConfig: join(configDir || home, '.claude.json'),
    userSettings: join(settingsDir, 'settings.json'),
    installedPlugins: join(settingsDir, 'plugins', 'installed_plugins.json'),
    projectMcp: join(folder, '.mcp.json'),
    projectSettings: join(folder, '.claude', 'settings.json'),
    localSettings: join(folder, '.claude', 'settings.local.json')
  }
}

/** each file parsed, null when missing, UNREADABLE when it exists but could not be read now */
export type ConfigFiles = Record<keyof ConfigPaths, unknown>

export interface ConfiguredServer {
  name: string
  scope: McpEditScope
  config: Record<string, unknown>
  approval: 'approved' | 'pending' | 'rejected' | null // project servers only
  disabled: boolean // in the folder entry's disabledMcpServers: the session's switch, never a change
}

export interface InstalledPlugin {
  id: string
  version: string
  enabled: boolean
}

export interface TabConfig {
  servers: ConfiguredServer[]
  plugins: InstalledPlugin[]
  unreadable: (keyof ConfigPaths)[] // files that exist but could not be read now: they configure nothing here
}

const CONFIG_KEYS: (keyof ConfigPaths)[] = ['userConfig', 'userSettings', 'installedPlugins', 'projectMcp', 'projectSettings', 'localSettings']

export type ConfigChangeKind =
  | 'server-added'
  | 'server-removed'
  | 'server-changed'
  | 'server-approved'
  | 'plugin-installed'
  | 'plugin-removed'
  | 'plugin-updated'
  | 'plugin-enabled'
  | 'plugin-disabled'

/** a plugin's name is its id before '@' */
export interface ConfigChange {
  kind: ConfigChangeKind
  name: string
}

type Json = Record<string, unknown>

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined
}

function listHas(list: unknown, name: string): boolean {
  return Array.isArray(list) && list.includes(name)
}

/** the folder as Claude Code wrote it: pathKey, with win32 rules for a Windows folder, and a trailing separator dropped */
function folderMatcher(folder: string): (other: string) => boolean {
  const path: PlatformPath = isWindowsPath(folder) ? win32 : nativePath
  const key = (p: string): string => pathKey(p.replace(/[\\/]+$/, '') || p, path)
  const own = key(folder)
  return (other) => key(other) === own
}

/** the approval of a project server, from the folder entry and the three settings files */
function approvalOf(name: string, sources: Json[]): 'approved' | 'pending' | 'rejected' {
  if (sources.some((s) => listHas(s.disabledMcpjsonServers, name))) return 'rejected'
  if (sources.some((s) => s.enableAllProjectMcpServers === true || listHas(s.enabledMcpjsonServers, name))) return 'approved'
  return 'pending'
}

function pluginName(id: string): string {
  const at = id.indexOf('@')
  return at > 0 ? id.slice(0, at) : id
}

/** what the files configure for a tab in `folder` (the folder already canonical); nothing here throws */
export function tabConfig(files: ConfigFiles, folder: string): TabConfig {
  const matches = folderMatcher(folder)
  const unreadable = CONFIG_KEYS.filter((key) => files[key] === UNREADABLE)
  // an unreadable file configures nothing, as a missing one does
  const readable = (key: keyof ConfigPaths): unknown => (files[key] === UNREADABLE ? null : files[key])
  const user = asObject(readable('userConfig'))
  const projects = asObject(user?.projects)
  const entryKey = projects === undefined ? undefined : Object.keys(projects).find((key) => matches(key))
  const entry = projects !== undefined && entryKey !== undefined ? asObject(projects[entryKey]) : undefined

  const userSettings = asObject(readable('userSettings'))
  const projectSettings = asObject(readable('projectSettings'))
  const localSettings = asObject(readable('localSettings'))
  const approvalSources = [entry, userSettings, projectSettings, localSettings].filter((s): s is Json => s !== undefined)
  const disabledHere = (name: string): boolean => listHas(entry?.disabledMcpServers, name)

  const servers: ConfiguredServer[] = []
  const addAll = (scope: McpEditScope, list: unknown, approval: (name: string) => ConfiguredServer['approval']): void => {
    const map = asObject(list)
    if (map === undefined) return
    for (const name of Object.keys(map)) {
      const config = asObject(map[name])
      if (config === undefined) continue
      servers.push({ name, scope, config, approval: approval(name), disabled: disabledHere(name) })
    }
  }
  addAll('user', user?.mcpServers, () => null)
  addAll('project', asObject(readable('projectMcp'))?.mcpServers, (name) => approvalOf(name, approvalSources))
  addAll('local', entry?.mcpServers, () => null)

  // the last of user, project and local settings that names the plugin decides
  const enabledIn = (id: string): boolean => {
    let enabled = false
    for (const settings of [userSettings, projectSettings, localSettings]) {
      const map = asObject(settings?.enabledPlugins)
      const on = map !== undefined && Object.hasOwn(map, id) ? map[id] : undefined
      if (typeof on === 'boolean') enabled = on
    }
    return enabled
  }

  const installed = asObject(asObject(readable('installedPlugins'))?.plugins)
  const plugins: InstalledPlugin[] = []
  for (const id of Object.keys(installed ?? {})) {
    const entries = installed !== undefined ? installed[id] : undefined
    if (!Array.isArray(entries)) continue
    // a project's or local install of this folder wins over a user or managed install
    let chosen: { version: string; project: boolean } | null = null
    for (const item of entries) {
      const install = asObject(item)
      if (install === undefined) continue
      const version = install.version
      if (typeof version !== 'string') continue
      let candidate: { version: string; project: boolean } | null = null
      if (install.scope === 'user' || install.scope === 'managed') candidate = { version, project: false }
      else if ((install.scope === 'project' || install.scope === 'local') && typeof install.projectPath === 'string' && matches(install.projectPath)) {
        candidate = { version, project: true }
      }
      if (candidate !== null && (chosen === null || (candidate.project && !chosen.project))) chosen = candidate
    }
    if (chosen !== null) plugins.push({ id, version: chosen.version, enabled: enabledIn(id) })
  }

  return { servers, plugins, unreadable }
}

/** the configuration of a tab read from the files; a file that exists but cannot be read (readJson throws) is UNREADABLE */
export async function readTabConfig(paths: ConfigPaths, folder: string, readJson: (file: string) => Promise<unknown>): Promise<TabConfig> {
  const read = async (file: string): Promise<unknown> => {
    try {
      return await readJson(file)
    } catch {
      return UNREADABLE
    }
  }
  const [userConfig, userSettings, installedPlugins, projectMcp, projectSettings, localSettings] = await Promise.all([
    read(paths.userConfig),
    read(paths.userSettings),
    read(paths.installedPlugins),
    read(paths.projectMcp),
    read(paths.projectSettings),
    read(paths.localSettings)
  ])
  return tabConfig({ userConfig, userSettings, installedPlugins, projectMcp, projectSettings, localSettings }, folder)
}

/** what a load gives: the parsed file or UNREADABLE, and whether the read itself failed (so the version is not kept) */
type Loaded = { data: unknown; readFailed: boolean }

/**
 * a reader that stats the file each call and reads and parses it again only when its mtime or size changed. The result is null for a file
 * that does not exist and for one over MAX_CONFIG_BYTES (not read); UNREADABLE for one that exists but whose stat throws (not kept, the next
 * call asks again), whose read fails (not kept, the next call reads again) or whose text is not JSON (kept for that version, like a parse).
 * A read in flight is shared: callers that ask for the same file version at once read it once, even when that read fails.
 */
export function jsonFileCache(fs: {
  /** null when the file is missing; throws when it cannot be stat-ed */
  stat(f: string): Promise<{ mtimeMs: number; size: number } | null>
  /** the text, null or a throw when it cannot be read */
  read(f: string): Promise<string | null>
}): (file: string) => Promise<unknown> {
  const cache = new Map<string, { mtimeMs: number; size: number; data: Promise<Loaded> }>()

  /** the parsed file, or UNREADABLE when the read fails or the text is not JSON */
  const load = async (file: string): Promise<Loaded> => {
    let text: string | null
    try {
      text = await fs.read(file)
    } catch {
      return { data: UNREADABLE, readFailed: true }
    }
    if (text === null) return { data: UNREADABLE, readFailed: true }
    try {
      return { data: JSON.parse(text), readFailed: false }
    } catch {
      return { data: UNREADABLE, readFailed: false }
    }
  }

  return async (file) => {
    let stat: { mtimeMs: number; size: number } | null
    try {
      stat = await fs.stat(file)
    } catch {
      return UNREADABLE
    }
    if (stat === null || stat.size > MAX_CONFIG_BYTES) {
      cache.delete(file)
      return null
    }
    const hit = cache.get(file)
    if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return (await hit.data).data

    const loaded = load(file)
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, data: loaded })
    const result = await loaded
    // a failed read is not kept, so the next call reads the file again; a newer version that took the entry stays
    if (result.readFailed && cache.get(file)?.data === loaded) cache.delete(file)
    return result.data
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  const object = asObject(value)
  if (object === undefined) return value
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, sortKeys(object[key])]))
}

/** the config as JSON with the keys sorted at every level, so equal configs have equal keys */
export function configKey(config: Record<string, unknown>): string {
  return JSON.stringify(sortKeys(config))
}

/** the servers Claude Code loads for the tab: user, then approved project, then local, the later scope winning a name */
function loadable(config: TabConfig): Map<string, ConfiguredServer> {
  const map = new Map<string, ConfiguredServer>()
  for (const scope of ['user', 'project', 'local'] as const) {
    for (const server of config.servers) {
      if (server.scope !== scope) continue
      if (scope === 'project' && server.approval !== 'approved') continue
      map.set(server.name, server)
    }
  }
  return map
}

function pluginChange(before: InstalledPlugin | undefined, now: InstalledPlugin | undefined): ConfigChangeKind | null {
  if (!before?.enabled && now?.enabled) return before === undefined ? 'plugin-installed' : 'plugin-enabled'
  if (before?.enabled && now === undefined) return 'plugin-removed'
  if (before?.enabled && now !== undefined && !now.enabled) return 'plugin-disabled'
  if (before?.enabled && now?.enabled && before.version !== now.version) return 'plugin-updated'
  return null
}

/** what changed between the configuration a session loaded and the one the files give now; sorted by name, servers first */
export function diffConfig(loaded: TabConfig, now: TabConfig): ConfigChange[] {
  const before = loadable(loaded)
  const after = loadable(now)
  const servers: ConfigChange[] = []
  const names = [...new Set([...before.keys(), ...after.keys()])].sort()
  for (const name of names) {
    const was = before.get(name)
    const is = after.get(name)
    if (was !== undefined && is === undefined) {
      servers.push({ kind: 'server-removed', name })
    } else if (was === undefined && is !== undefined) {
      const waiting = loaded.servers.some((s) => s.name === name && s.scope === 'project' && (s.approval === 'pending' || s.approval === 'rejected'))
      servers.push({ kind: waiting ? 'server-approved' : 'server-added', name })
    } else if (was !== undefined && is !== undefined && configKey(was.config) !== configKey(is.config)) {
      servers.push({ kind: 'server-changed', name })
    }
  }

  const pluginsById = (config: TabConfig): Map<string, InstalledPlugin> => new Map(config.plugins.map((p) => [p.id, p]))
  const wasPlugins = pluginsById(loaded)
  const isPlugins = pluginsById(now)
  const plugins: ConfigChange[] = []
  for (const id of [...new Set([...wasPlugins.keys(), ...isPlugins.keys()])].sort()) {
    const kind = pluginChange(wasPlugins.get(id), isPlugins.get(id))
    if (kind !== null) plugins.push({ kind, name: pluginName(id) })
  }
  plugins.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  return [...servers, ...plugins]
}

const CONFIG_FILE_NAMES = new Set(['.mcp.json', '.claude.json', 'settings.json', 'settings.local.json', 'installed_plugins.json', 'known_marketplaces.json'])
/** `claude mcp …` or `claude plugin …`, run as claude, claude.exe or claude.cmd, possibly quoted or with a folder in front */
const CLAUDE_CONFIG_COMMAND = /(?:^|[\s;&|("'])["']?(?:[^\s;&|()"']*[\\/])?claude(?:\.exe|\.cmd)?["']?\s+(?:mcp|plugin)\b/i
/** a configuration file named by its base name, after a separator or at the start of a token */
const CONFIG_FILE_IN_COMMAND = /(?:^|[\s"'=\\/:])(?:\.mcp\.json|\.claude\.json|settings\.json|settings\.local\.json|installed_plugins\.json|known_marketplaces\.json)(?=$|[\s"'`;&|)])/i

/**
 * a tool call that may change what Claude Code loads: a Bash or PowerShell command that runs `claude mcp` or `claude plugin` or names one of the
 * configuration files, or an edit of one of those files
 */
export function touchesConfig(name: string, input: unknown): boolean {
  const fields = asObject(input)
  if (fields === undefined) return false
  if (name === 'Bash' || name === 'PowerShell') {
    const command = fields.command
    return typeof command === 'string' && (CLAUDE_CONFIG_COMMAND.test(command) || CONFIG_FILE_IN_COMMAND.test(command))
  }
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
    return [fields.file_path, fields.notebook_path].some((path) => {
      if (typeof path !== 'string') return false
      return CONFIG_FILE_NAMES.has((path.split(/[\\/]/).pop() ?? '').toLowerCase())
    })
  }
  return false
}
