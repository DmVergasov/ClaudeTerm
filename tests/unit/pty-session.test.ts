import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseStat, sessionAlive, waitSessionGone } from '../../src/main/pty-session'

const stat = (pid: number, comm: string, state: string, session: number): string => `${pid} (${comm}) ${state} 1 ${pid} ${session} 34816 0 -1 4194560`

function fakeProc(entries: [number, string, string, number][]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-proc-'))
  for (const [pid, comm, state, session] of entries) {
    mkdirSync(join(dir, String(pid)))
    writeFileSync(join(dir, String(pid), 'stat'), stat(pid, comm, state, session))
  }
  mkdirSync(join(dir, 'self'))
  return dir
}

describe('parseStat', () => {
  it('reads state and session after the name, even a name with spaces and parentheses', () => {
    expect(parseStat(stat(42, 'claude', 'S', 40))).toEqual({ state: 'S', session: 40 })
    expect(parseStat(stat(42, 'a) b (c', 'R', 7))).toEqual({ state: 'R', session: 7 })
    expect(parseStat('garbage')).toBeNull()
  })
})

describe('sessionAlive', () => {
  it('true while a live process belongs to the session; zombies and other sessions do not count', () => {
    expect(sessionAlive(40, fakeProc([[41, 'claude', 'S', 40], [50, 'x', 'S', 50]]))).toBe(true)
    expect(sessionAlive(40, fakeProc([[41, 'claude', 'Z', 40], [50, 'x', 'S', 50]]))).toBe(false)
    expect(sessionAlive(40, join(tmpdir(), 'no-such-proc'))).toBe(false)
  })
})

describe('waitSessionGone', () => {
  it('resolves as soon as the session is empty, or at the time limit', async () => {
    let checks = 0
    await waitSessionGone(1, 5000, () => ++checks < 3, 10)
    expect(checks).toBe(3)
    const started = Date.now()
    await waitSessionGone(1, 100, () => true, 10)
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
  })
})
