import { describe, expect, it } from 'vitest'
import { isId, isIdList, isImageAction, isOptionalTitle, isPtyData, isPtySize, isUserInput } from '../../src/main/ipc-guards'

describe('ipc guards', () => {
  it('isId accepts only strings', () => {
    expect(isId('abc')).toBe(true)
    expect(isId(1)).toBe(false)
    expect(isId(undefined)).toBe(false)
    expect(isId({})).toBe(false)
  })

  it('isPtySize accepts integers in 1..4000 only', () => {
    expect(isPtySize(120, 30)).toBe(true)
    expect(isPtySize(4000, 4000)).toBe(true)
    expect(isPtySize(0, 30)).toBe(false)
    expect(isPtySize(120, -1)).toBe(false)
    expect(isPtySize(NaN, 30)).toBe(false)
    expect(isPtySize(1.5, 30)).toBe(false)
    expect(isPtySize(4001, 30)).toBe(false)
    expect(isPtySize('80', 30)).toBe(false)
    expect(isPtySize(Infinity, 30)).toBe(false)
  })

  it('isUserInput ignores terminal-generated reports', () => {
    expect(isUserInput('a')).toBe(true)
    expect(isUserInput('\r')).toBe(true)
    expect(isUserInput('\x1b[A')).toBe(true)
    expect(isUserInput('\x1b[I')).toBe(false)
    expect(isUserInput('\x1b[O')).toBe(false)
    expect(isUserInput('\x1b[?1;2c')).toBe(false)
    expect(isUserInput('\x1b[12;40R')).toBe(false)
    expect(isUserInput('\x1b[I\x1b[O')).toBe(false)
    expect(isUserInput('\x1b[Ia')).toBe(true)
  })

  it('isPtyData accepts only strings', () => {
    expect(isPtyData('x')).toBe(true)
    expect(isPtyData('')).toBe(true)
    expect(isPtyData(5)).toBe(false)
    expect(isPtyData(null)).toBe(false)
  })

  it('isIdList accepts arrays of strings', () => {
    expect(isIdList(['a', 'b'])).toBe(true)
    expect(isIdList(['a', 1])).toBe(false)
    expect(isIdList('a')).toBe(false)
  })

  it('isOptionalTitle accepts string or null', () => {
    expect(isOptionalTitle('t')).toBe(true)
    expect(isOptionalTitle(null)).toBe(true)
    expect(isOptionalTitle(undefined)).toBe(false)
    expect(isOptionalTitle(3)).toBe(false)
  })

  it('isImageAction accepts only known actions', () => {
    for (const a of ['open', 'reveal', 'copy-image', 'copy-path', 'remove']) expect(isImageAction(a)).toBe(true)
    expect(isImageAction('rm')).toBe(false)
    expect(isImageAction(undefined)).toBe(false)
    expect(isImageAction(1)).toBe(false)
  })
})
