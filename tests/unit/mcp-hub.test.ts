import { describe, expect, it } from 'vitest'
import type { McpLiveServer } from '../../src/main/chat/chat-engine'
import type { ChatLaunch } from '../../src/main/chat/claude-spawn'
import { CliError, LOGIN_TIMEOUT_MS, type CliOptions, type CliRun } from '../../src/main/mcp/claude-cli'
import { configPaths, type ConfigPaths } from '../../src/main/mcp/mcp-config'
import { McpHub } from '../../src/main/mcp/mcp-hub'
import { MASK } from '../../src/shared/mcp-add'

const HOME = 'C:\\Users\\Dana'
const FOLDER = 'C:\\Work\\Acme'
const ENV = { CLAUDE_CONFIG_DIR: 'C:\\Config' }
const TAB = 'tab-1'
const LAUNCH: ChatLaunch = { how: 'direct', file: 'C:\\Program Files\\Claude\\claude.exe' }
const NOT_RUNNING = 'Claude Code is not running in this tab'
const NOT_TAB = 'Not a Claude tab of this computer'

interface Rec { args: string[]; o: CliOptions }
type Reply = (args: string[], o: CliOptions) => Promise<CliRun>

/** the hub with fakes for every dependency; the configuration files are keyed by the paths the hub reads */
function setup(o: Partial<{
  live: McpLiveServer[] | null
  files: Partial<Record<keyof ConfigPaths, unknown>>
  reply: Reply
  launch: ChatLaunch
  openError: string
}> = {}) {
  const paths = configPaths(ENV, HOME, FOLDER)
  const files = new Map<string, unknown>()
  for (const [key, value] of Object.entries(o.files ?? {})) files.set(paths[key as keyof ConfigPaths], value)
  const runs: Rec[] = []
  const reconnects: string[] = []
  const toggles: [string, boolean][] = []
  const changed: [string, boolean][] = []
  const copied: string[] = []
  const opened: string[] = []
  const warns: string[] = []
  const reply: Reply = o.reply ?? (async () => ({ code: 0, stdout: '', stderr: '' }))
  const hub = new McpHub({
    launch: async () => o.launch ?? LAUNCH,
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
    },
    hold: () => undefined,
    release: () => undefined,
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
  return { hub, runs, reconnects, toggles, changed, copied, opened, warns, paths }
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

  it('a launch that cannot start answers its reason and runs nothing', async () => {
    const { hub, runs } = setup({ launch: { how: 'none', reason: 'No claude command on PATH' } })

    expect(await hub.action(TAB, { kind: 'remove', name: 'github', scope: 'user' })).toEqual({ ok: false, error: 'No claude command on PATH' })
    expect(runs).toEqual([])
  })
})
