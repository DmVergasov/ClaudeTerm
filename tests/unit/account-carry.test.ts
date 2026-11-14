import { describe, expect, it } from 'vitest'
import {
  addTrust,
  carriedSettings,
  countHooks,
  hooksOf,
  isServerName,
  mergeSettings,
  pluginPlan,
  previewCounts,
  serverSecrets,
  userServers,
  withHooks,
  type FolderItem,
} from '../../src/main/account-carry'

describe('carriedSettings', () => {
  it('the settings filter drops hooks, plugins, marketplaces, each credential key and each credential variable of env', () => {
    const source = {
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] },
      enabledPlugins: { 'tools@acme': true },
      extraKnownMarketplaces: { acme: { source: { source: 'github', repo: 'acme/plugins' } } },
      apiKeyHelper: 'helper.sh',
      awsAuthRefresh: 'refresh',
      awsCredentialExport: 'export',
      forceLoginMethod: 'claudeai',
      forceLoginOrgUUID: '00000000-0000-0000-0000-000000000000',
      env: {
        FOO: 'bar',
        ANTHROPIC_API_KEY: 'key',
        ANTHROPIC_AUTH_TOKEN: 'token',
        CLAUDE_CODE_OAUTH_TOKEN: 'token',
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'token',
        CLAUDE_CONFIG_DIR: '/elsewhere',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_USE_VERTEX: '1',
        CLAUDE_CODE_USE_FOUNDRY: '1',
      },
    }
    expect(carriedSettings(source)).toEqual({ model: 'opus', env: { FOO: 'bar' } })
  })

  it('compares env variable names ignoring case and drops an env left empty', () => {
    expect(carriedSettings({ env: { anthropic_api_key: 'key' } })).toEqual({})
  })

  it('carries nothing from a value that is not a JSON object', () => {
    expect(carriedSettings(null)).toEqual({})
    expect(carriedSettings(['model'])).toEqual({})
    expect(carriedSettings('model')).toEqual({})
  })
})

describe('mergeSettings', () => {
  it("mergeSettings replaces the source's keys, merges env per variable and keeps the rest", () => {
    const account = { model: 'sonnet', theme: 'dark', env: { A: '1', B: '2' } }
    const carried = { model: 'opus', env: { B: '3', C: '4' } }
    expect(mergeSettings(account, carried)).toEqual({ model: 'opus', theme: 'dark', env: { A: '1', B: '3', C: '4' } })
  })

  it('withHooks replaces the account hooks as a whole and keeps the other keys', () => {
    const account = { model: 'sonnet', hooks: { Stop: [{ hooks: [{}, {}] }] } }
    expect(withHooks(account, { PreToolUse: [{ hooks: [{}] }] })).toEqual({ model: 'sonnet', hooks: { PreToolUse: [{ hooks: [{}] }] } })
    expect(hooksOf({ hooks: { Stop: [] } })).toEqual({ Stop: [] })
    expect(hooksOf({ hooks: 'x' })).toBeNull()
  })
})

describe('countHooks', () => {
  it('countHooks counts every hook command', () => {
    const hooks = {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }] },
        { hooks: [{ type: 'command', command: 'c' }] },
      ],
      Stop: [{ command: 'd' }],
      Notification: [],
    }
    expect(countHooks(hooks)).toBe(4)
    expect(countHooks(null)).toBe(0)
  })
})

describe('userServers', () => {
  it('userServers leaves claudeterm out and lists the user-scope servers by name', () => {
    const claudeJson = {
      mcpServers: {
        zeta: { type: 'stdio', command: 'z' },
        alpha: { type: 'http', url: 'https://example.com/mcp' },
        claudeterm: { type: 'stdio', command: 'ct' },
        'bad name!': { type: 'stdio', command: 'b' },
      },
      projects: { '/p': { mcpServers: { inProject: { type: 'stdio', command: 'p' } } } },
    }
    expect(userServers(claudeJson)).toEqual([
      { name: 'alpha', config: { type: 'http', url: 'https://example.com/mcp' } },
      { name: 'zeta', config: { type: 'stdio', command: 'z' } },
    ])
  })

  it('isServerName takes 1 to 64 letters, digits, _, - and ., not starting with -', () => {
    expect(isServerName('a'.repeat(64))).toBe(true)
    expect(isServerName('a'.repeat(65))).toBe(false)
    expect(isServerName('')).toBe(false)
    expect(isServerName('-x')).toBe(false)
    expect(isServerName('a b')).toBe(false)
    expect(isServerName('x.y_z-1')).toBe(true)
    expect(isServerName(3)).toBe(false)
  })
})

describe('serverSecrets', () => {
  it('serverSecrets are the env and header values', () => {
    const config = {
      type: 'http',
      command: 'not-a-secret',
      env: { A: 'secret-a', B: '', C: 3 },
      headers: { Authorization: 'Bearer token-b' },
    }
    expect(serverSecrets(config)).toEqual(['secret-a', 'Bearer token-b'])
  })
})

describe('pluginPlan', () => {
  it("pluginPlan: user-scope plugins with marketplace and on/off; a marketplace with nothing to add from is claude.ai's", () => {
    const installed = {
      version: 2,
      plugins: {
        'tools@acme': [{ scope: 'user' }],
        'lint@acme': [{ scope: 'user' }],
        'proj@acme': [{ scope: 'project' }],
        'hosted@claude-plugins': [{ scope: 'user' }],
        'git@tools-git': [{ scope: 'user' }],
        'dir@tools-dir': [{ scope: 'user' }],
      },
    }
    const known = {
      acme: { source: { source: 'github', repo: 'acme/plugins' }, installLocation: '/cache/acme' },
      'tools-git': { source: { source: 'git', url: 'https://example.com/tools.git' }, installLocation: '/cache/g' },
      'tools-dir': { source: { source: 'directory', path: 'D:/Work/tools' }, installLocation: '/cache/d' },
    }
    const settings = { enabledPlugins: { 'tools@acme': true, 'lint@acme': false, 'proj@acme': true } }
    expect(pluginPlan(installed, known, settings)).toEqual({
      plugins: [
        { id: 'dir@tools-dir', name: 'dir', marketplace: 'tools-dir', enabled: false },
        { id: 'git@tools-git', name: 'git', marketplace: 'tools-git', enabled: false },
        { id: 'hosted@claude-plugins', name: 'hosted', marketplace: 'claude-plugins', enabled: false },
        { id: 'lint@acme', name: 'lint', marketplace: 'acme', enabled: false },
        { id: 'tools@acme', name: 'tools', marketplace: 'acme', enabled: true },
      ],
      marketplaces: [
        { name: 'acme', source: 'acme/plugins' },
        { name: 'claude-plugins', source: null },
        { name: 'tools-dir', source: 'D:/Work/tools' },
        { name: 'tools-git', source: 'https://example.com/tools.git' },
      ],
    })
  })
})

describe('addTrust', () => {
  const claudeJson = JSON.stringify(
    {
      numStartups: 3,
      oauthAccount: { emailAddress: 'someone@example.com' },
      projects: {
        'C:\\Work\\Acme': { allowedTools: ['Bash'], hasTrustDialogAccepted: false, lastCost: 1 },
        'D:/Other': { hasTrustDialogAccepted: true },
      },
    },
    null,
    2,
  )

  it('addTrust adds only the flag, makes an entry with that key alone, keeps everything else, finds a key in another spelling', () => {
    const result = addTrust(claudeJson, ['C:\\Work\\Acme', 'C:/Work/New', 'd:\\other'])
    expect(result).toBe(
      JSON.stringify(
        {
          numStartups: 3,
          oauthAccount: { emailAddress: 'someone@example.com' },
          projects: {
            'C:\\Work\\Acme': { allowedTools: ['Bash'], hasTrustDialogAccepted: true, lastCost: 1 },
            'D:/Other': { hasTrustDialogAccepted: true },
            'C:/Work/New': { hasTrustDialogAccepted: true },
          },
        },
        null,
        2,
      ),
    )
  })

  it('starts from an empty object when the file is missing', () => {
    expect(addTrust(null, ['/home/dev/acme'])).toBe(JSON.stringify({ projects: { '/home/dev/acme': { hasTrustDialogAccepted: true } } }, null, 2))
  })

  it('addTrust answers null when nothing is to add and throws on text that is not an object', () => {
    expect(addTrust(claudeJson, ['D:/Other', 'd:\\OTHER'])).toBeNull()
    expect(addTrust(claudeJson, [])).toBeNull()
    expect(() => addTrust('[1]', ['/a'])).toThrow()
    expect(() => addTrust('"text"', ['/a'])).toThrow()
    expect(() => addTrust('null', ['/a'])).toThrow()
    expect(() => addTrust('{ not json', ['/a'])).toThrow()
    expect(() => addTrust('', ['/a'])).toThrow()
  })

  it('throws on a projects value that is present but not an object, and leaves nothing to write', () => {
    expect(() => addTrust('{"projects":[]}', ['/a'])).toThrow()
    expect(() => addTrust('{"projects":"x"}', ['/a'])).toThrow()
    expect(() => addTrust('{"projects":null}', ['/a'])).toThrow()
  })

  it('throws on a matching entry that is present but not an object', () => {
    expect(() => addTrust('{"projects":{"/a":null}}', ['/a'])).toThrow()
    expect(() => addTrust('{"projects":{"/a":"x"}}', ['/a'])).toThrow()
  })

  it('matches a POSIX folder case-sensitively', () => {
    expect(addTrust('{"projects":{"/A":{"hasTrustDialogAccepted":false}}}', ['/a'])).toBe(
      JSON.stringify({ projects: { '/A': { hasTrustDialogAccepted: false }, '/a': { hasTrustDialogAccepted: true } } }, null, 2),
    )
  })

  it('a folder named __proto__ becomes an own key and sets no prototype', () => {
    const result = addTrust(null, ['__proto__'])
    expect(result).not.toBeNull()
    const parsed = JSON.parse(result as string)
    expect(Object.keys(parsed.projects)).toEqual(['__proto__'])
    expect(parsed.projects.__proto__).toEqual({ hasTrustDialogAccepted: true })
  })
})

describe('previewCounts', () => {
  it('previewCounts gives the counts the helper shows', () => {
    const read = {
      settings: { model: 'opus', env: { FOO: '1', ANTHROPIC_API_KEY: 'key' }, hooks: { Stop: [{ hooks: [{}, {}] }, { hooks: [{}] }] } },
      claudeJson: {
        mcpServers: { alpha: { type: 'stdio' }, beta: { type: 'stdio' }, gamma: { type: 'stdio' }, delta: { type: 'stdio' } },
        projects: {
          '/a': { hasTrustDialogAccepted: true },
          '/b': { hasTrustDialogAccepted: false },
          '/c': { hasTrustDialogAccepted: true },
        },
      },
      installed: { plugins: { 'a@m': [{ scope: 'user' }], 'b@n': [{ scope: 'user' }], 'c@m': [{ scope: 'user' }] } },
      known: { m: { source: { source: 'github', repo: 'a/b' }, installLocation: '/cache/m' } },
    }
    const files: Record<FolderItem, number> = { skills: 2, agents: 0, commands: 1, 'output-styles': 0, memory: 3, keybindings: 1 }
    expect(previewCounts(read, files)).toEqual([
      { item: 'settings', count: 2, names: [], marketplaces: 0 },
      { item: 'hooks', count: 3, names: [], marketplaces: 0 },
      { item: 'mcp', count: 4, names: ['alpha', 'beta', 'delta'], marketplaces: 0 },
      { item: 'plugins', count: 3, names: [], marketplaces: 2 },
      { item: 'skills', count: 2, names: [], marketplaces: 0 },
      { item: 'agents', count: 0, names: [], marketplaces: 0 },
      { item: 'commands', count: 1, names: [], marketplaces: 0 },
      { item: 'memory', count: 3, names: [], marketplaces: 0 },
      { item: 'trust', count: 2, names: [], marketplaces: 0 },
      { item: 'keybindings', count: 1, names: [], marketplaces: 0 },
      { item: 'output-styles', count: 0, names: [], marketplaces: 0 },
    ])
  })
})

describe('malformed files carry nothing and never throw', () => {
  it('malformed files carry nothing and never throw', () => {
    const files: Record<FolderItem, number> = { skills: 0, agents: 0, commands: 0, 'output-styles': 0, memory: 0, keybindings: 0 }
    expect(countHooks('x')).toBe(0)
    expect(countHooks({ Stop: 'x' })).toBe(0)
    expect(userServers(null)).toEqual([])
    expect(userServers({ mcpServers: [1, 'x'] })).toEqual([])
    expect(userServers({ mcpServers: { a: 'x' } })).toEqual([])
    expect(serverSecrets({ env: 'x', headers: [1] })).toEqual([])
    expect(pluginPlan(null, null, null)).toEqual({ plugins: [], marketplaces: [] })
    expect(pluginPlan({ plugins: { 'a@m': 'x', b: [{ scope: 'user' }] } }, { m: 'x' }, { enabledPlugins: 'x' })).toEqual({
      plugins: [],
      marketplaces: [],
    })
    expect(previewCounts({ settings: null, claudeJson: 'x', installed: null, known: null }, files).map((c) => c.count)).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ])
  })
})
