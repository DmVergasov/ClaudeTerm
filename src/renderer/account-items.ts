import { MAIN_ACCOUNT, type AccountView } from '../shared/accounts'

/** a tab on an account deleted while it ran */
export const REMOVED_ACCOUNT = 'Removed account'

export interface AccountChoice {
  label: string
  account: string | null
  /** its token cannot be read here: starting on it would fail */
  disabled: boolean
}

export function accountLabel(id: string | null, accounts: readonly AccountView[]): string {
  if (id === null) return MAIN_ACCOUNT
  return accounts.find((a) => a.id === id)?.name ?? REMOVED_ACCOUNT
}

const MAIN_CHOICE: AccountChoice = { label: MAIN_ACCOUNT, account: null, disabled: false }

/** what a choice needs of an account: its id, its name, and whether its token can be read here (a device's accounts are readable) */
export interface ChoiceAccount {
  id: string
  name: string
  readable: boolean
}

/** every account, the main one first; none until an extra account is added */
export function accountChoices(accounts: readonly ChoiceAccount[]): AccountChoice[] {
  if (accounts.length === 0) return []
  return [MAIN_CHOICE, ...accounts.map((a) => ({ label: a.name, account: a.id, disabled: !a.readable }))]
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** a token from claude setup-token lasts a year: "14 Oct 2027", a month name so it reads the same everywhere */
export function validUntil(addedAt: string): string {
  const d = new Date(addedAt)
  if (Number.isNaN(d.getTime())) return 'unknown'
  d.setFullYear(d.getFullYear() + 1)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** the accounts a tab on `current` can continue on; a tab on an account deleted with no extra one left can still go back to the main one */
export function switchChoices(current: string | null, accounts: readonly ChoiceAccount[]): AccountChoice[] {
  const choices = current !== null && accounts.length === 0 ? [MAIN_CHOICE] : accountChoices(accounts)
  return choices.filter((c) => c.account !== current)
}
