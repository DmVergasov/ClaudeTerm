import { describe, expect, it } from 'vitest'
import { ToolActivity } from '../../src/main/tool-activity'

const T = Date.parse('2026-10-06T12:00:00.000Z')
const MIN = 60_000

describe('ToolActivity', () => {
  it('a tool runs from its tool_use to its tool_result, with a little slack at both ends', () => {
    const a = new ToolActivity()
    a.start('t1', T)
    a.end('t1', T + 5000)
    expect(a.runningAt(T + 2000)).toBe(true)
    expect(a.runningAt(T - 1000)).toBe(true)
    expect(a.runningAt(T + 6000)).toBe(true)
    expect(a.runningAt(T - 5000)).toBe(false)
    expect(a.runningAt(T + 10_000)).toBe(false)
  })

  it('a tool without a result yet runs from its start on', () => {
    const a = new ToolActivity()
    a.start('t1', T)
    expect(a.runningAt(T + 30 * MIN)).toBe(true)
    expect(a.runningAt(T - 5000)).toBe(false)
  })

  it('a tool left open for over two hours no longer counts (the session was interrupted)', () => {
    const a = new ToolActivity()
    a.start('t1', T)
    expect(a.runningAt(T + 121 * MIN)).toBe(false)
  })

  it('a result for an unknown tool is ignored', () => {
    const a = new ToolActivity()
    a.end('nope', T)
    expect(a.runningAt(T)).toBe(false)
  })

  it('forgets tools that finished more than ten minutes before the latest one', () => {
    const a = new ToolActivity()
    for (let i = 0; i < 50; i++) {
      a.start(`old${i}`, T + i)
      a.end(`old${i}`, T + i + 100)
    }
    a.start('new', T + 20 * MIN)
    a.end('new', T + 20 * MIN + 100)
    expect(a.tracked).toBe(1)
    expect(a.runningAt(T + 20 * MIN + 50)).toBe(true)
  })
})
