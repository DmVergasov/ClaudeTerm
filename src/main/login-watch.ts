import { stat } from 'node:fs/promises'
import { readLogin } from './claude-plan'

/** what tells a rewrite of the file: its identity, size and times */
export interface FileStamp {
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}

/** the file's stamp; null when it cannot be read */
async function statStamp(file: string): Promise<FileStamp | null> {
  try {
    const { ino, size, mtimeMs, ctimeMs } = await stat(file)
    return { ino, size, mtimeMs, ctimeMs }
  } catch {
    return null
  }
}

const keyOf = (s: FileStamp | null): string | null => (s === null ? null : `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`)

/**
 * A file system keeps a file's times in ticks: 15.6 ms on Windows by default, 2 s on FAT. A write in the tick of the last
 * read can leave the stamp as it was, so a file written this recently is read again on each poll however its stamp looks
 */
export const FRESH_MS = 3000

/**
 * Tells when the login Claude Code keeps in its .claude.json changes: a /login to another account or organization, or a
 * /logout. The usage limits a tab shows belong to the login they were read under. The file is polled, as Claude Code
 * rewrites it whole and often; a change of anything but the login tells nothing, and neither does a file that cannot be
 * read or is cut short while being written: the login it held before stays the one compared with. Each read is preceded
 * by a look at the file's stamp, so a write that comes while the file is read, however late the file system answers, is
 * seen by the next poll; a file written in the last FRESH_MS is read on each poll, as its stamp may not show a write.
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

  /** `look` reads the file's stamp (a test stands in a file system of its own) */
  constructor(
    private readonly file: string,
    private readonly onChange: () => void,
    private readonly intervalMs = 1000,
    private readonly look: (file: string) => Promise<FileStamp | null> = statStamp
  ) {}

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
        this.seen = keyOf(await this.look(this.file))
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
      const s = await this.look(this.file)
      const fresh = s !== null && Math.abs(Date.now() - s.mtimeMs) < FRESH_MS
      if ((fresh || keyOf(s) !== this.seen) && !this.stopped) await this.check()
    } finally {
      this.polling = false
    }
  }
}
