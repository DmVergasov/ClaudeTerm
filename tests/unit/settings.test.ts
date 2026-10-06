import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applySettingEdit, DEFAULT_SETTINGS, loadSettingsFile, loadSettingsSafe, parseSettings } from '../../src/main/settings'

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

describe('parseSettings: broken files', () => {
  it('marks invalid JSON and a non-object root as broken', () => {
    expect(parseSettings('{ "font": ').broken).toBe(true)
    expect(parseSettings('[1]').broken).toBe(true)
    expect(parseSettings('{}').broken).toBeUndefined()
  })
})

describe('applySettingEdit', () => {
  const edit = (text: string | null, key: Parameters<typeof applySettingEdit>[1], value: Parameters<typeof applySettingEdit>[2]) => {
    const r = applySettingEdit(text, key, value)
    if (!r.ok) throw new Error(r.error)
    return r.text
  }

  it('sets a nested key, keeps unknown keys and their order, writes two-space JSON', () => {
    const text = edit('{"myNote":"keep","font":{"family":"Consolas","size":12},"scrollback":5}', 'font.size', 14)
    expect(text).toBe('{\n  "myNote": "keep",\n  "font": {\n    "family": "Consolas",\n    "size": 14\n  },\n  "scrollback": 5\n}\n')
  })

  it('creates missing objects and replaces a non-object on the way', () => {
    expect(JSON.parse(edit('{}', 'claude.command', 'claude-beta'))).toEqual({ claude: { command: 'claude-beta' } })
    expect(JSON.parse(edit('{"claude":"x"}', 'claude.shellProfile', null))).toEqual({ claude: { shellProfile: null } })
  })

  it('treats a missing file as empty and strips a BOM', () => {
    expect(JSON.parse(edit(null, 'autoUpdate', false))).toEqual({ autoUpdate: false })
    expect(JSON.parse(edit('﻿{"scrollback":5}', 'autoUpdate', false))).toEqual({ scrollback: 5, autoUpdate: false })
  })

  it('refuses a value the app would not accept, naming the key', () => {
    expect(applySettingEdit('{}', 'font.size', 100)).toEqual({ ok: false, error: 'Invalid value for font.size' })
    expect(applySettingEdit('{}', 'font.family', '')).toEqual({ ok: false, error: 'Invalid value for font.family' })
    expect(applySettingEdit('{}', 'notifications.sound', 'none')).toEqual({ ok: false, error: 'Invalid value for notifications.sound' })
    expect(applySettingEdit('{}', 'imageWatch.enabled', 'yes')).toEqual({ ok: false, error: 'Invalid value for imageWatch.enabled' })
  })

  it('refuses a file that is not a JSON object', () => {
    const bad = applySettingEdit('{ "font": ', 'font.size', 14)
    expect(bad.ok).toBe(false)
    expect(!bad.ok && bad.error).toMatch(/^settings\.json can't be used: /)
    expect(applySettingEdit('[1]', 'font.size', 14)).toEqual({ ok: false, error: "settings.json can't be used: the root must be an object" })
  })

  it('an invalid value of another key does not block the edit', () => {
    expect(JSON.parse(edit('{"scrollback":-5}', 'font.size', 14))).toEqual({ scrollback: -5, font: { size: 14 } })
  })

  it('a notifications edit writes notifications from attention and drops attention', () => {
    const out = JSON.parse(edit('{"attention":{"sound":"none","flash":false},"scrollback":5}', 'notifications.done.tab', false))
    expect(out.attention).toBeUndefined()
    expect(out.scrollback).toBe(5)
    expect(out.notifications).toEqual({
      sound: 'system',
      permission: { sound: false, flash: false, tab: true },
      question: { sound: false, flash: false, tab: true },
      done: { sound: false, flash: false, tab: false },
      bell: { sound: false, flash: true, tab: true }
    })
  })

  it('a notifications edit keeps an existing notifications object and still drops attention', () => {
    const out = JSON.parse(edit('{"attention":{"sound":"none"},"notifications":{"done":{"tab":false}}}', 'notifications.bell.sound', true))
    expect(out).toEqual({ notifications: { done: { tab: false }, bell: { sound: true } } })
  })

  it('other edits leave attention alone', () => {
    expect(JSON.parse(edit('{"attention":{"sound":"none"}}', 'autoUpdate', false))).toEqual({ attention: { sound: 'none' }, autoUpdate: false })
  })
})
