import { MAIN_ACCOUNT, type AccountKind, type AccountState, type AccountView } from '../shared/accounts'

/** a tab on an account deleted while it ran */
export const REMOVED_ACCOUNT = 'Removed account'

export interface AccountChoice {
  label: string
  account: string | null
  /** its token cannot be read here, or its folder is gone: starting on it would fail */
  disabled: boolean
  /** a sign-in account that is not signed in: choosing it opens the sign-in */
  signInAgain: boolean
}

export function accountLabel(id: string | null, accounts: readonly AccountView[]): string {
  if (id === null) return MAIN_ACCOUNT
  return accounts.find((a) => a.id === id)?.name ?? REMOVED_ACCOUNT
}

const MAIN_CHOICE: AccountChoice = { label: MAIN_ACCOUNT, account: null, disabled: false, signInAgain: false }
const SIGN_IN_AGAIN = ' (sign in again)'

/** what a choice needs of an account: its id, its name, and whether its token can be read here (a device's accounts are readable) */
export interface ChoiceAccount {
  id: string
  name: string
  readable: boolean
  kind?: AccountKind
  state?: AccountState | null
}

function isSignedOut(a: ChoiceAccount): boolean {
  return a.kind !== 'token' && a.state === 'signed-out'
}

/** every account, the main one first; none until an extra account is added */
export function accountChoices(accounts: readonly ChoiceAccount[]): AccountChoice[] {
  if (accounts.length === 0) return []
  return [MAIN_CHOICE, ...accounts.map(choiceOf)]
}

function choiceOf(a: ChoiceAccount): AccountChoice {
  if (a.kind === 'token') return { label: `${a.name} · token`, account: a.id, disabled: !a.readable, signInAgain: false }
  if (isSignedOut(a)) return { label: a.name + SIGN_IN_AGAIN, account: a.id, disabled: false, signInAgain: true }
  return { label: a.name, account: a.id, disabled: !a.readable || a.state === 'missing', signInAgain: false }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** a token from claude setup-token lasts a year: "14 Oct 2027", a month name so it reads the same everywhere */
export function validUntil(addedAt: string): string {
  const d = new Date(addedAt)
  if (Number.isNaN(d.getTime())) return 'unknown'
  d.setFullYear(d.getFullYear() + 1)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** a tab on `current` can continue on every other account; a tab on an account deleted with no extra one left can still go back to the main one */
export function switchChoices(current: string | null, accounts: readonly ChoiceAccount[]): AccountChoice[] {
  const choices = accounts.length === 0 ? (current !== null ? [MAIN_CHOICE] : []) : [MAIN_CHOICE, ...accounts.map(switchChoiceOf)]
  return choices.filter((c) => c.account !== current)
}

function switchChoiceOf(a: ChoiceAccount): AccountChoice {
  const signedOut = isSignedOut(a)
  return { label: signedOut ? a.name + SIGN_IN_AGAIN : a.name, account: a.id, disabled: signedOut || !a.readable || a.state === 'missing', signInAgain: false }
}

/** the menu items that sign a signed-out account in again */
export function signInAgainChoices(accounts: readonly ChoiceAccount[]): { label: string; account: string }[] {
  return accounts.filter(isSignedOut).map((a) => ({ label: `Sign in to ${a.name} again…`, account: a.id }))
}

/** the line under an account's name: its plan, else the Claude Code login; a token is a token account */
export function footDetail(a: AccountView | undefined): string {
  if (a?.kind === 'token') return 'Token account'
  return a?.plan || 'Claude Code login'
}
