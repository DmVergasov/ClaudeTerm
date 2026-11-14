import { describe, expect, it } from 'vitest'
import { AccountChecks, RECHECK_MS, STATUS_TIMEOUT_MS, type AccountChecksDeps } from '../../src/main/account-checks'
import { NO_IDENTITY, parseAuthStatus, type AuthStatus, type Identity } from '../../src/main/account-login'

const ORG = '0b6f3c2e-4d5a-4e6f-8a7b-9c0d1e2f3a4b'

// the account file's login of a team account (invented values)
const FILE_LOGIN: Identity = { email: 'work@example.com', orgName: 'Example Team', orgUuid: ORG, plan: 'team' }

// `claude auth status --json` of a signed-in run: the email and the organization, no plan
const SIGNED_IN_STDOUT = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'work@example.com', orgName: 'Example Team' })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakes(over: Partial<AccountChecksDeps> = {}) {
  const log = { status: [] as string[], identity: [] as string[], changed: 0 }
  let now = 0
  const deps: AccountChecksDeps = {
    status: async (folder) => {
      log.status.push(folder)
      return parseAuthStatus({ code: 0, stdout: SIGNED_IN_STDOUT })
    },
    identity: async (folder) => {
      log.identity.push(folder)
      return FILE_LOGIN
    },
    isDir: async () => true,
    now: () => now,
    changed: () => {
      log.changed++
    },
    ...over
  }
  return { deps, log, setNow: (t: number) => (now = t) }
}

describe('account checks', () => {
  it('a folder that is gone is missing, without running Claude Code', async () => {
    const { deps, log } = fakes({ isDir: async () => false })
    const checks = new AccountChecks(deps)

    const check = await checks.check('a', 'gone')

    expect(check).toMatchObject({ state: 'missing', checking: false, identity: NO_IDENTITY })
    expect(log.status).toEqual([])
    expect(log.identity).toEqual([])
  })

  it('signed in is ready with who and the plan, from .claude.json where auth status has none', async () => {
    const checks = new AccountChecks(fakes().deps)

    const check = await checks.check('a', 'work')

    expect(check.state).toBe('ready')
    expect(check.identity).toEqual({ email: 'work@example.com', orgName: 'Example Team', orgUuid: ORG, plan: 'team' })
  })

  it('exit 1 is signed out', async () => {
    const { deps } = fakes({ status: async () => parseAuthStatus({ code: 1, stdout: '' }) })
    const checks = new AccountChecks(deps)

    const check = await checks.check('a', 'work')

    expect(check).toMatchObject({ state: 'signed-out', checking: false })
  })

  it('a timeout or an answer that cannot be read is unknown', async () => {
    const timeout: AuthStatus = { state: 'unknown', reason: 'timed out' }
    const timedOut = new AccountChecks(fakes({ status: async () => timeout }).deps)
    const unreadable = new AccountChecks(fakes({ status: async () => parseAuthStatus({ code: 0, stdout: 'not json' }) }).deps)

    expect(await timedOut.check('a', 'work')).toMatchObject({ state: 'unknown', checking: false, identity: FILE_LOGIN })
    expect(await unreadable.check('a', 'work')).toMatchObject({ state: 'unknown', checking: false, identity: FILE_LOGIN })
  })

  it('an account is unknown and checking until its first answer', async () => {
    const answer = deferred<AuthStatus>()
    const checks = new AccountChecks(fakes({ status: () => answer.promise }).deps)

    expect(checks.get('a')).toEqual({ state: 'unknown', checking: true, identity: NO_IDENTITY, at: null })

    const running = checks.check('a', 'work')
    expect(checks.get('a')).toMatchObject({ state: 'unknown', checking: true })

    answer.resolve(parseAuthStatus({ code: 1, stdout: '' }))
    await running
    expect(checks.get('a')).toMatchObject({ state: 'signed-out', checking: false })
  })

  it("one check at a time per account: a second ask gets the running one's answer", async () => {
    const answer = deferred<AuthStatus>()
    const statusCalls: string[] = []
    const checks = new AccountChecks(
      fakes({
        status: async (folder) => {
          statusCalls.push(folder)
          return answer.promise
        }
      }).deps
    )

    const first = checks.check('a', 'work')
    const second = checks.check('a', 'work')
    answer.resolve(parseAuthStatus({ code: 0, stdout: SIGNED_IN_STDOUT }))

    expect(await second).toEqual(await first)
    expect(statusCalls).toEqual(['work'])
  })

  it('a rejected status or identity is unknown, and nothing throws', async () => {
    const statusFails = new AccountChecks(fakes({ status: () => Promise.reject(new Error('boom')) }).deps)
    const identityFails = new AccountChecks(fakes({ identity: () => Promise.reject(new Error('boom')) }).deps)

    expect(await statusFails.check('a', 'work')).toMatchObject({ state: 'unknown', identity: FILE_LOGIN })
    expect(await identityFails.check('a', 'work')).toMatchObject({ state: 'ready', identity: { email: 'work@example.com', orgName: 'Example Team', orgUuid: null, plan: null } })
  })

  it('checkStale checks only the accounts not checked within a minute', async () => {
    const { deps, log, setNow } = fakes()
    const checks = new AccountChecks(deps)

    setNow(0)
    await checks.check('a', 'folder-a')
    setNow(30_000)
    await checks.check('b', 'folder-b')

    setNow(RECHECK_MS)
    checks.checkStale([
      { id: 'a', folder: 'folder-a' },
      { id: 'b', folder: 'folder-b' },
      { id: 'c', folder: 'folder-c' }
    ])
    await new Promise((resolve) => setImmediate(resolve))

    // the two checks above, then only a (last answer a minute ago) and c (never checked); b was checked 30 s ago
    expect(log.status).toEqual(['folder-a', 'folder-b', 'folder-a', 'folder-c'])
  })

  it('checkStale leaves alone an account whose check is running', async () => {
    const answer = deferred<AuthStatus>()
    const statusCalls: string[] = []
    const checks = new AccountChecks(
      fakes({
        status: async (folder) => {
          statusCalls.push(folder)
          return answer.promise
        }
      }).deps
    )

    const running = checks.check('a', 'work')
    checks.checkStale([{ id: 'a', folder: 'work' }])
    answer.resolve(parseAuthStatus({ code: 1, stdout: '' }))
    await running

    expect(statusCalls).toEqual(['work'])
  })

  it('changed is told when something changed, not when nothing did', async () => {
    const { deps, log } = fakes()
    const checks = new AccountChecks(deps)

    checks.get('a')
    expect(log.changed).toBe(0)

    checks.confirmed('a', FILE_LOGIN)
    expect(log.changed).toBe(1)

    checks.confirmed('a', { ...FILE_LOGIN })
    expect(log.changed).toBe(1)

    await checks.check('a', 'work')
    expect(log.changed).toBe(1)
  })

  it('confirmed is ready with the identity and runs no CLI', async () => {
    const { deps, log } = fakes()
    const checks = new AccountChecks(deps)

    checks.confirmed('a', FILE_LOGIN)

    expect(checks.get('a')).toMatchObject({ state: 'ready', checking: false, identity: FILE_LOGIN })
    expect(log.status).toEqual([])
  })

  it('forget drops what is known: a later get is unknown and checking again', async () => {
    const checks = new AccountChecks(fakes().deps)
    await checks.check('a', 'work')

    checks.forget('a')

    expect(checks.get('a')).toEqual({ state: 'unknown', checking: true, identity: NO_IDENTITY, at: null })
  })

  it('an answer that arrives after confirmed does not overwrite it', async () => {
    const answer = deferred<AuthStatus>()
    const checks = new AccountChecks(fakes({ status: () => answer.promise }).deps)

    const running = checks.check('a', 'work')
    checks.confirmed('a', FILE_LOGIN)
    answer.resolve(parseAuthStatus({ code: 1, stdout: '' }))
    await running

    expect(checks.get('a')).toMatchObject({ state: 'ready', checking: false })
  })

  it('the limits are 15 seconds for auth status and a minute between checks', () => {
    expect(STATUS_TIMEOUT_MS).toBe(15_000)
    expect(RECHECK_MS).toBe(60_000)
  })
})
