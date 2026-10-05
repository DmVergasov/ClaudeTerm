import { win32 } from 'node:path'

export interface ProcessSpec {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export interface SoundChild {
  on(event: 'error', cb: (e: Error) => void): unknown
  on(event: 'exit', cb: (code: number | null) => void): unknown
}

export interface SoundPlayerDeps {
  env: NodeJS.ProcessEnv
  beep(): void
  spawn(p: ProcessSpec): SoundChild
  /** told once per file that cannot be played */
  warn(message: string): void
}

/** 'system' beeps; a .wav path plays in a separate process and falls back to the beep when it cannot be played. */
export function createSoundPlayer(d: SoundPlayerDeps): (sound: string) => void {
  const warned = new Set<string>()
  return (sound) => {
    if (sound === 'system') {
      d.beep()
      return
    }
    let failed = false
    const fail = (reason: string): void => {
      if (failed) return
      failed = true
      d.beep()
      if (warned.has(sound)) return
      warned.add(sound)
      d.warn(`Cannot play the attention sound ${sound} (${reason}); using the system sound`)
    }
    try {
      const child = d.spawn(wavPlayer(sound, d.env))
      child.on('error', (e) => fail(e.message))
      child.on('exit', (code) => { if (code !== 0) fail(`exit code ${String(code)}`) })
    } catch (e) {
      fail((e as Error).message)
    }
  }
}

/** Plays a .wav with PowerShell's SoundPlayer; the path goes through the environment, never into the command line. */
export function wavPlayer(path: string, env: NodeJS.ProcessEnv): ProcessSpec {
  const root = env.SystemRoot
  return {
    file: root ? win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', '(New-Object System.Media.SoundPlayer $env:CLAUDETERM_SOUND).PlaySync()'],
    env: { ...env, CLAUDETERM_SOUND: path }
  }
}
