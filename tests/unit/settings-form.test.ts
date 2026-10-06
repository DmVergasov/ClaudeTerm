import { describe, expect, it } from 'vitest'
import { AUTOMATIC, checkNumber, checkText, CUSTOM_THEME, profileOptions, profileValue, soundChoice, themeOptions } from '../../src/renderer/settings-form'

describe('settings form', () => {
  it('checkNumber: font size 6–72, fractions allowed', () => {
    expect(checkNumber('font.size', '12')).toEqual({ ok: true, value: 12 })
    expect(checkNumber('font.size', ' 10.5 ')).toEqual({ ok: true, value: 10.5 })
    for (const t of ['', '5', '73', 'big', 'Infinity']) expect(checkNumber('font.size', t)).toEqual({ ok: false, error: 'Between 6 and 72' })
  })

  it('checkNumber: scrollback is a whole number 0–1000000', () => {
    expect(checkNumber('scrollback', '0')).toEqual({ ok: true, value: 0 })
    expect(checkNumber('scrollback', '1000000')).toEqual({ ok: true, value: 1_000_000 })
    for (const t of ['-1', '1000001', '10.5', '']) expect(checkNumber('scrollback', t)).toEqual({ ok: false, error: 'A whole number between 0 and 1000000' })
  })

  it('checkText: trims and refuses empty text', () => {
    expect(checkText('  Consolas ')).toEqual({ ok: true, value: 'Consolas' })
    expect(checkText('   ')).toEqual({ ok: false, error: 'Cannot be empty' })
  })

  it('themeOptions: the built-in themes; a custom object or an unknown name gets an extra selected item', () => {
    expect(themeOptions('One Half Dark')).toEqual({
      options: [{ value: 'Campbell', label: 'Campbell' }, { value: 'One Half Dark', label: 'One Half Dark' }, { value: 'One Half Light', label: 'One Half Light' }],
      selected: 'One Half Dark'
    })
    const custom = themeOptions({ background: '#000000' })
    expect(custom.options.at(-1)).toEqual({ value: CUSTOM_THEME, label: 'Custom (settings.json)' })
    expect(custom.selected).toBe(CUSTOM_THEME)
    const unknown = themeOptions('Dracula')
    expect(unknown.options.at(-1)).toEqual({ value: 'Dracula', label: 'Dracula (not found)' })
    expect(unknown.selected).toBe('Dracula')
  })

  it('profileOptions: Automatic first, then the profiles; a missing current one is shown as not found', () => {
    expect(profileOptions(['PowerShell 7', 'cmd'], null)).toEqual({
      options: [{ value: AUTOMATIC, label: 'Automatic' }, { value: 'PowerShell 7', label: 'PowerShell 7' }, { value: 'cmd', label: 'cmd' }],
      selected: AUTOMATIC
    })
    const gone = profileOptions(['cmd'], 'Git Bash')
    expect(gone.options.at(-1)).toEqual({ value: 'Git Bash', label: 'Git Bash (not found)' })
    expect(gone.selected).toBe('Git Bash')
    expect(profileValue(AUTOMATIC)).toBeNull()
    expect(profileValue('cmd')).toBe('cmd')
  })

  it('soundChoice', () => {
    expect(soundChoice('system')).toEqual({ custom: false, path: '' })
    expect(soundChoice('D:\\s\\ding.wav')).toEqual({ custom: true, path: 'D:\\s\\ding.wav' })
  })
})
