import { win32 } from 'node:path'
import type { McpLiveServer } from '../chat/chat-engine'
import type { ChatHub } from '../chat/chat-hub'
import type { ChatLaunch } from '../chat/claude-spawn'
import type { McpAction, McpAddRequest, McpEditScope, McpResult, McpScope, McpServerView, McpServersView, McpStatus, McpTransport } from '../../shared/mcp'
import { isServerName, maskedConfig, maskText, maskUrl, parseAddInput, secretsOf, targetOf, type McpConfig, type McpOauth } from '../../shared/mcp-add'
import { isWindowsPath, nativePath, pathKey } from '../path-key'
import { CliError, cliMessage, LOGIN_TIMEOUT_MS, runClaudeCli, type CliOptions, type CliRun } from './claude-cli'
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

export interface McpHubDeps {
  launch(): Promise<ChatLaunch>                                   // resolveChatLaunch(settings.claude.command, …)
  tab(tabId: string): Promise<{ env: Record<string, string>; folder: string } | null>   // a local Claude tab: claudeEnv and its canonical folder
  home: string
  readJson(file: string): Promise<unknown>                        // the shared jsonFileCache
  run: typeof runClaudeCli
  session: Pick<ChatHub, 'mcpStatus' | 'reconnectMcp' | 'toggleMcp'>
  changed(tabId: string, madeHere: boolean): void                 // the panel reloads; madeHere: this tab changed the configuration
  hold(tabId: string): void; release(tabId: string): void         // used by Task 10
  openPath(file: string): Promise<string>                         // shell.openPath: '' or its error
  copy(text: string): void
  log: { warn(m: string): void }
}

type Tab = { env: Record<string, string>; folder: string }
type Json = Record<string, unknown>
type Outcome = { run: CliRun } | { error: string }

export class McpHub {
  private readonly d: McpHubDeps
  /** the last configuration command of each config folder; the next one waits for it */
  private readonly queues = new Map<string, Promise<void>>()
  /** the sign-ins running per tab and server name, so cancel-login and a removed tab can end them */
  private readonly logins = new Map<string, Map<string, AbortController>>()

  constructor(d: McpHubDeps) {
    this.d = d
  }

  async servers(tabId: string): Promise<McpServersView | null> {
    const tab = await this.d.tab(tabId)
    if (tab === null) return null
    const [config, statuses] = await Promise.all([readTabConfig(this.paths(tab), tab.folder, this.d.readJson), this.statuses(tabId)])

    if (statuses === null) {
      const servers = config.servers.map((s) => configuredView(s, s.disabled ? 'disabled' : waiting(s) ? 'pending-approval' : 'configured'))
      return { live: false, servers }
    }
    const live = (Array.isArray(statuses) ? statuses : []).filter((s): s is McpLiveServer => typeof s === 'object' && s !== null)
    const servers = live.map(liveView)
    const listed = new Set(servers.map((s) => s.name))
    for (const s of config.servers) {
      if (waiting(s) && !listed.has(s.name)) servers.push(configuredView(s, 'pending-approval'))
    }
    return { live: true, servers }
  }

  async action(tabId: string, a: McpAction): Promise<McpResult> {
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
      case 'login':
        return this.login(tabId, tab, a.name)
      case 'cancel-login':
        this.logins.get(tabId)?.get(a.name)?.abort()
        return { ok: true }
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

  /** ends the sign-ins of a tab that closed; each of them answers Cancelled */
  removeTab(tabId: string): void {
    for (const controller of this.logins.get(tabId)?.values() ?? []) controller.abort()
    this.logins.delete(tabId)
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

  /** beside the queue: a sign-in waits for the browser, so it must not hold up the other commands */
  private async login(tabId: string, tab: Tab, name: string): Promise<McpResult> {
    const controller = new AbortController()
    const mine = this.logins.get(tabId) ?? new Map<string, AbortController>()
    mine.set(name, controller)
    this.logins.set(tabId, mine)
    try {
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

  /** one configuration command at a time per config folder; the queue key is the folder's pathKey */
  private queued(tab: Tab, job: () => Promise<McpResult>): Promise<McpResult> {
    const dir = tab.env.CLAUDE_CONFIG_DIR || this.d.home
    const key = pathKey(dir, isWindowsPath(dir) ? win32 : nativePath)
    const run = (this.queues.get(key) ?? Promise.resolve()).then(job)
    const tail = run.then(() => undefined, () => undefined)
    this.queues.set(key, tail)
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key)
    })
    return run
  }

  /** one `claude` call: the answer, or the masked error text. Nothing is logged but the first two arguments and the exit code */
  private async cli(tab: Tab, args: string[], o: { secrets: string[]; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }): Promise<Outcome> {
    const masked = (text: string): string => maskText(text, o.secrets).slice(0, MAX_ERROR)
    try {
      const launch = await this.d.launch()
      if (launch.how === 'none') return { error: launch.reason }
      const options: CliOptions = { cwd: tab.folder, env: o.env ?? tab.env, timeoutMs: o.timeoutMs, signal: o.signal }
      const run = await this.d.run(launch, args, options)
      if (run.code === 0) return { run }
      this.d.log.warn(`claude ${args[0]} ${args[1]} failed (${run.code})`)
      return { error: masked(cliMessage(run)) || `Claude Code exited with code ${run.code}` }
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
    error: typeof s.error === 'string' ? s.error.slice(0, MAX_ERROR) : null,
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
