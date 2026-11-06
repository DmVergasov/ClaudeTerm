/** Claude Code's terminal title without the mark it puts before it (✳ idle, ◐ ◑ working): the tab's icon shows that */
export function claudeTitle(title: string): string {
  return title.replace(/^[✳◐◑] (?=\S)/, '')
}

export function folderName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}

/** xterm's ConPTY handling, for Windows only */
export function windowsPtyOption(build: number | null): { windowsPty?: { backend: 'conpty'; buildNumber: number } } {
  return build === null ? {} : { windowsPty: { backend: 'conpty', buildNumber: build } }
}
