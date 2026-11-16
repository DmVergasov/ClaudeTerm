import { describe, expect, it } from 'vitest'
import { buy, catchUp, click, newClicker, price, rate, shortNumber } from '../../src/renderer/games/clicker-rules'
import type { ClickerSave } from '../../src/shared/games'

const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

function save(lines: number, helpers: number[], at = NOW): ClickerSave {
  return { lines, helpers, at }
}

describe('clicker rules', () => {
  it('a click writes a line', () => {
    const s = newClicker(NOW)
    expect(click(s).lines).toBe(1)
    expect(s.lines).toBe(0)
  })

  it('prices grow by 15% per helper owned', () => {
    expect(price(save(0, [0, 0, 0, 0]), 0)).toBe(15)
    expect(price(save(0, [1, 0, 0, 0]), 0)).toBe(18)
    expect(price(save(0, [2, 0, 0, 0]), 0)).toBe(20)
  })

  it('buying spends the price and raises the rate; too poor is null', () => {
    const bought = buy(save(15, [0, 0, 0, 0]), 0)
    expect(bought).not.toBeNull()
    expect(bought!.lines).toBe(0)
    expect(rate(bought!)).toBe(1)
    expect(buy(save(14, [0, 0, 0, 0]), 0)).toBeNull()
  })

  it('catching up adds what the helpers wrote', () => {
    const s = save(0, [2, 1, 0, 0])
    expect(rate(s)).toBe(10)
    const { save: caught, earned, away } = catchUp(s, NOW + 30_000)
    expect(earned).toBe(300)
    expect(away).toBe(30_000)
    expect(caught.lines).toBe(300)
    expect(caught.at).toBe(NOW + 30_000)
  })

  it('an absence counts for at most 8 hours', () => {
    const { earned, away } = catchUp(save(0, [2, 1, 0, 0]), NOW + 10 * HOUR)
    expect(earned).toBe(288000)
    expect(away).toBe(10 * HOUR)
  })

  it('a clock that went back earns nothing and loses nothing', () => {
    const s = save(42, [2, 1, 0, 0], NOW)
    const { save: caught, earned } = catchUp(s, NOW - 5_000)
    expect(earned).toBe(0)
    expect(caught.lines).toBe(42)
    expect(caught.at).toBe(NOW - 5_000)
  })

  it('short numbers', () => {
    expect(shortNumber(999)).toBe('999')
    expect(shortNumber(1000)).toBe('1K')
    expect(shortNumber(12400)).toBe('12.4K')
    expect(shortNumber(12449)).toBe('12.4K')
    expect(shortNumber(3_100_000)).toBe('3.1M')
    expect(shortNumber(2.5e9)).toBe('2.5B')
  })
})
