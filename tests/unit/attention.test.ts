import { describe, expect, it } from 'vitest'
import { Attention, ATTENTION_REPEAT_MS } from '../../src/main/attention'
import { DEFAULT_SETTINGS } from '../../src/main/settings'
import type { NotificationSettings } from '../../src/shared/types'

function setup(o: { focused?: boolean; active?: string | null } = {}) {
  const state = { focused: o.focused ?? false, active: o.active === undefined ? 't1' : o.active, n: structuredClone(DEFAULT_SETTINGS.notifications) as NotificationSettings, t: 1000 }
  const calls: string[] = []
  const a = new Attention({
    windowFocused: () => state.focused,
    activeTabId: () => state.active,
    settings: () => state.n,
    flash: () => calls.push('flash'),
    play: (sound) => calls.push(`play:${sound}`),
    markTab: (id, reason) => calls.push(`mark:${id}:${reason}`),
    now: () => state.t
  })
  return { a, calls, state }
}

describe('Attention', () => {
  it('does nothing while the user looks at that tab', () => {
    const { a, calls } = setup({ focused: true, active: 't1' })
    expect(a.notify('t1', 'permission')).toBe(false)
    expect(a.notify('t1', 'bell')).toBe(false)
    expect(calls).toEqual([])
  })

  it('window in the background: plays the sound and flashes the taskbar', () => {
    const { a, calls } = setup({ focused: false, active: 't1' })
    expect(a.notify('t1', 'permission')).toBe(true)
    expect(calls).toEqual(['flash', 'play:system'])
  })

  it('another tab is open in the focused window: marks the tab with the reason and plays the sound, no flashing', () => {
    const { a, calls } = setup({ focused: true, active: 't2' })
    expect(a.notify('t1', 'question')).toBe(true)
    expect(calls).toEqual(['mark:t1:question', 'play:system'])
  })

  it('window in the background with another tab open: marks, flashes and plays', () => {
    const { a, calls } = setup({ focused: false, active: 't2' })
    a.notify('t1', 'done')
    expect(calls).toEqual(['mark:t1:done', 'flash', 'play:system'])
  })

  it('each case gives only the signals switched on for it', () => {
    const { a, calls, state } = setup({ focused: false, active: 't2' })
    state.n.done = { sound: false, flash: true, tab: false }
    state.n.question = { sound: true, flash: false, tab: true }
    a.notify('t1', 'done')
    expect(calls).toEqual(['flash'])
    calls.length = 0
    a.notify('t3', 'question')
    expect(calls).toEqual(['mark:t3:question', 'play:system'])
  })

  it('a case with every signal off gives none and reports it', () => {
    const { a, calls, state } = setup({ focused: false, active: 't2' })
    state.n.permission = { sound: false, flash: false, tab: false }
    expect(a.notify('t1', 'permission')).toBe(false)
    expect(calls).toEqual([])
  })

  it('plays the chosen .wav', () => {
    const { a, calls, state } = setup({ focused: false })
    state.n.sound = 'D:\\s\\ding.wav'
    a.notify('t1', 'done')
    expect(calls).toEqual(['flash', 'play:D:\\s\\ding.wav'])
  })

  it('the terminal bell: by default a dot and a flash, no sound', () => {
    const { a, calls } = setup({ focused: false, active: 't2' })
    expect(a.notify('t1', 'bell')).toBe(true)
    expect(calls).toEqual(['mark:t1:bell', 'flash'])
  })

  it('one sound per tab per repeat window; marking and flashing still happen; other tabs keep their own window', () => {
    const { a, calls, state } = setup({ focused: false, active: 't9' })
    a.notify('t1', 'question')
    state.t += ATTENTION_REPEAT_MS - 1
    calls.length = 0
    expect(a.notify('t1', 'permission')).toBe(true)
    expect(calls).toEqual(['mark:t1:permission', 'flash'])
    calls.length = 0
    a.notify('t2', 'permission')
    expect(calls).toContain('play:system')
    state.t += 1
    calls.length = 0
    a.notify('t1', 'done')
    expect(calls).toContain('play:system')
  })

  it('a case with its sound off does not use up the sound window', () => {
    const { a, calls, state } = setup({ focused: false })
    state.n.question.sound = false
    a.notify('t1', 'question')
    state.t += 100
    a.notify('t1', 'permission')
    expect(calls.filter((c) => c === 'play:system')).toHaveLength(1)
  })

  it('a bell sound obeys the same per-tab window', () => {
    const { a, calls, state } = setup({ focused: false })
    state.n.bell.sound = true
    a.notify('t1', 'bell')
    state.t += 10
    a.notify('t1', 'bell')
    expect(calls.filter((c) => c === 'play:system')).toHaveLength(1)
  })

  it('a suppressed notification while looking does not start the repeat window', () => {
    const { a, calls, state } = setup({ focused: true, active: 't1' })
    a.notify('t1', 'done')
    state.focused = false
    a.notify('t1', 'done')
    expect(calls).toContain('play:system')
  })

  it('removeTab forgets the repeat window', () => {
    const { a, calls } = setup({ focused: false })
    a.notify('t1', 'done')
    a.removeTab('t1')
    calls.length = 0
    a.notify('t1', 'done')
    expect(calls).toContain('play:system')
  })
})
