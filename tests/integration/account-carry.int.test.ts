import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loginEnv } from '../../src/main/accounts'
import { MASK, MAX_CONFIG_BYTES, carryItem, copyTree, readSource, type CarryDeps, type SourceFolder } from '../../src/main/account-carry-run'
import { CliError, runClaudeCli } from '../../src/main/mcp/claude-cli'
import { buildChildEnv, applyEnvPatch } from '../../src/main/child-env'
import { resolveChatLaunch, type ChatLaunch } from '../../src/main/chat/claude-spawn'
import type { CarryItem } from '../../src/shared/accounts'
import { MAIN_CREDENTIAL, hashTree, readLog, runs } from '../fixtures/accounts'
import { installFakeClaude } from '../fixtures/fake-claude/install'
import type { FakeScript } from '../fixtures/fake-claude/install'

// the carry-over runner against real folders: the source is a temp config folder, the account is another one, and the
// Claude Code commands are the stand-in (tests/fixtures/fake-claude) run with the account's environment

const SOURCE_NAME = 'Main account'
const TARGET_NAME = 'Work'
const SECRET_HEADER = 'sk-header-secret'
// a directory link: a junction on Windows (no privilege needed), a directory symlink elsewhere
const LINK = process.platform === 'win32' ? 'junction' : 'dir'
const OLD = new Date('2020-01-01T00:00:00Z')
const ORDER: CarryItem[] = ['settings', 'hooks', 'mcp', 'plugins', 'skills', 'agents', 'commands', 'memory', 'keybindings', 'output-styles', 'trust']

let dir: string
let source: string
let target: string
let work: string
let log: string
let scriptFile: string
let launch: Exclude<ChatLaunch, { how: 'none' }>
let warnings: string[]
let alpha: string
let beta: string
let gamma: string

// the environment of the test process, without the values Node leaves undefined: a Windows command needs its own PATH
function base(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))
}

function write(file: string, text: string): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text)
}

function writeJson(file: string, value: unknown): void {
  write(file, JSON.stringify(value, null, 2))
}

function readJson(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
}

function writeScript(script: FakeScript): void {
  writeFileSync(scriptFile, JSON.stringify(script))
}

// the plugin catalogue of the source's marketplace: `paid` runs a command to install, `tools` and `old` do not
const MARKETPLACE: FakeScript['marketplaces'] = [
  {
    name: 'lab',
    source: 'acme/claude-lab',
    plugins: [
      { name: 'tools', description: 'Tools.', version: '1.0.0' },
      { name: 'old', description: 'Old tools.', version: '1.0.0' },
      { name: 'paid', description: 'Paid tools.', version: '1.0.0', installCommand: 'sh -c "echo paid"' }
    ]
  }
]

// the source account: settings with secrets and hooks, two MCP servers and ClaudeTerm's own, plugins, the folder items,
// trusted folders, a conversation and the credential file
function seedSource(): void {
  writeJson(join(source, 'settings.json'), {
    model: 'claude-haiku-5-5',
    theme: 'dark',
    env: { FEATURE_FLAG: '1', ANTHROPIC_API_KEY: 'sk-ant-source-key-0001', CLAUDE_CODE_USE_BEDROCK: '1' },
    apiKeyHelper: '/opt/keys/print-key',
    enabledPlugins: { 'tools@lab': true, 'old@lab': false },
    extraKnownMarketplaces: { lab: { source: { source: 'github', repo: 'acme/claude-lab' } } },
    hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node hook.js' }] }] }
  })
  writeJson(join(source, '.claude.json'), {
    oauthAccount: { emailAddress: 'main@example.com', organizationName: 'Example', organizationUuid: '00000000-0000-4000-8000-000000000001', organizationType: 'claude_max' },
    mcpServers: {
      claudeterm: { type: 'stdio', command: 'node', args: ['show-image.js'] },
      docs: { type: 'stdio', command: 'node', args: ['docs.js'], env: { DOCS_TOKEN: 'docs-env-secret-0001' } },
      api: { type: 'http', url: 'https://api.example.com/mcp', headers: { 'X-Key': SECRET_HEADER } }
    },
    projects: {
      [alpha]: { hasTrustDialogAccepted: true },
      [beta]: { hasTrustDialogAccepted: true, allowedTools: [] },
      [gamma]: { hasTrustDialogAccepted: false }
    }
  })
  write(join(source, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: MAIN_CREDENTIAL } }))
  write(join(source, 'skills', 'review', 'SKILL.md'), 'source review skill')
  write(join(source, 'skills', 'review', 'notes.md'), 'source review notes')
  write(join(source, 'agents', 'planner.md'), 'source planner agent')
  write(join(source, 'commands', 'ship.md'), 'source ship command')
  write(join(source, 'output-styles', 'terse.md'), 'source terse style')
  write(join(source, 'CLAUDE.md'), 'source memory')
  write(join(source, 'rules', 'style.md'), 'source rule')
  write(join(source, 'keybindings.json'), '{"bindings":[]}')
  write(join(source, 'projects', '-work', 'conversation.jsonl'), '{"type":"user"}\n')
  writeJson(join(source, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'tools@lab': [{ scope: 'user', version: '1.0.0' }],
      'old@lab': [{ scope: 'user', version: '1.0.0' }],
      'paid@lab': [{ scope: 'user', version: '1.0.0' }],
      'cloud-tool@claude-hosted': [{ scope: 'user', version: '2.0.0' }],
      'scratch@lab': [{ scope: 'project', version: '0.1.0' }]
    }
  })
  writeJson(join(source, 'plugins', 'known_marketplaces.json'), {
    lab: { source: { source: 'github', repo: 'acme/claude-lab' }, installLocation: join(source, 'plugins', 'marketplaces', 'lab') },
    'claude-hosted': { source: { source: 'claude.ai' }, installLocation: join(source, 'plugins', 'marketplaces', 'claude-hosted') }
  })
}

// a link removed by its path, never what it points to: a junction is removed as a directory
function unlinkLinkSync(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    rmdirSync(path)
  }
}

function deps(): CarryDeps {
  const env = applyEnvPatch(
    { ...buildChildEnv(base()), FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_SCRIPT: scriptFile, CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-host', ANTHROPIC_API_KEY: 'sk-host-key' },
    loginEnv(target)
  )
  return {
    source: { configDir: source, claudeJson: join(source, '.claude.json') },
    sourceName: SOURCE_NAME,
    target: { id: 'work', name: TARGET_NAME, folder: target },
    cli: (args) => runClaudeCli(launch, args, { cwd: work, env }),
    log: { warn: (m) => warnings.push(m) }
  }
}

// every file under a folder, as text, to look for a value in it
function everyText(folder: string): string {
  if (!existsSync(folder)) return ''
  return readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
    .join('\n')
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'account-carry-'))
  source = join(dir, 'main')
  target = join(dir, 'work')
  work = join(dir, 'home')
  log = join(dir, 'claude.log')
  scriptFile = join(dir, 'script.json')
  alpha = join(dir, 'projects', 'alpha')
  beta = join(dir, 'projects', 'beta')
  gamma = join(dir, 'projects', 'gamma')
  mkdirSync(target, { recursive: true })
  mkdirSync(work, { recursive: true })
  warnings = []
  writeScript({ turns: {}, marketplaces: MARKETPLACE })
  seedSource()
  const command = installFakeClaude(join(dir, 'bin'))
  const resolved = await resolveChatLaunch(command, {
    platform: process.platform,
    isFile: (p) => existsSync(p),
    isExecutable: (p) => existsSync(p),
    where: async () => [],
    loginShell: () => '/bin/sh'
  })
  if (resolved.how === 'none') throw new Error(resolved.reason)
  launch = resolved
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// every item in the order the flow runs them
async function carryAll(): Promise<{ item: string; state: string; text: string; subs: string[] }[]> {
  const lines = []
  for (const item of ORDER) lines.push(await carryItem(item, deps()))
  return lines
}

describe('carry-over', () => {
  it('carry-over into a fresh folder copies the trees and never changes the source', async () => {
    const before = hashTree(source)
    const lines = await carryAll()
    expect(hashTree(source)).toBe(before)

    expect(lines.map(({ item, state, text }) => ({ item, state, text }))).toEqual([
      { item: 'settings', state: 'done', text: '3 settings' },
      { item: 'hooks', state: 'done', text: '1 hook' },
      { item: 'mcp', state: 'done', text: '2 added' },
      { item: 'plugins', state: 'skipped', text: '2 of 4 installed · 2 skipped' },
      { item: 'skills', state: 'done', text: '2 files' },
      { item: 'agents', state: 'done', text: '1 file' },
      { item: 'commands', state: 'done', text: '1 file' },
      { item: 'memory', state: 'done', text: '2 files' },
      { item: 'keybindings', state: 'done', text: '1 file' },
      { item: 'output-styles', state: 'done', text: '1 file' },
      { item: 'trust', state: 'done', text: '2 folders' }
    ])
    expect(readFileSync(join(target, 'skills', 'review', 'notes.md'), 'utf8')).toBe('source review notes')
    expect(readFileSync(join(target, 'rules', 'style.md'), 'utf8')).toBe('source rule')
    expect(existsSync(join(target, 'projects'))).toBe(false)
  })

  it("the source's .credentials.json is never in the account", async () => {
    await carryAll()
    expect(everyText(target)).not.toContain(MAIN_CREDENTIAL)
  })

  it("settings carry without hooks, plugins or credentials; hooks replace the account's hooks", async () => {
    writeJson(join(target, 'settings.json'), {
      theme: 'light',
      env: { LOCAL: 'yes', FEATURE_FLAG: '0' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'old hook' }] }] }
    })

    const settings = await carryItem('settings', deps())
    expect(settings).toMatchObject({ item: 'settings', state: 'done', text: '3 settings' })
    expect(readJson(join(target, 'settings.json'))).toEqual({
      theme: 'dark',
      model: 'claude-haiku-5-5',
      env: { LOCAL: 'yes', FEATURE_FLAG: '1' },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'old hook' }] }] }
    })

    const hooks = await carryItem('hooks', deps())
    expect(hooks).toMatchObject({ item: 'hooks', state: 'done', text: '1 hook' })
    expect(readJson(join(target, 'settings.json'))).toEqual({
      theme: 'dark',
      model: 'claude-haiku-5-5',
      env: { LOCAL: 'yes', FEATURE_FLAG: '1' },
      hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node hook.js' }] }] }
    })
  })

  it('a same-named file is replaced and what only the account has stays', async () => {
    write(join(target, 'skills', 'review', 'SKILL.md'), 'account review skill')
    write(join(target, 'skills', 'review', 'own.md'), 'only the account')

    const line = await carryItem('skills', deps())
    expect(line).toMatchObject({ item: 'skills', state: 'done', text: '2 files' })
    expect(readFileSync(join(target, 'skills', 'review', 'SKILL.md'), 'utf8')).toBe('source review skill')
    expect(readFileSync(join(target, 'skills', 'review', 'own.md'), 'utf8')).toBe('only the account')
    expect(readdirSync(join(target, 'skills', 'review')).sort()).toEqual(['SKILL.md', 'notes.md', 'own.md'])
  })

  it("MCP servers are added with add-json in the account's folder, without a token or a key", async () => {
    const sourceServers = readJson(join(source, '.claude.json')).mcpServers as Record<string, unknown>
    const line = await carryItem('mcp', deps())
    expect(line).toMatchObject({ item: 'mcp', state: 'done', text: '2 added' })

    const calls = runs(() => readLog(log)).filter((run) => run.argv[0] === 'mcp')
    expect(calls.map((run) => run.argv)).toEqual([
      ['mcp', 'remove', '--scope', 'user', '--', 'api'],
      ['mcp', 'add-json', '--scope', 'user', '--', 'api', JSON.stringify(sourceServers.api)],
      ['mcp', 'remove', '--scope', 'user', '--', 'docs'],
      ['mcp', 'add-json', '--scope', 'user', '--', 'docs', JSON.stringify(sourceServers.docs)]
    ])
    for (const call of calls) {
      expect(call.config).toBe(target)
      expect(call.oauthToken).toBe(false)
      expect(call.apiKey).toBe(false)
    }
    const servers = readJson(join(target, '.claude.json')).mcpServers as Record<string, unknown>
    expect(Object.keys(servers).sort()).toEqual(['api', 'docs'])
  })

  it("a failed add-json says Claude Code's message with the server's secrets masked and logs only its name and code", async () => {
    writeScript({ turns: {}, marketplaces: MARKETPLACE, cliFail: { 'mcp add-json': `Invalid JSON: {"headers":{"X-Key":"${SECRET_HEADER}"}}` } })

    const line = await carryItem('mcp', deps())
    expect(line.state).toBe('failed')
    expect(line.text).toBe(`0 of 2 · api: Invalid JSON: {"headers":{"X-Key":"${MASK}"}}`)
    expect(line.text).not.toContain(SECRET_HEADER)
    expect(warnings).toEqual(['claude mcp add-json failed for api (1)', 'claude mcp add-json failed for docs (1)'])
    expect(warnings.join('\n')).not.toContain(SECRET_HEADER)
    expect(warnings.join('\n')).not.toContain('docs-env-secret-0001')
  })

  it('plugins: the marketplace added, the plugin installed and turned off as in the source; one needing a confirmed command and a claude.ai marketplace skipped and named', async () => {
    const line = await carryItem('plugins', deps())
    expect(line).toEqual({
      item: 'plugins',
      state: 'skipped',
      text: '2 of 4 installed · 2 skipped',
      subs: [
        'claude-hosted: hosted by claude.ai for Main account',
        'paid: its marketplace runs a command to install it — install it from MCP · Plugins in a chat on Work'
      ]
    })

    expect(readJson(join(target, 'plugins', 'known_marketplaces.json'))).toHaveProperty('lab')
    const registry = readJson(join(target, 'plugins', 'installed_plugins.json')).plugins as Record<string, unknown>
    expect(Object.keys(registry).sort()).toEqual(['old@lab', 'tools@lab'])
    expect(readJson(join(target, 'settings.json')).enabledPlugins).toEqual({ 'tools@lab': true, 'old@lab': false })

    const installs = runs(() => readLog(log))
      .map((run) => run.argv)
      .filter((argv) => argv[0] === 'plugin' && argv[1] === 'install')
      .map((argv) => argv.at(-1))
    expect(installs).toEqual(['old@lab', 'paid@lab', 'tools@lab'])
    expect(runs(() => readLog(log)).some((run) => run.argv.includes('cloud-tool@claude-hosted'))).toBe(false)
  })

  it('an already installed plugin counts as done', async () => {
    writeJson(join(target, 'plugins', 'installed_plugins.json'), {
      version: 2,
      plugins: { 'tools@lab': [{ scope: 'user', version: '1.0.0' }] }
    })

    const line = await carryItem('plugins', deps())
    expect(line).toMatchObject({ item: 'plugins', state: 'skipped', text: '2 of 4 installed · 2 skipped' })
    const installs = runs(() => readLog(log))
      .map((run) => run.argv)
      .filter((argv) => argv[0] === 'plugin' && argv[1] === 'install')
      .map((argv) => argv.at(-1))
    expect(installs).not.toContain('tools@lab')
    expect(installs).toContain('old@lab')
  })

  it('trusted folders add only the flag after the other items', async () => {
    writeJson(join(target, '.claude.json'), {
      oauthAccount: { emailAddress: 'work@example.com' },
      projects: { [beta]: { allowedTools: ['Bash'] } }
    })
    await carryItem('mcp', deps())

    const line = await carryItem('trust', deps())
    expect(line).toEqual({ item: 'trust', state: 'done', text: '2 folders', subs: [] })
    const doc = readJson(join(target, '.claude.json'))
    expect(doc.oauthAccount).toEqual({ emailAddress: 'work@example.com' })
    expect(Object.keys(doc.mcpServers).sort()).toEqual(['api', 'docs'])
    expect(doc.projects[alpha]).toEqual({ hasTrustDialogAccepted: true })
    expect(doc.projects[beta]).toEqual({ allowedTools: ['Bash'], hasTrustDialogAccepted: true })
    expect(doc.projects[gamma]).toBeUndefined()
  })

  it('an account settings.json that is not JSON fails the item and stays as it was', async () => {
    write(join(target, 'settings.json'), '{ not json')
    expect(await carryItem('settings', deps())).toEqual({
      item: 'settings',
      state: 'failed',
      text: 'settings.json of Work cannot be read: left as it was',
      subs: []
    })
    expect(await carryItem('hooks', deps())).toMatchObject({ item: 'hooks', state: 'failed' })
    expect(readFileSync(join(target, 'settings.json'), 'utf8')).toBe('{ not json')

    write(join(target, '.claude.json'), '[1, 2]')
    expect(await carryItem('trust', deps())).toEqual({
      item: 'trust',
      state: 'failed',
      text: '.claude.json of Work cannot be read: left as it was',
      subs: []
    })
    expect(readFileSync(join(target, '.claude.json'), 'utf8')).toBe('[1, 2]')
  })

  it('a symlink in a copied folder is recreated or its content copied', async () => {
    const shared = join(dir, 'shared-skill')
    write(join(shared, 'note.md'), 'shared note')
    utimesSync(join(shared, 'note.md'), OLD, OLD)
    symlinkSync(shared, join(source, 'skills', 'linked'), LINK)
    const before = hashTree(source)

    expect(await carryItem('skills', deps())).toMatchObject({ item: 'skills', state: 'done', text: '3 files' })
    expect(await carryItem('skills', deps())).toMatchObject({ item: 'skills', state: 'done', text: '3 files' })
    expect(readFileSync(join(target, 'skills', 'linked', 'note.md'), 'utf8')).toBe('shared note')
    expect(statSync(join(shared, 'note.md')).mtimeMs).toBe(OLD.getTime())
    expect(readFileSync(join(shared, 'note.md'), 'utf8')).toBe('shared note')
    const copied = join(target, 'skills', 'linked')
    if (lstatSync(copied).isSymbolicLink()) {
      expect(readlinkSync(copied)).toBe(readlinkSync(join(source, 'skills', 'linked')))
    }
    expect(hashTree(source)).toBe(before)
  })

  it('a link into a carried item is carried as a copy of its content, never as a link into the source', async () => {
    write(join(source, 'agents', 'x', 'a.md'), 'agent x')
    symlinkSync(join(source, 'agents', 'x'), join(source, 'skills', 'shared'), LINK)
    const before = hashTree(source)

    expect(await carryItem('skills', deps())).toMatchObject({ item: 'skills', state: 'done', text: '3 files' })
    expect(hashTree(source)).toBe(before)
    expect(lstatSync(join(target, 'skills', 'shared')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(target, 'skills', 'shared', 'a.md'), 'utf8')).toBe('agent x')
  })

  it("a link into the source outside the carried items is not carried, and the account's own link of that name stays", async () => {
    const store = join(source, 'store')
    write(join(store, 'foo', 'SKILL.md'), 'store skill')
    utimesSync(join(store, 'foo', 'SKILL.md'), OLD, OLD)
    symlinkSync(join(store, 'foo'), join(source, 'skills', 'foo'), LINK)
    // the account's own same-named link, from an earlier carry: it is left as it is
    mkdirSync(join(target, 'skills'), { recursive: true })
    symlinkSync(store, join(target, 'skills', 'foo'), LINK)
    const before = hashTree(source)

    const line = await carryItem('skills', deps())
    expect(line).toMatchObject({ item: 'skills', state: 'done', text: '2 files' })
    expect(line.subs).toEqual(["foo: a link to store/foo in Main account's folder, not carried"])
    expect(hashTree(source)).toBe(before)
    expect(statSync(join(store, 'foo', 'SKILL.md')).mtimeMs).toBe(OLD.getTime())
    expect(lstatSync(join(target, 'skills', 'foo')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(target, 'skills', 'foo'))).toBe(store)
  })

  it('a link to the source history or credentials is not carried, and its sub-line is relative to the item', async () => {
    mkdirSync(join(source, 'skills', 'foo'), { recursive: true })
    // a junction (or a directory symlink) into the transcripts, nested in a folder of the item
    symlinkSync(join(source, 'projects'), join(source, 'skills', 'foo', 'back'), LINK)
    symlinkSync(join(source, 'projects'), join(source, 'skills', 'hist'), LINK)
    const before = hashTree(source)

    const line = await carryItem('skills', deps())
    expect(line).toMatchObject({ item: 'skills', state: 'done', text: '2 files' })
    expect([...line.subs].sort()).toEqual(['foo/back: a link to projects in Main account\'s folder, not carried', 'hist: a link to projects in Main account\'s folder, not carried'])
    expect(() => lstatSync(join(target, 'skills', 'hist'))).toThrow()
    expect(hashTree(source)).toBe(before)
  })

  it('a carried item path that is itself a link into the history does not make the history a carried path', async () => {
    rmSync(join(source, 'rules'), { recursive: true })
    symlinkSync(join(source, 'projects'), join(source, 'rules'), LINK)
    symlinkSync(join(source, 'projects'), join(source, 'skills', 'hist'), LINK)
    const before = hashTree(source)

    const memory = await carryItem('memory', deps())
    expect(memory.subs).toEqual(["rules: a link to projects in Main account's folder, not carried"])
    const skills = await carryItem('skills', deps())
    expect(skills.subs).toEqual(["hist: a link to projects in Main account's folder, not carried"])
    expect(() => lstatSync(join(target, 'rules'))).toThrow()
    expect(() => lstatSync(join(target, 'skills', 'hist'))).toThrow()
    expect(hashTree(source)).toBe(before)
  })

  it.skipIf(process.platform === 'win32')('a file link to the credentials, from anywhere in the item, is not carried', async () => {
    symlinkSync(join(source, '.credentials.json'), join(source, 'skills', 'abs-creds'))
    symlinkSync('../../.credentials.json', join(source, 'skills', 'review', 'rel-creds'))

    const line = await carryItem('skills', deps())
    expect(line).toMatchObject({ item: 'skills', state: 'done', text: '2 files' })
    expect([...line.subs].sort()).toEqual([
      "abs-creds: a link to .credentials.json in Main account's folder, not carried",
      "review/rel-creds: a link to .credentials.json in Main account's folder, not carried"
    ])
    expect(everyText(target)).not.toContain(MAIN_CREDENTIAL)
  })

  it.skipIf(process.platform === 'win32')('a link to the source .claude.json is not carried, even when that file lies outside the source folder', async () => {
    const outside = join(dir, 'home', '.claude.json')
    write(outside, '{"projects":{}}')
    symlinkSync(outside, join(source, 'skills', 'cj'))

    const line = await carryItem('skills', { ...deps(), source: { configDir: source, claudeJson: outside } })
    expect(line.subs).toEqual(["cj: a link to .claude.json in Main account's folder, not carried"])
    expect(() => lstatSync(join(target, 'skills', 'cj'))).toThrow()
    expect(readFileSync(outside, 'utf8')).toBe('{"projects":{}}')
  })

  it.skipIf(process.platform === 'win32')('a single-file item that is itself such a link names its own file', async () => {
    unlinkSync(join(source, 'CLAUDE.md'))
    symlinkSync(join(source, '.credentials.json'), join(source, 'CLAUDE.md'))

    const line = await carryItem('memory', deps())
    expect(line.subs).toEqual(["CLAUDE.md: a link to .credentials.json in Main account's folder, not carried"])
    expect(() => lstatSync(join(target, 'CLAUDE.md'))).toThrow()
  })

  it("a link to the source folder itself is not carried, and the account's own link of that name survives", async () => {
    const ext = join(dir, 'outside', 'mine')
    write(join(ext, 'a.md'), 'mine')
    mkdirSync(join(target, 'skills'), { recursive: true })
    symlinkSync(ext, join(target, 'skills', 'self'), LINK)
    symlinkSync(source, join(source, 'skills', 'self'), LINK)

    const line = await carryItem('skills', deps())
    expect(line).toMatchObject({ item: 'skills', state: 'done', text: '2 files' })
    expect(line.subs).toEqual(["self: a link to Main account's whole folder, not carried"])
    expect(lstatSync(join(target, 'skills', 'self')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(target, 'skills', 'self'))).toBe(ext)
  })

  it('a link to a folder above the link is not carried', async () => {
    symlinkSync(join(source, 'skills'), join(source, 'skills', 'up'), LINK)

    const line = await carryItem('skills', deps())
    expect(line).toMatchObject({ item: 'skills', state: 'done', text: '2 files' })
    expect(line.subs).toEqual(['up: a link to a folder above it, not carried'])
    expect(existsSync(join(target, 'skills', 'up'))).toBe(false)
  })

  it('a second carry that repoints a link does not write into the old target', async () => {
    const ext1 = join(dir, 'outside', 'ext1')
    const ext2 = join(dir, 'outside', 'ext2')
    write(join(ext1, 'a.md'), 'ext1 original')
    write(join(ext2, 'a.md'), 'ext2 content')
    symlinkSync(ext1, join(source, 'skills', 'ext'), LINK)
    expect(await carryItem('skills', deps())).toMatchObject({ item: 'skills', state: 'done' })

    unlinkLinkSync(join(source, 'skills', 'ext'))
    symlinkSync(ext2, join(source, 'skills', 'ext'), LINK)
    expect(await carryItem('skills', deps())).toMatchObject({ item: 'skills', state: 'done' })
    expect(readFileSync(join(ext1, 'a.md'), 'utf8')).toBe('ext1 original')
    expect(readFileSync(join(target, 'skills', 'ext', 'a.md'), 'utf8')).toBe('ext2 content')
  })

  it.skipIf(process.platform === 'win32')('a relative link that resolves from the config folder real place is not carried, even when the config folder is reached through a link', async () => {
    // the config folder is reached through a link (a stow-style folder). From the link's place the target `../../claude`
    // is another folder; from the real place it is the config folder itself
    const real = join(dir, 'dotfiles', 'claude')
    write(join(real, '.credentials.json'), MAIN_CREDENTIAL)
    write(join(real, 'skills', 'review', 'SKILL.md'), 'review')
    symlinkSync(real, join(dir, 'claude-link'), LINK)
    source = join(dir, 'claude-link')
    symlinkSync('../../claude', join(real, 'skills', 'x'))
    const before = hashTree(real)

    const line = await carryItem('skills', deps())
    expect(line).toMatchObject({ item: 'skills', state: 'done', text: '1 file' })
    expect(line.subs).toEqual(["x: a link to Main account's whole folder, not carried"])
    expect(() => lstatSync(join(target, 'skills', 'x'))).toThrow()
    expect(everyText(target)).not.toContain(MAIN_CREDENTIAL)
    expect(hashTree(real)).toBe(before)
  })

  it('a folder carried over a link in the account replaces the link and never writes through it', async () => {
    const elsewhere = join(dir, 'elsewhere')
    write(join(elsewhere, 'keep.md'), 'elsewhere file')
    utimesSync(join(elsewhere, 'keep.md'), OLD, OLD)
    write(join(source, 'skills', 'real-dir', 'a.md'), 'source a')
    mkdirSync(join(target, 'skills'), { recursive: true })
    symlinkSync(elsewhere, join(target, 'skills', 'real-dir'), LINK)
    const before = hashTree(elsewhere)

    expect(await carryItem('skills', deps())).toMatchObject({ item: 'skills', state: 'done' })
    expect(hashTree(elsewhere)).toBe(before)
    expect(statSync(join(elsewhere, 'keep.md')).mtimeMs).toBe(OLD.getTime())
    expect(lstatSync(join(target, 'skills', 'real-dir')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(target, 'skills', 'real-dir', 'a.md'), 'utf8')).toBe('source a')
  })

  it('a link to a folder holding the source is not carried and does not loop', async () => {
    symlinkSync(dir, join(source, 'skills', 'loop'), LINK)
    const before = hashTree(source)

    const line = await carryItem('skills', deps())
    expect(line).toMatchObject({ item: 'skills', state: 'done', text: '2 files' })
    expect(line.subs).toEqual(["loop: a link to Main account's whole folder, not carried"])
    expect(hashTree(source)).toBe(before)
    expect(existsSync(join(target, 'skills', 'loop'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('a relative link is carried as a link to the same folder from the account', async () => {
    write(join(dir, 'dotfiles', 'skills', 'x.md'), 'dotfile skill')
    symlinkSync('../../dotfiles/skills', join(source, 'skills', 'stow'))

    await carryItem('skills', deps())
    expect(readFileSync(join(target, 'skills', 'stow', 'x.md'), 'utf8')).toBe('dotfile skill')
    // the link names the folder by its real path (/private/var on macOS for /var)
    expect(readlinkSync(join(target, 'skills', 'stow'))).toBe(realpathSync(join(dir, 'dotfiles', 'skills')))
  })

  it.skipIf(process.platform === 'win32')('a replaced file keeps its permissions', async () => {
    writeJson(join(target, '.claude.json'), { oauthAccount: { emailAddress: 'work@example.com' } })
    chmodSync(join(target, '.claude.json'), 0o600)

    await carryItem('mcp', deps())
    await carryItem('trust', deps())
    expect(statSync(join(target, '.claude.json')).mode & 0o777).toBe(0o600)
  })

  it('a source settings.json that cannot be read fails settings, hooks and plugins and writes nothing', async () => {
    writeJson(join(target, 'settings.json'), { theme: 'light', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'keep me' }] }] } })
    const before = readFileSync(join(target, 'settings.json'), 'utf8')
    write(join(source, 'settings.json'), '{ broken')

    expect(await carryItem('settings', deps())).toEqual({
      item: 'settings',
      state: 'failed',
      text: 'settings.json of Main account cannot be read',
      subs: []
    })
    expect(await carryItem('hooks', deps())).toEqual({
      item: 'hooks',
      state: 'failed',
      text: 'settings.json of Main account cannot be read',
      subs: []
    })
    expect(await carryItem('plugins', deps())).toEqual({
      item: 'plugins',
      state: 'failed',
      text: 'settings.json of Main account cannot be read',
      subs: []
    })
    expect(readFileSync(join(target, 'settings.json'), 'utf8')).toBe(before)
    expect(runs(() => readLog(log)).filter((run) => run.argv[0] === 'plugin')).toEqual([])
  })

  it('a secret cut by the 500-character limit is still masked, and a secret with a quote is masked in its escaped form', async () => {
    const quoted = 'q"uote-secret-99'
    const long = 'sk-header-secret-012'
    writeJson(join(source, '.claude.json'), {
      mcpServers: { api: { type: 'http', url: 'https://api.example.com/mcp', headers: { 'X-Key': quoted, 'X-Long': long } } }
    })
    // the secret starts at character 481, so the 500-character cut would show its first 19 characters
    writeScript({ turns: {}, marketplaces: MARKETPLACE, cliFail: { 'mcp add-json': `${'x'.repeat(480)} ${long} ${JSON.stringify(quoted)}` } })

    const line = await carryItem('mcp', deps())
    expect(line.state).toBe('failed')
    expect(line.text).toContain(MASK)
    expect(line.text).not.toContain('sk-header')
    expect(line.text).not.toContain('secret-0')
    expect(line.text).not.toContain('uote-secret')
  })

  it('a command that cannot run fails its item with its message', async () => {
    const failing: CarryDeps = { ...deps(), cli: () => Promise.reject(new CliError('timeout', 'Claude Code did not answer in 60 s')) }
    expect(await carryItem('mcp', failing)).toEqual({ item: 'mcp', state: 'failed', text: 'Claude Code did not answer in 60 s', subs: [] })
  })
})

describe('reading the source and copying trees', () => {
  it('readSource reads the configs and counts the folder items, and a file over the limit is not read', async () => {
    const read = await readSource({ configDir: source, claudeJson: join(source, '.claude.json') } satisfies SourceFolder)
    expect(read.settings).toMatchObject({ model: 'claude-haiku-5-5', theme: 'dark' })
    expect(read.claudeJson).toMatchObject({ oauthAccount: { emailAddress: 'main@example.com' } })
    expect(Object.keys(read.installed as object)).toEqual(['version', 'plugins'])
    expect(read.files).toEqual({ skills: 2, agents: 1, commands: 1, 'output-styles': 1, memory: 2, keybindings: 1 })

    writeFileSync(join(source, 'settings.json'), ' '.repeat(MAX_CONFIG_BYTES + 1))
    expect((await readSource({ configDir: source, claudeJson: join(source, '.claude.json') })).settings).toBeNull()
  })

  it('copyTree of a missing folder copies nothing and does not fail', async () => {
    expect(await copyTree(join(dir, 'nowhere'), join(target, 'skills'))).toBe(0)
  })
})
