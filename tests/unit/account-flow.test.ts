import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AccountFlow, type AccountFlowDeps } from '../../src/main/account-flow'
import { NO_IDENTITY, type AuthStatus, type Identity } from '../../src/main/account-login'
import type { AccountEntry } from '../../src/main/accounts'
import type { AccountBegin, AccountFlowView, CarryItem } from '../../src/shared/accounts'

const ROOT = join(tmpdir(), 'claude-accounts')
const MAIN = join(tmpdir(), 'main-config')
const WORK = join(ROOT, 'work')
const OLD = join(ROOT, 'old')
const PICKED = join(tmpdir(), 'my-config')
const ANA: Identity = { email: 'ana@example.test', orgName: 'Acme', orgUuid: 'org-1', plan: 'Max' }

function login(over: Partial<AccountEntry> = {}): AccountEntry {
  return { id: 'acc-old', name: 'Old', addedAt: '2026-11-01T00:00:00.000Z', kind: 'login', folder: OLD, created: true, readable: true, ...over }
}

/** a promise a test resolves by hand, to hold an await open */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

interface Options {
  main?: string
  entries?: AccountEntry[]
  others?: { label: string; identity: Identity }[]
  tabs?: Record<string, number>
  settingsOpen?: boolean
}

function setup(over: Options = {}) {
  const calls: string[] = []
  const views: (AccountFlowView | null)[] = []
  const dirs = new Set<string>([MAIN])
  const entries = over.entries ?? []
  const w = {
    status: { state: 'signed-in', identity: ANA } as AuthStatus,
    identity: NO_IDENTITY as Identity,
    failCarry: new Map<CarryItem, string>(),
    gates: new Map<CarryItem, Promise<void>>(),
    statusGate: null as Promise<void> | null,
    logoutGate: null as Promise<void> | null,
    failRemove: null as Error | null,
    others: over.others ?? [],
    tabs: over.tabs ?? {},
    settingsOpen: over.settingsOpen ?? false
  }
  let tabNo = 0
  const deps: AccountFlowDeps = {
    store: {
      list: () => entries,
      addLogin: (a) => {
        calls.push(`addLogin ${a.id} ${a.name} ${a.folder} ${a.created}`)
        return { ok: true }
      },
      toLogin: (id, name, folder, created) => {
        calls.push(`toLogin ${String(id)} ${String(name)} ${folder} ${created}`)
        return { ok: true }
      }
    },
    root: () => ROOT,
    mainFolder: over.main ?? MAIN,
    canonical: async (p) => p,
    isDir: async (p) => dirs.has(p),
    mkdir: async (p) => {
      calls.push(`mkdir ${p}`)
      dirs.add(p)
    },
    removeCreated: async (p) => {
      calls.push(`remove ${p}`)
      if (w.failRemove) throw w.failRemove
      dirs.delete(p)
    },
    openSignInTab: (name, folder, email) => {
      calls.push(`open ${name} ${folder} ${email ?? '-'}`)
      return `tab${++tabNo}`
    },
    closeTab: (tab) => {
      calls.push(`close ${tab}`)
    },
    showTab: (tab) => {
      calls.push(`show ${tab}`)
    },
    status: async (folder) => {
      calls.push(`status ${folder}`)
      if (w.statusGate) await w.statusGate
      return w.status
    },
    identity: async () => w.identity,
    logout: async (folder) => {
      calls.push(`logout ${folder}`)
      if (w.logoutGate) await w.logoutGate
      return true
    },
    others: async () => w.others,
    carry: async (item, target, source) => {
      calls.push(`carry ${item} ${target.name} ${source ?? 'main'}`)
      const held = w.gates.get(item)
      if (held) await held
      const failure = w.failCarry.get(item)
      if (failure !== undefined) throw new Error(failure)
      return { item, state: 'done', text: `${item} copied`, subs: [] }
    },
    register: async () => {
      calls.push('register')
      return { item: 'claudeterm', state: 'done', text: "ClaudeTerm's tools added", subs: [] }
    },
    tabsOn: (id) => w.tabs[id] ?? 0,
    settingsOpen: () => w.settingsOpen,
    toast: (message) => {
      calls.push(`toast ${message}`)
    },
    publish: (view) => {
      views.push(view)
    },
    accountsChanged: () => {
      calls.push('changed')
    },
    confirmed: (id, identity) => {
      calls.push(`confirmed ${id} ${identity.email}`)
    },
    openClaudeTab: (id) => {
      calls.push(`open-claude ${id}`)
    },
    log: (message) => {
      calls.push(`log ${message}`)
    },
    newId: () => 'acc-1'
  }
  return { flow: new AccountFlow(deps), calls, views, dirs, w, entries }
}

/** the steps of the views published so far, in order (null for a forgotten flow) */
function steps(views: (AccountFlowView | null)[]): (string | null)[] {
  return views.map((v) => (v === null ? null : v.step))
}

/** the states of a published view's lines, in line order */
function states(views: (AccountFlowView | null)[], index: number): string[] | undefined {
  return views[index]?.lines.map((l) => l.state)
}

/** lets the background work of the flow (the carry-over's items) run to its next await */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function add(over: Partial<AccountBegin> = {}): AccountBegin {
  return { mode: 'add', id: null, name: 'Work', email: null, source: null, items: [], adopt: false, ...over }
}

function carryReq(items: CarryItem[]): AccountBegin {
  return { mode: 'carry', id: 'acc-old', name: null, email: null, source: null, items, adopt: false }
}

describe('AccountFlow', () => {
  it('begin add makes the folder, keeps the account pending and opens the sign-in tab in the background', async () => {
    const t = setup()
    expect(await t.flow.begin(add())).toEqual({ ok: true })
    expect(t.calls).toEqual([`mkdir ${WORK}`, `open Work ${WORK} -`])
    expect(t.flow.view()).toMatchObject({ mode: 'add', id: 'acc-1', name: 'Work', step: 'sign-in', folder: WORK, error: null })
    expect(steps(t.views)).toEqual(['sign-in'])
  })

  it('a second begin while one runs is refused', async () => {
    const t = setup()
    await t.flow.begin(add())
    expect(await t.flow.begin(add({ name: 'Other' }))).toEqual({
      ok: false,
      error: 'An account is being added: finish or cancel it first'
    })
    expect(t.calls.filter((c) => c.startsWith('mkdir'))).toHaveLength(1)
  })

  it('a name or an email that is not valid is refused before any folder is made', async () => {
    const t = setup()
    expect(await t.flow.begin(add({ name: '  ' }))).toEqual({ ok: false, error: 'Enter a name' })
    expect(await t.flow.begin(add({ name: 'Main account' }))).toEqual({
      ok: false,
      error: '"Main account" is your normal Claude Code login; choose another name'
    })
    expect(await t.flow.begin(add({ email: 'not an address' }))).toEqual({
      ok: false,
      error: 'Enter an email address, or leave it empty'
    })
    expect(t.calls).toEqual([])
    expect(t.views).toEqual([])
    expect(t.flow.view()).toBeNull()
  })

  it("signed in: the tab closes, the account is saved, the items run in order, ClaudeTerm's tools, trusted folders last", async () => {
    const t = setup()
    await t.flow.begin(add({ items: ['plugins', 'trust', 'settings', 'hooks'] }))
    await t.flow.tabEnded('tab1')

    const carries = t.calls.filter((c) => /^(carry|register)/.test(c))
    expect(carries).toEqual(['carry settings Work main', 'carry hooks Work main', 'carry plugins Work main', 'register', 'carry trust Work main'])
    const saved = t.calls.indexOf(`addLogin acc-1 Work ${WORK} true`)
    expect(saved).toBeGreaterThanOrEqual(0)
    expect(saved).toBeLessThan(t.calls.indexOf('carry settings Work main'))
    expect(t.calls).toContain('close tab1')
    expect(t.calls).toContain('changed')
    expect(t.calls).toContain('confirmed acc-1 ana@example.test')
    expect(t.calls).toContain('toast Account "Work" is ready: signed in as ana@example.test')

    const view = t.flow.view()
    expect(view).toMatchObject({ step: 'done', who: { email: 'ana@example.test', plan: 'Max' } })
    expect(view?.lines.map((l) => l.item)).toEqual(['settings', 'hooks', 'plugins', 'trust', 'claudeterm'])
    expect(view?.lines.every((l) => l.state === 'done')).toBe(true)

    // the published sequence: sign-in, confirming, done with every line running, then each line replaced in turn
    expect(steps(t.views)).toEqual(['sign-in', 'confirming', 'done', 'done', 'done', 'done', 'done', 'done'])
    expect(states(t.views, 2)).toEqual(['running', 'running', 'running', 'running', 'running'])
    expect(states(t.views, 3)).toEqual(['done', 'running', 'running', 'running', 'running'])
    expect(states(t.views, 4)).toEqual(['done', 'done', 'running', 'running', 'running'])
    expect(states(t.views, 5)).toEqual(['done', 'done', 'done', 'running', 'running'])
    expect(states(t.views, 6)).toEqual(['done', 'done', 'done', 'running', 'done'])
    expect(states(t.views, 7)).toEqual(['done', 'done', 'done', 'done', 'done'])
  })

  it('a tab that ends without a sign-in did not finish: its last line, the tab left open; Try again opens a new one', async () => {
    const t = setup()
    t.w.status = { state: 'signed-out' }
    await t.flow.begin(add())
    await t.flow.tabOutput('tab1', 'Opening your browser\r\n\x1b[31mRun claude auth login again\x1b[0m\r\n')
    await t.flow.tabEnded('tab1')
    expect(t.flow.view()).toMatchObject({ step: 'failed', error: 'The sign-in did not finish', lastLine: 'Run claude auth login again' })
    expect(t.calls).not.toContain('close tab1')
    expect(t.calls.some((c) => c.startsWith('addLogin'))).toBe(false)
    expect(steps(t.views)).toEqual(['sign-in', 'confirming', 'failed'])

    await t.flow.action({ kind: 'retry-sign-in' })
    expect(t.calls).toContain('close tab1')
    expect(t.calls.filter((c) => c.startsWith('open '))).toHaveLength(2)
    expect(t.flow.view()).toMatchObject({ step: 'sign-in', error: null, lastLine: null })
  })

  it('a closed sign-in tab is a sign-in that did not finish: nothing saved, no folder removed, Try again opens a new tab', async () => {
    const t = setup()
    t.w.status = { state: 'signed-out' }
    await t.flow.begin(add())
    // the person closed the tab: only the end of its process arrives, the flow closes nothing itself
    await t.flow.tabEnded('tab1')
    expect(t.flow.view()).toMatchObject({ step: 'failed', error: 'The sign-in did not finish' })
    expect(t.calls.some((c) => c.startsWith('close'))).toBe(false)
    expect(t.calls.some((c) => c.startsWith('addLogin') || c.startsWith('toLogin'))).toBe(false)
    expect(t.calls.some((c) => c.startsWith('remove'))).toBe(false)
    expect(t.calls.some((c) => c === 'changed')).toBe(false)

    await t.flow.action({ kind: 'retry-sign-in' })
    expect(t.calls.filter((c) => c.startsWith('open '))).toHaveLength(2)
    expect(t.flow.view()?.step).toBe('sign-in')
  })

  it('a tab the flow closed itself does not end a sign-in again', async () => {
    const t = setup()
    await t.flow.begin(add())
    await t.flow.tabEnded('tab1')
    const statusCalls = t.calls.filter((c) => c.startsWith('status')).length
    await t.flow.tabEnded('tab1')
    expect(t.calls.filter((c) => c.startsWith('status'))).toHaveLength(statusCalls)
    expect(t.flow.view()?.step).toBe('done')
  })

  it('unknown right after the sign-in is a failure and saves nothing', async () => {
    const t = setup()
    t.w.status = { state: 'unknown', reason: 'timeout' }
    await t.flow.begin(add())
    await t.flow.tabEnded('tab1')
    expect(t.flow.view()).toMatchObject({ step: 'failed', error: 'Could not confirm the sign-in' })
    expect(t.calls.some((c) => c.startsWith('addLogin'))).toBe(false)
    expect(t.calls).not.toContain('changed')
  })

  it('the same login as Main account asks; Sign in with another account signs out and opens a new tab; Keep it anyway saves', async () => {
    const t = setup({ others: [{ label: 'Main account', identity: ANA }] })
    await t.flow.begin(add())
    await t.flow.tabEnded('tab1')
    expect(t.flow.view()).toMatchObject({ step: 'same-login', sameAs: { account: 'Main account', email: 'ana@example.test' } })
    expect(t.calls.some((c) => c.startsWith('addLogin'))).toBe(false)
    expect(steps(t.views)).toEqual(['sign-in', 'confirming', 'same-login'])

    await t.flow.action({ kind: 'another-login' })
    expect(t.calls).toContain(`logout ${WORK}`)
    expect(t.calls.filter((c) => c.startsWith('open '))).toHaveLength(2)
    expect(t.flow.view()).toMatchObject({ step: 'sign-in', sameAs: null })
    expect(t.calls.some((c) => c.startsWith('addLogin'))).toBe(false)

    // the new login is the same one again: the question comes back, and Keep it anyway saves
    await t.flow.tabEnded('tab2')
    expect(t.flow.view()?.step).toBe('same-login')
    await t.flow.action({ kind: 'keep-login' })
    expect(t.calls).toContain(`addLogin acc-1 Work ${WORK} true`)
    expect(t.flow.view()?.step).toBe('done')
  })

  it('no email known asks nothing', async () => {
    const t = setup({ others: [{ label: 'Main account', identity: ANA }] })
    t.w.status = { state: 'signed-in', identity: { ...ANA, email: null } }
    await t.flow.begin(add())
    await t.flow.tabEnded('tab1')
    expect(t.flow.view()?.step).toBe('done')
    expect(t.calls).toContain(`addLogin acc-1 Work ${WORK} true`)
  })

  it('Cancel closes the tab, deletes the folder it made and saves nothing', async () => {
    const t = setup()
    await t.flow.begin(add())
    await t.flow.action({ kind: 'cancel' })
    expect(t.calls).toEqual(expect.arrayContaining(['close tab1', `remove ${WORK}`]))
    expect(t.calls.some((c) => c.startsWith('addLogin'))).toBe(false)
    expect(t.flow.view()).toBeNull()
    expect(t.views.at(-1)).toBeNull()
  })

  it('Cancel during the confirmation closes the tab and removes the folder; the late answer changes nothing', async () => {
    const t = setup()
    const held = gate()
    t.w.statusGate = held.wait
    await t.flow.begin(add())
    const ended = t.flow.tabEnded('tab1')
    await t.flow.action({ kind: 'cancel' })
    expect(t.calls).toEqual(expect.arrayContaining(['close tab1', `remove ${WORK}`]))
    held.open()
    await ended
    expect(t.calls.some((c) => c.startsWith('addLogin') || c === 'changed')).toBe(false)
    expect(t.flow.view()).toBeNull()
  })

  it('Cancel of a sign-in again or of an adopted folder deletes nothing', async () => {
    const again = setup({ entries: [login()] })
    again.dirs.add(OLD)
    expect(await again.flow.begin({ mode: 'sign-in-again', id: 'acc-old', name: null, email: null, source: null, items: [], adopt: false })).toEqual({ ok: true })
    await again.flow.action({ kind: 'cancel' })
    expect(again.calls.some((c) => c.startsWith('remove'))).toBe(false)
    expect(again.flow.view()).toBeNull()

    const adopted = setup()
    adopted.dirs.add(PICKED)
    adopted.w.status = { state: 'signed-out' }
    await adopted.flow.pick(PICKED)
    expect(await adopted.flow.begin(add({ adopt: true }))).toEqual({ ok: true })
    await adopted.flow.action({ kind: 'cancel' })
    expect(adopted.calls.some((c) => c.startsWith('remove'))).toBe(false)
    expect(adopted.calls).toContain('close tab1')
  })

  it('in done, cancel only forgets the flow', async () => {
    const t = setup()
    await t.flow.begin(add())
    await t.flow.tabEnded('tab1')
    await t.flow.action({ kind: 'cancel' })
    expect(t.calls.some((c) => c.startsWith('remove'))).toBe(false)
    expect(t.flow.view()).toBeNull()
  })

  it('with the Settings window closed the ready account is toasted', async () => {
    const t = setup({ settingsOpen: false })
    await t.flow.begin(add())
    await t.flow.tabEnded('tab1')
    expect(t.calls).toContain('toast Account "Work" is ready: signed in as ana@example.test')
  })

  it('with the Settings window closed a ready account without an email is toasted without one', async () => {
    const t = setup({ settingsOpen: false })
    t.w.status = { state: 'signed-in', identity: { ...ANA, email: null } }
    await t.flow.begin(add())
    await t.flow.tabEnded('tab1')
    expect(t.calls).toContain('toast Account "Work" is ready')
  })

  it('with the Settings window open the ready account is not toasted', async () => {
    const t = setup({ settingsOpen: true })
    await t.flow.begin(add())
    await t.flow.tabEnded('tab1')
    expect(t.calls.some((c) => c.startsWith('toast'))).toBe(false)
    expect(t.calls.some((c) => c.startsWith('addLogin'))).toBe(true)
  })

  it('to-login keeps the id and drops the token in one write', async () => {
    const token: AccountEntry = login({ id: 'tok-1', name: 'Old', kind: 'token', folder: null, created: false })
    const t = setup({ entries: [token] })
    expect(await t.flow.begin({ mode: 'to-login', id: 'tok-1', name: 'Old', email: null, source: null, items: [], adopt: false })).toEqual({ ok: true })
    expect(t.calls).toContain(`mkdir ${OLD}`)
    await t.flow.tabEnded('tab1')
    expect(t.calls.filter((c) => c.startsWith('toLogin'))).toEqual([`toLogin tok-1 Old ${OLD} true`])
    expect(t.calls.some((c) => c.startsWith('addLogin'))).toBe(false)
    expect(t.flow.view()).toMatchObject({ id: 'tok-1', step: 'done' })
  })

  it("pick refuses Main account's folder, an account's folder and a file; a signed-in folder is added at once with created false", async () => {
    const t = setup({ entries: [login({ id: 'acc-work', name: 'Work', folder: WORK })] })
    expect(await t.flow.pick(join(tmpdir(), 'notes.txt'))).toEqual({ ok: false, error: 'Not a folder' })
    expect(await t.flow.pick(MAIN)).toEqual({ ok: false, error: "This is Main account's folder" })
    t.dirs.add(WORK)
    expect(await t.flow.pick(WORK)).toEqual({ ok: false, error: 'This folder is already the account "Work"' })

    t.dirs.add(PICKED)
    expect(await t.flow.pick(PICKED)).toEqual({ ok: true, path: PICKED, signedIn: true, email: 'ana@example.test', plan: 'Max' })
    expect(await t.flow.begin(add({ name: 'Mine', adopt: true }))).toEqual({ ok: true })
    expect(t.calls).toContain(`addLogin acc-1 Mine ${PICKED} false`)
    expect(t.calls.some((c) => c.startsWith('mkdir'))).toBe(false)
    expect(t.flow.view()?.step).toBe('done')
  })

  it('adopt without a picked folder is refused, and an adopted folder that is not signed in gets the sign-in tab', async () => {
    const t = setup()
    expect(await t.flow.begin(add({ adopt: true }))).toEqual({ ok: false, error: 'Pick the folder first' })

    t.dirs.add(PICKED)
    t.w.status = { state: 'signed-out' }
    await t.flow.pick(PICKED)
    expect(await t.flow.begin(add({ name: 'Mine', adopt: true }))).toEqual({ ok: true })
    expect(t.calls.filter((c) => c.startsWith('open '))).toEqual([`open Mine ${PICKED} -`])
    expect(t.calls.some((c) => c.startsWith('mkdir'))).toBe(false)
    expect(t.flow.view()).toMatchObject({ step: 'sign-in', folder: PICKED })
  })

  it('a picked folder is used once: a second adopt begin needs a new pick', async () => {
    const t = setup()
    t.dirs.add(PICKED)
    await t.flow.pick(PICKED)
    expect(await t.flow.begin(add({ name: 'Mine', adopt: true }))).toEqual({ ok: true })
    await t.flow.action({ kind: 'cancel' })
    expect(await t.flow.begin(add({ name: 'Again', adopt: true }))).toEqual({ ok: false, error: 'Pick the folder first' })
  })

  it('an adopt begin for a folder that became an account meanwhile is refused', async () => {
    const entries: AccountEntry[] = []
    const t = setup({ entries })
    t.dirs.add(PICKED)
    await t.flow.pick(PICKED)
    entries.push(login({ id: 'acc-mine', name: 'Mine', folder: PICKED }))
    expect(await t.flow.begin(add({ name: 'Other', adopt: true }))).toEqual({ ok: false, error: 'This folder is already the account "Mine"' })
    expect(t.calls.some((c) => c.startsWith('addLogin'))).toBe(false)
  })

  it("pick refuses a folder that is part of Main account's setup: the home folder holding ~/.claude, a folder inside it or holding it", async () => {
    const home = join(tmpdir(), 'home-of-the-person')
    const t = setup({ main: join(home, '.claude') })
    t.dirs.add(home)
    t.dirs.add(join(home, 'notes'))
    t.dirs.add(join(home, '.claude', 'projects'))
    expect(await t.flow.pick(home)).toEqual({ ok: false, error: "This folder is part of Main account's setup" })
    expect(await t.flow.pick(join(home, '.claude', 'projects'))).toEqual({ ok: false, error: "This folder is part of Main account's setup" })
    expect(await t.flow.pick(join(home, 'notes'))).toMatchObject({ ok: true, path: join(home, 'notes') })
  })

  it('pick refuses a folder that is part of another account: inside it, or holding it', async () => {
    const t = setup({ entries: [login({ id: 'acc-work', name: 'Work', folder: WORK })] })
    t.dirs.add(WORK)
    t.dirs.add(join(WORK, 'nested'))
    t.dirs.add(ROOT)
    expect(await t.flow.pick(join(WORK, 'nested'))).toEqual({ ok: false, error: 'This folder is part of the account "Work"' })
    expect(await t.flow.pick(ROOT)).toEqual({ ok: false, error: 'This folder is part of the account "Work"' })
  })

  it("pick refuses a folder inside Main account's folder", async () => {
    const t = setup()
    t.dirs.add(join(MAIN, 'projects'))
    expect(await t.flow.pick(join(MAIN, 'projects'))).toEqual({ ok: false, error: "This folder is part of Main account's setup" })
  })

  it('a carry copies from Main account or another sign-in account only: a token account, the target itself or an unknown id is refused', async () => {
    const token: AccountEntry = { id: 'acc-token', name: 'Token', addedAt: '2026-11-01T00:00:00.000Z', kind: 'token', folder: null, created: false, readable: true }
    const t = setup({ entries: [login(), token] })
    t.dirs.add(OLD)
    const refused = { ok: false, error: 'The account to carry from is not available' }
    expect(await t.flow.begin({ ...carryReq(['mcp']), source: 'acc-token' })).toEqual(refused)
    expect(await t.flow.begin({ ...carryReq(['mcp']), source: 'acc-old' })).toEqual(refused)
    expect(await t.flow.begin({ ...carryReq(['mcp']), source: 'acc-missing' })).toEqual(refused)
    expect(t.calls.some((c) => c.startsWith('carry'))).toBe(false)
    expect(await t.flow.begin({ ...carryReq(['mcp']), source: null })).toEqual({ ok: true })
    await settle()
    expect(t.calls).toContain('carry mcp Old main')
  })

  it('cancel at the same-login step signs the signed-in folder out before the folder is removed', async () => {
    const t = setup({ others: [{ label: 'Work', identity: ANA }] })
    await t.flow.begin(add())
    await t.flow.tabEnded('tab1')
    expect(t.flow.view()?.step).toBe('same-login')
    await t.flow.action({ kind: 'cancel' })
    const logout = t.calls.indexOf(`logout ${WORK}`)
    expect(logout).toBeGreaterThanOrEqual(0)
    expect(logout).toBeLessThan(t.calls.indexOf(`remove ${WORK}`))
  })

  it('carry runs only the ticked items', async () => {
    const t = setup({ entries: [login()] })
    t.dirs.add(OLD)
    t.w.identity = ANA
    expect(await t.flow.begin(carryReq(['mcp']))).toEqual({ ok: true })
    await settle()
    expect(t.calls.filter((c) => /^(carry|register)/.test(c))).toEqual(['carry mcp Old main', 'register'])
    expect(t.calls.some((c) => c.startsWith('addLogin') || c.startsWith('mkdir') || c.startsWith('open '))).toBe(false)
    expect(t.flow.view()).toMatchObject({ step: 'done', who: { email: 'ana@example.test', plan: 'Max' } })
    expect(t.flow.view()?.lines.map((l) => l.item)).toEqual(['mcp', 'claudeterm'])
  })

  it('carry never calls confirmed or saves: no sign-in ran', async () => {
    const t = setup({ entries: [login()] })
    t.dirs.add(OLD)
    await t.flow.begin(carryReq(['mcp']))
    expect(t.calls.some((c) => c.startsWith('confirmed'))).toBe(false)
    expect(t.calls.some((c) => c.startsWith('addLogin') || c.startsWith('toLogin'))).toBe(false)
    expect(t.calls).not.toContain('changed')
  })

  it('trusted folders are skipped while tabs run on the account in carry mode', async () => {
    const t = setup({ entries: [login()], tabs: { 'acc-old': 2 } })
    t.dirs.add(OLD)
    await t.flow.begin(carryReq(['trust']))
    await settle()
    const trust = t.flow.view()?.lines.find((l) => l.item === 'trust')
    expect(trust).toMatchObject({ state: 'skipped', text: 'Close the tabs on Old to carry over trusted folders' })
    expect(t.calls).not.toContain('carry trust Old main')
  })

  it('one failing item does not stop the others', async () => {
    const t = setup({ entries: [login()] })
    t.dirs.add(OLD)
    t.w.failCarry.set('mcp', 'boom')
    await t.flow.begin(carryReq(['mcp', 'plugins']))
    await settle()
    expect(t.flow.view()?.lines).toEqual([
      { item: 'mcp', state: 'failed', text: 'boom', subs: [] },
      { item: 'plugins', state: 'done', text: 'plugins copied', subs: [] },
      { item: 'claudeterm', state: 'done', text: "ClaudeTerm's tools added", subs: [] }
    ])
  })

  it('retry-item runs that item again', async () => {
    const t = setup({ entries: [login()] })
    t.dirs.add(OLD)
    t.w.failCarry.set('mcp', 'boom')
    await t.flow.begin(carryReq(['mcp']))
    await settle()
    t.w.failCarry.delete('mcp')
    await t.flow.action({ kind: 'retry-item', item: 'mcp' })
    expect(t.flow.view()?.lines.find((l) => l.item === 'mcp')).toMatchObject({ state: 'done', text: 'mcp copied' })
    expect(t.calls.filter((c) => c === 'carry mcp Old main')).toHaveLength(2)
  })

  it('a double retry-item runs the item once: a line that is running is not retried', async () => {
    const t = setup({ entries: [login()] })
    t.dirs.add(OLD)
    t.w.failCarry.set('mcp', 'boom')
    await t.flow.begin(carryReq(['mcp']))
    await settle()
    t.w.failCarry.delete('mcp')
    const held = gate()
    t.w.gates.set('mcp', held.wait)
    const first = t.flow.action({ kind: 'retry-item', item: 'mcp' })
    await t.flow.action({ kind: 'retry-item', item: 'mcp' })
    held.open()
    await first
    expect(t.calls.filter((c) => c === 'carry mcp Old main')).toHaveLength(2)
  })

  it('begin of a carry resolves before a still-pending item answers; a begin after close during the run is accepted', async () => {
    const t = setup({ entries: [login()] })
    t.dirs.add(OLD)
    const held = gate()
    t.w.gates.set('mcp', held.wait)
    const begun = await Promise.race([t.flow.begin(carryReq(['mcp'])), new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 0))])
    expect(begun).toEqual({ ok: true })
    expect(t.flow.view()?.lines.find((l) => l.item === 'mcp')?.state).toBe('running')

    await t.flow.action({ kind: 'close' })
    expect(t.flow.view()).toBeNull()
    expect(await t.flow.begin(add({ name: 'Fresh' }))).toEqual({ ok: true })
    held.open()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(t.flow.view()).toMatchObject({ name: 'Fresh', step: 'sign-in' })
  })

  it('another-login refused while it waits for the logout: a second click runs nothing more', async () => {
    const t = setup({ others: [{ label: 'Main account', identity: ANA }] })
    await t.flow.begin(add())
    await t.flow.tabEnded('tab1')
    const held = gate()
    t.w.logoutGate = held.wait
    const first = t.flow.action({ kind: 'another-login' })
    await t.flow.action({ kind: 'another-login' })
    held.open()
    await first
    expect(t.calls.filter((c) => c.startsWith('logout'))).toHaveLength(1)
    expect(t.calls.filter((c) => c.startsWith('open '))).toHaveLength(2)
  })

  it('keep-login during another-login is refused: nothing is saved until the new sign-in is confirmed', async () => {
    const t = setup({ others: [{ label: 'Main account', identity: ANA }] })
    await t.flow.begin(add())
    await t.flow.tabEnded('tab1')
    const held = gate()
    t.w.logoutGate = held.wait
    const first = t.flow.action({ kind: 'another-login' })
    await t.flow.action({ kind: 'keep-login' })
    expect(t.calls.some((c) => c.startsWith('addLogin'))).toBe(false)
    held.open()
    await first
    expect(t.calls.some((c) => c.startsWith('addLogin'))).toBe(false)
    expect(t.flow.view()).toMatchObject({ step: 'sign-in' })
  })

  it('a folder that cannot be removed on cancel is logged and the flow still ends', async () => {
    const t = setup()
    t.w.failRemove = Object.assign(new Error('busy'), { code: 'EBUSY' })
    await t.flow.begin(add())
    await t.flow.action({ kind: 'cancel' })
    expect(t.calls).toContain(`log Could not remove the folder ${WORK}: EBUSY`)
    expect(t.flow.view()).toBeNull()
    expect(t.views.at(-1)).toBeNull()
  })

  it('a folder that cannot be removed on quit is logged and quit still resolves', async () => {
    const t = setup()
    t.w.failRemove = new Error('the folder is in use')
    await t.flow.begin(add())
    await t.flow.quit()
    expect(t.calls).toContain(`log Could not remove the folder ${WORK}: the folder is in use`)
    expect(t.flow.view()).toBeNull()
  })

  it('tab output keeps the last non-empty line, clean of control sequences and at most 200 characters', async () => {
    const t = setup()
    t.w.status = { state: 'signed-out' }
    await t.flow.begin(add())
    await t.flow.tabOutput('tab1', '\x1b]0;Title\x07Hello\x1b[2K\r\n\r\n   Visit the page   \r\n\r\n')
    await t.flow.tabOutput('tab9', 'output of another tab\r\n')
    expect(t.flow.view()).toMatchObject({ lastLine: 'Visit the page' })
    await t.flow.tabOutput('tab1', `${'a'.repeat(300)}\r\n`)
    await t.flow.tabEnded('tab1')
    expect(t.flow.view()?.lastLine).toBe('a'.repeat(200))
  })

  it('the sign-in tab output shows its last line on a failed sign-in with control characters removed', async () => {
    const t = setup()
    t.w.status = { state: 'signed-out' }
    await t.flow.begin(add())
    await t.flow.tabOutput('tab1', '\x1b]0;Title\x07Hello\x1b[2K\r\n\r\n   Visit the page   \r\n\r\n')
    await t.flow.tabEnded('tab1')
    expect(t.flow.view()?.lastLine).toBe('Visit the page')
  })

  it('quit removes the folder of an add still waiting, and closes its tab', async () => {
    const t = setup()
    await t.flow.begin(add())
    await t.flow.quit()
    expect(t.calls).toEqual(expect.arrayContaining(['close tab1', `remove ${WORK}`]))
    expect(t.flow.view()).toBeNull()
  })

  it('open-tab opens a Claude tab on the account and forgets the flow', async () => {
    const t = setup()
    await t.flow.begin(add())
    await t.flow.tabEnded('tab1')
    await t.flow.action({ kind: 'open-tab' })
    expect(t.calls).toContain('open-claude acc-1')
    expect(t.flow.view()).toBeNull()
  })

  it('open-tab waits while a carry-over line runs: no tab opens until the lines settle, then one does', async () => {
    const t = setup({ entries: [login()] })
    t.dirs.add(OLD)
    t.w.identity = ANA
    const held = gate()
    t.w.gates.set('mcp', held.wait)
    expect(await t.flow.begin(carryReq(['mcp']))).toEqual({ ok: true })
    await settle()
    await t.flow.action({ kind: 'open-tab' })
    expect(t.calls).not.toContain('open-claude acc-old')
    expect(t.flow.view()?.step).toBe('done')

    held.open()
    await settle()
    await settle()
    expect(t.flow.view()?.lines.some((l) => l.state === 'running')).toBe(false)
    await t.flow.action({ kind: 'open-tab' })
    expect(t.calls.filter((c) => c === 'open-claude acc-old')).toHaveLength(1)
  })

  it('show-tab brings the sign-in tab forward', async () => {
    const t = setup()
    await t.flow.begin(add())
    await t.flow.action({ kind: 'show-tab' })
    expect(t.calls).toContain('show tab1')
  })
})
