import { lstat, open, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { COPY_TOAST_MS, MAX_TRANSFER_BYTES, REMOTE_COPY } from '../../shared/remote'
import { CallError } from './calls'
import type { OutgoingFile, SentFiles } from './file-sender'

// The files of this device that are dropped or pasted on a remote tab: each is read from its own path, part by part, and a
// path that is not a regular file (a folder, a link to one) is refused before anything is sent. One copy per tab at a time.

/** the parts of a file's stat that a copy uses */
export interface FileStat {
  isFile(): boolean
  isSymbolicLink(): boolean
  ino: number
  dev: number
  size: number
}

/** an open file that parts are read from */
export interface ReadHandle {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  stat(): Promise<FileStat>
  close(): Promise<void>
}

/** the file system calls a dropped file needs: injected, so the tests can stand in for the disk */
export interface DropFs {
  lstat(path: string): Promise<FileStat>
  stat(path: string): Promise<FileStat>
  open(path: string): Promise<ReadHandle>
}

const nodeFs: DropFs = {
  lstat: (path) => lstat(path),
  stat: (path) => stat(path),
  open: async (path) => {
    const file = await open(path, 'r')
    return {
      read: (buffer, offset, length, position) => file.read(buffer, offset, length, position),
      stat: () => file.stat(),
      close: () => file.close()
    }
  }
}

const refused = (): CallError => new CallError(REMOTE_COPY.copyReadFailed)

/**
 * A dropped file as a file to send: its size from its stat, and its bytes read from the file at each part. A link is followed
 * to its target, which must be a regular file. Each part opens the file, checks that it is still that file, and closes it.
 */
export async function fileToSend(path: string, fs: DropFs = nodeFs): Promise<OutgoingFile> {
  const listed = await fs.lstat(path).catch(() => null)
  if (listed === null) throw refused()
  const target = listed.isSymbolicLink() ? await fs.stat(path).catch(() => null) : listed
  if (target === null || !target.isFile()) throw refused()
  return {
    name: basename(path),
    size: target.size,
    read: async (offset, length) => {
      const file = await fs.open(path)
      try {
        const now = await file.stat()
        if (!now.isFile() || now.ino !== target.ino || now.dev !== target.dev) throw refused()
        const data = Buffer.alloc(length)
        let got = 0
        // a read may give fewer bytes than asked: the part is full, or the file ends
        while (got < length) {
          const { bytesRead } = await file.read(data, got, length - got, offset + got)
          if (bytesRead === 0) break
          got += bytesRead
        }
        return data.subarray(0, got)
      } finally {
        await file.close()
      }
    }
  }
}

/** what a copy needs from the window: its toasts, the sending, the device's name, and the timers (injected in the tests) */
export interface CopyDeps {
  toast(message: string): void
  /** sends the files to the tab's device: their paths there and the text to type for them, or the device's refusal */
  sendFiles(tabId: string, files: OutgoingFile[]): Promise<SentFiles>
  /** the device's name as the window shows it; null when the tab is not on another device */
  nameOf(tabId: string): string | null
  timers?: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void }
  /** the time after which a copy that still runs says so; COPY_TOAST_MS by default */
  slowMs?: number
}

const systemTimers = {
  set: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clear: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** the copies to remote tabs: a tab takes one copy at a time, and gives it back however the copy ends */
export class RemoteCopies {
  private readonly running = new Set<string>()

  constructor(private readonly deps: CopyDeps) {}

  /**
   * Copies files to the tab's device and answers what the device sends back: their paths there and the text to type. `prepare`
   * gives the files (null: nothing to copy). A copy already running for the tab is refused with the copying toast. A copy still
   * running after the slow time says so; a refusal or a failure is toasted with the device's name and the device's words.
   */
  async copy(tabId: string, prepare: () => Promise<OutgoingFile[] | null>): Promise<SentFiles | null> {
    const name = this.deps.nameOf(tabId)
    if (name === null) return null
    if (this.running.has(tabId)) {
      this.deps.toast(REMOTE_COPY.copying(name))
      return null
    }
    this.running.add(tabId)
    const timers = this.deps.timers ?? systemTimers
    const slow = timers.set(() => this.deps.toast(REMOTE_COPY.copying(name)), this.deps.slowMs ?? COPY_TOAST_MS)
    try {
      const files = await prepare()
      if (files === null) return null
      // refused before any byte is sent: the files together are more than one transfer takes
      if (files.reduce((n, f) => n + f.size, 0) > MAX_TRANSFER_BYTES) {
        this.deps.toast(REMOTE_COPY.copyTooLarge(name))
        return null
      }
      return await this.deps.sendFiles(tabId, files)
    } catch (e) {
      this.deps.toast(REMOTE_COPY.copyFailed(name, e instanceof Error ? e.message : 'failed'))
      return null
    } finally {
      timers.clear(slow)
      this.running.delete(tabId)
    }
  }

  /** a refusal before any copy starts: toasted with the device's name, and the tab is not taken */
  refuse(tabId: string, message: string): null {
    const name = this.deps.nameOf(tabId)
    if (name !== null) this.deps.toast(REMOTE_COPY.copyFailed(name, message))
    return null
  }
}
