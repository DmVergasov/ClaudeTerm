import { unwatchFile, watchFile, type Stats } from 'node:fs'
import { readLogin } from './claude-plan'

/**
 * Tells when the login Claude Code keeps in its .claude.json changes: a /login to another account or organization, or a
 * /logout. The usage limits a tab shows belong to the login they were read under. The file is polled, as Claude Code
 * rewrites it whole and often; a change of anything but the login tells nothing, and neither does a file that cannot be
 * read or is cut short while being written: the login it held before stays the one compared with.
 */
export class LoginWatch {
  /** the login of the last read that could tell one; undefined before the first */
  private last: string | null | undefined = undefined
  private running: Promise<void> | null = null
  private again = false
  private stopped = false
  private watching = false
  private readonly listener = (now: Stats, before: Stats): void => {
    if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) void this.check()
  }

  constructor(private readonly file: string, private readonly onChange: () => void, private readonly intervalMs = 1000) {}

  /** reads the login the file holds now, then watches the file */
  async start(): Promise<void> {
    await this.check()
    if (this.stopped || this.watching) return
    watchFile(this.file, { interval: this.intervalMs, persistent: false }, this.listener)
    this.watching = true
  }

  stop(): void {
    this.stopped = true
    if (this.watching) unwatchFile(this.file, this.listener)
    this.watching = false
  }

  /** reads the file now and tells of a login other than the one before; one read at a time, and a change during it is read after it */
  check(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        const login = await readLogin(this.file)
        if (login === undefined || this.stopped) continue
        const before = this.last
        this.last = login
        if (before !== undefined && before !== login) this.onChange()
      } while (this.again && !this.stopped)
    })().finally(() => {
      this.running = null
    })
    return this.running
  }
}
