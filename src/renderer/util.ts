export function folderName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}

/** xterm's ConPTY handling, for Windows only */
export function windowsPtyOption(build: number | null): { windowsPty?: { backend: 'conpty'; buildNumber: number } } {
  return build === null ? {} : { windowsPty: { backend: 'conpty', buildNumber: build } }
}
