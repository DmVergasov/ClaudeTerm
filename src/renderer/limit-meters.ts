import type { StatusUpdate } from '../shared/ipc'
import { dayAndTime, duration, FIVE_HOURS_MS, hoursAndMinutes, levelFor, limitPace, SEVEN_DAYS_MS, WEEKDAYS, type Level } from './status-bar'

/** one of the usage limits, as the title bar draws it */
export interface LimitMeter {
  key: 'limit' | 'week'
  label: '5-HOUR' | 'WEEKLY'
  /** '24%' */
  pct: string
  /** the reset as a clock: '18:40' today, 'Thu 09:00' on another day */
  reset: string
  /** today's segment tooltip, unchanged: 'resets at 18:40, in 1 h' plus the pace line */
  title: string
  level: Level
  /** null with claude.limitPace off */
  bar: { used: number; elapsed: number } | null
}

/** the reset as a clock: the time alone on the same day, else the weekday and the time */
export function resetClock(resetMs: number, now: number): string {
  const reset = new Date(resetMs)
  const clock = hoursAndMinutes(reset)
  const today = new Date(now)
  const sameDay = reset.getFullYear() === today.getFullYear() && reset.getMonth() === today.getMonth() && reset.getDate() === today.getDate()
  return sameDay ? clock : `${WEEKDAYS[reset.getDay()]} ${clock}`
}

/**
 * a usage limit's meter: its color, forecast and bar from the pace it is spent at; with `paced` off (claude.limitPace),
 * no bar and no forecast, and the color from the fixed 70% and 90%
 */
function meter(key: LimitMeter['key'], label: LimitMeter['label'], limit: { usedPct: number; resetsAt: number }, windowMs: number, now: number, at: (d: Date) => string, paced: boolean): LimitMeter {
  const reset = limit.resetsAt * 1000
  const lines = [`resets ${at(new Date(reset))}${reset > now ? `, in ${duration(reset - now)}` : ''}`]
  if (limit.usedPct >= 100) lines.push('used up')
  const pct = `${Math.round(limit.usedPct)}%`
  const clock = resetClock(reset, now)
  if (!paced) return { key, label, pct, reset: clock, title: lines.join('\n'), level: levelFor(limit.usedPct), bar: null }
  // a limit used up has no forecast
  const pace = limitPace(limit.usedPct, limit.resetsAt, windowMs, now)
  if (pace.runsOutAt !== null) lines.push(`at this pace: runs out ${at(new Date(pace.runsOutAt))}, ${duration(reset - pace.runsOutAt)} before the reset`)
  else if (pace.atReset !== null) lines.push(`at this pace: lasts until the reset, about ${Math.round(pace.atReset)}% by then`)
  return {
    key,
    label,
    pct,
    reset: clock,
    title: lines.join('\n'),
    level: pace.level,
    bar: { used: Math.min(100, Math.max(0, Math.round(limit.usedPct))), elapsed: Math.round(pace.elapsed * 100) }
  }
}

/** the 5-hour and the weekly limit of the tab's Claude status, in that order; none for a shell tab or a status without limits */
export function limitMeters(u: StatusUpdate | null, now: number, paced: boolean): LimitMeter[] {
  const main = u?.main
  if (!main) return []
  const meters: LimitMeter[] = []
  if (main.fiveHour) meters.push(meter('limit', '5-HOUR', main.fiveHour, FIVE_HOURS_MS, now, (d) => `at ${hoursAndMinutes(d)}`, paced))
  if (main.sevenDay) meters.push(meter('week', 'WEEKLY', main.sevenDay, SEVEN_DAYS_MS, now, dayAndTime, paced))
  return meters
}
