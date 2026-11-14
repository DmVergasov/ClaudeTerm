import type { Stats } from 'node:fs'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CarryItem, CarryLine, CarryLineItem } from '../shared/accounts'
import {
  ITEM_PATHS,
  addTrust,
  carriedSettings,
  countHooks,
  hooksOf,
  mergeSettings,
  pluginPlan,
  serverSecrets,
  userServers,
  withHooks,
  type FolderItem
} from './account-carry'
import { cliMessage, jsonOutput, type CliRun } from './mcp/claude-cli'
import { canonicalOf, copyTree, writeAtomic, type CopyGuard } from './account-copy'

export { copyTree }

/** a file over this size is not read: a config file of a few kilobytes never comes near it */
export const MAX_CONFIG_BYTES = 16 * 1024 * 1024
/** what a secret shows as in a message */
export const MASK = '••••••••'

type Obj = Record<string, unknown>

/** a config folder of the source: its settings and the .claude.json the account's state is read from */
export interface SourceFolder {
  configDir: string
  claudeJson: string
}

export interface CarryDeps {
  source: SourceFolder
  sourceName: string
  target: { id: string; name: string; folder: string }
  /** runs `claude <args>` with the account's environment */
  cli(args: string[]): Promise<CliRun>
  log: { warn(m: string): void }
}

interface SourceConfigs {
  settings: unknown
  claudeJson: unknown
  installed: unknown
  known: unknown
}

type Text = { state: 'missing' } | { state: 'unreadable' } | { state: 'read'; text: string }
type Parsed = { state: 'missing' } | { state: 'unreadable' } | { state: 'ok'; value: unknown }

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** every occurrence of each non-empty secret, longest first, replaced by MASK */
export function maskText(text: string, secrets: string[]): string {
  let masked = text
  const longest = secrets.filter((secret) => secret !== '').sort((a, b) => b.length - a.length)
  for (const secret of longest) masked = masked.split(secret).join(MASK)
  return masked
}

/** a run with each secret masked in its output, plain and JSON-escaped: masking comes before cliMessage cuts the text */
function maskedRun(run: CliRun, secrets: string[]): CliRun {
  const forms = secrets.flatMap((secret) => {
    const escaped = JSON.stringify(secret).slice(1, -1)
    return escaped === secret ? [secret] : [secret, escaped]
  })
  return { ...run, stdout: maskText(run.stdout, forms), stderr: maskText(run.stderr, forms) }
}

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function line(item: CarryLineItem, state: CarryLine['state'], text: string, subs: string[] = []): CarryLine {
  return { item, state, text, subs }
}

/** a file's text: missing, unreadable (not a file, over MAX_CONFIG_BYTES, or it cannot be read), or read */
async function readText(file: string): Promise<Text> {
  let info: Stats
  try {
    info = await stat(file)
  } catch (error) {
    return isNotFound(error) ? { state: 'missing' } : { state: 'unreadable' }
  }
  if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return { state: 'unreadable' }
  try {
    return { state: 'read', text: await readFile(file, 'utf8') }
  } catch {
    return { state: 'unreadable' }
  }
}

/** a JSON file: its value, missing, or unreadable (not JSON counts as unreadable) */
async function parseJsonFile(file: string): Promise<Parsed> {
  const text = await readText(file)
  if (text.state !== 'read') return text
  try {
    return { state: 'ok', value: JSON.parse(text.text) as unknown }
  } catch {
    return { state: 'unreadable' }
  }
}

/** a JSON file of the source: its value, or null when it is missing, unreadable or not JSON */
async function readJsonOf(file: string): Promise<unknown> {
  const parsed = await parseJsonFile(file)
  return parsed.state === 'ok' ? parsed.value : null
}

async function readConfigs(source: SourceFolder): Promise<SourceConfigs> {
  return {
    settings: await readJsonOf(join(source.configDir, 'settings.json')),
    claudeJson: await readJsonOf(source.claudeJson),
    installed: await readJsonOf(join(source.configDir, 'plugins', 'installed_plugins.json')),
    known: await readJsonOf(join(source.configDir, 'plugins', 'known_marketplaces.json'))
  }
}

/** the source's settings: its object, {} when missing; null when it cannot be read or is not an object (the item fails, nothing is written) */
async function sourceSettings(d: CarryDeps): Promise<Obj | null> {
  const parsed = await parseJsonFile(join(d.source.configDir, 'settings.json'))
  if (parsed.state === 'missing') return {}
  if (parsed.state === 'ok' && isObject(parsed.value)) return parsed.value
  return null
}

/** the files under a path that a copy would copy: a symlink counts as one, a folder counts its files */
async function countFiles(path: string): Promise<number> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return 1
    if (info.isFile()) return 1
    if (!info.isDirectory()) return 0
    let count = 0
    for (const name of await readdir(path)) count += await countFiles(join(path, name))
    return count
  } catch {
    return 0
  }
}

/** the source's configs and the files of each folder item; reads only, a broken file is null (or 0 files) */
export async function readSource(s: SourceFolder): Promise<{ settings: unknown; claudeJson: unknown; installed: unknown; known: unknown; files: Record<FolderItem, number> }> {
  const configs = await readConfigs(s)
  const files = {} as Record<FolderItem, number>
  for (const item of Object.keys(ITEM_PATHS) as FolderItem[]) {
    let count = 0
    for (const path of ITEM_PATHS[item]) count += await countFiles(join(s.configDir, path.replace(/\/+$/, '')))
    files[item] = count
  }
  return { ...configs, files }
}

/** the account's settings.json for a write: its object, {} when missing; null when it cannot be read or is not an object */
async function accountSettings(file: string): Promise<Obj | null> {
  const text = await readText(file)
  if (text.state === 'unreadable') return null
  if (text.state === 'missing') return {}
  try {
    const value = JSON.parse(text.text) as unknown
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

async function carrySettings(d: CarryDeps): Promise<CarryLine> {
  const source = await sourceSettings(d)
  if (source === null) return line('settings', 'failed', `settings.json of ${d.sourceName} cannot be read`)
  const file = join(d.target.folder, 'settings.json')
  const current = await accountSettings(file)
  if (current === null) return line('settings', 'failed', `settings.json of ${d.target.name} cannot be read: left as it was`)
  const carried = carriedSettings(source)
  await writeAtomic(file, JSON.stringify(mergeSettings(current, carried), null, 2) + '\n')
  return line('settings', 'done', counted(Object.keys(carried).length, 'setting', 'settings'))
}

async function carryHooks(d: CarryDeps): Promise<CarryLine> {
  const source = await sourceSettings(d)
  if (source === null) return line('hooks', 'failed', `settings.json of ${d.sourceName} cannot be read`)
  const file = join(d.target.folder, 'settings.json')
  const current = await accountSettings(file)
  if (current === null) return line('hooks', 'failed', `settings.json of ${d.target.name} cannot be read: left as it was`)
  const hooks = hooksOf(source) ?? {}
  await writeAtomic(file, JSON.stringify(withHooks(current, hooks), null, 2) + '\n')
  return line('hooks', 'done', counted(countHooks(hooks), 'hook', 'hooks'))
}

async function carryFolders(item: FolderItem, d: CarryDeps): Promise<CarryLine> {
  const source = await canonicalOf(d.source.configDir)
  // every path any item carries, as written and never resolved (the source is canonical already): a link into the
  // source is copied only from inside one of them, and an item path that is itself a link must not widen the set
  const carried = Object.values(ITEM_PATHS).flat().map((path) => join(source, path.replace(/\/+$/, '')))
  const claudeJson = await canonicalOf(d.source.claudeJson)
  const notes: string[] = []
  let files = 0
  for (const path of ITEM_PATHS[item]) {
    const rel = path.replace(/\/+$/, '')
    const guard: CopyGuard = { source, claudeJson, carried, sourceName: d.sourceName, at: '', notes }
    files += await copyTree(join(d.source.configDir, rel), join(d.target.folder, rel), guard)
  }
  return line(item, 'done', counted(files, 'file', 'files'), notes)
}

async function carryMcp(d: CarryDeps): Promise<CarryLine> {
  const servers = userServers((await readConfigs(d.source)).claudeJson)
  let added = 0
  let failure: { name: string; message: string } | null = null
  for (const server of servers) {
    await d.cli(['mcp', 'remove', '--scope', 'user', '--', server.name])
    const run = await d.cli(['mcp', 'add-json', '--scope', 'user', '--', server.name, JSON.stringify(server.config)])
    if (run.code === 0) {
      added++
      continue
    }
    d.log.warn(`claude mcp add-json failed for ${server.name} (${run.code})`)
    failure ??= { name: server.name, message: cliMessage(maskedRun(run, serverSecrets(server.config))) }
  }
  if (failure !== null) return line('mcp', 'failed', `${added} of ${servers.length} · ${failure.name}: ${failure.message}`)
  return line('mcp', 'done', `${added} added`)
}

/** the names of the marketplaces `claude plugin marketplace list --json` answers; an entry without a name is skipped */
function parseMarketplaces(json: unknown): Set<string> {
  const names = new Set<string>()
  for (const entry of Array.isArray(json) ? (json as unknown[]) : []) {
    if (isObject(entry) && typeof entry.name === 'string' && entry.name !== '') names.add(entry.name)
  }
  return names
}

/** the ids of the plugins installed for the user scope in `claude plugin list --json`; an entry without an id or scope is skipped */
function parseInstalled(json: unknown): Set<string> {
  const ids = new Set<string>()
  for (const entry of Array.isArray(json) ? (json as unknown[]) : []) {
    if (isObject(entry) && typeof entry.id === 'string' && entry.scope === 'user') ids.add(entry.id)
  }
  return ids
}

/** a confirmation the install asked for (`--json` names it, or the message says --accept-command) */
function needsConfirmation(run: CliRun): boolean {
  const value = jsonOutput(run.stdout)
  return (isObject(value) && value.needsConfirmation === true) || cliMessage(run).includes('--accept-command')
}

async function carryPlugins(d: CarryDeps): Promise<CarryLine> {
  const source = await sourceSettings(d)
  if (source === null) return line('plugins', 'failed', `settings.json of ${d.sourceName} cannot be read`)
  const configs = await readConfigs(d.source)
  const plan = pluginPlan(configs.installed, configs.known, source)

  const listed = await d.cli(['plugin', 'marketplace', 'list', '--json'])
  if (listed.code !== 0) return line('plugins', 'failed', cliMessage(listed))
  const known = parseMarketplaces(jsonOutput(listed.stdout))
  const installedRun = await d.cli(['plugin', 'list', '--json'])
  if (installedRun.code !== 0) return line('plugins', 'failed', cliMessage(installedRun))
  const owned = parseInstalled(jsonOutput(installedRun.stdout))

  const subs: string[] = []
  const hosted = new Set<string>()
  for (const market of plan.marketplaces) {
    if (market.source !== null) continue
    hosted.add(market.name)
    subs.push(`${market.name}: hosted by claude.ai for ${d.sourceName}`)
  }

  // the marketplaces the plugins come from are added first; one that fails to add takes its plugins down with it
  const usable = new Set<string>()
  let failure: { id: string; message: string } | null = null
  for (const market of plan.marketplaces) {
    if (market.source === null) continue
    if (known.has(market.name)) {
      usable.add(market.name)
      continue
    }
    const added = await d.cli(['plugin', 'marketplace', 'add', '--', market.source])
    if (added.code === 0) usable.add(market.name)
    else failure ??= { id: market.name, message: cliMessage(added) }
  }

  let done = 0
  let skipped = 0
  const installedNow = new Set<string>()
  for (const plugin of plan.plugins) {
    if (hosted.has(plugin.marketplace)) {
      skipped++
      continue
    }
    if (!usable.has(plugin.marketplace)) continue
    if (owned.has(plugin.id)) {
      done++
      installedNow.add(plugin.id)
      continue
    }
    const run = await d.cli(['plugin', 'install', '--scope', 'user', '--json', '--', plugin.id])
    if (run.code === 0) {
      done++
      installedNow.add(plugin.id)
    } else if (needsConfirmation(run)) {
      skipped++
      subs.push(`${plugin.name}: its marketplace runs a command to install it — install it from MCP · Plugins in a chat on ${d.target.name}`)
    } else {
      failure ??= { id: plugin.id, message: cliMessage(run) }
    }
  }

  // the plugins that are off in the source are turned off after the installs
  for (const plugin of plan.plugins) {
    if (plugin.enabled || !installedNow.has(plugin.id)) continue
    const run = await d.cli(['plugin', 'disable', '--scope', 'user', '--', plugin.id])
    if (run.code !== 0) failure ??= { id: plugin.id, message: cliMessage(run) }
  }

  const total = plan.plugins.length
  if (failure !== null) return line('plugins', 'failed', `${done} of ${total} · ${failure.id}: ${failure.message}`)
  if (skipped > 0) return line('plugins', 'skipped', `${done} of ${total} installed · ${skipped} skipped`, subs)
  return line('plugins', 'done', `${done} installed`)
}

/** the folders the source trusts: the keys of its projects whose flag is true */
function trustedFolders(claudeJson: unknown): string[] {
  if (!isObject(claudeJson) || !isObject(claudeJson.projects)) return []
  return Object.entries(claudeJson.projects)
    .filter(([, entry]) => isObject(entry) && entry.hasTrustDialogAccepted === true)
    .map(([folder]) => folder)
}

async function carryTrust(d: CarryDeps): Promise<CarryLine> {
  const folders = trustedFolders(await readJsonOf(d.source.claudeJson))
  const file = join(d.target.folder, '.claude.json')
  // a fresh read: the CLI items above have changed this file
  const text = await readText(file)
  const unreadable = line('trust', 'failed', `.claude.json of ${d.target.name} cannot be read: left as it was`)
  if (text.state === 'unreadable') return unreadable
  let updated: string | null
  try {
    updated = addTrust(text.state === 'read' ? text.text : null, folders)
  } catch {
    return unreadable
  }
  if (updated !== null) await writeAtomic(file, updated)
  return line('trust', 'done', counted(folders.length, 'folder', 'folders'))
}

/** carries one ticked item into the target folder; a failure is that item's line, never a throw */
export async function carryItem(item: CarryItem, d: CarryDeps): Promise<CarryLine> {
  try {
    switch (item) {
      case 'settings':
        return await carrySettings(d)
      case 'hooks':
        return await carryHooks(d)
      case 'mcp':
        return await carryMcp(d)
      case 'plugins':
        return await carryPlugins(d)
      case 'trust':
        return await carryTrust(d)
      default:
        return await carryFolders(item, d)
    }
  } catch (error) {
    return line(item, 'failed', error instanceof Error ? error.message : String(error))
  }
}
