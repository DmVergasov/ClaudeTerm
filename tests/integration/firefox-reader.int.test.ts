import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFirefoxCookies } from '../../src/main/browser-import/firefox-reader'
import { TEMP_PREFIX, makePrivateTemp, removeStaleTemps } from '../../src/main/browser-import/temp-copy'
import { WIN } from '../fixtures/platform'

// Invented rows only: the values are placeholders and every host is example.com.

// Makes chmod fail on demand, to test that a failed chmod leaves no folder behind.
const chmodFault = vi.hoisted(() => ({ fail: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    chmod: (...args: Parameters<typeof real.chmod>) =>
      chmodFault.fail ? Promise.reject(Object.assign(new Error('EPERM: chmod refused'), { code: 'EPERM' })) : real.chmod(...args),
  }
})

const nowS = Math.floor(Date.now() / 1000)
const DAY = 86400

// The real moz_cookies columns of Firefox
const COLUMNS = `id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT,
  expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0,
  sameSite INTEGER DEFAULT 0, rawSameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0, isPartitionedAttributeSet INTEGER DEFAULT 0`

const COLUMNS_OLD = COLUMNS.replace(/,\s*isPartitionedAttributeSet INTEGER DEFAULT 0/, '')

// Each test gets a temp root of its own: os.tmpdir() reads these variables on every call.
const TEMP_VARS = ['TMPDIR', 'TEMP', 'TMP'] as const

let root: string
let profile: string
let writer: DatabaseSync | null
let savedTemp: Record<string, string | undefined>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ct-ffr-'))
  savedTemp = Object.fromEntries(TEMP_VARS.map((k) => [k, process.env[k]]))
  for (const k of TEMP_VARS) process.env[k] = root
  expect(tmpdir()).toBe(root)
  profile = join(root, 'abc.default-release')
  mkdirSync(profile)
  writer = null
})

afterEach(() => {
  writer?.close()
  writer = null
  for (const k of TEMP_VARS) {
    if (savedTemp[k] === undefined) delete process.env[k]
    else process.env[k] = savedTemp[k]
  }
  rmSync(root, { recursive: true, force: true })
})

function tempEntries(): string[] {
  return readdirSync(root).filter((e) => e.startsWith(TEMP_PREFIX)).sort()
}

// Writes the rows through a connection that stays open, so the rows live only in cookies.sqlite-wal.
function writeProfile(columns: string, insert: (db: DatabaseSync) => void): void {
  writer = new DatabaseSync(join(profile, 'cookies.sqlite'))
  writer.exec('PRAGMA journal_mode = WAL')
  writer.exec(`CREATE TABLE moz_cookies (${columns})`)
  insert(writer)
}

const INSERT = `INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite, isPartitionedAttributeSet)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

describe('readFirefoxCookies', () => {
  it('reads the rows still in the WAL, maps the usable one and counts the container and expired rows as skipped', async () => {
    writeProfile(COLUMNS, (db) => {
      const insert = db.prepare(INSERT)
      insert.run('', 'session-id', 'test-value-1', '.example.com', '/', nowS + 30 * DAY, 1, 1, 1, 0)
      insert.run('^userContextId=1', 'container-id', 'test-value-2', 'example.com', '/', nowS + 30 * DAY, 0, 0, 0, 0)
      insert.run('', 'old-id', 'test-value-3', 'example.com', '/', nowS - DAY, 0, 0, 0, 0)
    })
    expect(existsSync(join(profile, 'cookies.sqlite-wal'))).toBe(true)
    expect(statSync(join(profile, 'cookies.sqlite-wal')).size).toBeGreaterThan(0)
    const before = tempEntries()

    const result = await readFirefoxCookies(profile, nowS)

    expect(result.skipped).toBe(2)
    expect(result.cookies).toHaveLength(1)
    expect(result.cookies[0]).toMatchObject({
      name: 'session-id',
      domain: '.example.com',
      hostOnly: false,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expires: nowS + 30 * DAY,
    })
    expect(result.cookies[0].value).toBe('test-value-1')
    expect(tempEntries()).toEqual(before)
  })

  it('reads a database from an older Firefox that has no isPartitionedAttributeSet column', async () => {
    writeProfile(COLUMNS_OLD, (db) => {
      db.prepare('INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('', 'plain-id', 'test-value-1', 'example.com', '/', 0, 0, 0, 0)
    })

    const result = await readFirefoxCookies(profile, nowS)

    expect(result.skipped).toBe(0)
    expect(result.cookies.map((c) => c.name)).toEqual(['plain-id'])
  })

  it('returns no cookies and no skips when the profile has no cookies.sqlite', async () => {
    expect(await readFirefoxCookies(profile, nowS)).toEqual({ cookies: [], skipped: 0 })
  })

  it('throws an error that names the profile folder and the error code, never the file contents, and leaves no temp copy', async () => {
    const junk = 'this is not a database, and nothing in it is a cookie'
    writeFileSync(join(profile, 'cookies.sqlite'), junk.repeat(20))
    const before = tempEntries()

    const failure = await readFirefoxCookies(profile, nowS).then(
      () => null,
      (e: unknown) => e as Error,
    )

    expect(failure).toBeInstanceOf(Error)
    expect(failure?.message).toMatch(/^Could not read Firefox cookies from "abc\.default-release" \(\S+\)\.$/)
    expect(failure?.message).not.toContain('nothing in it is a cookie')
    expect(tempEntries()).toEqual(before)
  })
})

describe('removeStaleTemps', () => {
  it('deletes a planted leftover folder of this import and leaves other folders in the temp root alone', async () => {
    const stale = join(root, `${TEMP_PREFIX}x`)
    const other = join(root, 'ct-other-keep-x')
    mkdirSync(stale)
    writeFileSync(join(stale, 'cookies.sqlite'), '')
    // an hour old: an import's copy lives about two minutes, so an old folder is a leftover
    const hourAgo = new Date(Date.now() - 60 * 60_000)
    utimesSync(stale, hourAgo, hourAgo)
    mkdirSync(other)

    await removeStaleTemps()

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('keeps a young copy of another ClaudeTerm run, which may be in the middle of its import', async () => {
    const young = join(root, `${TEMP_PREFIX}young`)
    const old = join(root, `${TEMP_PREFIX}old`)
    mkdirSync(young)
    mkdirSync(old)
    const hourAgo = new Date(Date.now() - 60 * 60_000)
    utimesSync(old, hourAgo, hourAgo)
    const twoMinutesAgo = new Date(Date.now() - 2 * 60_000)
    utimesSync(young, twoMinutesAgo, twoMinutesAgo)

    await removeStaleTemps()

    expect(existsSync(old)).toBe(false)
    expect(existsSync(young)).toBe(true)
  })
})

describe('makePrivateTemp', () => {
  it('creates an empty folder of this import under tmpdir(), private to the user where the platform allows it', async () => {
    const dir = await makePrivateTemp(TEMP_PREFIX)

    expect(dir.startsWith(root)).toBe(true)
    expect(readdirSync(dir)).toEqual([])
    if (!WIN) expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it.runIf(!WIN)('a failed chmod removes the new folder before the error is rethrown', async () => {
    chmodFault.fail = true
    try {
      await expect(makePrivateTemp(TEMP_PREFIX)).rejects.toThrow('EPERM')
    } finally {
      chmodFault.fail = false
    }
    expect(tempEntries()).toEqual([])
  })
})
