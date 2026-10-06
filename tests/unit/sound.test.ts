import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createSoundPlayer, FREEDESKTOP_SOUND, linuxPlayer, linuxSoundDeps, type ProcessSpec, wavPlayer } from '../../src/main/sound'

function setup(o: { spawnThrows?: boolean; systemSound?: string | null; noPlayer?: boolean } = {}) {
  const calls: string[] = []
  const children: EventEmitter[] = []
  const play = createSoundPlayer({
    beep: () => calls.push('beep'),
    player: (p) => (o.noPlayer ? null : wavPlayer(p, { SystemRoot: 'C:\\Windows' })),
    systemSound: o.systemSound ?? null,
    spawn: (p: ProcessSpec) => {
      if (o.spawnThrows) throw new Error('spawn EPERM')
      calls.push(`spawn:${p.env.CLAUDETERM_SOUND}`)
      const child = new EventEmitter()
      children.push(child)
      return child
    },
    warn: (m) => calls.push(`warn:${m}`)
  })
  return { play, calls, children }
}

describe('createSoundPlayer', () => {
  it('"system" beeps where there is no system sound file', () => {
    const { play, calls } = setup()
    play('system')
    expect(calls).toEqual(['beep'])
  })

  it('"system" plays the system sound file where there is one, and beeps without a warning when it cannot', () => {
    const { play, calls, children } = setup({ systemSound: '/usr/share/sounds/x.oga' })
    play('system')
    children[0].emit('exit', 1)
    expect(calls).toEqual(['spawn:/usr/share/sounds/x.oga', 'beep'])
  })

  it('no player on this machine: beep, and say why once', () => {
    const { play, calls } = setup({ noPlayer: true })
    play('/s/a.wav')
    play('/s/a.wav')
    expect(calls).toEqual([
      'beep',
      'warn:Cannot play the attention sound /s/a.wav (no sound player found: paplay, pw-play or aplay); using the system sound',
      'beep'
    ])
  })

  it('a .wav is played by a separate process; a clean exit needs nothing else', () => {
    const { play, calls, children } = setup()
    play('D:\\s\\ding.wav')
    children[0].emit('exit', 0)
    expect(calls).toEqual(['spawn:D:\\s\\ding.wav'])
  })

  it('a .wav that cannot be played (missing, not a wave file) falls back to the beep and warns once per file', () => {
    const { play, calls, children } = setup()
    play('D:\\s\\typo.wav')
    children[0].emit('exit', 1)
    play('D:\\s\\typo.wav')
    children[1].emit('exit', 1)
    expect(calls).toEqual([
      'spawn:D:\\s\\typo.wav',
      'beep',
      'warn:Cannot play the attention sound D:\\s\\typo.wav (exit code 1); using the system sound',
      'spawn:D:\\s\\typo.wav',
      'beep'
    ])
  })

  it('a player that does not start falls back to the beep too', () => {
    const { play, calls, children } = setup()
    play('D:\\s\\a.wav')
    children[0].emit('error', new Error('spawn ENOENT'))
    const thrown = setup({ spawnThrows: true })
    thrown.play('D:\\s\\b.wav')
    expect(calls).toEqual(['spawn:D:\\s\\a.wav', 'beep', 'warn:Cannot play the attention sound D:\\s\\a.wav (spawn ENOENT); using the system sound'])
    expect(thrown.calls).toEqual(['beep', 'warn:Cannot play the attention sound D:\\s\\b.wav (spawn EPERM); using the system sound'])
  })

  it('an error followed by an exit still beeps only once', () => {
    const { play, calls, children } = setup()
    play('D:\\s\\a.wav')
    children[0].emit('error', new Error('spawn ENOENT'))
    children[0].emit('exit', 1)
    expect(calls.filter((c) => c === 'beep')).toHaveLength(1)
  })
})

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

describe('linuxPlayer', () => {
  const env = { PATH: '/usr/bin' }

  it('prefers paplay, then pw-play, then aplay; the path is an argument, never shell text', () => {
    const path = "/home/me/my sounds/it's $(x).wav"
    expect(linuxPlayer(path, () => true, env)).toEqual({ file: 'paplay', args: [path], env })
    expect(linuxPlayer(path, (c) => c !== 'paplay', env)?.file).toBe('pw-play')
    expect(linuxPlayer(path, (c) => c === 'aplay', env)?.file).toBe('aplay')
    expect(linuxPlayer(path, () => false, env)).toBeNull()
  })

  it('aplay plays .wav only', () => {
    expect(linuxPlayer('/s/bell.oga', (c) => c === 'aplay', env)).toBeNull()
  })
})

describe('linuxSoundDeps', () => {
  it('the system sound is the freedesktop one when installed; players are looked up once', () => {
    const asked: string[] = []
    const has = (c: string): boolean => {
      asked.push(c)
      return c === 'pw-play'
    }
    const d = linuxSoundDeps({}, has, (p) => p === FREEDESKTOP_SOUND)
    expect(d.systemSound).toBe(FREEDESKTOP_SOUND)
    d.player('/a.wav')
    d.player('/b.wav')
    expect(asked).toEqual(['paplay', 'pw-play'])
    expect(linuxSoundDeps({}, has, () => false).systemSound).toBeNull()
  })
})
