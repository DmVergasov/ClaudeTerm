import { describe, expect, it } from 'vitest'
import { isSettingKey, isSettingValue, SETTING_KEYS } from '../../src/shared/settings-keys'

describe('settings keys', () => {
  it('lists the 12 notification cells, the sound and the thirteen plain settings', () => {
    expect(SETTING_KEYS).toHaveLength(26)
    expect(SETTING_KEYS).toContain('notifications.bell.tab')
    expect(SETTING_KEYS).toContain('notifications.sound')
    expect(SETTING_KEYS).toContain('claude.shellProfile')
    expect(SETTING_KEYS).toContain('review.editor')
    expect(SETTING_KEYS).toContain('review.statusBar')
    expect(SETTING_KEYS).toContain('review.hideIgnored')
  })

  it('isSettingKey accepts listed keys only', () => {
    expect(isSettingKey('font.size')).toBe(true)
    expect(isSettingKey('profiles')).toBe(false)
    expect(isSettingKey('__proto__')).toBe(false)
    expect(isSettingKey(1)).toBe(false)
  })

  it('isSettingValue accepts strings, finite numbers, booleans and null', () => {
    for (const v of ['x', 12, 0, true, false, null]) expect(isSettingValue(v)).toBe(true)
    for (const v of [undefined, NaN, Infinity, {}, [], () => 1]) expect(isSettingValue(v)).toBe(false)
  })
})
