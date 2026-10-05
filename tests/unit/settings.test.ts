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

  it('attention: system sound and flashing by default; "none" or an absolute .wav path are accepted', () => {
    expect(DEFAULT_SETTINGS.attention).toEqual({ sound: 'system', flash: true })
    expect(parseSettings(JSON.stringify({ attention: { sound: 'none', flash: false } })).settings.attention).toEqual({ sound: 'none', flash: false })
    expect(parseSettings(JSON.stringify({ attention: { sound: 'D:\\sounds\\Ding.WAV' } })).settings.attention).toEqual({ sound: 'D:\\sounds\\Ding.WAV', flash: true })
  })

  it('attention: rejects other sounds and names the key', () => {
    for (const sound of ['ding.wav', 'D:\\sounds\\ding.mp3', 'loud', true]) {
      const r = parseSettings(JSON.stringify({ attention: { sound } }))
      expect(r.settings.attention.sound).toBe('system')
      expect(r.errors.join('\n')).toContain('"attention.sound"')
    }
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
