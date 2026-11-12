import { describe, expect, it } from 'vitest'
import { AUTOMATIC, checkNumber, checkOptionalText, checkPatterns, checkText, CUSTOM_THEME, profileOptions, profileValue, soundChoice, themeChoices } from '../../src/renderer/settings-form'

describe('settings form', () => {
  it('checkPatterns: one pattern per line, trimmed, empty lines dropped; an empty field is an empty list', () => {
    expect(checkPatterns('**/tests/**\n  *.spec.*  \r\n\n*Test.*\n')).toEqual({ ok: true, value: ['**/tests/**', '*.spec.*', '*Test.*'] })
    expect(checkPatterns('')).toEqual({ ok: true, value: [] })
    expect(checkPatterns(' \n \n')).toEqual({ ok: true, value: [] })
  })

  it('checkPatterns: at most 200 patterns of at most 200 characters', () => {
    expect(checkPatterns(Array(200).fill('a').join('\n'))).toMatchObject({ ok: true })
    expect(checkPatterns(Array(201).fill('a').join('\n'))).toEqual({ ok: false, error: 'At most 200 patterns' })
    expect(checkPatterns('x'.repeat(200))).toMatchObject({ ok: true })
    expect(checkPatterns('ok\n' + 'x'.repeat(201))).toEqual({ ok: false, error: 'A pattern is longer than 200 characters' })
  })

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

  it('checkNumber: the status bar refresh of Claude tabs is a whole number of seconds 1–300', () => {
    expect(checkNumber('claude.statusRefreshInterval', '1')).toEqual({ ok: true, value: 1 })
    expect(checkNumber('claude.statusRefreshInterval', ' 300 ')).toEqual({ ok: true, value: 300 })
    for (const t of ['0', '301', '2.5', '', 'often']) expect(checkNumber('claude.statusRefreshInterval', t)).toEqual({ ok: false, error: 'A whole number between 1 and 300' })
  })

  it('checkText: trims and refuses empty text', () => {
    expect(checkText('  Consolas ')).toEqual({ ok: true, value: 'Consolas' })
    expect(checkText('   ')).toEqual({ ok: false, error: 'Cannot be empty' })
  })

  it('themeChoices: a card per built-in theme, Graphite first, the saved one chosen', () => {
    const c = themeChoices('Campbell')
    expect(c.map((x) => x.value)).toEqual(['Graphite', 'Campbell', 'One Half Dark', 'One Half Light'])
    expect(c.filter((x) => x.selected).map((x) => x.value)).toEqual(['Campbell'])
    expect(c.every((x) => x.selectable)).toBe(true)
    expect(c[0]).toMatchObject({ title: 'Graphite', note: "ClaudeTerm's own, in the window's colors", colors: { background: '#0E0E10', foreground: '#D4D4DA', green: '#63C08F', cursor: '#D97757' } })
    expect(c.map((x) => x.note)).toEqual(["ClaudeTerm's own, in the window's colors", "Windows Terminal's default", 'Soft contrast on slate', 'A light terminal in the dark window'])
  })

  it('themeChoices: a theme object from settings.json is one more card, chosen, not selectable, in its colors over Campbell', () => {
    const c = themeChoices({ background: '#101010' })
    expect(c).toHaveLength(5)
    expect(c[4]).toMatchObject({ value: CUSTOM_THEME, title: 'Custom (settings.json)', note: 'Your own colors from settings.json', selectable: false, selected: true, colors: { background: '#101010', foreground: '#CCCCCC' } })
    expect(c.filter((x) => x.selected)).toHaveLength(1)
  })

  it('themeChoices: an unknown name is one more card, chosen, not selectable, in Graphite colors', () => {
    expect(themeChoices('Solarized')[4]).toMatchObject({ value: 'Solarized', title: 'Solarized (not found)', note: "Not one of ClaudeTerm's themes: Graphite is used", selectable: false, selected: true, colors: { background: '#0E0E10' } })
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

describe('checkOptionalText', () => {
  it('takes empty text as null and trims the rest', () => {
    expect(checkOptionalText('   ')).toEqual({ ok: true, value: null })
    expect(checkOptionalText(' code --goto {file}:{line} ')).toEqual({ ok: true, value: 'code --goto {file}:{line}' })
  })
})
