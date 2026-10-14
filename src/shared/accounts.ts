/** The user's normal Claude Code login: Claude tabs run on it unless they are given an extra account. */
export const MAIN_ACCOUNT = 'Main account'

/** An extra account as the windows see it; its token never leaves the main process. */
export interface AccountView {
  id: string
  name: string
  /** ISO date the token was saved: a token from `claude setup-token` lasts a year */
  addedAt: string
  /** false: the token cannot be decrypted here (the data folder came from another machine or user) */
  readable: boolean
}

export interface AccountsView {
  accounts: AccountView[]
  /** whether the system keyring encrypts the tokens; false on Linux without one */
  keyring: boolean
}

export type AccountResult = { ok: true } | { ok: false; error: string }
