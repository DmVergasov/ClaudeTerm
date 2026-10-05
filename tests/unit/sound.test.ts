import { describe, expect, it } from 'vitest'
import { wavPlayer } from '../../src/main/sound'

describe('wavPlayer', () => {
  it('plays the file with Windows PowerShell, passing the path through the environment', () => {
    const path = "D:\\My Sounds\\it's $(calc).wav"
    const p = wavPlayer(path, { SystemRoot: 'C:\\Windows', PATH: 'x' })
    expect(p.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(p.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', '(New-Object System.Media.SoundPlayer $env:CLAUDETERM_SOUND).PlaySync()'])
    expect(p.args.join(' ')).not.toContain(path)
    expect(p.env).toEqual({ SystemRoot: 'C:\\Windows', PATH: 'x', CLAUDETERM_SOUND: path })
  })

  it('falls back to powershell.exe from PATH without SystemRoot', () => {
    expect(wavPlayer('D:\\a.wav', {}).file).toBe('powershell.exe')
  })
})
