import type { ClickerSave } from '../../shared/games'

export const HELPERS = [
  { name: 'Intern', cost: 15, rate: 1 },
  { name: 'Agent', cost: 100, rate: 8 },
  { name: 'Server', cost: 1100, rate: 47 },
  { name: 'Data center', cost: 12000, rate: 260 }
] as const

/** each owned helper of a kind makes the next one of that kind dearer by 15% */
export const PRICE_GROWTH = 1.15

/** the most an absence can earn for: 8 hours */
export const AWAY_CAP_MS = 8 * 60 * 60 * 1000

/** an absence shorter than this gets no "while you were away" line */
export const AWAY_NOTE_MS = 60_000

const SUFFIXES: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K']
]

/** a clicker with no lines and no helpers, brought up to date at now */
export function newClicker(now: number): ClickerSave {
  return { lines: 0, helpers: [0, 0, 0, 0], at: now }
}

/** lines per second: each owned helper writes its rate */
export function rate(s: ClickerSave): number {
  return HELPERS.reduce((sum, h, i) => sum + h.rate * s.helpers[i], 0)
}

/** what the next helper of this kind costs: the base cost grows 15% for each one already owned */
export function price(s: ClickerSave, helper: number): number {
  return Math.ceil(HELPERS[helper].cost * PRICE_GROWTH ** s.helpers[helper])
}

/** one click writes one line; the input is not changed */
export function click(s: ClickerSave): ClickerSave {
  return { ...s, helpers: s.helpers.slice(), lines: s.lines + 1 }
}

/** buys one helper of this kind; null when there are not enough lines; the input is not changed */
export function buy(s: ClickerSave, helper: number): ClickerSave | null {
  const cost = price(s, helper)
  if (s.lines < cost) return null
  const helpers = s.helpers.slice()
  helpers[helper] += 1
  return { lines: s.lines - cost, helpers, at: s.at }
}

/** brings lines up to `now`: away = max(0, now - at); earned = rate × min(away, AWAY_CAP_MS) / 1000; at = now */
export function catchUp(s: ClickerSave, now: number): { save: ClickerSave; earned: number; away: number } {
  const away = Math.max(0, now - s.at)
  const earned = (rate(s) * Math.min(away, AWAY_CAP_MS)) / 1000
  return { save: { lines: s.lines + earned, helpers: s.helpers.slice(), at: now }, earned, away }
}

/** a count for display: 999, 1K, 12.4K, 3.1M, 2.5B; floors first, keeps one decimal and drops a trailing .0 */
export function shortNumber(n: number): string {
  const whole = Math.floor(n)
  for (const [unit, suffix] of SUFFIXES) {
    if (whole >= unit) {
      const tenths = Math.floor((whole * 10) / unit)
      const decimal = tenths % 10 === 0 ? '' : `.${tenths % 10}`
      return `${Math.floor(tenths / 10)}${decimal}${suffix}`
    }
  }
  return String(whole)
}
