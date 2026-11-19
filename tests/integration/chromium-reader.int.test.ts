import { spawn as spawnReal } from 'node:child_process'
import { copyFile } from 'node:fs/promises'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportSource } from '../../src/main/browser-import/sources'
import { readChromiumCookies, type ChromiumReadDeps } from '../../src/main/browser-import/chromium-reader'
import { TEMP_PREFIX } from '../../src/main/browser-import/temp-copy'

// Invented cookies only: the values are placeholders and every domain is example.com.
// The browser is the stand-in script, run with this Node binary; no real browser folder is ever read.

// Records the options of every rm call, to check that a temp copy is removed with retries.
const rmCalls = vi.hoisted(() => [] as unknown[])
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    rm: (path: Parameters<typeof real.rm>[0], options?: Parameters<typeof real.rm>[1]) => {
      rmCalls.push(options)
      return real.rm(path, options)
    },
  }
})

const STAND_IN = join(__dirname, '..', 'fixtures', 'stand-in-browser.mjs')
const DAY = 86400
const nowS = Math.floor(Date.now() / 1000)

// Each test gets a temp root of its own: os.tmpdir() reads these variables on every call.
const TEMP_VARS = ['TMPDIR', 'TEMP', 'TMP'] as const

let root: string
let savedTemp: Record<string, string | undefined>
let userDataDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ct-chromium-'))
  savedTemp = Object.fromEntries(TEMP_VARS.map((k) => [k, process.env[k]]))
  for (const k of TEMP_VARS) process.env[k] = root
  expect(tmpdir()).toBe(root)
  userDataDir = join(root, 'Fake Browser User Data')
  mkdirSync(join(userDataDir, 'Default', 'Network'), { recursive: true })
  writeFileSync(join(userDataDir, 'Local State'), '{}')
  rmCalls.length = 0
})

afterEach(() => {
  for (const k of TEMP_VARS) {
    if (savedTemp[k] === undefined) delete process.env[k]
    else process.env[k] = savedTemp[k]
  }
  rmSync(root, { recursive: true, force: true })
})

function tempEntries(): string[] {
  return readdirSync(root).filter((e) => e.startsWith(TEMP_PREFIX)).sort()
}

function cookie(name: string, value: string, expires: number): Record<string, unknown> {
  return { name, value, domain: 'example.com', path: '/', expires, httpOnly: false, secure: true, session: false }
}

function writeCookies(list: unknown[]): void {
  writeFileSync(join(userDataDir, 'Default', 'Network', 'Cookies'), JSON.stringify(list))
}

function source(over: Partial<ImportSource> = {}): ImportSource {
  return {
    id: 'chrome:Default',
    kind: 'chrome',
    browser: 'Chrome',
    label: 'Chrome · Default',
    family: 'chromium',
    mode: 'copy',
    userDataDir,
    profileDir: join(userDataDir, 'Default'),
    profileName: 'Default',
    email: null,
    hasCookies: true,
    binary: { file: process.execPath, args: [STAND_IN] },
    ...over,
  }
}

function deps(over: Partial<ChromiumReadDeps> = {}): ChromiumReadDeps {
  return {
    spawn: spawnReal,
    copyFile: (src, dst) => copyFile(src, dst),
    onWaiting: () => {},
    signal: new AbortController().signal,
    retryMs: 10,
    ...over,
  }
}

function ebusy(): Error {
  return Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

// The pids of every browser a spawn started, so a test can check that each one is gone.
function recordingSpawn(pids: number[]): ChromiumReadDeps['spawn'] {
  return ((file: string, args: string[], options: object) => {
    const child = spawnReal(file, args, options as Parameters<typeof spawnReal>[2])
    if (child.pid !== undefined) pids.push(child.pid)
    return child
  }) as ChromiumReadDeps['spawn']
}

async function failureOf(p: Promise<unknown>): Promise<Error | null> {
  return p.then(
    () => null,
    (e: unknown) => e as Error,
  )
}

describe('readChromiumCookies', () => {
  it('reads cookies through a copy, drops the expired one and deletes the temp folder', async () => {
    writeCookies([cookie('kept-id', 'test-value-1', nowS + 30 * DAY), cookie('old-id', 'test-value-2', nowS - DAY)])
    const before = tempEntries()

    const result = await readChromiumCookies(source(), nowS, deps())

    expect(result.skipped).toBe(1)
    expect(result.cookies.map((c) => [c.name, c.value])).toEqual([['kept-id', 'test-value-1']])
    expect(result.cookies[0]).toMatchObject({ domain: 'example.com', hostOnly: true, secure: true, expires: nowS + 30 * DAY })
    expect(tempEntries()).toEqual(before)
    // the browser was started on the copy: the private folder, the profile, the pipe, and the switch of this platform
    const args = JSON.parse(readFileSync(join(root, 'stand-in-args.json'), 'utf8')) as string[]
    expect(args).toContain('--remote-debugging-pipe')
    expect(args).toContain('--profile-directory=Default')
    expect(args.some((a) => a.startsWith('--user-data-dir=') && a.includes(TEMP_PREFIX))).toBe(true)
    expect(args).toContain(process.platform === 'win32' ? '--headless=new' : '--no-startup-window')
  })

  it('removes the temp copy with retries, since a browser helper may still hold a file for a moment', async () => {
    writeCookies([cookie('kept-id', 'test-value-1', nowS + 30 * DAY)])

    await readChromiumCookies(source(), nowS, deps())

    expect(rmCalls).toContainEqual(expect.objectContaining({ recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  })

  it('waits while the cookie file is held, tells the person once and then reads', async () => {
    writeCookies([cookie('kept-id', 'test-value-1', nowS + 30 * DAY)])
    let calls = 0
    const copy = vi.fn(async (src: string, dst: string) => {
      calls++
      if (calls <= 2) throw ebusy()
      await copyFile(src, dst)
    })
    const onWaiting = vi.fn()

    const result = await readChromiumCookies(source(), nowS, deps({ copyFile: copy, onWaiting }))

    expect(onWaiting).toHaveBeenCalledTimes(1)
    expect(copy).toHaveBeenCalledTimes(3)
    expect(result.cookies.map((c) => c.name)).toEqual(['kept-id'])
  })

  it('cancel while waiting rejects with cancelled and deletes the temp folder', async () => {
    writeCookies([cookie('kept-id', 'test-value-1', nowS + 30 * DAY)])
    const controller = new AbortController()
    const copy = vi.fn(async () => {
      throw ebusy()
    })
    const onWaiting = vi.fn(() => controller.abort())

    const failure = await failureOf(readChromiumCookies(source(), nowS, deps({ copyFile: copy, onWaiting, signal: controller.signal })))

    expect(failure?.message).toBe('cancelled')
    expect(onWaiting).toHaveBeenCalledTimes(1)
    expect(tempEntries()).toEqual([])
  })

  it('cancel while the browser is asked for its cookies ends the browser and rejects with cancelled', async () => {
    writeCookies([cookie('kept-id', 'test-value-1', nowS + 30 * DAY)])
    const controller = new AbortController()
    const pids: number[] = []
    const spawnAndCancel = ((file: string, args: string[], options: object) => {
      const child = recordingSpawn(pids)(file, args, options)
      controller.abort()
      return child
    }) as ChromiumReadDeps['spawn']
    const hanging = source({ binary: { file: process.execPath, args: [STAND_IN], env: { STAND_IN_HANG: '1' } } })

    const failure = await failureOf(readChromiumCookies(hanging, nowS, deps({ spawn: spawnAndCancel, signal: controller.signal })))

    expect(failure?.message).toBe('cancelled')
    expect(pids).toHaveLength(1)
    expect(isAlive(pids[0])).toBe(false)
    expect(tempEntries()).toEqual([])
  }, 30_000)

  it('a hanging browser is ended: the call is answered with a timeout error and the process is gone', async () => {
    writeCookies([cookie('kept-id', 'test-value-1', nowS + 30 * DAY)])
    const pids: number[] = []
    const hanging = source({ binary: { file: process.execPath, args: [STAND_IN], env: { STAND_IN_HANG: 'cookies' } } })

    const failure = await failureOf(readChromiumCookies(hanging, nowS, deps({ spawn: recordingSpawn(pids) })))

    expect(failure?.message).toBe('Chrome did not answer in time')
    expect(pids).toHaveLength(1)
    expect(isAlive(pids[0])).toBe(false)
    expect(tempEntries()).toEqual([])
  }, 30_000)

  it('a browser that ignores SIGTERM and hangs is killed: the process is gone afterwards', async () => {
    writeCookies([cookie('kept-id', 'test-value-1', nowS + 30 * DAY)])
    const pids: number[] = []
    const stuck = source({ binary: { file: process.execPath, args: [STAND_IN], env: { STAND_IN_HANG: '1', STAND_IN_IGNORE_TERM: '1' } } })

    const failure = await failureOf(readChromiumCookies(stuck, nowS, deps({ spawn: recordingSpawn(pids), timeoutMs: 2_000 })))

    expect(failure?.message).toBe('Chrome did not answer in time')
    expect(pids).toHaveLength(1)
    expect(isAlive(pids[0])).toBe(false)
    expect(tempEntries()).toEqual([])
  }, 30_000)

  it('a slow first start counts against timeoutMs, not against the 10 s call limit', async () => {
    writeCookies([cookie('kept-id', 'test-value-1', nowS + 30 * DAY)])
    const pids: number[] = []
    const slow = source({ binary: { file: process.execPath, args: [STAND_IN], env: { STAND_IN_START_MS: '60000' } } })

    const failure = await failureOf(readChromiumCookies(slow, nowS, deps({ spawn: recordingSpawn(pids), timeoutMs: 1_500 })))

    expect(failure?.message).toBe('Chrome did not answer in time')
    expect(isAlive(pids[0])).toBe(false)
    expect(tempEntries()).toEqual([])
  }, 30_000)

  it('a browser that exits before it answers is reported as closed', async () => {
    writeCookies([cookie('kept-id', 'test-value-1', nowS + 30 * DAY)])
    // without Local State in the copy, the stand-in exits at once
    rmSync(join(userDataDir, 'Local State'))

    const failure = await failureOf(readChromiumCookies(source(), nowS, deps()))

    expect(failure?.message).toBe('Chrome closed before it answered')
    expect(tempEntries()).toEqual([])
  })

  it('a binary that does not exist is reported as not installed and copies nothing', async () => {
    writeCookies([cookie('kept-id', 'test-value-1', nowS + 30 * DAY)])
    const before = tempEntries()
    const missing = source({ binary: { file: join(root, 'no-such-browser'), args: [] } })

    const failure = await failureOf(readChromiumCookies(missing, nowS, deps()))

    expect(failure?.message).toBe('Chrome is not installed where ClaudeTerm looks for it')
    expect(tempEntries()).toEqual(before)
  })

  it('a missing binary rejects with the not-installed text and copies nothing', async () => {
    writeCookies([cookie('kept-id', 'test-value-1', nowS + 30 * DAY)])
    const before = tempEntries()

    await expect(readChromiumCookies(source({ binary: null }), nowS, deps())).rejects.toThrow(
      'Chrome is not installed where ClaudeTerm looks for it',
    )
    expect(tempEntries()).toEqual(before)
  })

  it('a profile without a Cookies file rejects and deletes the temp folder', async () => {
    const before = tempEntries()

    await expect(readChromiumCookies(source(), nowS, deps())).rejects.toThrow('Chrome has no cookies in this profile')
    expect(tempEntries()).toEqual(before)
  })
})
