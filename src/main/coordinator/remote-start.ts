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

/**
 * where a session opened on another device: `asked` is the folder sent (the one asked for, or that of a project's tab when fromTab),
 * and the device says when it opened in its default folder instead
 */
export function remoteFolderText(o: { cwd: string; asked: string | null; fromTab: boolean; defaulted: boolean; project: string }): string {
  if (o.defaulted) return `in ${o.cwd}, its default folder (${o.asked} is not a folder there)`
  if (o.fromTab) return `in ${o.cwd}, the folder of its ${o.project} tab`
  if (o.asked !== null) return `in ${o.cwd}`
  return `in ${o.cwd}, its default folder (no ${o.project} tab is open there)`
}
