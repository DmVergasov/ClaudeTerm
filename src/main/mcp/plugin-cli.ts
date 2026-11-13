import { win32, type PlatformPath } from 'node:path'
import type { MarketplaceView, PluginOffer, PluginOption, PluginsView, PluginView } from '../../shared/mcp'
import { isWindowsPath, nativePath, pathKey } from '../path-key'

// Reads the JSON that `claude plugin …` prints, and builds the Plugins section for a tab's folder. Everything here is
// untrusted CLI output: each field is checked and capped, a malformed entry is skipped, and nothing throws.

const MAX_NAME = 200
const MAX_DESCRIPTION = 2000
const MAX_ERROR = 2000
const MAX_ERRORS = 20
const MAX_VERSION = 100
const MAX_SOURCE = 2000

export interface InstalledEntry {
  id: string
  name: string
  marketplace: string
  version: string
  scope: string
  enabled: boolean
  projectPath: string | null
  mcpServers: number
  errors: string[]
}

export interface MarketplaceEntry {
  name: string
  source: string
  installLocation: string | null
}

type Json = Record<string, unknown>

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined
}

/** the list itself, or the list under `key` of an object (the --available output carries `installed` and `available`) */
function listOf(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value
  const list = asObject(value)?.[key]
  return Array.isArray(list) ? list : []
}

/** a name or identifier: a non-empty string of at most MAX_NAME characters, else null */
function label(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && value.length <= MAX_NAME ? value : null
}

/** a free text: a string cut to `max` characters, else null */
function text(value: unknown, max: number): string | null {
  return typeof value === 'string' ? value.slice(0, max) : null
}

/** a plugin id `name@marketplace` split at its last '@'; without one the whole id is the name */
function splitId(id: string): { name: string; marketplace: string } {
  const at = id.lastIndexOf('@')
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id, marketplace: '' }
}

function errorsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((error): error is string => typeof error === 'string').slice(0, MAX_ERRORS).map((error) => error.slice(0, MAX_ERROR))
}

/** the folder as Claude Code wrote it: pathKey, with win32 rules for a Windows folder, and a trailing separator dropped (as mcp-config's folder matcher) */
function folderMatcher(folder: string): (other: string) => boolean {
  const path: PlatformPath = isWindowsPath(folder) ? win32 : nativePath
  const key = (p: string): string => pathKey(p.replace(/[\\/]+$/, '') || p, path)
  const own = key(folder)
  return (other) => key(other) === own
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** `plugin list --json` (an array), or the `installed` of `plugin list --available --json` */
export function parseInstalled(v: unknown): InstalledEntry[] {
  const entries: InstalledEntry[] = []
  for (const item of listOf(v, 'installed')) {
    const e = asObject(item)
    if (e === undefined) continue
    const id = label(e.id)
    const scope = label(e.scope)
    if (id === null || scope === null) continue
    const { name, marketplace } = splitId(id)
    entries.push({
      id,
      name,
      marketplace,
      version: text(e.version, MAX_VERSION) || 'unknown',
      scope,
      enabled: e.enabled === true,
      projectPath: typeof e.projectPath === 'string' && e.projectPath !== '' ? e.projectPath : null,
      mcpServers: Object.keys(asObject(e.mcpServers) ?? {}).length,
      errors: errorsOf(e.errors)
    })
  }
  return entries
}

/** the `available` of `plugin list --available --json` (or that whole output) */
export function parseAvailable(v: unknown): PluginOffer[] {
  const offers: PluginOffer[] = []
  for (const item of listOf(v, 'available')) {
    const e = asObject(item)
    if (e === undefined) continue
    const id = label(e.pluginId)
    if (id === null) continue
    const parts = splitId(id)
    offers.push({
      id,
      name: label(e.name) ?? parts.name,
      marketplace: label(e.marketplaceName) ?? parts.marketplace,
      description: text(e.description, MAX_DESCRIPTION) ?? '',
      version: text(e.version, MAX_VERSION) || null,
      installs: typeof e.installCount === 'number' && Number.isFinite(e.installCount) && e.installCount >= 0 ? e.installCount : null
    })
  }
  return offers
}

/** `marketplace list --json`: each source named by what the person gave, a repository, a URL or a path */
export function parseMarketplaces(v: unknown): MarketplaceEntry[] {
  const markets: MarketplaceEntry[] = []
  for (const item of Array.isArray(v) ? v : []) {
    const e = asObject(item)
    if (e === undefined) continue
    const name = label(e.name)
    if (name === null) continue
    const source = sourceOf(e)
    if (source === null) continue
    markets.push({ name, source, installLocation: typeof e.installLocation === 'string' ? e.installLocation : null })
  }
  return markets
}

function sourceOf(e: Json): string | null {
  switch (e.source) {
    case 'github':
      return text(e.repo, MAX_SOURCE) || null
    case 'git':
    case 'url':
      return text(e.url, MAX_SOURCE) || null
    case 'directory':
    case 'file':
      return text(e.path, MAX_SOURCE) || null
    default:
      return null
  }
}

/** a marketplace.json's plugins by name: the version a catalog offers and its description */
export function parseCatalog(v: unknown): Map<string, { version: string | null; description: string }> {
  const catalog = new Map<string, { version: string | null; description: string }>()
  const plugins = asObject(v)?.plugins
  for (const item of Array.isArray(plugins) ? plugins : []) {
    const e = asObject(item)
    if (e === undefined) continue
    const name = label(e.name)
    if (name === null) continue
    catalog.set(name, { version: text(e.version, MAX_VERSION) || null, description: text(e.description, MAX_DESCRIPTION) ?? '' })
  }
  return catalog
}

/** `plugin configure <id> --json`: the required options that are not configured yet */
export function parseConfigure(v: unknown): PluginOption[] {
  const root = asObject(v)
  const schema = asObject(root?.schema)
  if (schema === undefined) return []
  const configured = Array.isArray(root?.configured) ? root.configured.filter((key): key is string => typeof key === 'string') : []
  const options: PluginOption[] = []
  for (const key of Object.keys(schema)) {
    const option = asObject(schema[key])
    if (label(key) === null || option === undefined || option.required !== true || configured.includes(key)) continue
    options.push({
      key,
      title: label(option.title) ?? key,
      description: text(option.description, MAX_DESCRIPTION) ?? '',
      sensitive: option.sensitive === true
    })
  }
  return options
}

/** the Plugins section for a tab in `folder`: its user plugins and those of the folder, the catalogs' updates and descriptions */
export function pluginsView(
  installed: InstalledEntry[],
  available: PluginOffer[],
  marketplaces: MarketplaceEntry[],
  catalogs: Map<string, Map<string, { version: string | null; description: string }>>,
  folder: string
): PluginsView {
  const matches = folderMatcher(folder)
  const applies = (p: InstalledEntry): boolean =>
    p.scope === 'user' || ((p.scope === 'project' || p.scope === 'local') && p.projectPath !== null && matches(p.projectPath))

  const plugins: PluginView[] = installed
    .filter(applies)
    .map((p) => {
      const catalog = catalogs.get(p.marketplace)?.get(p.name)
      const latest = catalog?.version ?? null
      return {
        id: p.id,
        name: p.name,
        marketplace: p.marketplace,
        version: p.version,
        scope: p.scope,
        enabled: p.enabled,
        update: latest !== null && p.version !== 'unknown' && latest !== p.version ? latest : null,
        description: catalog?.description ?? '',
        mcpServers: p.mcpServers,
        errors: p.errors
      }
    })
    .sort((a, b) => compare(a.name, b.name))

  const offers = available
    .map((o): PluginOffer => ({ ...o }))
    .sort((a, b) => compare(a.marketplace, b.marketplace) || compare(a.name, b.name))

  const markets: MarketplaceView[] = marketplaces
    .map((m) => ({ name: m.name, source: m.source }))
    .sort((a, b) => compare(a.name, b.name))

  return { installed: plugins, available: offers, marketplaces: markets }
}
