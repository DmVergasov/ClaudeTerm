import { describe, expect, it } from 'vitest'
import { countdown, limitMeters, resetClock } from '../../src/renderer/limit-meters'
import type { StatusUpdate } from '../../src/shared/ipc'
import type { MainStatus } from '../../src/shared/types'

const H = 3_600_000
const FIVE_HOURS = 5 * H
/** the 5h window resets at 21:40; the status is read at 19:40, three hours into it */
const RESET = new Date(2026, 9, 5, 21, 40).getTime()
const NOW = RESET - 2 * H

const main: MainStatus = {
  model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  effort: 'xhigh',
  context: { usedTokens: 82_314, size: 200_000, usedPct: 41.2 },
  fiveHour: { usedPct: 23.5, resetsAt: RESET / 1000 },
  sevenDay: { usedPct: 41.2, resetsAt: new Date(2026, 9, 9, 14, 0).getTime() / 1000 }
}
const update = (over: Partial<MainStatus>): StatusUpdate => ({ tabId: 't', main: { ...main, ...over }, agents: [], background: [] })

describe('resetClock', () => {
  it('names the reset by its clock time today, and by weekday and time on another day', () => {
    const now = new Date(2026, 10, 10, 15, 0).getTime()
    expect(resetClock(new Date(2026, 10, 10, 18, 40).getTime(), now)).toBe('18:40')
    expect(resetClock(new Date(2026, 10, 12, 9, 0).getTime(), now)).toBe('Thu 09:00')
  })

  it('a reset already past still shows its clock', () => {
    const now = new Date(2026, 10, 10, 15, 0).getTime()
    expect(resetClock(new Date(2026, 10, 10, 14, 0).getTime(), now)).toBe('14:00')
  })
})

describe('countdown', () => {
  it('days and hours, hours and minutes, minutes and seconds, or seconds; never below 0', () => {
    expect(countdown(3 * 86_400_000 + 18 * H + 20 * 60_000)).toBe('3d 18h')
    expect(countdown(2 * H + 5 * 60_000)).toBe('2h 05m')
    expect(countdown(25 * 60_000 + 5_000)).toBe('25m 05s')
    expect(countdown(41_200)).toBe('42s')
    expect(countdown(-5_000)).toBe('0s')
  })
})

describe('limitMeters', () => {
  it('gives the 5-hour and weekly meters in that order, with a bar of the % used and the share of the window gone by', () => {
    // the 5h limit 3 hours into its window, the week 3 days 18 hours before its reset (46% of it gone)
    const [five, week] = limitMeters(update({}), NOW, true)
    expect(five).toMatchObject({ key: 'limit', label: '5-HOUR', pct: '24%', level: 'normal', bar: { used: 24, elapsed: 60 } })
    expect(week).toMatchObject({ key: 'week', label: 'WEEKLY', pct: '41%', bar: { used: 41, elapsed: 46 } })
  })

  it('the reset of each meter is its clock: 21:40 today, and weekday and time for the weekly one', () => {
    const [five, week] = limitMeters(update({}), NOW, true)
    expect(five!.reset).toBe('21:40')
    expect(week!.reset).toBe('Fri 14:00')
  })

  it('a limit that runs out before its reset says when, and one used up says so', () => {
    const at = (usedPct: number, now: number) => limitMeters(update({ fiveHour: { usedPct, resetsAt: RESET / 1000 } }), now, true)[0]
    // 50% in the first hour: the rest goes in the next hour, at 18:40, three hours before the reset
    expect(at(50, RESET - 4 * H)).toEqual({ key: 'limit', label: '5-HOUR', pct: '50%', reset: '21:40', counting: false, title: 'resets at 21:40, in 4 h\nat this pace: runs out at 18:40, 3 h before the reset', level: 'crit', bar: { used: 50, elapsed: 20 } })
    expect(at(100, NOW)).toEqual({ key: 'limit', label: '5-HOUR', pct: '100%', reset: 'in 2h 00m', counting: true, title: 'resets at 21:40, in 2 h\nused up', level: 'crit', bar: { used: 100, elapsed: 60 } })
    // too early in the window for a pace: no forecast
    expect(at(10, RESET - FIVE_HOURS + 18 * 60_000)).toMatchObject({ title: 'resets at 21:40, in 4 h 42 min', level: 'normal' })
  })

  it('the weekly tooltip keeps its day and time', () => {
    const week = limitMeters(update({}), NOW, true)[1]
    expect(week!.title).toBe('resets Fri 9 Oct, 14:00, in 3 d 18 h\nat this pace: lasts until the reset, about 89% by then')
  })

  it('with the pace turned off a limit has no bar and no forecast, and takes its color from the fixed 70% and 90%', () => {
    const at = (usedPct: number) => limitMeters(update({ fiveHour: { usedPct, resetsAt: RESET / 1000 } }), RESET - 4 * H, false)[0]
    // 50% in the first hour runs out early at this pace, but is only half the limit
    expect(at(50)).toEqual({ key: 'limit', label: '5-HOUR', pct: '50%', reset: '21:40', counting: false, title: 'resets at 21:40, in 4 h', level: 'normal', bar: null })
    expect(at(75)).toMatchObject({ level: 'warn', bar: null })
    expect(at(100)).toEqual({ key: 'limit', label: '5-HOUR', pct: '100%', reset: 'in 4h 00m', counting: true, title: 'resets at 21:40, in 4 h\nused up', level: 'crit', bar: null })
    expect(limitMeters(update({}), NOW, false)[1]).toEqual({ key: 'week', label: 'WEEKLY', pct: '41%', reset: 'Fri 14:00', counting: false, title: 'resets Fri 9 Oct, 14:00, in 3 d 18 h', level: 'normal', bar: null })
  })

  it('a used-up limit counts down to its reset in its own meter: hours and minutes, then minutes and seconds, then seconds', () => {
    const five = (now: number) => limitMeters(update({ fiveHour: { usedPct: 100, resetsAt: RESET / 1000 } }), now, true)[0]!
    expect(five(NOW)).toMatchObject({ reset: 'in 2h 00m', counting: true })
    expect(five(RESET - 25 * 60_000 - 5_000)).toMatchObject({ reset: 'in 25m 05s', counting: true })
    expect(five(RESET - 42_000)).toMatchObject({ reset: 'in 42s', counting: true })
    // the weekly one stays a clock while it is not used up
    expect(limitMeters(update({ fiveHour: { usedPct: 100, resetsAt: RESET / 1000 } }), NOW, true)[1]).toMatchObject({ reset: 'Fri 14:00', counting: false })
  })

  it('the weekly limit used up counts down in days and hours, in the weekly meter', () => {
    const [five, week] = limitMeters(update({ sevenDay: { usedPct: 100, resetsAt: new Date(2026, 9, 9, 14, 0).getTime() / 1000 } }), NOW, true)
    expect(week).toMatchObject({ reset: 'in 3d 18h', counting: true, level: 'crit' })
    expect(five).toMatchObject({ reset: '21:40', counting: false })
  })

  it('the meter of the reset the tab waits for says Claude goes on by itself after it; the other one does not', () => {
    const week = new Date(2026, 9, 9, 14, 0).getTime()
    const both = update({ fiveHour: { usedPct: 100, resetsAt: RESET / 1000 }, sevenDay: { usedPct: 100, resetsAt: week / 1000 } })
    const [five, weekly] = limitMeters({ ...both, continuesAt: week }, NOW, true)
    expect(weekly!.title).toBe('resets Fri 9 Oct, 14:00, in 3 d 18 h\nused up\nClaude goes on by itself a minute after the reset (Settings → Claude Code)')
    expect(five!.title).toBe('resets at 21:40, in 2 h\nused up')
    // no wait, no such line
    expect(limitMeters(both, NOW, true).map((m) => m.title).join('\n')).not.toContain('goes on')
  })

  it('a used-up limit whose reset has passed shows its clock again and stops counting', () => {
    const five = limitMeters(update({ fiveHour: { usedPct: 100, resetsAt: RESET / 1000 } }), RESET + 1000, true)[0]
    expect(five).toMatchObject({ reset: '21:40', counting: false })
  })

  it('the levels while the pace is not known: 70% warn, 90% crit, for the limits too', () => {
    const levels = limitMeters(update({ fiveHour: { usedPct: 70, resetsAt: 0 }, sevenDay: { usedPct: 90, resetsAt: 0 } }), 0, true).map((m) => m.level)
    expect(levels).toEqual(['warn', 'crit'])
  })

  it('no status, or a status without limits, gives no meters', () => {
    expect(limitMeters(null, NOW, true)).toEqual([])
    expect(limitMeters(update({ fiveHour: null, sevenDay: null }), NOW, true)).toEqual([])
    expect(limitMeters({ tabId: 't', main: null, agents: [], background: [] }, NOW, true)).toEqual([])
  })
})
