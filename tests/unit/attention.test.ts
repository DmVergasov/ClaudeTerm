import { describe, expect, it } from 'vitest'
import { Attention, ATTENTION_REPEAT_MS } from '../../src/main/attention'
import type { Settings } from '../../src/shared/types'

function setup(o: { focused?: boolean; active?: string | null; attention?: Settings['attention'] } = {}) {
  const state = { focused: o.focused ?? false, active: o.active ?? 't1', attention: o.attention ?? { sound: 'system', flash: true }, t: 1000 }
  const calls: string[] = []
  const a = new Attention({
    windowFocused: () => state.focused,
    activeTabId: () => state.active,
    settings: () => state.attention,
    flash: () => calls.push('flash'),
    play: (sound) => calls.push(`play:${sound}`),
    markTab: (id) => calls.push(`mark:${id}`),
    now: () => state.t
  })
  return { a, calls, state }
}

describe('Attention', () => {
  it('does nothing while the user looks at that tab', () => {
    const { a, calls } = setup({ focused: true, active: 't1' })
    expect(a.notify('t1')).toBe(false)
    expect(calls).toEqual([])
  })

  it('window in the background: plays the sound and flashes the taskbar', () => {
    const { a, calls } = setup({ focused: false, active: 't1' })
    expect(a.notify('t1')).toBe(true)
    expect(calls).toEqual(['flash', 'play:system'])
  })

  it('another tab is open in the focused window: marks the tab and plays the sound, no flashing', () => {
    const { a, calls } = setup({ focused: true, active: 't2' })
    expect(a.notify('t1')).toBe(true)
    expect(calls).toEqual(['mark:t1', 'play:system'])
  })

  it('window in the background with another tab open: marks, flashes and plays', () => {
    const { a, calls } = setup({ focused: false, active: 't2' })
    a.notify('t1')
    expect(calls).toEqual(['mark:t1', 'flash', 'play:system'])
  })

  it('follows the settings: no sound, no flashing, a custom .wav', () => {
    const { a, calls, state } = setup({ focused: false, attention: { sound: 'none', flash: false } })
    expect(a.notify('t1')).toBe(true)
    expect(calls).toEqual([])
    state.attention = { sound: 'D:\\s\\ding.wav', flash: false }
    state.t += ATTENTION_REPEAT_MS
    a.notify('t1')
    expect(calls).toEqual(['play:D:\\s\\ding.wav'])
  })

  it('collapses repeats from the same tab within the repeat window, but not from other tabs', () => {
    const { a, calls, state } = setup({ focused: false, active: 't1' })
    a.notify('t1')
    state.t += ATTENTION_REPEAT_MS - 1
    expect(a.notify('t1')).toBe(false)
    expect(a.notify('t2')).toBe(true)
    state.t += 1
    expect(a.notify('t1')).toBe(true)
    expect(calls.filter((c) => c === 'play:system')).toHaveLength(3)
  })

  it('a suppressed notification while looking does not start the repeat window', () => {
    const { a, state } = setup({ focused: true, active: 't1' })
    a.notify('t1')
    state.focused = false
    expect(a.notify('t1')).toBe(true)
  })

  it('removeTab forgets the repeat window', () => {
    const { a } = setup({ focused: false })
    a.notify('t1')
    a.removeTab('t1')
    expect(a.notify('t1')).toBe(true)
  })
})
