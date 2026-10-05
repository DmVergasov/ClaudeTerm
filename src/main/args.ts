export type LaunchCommand =
  | { kind: 'default' }
  | { kind: 'claude'; dir: string }
  | { kind: 'shell'; dir: string; profile: string | null }

export function normalizeDirArg(raw: string): string {
  // Explorer passes "%V"; for a drive root that is "D:\" which Windows argv parsing turns into D:"
  let s = raw.trim().replace(/"+$/, '')
  if (/^[A-Za-z]:$/.test(s)) s += '\\'
  return s
}

export function parseArgs(argv: readonly string[]): LaunchCommand {
  const valueAfter = (flag: string): string | null => {
    const i = argv.indexOf(flag)
    if (i < 0) return null
    const v = argv[i + 1]
    return v !== undefined && !v.startsWith('--') ? v : null
  }
  const claudeDir = valueAfter('--claude')
  if (claudeDir !== null) return { kind: 'claude', dir: normalizeDirArg(claudeDir) }
  const shellDir = valueAfter('--shell')
  if (shellDir !== null) return { kind: 'shell', dir: normalizeDirArg(shellDir), profile: valueAfter('--profile') }
  return { kind: 'default' }
}

export function resolveLaunchDir(dir: string, home: string, isDir: (p: string) => boolean): { cwd: string; warning: string | null } {
  if (dir && isDir(dir)) return { cwd: dir, warning: null }
  return { cwd: home, warning: `Folder not found: ${dir} — opened in ${home}` }
}
