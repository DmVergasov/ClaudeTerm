/** the email of an account or a coordinator, compared trimmed and without case */
function emailKey(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * the account a tab opened for a coordinator runs on: Main account (null) when its email is this one, else the first readable
 * extra account with it, else Main account; emails compared trimmed and without case
 */
export function accountForEmail(email: string, view: { main: { email: string | null }; accounts: { id: string; email: string | null; readable: boolean }[] }): string | null {
  const key = emailKey(email)
  if (view.main.email !== null && emailKey(view.main.email) === key) return null
  const extra = view.accounts.find((a) => a.readable && a.email !== null && emailKey(a.email) === key)
  return extra?.id ?? null
}
