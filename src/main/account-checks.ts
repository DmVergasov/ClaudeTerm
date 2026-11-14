import type { AccountState } from '../shared/accounts'
import { type AuthStatus, type Identity, mergeIdentity, NO_IDENTITY } from './account-login'

/** how long `claude auth status` may run for an account */
export const STATUS_TIMEOUT_MS = 15_000
/** an account checked less than this long ago is not checked again by checkStale */
export const RECHECK_MS = 60_000

export interface AccountCheck {
  state: AccountState
  /** a check of the account is running, or none has answered yet */
  checking: boolean
  identity: Identity
  /** when the last answer came (ms since the epoch), null before the first one */
  at: number | null
}

export interface AccountChecksDeps {
  /** auth status --json with the account's env, 15 s; unknown on a timeout or a CLI error */
  status(folder: string): Promise<AuthStatus>
  /** the folder's .claude.json login */
  identity(folder: string): Promise<Identity>
  isDir(folder: string): Promise<boolean>
  now(): number
  /** an answer changed the state, the checking flag or the identity */
  changed(): void
}

interface Answer {
  state: AccountState
  identity: Identity
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.email === b.email && a.orgName === b.orgName && a.orgUuid === b.orgUuid && a.plan === b.plan
}

/** the state of each sign-in account: ready, signed-out, missing or unknown, from `claude auth status` and the account file */
export class AccountChecks {
  private readonly checks = new Map<string, AccountCheck>()
  private readonly running = new Map<string, Promise<AccountCheck>>()
  /** bumped by confirmed and forget: an answer from before that is not stored */
  private readonly generation = new Map<string, number>()

  constructor(private readonly d: AccountChecksDeps) {}

  /** the account's last answer; before its first answer it is unknown and checking */
  get(id: string): AccountCheck {
    const check = this.checks.get(id)
    if (check !== undefined) return { ...check, identity: { ...check.identity } }
    return { state: 'unknown', checking: true, identity: NO_IDENTITY, at: null }
  }

  /** runs `claude auth status` for the account's folder; while one runs for the account, the same answer is returned */
  check(id: string, folder: string): Promise<AccountCheck> {
    const running = this.running.get(id)
    if (running !== undefined) return running
    const check = this.run(id, folder).finally(() => {
      if (this.running.get(id) === check) this.running.delete(id)
    })
    this.running.set(id, check)
    return check
  }

  /** checks the accounts that were not checked within RECHECK_MS; an account whose check is running counts as fresh */
  checkStale(list: { id: string; folder: string }[]): void {
    const now = this.d.now()
    for (const { id, folder } of list) {
      if (this.running.has(id)) continue
      const last = this.checks.get(id)?.at
      if (last !== undefined && last !== null && now - last < RECHECK_MS) continue
      void this.check(id, folder)
    }
  }

  /** a sign-in was just confirmed: the account is ready with this identity, no CLI run */
  confirmed(id: string, identity: Identity): void {
    this.bump(id)
    this.running.delete(id)
    this.store(id, { state: 'ready', identity: { ...identity } })
  }

  /** drops what is known of the account */
  forget(id: string): void {
    this.bump(id)
    this.running.delete(id)
    this.checks.delete(id)
  }

  private async run(id: string, folder: string): Promise<AccountCheck> {
    const generation = this.generation.get(id) ?? 0
    const answer = await this.answer(folder)
    if ((this.generation.get(id) ?? 0) === generation) this.store(id, answer)
    return this.get(id)
  }

  /** the answer for a folder: missing without a CLI run, else from auth status with the account file's login */
  private async answer(folder: string): Promise<Answer> {
    try {
      if (!(await this.d.isDir(folder))) return { state: 'missing', identity: NO_IDENTITY }
    } catch {
      return { state: 'unknown', identity: await this.fileIdentity(folder) }
    }
    let status: AuthStatus
    try {
      status = await this.d.status(folder)
    } catch {
      status = { state: 'unknown', reason: 'the status check failed' }
    }
    if (status.state === 'signed-out') return { state: 'signed-out', identity: NO_IDENTITY }
    const file = await this.fileIdentity(folder)
    if (status.state === 'signed-in') return { state: 'ready', identity: mergeIdentity(status.identity, file) }
    return { state: 'unknown', identity: file }
  }

  private async fileIdentity(folder: string): Promise<Identity> {
    try {
      return await this.d.identity(folder)
    } catch {
      return NO_IDENTITY
    }
  }

  /** stores an answer and tells the window when the state, the checking flag or the identity changed */
  private store(id: string, answer: Answer): void {
    const before = this.get(id)
    const next: AccountCheck = { state: answer.state, checking: false, identity: { ...answer.identity }, at: this.d.now() }
    this.checks.set(id, next)
    if (before.state !== next.state || before.checking !== next.checking || !sameIdentity(before.identity, next.identity)) {
      this.d.changed()
    }
  }

  private bump(id: string): void {
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1)
  }
}
