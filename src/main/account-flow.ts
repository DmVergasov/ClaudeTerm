import {
  CARRY_ITEMS,
  CARRY_LABELS,
  type AccountBegin,
  type AccountFlowView,
  type AccountResult,
  type CarryItem,
  type CarryLine,
  type CarryLineItem,
  type FlowAction,
  type FlowMode,
  type PickedFolder
} from '../shared/accounts'
import { accountFolder, checkEmail, clashes, mergeIdentity, NO_IDENTITY, sameLogin, type AuthStatus, type Identity } from './account-login'
import { checkAccountName, type AccountStore } from './accounts'
import { pathKey } from './path-key'

/** the account a carry-over writes into */
export interface FlowTarget {
  id: string
  name: string
  folder: string
}

/** everything the add flow touches: the store, the folders, the tabs, Claude Code's CLI and the windows */
export interface AccountFlowDeps {
  store: Pick<AccountStore, 'list' | 'addLogin' | 'toLogin'>
  root(): string
  mainFolder: string | null
  canonical(path: string): Promise<string>
  isDir(path: string): Promise<boolean>
  /** recursive; mode 0700 off Windows */
  mkdir(path: string): Promise<void>
  /** removes a folder this flow made */
  removeCreated(path: string): Promise<void>
  /** the sign-in tab in the background; its tab id, or null when it cannot be opened */
  openSignInTab(name: string, folder: string, email: string | null): string | null
  closeTab(tabId: string): void
  showTab(tabId: string): void
  status(folder: string): Promise<AuthStatus>
  identity(folder: string): Promise<Identity>
  /** `claude auth logout` in the folder; false when it failed */
  logout(folder: string): Promise<boolean>
  /** Main account first, then the other sign-in accounts */
  others(except: string | null): Promise<{ label: string; identity: Identity }[]>
  carry(item: CarryItem, target: FlowTarget, source: string | null): Promise<CarryLine>
  register(folder: string): Promise<CarryLine>
  tabsOn(id: string): number
  settingsOpen(): boolean
  toast(message: string): void
  publish(view: AccountFlowView | null): void
  accountsChanged(): void
  confirmed(id: string, identity: Identity): void
  openClaudeTab(id: string): void
  /** the app log: a failure the flow cannot show the person (a folder it could not remove) */
  log(message: string): void
  newId(): string
}

/** a folder picked for an account, kept for `begin({ adopt: true })` until that begin uses it */
interface Picked {
  path: string
  signedIn: boolean
  identity: Identity
}

/** the flow as it runs: the view published to the windows, and what only main needs */
interface Flow {
  view: AccountFlowView
  email: string | null
  created: boolean
  source: string | null
  items: CarryItem[]
  /** the sign-in tab, while it is open */
  tabId: string | null
  identity: Identity
  /** the folder was confirmed signed in: a cancel signs it out before the folder goes */
  signedIn: boolean
  /** an action is waiting for its await: every other action is refused until it resolves */
  busy: boolean
}

/** a flow that may start: the account, its folder and what it carries */
interface Start {
  mode: FlowMode
  id: string
  name: string
  email: string | null
  folder: string
  created: boolean
  source: string | null
  items: CarryItem[]
  /** a folder picked and already signed in: no sign-in tab */
  signedIn: Identity | null
}

type Planned = { ok: true; start: Start } | { ok: false; error: string }

/** the order the carry-over runs its items in; the lines are shown in CARRY_ITEMS order, then ClaudeTerm's tools */
const RUN_ORDER: CarryLineItem[] = ['settings', 'hooks', 'skills', 'agents', 'commands', 'output-styles', 'memory', 'keybindings', 'mcp', 'plugins', 'claudeterm', 'trust']
const LAST_LINE_MAX = 200
const BUSY = 'An account is being added: finish or cancel it first'
const NO_ACCOUNT = 'No such account'
const NO_SOURCE = 'The account to carry from is not available'
/** an ANSI/OSC escape sequence: OSC up to its BEL or ST, CSI, or a two-character escape */
const ESCAPE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

/** the last non-empty line of some tab output: escape sequences and control characters removed, at most 200 characters */
function lastLine(data: string): string | null {
  const lines = data.replace(ESCAPE, '').split(/\r\n|\r|\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i].replace(CONTROL, '').trim()
    if (text !== '') return text.slice(0, LAST_LINE_MAX)
  }
  return null
}

/** a copy of a view, so the windows and the flow never share an object */
function snapshot(v: AccountFlowView): AccountFlowView {
  return {
    ...v,
    who: { ...v.who },
    sameAs: v.sameAs === null ? null : { ...v.sameAs },
    lines: v.lines.map((l) => ({ ...l, subs: [...l.subs] }))
  }
}

/** an error's code when it has one (a file system error), else its message */
function errorText(e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code
  if (typeof code === 'string') return code
  return e instanceof Error ? e.message : String(e)
}

/**
 * The add flow of an extra account: a name and ticks become a folder and a background sign-in tab; when the tab ends,
 * `auth status` decides whether the account is saved, and the ticked items are carried over into it.
 */
export class AccountFlow {
  private flow: Flow | null = null
  /** a flow is being planned: its folder may be made before it is shown */
  private starting = false
  private picked: Picked | null = null

  constructor(private readonly d: AccountFlowDeps) {}

  view(): AccountFlowView | null {
    return this.flow ? snapshot(this.flow.view) : null
  }

  async begin(req: AccountBegin): Promise<AccountResult> {
    if (this.starting || (this.flow !== null && this.flow.view.step !== 'done')) return { ok: false, error: BUSY }
    this.starting = true
    try {
      const planned = await this.plan(req)
      if (!planned.ok) return planned
      return await this.launch(planned.start)
    } finally {
      this.starting = false
    }
  }

  /** the folder main's dialog returned: checked, and kept for `begin({ adopt: true })` */
  async pick(path: string): Promise<PickedFolder> {
    if (!(await this.d.isDir(path))) return { ok: false, error: 'Not a folder' }
    const error = await this.folderError(path)
    if (error !== null) return { ok: false, error }
    const status = await this.d.status(path)
    const identity = mergeIdentity(status.state === 'signed-in' ? status.identity : NO_IDENTITY, await this.d.identity(path))
    const signedIn = status.state === 'signed-in'
    this.picked = { path, signedIn, identity }
    return { ok: true, path, signedIn, email: identity.email, plan: identity.plan }
  }

  async action(a: FlowAction): Promise<void> {
    const f = this.flow
    if (!f || f.busy) return
    const step = f.view.step
    switch (a.kind) {
      case 'cancel':
      case 'close':
        return step === 'done' ? this.forget() : this.abandon(f)
      case 'show-tab':
        if (f.tabId !== null) this.d.showTab(f.tabId)
        return
      case 'retry-sign-in':
        if (step !== 'failed') return
        this.closeSignInTab(f)
        return this.startTab(f)
      case 'another-login': {
        if (step !== 'same-login') return
        f.busy = true
        try {
          await this.d.logout(f.view.folder)
        } finally {
          f.busy = false
        }
        if (this.flow !== f) return
        f.identity = NO_IDENTITY
        f.signedIn = false
        f.view.who = { email: null, plan: null }
        return this.startTab(f)
      }
      case 'keep-login':
        if (step !== 'same-login') return
        return this.finish(f)
      case 'open-tab':
        if (step !== 'done') return
        // the tab starts once the carry-over is in place: its servers, plugins and tools, and the trusted folders
        if (f.view.lines.some((l) => l.state === 'running')) return
        this.forget()
        this.d.openClaudeTab(f.view.id)
        return
      case 'retry-item': {
        if (step !== 'done') return
        const line = f.view.lines.find((l) => l.item === a.item)
        if (!line || (line.state !== 'failed' && line.state !== 'skipped')) return
        this.setLine(f, a.item, { item: a.item, state: 'running', text: CARRY_LABELS[a.item], subs: [] })
        this.show(f)
        return this.runLine(f, a.item)
      }
    }
  }

  /** tab output: keeps the last non-empty line of the sign-in tab, for the failure that shows it */
  tabOutput(tabId: string, data: string): void {
    const f = this.flow
    if (!f || f.tabId !== tabId) return
    const line = lastLine(data)
    if (line !== null) f.view.lastLine = line
  }

  /** the sign-in tab's process ended, or the person closed it: `auth status` decides */
  async tabEnded(tabId: string): Promise<void> {
    const f = this.flow
    if (!f || f.view.step !== 'sign-in' || f.tabId !== tabId) return
    f.view.step = 'confirming'
    this.show(f)
    const status = await this.d.status(f.view.folder)
    if (this.flow !== f) return
    if (status.state === 'unknown') return this.fail(f, 'Could not confirm the sign-in')
    if (status.state === 'signed-out') return this.fail(f, 'The sign-in did not finish')

    const identity = mergeIdentity(status.identity, await this.d.identity(f.view.folder))
    if (this.flow !== f) return
    this.d.closeTab(tabId)
    f.tabId = null
    f.signedIn = true
    f.identity = identity
    f.view.who = { email: identity.email, plan: identity.plan }
    const same = (await this.d.others(f.view.id)).find((o) => sameLogin(identity, o.identity))
    if (this.flow !== f) return
    if (same !== undefined && same.identity.email !== null) {
      f.view.step = 'same-login'
      f.view.sameAs = { account: same.label, email: same.identity.email }
      this.show(f)
      return
    }
    return this.finish(f)
  }

  /** main is quitting: a flow still waiting is undone (its tab closed, its folder removed); a finished one stays */
  async quit(): Promise<void> {
    const f = this.flow
    if (!f) return
    if (f.view.step === 'done') {
      this.flow = null
      return
    }
    await this.abandon(f)
  }

  /** plans a begin: checks the request and makes the folder a new account needs */
  private async plan(req: AccountBegin): Promise<Planned> {
    const accounts = this.d.store.list()
    const entry = req.id === null ? null : (accounts.find((a) => a.id === req.id) ?? null)
    // a carry copies from Main account (null) or a sign-in account other than the target
    if (req.source !== null && (req.source === req.id || !accounts.some((a) => a.id === req.source && a.kind === 'login'))) {
      return { ok: false, error: NO_SOURCE }
    }

    if (req.mode === 'sign-in-again' || req.mode === 'carry') {
      if (entry === null || entry.kind !== 'login' || entry.folder === null) return { ok: false, error: NO_ACCOUNT }
      const folder = entry.folder
      if (!(await this.d.isDir(folder))) return { ok: false, error: `Its folder is gone: ${folder}` }
      let email: string | null = null
      if (req.mode === 'sign-in-again') {
        const checked = checkEmail(req.email ?? '')
        if (!checked.ok) return checked
        email = checked.value
      }
      return { ok: true, start: { mode: req.mode, id: entry.id, name: entry.name, email, folder, created: false, source: req.source, items: req.items, signedIn: null } }
    }

    if (req.mode === 'to-login' && (entry === null || entry.kind !== 'token')) return { ok: false, error: NO_ACCOUNT }
    const others = accounts.filter((a) => entry === null || a.id !== entry.id)
    const name = checkAccountName(req.name ?? entry?.name ?? null, others.map((a) => a.name))
    if (!name.ok) return name
    const email = checkEmail(req.email ?? '')
    if (!email.ok) return email

    if (req.mode === 'add' && req.adopt) {
      const picked = this.picked
      if (picked === null) return { ok: false, error: 'Pick the folder first' }
      const error = await this.folderError(picked.path)
      if (error !== null) return { ok: false, error }
      this.picked = null
      return {
        ok: true,
        start: {
          mode: 'add',
          id: this.d.newId(),
          name: name.value,
          email: email.value,
          folder: picked.path,
          created: false,
          source: req.source,
          items: req.items,
          signedIn: picked.signedIn ? picked.identity : null
        }
      }
    }

    const made = await this.freshFolder(name.value)
    if (!made.ok) return made
    const id = req.mode === 'to-login' && entry !== null ? entry.id : this.d.newId()
    return {
      ok: true,
      start: { mode: req.mode, id, name: name.value, email: email.value, folder: made.folder, created: true, source: req.source, items: req.items, signedIn: null }
    }
  }

  /**
   * why a folder cannot be an account's now; null when it can. A folder equal to, inside or holding Main account's or
   * another account's folder is refused: sign-in, carry-over and sign-out would write into their files. Main account's
   * `.claude.json` sits beside its folder (the home folder for the default ~/.claude), so the home folder holds it too.
   */
  private async folderError(path: string): Promise<string | null> {
    const real = await this.d.canonical(path)
    if (this.d.mainFolder !== null) {
      const main = await this.d.canonical(this.d.mainFolder)
      if (pathKey(main) === pathKey(real)) return "This is Main account's folder"
      if (clashes(real, [main])) return "This folder is part of Main account's setup"
    }
    for (const a of this.d.store.list()) {
      if (a.folder === null) continue
      const folder = await this.d.canonical(a.folder)
      if (pathKey(folder) === pathKey(real)) return `This folder is already the account "${a.name}"`
      if (clashes(real, [folder])) return `This folder is part of the account "${a.name}"`
    }
    return null
  }

  /** the folder a new account gets under the root: its name's slug, with -2, -3… when taken; made here */
  private async freshFolder(name: string): Promise<{ ok: true; folder: string } | { ok: false; error: string }> {
    const accounts = this.d.store.list()
    const busy = new Set<string>()
    let folder: string
    for (;;) {
      folder = accountFolder(this.d.root(), name, (p) => busy.has(pathKey(p)))
      const taken = accounts.some((a) => a.folder !== null && pathKey(a.folder) === pathKey(folder))
      if (!taken && !(await this.d.isDir(folder))) break
      busy.add(pathKey(folder))
    }
    const real = await this.d.canonical(folder)
    const owned = [this.d.mainFolder, ...accounts.map((a) => a.folder)].filter((f): f is string => f !== null)
    if (clashes(real, await Promise.all(owned.map((f) => this.d.canonical(f))))) {
      return { ok: false, error: `ClaudeTerm cannot make a folder for the account inside another account's folder: ${folder}` }
    }
    try {
      await this.d.mkdir(folder)
    } catch (e) {
      return { ok: false, error: `Cannot make the folder ${folder}: ${(e as Error).message}` }
    }
    return { ok: true, folder }
  }

  /** shows a planned flow: a carry-over or an adopted, signed-in folder is finished at once; else its sign-in tab opens */
  private async launch(s: Start): Promise<AccountResult> {
    const f: Flow = {
      view: {
        mode: s.mode,
        id: s.id,
        name: s.name,
        step: 'sign-in',
        error: null,
        lastLine: null,
        sameAs: null,
        who: { email: null, plan: null },
        folder: s.folder,
        lines: []
      },
      email: s.email,
      created: s.created,
      source: s.source,
      items: s.items,
      tabId: null,
      identity: NO_IDENTITY,
      signedIn: false,
      busy: false
    }
    if (s.mode === 'carry' || s.signedIn !== null) {
      f.identity = s.signedIn ?? (await this.d.identity(s.folder))
      f.view.who = { email: f.identity.email, plan: f.identity.plan }
      this.flow = f
      // begin does not wait for the items: they run in the background and the flow forgets them when it is closed
      if (await this.complete(f)) void this.run(f)
      return { ok: true }
    }
    const tab = this.d.openSignInTab(s.name, s.folder, s.email)
    if (tab === null) {
      if (s.created) await this.removeQuietly(s.folder)
      return { ok: false, error: 'Cannot open the sign-in tab' }
    }
    f.tabId = tab
    this.flow = f
    this.show(f)
    return { ok: true }
  }

  /** opens a new sign-in tab for the flow, or shows the failure when it cannot be opened */
  private startTab(f: Flow): void {
    const tab = this.d.openSignInTab(f.view.name, f.view.folder, f.email)
    f.view.step = 'sign-in'
    f.view.error = null
    f.view.lastLine = null
    f.view.sameAs = null
    if (tab === null) {
      f.view.step = 'failed'
      f.view.error = 'Cannot open the sign-in tab'
    } else {
      f.tabId = tab
    }
    this.show(f)
  }

  private closeSignInTab(f: Flow): void {
    if (f.tabId !== null) this.d.closeTab(f.tabId)
    f.tabId = null
  }

  private fail(f: Flow, error: string): void {
    f.view.step = 'failed'
    f.view.error = error
    this.show(f)
  }

  /** a sign-in ended with the account signed in: saved and shown as done, then the carry-over runs */
  private async finish(f: Flow): Promise<void> {
    if (await this.complete(f)) await this.run(f)
  }

  /**
   * Saves the account where the flow saves one (add, to-login), tells the account list and the checks, and shows the
   * flow as done with its lines running. Returns false when the save failed (the flow then shows that failure).
   */
  private async complete(f: Flow): Promise<boolean> {
    const v = f.view
    const saves = v.mode === 'add' || v.mode === 'to-login'
    if (saves) {
      const saved =
        v.mode === 'add'
          ? this.d.store.addLogin({ id: v.id, name: v.name, folder: v.folder, created: f.created })
          : this.d.store.toLogin(v.id, v.name, v.folder, f.created)
      if (!saved.ok) {
        this.fail(f, saved.error)
        return false
      }
    }
    if (v.mode !== 'carry') {
      this.d.accountsChanged()
      this.d.confirmed(v.id, f.identity)
    }
    if (saves && !this.d.settingsOpen()) this.d.toast(this.readyText(f))

    const ticked = CARRY_ITEMS.filter((item) => f.items.includes(item))
    v.step = 'done'
    v.lines = [...ticked, 'claudeterm' as const].map((item): CarryLine => ({ item, state: 'running', text: CARRY_LABELS[item], subs: [] }))
    this.show(f)
    return true
  }

  /** the carry-over's items, one after another in RUN_ORDER */
  private async run(f: Flow): Promise<void> {
    for (const item of RUN_ORDER) {
      if (f.view.lines.some((l) => l.item === item)) await this.runLine(f, item)
    }
  }

  /** one line of the carry-over: the item's result replaces its line; a failure is that line's, the others go on */
  private async runLine(f: Flow, item: CarryLineItem): Promise<void> {
    const v = f.view
    let line: CarryLine
    if (item === 'trust' && v.mode === 'carry' && this.d.tabsOn(v.id) > 0) {
      line = { item, state: 'skipped', text: `Close the tabs on ${v.name} to carry over trusted folders`, subs: [] }
    } else {
      try {
        line = item === 'claudeterm' ? await this.d.register(v.folder) : await this.d.carry(item, { id: v.id, name: v.name, folder: v.folder }, f.source)
      } catch (e) {
        line = { item, state: 'failed', text: e instanceof Error ? e.message : String(e), subs: [] }
      }
    }
    if (this.flow !== f) return
    this.setLine(f, item, line)
    this.show(f)
  }

  private setLine(f: Flow, item: CarryLineItem, line: CarryLine): void {
    f.view.lines = f.view.lines.map((l) => (l.item === item ? line : l))
  }

  private readyText(f: Flow): string {
    const email = f.identity.email
    return email === null ? `Account "${f.view.name}" is ready` : `Account "${f.view.name}" is ready: signed in as ${email}`
  }

  /** a flow that is not finished: its tab closed, the folder it made removed, nothing saved */
  private async abandon(f: Flow): Promise<void> {
    this.flow = null
    this.closeSignInTab(f)
    // a folder that is signed in is signed out before it goes: on macOS the login is in the Keychain, not in the folder
    if (f.created && f.signedIn) await this.signOutQuietly(f.view.folder)
    if (f.created) await this.removeQuietly(f.view.folder)
    this.d.publish(null)
  }

  /** `claude auth logout` in a folder that is going: a failure is logged and the cancel goes on */
  private async signOutQuietly(folder: string): Promise<void> {
    try {
      if (!(await this.d.logout(folder))) this.d.log(`Could not sign out of ${folder}`)
    } catch (e) {
      this.d.log(`Could not sign out of ${folder}: ${errorText(e)}`)
    }
  }

  private async removeQuietly(folder: string): Promise<void> {
    try {
      await this.d.removeCreated(folder)
    } catch (e) {
      this.d.log(`Could not remove the folder ${folder}: ${errorText(e)}`)
    }
  }

  private forget(): void {
    this.flow = null
    this.d.publish(null)
  }

  private show(f: Flow): void {
    this.d.publish(snapshot(f.view))
  }
}
