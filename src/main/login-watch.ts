import { stat } from 'node:fs/promises'
import { readLogin } from './claude-plan'

/** what tells a rewrite of the file: its identity, size and times; null when it cannot be read */
async function stamp(file: string): Promise<string | null> {
  try {
    const s = await stat(file)
    return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
  } catch {
    return null
  }
}

/**
 * Tells when the login Claude Code keeps in its .claude.json changes: a /login to another account or organization, or a
 * /logout. The usage limits a tab shows belong to the login they were read under. The file is polled, as Claude Code
 * rewrites it whole and often; a change of anything but the login tells nothing, and neither does a file that cannot be
 * read or is cut short while being written: the login it held before stays the one compared with. Each read is preceded
 * by a look at the file's stamp, so a write that comes while the file is read, however late the file system answers, is
 * seen by the next poll.
 */
export class LoginWatch {
  /** the login of the last read that could tell one; undefined before the first */
  private last: string | null | undefined = undefined
  /** the file's stamp taken right before the last read */
  private seen: string | null = null
  private running: Promise<void> | null = null
  private again = false
  private stopped = false
  private timer: ReturnType<typeof setInterval> | null = null
  private polling = false

  constructor(private readonly file: string, private readonly onChange: () => void, private readonly intervalMs = 1000) {}

  /** reads the login the file holds now, then watches the file */
  async start(): Promise<void> {
    await this.check()
    if (this.stopped || this.timer) return
    this.timer = setInterval(() => void this.poll(), this.intervalMs)
    // the watch keeps no process alive
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
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
        this.seen = await stamp(this.file)
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

  /** the file was written since its last read: read it again */
  private async poll(): Promise<void> {
    if (this.polling || this.running) return
    this.polling = true
    try {
      if ((await stamp(this.file)) !== this.seen && !this.stopped) await this.check()
    } finally {
      this.polling = false
    }
  }
}
