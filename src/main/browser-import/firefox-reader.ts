import { access } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fromFirefox, type FirefoxRow, type ImportedCookie } from './cookie-map'
import { TEMP_PREFIX, copyIfExists, makePrivateTemp, removeTemp } from './temp-copy'

const DB_NAME = 'cookies.sqlite'

/**
 * The cookies of a Firefox profile. The database is copied first, with its WAL and shared-memory files, so the
 * running Firefox keeps its lock and the copy holds the rows still in the WAL.
 */
export async function readFirefoxCookies(profileDir: string, nowS: number): Promise<{ cookies: ImportedCookie[]; skipped: number }> {
  if (!(await exists(join(profileDir, DB_NAME)))) return { cookies: [], skipped: 0 }
  const tmp = await makePrivateTemp(TEMP_PREFIX)
  let db: DatabaseSync | null = null
  try {
    const copy = join(tmp, DB_NAME)
    await copyIfExists(join(profileDir, DB_NAME), copy)
    await copyIfExists(join(profileDir, `${DB_NAME}-wal`), `${copy}-wal`)
    await copyIfExists(join(profileDir, `${DB_NAME}-shm`), `${copy}-shm`)
    db = new DatabaseSync(copy)
    const rows = db.prepare(selectSql(db)).all() as unknown as FirefoxRow[]
    const cookies: ImportedCookie[] = []
    let skipped = 0
    for (const row of rows) {
      const cookie = fromFirefox(row, nowS)
      if (cookie) cookies.push(cookie)
      else skipped++
    }
    return { cookies, skipped }
  } catch (e) {
    // the message names the profile folder and the error code only: the original message may echo a cookie value
    throw new Error(`Could not read Firefox cookies from "${basename(profileDir)}"${errorCode(e)}.`)
  } finally {
    try {
      db?.close()
    } catch {
      // the copy is deleted below either way
    }
    await removeTemp(tmp)
  }
}

// isPartitionedAttributeSet came with a later Firefox, so it is selected only when the table has it.
function selectSql(db: DatabaseSync): string {
  const columns = db.prepare('PRAGMA table_info(moz_cookies)').all().map((c) => String(c.name))
  const partitioned = columns.includes('isPartitionedAttributeSet') ? ', isPartitionedAttributeSet' : ''
  return `SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes${partitioned} FROM moz_cookies`
}

// " (EBUSY)" for an error with a code (a file error or a sqlite error), or "" when there is none.
function errorCode(e: unknown): string {
  const err = (typeof e === 'object' && e !== null ? e : {}) as { code?: unknown; errcode?: unknown }
  const code = err.code ?? err.errcode
  return typeof code === 'string' || typeof code === 'number' ? ` (${code})` : ''
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}
