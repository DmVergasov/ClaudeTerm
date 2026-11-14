import { describe, expect, it } from 'vitest'
import type { McpServerView, McpServersView, PluginView } from '../../src/shared/mcp'
import {
  badgeOf,
  countLabel,
  detailOf,
  editScope,
  iconColor,
  initials,
  matchedTools,
  pluginLine,
  rowActions,
  serverGroups,
  serverStats,
} from '../../src/renderer/mcp/mcp-view-model'

function server(name: string, over: Partial<McpServerView> = {}): McpServerView {
  return { name, status: 'connected', scope: 'user', plugin: null, transport: 'stdio', target: '', tools: [], error: null, version: null, ...over }
}

function toolNames(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}_${i + 1}`)
}

// The servers of the board's frame 1 (the MCP servers panel), with the same statuses, scopes and counts
const board: McpServersView = {
  live: true,
  servers: [
    server('linear', { status: 'needs-auth', scope: 'claudeai', transport: 'http', target: 'https://mcp.linear.app/mcp' }),
    server('sentry', { status: 'needs-auth', scope: 'user', transport: 'http', target: 'https://mcp.sentry.dev/mcp' }),
    server('postgres', { status: 'failed', scope: 'project', target: 'uvx postgres-mcp', error: 'spawn uvx ENOENT' }),
    server('github', {
      scope: 'user', transport: 'http', target: 'https://api.githubcopilot.com/mcp/', version: '1.4.2',
      tools: ['create_pull_request', 'search_code', 'get_issue', 'list_commits', ...toolNames('github', 37)],
    }),
    server('context7', { scope: 'user', target: 'npx -y @upstash/context7-mcp', tools: ['resolve-library-id', 'get-library-docs'] }),
    server('playwright', { scope: 'project', target: 'npx @playwright/mcp', tools: toolNames('browser', 21) }),
    server('claudeterm', { scope: 'plugin', plugin: 'claudeterm', target: 'node claudeterm-mcp.js', tools: toolNames('claudeterm', 6) }),
    server('memory', { status: 'disabled', scope: 'user', target: 'npx -y @modelcontextprotocol/server-memory' }),
  ],
  reload: null,
}

function names(view: ReturnType<typeof serverGroups>): [string, string[]][] {
  return view.map((group) => [group.label, group.servers.map((s) => s.name)])
}

describe('serverGroups', () => {
  it('groups the board servers by attention, connection and off, each sorted by name', () => {
    expect(names(serverGroups(board, ''))).toEqual([
      ['Needs attention', ['linear', 'postgres', 'sentry']],
      ['Connected', ['claudeterm', 'context7', 'github', 'playwright']],
      ['Off', ['memory']],
    ])
  })

  it('leaves out an empty group', () => {
    const connectedOnly: McpServersView = { live: true, servers: [server('github'), server('context7')], reload: null }
    expect(names(serverGroups(connectedOnly, ''))).toEqual([['Connected', ['context7', 'github']]])
  })

  it('the filter finds a server by a tool and lists only those tools', () => {
    expect(names(serverGroups(board, 'search'))).toEqual([['Connected', ['github']]])
    expect(matchedTools(board.servers[3], 'search')).toEqual(['search_code'])
    expect(names(serverGroups(board, 'PLAY'))).toEqual([['Connected', ['playwright']]])
    expect(matchedTools(board.servers[5], 'PLAY')).toBeNull()
    expect(names(serverGroups(board, 'no such tool'))).toEqual([])
  })

  it('not live: Configured, no switch, no reconnect', () => {
    const configured: McpServersView = {
      live: false,
      servers: [
        server('github', { status: 'configured', target: 'https://api.githubcopilot.com/mcp/' }),
        server('memory', { status: 'configured', target: 'npx -y @modelcontextprotocol/server-memory' }),
      ],
      reload: null,
    }
    expect(names(serverGroups(configured, ''))).toEqual([['Configured', ['github', 'memory']]])
    expect(rowActions(configured.servers[0], false)).toEqual({
      primary: null, reconnect: false, toggle: null, menu: ['copy-config', 'open-config', 'remove'],
    })
  })
})

describe('serverStats', () => {
  it('counts the connected, the servers needing sign-in and the failed ones', () => {
    expect(serverStats(board)).toEqual({ connected: 4, needSignIn: 2, failed: 1 })
  })
})

describe('matchedTools', () => {
  it('is null with no filter or when the name matches', () => {
    expect(matchedTools(board.servers[3], '   ')).toBeNull()
    expect(matchedTools(board.servers[3], 'GIT')).toBeNull()
  })

  it('lists the tools that match, in their order', () => {
    expect(matchedTools(board.servers[3], 'issue')).toEqual(['get_issue'])
    expect(matchedTools(board.servers[3], 'nothing')).toEqual([])
  })
})

describe('badgeOf', () => {
  it('names where a server comes from', () => {
    expect(badgeOf(server('a', { scope: 'user' }))).toBe('User')
    expect(badgeOf(server('a', { scope: 'project' }))).toBe('Project')
    expect(badgeOf(server('a', { scope: 'local' }))).toBe('Local')
    expect(badgeOf(server('a', { scope: 'plugin', plugin: 'claudeterm' }))).toBe('Plugin · claudeterm')
    expect(badgeOf(server('a', { scope: 'claudeai' }))).toBe('claude.ai')
    expect(badgeOf(server('a', { scope: 'managed' }))).toBe('Managed')
    expect(badgeOf(server('a', { scope: 'other' }))).toBeNull()
  })
})

describe('detailOf', () => {
  it('describes each status in one line', () => {
    expect(detailOf(board.servers[3])).toBe('41 tools · v1.4.2')
    expect(detailOf(board.servers[4])).toBe('2 tools')
    expect(detailOf(server('one', { tools: ['a'] }))).toBe('1 tool')
    expect(detailOf(board.servers[0])).toBe('Needs sign-in')
    expect(detailOf(board.servers[2])).toBe('Failed to start')
    expect(detailOf(server('a', { status: 'pending' }))).toBe('Connecting…')
    expect(detailOf(server('a', { status: 'pending-approval' }))).toBe('Waiting for approval')
    expect(detailOf(board.servers[7])).toBe('Disabled')
    expect(detailOf(server('a', { status: 'configured', target: 'https://example.test/mcp' }))).toBe('https://example.test/mcp')
  })
})

describe('rowActions', () => {
  it('a server that needs sign-in offers Sign in, a switch and sign-out', () => {
    expect(rowActions(board.servers[0], true)).toEqual({
      primary: 'sign-in', reconnect: false, toggle: true, menu: ['reconnect', 'sign-out'],
    })
  })

  it('a failed project server offers Retry and the config actions', () => {
    expect(rowActions(board.servers[2], true)).toEqual({
      primary: 'retry', reconnect: false, toggle: true, menu: ['reconnect', 'copy-config', 'open-config', 'remove'],
    })
  })

  it('a connected server offers reconnect, sign-out, tools and the config actions', () => {
    expect(rowActions(board.servers[3], true)).toEqual({
      primary: null, reconnect: true, toggle: true, menu: ['sign-out', 'tools', 'copy-config', 'open-config', 'remove'],
    })
  })

  it('a plugin server has no config actions', () => {
    expect(rowActions(board.servers[6], true)).toEqual({ primary: null, reconnect: true, toggle: true, menu: ['tools'] })
  })

  it('a disabled server is switched off', () => {
    expect(rowActions(board.servers[7], true)).toEqual({
      primary: null, reconnect: false, toggle: false, menu: ['reconnect', 'copy-config', 'open-config', 'remove'],
    })
  })

  it('a server waiting for approval offers Approve and no switch', () => {
    const waiting = server('shared', { status: 'pending-approval', scope: 'project' })
    expect(rowActions(waiting, true)).toEqual({
      primary: 'approve', reconnect: false, toggle: null, menu: ['reconnect', 'copy-config', 'open-config', 'remove'],
    })
  })
})

describe('initials', () => {
  it('takes the first letter and the letter after a separator, or the second letter', () => {
    expect(initials('context7')).toBe('Co')
    expect(initials('code-review-kit')).toBe('Cr')
    expect(initials('github')).toBe('Gi')
    expect(initials('x')).toBe('X')
    expect(initials('')).toBe('')
  })
})

describe('iconColor', () => {
  const palette = ['#5E6AD2', '#8D7BD8', '#336791', '#63C08F', '#2EAD33', '#D97757', '#7FA7F5', '#E5B567']

  it('is one of the palette colours and the same for the same name', () => {
    for (const name of ['github', 'linear', 'context7', 'memory']) {
      expect(palette).toContain(iconColor(name))
      expect(iconColor(name)).toBe(iconColor(name))
    }
  })
})

describe('countLabel', () => {
  it('shortens a count to thousands and millions', () => {
    expect(countLabel(812)).toBe('812')
    expect(countLabel(2400)).toBe('2.4k')
    expect(countLabel(12000)).toBe('12k')
    expect(countLabel(1200000)).toBe('1.2M')
  })
})

describe('pluginLine', () => {
  const plugin: PluginView = {
    id: 'claudeterm@claudeterm-marketplace', name: 'claudeterm', marketplace: 'claudeterm-marketplace', version: '0.3.1',
    scope: 'user', enabled: true, update: null, description: '', mcpServers: 1, errors: [],
  }

  it('gives the marketplace, the version and the server count', () => {
    expect(pluginLine(plugin)).toBe('claudeterm-marketplace · 0.3.1 · 1 MCP server')
    expect(pluginLine({ ...plugin, mcpServers: 3 })).toBe('claudeterm-marketplace · 0.3.1 · 3 MCP servers')
    expect(pluginLine({ ...plugin, mcpServers: 0 })).toBe('claudeterm-marketplace · 0.3.1')
  })

  it('a disabled plugin says so', () => {
    expect(pluginLine({ ...plugin, enabled: false })).toBe('claudeterm-marketplace · disabled')
  })
})

describe('editScope', () => {
  it('is the scope a server can be edited in, or null', () => {
    expect(editScope(server('a', { scope: 'user' }))).toBe('user')
    expect(editScope(server('a', { scope: 'project' }))).toBe('project')
    expect(editScope(server('a', { scope: 'local' }))).toBe('local')
    expect(editScope(server('a', { scope: 'plugin', plugin: 'p' }))).toBeNull()
    expect(editScope(server('a', { scope: 'claudeai' }))).toBeNull()
  })
})
