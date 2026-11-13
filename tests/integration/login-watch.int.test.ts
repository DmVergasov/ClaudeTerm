import { pbkdf2 } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LoginWatch } from '../../src/main/login-watch'

const login = (accountUuid: string, more: object = {}): string =>
  JSON.stringify({ numStartups: 3, ...more, oauthAccount: { accountUuid, organizationUuid: 'org-1', organizationType: 'claude_max' } })

describe('LoginWatch', () => {
  let dir: string
  let file: string
  let watch: LoginWatch | null = null
  let changes = 0

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ct-login-'))
    file = join(dir, '.claude.json')
    changes = 0
  })
  afterEach(() => {
    watch?.stop()
    watch = null
    rmSync(dir, { recursive: true, force: true })
  })

  const start = async (): Promise<LoginWatch> => {
    watch = new LoginWatch(file, () => { changes += 1 }, 20)
    await watch.start()
    return watch
  }

  it('tells of another login and of a logout, not of the login it started with nor of anything else the file holds', async () => {
    writeFileSync(file, login('acc-1'))
    const w = await start()
    expect(changes).toBe(0)
    writeFileSync(file, login('acc-1', { numStartups: 4, projects: { work: {} } }))
    await w.check()
    expect(changes).toBe(0)
    writeFileSync(file, login('acc-2'))
    await w.check()
    expect(changes).toBe(1)
    writeFileSync(file, JSON.stringify({ numStartups: 5 }))
    await w.check()
    expect(changes).toBe(2)
  })

  it('a file caught half written, or gone, tells nothing: the login it held stays the one compared with', async () => {
    writeFileSync(file, login('acc-1'))
    const w = await start()
    writeFileSync(file, login('acc-1').slice(0, 30))
    await w.check()
    rmSync(file)
    await w.check()
    writeFileSync(file, login('acc-1'))
    await w.check()
    expect(changes).toBe(0)
  })

  it('sees a /login by itself, without being asked', async () => {
    writeFileSync(file, login('acc-1'))
    await start()
    writeFileSync(file, login('acc-2'))
    await expect.poll(() => changes).toBe(1)
  })

  it('sees a /login written right after the watch started, while the file system answers late', async () => {
    // a loaded machine: the thread pool that answers file reads stays busy, every job that ends starts another
    let busy = true
    const job = (): void => pbkdf2('x', 'y', 3000, 32, 'sha256', () => { if (busy) job() })
    for (let k = 0; k < 4; k++) job()
    const watches: LoginWatch[] = []
    try {
      for (let i = 0; i < 10; i++) {
        const at = join(dir, `${i}.json`)
        writeFileSync(at, login('acc-1'))
        let seen = 0
        const w = new LoginWatch(at, () => { seen += 1 }, 20)
        watches.push(w)
        await w.start()
        writeFileSync(at, login('acc-2'))
        await expect.poll(() => seen, { timeout: 3000 }).toBe(1)
      }
    } finally {
      busy = false
      for (const w of watches) w.stop()
    }
  })

  it('tells nothing once stopped', async () => {
    writeFileSync(file, login('acc-1'))
    const w = await start()
    w.stop()
    writeFileSync(file, login('acc-2'))
    await w.check()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(changes).toBe(0)
  })
})
