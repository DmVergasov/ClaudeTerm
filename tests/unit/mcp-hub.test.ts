import { describe, expect, it, vi } from 'vitest'
import type { McpLiveServer } from '../../src/main/chat/chat-engine'
import type { ChatLaunch } from '../../src/main/chat/claude-spawn'
import { CliError, LOGIN_TIMEOUT_MS, type CliOptions, type CliRun } from '../../src/main/mcp/claude-cli'
import { configPaths, type ConfigPaths } from '../../src/main/mcp/mcp-config'
import { McpHub } from '../../src/main/mcp/mcp-hub'
import type { PluginAction } from '../../src/shared/mcp'
import { MASK } from '../../src/shared/mcp-add'

const HOME = 'C:\\Users\\Dana'
const FOLDER = 'C:\\Work\\Acme'
const ENV = { CLAUDE_CONFIG_DIR: 'C:\\Config' }
const TAB = 'tab-1'
const LAUNCH: ChatLaunch = { how: 'direct', file: 'C:\\Program Files\\Claude\\claude.exe' }
const NOT_RUNNING = 'Claude Code is not running in this tab'
const NOT_TAB = 'Not a Claude tab of this computer'
const PLUGIN = 'ci-watch@acme-tools'
const MARKET_DIR = 'C:\\Config\\plugins\\marketplaces\\acme-tools'
const MARKET_FILE = `${MARKET_DIR}\\.claude-plugin\\marketplace.json`
const LIST = ['plugin', 'list', '--json', '--available']
const MARKETS = ['plugin', 'marketplace', 'list', '--json']

interface Rec { args: string[]; o: CliOptions }
type Reply = (args: string[], o: CliOptions) => Promise<CliRun>

/** the hub with fakes for every dependency; the configuration files are keyed by the paths the hub reads */
function setup(o: Partial<{
  live: McpLiveServer[] | null
  files: Partial<Record<keyof ConfigPaths, unknown>>
  reply: Reply
  launch: ChatLaunch
  launchError: string
  openError: string
  json: Record<string, unknown>   // more files, by their full path
}> = {}) {
  const paths = configPaths(ENV, HOME, FOLDER)
  const files = new Map<string, unknown>()
  for (const [key, value] of Object.entries(o.files ?? {})) files.set(paths[key as keyof ConfigPaths], value)
  for (const [file, value] of Object.entries(o.json ?? {})) files.set(file, value)
  const runs: Rec[] = []
  const reconnects: string[] = []
  const toggles: [string, boolean][] = []
  const changed: [string, boolean][] = []
  const order: string[] = []   // the restart holds, releases and changes, in the order they happen
  const copied: string[] = []
  const opened: string[] = []
  const warns: string[] = []
  const reply: Reply = o.reply ?? (async () => ({ code: 0, stdout: '', stderr: '' }))
  const hub = new McpHub({
    launch: async () => {
      if (o.launchError !== undefined) throw new Error(o.launchError)
      return o.launch ?? LAUNCH
    },
    tab: async (id) => (id === TAB ? { env: ENV, folder: FOLDER } : null),
    home: HOME,
    readJson: async (file) => files.get(file) ?? null,
    run: async (_launch, args, opts) => {
      runs.push({ args, o: opts })
      return reply(args, opts)
    },
    session: {
      mcpStatus: async () => o.live ?? null,
      reconnectMcp: async (_tab, name) => {
        reconnects.push(name)
      },
      toggleMcp: async (_tab, name, enabled) => {
        toggles.push([name, enabled])
      }
    },
    changed: (tab, madeHere) => {
      changed.push([tab, madeHere])
      order.push(`changed:${tab}:${madeHere}`)
    },
    hold: (tab) => {
      order.push(`hold:${tab}`)
    },
    release: (tab) => {
      order.push(`release:${tab}`)
    },
    openPath: async (file) => {
      opened.push(file)
      return o.openError ?? ''
    },
    copy: (text) => {
      copied.push(text)
    },
    log: {
      warn: (message) => {
        warns.push(message)
      }
    }
  })
  return { hub, runs, reconnects, toggles, changed, order, copied, opened, warns, paths }
}

const live = (over: Partial<McpLiveServer>): McpLiveServer => ({
  name: 'github', status: 'connected', error: null, version: null, scope: 'user', source: null, transport: 'stdio', target: null, tools: [], ...over
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('McpHub', () => {
  it('servers merges the session\'s statuses with the pending project servers of the configuration', async () => {
    const { hub } = setup({
      live: [
        live({ name: 'github', version: '1.2.0', transport: 'http', target: 'https://api.example.com/mcp?key=abc123', tools: ['search'] }),
        live({ name: 'plugin:docs:notes', status: 'failed', error: 'boom', scope: 'user', source: 'plugin', transport: 'stdio', target: 'npx notes' })
      ],
      files: {
        userConfig: { projects: { [FOLDER]: { disabledMcpjsonServers: ['blocked'] } } },
        projectMcp: {
          mcpServers: {
            github: { type: 'http', url: 'https://api.example.com/mcp' },
            waiting: { command: 'uvx', args: ['w'] },
            blocked: { command: 'node' }
          }
        }
      }
    })

    expect(await hub.servers(TAB)).toEqual({
      live: true,
      servers: [
        { name: 'github', status: 'connected', scope: 'user', plugin: null, transport: 'http', target: `https://api.example.com/mcp?key=${MASK}`, tools: ['search'], error: null, version: '1.2.0' },
        { name: 'plugin:docs:notes', status: 'failed', scope: 'plugin', plugin: 'docs', transport: 'stdio', target: 'npx notes', tools: [], error: 'boom', version: null },
        { name: 'waiting', status: 'pending-approval', scope: 'project', plugin: null, transport: 'stdio', target: 'uvx w', tools: [], error: null, version: null },
        { name: 'blocked', status: 'pending-approval', scope: 'project', plugin: null, transport: 'stdio', target: 'node', tools: [], error: null, version: null }
      ]
    })
  })

  it('with no running session the configured servers are listed: disabled off, pending waiting for approval, others configured', async () => {
    const { hub } = setup({
      files: {
        userConfig: {
          mcpServers: { search: { type: 'http', url: 'https://mcp.example.com/sse?token=zzz' } },
          projects: { [FOLDER]: { disabledMcpServers: ['search'], mcpServers: { notes: { command: 'node', args: ['n.js'] } } } }
        },
        projectMcp: { mcpServers: { waiting: { command: 'uvx', args: ['w'] } } }
      }
    })

    expect(await hub.servers(TAB)).toEqual({
      live: false,
      servers: [
        { name: 'search', status: 'disabled', scope: 'user', plugin: null, transport: 'http', target: `https://mcp.example.com/sse?token=${MASK}`, tools: [], error: null, version: null },
        { name: 'waiting', status: 'pending-approval', scope: 'project', plugin: null, transport: 'stdio', target: 'uvx w', tools: [], error: null, version: null },
        { name: 'notes', status: 'configured', scope: 'local', plugin: null, transport: 'stdio', target: 'node n.js', tools: [], error: null, version: null }
      ]
    })
  })

  it('reconnect and toggle go to the session; with none they say Claude Code is not running', async () => {
    const running = setup({ live: [live({})] })
    expect(await running.hub.action(TAB, { kind: 'reconnect', name: 'github' })).toEqual({ ok: true })
    expect(await running.hub.action(TAB, { kind: 'toggle', name: 'github', enabled: false })).toEqual({ ok: true })
    expect(running.reconnects).toEqual(['github'])
    expect(running.toggles).toEqual([['github', false]])
    expect(running.changed).toEqual([[TAB, false], [TAB, false]])

    const idle = setup()
    expect(await idle.hub.action(TAB, { kind: 'reconnect', name: 'github' })).toEqual({ ok: false, error: NOT_RUNNING })
    expect(await idle.hub.action(TAB, { kind: 'toggle', name: 'github', enabled: true })).toEqual({ ok: false, error: NOT_RUNNING })
    expect(idle.reconnects).toEqual([])
    expect(idle.toggles).toEqual([])
    expect(idle.changed).toEqual([])
  })

  it('remove runs claude mcp remove with the scope after --, then marks the tab as the maker', async () => {
    const { hub, runs, changed } = setup()

    expect(await hub.action(TAB, { kind: 'remove', name: 'github', scope: 'local' })).toEqual({ ok: true })
    expect(runs).toHaveLength(1)
    expect(runs[0].args).toEqual(['mcp', 'remove', '--scope', 'local', '--', 'github'])
    expect(runs[0].o.cwd).toBe(FOLDER)
    expect(runs[0].o.env).toEqual(ENV)
    expect(changed).toEqual([[TAB, true]])
  })

  it('login runs for 5 minutes at most then reconnects; cancel-login ends it with Cancelled and no reconnect', async () => {
    const done = setup({ live: [live({})] })
    expect(await done.hub.action(TAB, { kind: 'login', name: 'github' })).toEqual({ ok: true })
    expect(done.runs[0].args).toEqual(['mcp', 'login', '--', 'github'])
    expect(done.runs[0].o.timeoutMs).toBe(LOGIN_TIMEOUT_MS)
    expect(LOGIN_TIMEOUT_MS).toBe(300_000)
    expect(done.reconnects).toEqual(['github'])
    expect(done.changed).toEqual([[TAB, false]])

    const cancelled = setup({
      live: [live({})],
      reply: (_args, o) => new Promise((_resolve, reject) => {
        o.signal?.addEventListener('abort', () => reject(new CliError('cancelled', 'Cancelled')))
      })
    })
    const login = cancelled.hub.action(TAB, { kind: 'login', name: 'github' })
    while (cancelled.runs.length === 0) await sleep(1)
    expect(await cancelled.hub.action(TAB, { kind: 'cancel-login', name: 'github' })).toEqual({ ok: true })
    expect(await login).toEqual({ ok: false, error: 'Cancelled' })
    expect(cancelled.reconnects).toEqual([])
    expect(cancelled.changed).toEqual([])
  })

  it('logout runs, then reconnects', async () => {
    const { hub, runs, reconnects, changed } = setup({ live: [live({})] })

    expect(await hub.action(TAB, { kind: 'logout', name: 'github' })).toEqual({ ok: true })
    expect(runs[0].args).toEqual(['mcp', 'logout', '--', 'github'])
    expect(reconnects).toEqual(['github'])
    expect(changed).toEqual([[TAB, false]])
  })

  it('add re-reads the text, takes the edited names and adds each server with add-json in the scope', async () => {
    const { hub, runs, changed } = setup()
    const text = JSON.stringify({
      mcpServers: {
        a: { command: 'node', args: ['a.js'] },
        b: { type: 'http', url: 'https://b.example.com/mcp' }
      }
    })

    expect(await hub.add(TAB, { text, names: ['first', 'second'], scope: 'project', clientSecret: null })).toEqual({ ok: true })
    expect(runs.map((r) => r.args)).toEqual([
      ['mcp', 'add-json', '--scope', 'project', '--', 'first', '{"type":"stdio","command":"node","args":["a.js"],"env":{}}'],
      ['mcp', 'add-json', '--scope', 'project', '--', 'second', '{"type":"http","url":"https://b.example.com/mcp","headers":{}}']
    ])
    expect(changed).toEqual([[TAB, true]])
  })

  it('a client secret goes in MCP_CLIENT_SECRET with --client-secret, never in the arguments', async () => {
    const { hub, runs } = setup()
    const text = JSON.stringify({ mcpServers: { oauth: { type: 'http', url: 'https://o.example.com/mcp', oauth: { clientId: 'cid' } } } })

    expect(await hub.add(TAB, { text, names: ['oauth'], scope: 'user', clientSecret: 'sec-XYZ-987' })).toEqual({ ok: true })
    expect(runs[0].args.slice(0, 5)).toEqual(['mcp', 'add-json', '--scope', 'user', '--client-secret'])
    expect(runs[0].args.join(' ')).not.toContain('sec-XYZ-987')
    expect(runs[0].o.env).toEqual({ ...ENV, MCP_CLIENT_SECRET: 'sec-XYZ-987' })
  })

  it('a failed add stops at that server, and its message has every secret masked, nothing logged with it', async () => {
    const reply: Reply = async (args) => {
      // the stand-in echoes the config it was given, as the CLI can
      if (args[5] === 'two') return { code: 1, stdout: '', stderr: `Error: cannot add two ${args[args.length - 1]}` }
      return { code: 0, stdout: '', stderr: '' }
    }
    const { hub, runs, changed, warns } = setup({ reply })
    const server = (url: string): unknown => ({ type: 'http', url, headers: { Authorization: 'sk-test-123' } })
    const text = JSON.stringify({ mcpServers: { one: server('https://one.example.com/mcp'), two: server('https://two.example.com/mcp'), three: server('https://three.example.com/mcp') } })

    const result = await hub.add(TAB, { text, names: ['one', 'two', 'three'], scope: 'user', clientSecret: null })
    expect(result).toEqual({
      ok: false,
      error: `Added one. Could not add two: Error: cannot add two {"type":"http","url":"https://two.example.com/mcp","headers":{"Authorization":"${MASK}"}}`
    })
    expect(runs).toHaveLength(2)
    expect(changed).toEqual([[TAB, true]])
    expect(warns).toEqual(['claude mcp add-json failed (1)'])
    expect(JSON.stringify(result)).not.toContain('sk-test-123')
  })

  it('commands of one config folder run one after the other', async () => {
    let active = 0
    let peak = 0
    const order: string[] = []
    const { hub } = setup({
      reply: async (args) => {
        active++
        peak = Math.max(peak, active)
        order.push(args[args.length - 1])
        await sleep(5)
        active--
        return { code: 0, stdout: '', stderr: '' }
      }
    })

    const results = await Promise.all([
      hub.action(TAB, { kind: 'remove', name: 'first', scope: 'user' }),
      hub.action(TAB, { kind: 'remove', name: 'second', scope: 'user' })
    ])
    expect(results).toEqual([{ ok: true }, { ok: true }])
    expect(peak).toBe(1)
    expect(order).toEqual(['first', 'second'])
  })

  it('copy-config copies the JSON with header and env values masked', async () => {
    const { hub, copied } = setup({
      files: {
        userConfig: {
          mcpServers: {
            github: { type: 'http', url: 'https://api.example.com/mcp?api_key=abc', headers: { Authorization: 'Bearer tok-1' } },
            npmsrv: { command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 't-2' } }
          }
        }
      }
    })

    expect(await hub.action(TAB, { kind: 'copy-config', name: 'github', scope: 'user' })).toEqual({ ok: true })
    expect(copied[0]).toBe(JSON.stringify({
      github: { type: 'http', url: `https://api.example.com/mcp?api_key=${MASK}`, headers: { Authorization: MASK } }
    }, null, 2))

    expect(await hub.action(TAB, { kind: 'copy-config', name: 'npmsrv', scope: 'user' })).toEqual({ ok: true })
    expect(copied[1]).toContain(`"TOKEN": "${MASK}"`)
    expect(copied[1]).not.toContain('t-2')

    expect(await hub.action(TAB, { kind: 'copy-config', name: 'github', scope: 'local' })).toEqual({ ok: false, error: 'No such server in this scope' })
  })

  it('open-config opens .claude.json for user and local, .mcp.json for project', async () => {
    const { hub, opened, paths } = setup()

    expect(await hub.action(TAB, { kind: 'open-config', scope: 'user' })).toEqual({ ok: true })
    expect(await hub.action(TAB, { kind: 'open-config', scope: 'local' })).toEqual({ ok: true })
    expect(await hub.action(TAB, { kind: 'open-config', scope: 'project' })).toEqual({ ok: true })
    expect(opened).toEqual([paths.userConfig, paths.userConfig, paths.projectMcp])

    const refused = setup({ openError: 'No application is associated with this file' })
    expect(await refused.hub.action(TAB, { kind: 'open-config', scope: 'user' })).toEqual({ ok: false, error: 'No application is associated with this file' })
  })

  it('a tab that is not a local Claude tab gets null and an error', async () => {
    const { hub, runs } = setup()

    expect(await hub.servers('remote-tab')).toBeNull()
    expect(await hub.action('remote-tab', { kind: 'remove', name: 'github', scope: 'user' })).toEqual({ ok: false, error: NOT_TAB })
    expect(await hub.add('remote-tab', { text: '{}', names: [], scope: 'user', clientSecret: null })).toEqual({ ok: false, error: NOT_TAB })
    expect(runs).toEqual([])
  })

  it('a live target of any URL scheme is masked, not only http', async () => {
    const { hub } = setup({
      live: [
        live({ name: 'socket', transport: 'ws', target: 'wss://h/x?token=abc' }),
        live({ name: 'basic', transport: 'http', target: 'https://u:pw@h/mcp' })
      ]
    })

    const view = await hub.servers(TAB)
    expect(view?.servers.map((s) => s.target)).toEqual([`wss://h/x?token=${MASK}`, `https://u:${MASK}@h/mcp`])
  })

  it('a launch that rejects answers its error for remove and add, and never throws', async () => {
    const { hub, runs } = setup({ launchError: 'spawn EPERM' })
    const text = JSON.stringify({ mcpServers: { a: { command: 'node' } } })

    expect(await hub.action(TAB, { kind: 'remove', name: 'github', scope: 'user' })).toEqual({ ok: false, error: 'spawn EPERM' })
    expect(await hub.add(TAB, { text, names: ['a'], scope: 'user', clientSecret: null })).toEqual({ ok: false, error: 'Could not add a: spawn EPERM' })
    expect(runs).toEqual([])
  })

  it('a launch that cannot start answers its reason and runs nothing', async () => {
    const { hub, runs } = setup({ launch: { how: 'none', reason: 'No claude command on PATH' } })

    expect(await hub.action(TAB, { kind: 'remove', name: 'github', scope: 'user' })).toEqual({ ok: false, error: 'No claude command on PATH' })
    expect(runs).toEqual([])
  })

  it('plugins runs the two lists once in the tab\'s folder and environment and keeps them 30 s; an action drops them', async () => {
    const listed = { installed: [{ id: PLUGIN, version: '1.0.0', scope: 'user', enabled: true, mcpServers: { watch: {} }, errors: [] }], available: [] }
    const markets = [{ name: 'acme-tools', source: 'github', repo: 'acme/tools', installLocation: MARKET_DIR }]
    const { hub, runs } = setup({
      reply: async (args) => ({ code: 0, stdout: JSON.stringify(args[1] === 'marketplace' ? markets : listed), stderr: '' }),
      json: { [MARKET_FILE]: { plugins: [{ name: 'ci-watch', description: 'Follows CI runs and explains what failed.', version: '1.1.0' }] } }
    })
    const clock = vi.spyOn(Date, 'now')
    try {
      clock.mockReturnValue(1_000_000)
      expect(await hub.plugins(TAB)).toEqual({
        installed: [{ id: PLUGIN, name: 'ci-watch', marketplace: 'acme-tools', version: '1.0.0', scope: 'user', enabled: true, update: '1.1.0', description: 'Follows CI runs and explains what failed.', mcpServers: 1, errors: [] }],
        available: [],
        marketplaces: [{ name: 'acme-tools', source: 'acme/tools' }]
      })
      expect(runs.map((r) => r.args)).toEqual([LIST, MARKETS])
      expect(runs.every((r) => r.o.cwd === FOLDER && r.o.env === ENV)).toBe(true)

      clock.mockReturnValue(1_029_000)
      await hub.plugins(TAB)
      expect(runs).toHaveLength(2)

      clock.mockReturnValue(1_031_000)
      await hub.plugins(TAB)
      expect(runs).toHaveLength(4)

      await hub.pluginAction(TAB, { kind: 'enable', id: PLUGIN })
      await hub.plugins(TAB)
      expect(runs).toHaveLength(7)
      expect(runs[4].args).toEqual(['plugin', 'enable', '--', PLUGIN])
      expect(runs.slice(5).map((r) => r.args)).toEqual([LIST, MARKETS])
    } finally {
      clock.mockRestore()
    }
  })

  it('install reads the plugin\'s options and holds the restart while required ones are unset', async () => {
    const schema = {
      token: { type: 'string', title: 'API token', required: true, sensitive: true },
      region: { type: 'string', title: 'Region', required: false, sensitive: false }
    }
    const { hub, runs, order } = setup({
      reply: async (args) => ({ code: 0, stdout: args.includes('--json') ? JSON.stringify({ schema, configured: [] }) : '', stderr: '' })
    })

    expect(await hub.pluginAction(TAB, { kind: 'install', id: PLUGIN })).toEqual({
      ok: true,
      options: [{ key: 'token', title: 'API token', description: '', sensitive: true }]
    })
    expect(runs.map((r) => r.args)).toEqual([
      ['plugin', 'install', '--scope', 'user', '--', PLUGIN],
      ['plugin', 'configure', '--json', '--', PLUGIN]
    ])
    expect(order).toEqual([`hold:${TAB}`, `changed:${TAB}:true`])

    const configured = setup({
      reply: async (args) => ({ code: 0, stdout: args.includes('--json') ? JSON.stringify({ schema, configured: ['token'] }) : '', stderr: '' })
    })
    expect(await configured.hub.pluginAction(TAB, { kind: 'install', id: PLUGIN })).toEqual({ ok: true })
    expect(configured.order).toEqual([`changed:${TAB}:true`])
  })

  it('configure sends the values on stdin, never as arguments, then releases', async () => {
    const { hub, runs, order } = setup()

    expect(await hub.pluginAction(TAB, { kind: 'configure', id: PLUGIN, values: { token: 'tok-SECRET-42' } })).toEqual({ ok: true })
    expect(runs[0].args).toEqual(['plugin', 'configure', '--values-stdin', '--', PLUGIN])
    expect(runs[0].o.stdin).toBe(JSON.stringify({ token: 'tok-SECRET-42' }))
    expect(runs[0].args.join(' ')).not.toContain('tok-SECRET-42')
    expect(order).toEqual([`release:${TAB}`, `changed:${TAB}:true`])

    const refused = setup({ reply: async () => ({ code: 1, stdout: '', stderr: 'Invalid token tok-SECRET-42' }) })
    expect(await refused.hub.pluginAction(TAB, { kind: 'configure', id: PLUGIN, values: { token: 'tok-SECRET-42' } })).toEqual({ ok: false, error: `Invalid token ${MASK}` })
    expect(refused.order).toEqual([])
    expect(refused.warns.join(' ')).not.toContain('tok-SECRET-42')
  })

  it('configure-later releases the restart and runs no command', async () => {
    const { hub, runs, order } = setup()

    expect(await hub.pluginAction(TAB, { kind: 'configure-later', id: PLUGIN })).toEqual({ ok: true })
    expect(runs).toEqual([])
    expect(order).toEqual([`release:${TAB}`])
  })

  it('marketplace-add takes a GitHub link as owner/repo and names the marketplace it added', async () => {
    let added = false
    const { hub, runs, order } = setup({
      reply: async (args) => {
        if (args[2] === 'add') added = true
        const markets = added ? [{ name: 'acme-tools', source: 'github', repo: 'acme/tools', installLocation: MARKET_DIR }] : []
        return { code: 0, stdout: JSON.stringify(markets), stderr: '' }
      }
    })

    expect(await hub.pluginAction(TAB, { kind: 'marketplace-add', source: 'https://github.com/acme/tools' })).toEqual({ ok: true, marketplace: 'acme-tools' })
    expect(runs.map((r) => r.args)).toEqual([MARKETS, ['plugin', 'marketplace', 'add', '--', 'acme/tools'], MARKETS])
    expect(order).toEqual([`changed:${TAB}:true`])
  })

  it('enable, disable, update, uninstall and the marketplace commands run and mark the tab as the maker', async () => {
    const { hub, runs, changed } = setup()
    const actions: [PluginAction, string[]][] = [
      [{ kind: 'enable', id: PLUGIN }, ['plugin', 'enable', '--', PLUGIN]],
      [{ kind: 'disable', id: PLUGIN }, ['plugin', 'disable', '--', PLUGIN]],
      [{ kind: 'update', id: PLUGIN }, ['plugin', 'update', '--', PLUGIN]],
      [{ kind: 'uninstall', id: PLUGIN }, ['plugin', 'uninstall', '--', PLUGIN]],
      [{ kind: 'marketplace-update', name: 'acme-tools' }, ['plugin', 'marketplace', 'update', '--', 'acme-tools']],
      [{ kind: 'marketplace-remove', name: 'acme-tools' }, ['plugin', 'marketplace', 'remove', '--', 'acme-tools']]
    ]

    for (const [action] of actions) expect(await hub.pluginAction(TAB, action)).toEqual({ ok: true })
    expect(runs.map((r) => r.args)).toEqual(actions.map(([, args]) => args))
    expect(changed).toEqual(actions.map(() => [TAB, true]))
  })

  it('a failed command answers its message, and a failed or unreadable list is answered and not kept', async () => {
    const failing = setup({ reply: async () => ({ code: 1, stdout: '', stderr: 'Error: plugin is not installed' }) })
    expect(await failing.hub.pluginAction(TAB, { kind: 'uninstall', id: PLUGIN })).toEqual({ ok: false, error: 'Error: plugin is not installed' })
    expect(await failing.hub.pluginAction(TAB, { kind: 'install', id: PLUGIN })).toEqual({ ok: false, error: 'Error: plugin is not installed' })
    expect(failing.changed).toEqual([])
    expect(await failing.hub.plugins(TAB)).toEqual({ error: 'Error: plugin is not installed' })
    const before = failing.runs.length
    expect(await failing.hub.plugins(TAB)).toEqual({ error: 'Error: plugin is not installed' })
    expect(failing.runs.length).toBe(before + 1)

    const garbled = setup({ reply: async () => ({ code: 0, stdout: 'not json', stderr: '' }) })
    expect(await garbled.hub.plugins(TAB)).toEqual({ error: 'not json' })
  })
})
