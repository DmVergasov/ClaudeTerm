import { win32 } from 'node:path'
import type { McpLiveServer } from '../chat/chat-engine'
import type { ChatHub } from '../chat/chat-hub'
import type { ChatLaunch } from '../chat/claude-spawn'
import type { McpAction, McpAddRequest, McpEditScope, McpReload, McpResult, McpScope, McpServerView, McpServersView, McpStatus, McpTransport, PluginAction, PluginOffer, PluginOption, PluginsView } from '../../shared/mcp'
import { marketplaceSource } from '../../shared/mcp'
import { isServerName, maskedConfig, maskText, maskUrl, maskUrls, parseAddInput, secretsOf, targetOf, type McpConfig, type McpOauth } from '../../shared/mcp-add'
import { isWindowsPath, nativePath, pathKey } from '../path-key'
import { CliError, cliMessage, jsonOutput, LOGIN_TIMEOUT_MS, runClaudeCli, type CliOptions, type CliRun } from './claude-cli'
import { parseAvailable, parseCatalog, parseConfigure, parseInstalled, parseMarketplaces, pluginsView, type InstalledEntry, type MarketplaceEntry } from './plugin-cli'
import { configPaths, readTabConfig, type ConfiguredServer, type ConfigPaths } from './mcp-config'

// The MCP · Plugins panel's backend for servers: what the running session or the configuration files say, the row actions,
// and adding servers from pasted text through Claude Code's own CLI. Nothing here writes a configuration file.

const NOT_RUNNING = 'Claude Code is not running in this tab'
const NOT_TAB = 'Not a Claude tab of this computer'
const GITHUB = 'This is a GitHub repository: add it as a plugin marketplace'
const UNCOPYABLE = "This server's configuration cannot be copied"
const MAX_NAME = 200
const MAX_ERROR = 2000
const MAX_TARGET = 2000
const MAX_TOOLS = 500
const LIVE_STATUSES = new Set<string>(['connected', 'failed', 'needs-auth', 'pending', 'disabled'])
const TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse', 'ws']
const LIST_TTL_MS = 30_000
const NO_LIST = 'Claude Code printed no plugin list'

export interface McpHubDeps {
  launch(): Promise<ChatLaunch>                                   // resolveChatLaunch(settings.claude.command, …)
  tab(tabId: string): Promise<{ env: Record<string, string>; folder: string } | null>   // a local Claude tab: claudeEnv and its canonical folder
  home: string
  readJson(file: string): Promise<unknown>                        // the shared jsonFileCache
  run: typeof runClaudeCli
  session: Pick<ChatHub, 'mcpStatus' | 'reconnectMcp' | 'toggleMcp'>
  reload(tabId: string): McpReload | null                         // the changes its session has not loaded (RestartCoordinator.waiting)
  changed(tabId: string, madeHere: boolean): void                 // the panel reloads; madeHere: this tab changed the configuration
  hold(tabId: string): void; release(tabId: string): void         // used by Task 10
  openPath(file: string): Promise<string>                         // shell.openPath: '' or its error
  copy(text: string): void
  log: { warn(m: string): void }
}

type Tab = { env: Record<string, string>; folder: string }
type Json = Record<string, unknown>
type Outcome = { run: CliRun } | { error: string }
type Catalog = ReturnType<typeof parseCatalog>
type Lists = { installed: InstalledEntry[]; available: PluginOffer[]; marketplaces: MarketplaceEntry[]; catalogs: Map<string, Catalog> }

export class McpHub {
  private readonly d: McpHubDeps
  /** the last configuration command of each config folder; the next one waits for it */
  private readonly queues = new Map<string, Promise<void>>()
  /** the sign-ins running per tab and server name, so cancel-login and a removed tab can end them */
  private readonly logins = new Map<string, Map<string, AbortController>>()
  /** the Cancels that came before their sign-in registered, per tab and server name: the next sign-in of that name answers Cancelled */
  private readonly cancels = new Map<string, Set<string>>()
  /** the plugin lists of each config folder, kept LIST_TTL_MS; any plugin action drops them */
  private readonly lists = new Map<string, { at: number; lists: Lists }>()

  constructor(d: McpHubDeps) {
    this.d = d
  }

  async servers(tabId: string): Promise<McpServersView | null> {
    const tab = await this.d.tab(tabId)
    if (tab === null) return null
    const [config, statuses] = await Promise.all([readTabConfig(this.paths(tab), tab.folder, this.d.readJson), this.statuses(tabId)])

    if (statuses === null) {
      const servers = config.servers.map((s) => configuredView(s, s.disabled ? 'disabled' : waiting(s) ? 'pending-approval' : 'configured'))
      return { live: false, servers, reload: null }
    }
    const live = (Array.isArray(statuses) ? statuses : []).filter((s): s is McpLiveServer => typeof s === 'object' && s !== null)
    const servers = live.map(liveView)
    const listed = new Set(servers.map((s) => s.name))
    for (const s of config.servers) {
      if (waiting(s) && !listed.has(s.name)) servers.push(configuredView(s, 'pending-approval'))
    }
    return { live: true, servers, reload: this.d.reload(tabId) }
  }

  async action(tabId: string, a: McpAction): Promise<McpResult> {
    // a sign-in and its Cancel do not wait for the tab lookup: a Cancel must always find the sign-in its window shows
    if (a.kind === 'login') return this.login(tabId, a.name)
    if (a.kind === 'cancel-login') return this.cancelLogin(tabId, a.name)
    const tab = await this.d.tab(tabId)
    if (tab === null) return fail(NOT_TAB)
    switch (a.kind) {
      case 'reconnect': {
        const name = a.name
        return this.inSession(tabId, () => this.d.session.reconnectMcp(tabId, name))
      }
      case 'toggle': {
        const { name, enabled } = a
        return this.inSession(tabId, () => this.d.session.toggleMcp(tabId, name, enabled))
      }
      case 'remove':
        return this.remove(tabId, tab, a.name, a.scope)
      case 'logout':
        return this.logout(tabId, tab, a.name)
      case 'copy-config':
        return this.copyConfig(tab, a.name, a.scope)
      case 'open-config':
        return this.openConfig(tab, a.scope)
    }
  }

  async add(tabId: string, req: McpAddRequest): Promise<McpResult> {
    const tab = await this.d.tab(tabId)
    if (tab === null) return fail(NOT_TAB)
    const parsed = parseAddInput(req.text)
    if (parsed.kind === 'github') return fail(GITHUB)
    if (parsed.kind === 'none') return fail(`Nothing to add: ${parsed.reason}`)
    const { servers } = parsed
    if (servers.length !== req.names.length) return fail('The names do not match the servers')
    if (!req.names.every((name) => isServerName(name))) return fail('Nothing to add: a name is not valid')
    if (new Set(req.names).size !== req.names.length) return fail('Two servers have the same name')

    const secret = req.clientSecret ?? ''
    const secrets = [...servers.flatMap((s) => secretsOf(s.config)), secret]
    const env = secret === '' ? tab.env : { ...tab.env, MCP_CLIENT_SECRET: secret }
    return this.queued(tab, async () => {
      const added: string[] = []
      for (const [i, server] of servers.entries()) {
        const name = req.names[i]
        const args = ['mcp', 'add-json', '--scope', req.scope, ...(secret === '' ? [] : ['--client-secret']), '--', name, JSON.stringify(server.config)]
        const result = await this.cli(tab, args, { secrets, env })
        if ('error' in result) {
          if (added.length > 0) this.d.changed(tabId, true)
          const prefix = added.length > 0 ? `Added ${added.join(', ')}. ` : ''
          return fail(`${prefix}Could not add ${name}: ${result.error}`)
        }
        added.push(name)
      }
      this.d.changed(tabId, true)
      return { ok: true }
    })
  }

  /** the Plugins section of a tab: its config folder's lists, read through the queue and kept LIST_TTL_MS; a failed list is its error */
  async plugins(tabId: string): Promise<PluginsView | { error: string } | null> {
    const tab = await this.d.tab(tabId)
    if (tab === null) return null
    return this.queued(tab, async () => {
      const key = this.folderKey(tab)
      const kept = this.lists.get(key)
      let lists: Lists
      if (kept !== undefined && Date.now() - kept.at < LIST_TTL_MS) {
        lists = kept.lists
      } else {
        const read = await this.readLists(tab)
        if ('error' in read) return read
        lists = read
        this.lists.set(key, { at: Date.now(), lists })
      }
      return pluginsView(lists.installed, lists.available, lists.marketplaces, lists.catalogs, tab.folder)
    })
  }

  /** a plugin or marketplace command, in the queue of the tab's config folder; the lists are read again after it */
  async pluginAction(tabId: string, a: PluginAction): Promise<McpResult> {
    const tab = await this.d.tab(tabId)
    if (tab === null) return fail(NOT_TAB)
    return this.queued(tab, () => {
      this.lists.delete(this.folderKey(tab))
      return this.pluginJob(tabId, tab, a)
    })
  }

  /** ends the sign-ins of a tab that closed; each of them answers Cancelled */
  removeTab(tabId: string): void {
    for (const controller of this.logins.get(tabId)?.values() ?? []) controller.abort()
    this.logins.delete(tabId)
    this.cancels.delete(tabId)
  }

  /** the app quits: every sign-in ends with Cancelled, so no `claude mcp login` outlives ClaudeTerm */
  dispose(): void {
    for (const tabId of [...this.logins.keys()]) this.removeTab(tabId)
  }

  private paths(tab: Tab): ConfigPaths {
    return configPaths(tab.env, this.d.home, tab.folder)
  }

  /** the session's statuses; null when no session runs in the tab */
  private async statuses(tabId: string): Promise<McpLiveServer[] | null> {
    try {
      return await this.d.session.mcpStatus(tabId)
    } catch {
      return null
    }
  }

  /** a session command: it needs a running session, and a success is a change of this tab's servers */
  private async inSession(tabId: string, job: () => Promise<void>): Promise<McpResult> {
    if ((await this.statuses(tabId)) === null) return fail(NOT_RUNNING)
    try {
      await job()
    } catch (error) {
      return fail(errorText(error))
    }
    this.d.changed(tabId, false)
    return { ok: true }
  }

  private async reconnectQuietly(tabId: string, name: string): Promise<void> {
    if ((await this.statuses(tabId)) === null) return
    try {
      await this.d.session.reconnectMcp(tabId, name)
    } catch {
      // the panel shows the server's state on its next read
    }
  }

  private remove(tabId: string, tab: Tab, name: string, scope: McpEditScope): Promise<McpResult> {
    return this.queued(tab, async () => {
      const result = await this.cli(tab, ['mcp', 'remove', '--scope', scope, '--', name], { secrets: [] })
      if ('error' in result) return fail(result.error)
      this.d.changed(tabId, true)
      return { ok: true }
    })
  }

  private logout(tabId: string, tab: Tab, name: string): Promise<McpResult> {
    return this.queued(tab, async () => {
      const result = await this.cli(tab, ['mcp', 'logout', '--', name], { secrets: [] })
      if ('error' in result) return fail(result.error)
      await this.reconnectQuietly(tabId, name)
      this.d.changed(tabId, false)
      return { ok: true }
    })
  }

  /** a Cancel ends the sign-in running for the name; one that finds none is remembered for the next sign-in of that name */
  private cancelLogin(tabId: string, name: string): McpResult {
    const running = this.logins.get(tabId)?.get(name)
    if (running !== undefined) {
      running.abort()
    } else {
      const early = this.cancels.get(tabId) ?? new Set<string>()
      early.add(name)
      this.cancels.set(tabId, early)
    }
    return { ok: true }
  }

  /** beside the queue: a sign-in waits for the browser, so it must not hold up the other commands. It registers before its tab lookup. */
  private async login(tabId: string, name: string): Promise<McpResult> {
    const controller = new AbortController()
    const mine = this.logins.get(tabId) ?? new Map<string, AbortController>()
    mine.set(name, controller)
    this.logins.set(tabId, mine)
    if (this.cancels.get(tabId)?.delete(name)) controller.abort()
    try {
      const tab = await this.d.tab(tabId)
      if (tab === null) return fail(NOT_TAB)
      if (controller.signal.aborted) return fail('Cancelled')
      const result = await this.cli(tab, ['mcp', 'login', '--', name], { secrets: [], timeoutMs: LOGIN_TIMEOUT_MS, signal: controller.signal })
      if ('error' in result) return fail(result.error)
      await this.reconnectQuietly(tabId, name)
      this.d.changed(tabId, false)
      return { ok: true }
    } finally {
      if (mine.get(name) === controller) mine.delete(name)
      if (mine.size === 0 && this.logins.get(tabId) === mine) this.logins.delete(tabId)
    }
  }

  private async copyConfig(tab: Tab, name: string, scope: McpEditScope): Promise<McpResult> {
    const config = await readTabConfig(this.paths(tab), tab.folder, this.d.readJson)
    const server = config.servers.find((s) => s.name === name && s.scope === scope)
    if (server === undefined) return fail('No such server in this scope')
    const mcp = mcpConfigOf(server.config)
    if (mcp === null) return fail(UNCOPYABLE)
    this.d.copy(JSON.stringify({ [name]: maskedConfig(mcp) }, null, 2))
    return { ok: true }
  }

  private async openConfig(tab: Tab, scope: McpEditScope): Promise<McpResult> {
    const paths = this.paths(tab)
    const file = scope === 'project' ? paths.projectMcp : paths.userConfig
    try {
      const error = await this.d.openPath(file)
      return error === '' ? { ok: true } : fail(error)
    } catch (error) {
      return fail(errorText(error))
    }
  }

  /** a plugin command: the install's options are asked after it, a configure sends its values on stdin */
  private async pluginJob(tabId: string, tab: Tab, a: PluginAction): Promise<McpResult> {
    switch (a.kind) {
      case 'install': {
        const result = await this.cli(tab, ['plugin', 'install', '--scope', 'user', '--', a.id], { secrets: [] })
        if ('error' in result) return fail(result.error)
        // a failed options read leaves none to ask: the plugin is installed either way
        const asked = await this.cli(tab, ['plugin', 'configure', '--json', '--', a.id], { secrets: [] })
        const options: PluginOption[] = 'error' in asked ? [] : parseConfigure(jsonOutput(asked.run.stdout))
        if (options.length > 0) this.d.hold(tabId)
        this.d.changed(tabId, true)
        return options.length > 0 ? { ok: true, options } : { ok: true }
      }
      case 'configure': {
        const result = await this.cli(tab, ['plugin', 'configure', '--values-stdin', '--', a.id], {
          secrets: Object.values(a.values).filter((value) => value !== ''),
          stdin: JSON.stringify(a.values)
        })
        if ('error' in result) return fail(result.error)
        this.d.release(tabId)
        this.d.changed(tabId, true)
        return { ok: true }
      }
      case 'configure-later':
        this.d.release(tabId)
        return { ok: true }
      case 'uninstall':
      case 'enable':
      case 'disable':
      case 'update': {
        const result = await this.cli(tab, ['plugin', a.kind, '--', a.id], { secrets: [] })
        if ('error' in result) return fail(result.error)
        this.d.changed(tabId, true)
        return { ok: true }
      }
      case 'marketplace-add':
        return this.marketplaceAdd(tabId, tab, a.source)
      case 'marketplace-remove':
      case 'marketplace-update': {
        const result = await this.cli(tab, ['plugin', 'marketplace', a.kind === 'marketplace-remove' ? 'remove' : 'update', '--', a.name], { secrets: [] })
        if ('error' in result) return fail(result.error)
        this.d.changed(tabId, true)
        return { ok: true }
      }
    }
  }

  /** the marketplace named by the source: the one the list has after the add and not before it */
  private async marketplaceAdd(tabId: string, tab: Tab, source: string): Promise<McpResult> {
    const named = marketplaceSource(source)
    if (named === null) return fail('Nothing to add: the source is not valid')
    const before = await this.marketplaceList(tab)
    if ('error' in before) return fail(before.error)
    const added = await this.cli(tab, ['plugin', 'marketplace', 'add', '--', named], { secrets: [] })
    if ('error' in added) return fail(added.error)
    this.d.changed(tabId, true)
    const after = await this.marketplaceList(tab)
    const marketplace = 'error' in after ? undefined : after.markets.find((m) => !before.markets.some((b) => b.name === m.name))?.name
    return marketplace === undefined ? { ok: true } : { ok: true, marketplace }
  }

  /** `plugin marketplace list --json` of the tab's config folder: the marketplaces, or the error */
  private async marketplaceList(tab: Tab): Promise<{ markets: MarketplaceEntry[] } | { error: string }> {
    const result = await this.cli(tab, ['plugin', 'marketplace', 'list', '--json'], { secrets: [] })
    if ('error' in result) return result
    const json = jsonOutput(result.run.stdout)
    if (json === undefined) return { error: cliMessage(result.run) || NO_LIST }
    return { markets: parseMarketplaces(json) }
  }

  /** the installed and available plugins and the marketplaces with their catalogs; a failed list is the error */
  private async readLists(tab: Tab): Promise<Lists | { error: string }> {
    const list = await this.cli(tab, ['plugin', 'list', '--json', '--available'], { secrets: [] })
    if ('error' in list) return list
    const json = jsonOutput(list.run.stdout)
    if (json === undefined) return { error: cliMessage(list.run) || NO_LIST }
    const markets = await this.marketplaceList(tab)
    if ('error' in markets) return markets
    const catalogs = new Map<string, Catalog>()
    for (const market of markets.markets) {
      if (market.installLocation !== null) catalogs.set(market.name, parseCatalog(await this.catalogOf(market.installLocation)))
    }
    return { installed: parseInstalled(json), available: parseAvailable(json), marketplaces: markets.markets, catalogs }
  }

  /** a marketplace's catalog file, read as the configuration files are; null when it cannot be read */
  private async catalogOf(installLocation: string): Promise<unknown> {
    try {
      return await this.d.readJson((isWindowsPath(installLocation) ? win32 : nativePath).join(installLocation, '.claude-plugin', 'marketplace.json'))
    } catch {
      return null
    }
  }

  /** the config folder's key: its queue and its plugin lists */
  private folderKey(tab: Tab): string {
    const dir = tab.env.CLAUDE_CONFIG_DIR || this.d.home
    return pathKey(dir, isWindowsPath(dir) ? win32 : nativePath)
  }

  /** one configuration command at a time per config folder; the queue key is the folder's pathKey */
  private queued<T>(tab: Tab, job: () => Promise<T>): Promise<T> {
    const key = this.folderKey(tab)
    const run = (this.queues.get(key) ?? Promise.resolve()).then(job)
    const tail = run.then(() => undefined, () => undefined)
    this.queues.set(key, tail)
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    return run
  }

  /** one `claude` call: the answer, or the masked error text. Nothing is logged but the first two arguments and the exit code */
  private async cli(tab: Tab, args: string[], o: { secrets: string[]; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; stdin?: string }): Promise<Outcome> {
    const masked = (text: string): string => maskText(text, o.secrets).slice(0, MAX_ERROR)
    try {
      const launch = await this.d.launch()
      if (launch.how === 'none') return { error: launch.reason }
      const options: CliOptions = { cwd: tab.folder, env: o.env ?? tab.env, timeoutMs: o.timeoutMs, signal: o.signal, stdin: o.stdin }
      const run = await this.d.run(launch, args, options)
      if (run.code === 0) return { run }
      this.d.log.warn(`claude ${args[0]} ${args[1]} failed (${run.code})`)
      // the secrets leave the whole output before its message is cut: a cut must not leave the start of a secret in clear
      const shown = { code: run.code, stdout: maskText(run.stdout, o.secrets), stderr: maskText(run.stderr, o.secrets) }
      return { error: masked(cliMessage(shown)) || `Claude Code exited with code ${run.code}` }
    } catch (error) {
      this.d.log.warn(`claude ${args[0]} ${args[1]} failed (${error instanceof CliError ? error.reason : 'error'})`)
      return { error: masked(errorText(error)) }
    }
  }
}

function fail(error: string): McpResult {
  return { ok: false, error: error.slice(0, MAX_ERROR) }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function waiting(s: ConfiguredServer): boolean {
  return s.scope === 'project' && (s.approval === 'pending' || s.approval === 'rejected')
}

function liveScope(s: McpLiveServer): McpScope {
  if (s.source === 'plugin') return 'plugin'
  if (s.scope === 'user' || s.scope === 'project' || s.scope === 'local') return s.scope
  if (s.scope === 'claudeai') return 'claudeai'
  if (s.scope === 'managed' || s.scope === 'enterprise') return 'managed'
  return 'other'
}

function transportOf(value: unknown): McpTransport {
  return TRANSPORTS.find((t) => t === value) ?? 'other'
}

function liveView(s: McpLiveServer): McpServerView {
  const name = text(s.name, MAX_NAME)
  const scope = liveScope(s)
  const target = text(s.target, MAX_TARGET)
  return {
    name,
    status: LIVE_STATUSES.has(s.status) ? (s.status as McpStatus) : 'failed',
    scope,
    plugin: scope === 'plugin' ? (/^plugin:([^:]+):/.exec(name)?.[1] ?? null) : null,
    transport: transportOf(s.transport),
    target: /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? maskUrl(target) : target,
    tools: Array.isArray(s.tools) ? s.tools.filter((t): t is string => typeof t === 'string').slice(0, MAX_TOOLS).map((t) => t.slice(0, MAX_NAME)) : [],
    error: typeof s.error === 'string' ? maskUrls(s.error).slice(0, MAX_ERROR) : null,
    version: typeof s.version === 'string' ? s.version.slice(0, MAX_NAME) : null
  }
}

function configuredView(s: ConfiguredServer, status: McpStatus): McpServerView {
  const mcp = mcpConfigOf(s.config)
  return {
    name: s.name.slice(0, MAX_NAME),
    status,
    scope: s.scope,
    plugin: null,
    transport: mcp === null ? 'other' : transportOf(mcp.type),
    target: mcp === null ? '' : targetOf(mcp),
    tools: [],
    error: null,
    version: null
  }
}

/** a configuration entry as an McpConfig: stdio with a command, http or sse with a url; null for anything else */
function mcpConfigOf(raw: Json): McpConfig | null {
  const declared = raw.type ?? (typeof raw.command === 'string' ? 'stdio' : 'http')
  const oauth = oauthOf(raw.oauth)
  if (declared === 'stdio' && typeof raw.command === 'string') {
    return { type: 'stdio', command: raw.command, args: strings(raw.args), env: records(raw.env), ...(oauth ? { oauth } : {}) }
  }
  if ((declared === 'http' || declared === 'sse') && typeof raw.url === 'string') {
    return { type: declared, url: raw.url, headers: records(raw.headers), ...(oauth ? { oauth } : {}) }
  }
  return null
}

function oauthOf(value: unknown): McpOauth | undefined {
  if (!isRecord(value)) return undefined
  const oauth: McpOauth = {}
  if (typeof value.clientId === 'string') oauth.clientId = value.clientId
  if (typeof value.callbackPort === 'number') oauth.callbackPort = value.callbackPort
  return oauth
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function records(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}
