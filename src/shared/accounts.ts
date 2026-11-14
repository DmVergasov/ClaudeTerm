/** The user's normal Claude Code login: Claude tabs run on it unless they are given an extra account. */
export const MAIN_ACCOUNT = 'Main account'

/** an account's name is at most this long, and has no control characters */
export const MAX_ACCOUNT_NAME = 40
const NAME_CONTROL = /[\u0000-\u001f\u007f]/

/** the name rule of an account, shared by main and the helper: the message of the first rule the name breaks, null when it is fine */
export function accountNameError(raw: string, taken: readonly string[]): string | null {
  const name = raw.trim()
  if (name.length === 0) return 'Enter a name'
  if (name.length > MAX_ACCOUNT_NAME) return `A name is at most ${MAX_ACCOUNT_NAME} characters`
  if (NAME_CONTROL.test(name)) return 'A name cannot hold control characters'
  const key = name.toLowerCase()
  if (key === MAIN_ACCOUNT.toLowerCase()) return `"${MAIN_ACCOUNT}" is your normal Claude Code login; choose another name`
  if (taken.some((t) => t.toLowerCase() === key)) return `An account named "${name}" already exists`
  return null
}

export type AccountKind = 'login' | 'token'
/** a sign-in account's state as its last check found it */
export type AccountState = 'ready' | 'signed-out' | 'missing' | 'unknown'

/** An extra account as the windows see it; its token never leaves the main process. */
export interface AccountView {
  id: string
  name: string
  /** ISO date the token was saved: a token from `claude setup-token` lasts a year */
  addedAt: string
  /** a sign-in account, or a token account */
  kind: AccountKind
  /** a tab can start on it: a sign-in account that is ready or unknown, a token that can be read here */
  readable: boolean
  /** sign-in accounts; null for a token account */
  state: AccountState | null
  /** a sign-in account whose first check of this run has not answered */
  checking: boolean
  /** sign-in accounts only */
  email: string | null
  plan: string | null
  folder: string | null
}

/** Main account as the windows see it: who is signed in there, read without its token */
export interface MainAccountView {
  email: string | null
  plan: string | null
  folder: string | null
}

export interface AccountsView {
  accounts: AccountView[]
  /** whether the system keyring encrypts the tokens; false on Linux without one */
  keyring: boolean
  main: MainAccountView
}

export type AccountResult = { ok: true } | { ok: false; error: string }

/** the items a new sign-in account can carry over from another account, in the order the picker lists them */
export const CARRY_ITEMS = ['settings', 'hooks', 'mcp', 'plugins', 'skills', 'agents', 'commands', 'memory', 'trust', 'keybindings', 'output-styles'] as const
export type CarryItem = (typeof CARRY_ITEMS)[number]
/** a line of the carry progress: a carried item, or ClaudeTerm's own tools */
export type CarryLineItem = CarryItem | 'claudeterm'

export const CARRY_LABELS: Record<CarryLineItem, string> = {
  settings: 'Settings',
  hooks: 'Hooks',
  mcp: 'MCP servers',
  plugins: 'Plugins',
  skills: 'Skills',
  agents: 'Agents',
  commands: 'Commands',
  memory: 'Memory',
  trust: 'Trusted folders',
  keybindings: 'Keybindings',
  'output-styles': 'Output styles',
  claudeterm: "ClaudeTerm's tools"
}

/** how many of one item a source account has, with the names to show (mcp: the first three) */
export interface CarryCount {
  item: CarryItem
  count: number
  names: string[]
  /** plugins: the marketplaces they come from */
  marketplaces: number
}

/** what a carry would copy from a source account into a target folder */
export interface CarryPreview {
  source: string | null
  sourceName: string
  sourceEmail: string | null
  sourceFolder: string | null
  items: CarryCount[]
  /** open Claude tabs on the target account */
  targetTabs: number
}

/** how an account is added: a new one, signing in again to one, signing in to a folder already there, or carrying items over */
export type FlowMode = 'add' | 'sign-in-again' | 'to-login' | 'carry'
export const FLOW_MODES: readonly FlowMode[] = ['add', 'sign-in-again', 'to-login', 'carry']

/** a request to start the flow; `id` is the account it is about (null for a new one) */
export interface AccountBegin {
  mode: FlowMode
  id: string | null
  name: string | null
  email: string | null
  /** the account the items are carried from: an account id, or null for Main account */
  source: string | null
  items: CarryItem[]
  /** adopt: the folder the user picked is kept as it is, not made by ClaudeTerm */
  adopt: boolean
}

export type FlowStep = 'sign-in' | 'confirming' | 'failed' | 'same-login' | 'done'
export type LineState = 'running' | 'done' | 'skipped' | 'failed'

export interface CarryLine {
  item: CarryLineItem
  state: LineState
  text: string
  subs: string[]
}

export interface AccountFlowView {
  mode: FlowMode
  id: string
  name: string
  step: FlowStep
  /** failed: the title, and the sign-in tab's last line */
  error: string | null
  lastLine: string | null
  /** same-login: the account that already signs in with this login */
  sameAs: { account: string; email: string } | null
  who: { email: string | null; plan: string | null }
  folder: string
  lines: CarryLine[]
}

export type FlowAction =
  | { kind: 'cancel' | 'show-tab' | 'retry-sign-in' | 'another-login' | 'keep-login' | 'open-tab' | 'close' }
  | { kind: 'retry-item'; item: CarryLineItem }

/** a folder picked for an account: its sign-in state, read from the folder; `error` when it cannot be used */
export type PickedFolder = { ok: true; path: string; signedIn: boolean; email: string | null; plan: string | null } | { ok: false; error: string }

export interface RemoveOptions {
  /** sign the account out (its folder keeps the login otherwise) */
  signOut: boolean
  /** move the folder to the trash, when ClaudeTerm made it */
  deleteFolder: boolean
}

/** what removing an account would touch, for the confirmation */
export interface RemoveInfo {
  kind: AccountKind
  folder: string | null
  created: boolean
  conversations: number
  tabs: number
}

export type RemoveResult = { ok: true; problems: string[] } | { ok: false; error: string }
