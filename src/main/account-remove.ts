import type { AccountResult, RemoveOptions, RemoveResult } from '../shared/accounts'
import { clashes } from './account-login'
import type { AccountEntry } from './accounts'

/** what removing an account touches: the store, the tabs, Claude Code's sign-out and the system trash */
export interface RemoveDeps {
  entry(id: string): AccountEntry | null
  tabsOn(id: string): number
  /** whether the folder has carry-over or registration jobs queued or running */
  busy(folder: string): boolean
  /** `claude auth logout` in the folder; resolves to its error, or null */
  logout(folder: string): Promise<string | null>
  remove(id: string): AccountResult
  changed(): void
  /** moves a folder to the system trash (deleted under CLAUDETERM_TEST=1) */
  trash(folder: string): Promise<void>
  /** Main account's and the other sign-in accounts' folders, as real paths */
  others(id: string): Promise<string[]>
  /** the real path of a folder, for a path that may not exist yet */
  canonical(path: string): Promise<string>
}

/**
 * Removes an account. A sign-in account is signed out and its folder moved to the trash only when the options ask for
 * it, ClaudeTerm made the folder, no tab runs on the account and no other account's folder is inside or holds it.
 * The account is removed whatever the sign-out or the move does; their failures come back as `problems`.
 */
export async function removeAccount(id: string, o: RemoveOptions, d: RemoveDeps): Promise<RemoveResult> {
  const entry = d.entry(id)
  if (!entry) return { ok: false, error: 'No such account' }
  if (entry.kind === 'token') {
    const removed = d.remove(id)
    if (!removed.ok) return removed
    d.changed()
    return { ok: true, problems: [] }
  }

  const folder = entry.folder
  // a carry-over or a registration still runs in the folder: it would write the folder back after the removal
  if (folder !== null && d.busy(folder)) return { ok: false, error: `Finish or cancel what runs for ${entry.name} first` }

  const tabs = d.tabsOn(id)
  if ((o.signOut || o.deleteFolder) && tabs > 0) {
    return { ok: false, error: `Close the ${tabs} ${tabs === 1 ? 'tab' : 'tabs'} on ${entry.name} to remove its folder too` }
  }


  const problems: string[] = []
  const trash = folder !== null && o.deleteFolder && entry.created && !clashes(await d.canonical(folder), await d.others(id))

  if (folder !== null && o.signOut) {
    const error = await d.logout(folder)
    if (error !== null) problems.push(`Could not sign out: ${error}`)
  }
  const removed = d.remove(id)
  if (!removed.ok) return removed
  d.changed()
  if (folder !== null && trash) {
    try {
      await d.trash(folder)
    } catch (e) {
      problems.push(`Could not move the folder to the trash: ${(e as Error).message}`)
    }
  }
  return { ok: true, problems }
}
