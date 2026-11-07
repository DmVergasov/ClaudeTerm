import { describe, expect, it } from 'vitest'
import { Attention, ATTENTION_REPEAT_MS } from '../../src/main/attention'
import { DEFAULT_SETTINGS } from '../../src/main/settings'
import type { NotificationSettings } from '../../src/shared/types'

function setup(o: { focused?: boolean; active?: string | null } = {}) {
  const state = { focused: o.focused ?? false, active: o.active === undefined ? 't1' : o.active, n: structuredClone(DEFAULT_SETTINGS.notifications) as NotificationSettings, t: 1000, muted: new Set<string>() }
  const calls: string[] = []
  const a = new Attention({
    windowFocused: () => state.focused,
    activeTabId: () => state.active,
    settings: () => state.n,
    flash: () => calls.push('flash'),
    play: (sound) => calls.push(`play:${sound}`),
    markTab: (id, reason) => calls.push(`mark:${id}:${reason}`),
    banner: (id, reason) => calls.push(`banner:${id}:${reason}`),
    muted: (id) => state.muted.has(id),
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

  it('window in the background: flashes the taskbar, shows a system notification and plays the sound', () => {
    const { a, calls } = setup({ focused: false, active: 't1' })
    expect(a.notify('t1', 'permission')).toBe(true)
    expect(calls).toEqual(['flash', 'banner:t1:permission', 'play:system'])
  })

  it('another tab is open in the focused window: marks the tab with the reason and plays the sound, no flashing', () => {
    const { a, calls } = setup({ focused: true, active: 't2' })
    expect(a.notify('t1', 'question')).toBe(true)
    expect(calls).toEqual(['mark:t1:question', 'play:system'])
  })

  it('window in the background with another tab open: marks, flashes, shows a system notification and plays', () => {
    const { a, calls } = setup({ focused: false, active: 't2' })
    a.notify('t1', 'done')
    expect(calls).toEqual(['mark:t1:done', 'flash', 'banner:t1:done', 'play:system'])
  })

  it('each case gives only the signals switched on for it', () => {
    const { a, calls, state } = setup({ focused: false, active: 't2' })
    state.n.done = { sound: false, flash: true, tab: false, front: false, banner: false }
    state.n.question = { sound: true, flash: false, tab: true, front: false, banner: false }
    a.notify('t1', 'done')
    expect(calls).toEqual(['flash'])
    calls.length = 0
    a.notify('t3', 'question')
    expect(calls).toEqual(['mark:t3:question', 'play:system'])
  })

  it('in front of the user, a case set to Even in front plays its sound and gives nothing else', () => {
    const { a, calls, state } = setup({ focused: true, active: 't1' })
    state.n.done.front = true
    expect(a.notify('t1', 'done')).toBe(true)
    expect(calls).toEqual(['play:system'])
    calls.length = 0
    expect(a.notify('t1', 'permission')).toBe(false)
    expect(calls).toEqual([])
  })

  it('Even in front without the sound gives nothing in front', () => {
    const { a, calls, state } = setup({ focused: true, active: 't1' })
    state.n.done = { sound: false, flash: true, tab: true, front: true, banner: true }
    expect(a.notify('t1', 'done')).toBe(false)
    expect(calls).toEqual([])
  })

  it('a turn that ends with background work still running is signalled like any other by default', () => {
    const { a, calls } = setup({ focused: false, active: 't2' })
    expect(a.notify('t1', 'done', true)).toBe(true)
    expect(calls).toEqual(['mark:t1:done', 'flash', 'banner:t1:done', 'play:system'])
  })

  it('with doneWithBackgroundWork off, such a turn gives no signal, even in front, while the turn after it does', () => {
    const { a, calls, state } = setup({ focused: false, active: 't2' })
    state.n.doneWithBackgroundWork = false
    expect(a.notify('t1', 'done', true)).toBe(false)
    state.focused = true
    state.active = 't1'
    state.n.done.front = true
    expect(a.notify('t1', 'done', true)).toBe(false)
    expect(calls).toEqual([])
    expect(a.notify('t1', 'done')).toBe(true)
    expect(calls).toEqual(['play:system'])
  })

  it('a case with every signal off gives none and reports it', () => {
    const { a, calls, state } = setup({ focused: false, active: 't2' })
    state.n.permission = { sound: false, flash: false, tab: false, front: false, banner: false }
    expect(a.notify('t1', 'permission')).toBe(false)
    expect(calls).toEqual([])
  })

  it('plays the chosen .wav', () => {
    const { a, calls, state } = setup({ focused: false })
    state.n.sound = 'D:\\s\\ding.wav'
    a.notify('t1', 'done')
    expect(calls).toEqual(['flash', 'banner:t1:done', 'play:D:\\s\\ding.wav'])
  })

  it('the terminal bell: by default a dot and a flash, no sound and no system notification', () => {
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
    expect(calls).toEqual(['mark:t1:permission', 'flash', 'banner:t1:permission'])
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

  it('a muted tab gives no sound; it is still marked, the taskbar still flashes and the system notification still shows', () => {
    const { a, calls, state } = setup({ focused: false, active: 't2' })
    state.n.bell.sound = true
    state.muted.add('t1')
    expect(a.notify('t1', 'permission')).toBe(true)
    a.notify('t1', 'bell')
    expect(calls).toEqual(['mark:t1:permission', 'flash', 'banner:t1:permission', 'mark:t1:bell', 'flash'])
    calls.length = 0
    a.notify('t3', 'done')
    expect(calls).toContain('play:system')
  })

  it('a muted tab with only the sound on for the case gives no signal and reports it', () => {
    const { a, calls, state } = setup({ focused: true, active: 't2' })
    state.n.done = { sound: true, flash: true, tab: false, front: false, banner: true }
    state.muted.add('t1')
    expect(a.notify('t1', 'done')).toBe(false)
    expect(calls).toEqual([])
  })

  it('a muted tab does not use up the sound window: unmuted, it sounds at once', () => {
    const { a, calls, state } = setup({ focused: false })
    state.muted.add('t1')
    a.notify('t1', 'question')
    state.muted.delete('t1')
    state.t += 10
    calls.length = 0
    a.notify('t1', 'permission')
    expect(calls).toContain('play:system')
  })

  it('a system notification shows only while the window is in the background, whichever tab is in front', () => {
    const { a, calls, state } = setup({ focused: true, active: 't2' })
    expect(a.notify('t1', 'question')).toBe(true)
    expect(calls).toEqual(['mark:t1:question', 'play:system'])
    calls.length = 0
    state.focused = false
    state.t += ATTENTION_REPEAT_MS
    a.notify('t1', 'question')
    expect(calls).toContain('banner:t1:question')
  })

  it('a case with only the system notification on gives it and reports a signal', () => {
    const { a, calls, state } = setup({ focused: false, active: 't1' })
    state.n.done = { sound: false, flash: false, tab: false, front: false, banner: true }
    expect(a.notify('t1', 'done')).toBe(true)
    expect(calls).toEqual(['banner:t1:done'])
  })

  it('removeTab forgets the repeat window', () => {
    const { a, calls } = setup({ focused: false })
    a.notify('t1', 'done')
    a.removeTab('t1')
    calls.length = 0
    a.notify('t1', 'done')
    expect(calls).toContain('play:system')
  })

  it('a ring for a case set to Even in front plays its sound only, once per repeat window', () => {
    const { a, calls, state } = setup({ focused: false, active: 't2' })
    state.n.permission = { sound: true, flash: true, tab: true, front: true, banner: true }
    a.ringInFront('t1', 'permission')
    expect(calls).toEqual(['play:system'])
    calls.length = 0
    state.t += ATTENTION_REPEAT_MS - 1
    a.ringInFront('t1', 'permission')
    expect(calls).toEqual([])
    state.t += 1
    a.ringInFront('t1', 'permission')
    expect(calls).toEqual(['play:system'])
  })

  it('a ring after a sound within the repeat window is silent: the window is shared with notify', () => {
    const { a, calls, state } = setup({ focused: false, active: 't2' })
    state.n.permission = { sound: true, flash: true, tab: true, front: true, banner: true }
    a.notify('t1', 'permission')
    expect(calls).toEqual(['mark:t1:permission', 'flash', 'banner:t1:permission', 'play:system'])
    calls.length = 0
    state.t += ATTENTION_REPEAT_MS - 1
    a.ringInFront('t1', 'permission')
    expect(calls).toEqual([])
    state.t += 1
    a.ringInFront('t1', 'permission')
    expect(calls).toEqual(['play:system'])
  })

  it('a ring does nothing for a case without Even in front, without its sound, or for a muted tab', () => {
    const { a, calls, state } = setup({ focused: true, active: 't1' })
    state.n.permission = { sound: true, flash: true, tab: true, front: false, banner: true }
    a.ringInFront('t1', 'permission')
    state.n.permission = { sound: false, flash: true, tab: true, front: true, banner: true }
    a.ringInFront('t1', 'permission')
    state.n.permission = { sound: true, flash: true, tab: true, front: true, banner: true }
    state.muted.add('t1')
    a.ringInFront('t1', 'permission')
    expect(calls).toEqual([])
  })

  it('a turn another session started (peer) gives the signals of its own case, all off by default', () => {
    const { a, calls, state } = setup({ focused: false, active: 't2' })
    expect(a.notify('t1', 'peer')).toBe(false)
    expect(calls).toEqual([])
    state.n.peer = { sound: true, flash: false, tab: true, front: false, banner: false }
    expect(a.notify('t1', 'peer')).toBe(true)
    expect(calls).toEqual(['mark:t1:peer', 'play:system'])
  })
})
