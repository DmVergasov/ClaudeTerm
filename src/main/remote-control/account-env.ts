import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// The environment Claude Code gives its own process from an account's settings.json (its `env` object). Remote Control's
// rules read it with the launch environment, so a base URL or a sign-in set there counts as set in the tab's environment.

/** the longest a read of settings.json may take; a read that takes longer counts as none */
const READ_MS = 5_000
/** the largest settings.json read: a bigger file is treated as unreadable */
const MAX_BYTES = 1024 * 1024

/** the `env` object of the account's settings.json: string values only (the file is untrusted); {} when the file is missing, not JSON or slow */
export async function settingsEnv(configDir: string): Promise<Record<string, string>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), READ_MS)
  })
  try {
    const text = await Promise.race([readFile(join(configDir, 'settings.json'), 'utf8'), limit])
    if (text === null || text.length > MAX_BYTES) return {}
    const value: unknown = JSON.parse(text)
    const env = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as { env?: unknown }).env : undefined
    if (typeof env !== 'object' || env === null || Array.isArray(env)) return {}
    return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  } finally {
    clearTimeout(timer)
  }
}

/** the environment an account's Claude Code process starts with: its settings.json env under the launch environment, which wins; names match without regard to case, as Windows reads them */
export function accountLaunchEnv(settings: Readonly<Record<string, string>>, launch: Readonly<Record<string, string>>): Record<string, string> {
  const named = new Set(Object.keys(launch).map((name) => name.toUpperCase()))
  const kept = Object.entries(settings).filter(([name]) => !named.has(name.toUpperCase()))
  return { ...Object.fromEntries(kept), ...launch }
}
