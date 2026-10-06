import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, loadSettingsFile, loadSettingsSafe, parseSettings } from '../../src/main/settings'

describe('parseSettings', () => {
  it('returns defaults for null or empty text', () => {
    expect(parseSettings(null)).toEqual({ settings: DEFAULT_SETTINGS, errors: [] })
    expect(parseSettings('  ')).toEqual({ settings: DEFAULT_SETTINGS, errors: [] })
  })

  it('merges partial overrides', () => {
    const { settings, errors } = parseSettings(JSON.stringify({ font: { size: 16 }, claude: { shellProfile: 'Git Bash' } }))
    expect(errors).toEqual([])
    expect(settings.font).toEqual({ family: DEFAULT_SETTINGS.font.family, size: 16 })
    expect(settings.claude).toEqual({ command: 'claude', shellProfile: 'Git Bash' })
    expect(settings.imageWatch).toEqual(DEFAULT_SETTINGS.imageWatch)
  })

  it('reports invalid JSON and falls back to defaults', () => {
    const r = parseSettings('{ "font": ')
    expect(r.settings).toEqual(DEFAULT_SETTINGS)
    expect(r.errors[0]).toMatch(/^settings\.json:/)
  })

  it('replaces invalid values with defaults and names the key', () => {
    const r = parseSettings(JSON.stringify({ scrollback: -5, font: { size: 'big' }, imagePanel: { autoOpen: 'yes' } }))
    expect(r.settings.scrollback).toBe(DEFAULT_SETTINGS.scrollback)
    expect(r.settings.font.size).toBe(DEFAULT_SETTINGS.font.size)
    expect(r.settings.imagePanel.autoOpen).toBe(true)
    const all = r.errors.join('\n')
    expect(all).toContain('"scrollback"')
    expect(all).toContain('"font.size"')
    expect(all).toContain('"imagePanel.autoOpen"')
  })

  it('notifications: defaults are the old behaviour, the bell rings no sound', () => {
    expect(DEFAULT_SETTINGS.notifications).toEqual({
      sound: 'system',
      permission: { sound: true, flash: true, tab: true },
      question: { sound: true, flash: true, tab: true },
      done: { sound: true, flash: true, tab: true },
      bell: { sound: false, flash: true, tab: true }
    })
    expect(parseSettings('{}').settings.notifications).toEqual(DEFAULT_SETTINGS.notifications)
  })

  it('notifications: each field is read on its own and an invalid one falls back with a notice naming it', () => {
    const r = parseSettings(JSON.stringify({ notifications: { sound: 'D:\\sounds\\Ding.WAV', done: { sound: false, tab: 'no' }, bell: { sound: true } } }))
    expect(r.settings.notifications.sound).toBe('D:\\sounds\\Ding.WAV')
    expect(r.settings.notifications.done).toEqual({ sound: false, flash: true, tab: true })
    expect(r.settings.notifications.bell).toEqual({ sound: true, flash: true, tab: true })
    expect(r.settings.notifications.permission).toEqual({ sound: true, flash: true, tab: true })
    expect(r.errors).toEqual(['settings.json: invalid value for "notifications.done.tab", using default'])
  })

  it('notifications.sound: "system" or an absolute .wav only', () => {
    for (const sound of ['none', 'ding.wav', 'D:\\sounds\\ding.mp3', 'loud', true]) {
      const r = parseSettings(JSON.stringify({ notifications: { sound } }))
      expect(r.settings.notifications.sound).toBe('system')
      expect(r.errors.join('\n')).toContain('"notifications.sound"')
    }
  })

  it('attention (old files): "none" turns the Claude sounds off, a .wav becomes the sound, flash: false stops Claude flashing', () => {
    const off = parseSettings(JSON.stringify({ attention: { sound: 'none', flash: false } }))
    expect(off.errors).toEqual([])
    expect(off.settings.notifications).toEqual({
      sound: 'system',
      permission: { sound: false, flash: false, tab: true },
      question: { sound: false, flash: false, tab: true },
      done: { sound: false, flash: false, tab: true },
      bell: { sound: false, flash: true, tab: true }
    })
    const wav = parseSettings(JSON.stringify({ attention: { sound: 'D:\\s\\ding.wav' } })).settings.notifications
    expect(wav.sound).toBe('D:\\s\\ding.wav')
    expect(wav.done).toEqual({ sound: true, flash: true, tab: true })
  })

  it('attention (old files): invalid values fall back with a notice naming them', () => {
    const r = parseSettings(JSON.stringify({ attention: { sound: 'loud', flash: 'yes' } }))
    expect(r.settings.notifications).toEqual(DEFAULT_SETTINGS.notifications)
    expect(r.errors.join('\n')).toContain('"attention.sound"')
    expect(r.errors.join('\n')).toContain('"attention.flash"')
  })

  it('notifications wins over attention', () => {
    const r = parseSettings(JSON.stringify({ attention: { sound: 'none' }, notifications: { done: { flash: false } } }))
    expect(r.settings.notifications.permission.sound).toBe(true)
    expect(r.settings.notifications.done).toEqual({ sound: true, flash: false, tab: true })
    expect(r.errors).toEqual([])
  })

  it('autoUpdate: on by default, false turns it off, other values fall back', () => {
    expect(DEFAULT_SETTINGS.autoUpdate).toBe(true)
    expect(parseSettings(JSON.stringify({ autoUpdate: false })).settings.autoUpdate).toBe(false)
    const r = parseSettings(JSON.stringify({ autoUpdate: 'no' }))
    expect(r.settings.autoUpdate).toBe(true)
    expect(r.errors.join('\n')).toContain('"autoUpdate"')
  })

  it('normalizes profiles without args', () => {
    const r = parseSettings(JSON.stringify({ profiles: [{ name: 'My Bash', command: 'C:\\x\\bash.exe' }] }))
    expect(r.settings.profiles).toEqual([{ name: 'My Bash', command: 'C:\\x\\bash.exe', args: [] }])
  })

  it('accepts a theme object', () => {
    expect(parseSettings(JSON.stringify({ theme: { background: '#000000' } })).settings.theme).toEqual({ background: '#000000' })
  })
})

describe('loadSettingsSafe', () => {
  it('returns defaults and an error when the path cannot be read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-set-'))
    const r = loadSettingsSafe(dir)
    expect(r.settings).toEqual(DEFAULT_SETTINGS)
    expect(r.settings).not.toBe(DEFAULT_SETTINGS)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatch(/^Cannot read settings\.json: .+; using defaults$/)
  })

  it('passes through a normal load', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'ct-set-')), 'settings.json')
    writeFileSync(p, JSON.stringify({ scrollback: 500 }))
    expect(loadSettingsSafe(p)).toEqual({ settings: { ...DEFAULT_SETTINGS, scrollback: 500 }, errors: [] })
  })
})

describe('loadSettingsFile', () => {
  it('creates the file with defaults when missing', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'ct-set-')), 'sub', 'settings.json')
    expect(loadSettingsFile(p).settings).toEqual(DEFAULT_SETTINGS)
    expect(existsSync(p)).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual(DEFAULT_SETTINGS)
  })

  it('strips a UTF-8 BOM', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'ct-set-')), 'settings.json')
    writeFileSync(p, '\uFEFF' + JSON.stringify({ scrollback: 500 }), 'utf8')
    expect(loadSettingsFile(p)).toEqual({ settings: { ...DEFAULT_SETTINGS, scrollback: 500 }, errors: [] })
  })
})
