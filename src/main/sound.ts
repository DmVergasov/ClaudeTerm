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
  beep(): void
  /** how to play a sound file; null when this machine has no player for it */
  player(path: string): ProcessSpec | null
  /** the file 'system' plays; null: the system beep */
  systemSound: string | null
  spawn(p: ProcessSpec): SoundChild
  /** told once per file that cannot be played */
  warn(message: string): void
}

/** 'system' plays the system sound (or beeps); a file plays in a separate process and falls back to the beep when it cannot. */
export function createSoundPlayer(d: SoundPlayerDeps): (sound: string) => void {
  const warned = new Set<string>()
  const playFile = (file: string, onFail: (reason: string) => void): void => {
    let failed = false
    const fail = (reason: string): void => {
      if (failed) return
      failed = true
      onFail(reason)
    }
    const spec = d.player(file)
    if (!spec) return fail('no sound player found: paplay, pw-play or aplay')
    try {
      const child = d.spawn(spec)
      child.on('error', (e) => fail(e.message))
      child.on('exit', (code) => { if (code !== 0) fail(`exit code ${String(code)}`) })
    } catch (e) {
      fail((e as Error).message)
    }
  }
  return (sound) => {
    if (sound === 'system') {
      if (d.systemSound) playFile(d.systemSound, () => d.beep())
      else d.beep()
      return
    }
    playFile(sound, (reason) => {
      d.beep()
      if (warned.has(sound)) return
      warned.add(sound)
      d.warn(`Cannot play the attention sound ${sound} (${reason}); using the system sound`)
    })
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

/** The "message" sound of the freedesktop sound theme, installed with most Linux desktops */
export const FREEDESKTOP_SOUND = '/usr/share/sounds/freedesktop/stereo/message-new-instant.oga'
const LINUX_PLAYERS = ['paplay', 'pw-play', 'aplay']

/** paplay (PulseAudio and PipeWire), pw-play, or aplay, which plays .wav only. The path is an argument, never shell text. */
export function linuxPlayer(file: string, has: (cmd: string) => boolean, env: NodeJS.ProcessEnv): ProcessSpec | null {
  const wav = /\.wav$/i.test(file)
  const cmd = LINUX_PLAYERS.find((c) => (c !== 'aplay' || wav) && has(c))
  return cmd ? { file: cmd, args: [file], env } : null
}

export function linuxSoundDeps(env: NodeJS.ProcessEnv, has: (cmd: string) => boolean, exists: (path: string) => boolean): Pick<SoundPlayerDeps, 'player' | 'systemSound'> {
  const found = new Map<string, boolean>()
  const cached = (c: string): boolean => {
    if (!found.has(c)) found.set(c, has(c))
    return found.get(c)!
  }
  return { player: (f) => linuxPlayer(f, cached, env), systemSound: exists(FREEDESKTOP_SOUND) ? FREEDESKTOP_SOUND : null }
}
