import type { StatusUpdate } from '../shared/ipc'
import { dayAndTime, duration, FIVE_HOURS_MS, hoursAndMinutes, levelFor, limitPace, SEVEN_DAYS_MS, WEEKDAYS, type Level } from './status-bar'

/** one of the usage limits, as the title bar draws it */
export interface LimitMeter {
  key: 'limit' | 'week'
  label: '5-HOUR' | 'WEEKLY'
  /** '24%' */
  pct: string
  /** the reset as a clock: '18:40' today, 'Thu 09:00' on another day; the time to it, 'in 2h 05m', while the limit is used up */
  reset: string
  /** the reset counts down: the limit is used up and its reset is to come, so the meter is drawn again each second */
  counting: boolean
  /** today's segment tooltip, unchanged: 'resets at 18:40, in 1 h' plus the pace line */
  title: string
  level: Level
  /** null with claude.limitPace off */
  bar: { used: number; elapsed: number } | null
}

/** the time to a moment, as a countdown shows it: 3d 18h, 2h 05m, 25m 05s, 42s */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const two = (n: number): string => String(n).padStart(2, '0')
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${two(m)}m`
  if (m > 0) return `${m}m ${two(s % 60)}s`
  return `${s}s`
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
 * no bar and no forecast, and the color from the fixed 70% and 90%. A used-up limit counts down to its reset; the reset the
 * tab waits for (`wait`) says when Claude goes on by itself after it, and between the reset and that moment the meter counts
 * down to it.
 */
function meter(key: LimitMeter['key'], label: LimitMeter['label'], limit: { usedPct: number; resetsAt: number }, windowMs: number, now: number, at: (d: Date) => string, paced: boolean, wait: { resetsAt: number; goesOnAt: number } | null): LimitMeter {
  const reset = limit.resetsAt * 1000
  const lines = [`resets ${at(new Date(reset))}${reset > now ? `, in ${duration(reset - now)}` : ''}`]
  if (limit.usedPct >= 100) lines.push('used up')
  const goesOnAt = wait?.resetsAt === reset && wait.goesOnAt > now ? wait.goesOnAt : null
  if (goesOnAt !== null) lines.push(`Claude goes on by itself at ${resetClock(goesOnAt, now)} (Settings → Claude Code)`)
  const pct = `${Math.round(limit.usedPct)}%`
  const toReset = limit.usedPct >= 100 && reset > now
  const counting = toReset || goesOnAt !== null
  const clock = toReset ? `in ${countdown(reset - now)}` : goesOnAt !== null ? `goes on in ${countdown(goesOnAt - now)}` : resetClock(reset, now)
  if (!paced) return { key, label, pct, reset: clock, counting, title: lines.join('\n'), level: levelFor(limit.usedPct), bar: null }
  // a limit used up has no forecast
  const pace = limitPace(limit.usedPct, limit.resetsAt, windowMs, now)
  if (pace.runsOutAt !== null) lines.push(`at this pace: runs out ${at(new Date(pace.runsOutAt))}, ${duration(reset - pace.runsOutAt)} before the reset`)
  else if (pace.atReset !== null) lines.push(`at this pace: lasts until the reset, about ${Math.round(pace.atReset)}% by then`)
  return {
    key,
    label,
    pct,
    reset: clock,
    counting,
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
  const wait = typeof u?.continuesAt === 'number' && typeof u.goesOnAt === 'number' ? { resetsAt: u.continuesAt, goesOnAt: u.goesOnAt } : null
  if (main.fiveHour) meters.push(meter('limit', '5-HOUR', main.fiveHour, FIVE_HOURS_MS, now, (d) => `at ${hoursAndMinutes(d)}`, paced, wait))
  if (main.sevenDay) meters.push(meter('week', 'WEEKLY', main.sevenDay, SEVEN_DAYS_MS, now, dayAndTime, paced, wait))
  return meters
}
