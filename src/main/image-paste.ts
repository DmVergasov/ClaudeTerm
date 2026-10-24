import { execFile } from 'node:child_process'

export interface CommandSpec {
  file: string
  args: string[]
}

/**
 * What Claude Code's image-paste key needs on Windows to read a clipboard image itself: Windows PowerShell loading
 * System.Windows.Forms. Constrained Language mode, where an AppLocker or WDAC policy puts PowerShell, refuses Add-Type,
 * and the paste then does nothing.
 */
export const CLAUDE_CLIPBOARD_CHECK: CommandSpec = {
  file: 'powershell.exe',
  args: ['-NoProfile', '-NonInteractive', '-Command', 'Add-Type -AssemblyName System.Windows.Forms']
}

/** Whether the command exits 0 within the time limit; one that cannot start, fails or hangs answers false */
export function runsCleanly(c: CommandSpec, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(c.file, c.args, { windowsHide: true, timeout: timeoutMs }, (e) => resolve(e === null))
  })
}

/** Runs the check at the first call only and answers every call with its result */
export function checkOnce(check: () => Promise<boolean>): () => Promise<boolean> {
  let result: Promise<boolean> | null = null
  return () => (result ??= check())
}
