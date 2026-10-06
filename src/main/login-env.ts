import { accessSync, constants, statSync } from 'node:fs'
import { posix } from 'node:path'
import type { Runner } from './mcp-registrar'

const MARK = '__CLAUDETERM_PATH__'
const LOOKUP_MS = 10_000

/** The PATH between the markers; whatever the shell's startup files print around it is ignored. */
export function parseMarkedPath(stdout: string): string | null {
  const m = new RegExp(`${MARK}(.*?)${MARK}`, 's').exec(stdout)
  return m && m[1].length > 0 ? m[1] : null
}

/**
 * The PATH a terminal would have. An app started from the desktop does not read ~/.bashrc or ~/.zshrc, where
 * installers (nvm, the Claude Code installer) put their folders, so ask the login shell. fish reads its config
 * without -i, and refuses -i together with -c in some versions.
 */
export async function loginShellPath(run: Runner, shell: string): Promise<string | null> {
  const fish = posix.basename(shell) === 'fish'
  const r = await run(shell, [...(fish ? ['-l'] : ['-l', '-i']), '-c', `printf '%s%s%s' ${MARK} "$PATH" ${MARK}`], { timeoutMs: LOOKUP_MS, detached: true })
  return parseMarkedPath(r.stdout)
}

/** The first executable called `name` in the folders of a PATH value. */
export function findExecutable(name: string, pathVar: string, isExecutable: (p: string) => boolean): string | null {
  for (const dir of pathVar.split(':')) {
    if (!dir || !posix.isAbsolute(dir)) continue
    const p = posix.join(dir, name)
    if (isExecutable(p)) return p
  }
  return null
}

export function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return statSync(p).isFile()
  } catch {
    return false
  }
}
