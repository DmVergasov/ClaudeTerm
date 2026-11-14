# MCP app secrets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The carry-over can bring the client secrets of MCP servers that sign in through the person's own OAuth app, and the MCP panel can give a server its client secret when its sign-in fails for lack of one.

**Architecture:** Main reads the source account's `.credentials.json` (`mcpOAuthClientConfig`), counts the secrets of the carried servers for the picker, and adds each such server with `claude mcp add-json --client-secret` and the secret in `MCP_CLIENT_SECRET` instead of the plain add; one run of MCP servers settles both progress lines. The panel gets a `set-secret` row action (`mcp remove`, then `mcp add-json --client-secret` in the same scope with the same config) and a password field under the row.

**Tech Stack:** Electron 44, TypeScript (strict, `noUnusedLocals`), plain DOM renderer, Vitest, Playwright, the stand-in `claude` (`tests/fixtures/fake-claude`).

**Spec:** `docs/superpowers/specs/2026-11-14-mcp-app-secrets-design.md`

## Global Constraints

- UI copy, verbatim: picker item and progress line `MCP app secrets` (right after `MCP servers`); panel field label and placeholder `Client secret`, its buttons `Save` and `Cancel`; ··· menu item `Set client secret…` (the `…` character).
- Claude Code 2.1.323 keeps a client secret in `<config folder>/.credentials.json` → `mcpOAuthClientConfig["<server name>|<16 hex hash>"] = { clientSecret }` on Windows and Linux; on macOS it is in the Keychain, so the carry item does not show there (`process.platform === 'darwin'`).
- A secret reaches Claude Code only as `MCP_CLIENT_SECRET` in the environment, with `--client-secret` in the arguments. It never goes into an argument, the app log, the stand-in's log, a progress line, an error text, an IPC answer or the window; error texts show it as `MASK` (`'••••••••'`).
- `.credentials.json` is untrusted: read through the capped readers of `account-carry-run.ts` (`MAX_CONFIG_BYTES`), shape-checked, never throws; a secret counts only when `isClientSecret` (Task 1) takes it.
- TDD in every task. Tests never touch the real home folder or the real `claude`; files go under `tmpdir()`; e2e tests never take the machine's window focus.
- Commands: `npx vitest run <files>`, `npm run typecheck`; build `node .superpowers/shared-lock.cjs "npm run build"`; e2e `node .superpowers/shared-lock.cjs "node scripts/e2e.mjs --workers=2 <spec file>"` (it does not build: build first).
- Every file touched here is CRLF: keep it. English comments, logs and copy; match the surrounding naming and comment density.
- Implementers do not commit (the controller does) and edit only the files their task lists. Other agents may have uncommitted work in `src/main/index.ts`: change only the spots named, never revert anything else. A build or e2e blocked by someone else's lock or work is reported to the controller.

## Review Focus

- The panel repaints its list after every answer and every 2 s while a server connects: the typed secret and the field's focus must survive a repaint (Task 6 e2e).
- A Save whose `mcp remove` worked and whose `add-json --client-secret` was refused must not lose the server: it is added back without the secret and the message is masked (Task 5 unit).
- A secret with `"` or `\` comes back from Claude Code JSON-escaped: it must be masked in both forms (Task 5 unit).
- A sign-in store with an empty, malformed or ambiguous entry (one server name, two different secrets): nothing guessed, nothing thrown (Task 1 unit).
- A begin request with `mcp-secrets` but without `mcp` (stale ticks, or a forged request): no line and nothing carried (Task 4 unit).

---

### Task 1: The client secrets of a sign-in store

**Files:**
- Modify: `src/shared/mcp.ts` (append)
- Modify: `src/main/account-carry.ts` (new export after `serverSecrets`)
- Test: `tests/unit/mcp-shared.test.ts`, `tests/unit/account-carry.test.ts`

**Interfaces:**
- Produces: `export const MAX_CLIENT_SECRET = 4096` and `export function isClientSecret(v: unknown): v is string` in `src/shared/mcp.ts`: a string of 1 to 4096 characters with no control character (`/[\u0000-\u001f\u007f]/`).
- Produces: `export function clientSecrets(credentials: unknown, names: readonly string[]): Map<string, string>` in `src/main/account-carry.ts`: server name → its client secret, in `names` order.

- [ ] **Step 1: Write the failing tests**

`tests/unit/mcp-shared.test.ts` (import `isClientSecret` beside `marketplaceSource`):

```ts
describe('isClientSecret', () => {
  it('takes 1 to 4096 characters on one line and refuses the rest', () => {
    for (const v of ['s', 'cs-123 with a space', 'x'.repeat(4096)]) expect(isClientSecret(v)).toBe(true)
    for (const v of ['', 'x'.repeat(4097), 'a\nb', 'a\u0000b', 'a\u007f', 1, null, undefined]) expect(isClientSecret(v)).toBe(false)
  })
})
```

`tests/unit/account-carry.test.ts` (import `clientSecrets`):

```ts
describe('clientSecrets', () => {
  it("finds each named server's client secret by the name before | and leaves the others out", () => {
    const credentials = {
      claudeAiOauth: { accessToken: 'not-a-client-secret' },
      mcpOAuthClientConfig: {
        'notion|fedcba9876543210': { clientSecret: 'notion-secret-0001' },
        'asana|0123456789abcdef': { clientSecret: 'asana-secret-0001' },
        'other|0000000000000000': { clientSecret: 'not-carried' }
      }
    }
    expect([...clientSecrets(credentials, ['asana', 'github', 'notion'])]).toEqual([['asana', 'asana-secret-0001'], ['notion', 'notion-secret-0001']])
  })

  it('skips empty, malformed and ambiguous entries and never throws', () => {
    for (const value of [null, 'x', [], { mcpOAuthClientConfig: [] }, { mcpOAuthClientConfig: 'x' }]) expect(clientSecrets(value, ['a']).size).toBe(0)
    const entries = {
      'a|1': { clientSecret: '' }, 'b|1': { clientSecret: 42 }, 'c|1': 'secret', d: { clientSecret: 'no-bar' },
      'e|1': { clientSecret: 'line\nbreak' }, 'f|1': { clientSecret: 'x'.repeat(4097) },
      'g|1': { clientSecret: 'one' }, 'g|2': { clientSecret: 'two' },
      'h|1': { clientSecret: 'same' }, 'h|2': { clientSecret: 'same' },
      '|1': { clientSecret: 'nameless' }
    }
    expect([...clientSecrets({ mcpOAuthClientConfig: entries }, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', ''])]).toEqual([['h', 'same']])
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/mcp-shared.test.ts tests/unit/account-carry.test.ts`
Expected: FAIL — `isClientSecret` / `clientSecrets` are not exported.

- [ ] **Step 3: Implement `isClientSecret` and `clientSecrets`**

`clientSecrets` rules: `credentials` must be an object whose `mcpOAuthClientConfig` is an object (else an empty map); its own keys only (`Object.entries`). A key counts when its first `|` is at index ≥ 1; the name is the text before it. The entry must be an object whose `clientSecret` passes `isClientSecret`. A name is kept only when it is in `names`; the same secret twice counts once; a name with two different secrets is left out (which one the carried config uses cannot be told). Build the map by walking `names`, so its order is theirs.

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run tests/unit/mcp-shared.test.ts tests/unit/account-carry.test.ts` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Report** (no commit: the controller commits)

---

### Task 2: The MCP app secrets item, counted and carried with the MCP servers

**Files:**
- Modify: `src/shared/accounts.ts` (`CARRY_ITEMS`, `CARRY_LABELS`)
- Modify: `src/main/account-carry.ts` (`previewCounts`)
- Modify: `src/main/account-carry-run.ts` (`CarryDeps`, `readSource`, `carryMcp`, new `carryLines` and `failedLines`, `carryItem`)
- Modify: `src/main/index.ts` (only the `previewCounts(` call in the `IPC.accountsCarryPreview` handler)
- Modify: `src/renderer/account-view.ts` (`tickRows`, `noteOf`)
- Modify: `tests/fixtures/fake-claude/fake-claude.ts` (`mcp add-json --client-secret`)
- Test: `tests/unit/account-carry.test.ts`, `tests/unit/account-view.test.ts`, `tests/integration/account-carry.int.test.ts`

**Interfaces:**
- Consumes: `clientSecrets`, `isClientSecret` (Task 1).
- Produces: `CARRY_ITEMS = ['settings', 'hooks', 'mcp', 'mcp-secrets', 'plugins', 'skills', 'agents', 'commands', 'memory', 'trust', 'keybindings', 'output-styles']`; `CARRY_LABELS['mcp-secrets'] = 'MCP app secrets'`.
- Produces: `previewCounts(read: { settings: unknown; claudeJson: unknown; installed: unknown; known: unknown; credentials: unknown }, files: Record<FolderItem, number>, withSecrets: boolean): CarryCount[]` — `mcp-secrets` counts the carried servers (`userServers`) with a client secret, `names` the first three of them; with `withSecrets` false the item is left out of the list.
- Produces: `readSource(s)` also returns `credentials: unknown` (`<configDir>/.credentials.json`, null when missing or unreadable).
- Produces in `account-carry-run.ts`: `CarryDeps.cli(args: string[], env?: Record<string, string>): Promise<CliRun>` (env: variables added to the account's environment); `CarryDeps.secrets?: boolean` (MCP app secrets are ticked); `export async function carryLines(item: CarryItem, d: CarryDeps): Promise<CarryLine[]>`; `export function failedLines(item: CarryItem, secrets: boolean, text: string): CarryLine[]`.
- Produces in the stand-in: `credentialsFile()` (`<CLAUDE_CONFIG_DIR>/.credentials.json`) and `saveClientSecret(name, entry, secret)`; Task 6 reads the same file.
- Produces in `tests/unit/account-view.test.ts`: a module-level `withSecrets: CarryPreview` that Task 3 reuses.

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/account-carry.test.ts`, describe `previewCounts`: in the existing test add to `read` the field `credentials: { mcpOAuthClientConfig: { 'beta|0123456789abcdef': { clientSecret: 'beta-app-secret' }, 'zeta|0123456789abcdef': { clientSecret: 'zeta-app-secret' } } }`, call `previewCounts(read, files, true)`, insert `{ item: 'mcp-secrets', count: 1, names: ['beta'], marketplaces: 0 }` right after the `mcp` entry, and add `expect(JSON.stringify(previewCounts(read, files, true))).not.toContain('app-secret')`. Add:

```ts
it('previewCounts leaves MCP app secrets out where Claude Code keeps them in the Keychain', () => {
  const files: Record<FolderItem, number> = { skills: 0, agents: 0, commands: 0, 'output-styles': 0, memory: 0, keybindings: 0 }
  const read = { settings: null, claudeJson: null, installed: null, known: null, credentials: null }
  expect(previewCounts(read, files, false).map((c) => c.item)).toEqual(['settings', 'hooks', 'mcp', 'plugins', 'skills', 'agents', 'commands', 'memory', 'trust', 'keybindings', 'output-styles'])
})
```

In the malformed test, call `previewCounts({ settings: null, claudeJson: 'x', installed: null, known: null, credentials: 'x' }, files, true)` and expect twelve zeros.

`tests/unit/account-view.test.ts`: below `preview`, add

```ts
const withSecrets: CarryPreview = { ...preview, items: [...preview.items, { item: 'mcp-secrets', count: 1, names: ['alpha'], marketplaces: 0 }] }
```

and in describe `tickRows`:

```ts
it('MCP app secrets come right after MCP servers, with the servers that have one, ticked by default; a preview without them has no such row', () => {
  const rows = tickRows(withSecrets, { adopt: false, mode: 'add', targetName: 'Studio' })
  expect(rows.map((r) => r.item).slice(2, 5)).toEqual(['mcp', 'mcp-secrets', 'plugins'])
  expect(rows[3]).toEqual({ item: 'mcp-secrets', label: 'MCP app secrets', note: 'alpha · client secrets of their own OAuth apps', count: '1', ticked: true, disabled: false })
  expect(tickRows(preview, { adopt: false, mode: 'add', targetName: 'Studio' }).some((r) => r.item === 'mcp-secrets')).toBe(false)
})
```

- [ ] **Step 2: Write the failing integration tests** in `tests/integration/account-carry.int.test.ts`

Import `carryLines`. Change `deps()`'s `cli` to `(args, extra) => runClaudeCli(launch, args, { cwd: work, env: { ...env, ...extra } })`. In the `readSource` test add `expect(read.credentials).toMatchObject({ claudeAiOauth: { accessToken: MAIN_CREDENTIAL } })`. Add near the top:

```ts
const APP_SECRET = 'app-client-secret-0001'

/** the source's sign-in store with a client secret for the server api, as Claude Code 2.1.323 keeps it */
function seedAppSecret(): void {
  writeJson(join(source, '.credentials.json'), { claudeAiOauth: { accessToken: MAIN_CREDENTIAL }, mcpOAuthClientConfig: { 'api|0123456789abcdef': { clientSecret: APP_SECRET } } })
}

/** the CLI calls the stand-in logged: the arguments, and whether MCP_CLIENT_SECRET was set */
function cliCalls(): { cli: unknown; secretEnv: unknown }[] {
  return readLog(log).filter((e) => Array.isArray(e.cli)).map((e) => ({ cli: e.cli, secretEnv: e.secretEnv }))
}
```

Then, in describe `carry-over`:

```ts
it('with MCP app secrets a server with a client secret is added with --client-secret and the secret in MCP_CLIENT_SECRET; the stand-in logs only that one came', async () => {
  seedAppSecret()
  const servers = readJson(join(source, '.claude.json')).mcpServers as Record<string, unknown>
  const lines = await carryLines('mcp', { ...deps(), secrets: true })
  expect(lines).toEqual([
    { item: 'mcp', state: 'done', text: '2 added', subs: [] },
    { item: 'mcp-secrets', state: 'done', text: '1 added', subs: [] }
  ])
  expect(cliCalls()).toEqual([
    { cli: ['mcp', 'remove', '--scope', 'user', '--', 'api'], secretEnv: false },
    { cli: ['mcp', 'add-json', '--scope', 'user', '--client-secret', '--', 'api', JSON.stringify(servers.api)], secretEnv: true },
    { cli: ['mcp', 'remove', '--scope', 'user', '--', 'docs'], secretEnv: false },
    { cli: ['mcp', 'add-json', '--scope', 'user', '--', 'docs', JSON.stringify(servers.docs)], secretEnv: false }
  ])
  expect(readFileSync(log, 'utf8')).not.toContain(APP_SECRET)
  expect(warnings.join('\n')).not.toContain(APP_SECRET)
  // the account's Claude Code keeps the same secret for api
  const store = readJson(join(target, '.credentials.json')).mcpOAuthClientConfig as Record<string, unknown>
  expect(Object.entries(store).filter(([key]) => key.startsWith('api|')).map(([, entry]) => entry)).toEqual([{ clientSecret: APP_SECRET }])
})

it('without MCP app secrets every server is added without a secret', async () => {
  seedAppSecret()
  expect((await carryLines('mcp', deps())).map((l) => l.item)).toEqual(['mcp'])
  const adds = cliCalls().filter((c) => (c.cli as string[])[1] === 'add-json')
  expect(adds.map((c) => c.secretEnv)).toEqual([false, false])
  expect(adds.some((c) => (c.cli as string[]).includes('--client-secret'))).toBe(false)
  expect(existsSync(join(target, '.credentials.json'))).toBe(false)
})

it('a refused secret fails both lines with the secret masked and logs only the name and the code', async () => {
  seedAppSecret()
  writeScript({ turns: {}, marketplaces: MARKETPLACE, cliFail: { 'mcp add-json --scope user --client-secret': `invalid_client: ${APP_SECRET} was refused` } })
  expect(await carryLines('mcp', { ...deps(), secrets: true })).toEqual([
    { item: 'mcp', state: 'failed', text: `1 of 2 · api: invalid_client: ${MASK} was refused`, subs: [] },
    { item: 'mcp-secrets', state: 'failed', text: `0 of 1 · api: invalid_client: ${MASK} was refused`, subs: [] }
  ])
  expect(warnings).toEqual(['claude mcp add-json failed for api (1)'])
})

it('a sign-in store that cannot be read fails MCP app secrets and still adds the servers', async () => {
  write(join(source, '.credentials.json'), '{ not json')
  expect(await carryLines('mcp', { ...deps(), secrets: true })).toEqual([
    { item: 'mcp', state: 'done', text: '2 added', subs: [] },
    { item: 'mcp-secrets', state: 'failed', text: '.credentials.json of Main account cannot be read', subs: [] }
  ])
})

it('carryItem of MCP app secrets adds the servers with their secrets and answers the secrets line; a command that cannot run fails both lines', async () => {
  seedAppSecret()
  expect(await carryItem('mcp-secrets', deps())).toEqual({ item: 'mcp-secrets', state: 'done', text: '1 added', subs: [] })
  const failing: CarryDeps = { ...deps(), secrets: true, cli: () => Promise.reject(new CliError('timeout', 'Claude Code did not answer in 60 s')) }
  expect((await carryLines('mcp', failing)).map(({ item, state, text }) => ({ item, state, text }))).toEqual([
    { item: 'mcp', state: 'failed', text: 'Claude Code did not answer in 60 s' },
    { item: 'mcp-secrets', state: 'failed', text: 'Claude Code did not answer in 60 s' }
  ])
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/unit/account-carry.test.ts tests/unit/account-view.test.ts tests/integration/account-carry.int.test.ts`
Expected: FAIL (type errors on the new item, `carryLines` missing).

- [ ] **Step 4: The item and its count**

In `src/shared/accounts.ts`, add `'mcp-secrets'` to `CARRY_ITEMS` right after `'mcp'` and `'mcp-secrets': 'MCP app secrets'` to `CARRY_LABELS` after `mcp`. In `previewCounts` (`src/main/account-carry.ts`) take the signature above, count with `clientSecrets(read.credentials, servers.map((s) => s.name))`, and return `CARRY_ITEMS.filter((item) => withSecrets || item !== 'mcp-secrets').map(...)`. Update its doc comment. In `src/main/index.ts` the preview handler passes `previewCounts(read, read.files, process.platform !== 'darwin')`.

- [ ] **Step 5: The carry run** in `src/main/account-carry-run.ts`

`readSource` adds `credentials: await readJsonOf(join(s.configDir, '.credentials.json'))`. `carryMcp` becomes `async function carryMcp(d: CarryDeps): Promise<{ servers: CarryLine; secrets: CarryLine }>`:

1. `servers = userServers((await readConfigs(d.source)).claudeJson)` as today.
2. Only when `d.secrets`: `parseJsonFile(join(d.source.configDir, '.credentials.json'))` — missing: no secrets; unreadable: no secrets and the secrets line will be failed `.credentials.json of ${d.sourceName} cannot be read`; ok: `clientSecrets(value, servers.map((s) => s.name))`. Without `d.secrets` the file is not read.
3. Per server: the `remove` as today (no env). A server with a secret is added with `['mcp', 'add-json', '--scope', 'user', '--client-secret', '--', name, JSON.stringify(config)]` and `d.cli(args, { MCP_CLIENT_SECRET: secret })`; the others as today with `d.cli(args)`. A failure warns as today (`claude mcp add-json failed for <name> (<code>)`) and its message is `cliMessage(maskedRun(run, [...serverSecrets(config), secret]))` (the secret only when there is one). The first failure of a server with a secret is also the secrets line's failure.
4. `servers`: the line of today. `secrets`: failed with the store's text when unreadable; else failed `${withSecret} of ${secretCount} · ${name}: ${message}` on a failure; else done `${withSecret} added`.

`carryItem`: `case 'mcp'` answers `(await carryMcp(d)).servers`; new `case 'mcp-secrets'` answers `(await carryMcp({ ...d, secrets: true })).secrets`. `failedLines(item, secrets, text)`: for `mcp` with `secrets`, or for `mcp-secrets`, both lines failed with `text`; otherwise the item's line. `carryLines(item, d)`: for `mcp` or `mcp-secrets`, `withSecrets = item === 'mcp-secrets' || d.secrets === true`, runs `carryMcp({ ...d, secrets: withSecrets })` and answers `[servers, secrets]` or `[servers]`; a throw answers `failedLines('mcp', withSecrets, message)`. Any other item answers `[await carryItem(item, d)]`. Doc comments say MCP app secrets are added with their servers.

- [ ] **Step 6: The stand-in's `--client-secret`** in `tests/fixtures/fake-claude/fake-claude.ts`

Add `const credentialsFile = (): string => join(configDir, '.credentials.json')` beside `authFile`. In `mcpCommand`'s `add-json`: when `call.flags.has('--client-secret')` and `process.env.MCP_CLIENT_SECRET` is empty or unset, answer `bad('--client-secret needs the secret in MCP_CLIENT_SECRET')`; after a successful `addServer`, `saveClientSecret(name, entry, secret)` writes, through `editJson(credentialsFile(), …)`, `mcpOAuthClientConfig[`${name}|${createHash('sha256').update(JSON.stringify(entry)).digest('hex').slice(0, 16)}`] = { clientSecret: secret }`, keeping the file's other keys. A comment says this is where Claude Code 2.1.323 keeps it. The secret is never logged (the existing `secretEnv` flag stays the only trace).

- [ ] **Step 7: The picker row** in `src/renderer/account-view.ts`

`tickRows` maps `CARRY_ITEMS.filter((item) => item !== 'mcp-secrets' || p.items.some((c) => c.item === 'mcp-secrets'))`. `noteOf` gets `case 'mcp-secrets'`: `${namesNote(c)} · client secrets of their own OAuth apps`, where `namesNote(c: CarryCount | undefined): string` is the names-and-`+rest` part the `mcp` case builds today (the `mcp` case uses it too). Update `tickRows`'s doc comment.

- [ ] **Step 8: Run the tests and the type check**

Run: `npx vitest run tests/unit/account-carry.test.ts tests/unit/account-view.test.ts tests/integration/account-carry.int.test.ts tests/unit/ipc-guards.test.ts` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 9: Report** (no commit: the controller commits)

---

### Task 3: MCP app secrets are off while MCP servers is off

**Files:**
- Modify: `src/renderer/account-view.ts` (`tickRows` option)
- Modify: `src/renderer/account-helper.ts` (`tickBox`, `paintTicks`, `selectAll`)
- Test: `tests/unit/account-view.test.ts`, `tests/e2e/account-add.spec.ts`

**Interfaces:**
- Consumes: the `mcp-secrets` row and `withSecrets` (Task 2).
- Produces: `tickRows(p: CarryPreview, o: { adopt: boolean; mode: FlowMode; targetName: string; mcpTicked?: boolean }): TickRow[]`.
- Produces in `tests/e2e/account-add.spec.ts` (Task 4 reuses them): `APP_SECRET = 'app-secret-never-shown-0001'`, `appSecretSetup(config: string): void`, `tick(win: Page, label: string)`.

- [ ] **Step 1: Write the failing unit test** in describe `tickRows`

```ts
it('MCP app secrets are off while MCP servers is unticked, and follow its default tick otherwise', () => {
  const o = { adopt: false, mode: 'add' as const, targetName: 'Studio' }
  const secretsRow = (p: CarryPreview, over: { adopt?: boolean; mcpTicked?: boolean }) => tickRows(p, { ...o, ...over }).find((r) => r.item === 'mcp-secrets')
  expect(secretsRow(withSecrets, { mcpTicked: false })).toEqual({ item: 'mcp-secrets', label: 'MCP app secrets', note: 'Comes with the servers above', count: '1', ticked: false, disabled: true })
  expect(secretsRow(withSecrets, { mcpTicked: true })).toMatchObject({ ticked: true, disabled: false })
  expect(secretsRow(withSecrets, { adopt: true, mcpTicked: true })).toMatchObject({ ticked: false, disabled: false })
  // without mcpTicked the servers' own default decides: ticked unless the folder is adopted
  expect(secretsRow(withSecrets, {})).toMatchObject({ ticked: true, disabled: false })
  expect(secretsRow(withSecrets, { adopt: true })).toMatchObject({ ticked: false, disabled: true })
  const none: CarryPreview = { ...withSecrets, items: withSecrets.items.map((c) => (c.item === 'mcp-secrets' ? { ...c, count: 0, names: [] } : c)) }
  expect(secretsRow(none, { mcpTicked: false })?.note).toBe('None in Main account')
})
```

- [ ] **Step 2: Write the failing e2e tests** in `tests/e2e/account-add.spec.ts`

```ts
const APP_SECRET = 'app-secret-never-shown-0001'

/** Main account's setup with a client secret for context7 in its sign-in store, as Claude Code keeps one on Windows and Linux */
function appSecretSetup(config: string): void {
  mainSetup(config)
  const store = JSON.parse(readFileSync(join(config, '.credentials.json'), 'utf8')) as Record<string, unknown>
  store.mcpOAuthClientConfig = { 'context7|0123456789abcdef': { clientSecret: APP_SECRET } }
  writeFileSync(join(config, '.credentials.json'), JSON.stringify(store))
}

/** a tick of the helper, by its exact label */
const tick = (win: Page, label: string) => helper(win).locator('.account-tick', { has: win.locator('b', { hasText: new RegExp(`^${label}$`) }) })

test('the picker lists MCP app secrets right after MCP servers with their count, and turns them off with MCP servers', async () => {
  test.skip(process.platform === 'darwin', 'Claude Code keeps the client secrets in the Keychain on macOS')
  const { app, page } = await launchAccounts({ script: { turns: {} }, main: appSecretSetup })
  const win = await accountsWindow(app, page)
  await fillAdd(win, 'Work', null)
  const secrets = tick(win, 'MCP app secrets')
  await expect(secrets).toContainText('context7', LONG)
  await expect(secrets.locator('.helper-count')).toHaveText('1')
  const labels = await helper(win).locator('.account-tick b').allTextContents()
  expect(labels.indexOf('MCP app secrets')).toBe(labels.indexOf('MCP servers') + 1)
  await expect(secrets.locator('input')).toBeChecked()
  const servers = tick(win, 'MCP servers').locator('input')
  await servers.uncheck()
  await expect(secrets.locator('input')).toBeDisabled()
  await expect(secrets.locator('input')).not.toBeChecked()
  await expect(servers).toBeFocused()
  await servers.check()
  await expect(secrets.locator('input')).toBeEnabled()
  await expect(secrets.locator('input')).toBeChecked()
  expect(await win.content()).not.toContain(APP_SECRET)
  await app.close()
})

test('on macOS the picker has no MCP app secrets', async () => {
  test.skip(process.platform !== 'darwin', 'the client secrets are read from .credentials.json on Windows and Linux')
  const { app, page } = await launchAccounts({ script: { turns: {} }, main: appSecretSetup })
  const win = await accountsWindow(app, page)
  await fillAdd(win, 'Work', null)
  await expect(tick(win, 'MCP servers')).toContainText('context7', LONG)
  await expect(tick(win, 'MCP app secrets')).toHaveCount(0)
  await app.close()
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/unit/account-view.test.ts`, then `node .superpowers/shared-lock.cjs "npm run build"` and `node .superpowers/shared-lock.cjs "node scripts/e2e.mjs --workers=2 account-add.spec.ts"`
Expected: the new unit test FAILS; on Windows and Linux the first new e2e test FAILS at `toBeDisabled`, the others PASS.

- [ ] **Step 4: Implement**

`tickRows`, for `mcp-secrets` only: `mcpOn = o.mcpTicked ?? (!o.adopt && <the mcp count> > 0)`; a count of 0 keeps `None in <source>`; else with `!mcpOn` the row is `disabled: true`, `ticked: false`, note `Comes with the servers above`; else as any other row. In `account-helper.ts`: `paintTicks` and `selectAll(f, on)` pass `mcpTicked` (`f.ticks.has('mcp')`, and `on`); the change of the MCP servers box sets `mcp-secrets` in `f.ticks` to that row's `ticked` from `tickRows(f.preview, { ...tickOptions(f), mcpTicked: input.checked })`, calls `paintTicks(f)`, and gives the focus back to the new MCP servers checkbox (`tickBox` sets `data-item` on its label so it can be found). `loadPreview` keeps `tickOptions(f)` without `mcpTicked`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/unit/account-view.test.ts`, `npm run typecheck`, build, then the e2e command of Step 3
Expected: all PASS (on macOS the first new e2e test is skipped).

- [ ] **Step 6: Report** (no commit: the controller commits)

---

### Task 4: The carry-over runs MCP app secrets with MCP servers

**Files:**
- Modify: `src/main/account-flow.ts` (`AccountFlowDeps.carry`, `complete`, `runLine`, the `retry-item` case)
- Modify: `src/main/index.ts` (the `carry-run` import, `accountCli`, the `carry:` dep of `new AccountFlow({`)
- Test: `tests/unit/account-flow.test.ts`, `tests/e2e/account-add.spec.ts`

**Interfaces:**
- Consumes: `carryLines`, `failedLines`, `CarryDeps.cli(args, env)`, `CarryDeps.secrets` (Task 2); `APP_SECRET`, `appSecretSetup`, `tick` (Task 3).
- Produces: `AccountFlowDeps.carry(item: CarryItem, target: FlowTarget, source: string | null, items: readonly CarryItem[]): Promise<CarryLine[]>` — `items`: the carry items that have a line in this flow; the answer: the lines the run settles.
- Produces: `accountCli(folder: string, args: string[], timeoutMs = CLI_TIMEOUT_MS, extraEnv: Record<string, string> = {}): Promise<CliRun>` in `index.ts` (env `{ ...accountEnv(folder), ...extraEnv }`).

- [ ] **Step 1: Write the failing unit tests** in `tests/unit/account-flow.test.ts`

Add `ticked: [] as CarryItem[][]` to `w`. The fake `carry` becomes `async (item, target, source, items)`: it pushes the same call string as today, pushes `[...items]` to `w.ticked`, keeps the gate and the failure, and answers `[{ item, state: 'done', text: `${item} copied`, subs: [] }]` plus `{ item: 'mcp-secrets', state: 'done', text: 'mcp-secrets copied', subs: [] }` when `item === 'mcp' && items.includes('mcp-secrets')` (type the array `CarryLine[]`, imported from `src/shared/accounts`). Then:

```ts
it('MCP app secrets come with MCP servers: one run settles both lines and is told the ticked items', async () => {
  const t = setup({ entries: [login()] })
  t.dirs.add(OLD)
  await t.flow.begin(carryReq(['mcp', 'mcp-secrets']))
  await settle()
  expect(t.calls.filter((c) => /^(carry|register)/.test(c))).toEqual(['carry mcp Old main', 'register'])
  expect(t.w.ticked).toEqual([['mcp', 'mcp-secrets']])
  expect(t.flow.view()?.lines).toEqual([
    { item: 'mcp', state: 'done', text: 'mcp copied', subs: [] },
    { item: 'mcp-secrets', state: 'done', text: 'mcp-secrets copied', subs: [] },
    { item: 'claudeterm', state: 'done', text: "ClaudeTerm's tools added", subs: [] }
  ])
})

it('MCP app secrets without MCP servers have no line and carry nothing', async () => {
  const t = setup({ entries: [login()] })
  t.dirs.add(OLD)
  await t.flow.begin(carryReq(['mcp-secrets', 'plugins']))
  await settle()
  expect(t.flow.view()?.lines.map((l) => l.item)).toEqual(['plugins', 'claudeterm'])
  expect(t.calls.filter((c) => /^(carry|register)/.test(c))).toEqual(['carry plugins Old main', 'register'])
})

it('a failed MCP servers run fails both lines; Try again on MCP app secrets runs MCP servers again once and settles both', async () => {
  const t = setup({ entries: [login()] })
  t.dirs.add(OLD)
  t.w.failCarry.set('mcp', 'boom')
  await t.flow.begin(carryReq(['mcp', 'mcp-secrets']))
  await settle()
  expect(t.flow.view()?.lines.slice(0, 2)).toEqual([
    { item: 'mcp', state: 'failed', text: 'boom', subs: [] },
    { item: 'mcp-secrets', state: 'failed', text: 'boom', subs: [] }
  ])
  t.w.failCarry.delete('mcp')
  const held = gate()
  t.w.gates.set('mcp', held.wait)
  const retry = t.flow.action({ kind: 'retry-item', item: 'mcp-secrets' })
  expect(t.flow.view()?.lines.slice(0, 2).map((l) => l.state)).toEqual(['running', 'running'])
  await t.flow.action({ kind: 'retry-item', item: 'mcp' })
  held.open()
  await retry
  expect(t.flow.view()?.lines.slice(0, 2).map((l) => l.state)).toEqual(['done', 'done'])
  expect(t.calls.filter((c) => c === 'carry mcp Old main')).toHaveLength(2)
})
```

- [ ] **Step 2: Write the failing e2e test** in `tests/e2e/account-add.spec.ts`

```ts
test('Carry over… with MCP app secrets adds the server with its client secret; the stand-in logs that one came, and no window shows it', async () => {
  test.skip(process.platform === 'darwin', 'Claude Code keeps the client secrets in the Keychain on macOS')
  const { app, page, root, config, log } = await launchAccounts({ accounts: workEntry, main: appSecretSetup, script: { turns: {} } })
  const folder = join(root, 'accounts', 'work')
  const context7 = (JSON.parse(readFileSync(join(config, '.claude.json'), 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers.context7
  const win = await accountsWindow(app, page)
  await row(win, 'Work').getByRole('button', { name: 'Carry over…' }).click()
  const dialog = helper(win)
  await expect(tick(win, 'MCP app secrets').locator('input')).toBeChecked(LONG)
  await dialog.getByRole('button', { name: 'Carry over', exact: true }).click()
  const line = dialog.locator('.helper-line', { hasText: 'MCP app secrets' })
  await expect(line).toHaveAttribute('data-state', 'done', LONG)
  await expect(line).toContainText('1 added')
  await expect(dialog.locator('.helper-line[data-state="running"]')).toHaveCount(0, LONG)

  const adds = log().filter((e) => Array.isArray(e.cli) && (e.cli as string[])[1] === 'add-json' && (e.cli as string[]).includes('context7'))
  expect(adds.map((e) => ({ cli: e.cli, secretEnv: e.secretEnv }))).toEqual([
    { cli: ['mcp', 'add-json', '--scope', 'user', '--client-secret', '--', 'context7', JSON.stringify(context7)], secretEnv: true }
  ])
  expect(JSON.stringify(log())).not.toContain(APP_SECRET)
  for (const html of [await win.content(), await page.content()]) expect(html).not.toContain(APP_SECRET)
  const store = JSON.parse(readFileSync(join(folder, '.credentials.json'), 'utf8')) as { mcpOAuthClientConfig: Record<string, unknown> }
  expect(Object.entries(store.mcpOAuthClientConfig).filter(([key]) => key.startsWith('context7|')).map(([, entry]) => entry)).toEqual([{ clientSecret: APP_SECRET }])
  await app.close()
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/unit/account-flow.test.ts`, build, then `node .superpowers/shared-lock.cjs "node scripts/e2e.mjs --workers=2 account-add.spec.ts"`
Expected: the new unit tests FAIL; the new e2e test FAILS (no `MCP app secrets` line: the flow does not run it).

- [ ] **Step 4: Implement the flow** in `src/main/account-flow.ts`

- `AccountFlowDeps.carry` takes the signature above (doc: MCP servers with MCP app secrets in `items` settles that line too).
- `complete()`: `ticked = CARRY_ITEMS.filter((item) => f.items.includes(item) && (item !== 'mcp-secrets' || f.items.includes('mcp')))`.
- `RUN_ORDER` stays; its comment says MCP app secrets run with MCP servers. A private helper `together(f: Flow, item: CarryLineItem): CarryLineItem[]` answers the lines of this flow among `['mcp', 'mcp-secrets']` for either of them, else `[item]`.
- `runLine(f, item)`: the run is `'mcp'` for `'mcp-secrets'`, else `item`; it calls `this.d.carry(run, target, f.source, <the carry items of f.view.lines>)` (`register` stays as is, as a one-line array); a throw fails every line of `together(f, item)` with the message; each answered line whose item has a line in the view replaces it.
- `retry-item`: the asked line must be failed or skipped and no line of `together(f, a.item)` running; every line of `together(f, a.item)` is set running (text `CARRY_LABELS[i]`), shown, then `this.runLine(f, a.item)`.

- [ ] **Step 5: Wire main** in `src/main/index.ts`

Import `carryLines, failedLines` instead of `carryItem` from `./account-carry-run`. Give `accountCli` the `extraEnv` parameter above. The `carry:` dep becomes `async (item, target, source, items)`: no source answers `failedLines(item, items.includes('mcp-secrets'), 'The account to carry from is not available')`; otherwise `inOrder(target.folder, () => carryLines(item, { source: from, sourceName: accountLabel(source), target, secrets: items.includes('mcp-secrets'), cli: (args, env) => accountCli(target.folder, args, CLI_TIMEOUT_MS, env), log: { warn: (m) => log.warn(m) } }))`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/unit/account-flow.test.ts tests/integration/account-carry.int.test.ts`, `npm run typecheck`, build, then `node .superpowers/shared-lock.cjs "node scripts/e2e.mjs --workers=2 account-add.spec.ts accounts-flow.spec.ts"`
Expected: all PASS (on macOS the new e2e test is skipped).

- [ ] **Step 7: Report** (no commit: the controller commits)

---

### Task 5: Set a server's client secret, in main

**Files:**
- Modify: `src/shared/mcp.ts` (`McpServerView.oauthApp`, `McpAction` kind `set-secret`)
- Modify: `src/main/ipc-guards.ts` (`isMcpAction`, `isMcpAddRequest`)
- Modify: `src/main/mcp/mcp-hub.ts` (`servers`, `liveView`, `configuredView`, `action`, new `setSecret`)
- Test: `tests/unit/mcp-hub.test.ts`, `tests/unit/ipc-guards.test.ts`; the `McpServerView` literals of `tests/unit/mcp-view-model.test.ts` (`server()`) and `tests/unit/status-bar.test.ts` (`server` in `mcpSegment`) get `oauthApp: false`

**Interfaces:**
- Consumes: `isClientSecret` (Task 1).
- Produces: `McpServerView.oauthApp: boolean` — the server's config signs in through the person's own OAuth app (`oauth.clientId` is a non-empty string).
- Produces: `McpAction` member `{ kind: 'set-secret'; name: string; scope: McpEditScope; secret: string }`; its answer is `McpResult`.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/mcp-hub.test.ts`, add `oauthApp: false` to every server of the two `servers()` `toEqual` expectations, and:

```ts
const ASANA = { type: 'http', url: 'https://mcp.asana.test/mcp', oauth: { clientId: 'asana-client-0001' } }
const APP_SECRET = 'app-secret-0001'

it('a server whose config has oauth.clientId is an OAuth app in the view, live or configured', async () => {
  const files = { userConfig: { mcpServers: { asana: ASANA, github: { type: 'http', url: 'https://api.example.com/mcp' } } } }
  const running = setup({ live: [live({ name: 'asana', status: 'needs-auth', transport: 'http' }), live({ name: 'github' })], files })
  expect((await running.hub.servers(TAB))?.servers.map((s) => [s.name, s.oauthApp])).toEqual([['asana', true], ['github', false]])
  const idle = setup({ files })
  expect((await idle.hub.servers(TAB))?.servers.map((s) => [s.name, s.oauthApp])).toEqual([['asana', true], ['github', false]])
})

it('set-secret adds the server again in its scope with the same config, the secret in MCP_CLIENT_SECRET with --client-secret; the restart waits meanwhile', async () => {
  const { hub, runs, order } = setup({ files: { userConfig: { mcpServers: { asana: ASANA } } } })
  expect(await hub.action(TAB, { kind: 'set-secret', name: 'asana', scope: 'user', secret: APP_SECRET })).toEqual({ ok: true })
  expect(runs.map((r) => r.args)).toEqual([
    ['mcp', 'remove', '--scope', 'user', '--', 'asana'],
    ['mcp', 'add-json', '--scope', 'user', '--client-secret', '--', 'asana', JSON.stringify(ASANA)]
  ])
  expect(runs[0].o.env).toEqual(ENV)
  expect(runs[1].o.env).toEqual({ ...ENV, MCP_CLIENT_SECRET: APP_SECRET })
  expect(JSON.stringify(runs.map((r) => r.args))).not.toContain(APP_SECRET)
  expect(order).toEqual([`hold:${TAB}`, `changed:${TAB}:true`, `release:${TAB}`])
})

it('a refused secret puts the server back without it; the message masks the secret, plain and JSON-escaped; nothing logged with it', async () => {
  const secret = 'se"cr\\et-0001'
  const reply: Reply = async (args) => (args.includes('--client-secret') ? { code: 1, stdout: '', stderr: `invalid_client: ${secret} / ${JSON.stringify(secret)}` } : { code: 0, stdout: '', stderr: '' })
  const { hub, runs, warns } = setup({ reply, files: { userConfig: { mcpServers: { asana: ASANA } } } })
  expect(await hub.action(TAB, { kind: 'set-secret', name: 'asana', scope: 'user', secret })).toEqual({ ok: false, error: `Could not save the client secret: invalid_client: ${MASK} / "${MASK}"` })
  expect(runs.map((r) => r.args)).toEqual([
    ['mcp', 'remove', '--scope', 'user', '--', 'asana'],
    ['mcp', 'add-json', '--scope', 'user', '--client-secret', '--', 'asana', JSON.stringify(ASANA)],
    ['mcp', 'add-json', '--scope', 'user', '--', 'asana', JSON.stringify(ASANA)]
  ])
  expect(runs[2].o.env).toEqual(ENV)
  expect(warns).toEqual(['claude mcp add-json failed (1)'])
})

it('when the server cannot be put back either, the message says so', async () => {
  const reply: Reply = async (args) => (args[1] === 'add-json' ? { code: 1, stdout: '', stderr: 'disk full' } : { code: 0, stdout: '', stderr: '' })
  const { hub } = setup({ reply, files: { userConfig: { mcpServers: { asana: ASANA } } } })
  expect(await hub.action(TAB, { kind: 'set-secret', name: 'asana', scope: 'user', secret: APP_SECRET })).toEqual({ ok: false, error: 'Could not save the client secret: disk full — asana could not be added back: disk full' })
})

it('set-secret of a server its scope does not have runs nothing', async () => {
  const { hub, runs } = setup({ files: { userConfig: { mcpServers: { asana: ASANA } } } })
  expect(await hub.action(TAB, { kind: 'set-secret', name: 'asana', scope: 'project', secret: APP_SECRET })).toEqual({ ok: false, error: 'No such server in this scope' })
  expect(runs).toEqual([])
})
```

In `tests/unit/ipc-guards.test.ts`, describe `MCP guards`:

```ts
it('isMcpAction takes set-secret with a name, an edit scope and a one-line secret of at most 4096 characters', () => {
  const ok = { kind: 'set-secret', name: 'asana', scope: 'user', secret: 'cs-123' }
  expect(isMcpAction(ok)).toBe(true)
  expect(isMcpAction({ ...ok, secret: 'x'.repeat(4096) })).toBe(true)
  const refused: unknown[] = [
    { ...ok, secret: '' }, { ...ok, secret: 'a\nb' }, { ...ok, secret: 'x'.repeat(4097) }, { ...ok, secret: 1 },
    { ...ok, scope: 'plugin' }, { ...ok, name: '-x' }, { kind: 'set-secret', name: 'asana', scope: 'user' }
  ]
  for (const v of refused) expect(isMcpAction(v)).toBe(false)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/mcp-hub.test.ts tests/unit/ipc-guards.test.ts`
Expected: FAIL (type errors on `oauthApp` and `set-secret`).

- [ ] **Step 3: Implement**

- `src/shared/mcp.ts`: the two type changes above, with a comment on `oauthApp`.
- `ipc-guards.ts`: `case 'set-secret': return isMcpName(a.name) && isMcpEditScope(a.scope) && isClientSecret(a.secret)`; `isMcpAddRequest` uses `isClientSecret(r.clientSecret)` in place of `oneLine(r.clientSecret, MAX_MCP_SECRET)`, and `MAX_MCP_SECRET` goes.
- `mcp-hub.ts`: `function hasOauthApp(config: Json): boolean`; `liveView(s: McpLiveServer, configured: ConfiguredServer[])` sets `oauthApp` when a configured server of the same name and scope has one (`servers()` passes `config.servers`); `configuredView` sets `oauthApp: hasOauthApp(s.config)`. `action` gets `case 'set-secret': return this.setSecret(tabId, tab, a.name, a.scope, a.secret)`.
- `private setSecret(tabId: string, tab: Tab, name: string, scope: McpEditScope, secret: string): Promise<McpResult>`, in `this.queued(tab, …)`: find the server by name and scope in `readTabConfig(...)` (else `fail('No such server in this scope')`, nothing run); `json = JSON.stringify(server.config)`; `secrets = [secret, ...(mcpConfigOf(server.config) === null ? [] : secretsOf(mcpConfigOf(server.config)))]` (compute it once); `this.d.hold(tabId)`, then in `try`: `mcp remove --scope <scope> -- <name>` (an error answers `Could not save the client secret: <error>`); `mcp add-json --scope <scope> --client-secret -- <name> <json>` with `env: { ...tab.env, MCP_CLIENT_SECRET: secret }`; on its error, the plain `mcp add-json --scope <scope> -- <name> <json>` puts the server back and the answer is `Could not save the client secret: <error>`, with ` — <name> could not be added back: <error of the put-back>` appended when that fails too. Every call passes `{ secrets }`. After the remove ran, `this.d.changed(tabId, true)`; `finally` `this.d.release(tabId)`.

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run tests/unit/mcp-hub.test.ts tests/unit/ipc-guards.test.ts tests/unit/mcp-view-model.test.ts tests/unit/status-bar.test.ts` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Report** (no commit: the controller commits)

---

### Task 6: The Client secret field in the MCP panel

**Files:**
- Modify: `src/renderer/mcp/mcp-view-model.ts` (`RowMenuItem`, `rowActions`, new `needsClientSecret`)
- Modify: `src/renderer/mcp/mcp-servers.ts` (`RowCommand`, `RowState`, `ServerListOptions`, menu labels, `serverRow`, new `secretField`)
- Modify: `src/renderer/mcp/mcp-panel.ts` (`command`, `signIn`, new `saveSecret`, `rowOf`, `paintServers`)
- Modify: `src/renderer/mcp/mcp.css`
- Modify: `tests/fixtures/fake-claude/fake-claude.ts` (`mcp login`), `tests/fixtures/fake-claude/install.ts` (`FakeScript.mcpLogin`)
- Test: `tests/unit/mcp-view-model.test.ts`, `tests/e2e/mcp-panel.spec.ts`

**Interfaces:**
- Consumes: `McpServerView.oauthApp`, the `set-secret` action (Task 5); `credentialsFile()` of the stand-in (Task 2).
- Produces: `RowMenuItem` adds `'client-secret'`; `export function needsClientSecret(error: string | null): boolean` (true when the text contains `client authentication failed` or `invalid_client`, any case).
- Produces: `RowCommand` adds `'set-secret' | 'save-secret' | 'cancel-secret'`; `RowState` adds `secretOpen: boolean` and `secret: string` (what the field holds, kept across repaints); `ServerListOptions.secretTyped(name: string, value: string): void`.
- Produces: `FakeScript.mcpLogin` entries take `noSecret?: string` — the sign-in fails with that message while `.credentials.json` keeps no client secret for the server.

- [ ] **Step 1: Write the failing unit tests** in `tests/unit/mcp-view-model.test.ts` (import `needsClientSecret`)

```ts
it('a server with its own OAuth app offers Set client secret… before the config actions, in an edit scope only', () => {
  const asana = server('asana', { status: 'needs-auth', transport: 'http', oauthApp: true })
  expect(rowActions(asana, true).menu).toEqual(['reconnect', 'sign-out', 'client-secret', 'copy-config', 'open-config', 'remove'])
  expect(rowActions({ ...asana, scope: 'plugin', plugin: 'tools' }, true).menu).not.toContain('client-secret')
  expect(rowActions({ ...asana, oauthApp: false }, true).menu).not.toContain('client-secret')
})

describe('needsClientSecret', () => {
  it("is true for a sign-in refused for the app's client authentication, false otherwise", () => {
    expect(needsClientSecret('Client authentication failed. Check that client_id and client_secret match your registered app.')).toBe(true)
    expect(needsClientSecret('OAuth error: invalid_client')).toBe(true)
    expect(needsClientSecret('Cancelled')).toBe(false)
    expect(needsClientSecret(null)).toBe(false)
  })
})
```

- [ ] **Step 2: Write the failing e2e tests** in `tests/e2e/mcp-panel.spec.ts`

```ts
const ASANA = { type: 'http', url: 'https://mcp.example.com/asana', oauth: { clientId: 'asana-client-0001' } }
const APP_SECRET = 'app-secret-never-shown-0001'
const CLIENT_AUTH = 'Client authentication failed. Check that client_id and client_secret match your registered app.'

test("a sign-in refused for the app's client authentication asks for the client secret; Save adds the server again with it, then the sign-in works", async () => {
  const { app, page, log } = await launchChatTab(
    { turns: {}, mcp: { asana: { status: 'needs-auth' } }, mcpLogin: { asana: { noSecret: CLIENT_AUTH } } },
    { claude: { mcpServers: { asana: ASANA } } }
  )
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    const row = page.locator(ROW('asana'))
    await row.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(row.locator('.mcp-error')).toContainText('Client authentication failed')
    const field = row.getByLabel('Client secret', { exact: true })
    await expect(field).toHaveAttribute('type', 'password')
    await expect(field).toBeFocused()
    await field.fill(APP_SECRET)
    await row.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(field).toHaveCount(0)
    expect(cliCalls(log).filter((c) => c.argv.includes('asana') && c.argv[1] !== 'login')).toEqual([
      { argv: ['mcp', 'remove', '--scope', 'user', '--', 'asana'], secretEnv: false, stdinKeys: null },
      { argv: ['mcp', 'add-json', '--scope', 'user', '--client-secret', '--', 'asana', JSON.stringify(ASANA)], secretEnv: true, stdinKeys: null }
    ])
    await row.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(row.locator('.mcp-row')).toHaveAttribute('data-status', 'connected')
    expect(await page.content()).not.toContain(APP_SECRET)
    expect(JSON.stringify(log())).not.toContain(APP_SECRET)
  } finally {
    await app.close()
  }
})

test('Set client secret… shows the field; what is typed survives a repaint; a refused secret shows the message masked and the server stays', async () => {
  const { app, page, log } = await launchChatTab(
    { turns: {}, mcp: { asana: { status: 'needs-auth' } }, cliFail: { 'mcp add-json --scope user --client-secret': `invalid_client: ${APP_SECRET} is not this app's secret` } },
    { claude: { mcpServers: { asana: ASANA } } }
  )
  try {
    await chatReady(page)
    await page.locator(TOGGLE).click()
    const row = page.locator(ROW('asana'))
    await row.getByRole('button', { name: 'More for asana', exact: true }).click()
    await page.locator('.panel-mcp .mcp-menu-item', { hasText: 'Set client secret…' }).click()
    const field = row.getByLabel('Client secret', { exact: true })
    await expect(field).toBeFocused()
    await field.fill(APP_SECRET)
    // a click on the row's name folds its tools: the list is drawn again
    await row.locator('.mcp-main').click()
    await expect(field).toHaveValue(APP_SECRET)
    await field.press('Enter')
    await expect(row.locator('.mcp-error')).toHaveText("Could not save the client secret: invalid_client: •••••••• is not this app's secret")
    await expect(field).toBeVisible()
    expect(cliCalls(log).filter((c) => c.argv.includes('asana')).map((c) => c.argv.slice(0, 5))).toEqual([
      ['mcp', 'remove', '--scope', 'user', '--'],
      ['mcp', 'add-json', '--scope', 'user', '--client-secret'],
      ['mcp', 'add-json', '--scope', 'user', '--']
    ])
    expect(await page.content()).not.toContain(APP_SECRET)
    await row.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(field).toHaveCount(0)
    await expect(row).toBeVisible()
  } finally {
    await app.close()
  }
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/unit/mcp-view-model.test.ts`, build, then `node .superpowers/shared-lock.cjs "node scripts/e2e.mjs --workers=2 mcp-panel.spec.ts"`
Expected: the new tests FAIL (no `client-secret` item, no field); the others PASS.

- [ ] **Step 4: The stand-in's sign-in**

`install.ts`: `mcpLogin?: Record<string, { gate?: string; fail?: string; noSecret?: string }>`, its doc naming `noSecret`. `fake-claude.ts` `login` case, after the gate and before `fail`: `if (plan?.noSecret !== undefined && !hasClientSecret(name)) return bad(plan.noSecret)`, where `hasClientSecret(name)` looks for a key starting with `${name}|` in `readJsonFile(credentialsFile()).mcpOAuthClientConfig`.

- [ ] **Step 5: View model and rows**

`rowActions`: in the edit-scope branch push `'client-secret'` before `'copy-config'` when `s.oauthApp`. `mcp-servers.ts`: `MENU_LABEL['client-secret'] = 'Set client secret…'`, `MENU_COMMAND['client-secret'] = 'set-secret'`; `serverRow` appends `secretField(s, o, row)` after the row's error and before the Remove ask, when `row.secretOpen && editScope(s) !== null`. `secretField` is a `div.mcp-secret` with an `input.mcp-secret-input` (`type: 'password'`, `placeholder: 'Client secret'`, aria-label `Client secret`, `autocomplete: 'off'`, `spellcheck: false`, `value: row.secret` set as a property, `data-focus-key="secret"`, disabled while `row.busy`; `input` → `o.secretTyped(s.name, input.value)`; Enter → `save-secret`, Esc → `cancel-secret`, both with `preventDefault` and `stopPropagation`), then `control('Save', 'mcp-btn primary', 'save-secret', …)` and `control('Cancel', 'mcp-btn', 'cancel-secret', …)`.

- [ ] **Step 6: The panel**

`rowOf` starts rows with `secretOpen: false, secret: ''`; `paintServers` passes `secretTyped: (name, value) => { this.rowOf(name).secret = value }` (no repaint). `command`: `set-secret` closes the menu, sets `row.secretOpen = true`, `this.wanted = { name, key: 'secret' }`, paints; `cancel-secret` sets `secretOpen = false`, `secret = ''`, `this.wanted = { name, key: 'name' }`, paints; `save-secret` calls `saveSecret(tabId, s, row)`. `signIn`: a failure (not cancelled) whose error passes `needsClientSecret` sets `row.secretOpen = true`, and the focus wanted afterwards is `'secret'` when the field is open, else `'sign-in'` as today. `private saveSecret(tabId: string, s: McpServerView, row: RowState): void`: does nothing while `row.busy`, for an empty `row.secret` or without an edit scope; else `row.busy = true`, `row.error = null`, paint, request `{ kind: 'set-secret', name: s.name, scope, secret: row.secret }`; on ok `secretOpen = false`, `secret = ''`, wanted `'sign-in'`; on failure `row.error = result.error`, wanted `'secret'`; then `this.settled(tabId)`.

`mcp.css`:

```css
.mcp-secret { display: flex; align-items: center; gap: 6px; margin: 2px 8px 6px 46px; }
.mcp-secret-input { flex: 1; min-width: 0; box-sizing: border-box; padding: 5px 8px; background: var(--term); color: var(--text); border: 1px solid var(--line-2); border-radius: 8px; font: inherit; font-size: 12.5px; }
.mcp-secret-input:focus { outline: none; border-color: var(--accent); }
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/unit/mcp-view-model.test.ts`, `npm run typecheck`, build, then `node .superpowers/shared-lock.cjs "node scripts/e2e.mjs --workers=2 mcp-panel.spec.ts mcp-add.spec.ts"`
Expected: all PASS.

- [ ] **Step 8: Report** (no commit: the controller commits)

---

## After the last task

Run `npm run typecheck`, `npm test`, the build, then `node .superpowers/shared-lock.cjs "node scripts/e2e.mjs --workers=2 account-add.spec.ts accounts-flow.spec.ts mcp-panel.spec.ts mcp-add.spec.ts"`. Known flakes under load: `review.spec`, `tab-panel.spec:311`, the account-add sign-in check (rerun alone before blaming this work).
