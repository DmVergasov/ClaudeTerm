/** Claude Code's terminal title without the mark it puts before it (✳ idle, ◐ ◑ working): the tab's icon shows that */
export function claudeTitle(title: string): string {
  return title.replace(/^[✳◐◑] (?=\S)/, '')
}

/** a time of day as HH:MM on the local clock, the same in every locale */
export function clockOf(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** a session's name without its device: the part before the last ' · ', else the name */
export function labelOf(name: string): string {
  const at = name.lastIndexOf(' · ')
  return at >= 0 ? name.slice(0, at) : name
}

export function folderName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}

/** xterm's ConPTY handling, for Windows only */
export function windowsPtyOption(build: number | null): { windowsPty?: { backend: 'conpty'; buildNumber: number } } {
  return build === null ? {} : { windowsPty: { backend: 'conpty', buildNumber: build } }
}
