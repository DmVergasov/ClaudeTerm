import { win32 } from 'node:path'

export interface ProcessSpec {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
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
