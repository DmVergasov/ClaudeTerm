import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_CONFIG_BYTES,
  configKey,
  configPaths,
  diffConfig,
  jsonFileCache,
  readTabConfig,
  tabConfig,
  touchesConfig,
  type ConfigFiles,
  type ConfiguredServer,
  type InstalledPlugin,
  type TabConfig
} from '../../src/main/mcp/mcp-config'

const FOLDER = 'C:\\Work\\Acme'

/** every file missing, then the given ones */
function base(over: Partial<ConfigFiles>): ConfigFiles {
  return {
    userConfig: null,
    userSettings: null,
    installedPlugins: null,
    projectMcp: null,
    projectSettings: null,
    localSettings: null,
    ...over
  }
}

const EMPTY: TabConfig = { servers: [], plugins: [] }
const srv = (name: string, scope: ConfiguredServer['scope'], config: Record<string, unknown>, approval: ConfiguredServer['approval'] = null): ConfiguredServer =>
  ({ name, scope, config, approval, disabled: false })
const plug = (id: string, version: string, enabled: boolean): InstalledPlugin => ({ id, version, enabled })
const tab = (servers: ConfiguredServer[] = [], plugins: InstalledPlugin[] = []): TabConfig => ({ servers, plugins })
const byId = (a: InstalledPlugin, b: InstalledPlugin): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

describe('mcp-config', () => {
  it('configPaths follows CLAUDE_CONFIG_DIR, else the home folder', () => {
    const home = '/home/dev'
    expect(configPaths({}, home, FOLDER)).toEqual({
      userConfig: join(home, '.claude.json'),
      userSettings: join(home, '.claude', 'settings.json'),
      installedPlugins: join(home, '.claude', 'plugins', 'installed_plugins.json'),
      projectMcp: join(FOLDER, '.mcp.json'),
      projectSettings: join(FOLDER, '.claude', 'settings.json'),
      localSettings: join(FOLDER, '.claude', 'settings.local.json')
    })
    const dir = '/cfg/claude'
    expect(configPaths({ CLAUDE_CONFIG_DIR: dir }, home, FOLDER)).toEqual({
      userConfig: join(dir, '.claude.json'),
      userSettings: join(dir, 'settings.json'),
      installedPlugins: join(dir, 'plugins', 'installed_plugins.json'),
      projectMcp: join(FOLDER, '.mcp.json'),
      projectSettings: join(FOLDER, '.claude', 'settings.json'),
      localSettings: join(FOLDER, '.claude', 'settings.local.json')
    })
    expect(configPaths({ CLAUDE_CONFIG_DIR: '' }, home, FOLDER).userConfig).toBe(join(home, '.claude.json'))
  })

  it('user, project and local servers apply to the folder, local over project over user', () => {
    const userConfig = { mcpServers: { shared: { command: 'user' }, userOnly: { command: 'u' } } }
    const projects = { [FOLDER]: { mcpServers: { shared: { command: 'local' } } } }
    const files = base({
      userConfig: { ...userConfig, projects },
      projectMcp: { mcpServers: { shared: { command: 'project' }, projOnly: { command: 'p' } } },
      userSettings: { enableAllProjectMcpServers: true }
    })
    const t = tabConfig(files, FOLDER)
    expect(t.servers.map((s) => `${s.name}:${s.scope}`).sort()).toEqual([
      'projOnly:project',
      'shared:local',
      'shared:project',
      'shared:user',
      'userOnly:user'
    ])
    expect(t.servers.find((s) => s.name === 'projOnly')?.approval).toBe('approved')

    // without the local entry, the project server is the one that loads
    const withoutLocal = tabConfig({ ...files, userConfig: { ...userConfig, projects: {} } }, FOLDER)
    expect(diffConfig(t, withoutLocal)).toEqual([{ kind: 'server-changed', name: 'shared' }])
  })

  it('the folder entry matches in another case, with \\ or / and a trailing separator (Windows rules)', () => {
    const files = base({
      userConfig: {
        projects: {
          'C:/Work/Acme/': { mcpServers: { local: { command: 'l' } } },
          'C:/Work/Other': { mcpServers: { other: { command: 'o' } } }
        }
      },
      installedPlugins: { plugins: { 'p@m': [{ scope: 'project', projectPath: 'C:/Work/Acme/', installPath: '/p', version: '1' }] } }
    })
    const t = tabConfig(files, 'c:\\work\\acme')
    expect(t.servers.map((s) => [s.name, s.scope])).toEqual([['local', 'local']])
    expect(t.plugins).toEqual([{ id: 'p@m', version: '1', enabled: false }])
  })

  it('a project server is pending until approved, from the folder entry or any settings file; disabledMcpjsonServers rejects it', () => {
    const files = base({
      userConfig: { projects: { [FOLDER]: { enabledMcpjsonServers: ['a'], disabledMcpjsonServers: ['d'] } } },
      projectMcp: { mcpServers: { a: { command: 'a' }, b: { command: 'b' }, c: { command: 'c' }, d: { command: 'd' }, e: { command: 'e' }, f: { command: 'f' } } },
      projectSettings: { enabledMcpjsonServers: ['b'] },
      localSettings: { enabledMcpjsonServers: ['c', 'e'] },
      userSettings: { disabledMcpjsonServers: ['e'] }
    })
    const t = tabConfig(files, FOLDER)
    expect(Object.fromEntries(t.servers.map((s) => [s.name, s.approval]))).toEqual({
      a: 'approved',
      b: 'approved',
      c: 'approved',
      d: 'rejected',
      e: 'rejected',
      f: 'pending'
    })
    // only the approved ones load
    expect(diffConfig(EMPTY, t)).toEqual([
      { kind: 'server-added', name: 'a' },
      { kind: 'server-added', name: 'b' },
      { kind: 'server-added', name: 'c' }
    ])
  })

  it('plugins of another folder are left out; local settings over project over user', () => {
    const files = base({
      installedPlugins: {
        version: 2,
        plugins: {
          'a@m': [{ scope: 'user', installPath: '/p/a', version: '1.0' }],
          'b@m': [{ scope: 'project', projectPath: '/other', installPath: '/p/b', version: '1' }],
          'c@m': [{ scope: 'local', projectPath: FOLDER, installPath: '/p/c', version: '2' }],
          'd@m': [{ scope: 'project', projectPath: FOLDER, installPath: '/p/d', version: '3' }],
          'e@m': [{ scope: 'user', installPath: '/p/e', version: '4' }],
          'f@m': [{ scope: 'user', installPath: '/p/f', version: '5' }]
        }
      },
      userSettings: { enabledPlugins: { 'a@m': true, 'c@m': true, 'd@m': false, 'e@m': false, 'f@m': true } },
      projectSettings: { enabledPlugins: { 'a@m': false, 'b@m': true, 'd@m': true, 'e@m': true, 'f@m': false } },
      localSettings: { enabledPlugins: { 'a@m': true, 'd@m': false } }
    })
    expect(tabConfig(files, FOLDER).plugins.sort(byId)).toEqual([
      { id: 'a@m', version: '1.0', enabled: true },
      { id: 'c@m', version: '2', enabled: true },
      { id: 'd@m', version: '3', enabled: false },
      { id: 'e@m', version: '4', enabled: true },
      { id: 'f@m', version: '5', enabled: false }
    ])
  })

  it('diffConfig names each kind of change', () => {
    expect(diffConfig(tab(), tab([srv('x', 'user', { c: 1 })]))).toEqual([{ kind: 'server-added', name: 'x' }])
    expect(diffConfig(tab([srv('x', 'user', { c: 1 })]), tab())).toEqual([{ kind: 'server-removed', name: 'x' }])
    expect(diffConfig(tab([srv('x', 'user', { c: 1 })]), tab([srv('x', 'user', { c: 2 })]))).toEqual([{ kind: 'server-changed', name: 'x' }])
    expect(diffConfig(tab([srv('y', 'project', { c: 1 }, 'pending')]), tab([srv('y', 'project', { c: 1 }, 'approved')]))).toEqual([
      { kind: 'server-approved', name: 'y' }
    ])
    expect(diffConfig(tab(), tab([], [plug('p@m', '1', true)]))).toEqual([{ kind: 'plugin-installed', name: 'p' }])
    expect(diffConfig(tab([], [plug('p@m', '1', true)]), tab())).toEqual([{ kind: 'plugin-removed', name: 'p' }])
    expect(diffConfig(tab([], [plug('p@m', '1', true)]), tab([], [plug('p@m', '2', true)]))).toEqual([{ kind: 'plugin-updated', name: 'p' }])
    expect(diffConfig(tab([], [plug('p@m', '1', false)]), tab([], [plug('p@m', '1', true)]))).toEqual([{ kind: 'plugin-enabled', name: 'p' }])
    expect(diffConfig(tab([], [plug('p@m', '1', true)]), tab([], [plug('p@m', '1', false)]))).toEqual([{ kind: 'plugin-disabled', name: 'p' }])
  })

  it('other keys of .claude.json, other folders\' entries, disabledMcpServers and a pending project server are no change', () => {
    const before = base({
      userConfig: {
        numStartups: 1,
        mcpServers: { u: { command: 'u' } },
        projects: { [FOLDER]: { disabledMcpServers: [] }, '/elsewhere': { mcpServers: { x: { command: 'x' } } } }
      },
      projectMcp: { mcpServers: {} }
    })
    const after = base({
      userConfig: {
        numStartups: 9,
        mcpServers: { u: { command: 'u' } },
        projects: { [FOLDER]: { disabledMcpServers: ['u'] }, '/elsewhere': { mcpServers: { y: { command: 'y' } } } }
      },
      projectMcp: { mcpServers: { pending: { command: 'p' } } },
      installedPlugins: { plugins: { 'z@m': [{ scope: 'user', installPath: '/p/z', version: '1' }] } },
      userSettings: { enabledPlugins: { 'z@m': false } }
    })
    const now = tabConfig(after, FOLDER)
    expect(now.servers.find((s) => s.name === 'u')?.disabled).toBe(true)
    expect(diffConfig(tabConfig(before, FOLDER), now)).toEqual([])
  })

  it('malformed files, wrong types and nulls configure nothing and never throw', async () => {
    const t = tabConfig(
      base({
        userConfig: 42,
        userSettings: null,
        installedPlugins: [],
        projectMcp: { mcpServers: { n1: null, n2: 'x', n3: [], n4: { command: 'ok' } } },
        projectSettings: { enabledMcpjsonServers: 'n4', enableAllProjectMcpServers: 'yes' },
        localSettings: { enabledPlugins: null, disabledMcpjsonServers: 7 }
      }),
      FOLDER
    )
    expect(t).toEqual({ servers: [srv('n4', 'project', { command: 'ok' }, 'pending')], plugins: [] })

    const broken = tabConfig(
      base({
        userConfig: { mcpServers: 'x', projects: { [FOLDER]: null } },
        installedPlugins: {
          plugins: {
            'bad@m': 'x',
            'bad2@m': [null, { scope: 'user' }],
            'bad3@m': [{ scope: 'user', version: 3 }],
            'bad4@m': [{ scope: 'project', version: '1' }]
          }
        },
        userSettings: { enabledPlugins: { 'bad2@m': 'yes' } }
      }),
      FOLDER
    )
    expect(broken).toEqual(EMPTY)

    const paths = configPaths({}, '/home/dev', FOLDER)
    await expect(
      readTabConfig(paths, FOLDER, async () => {
        throw new Error('boom')
      })
    ).resolves.toEqual(EMPTY)
    await expect(readTabConfig(paths, FOLDER, async (file) => (file === paths.projectMcp ? { mcpServers: { x: { command: 'x' } } } : 42))).resolves.toEqual(
      tab([srv('x', 'project', { command: 'x' }, 'pending')])
    )
  })

  it('jsonFileCache parses a file once per version', async () => {
    const reads: string[] = []
    let stat: { mtimeMs: number; size: number } | null = { mtimeMs: 1, size: 7 }
    const load = jsonFileCache({
      stat: async () => stat,
      read: async (file) => {
        reads.push(file)
        return '{"a":1}'
      }
    })
    const file = join('/cfg', '.claude.json')
    expect(await load(file)).toEqual({ a: 1 })
    expect(await load(file)).toEqual({ a: 1 })
    expect(reads).toHaveLength(1)

    stat = { mtimeMs: 2, size: 7 }
    expect(await load(file)).toEqual({ a: 1 })
    expect(reads).toHaveLength(2)

    stat = { mtimeMs: 3, size: MAX_CONFIG_BYTES + 1 }
    expect(await load(file)).toBeNull()
    expect(reads).toHaveLength(2)

    stat = null
    expect(await load(file)).toBeNull()
  })

  it('jsonFileCache shares a read in flight: callers that ask at once for one version read the file once', async () => {
    const reads: string[] = []
    const load = jsonFileCache({
      stat: async () => ({ mtimeMs: 1, size: 7 }),
      read: async (file) => {
        reads.push(file)
        await new Promise((resolve) => setTimeout(resolve, 5))
        return '{"a":1}'
      }
    })
    const file = join('/cfg', '.claude.json')
    const results = await Promise.all([load(file), load(file), load(file)])
    expect(results).toEqual([{ a: 1 }, { a: 1 }, { a: 1 }])
    expect(reads).toHaveLength(1)
  })

  it('touchesConfig', () => {
    // calls that may change what Claude Code loads
    expect(touchesConfig('Bash', { command: 'cd x\nclaude mcp add-json srv "{}"' })).toBe(true)
    expect(touchesConfig('Bash', { command: 'cd x && claude mcp add-json srv "{}"' })).toBe(true)
    expect(touchesConfig('PowerShell', { command: 'claude.exe plugin install a@b' })).toBe(true)
    expect(touchesConfig('PowerShell', { command: '& "C:\\Tools\\claude.cmd" mcp remove srv' })).toBe(true)
    expect(touchesConfig('Bash', { command: 'cat /w/.claude.json' })).toBe(true)
    expect(touchesConfig('Edit', { file_path: '/w/.mcp.json' })).toBe(true)
    expect(touchesConfig('Write', { file_path: 'C:\\u\\.claude\\settings.local.json' })).toBe(true)
    expect(touchesConfig('MultiEdit', { file_path: '/w/.claude/settings.json' })).toBe(true)
    expect(touchesConfig('NotebookEdit', { notebook_path: '/w/known_marketplaces.json' })).toBe(true)

    // everything else
    expect(touchesConfig('Bash', { command: 'npm test' })).toBe(false)
    expect(touchesConfig('Read', { file_path: '.mcp.json' })).toBe(false)
    expect(touchesConfig('Edit', { file_path: 'src/settings.ts' })).toBe(false)
    expect(touchesConfig('Write', { file_path: '/w/mysettings.json' })).toBe(false)
    expect(touchesConfig('Bash', { command: 'claude --version' })).toBe(false)
    expect(touchesConfig('Edit', null)).toBe(false)
  })

  it('configKey sorts the keys at every level', () => {
    expect(configKey({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } })).toBe(configKey({ a: { c: null, d: [{ x: 2, y: 1 }] }, b: 1 }))
    expect(configKey({ a: [1, 2] })).not.toBe(configKey({ a: [2, 1] }))
  })
})
