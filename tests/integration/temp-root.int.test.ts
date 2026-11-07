import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { closeTempRoot, openTempRoot, STALE_ROOT_MS, TEMP_ROOT_PREFIX } from '../fixtures/temp-root'

const DAY = 24 * 3_600_000

describe('the temp root of a test run', () => {
  it('this run writes its temp files into a root of its own, which its global setup made', () => {
    expect(basename(tmpdir()).startsWith(TEMP_ROOT_PREFIX)).toBe(true)
    expect(process.env.TEMP).toBe(tmpdir())
    expect(process.env.TMPDIR).toBe(tmpdir())
  })

  it('opens a root in the system temp folder and points TEMP, TMP and TMPDIR of the environment at it', () => {
    const system = mkdtempSync(join(tmpdir(), 'system-'))
    const env: NodeJS.ProcessEnv = { TEMP: system, PATH: 'kept' }
    const root = openTempRoot(env, system)
    expect(dirname(root)).toBe(system)
    expect(basename(root).startsWith(TEMP_ROOT_PREFIX)).toBe(true)
    expect(existsSync(root)).toBe(true)
    expect(env).toEqual({ TEMP: root, TMP: root, TMPDIR: root, PATH: 'kept' })
  })

  it('closing the root deletes it with everything in it', () => {
    const system = mkdtempSync(join(tmpdir(), 'system-'))
    const root = openTempRoot({}, system)
    mkdirSync(join(root, 'ct-e2e-a1', 'GPUCache'), { recursive: true })
    writeFileSync(join(root, 'ct-e2e-a1', 'GPUCache', 'data_0'), 'x')
    closeTempRoot(root)
    expect(existsSync(root)).toBe(false)
  })

  it('a new root deletes the roots of runs that died over a day ago, and leaves fresh roots and other folders alone', () => {
    const system = mkdtempSync(join(tmpdir(), 'system-'))
    const now = Date.now()
    const dead = join(system, `${TEMP_ROOT_PREFIX}dead01`)
    const running = join(system, `${TEMP_ROOT_PREFIX}live01`)
    const other = join(system, 'ClaudeTerm')
    for (const d of [dead, running, other]) mkdirSync(join(d, 'inner'), { recursive: true })
    const old = new Date(now - STALE_ROOT_MS - 60_000)
    utimesSync(dead, old, old)
    utimesSync(other, old, old)
    const recent = new Date(now - DAY / 2)
    utimesSync(running, recent, recent)

    openTempRoot({}, system, now)
    expect(existsSync(dead)).toBe(false)
    expect(existsSync(running)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })
})
