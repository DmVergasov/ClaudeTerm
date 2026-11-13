import { describe, expect, it } from 'vitest'
import {
  parseAvailable,
  parseCatalog,
  parseConfigure,
  parseInstalled,
  parseMarketplaces,
  pluginsView,
  type InstalledEntry,
  type MarketplaceEntry
} from '../../src/main/mcp/plugin-cli'

const FOLDER = 'C:\\Work\\Acme'

/** an installed entry as `plugin list --json` prints it, with the fields the tests vary */
function listed(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'docs@acme-tools',
    version: '1.2.0',
    scope: 'user',
    enabled: true,
    installPath: 'C:\\Users\\dev\\.claude\\plugins\\cache\\acme-tools\\docs\\1.2.0',
    installedAt: '2026-11-01T10:00:00.000Z',
    lastUpdated: '2026-11-01T10:00:00.000Z',
    projectPath: null,
    mcpServers: { docs: {} },
    ...over
  }
}

/** an installed entry already read, for pluginsView */
function installed(over: Partial<InstalledEntry>): InstalledEntry {
  return {
    id: 'docs@acme-tools',
    name: 'docs',
    marketplace: 'acme-tools',
    version: '1.2.0',
    scope: 'user',
    enabled: true,
    projectPath: null,
    mcpServers: 1,
    errors: [],
    ...over
  }
}

function market(plugins: Record<string, { version?: string; description?: string }>): Map<string, { version: string | null; description: string }> {
  return new Map(Object.entries(plugins).map(([plugin, value]) => [plugin, { version: value.version ?? null, description: value.description ?? '' }]))
}

describe('plugin-cli', () => {
  it('parseInstalled reads list --json and the installed part of --available', () => {
    const list = [
      listed({}),
      listed({ id: 'notes@acme-tools', version: undefined, scope: 'project', enabled: false, projectPath: 'C:\\Work\\Acme', mcpServers: {} })
    ]
    const entries = parseInstalled(list)
    expect(entries).toEqual([
      {
        id: 'docs@acme-tools',
        name: 'docs',
        marketplace: 'acme-tools',
        version: '1.2.0',
        scope: 'user',
        enabled: true,
        projectPath: null,
        mcpServers: 1,
        errors: []
      },
      {
        id: 'notes@acme-tools',
        name: 'notes',
        marketplace: 'acme-tools',
        version: 'unknown',
        scope: 'project',
        enabled: false,
        projectPath: 'C:\\Work\\Acme',
        mcpServers: 0,
        errors: []
      }
    ])
    // the installed part of --available is the same list
    expect(parseInstalled({ installed: list, available: [] })).toEqual(entries)
  })

  it('parseInstalled splits the id at the last @ and keeps the errors the CLI reports', () => {
    const [entry] = parseInstalled([listed({ id: 'scope@one@acme-tools', errors: ['Server "docs" failed to start', 42, ''] })])
    expect(entry.name).toBe('scope@one')
    expect(entry.marketplace).toBe('acme-tools')
    expect(entry.errors).toEqual(['Server "docs" failed to start', ''])
  })

  it('parseAvailable keeps the install counts', () => {
    const available = parseAvailable({
      installed: [],
      available: [
        { pluginId: 'lint@acme-tools', name: 'lint', description: 'Lints the tree', marketplaceName: 'acme-tools', version: '2.0.1', source: 'fake', installCount: 1200 },
        { pluginId: 'deploy@other', name: 'deploy', description: '', marketplaceName: 'other', version: '0.3.0', source: 'fake', installCount: 0 },
        { pluginId: 'bare@other', name: 'bare', description: 'No count', marketplaceName: 'other', version: null, source: 'fake' }
      ]
    })
    expect(available).toEqual([
      { id: 'lint@acme-tools', name: 'lint', marketplace: 'acme-tools', description: 'Lints the tree', version: '2.0.1', installs: 1200 },
      { id: 'deploy@other', name: 'deploy', marketplace: 'other', description: '', version: '0.3.0', installs: 0 },
      { id: 'bare@other', name: 'bare', marketplace: 'other', description: 'No count', version: null, installs: null }
    ])
  })

  it('parseMarketplaces names each source as the person knows it', () => {
    const markets = parseMarketplaces([
      { name: 'acme-tools', source: 'github', repo: 'acme/claude-tools', installLocation: 'C:\\Users\\dev\\.claude\\plugins\\marketplaces\\acme-tools' },
      { name: 'mirror', source: 'git', url: 'https://git.example.test/mirror.git', installLocation: null },
      { name: 'web', source: 'url', url: 'https://plugins.example.test/marketplace.json', installLocation: null },
      { name: 'local', source: 'directory', path: 'C:\\Work\\plugins', installLocation: 'C:\\Work\\plugins' },
      { name: 'file', source: 'file', path: '/home/dev/marketplace.json', installLocation: null },
      { name: 'odd', source: 'npm', installLocation: null }
    ])
    expect(markets).toEqual<MarketplaceEntry[]>([
      { name: 'acme-tools', source: 'acme/claude-tools', installLocation: 'C:\\Users\\dev\\.claude\\plugins\\marketplaces\\acme-tools' },
      { name: 'mirror', source: 'https://git.example.test/mirror.git', installLocation: null },
      { name: 'web', source: 'https://plugins.example.test/marketplace.json', installLocation: null },
      { name: 'local', source: 'C:\\Work\\plugins', installLocation: 'C:\\Work\\plugins' },
      { name: 'file', source: '/home/dev/marketplace.json', installLocation: null }
    ])
  })

  it('parseCatalog reads a marketplace.json plugins by name', () => {
    const catalog = parseCatalog({
      name: 'acme-tools',
      plugins: [
        { name: 'docs', description: 'Documentation tools', version: '1.3.0' },
        { name: 'lint', description: 'Lints the tree' },
        { name: 42, version: '9.9.9' }
      ]
    })
    expect(catalog).toEqual(
      new Map([
        ['docs', { version: '1.3.0', description: 'Documentation tools' }],
        ['lint', { version: null, description: 'Lints the tree' }]
      ])
    )
  })

  it('parseConfigure gives the required options not set yet', () => {
    const options = parseConfigure({
      pluginId: 'docs@acme-tools',
      displayName: 'docs',
      schema: {
        apiUrl: { type: 'string', title: 'API address', description: 'Where the docs live', required: true, sensitive: false },
        token: { type: 'string', title: 'Token', description: 'Access token', required: true, sensitive: true },
        region: { type: 'string', title: 'Region', description: '', required: false, sensitive: false }
      },
      configured: ['apiUrl'],
      unconfigured: ['token', 'region']
    })
    expect(options).toEqual([{ key: 'token', title: 'Token', description: 'Access token', sensitive: true }])
  })

  it('an installed plugin whose catalog names another version has an update; unknown has none', () => {
    const catalogs = new Map([
      ['acme-tools', market({ docs: { version: '1.3.0', description: 'Documentation tools' }, lint: { version: '2.0.0' } })]
    ])
    const view = pluginsView(
      [installed({ name: 'docs', version: '1.2.0' }), installed({ id: 'lint@acme-tools', name: 'lint', version: 'unknown' })],
      [],
      [],
      catalogs,
      FOLDER
    )
    expect(view.installed.map((p) => [p.name, p.update, p.description])).toEqual([
      ['docs', '1.3.0', 'Documentation tools'],
      ['lint', null, '']
    ])
    // the same version in the catalog is no update
    const same = pluginsView([installed({ version: '1.3.0' })], [], [], catalogs, FOLDER)
    expect(same.installed[0].update).toBeNull()
  })

  it('plugins installed for another folder are left out', () => {
    const view = pluginsView(
      [
        installed({ name: 'docs', scope: 'user' }),
        installed({ id: 'notes@acme-tools', name: 'notes', scope: 'project', projectPath: 'C:\\Work\\Acme\\' }),
        installed({ id: 'secret@acme-tools', name: 'secret', scope: 'local', projectPath: 'C:\\Work\\Other' }),
        installed({ id: 'managed@acme-tools', name: 'managed', scope: 'managed' }),
        installed({ id: 'elsewhere@acme-tools', name: 'elsewhere', scope: 'project', projectPath: null })
      ],
      [],
      [],
      new Map(),
      'c:/work/acme'
    )
    expect(view.installed.map((p) => p.name)).toEqual(['docs', 'notes'])
  })

  it('malformed output gives empty lists', () => {
    const junk: unknown[] = [null, undefined, 'plugins', 42, true, {}, { installed: 'none' }, [null, 7, 'x', []], [{ version: '1.0.0' }]]
    for (const value of junk) {
      expect(parseInstalled(value)).toEqual([])
      expect(parseAvailable(value)).toEqual([])
      expect(parseMarketplaces(value)).toEqual([])
      expect(parseCatalog(value)).toEqual(new Map())
      expect(parseConfigure(value)).toEqual([])
    }
    expect(parseInstalled([listed({ scope: undefined })])).toEqual([])
    expect(parseInstalled([listed({ id: 'x'.repeat(201) })])).toEqual([])
    expect(parseAvailable({ available: [{ name: 'no-id' }] })).toEqual([])
    expect(parseConfigure({ schema: [], configured: [] })).toEqual([])
    const view = pluginsView([], [], [], new Map(), FOLDER)
    expect(view).toEqual({ installed: [], available: [], marketplaces: [] })
  })

  it('caps the text it keeps and drops what cannot be named', () => {
    const [entry] = parseInstalled([listed({ version: 'v'.repeat(150), errors: ['e'.repeat(2500)] })])
    expect(entry.version).toHaveLength(100)
    expect(entry.errors[0]).toHaveLength(2000)
    const many = parseInstalled([listed({ errors: Array.from({ length: 30 }, (_, i) => `error ${i}`) })])
    expect(many[0].errors).toHaveLength(20)
    const [offer] = parseAvailable([{ pluginId: 'big@acme-tools', name: 'big', description: 'd'.repeat(2500), marketplaceName: 'acme-tools', version: null }])
    expect(offer.description).toHaveLength(2000)
  })

  it('pluginsView sorts the lists and names the marketplaces by name', () => {
    const view = pluginsView(
      [installed({ id: 'zeta@m', name: 'zeta', marketplace: 'm' }), installed({ id: 'alpha@m', name: 'alpha', marketplace: 'm' })],
      [
        { id: 'b@z', name: 'b', marketplace: 'z', description: '', version: null, installs: null },
        { id: 'a@z', name: 'a', marketplace: 'z', description: '', version: null, installs: 3 },
        { id: 'c@a', name: 'c', marketplace: 'a', description: '', version: null, installs: null }
      ],
      [
        { name: 'z', source: 'acme/zz', installLocation: null },
        { name: 'a', source: 'https://example.test/a.json', installLocation: null }
      ],
      new Map(),
      FOLDER
    )
    expect(view.installed.map((p) => p.name)).toEqual(['alpha', 'zeta'])
    expect(view.available.map((p) => p.id)).toEqual(['c@a', 'a@z', 'b@z'])
    expect(view.marketplaces).toEqual([
      { name: 'a', source: 'https://example.test/a.json' },
      { name: 'z', source: 'acme/zz' }
    ])
  })
})
