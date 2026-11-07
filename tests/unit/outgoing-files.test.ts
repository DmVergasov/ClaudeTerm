import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OutgoingFile } from '../../src/main/sync/file-sender'
import { CallError } from '../../src/main/sync/calls'
import { fileToSend, RemoteCopies, type DropFs, type FileStat, type ReadHandle } from '../../src/main/sync/outgoing-files'
import { COPY_TOAST_MS, MAX_TRANSFER_BYTES, REMOTE_COPY } from '../../src/shared/remote'

type Kind = 'file' | 'dir' | 'link'

/** a stat as lstat or stat gives it: the kind, and the identity a read is checked against */
function stat(o: { kind?: Kind; ino?: number; dev?: number; size?: number } = {}): FileStat {
  const kind = o.kind ?? 'file'
  return { isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link', ino: o.ino ?? 1, dev: o.dev ?? 1, size: o.size ?? 0 }
}

/** a fake file system: `data` is what the file holds; each read gives at most `step` bytes, as a short read does */
function fakeFs(o: { lstat: FileStat | null; stat?: FileStat | null; opened?: FileStat; data?: Buffer; step?: number }): DropFs {
  const data = o.data ?? Buffer.alloc(0)
  const handle: ReadHandle = {
    read: async (buffer, offset, length, position) => {
      const n = Math.max(0, Math.min(length, o.step ?? length, data.length - position))
      data.copy(buffer, offset, position, position + n)
      return { bytesRead: n }
    },
    stat: async () => o.opened ?? stat({ size: data.length }),
    close: async () => {}
  }
  return {
    lstat: async () => {
      if (o.lstat === null) throw new Error('ENOENT')
      return o.lstat
    },
    stat: async () => {
      if (o.stat === null || o.stat === undefined) throw new Error('ENOENT')
      return o.stat
    },
    open: async () => handle
  }
}

async function refusalOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    return e instanceof Error ? e.message : ''
  }
  return 'accepted'
}

describe('fileToSend', () => {
  it('reads a regular file whole, though each read gives back fewer bytes than asked', async () => {
    const fs = fakeFs({ lstat: stat({ size: 10 }), data: Buffer.from('0123456789'), step: 3 })
    const f = await fileToSend('/p/a.bin', fs)
    expect(f.name).toBe('a.bin')
    expect(f.size).toBe(10)
    expect((await f.read(0, 10)).toString()).toBe('0123456789')
  })

  it('reads a link to a regular file through the link', async () => {
    const fs = fakeFs({ lstat: stat({ kind: 'link', ino: 7 }), stat: stat({ size: 4, ino: 9 }), opened: stat({ size: 4, ino: 9 }), data: Buffer.from('link') })
    const f = await fileToSend('/p/link', fs)
    expect(f.size).toBe(4)
    expect((await f.read(0, 4)).toString()).toBe('link')
  })

  it('refuses a folder, a link to a folder, and a path that is gone, with the copy\'s words', async () => {
    const refused = REMOTE_COPY.copyReadFailed
    expect(await refusalOf(fileToSend('/p/dir', fakeFs({ lstat: stat({ kind: 'dir' }) })))).toBe(refused)
    expect(await refusalOf(fileToSend('/p/link', fakeFs({ lstat: stat({ kind: 'link' }), stat: stat({ kind: 'dir' }) })))).toBe(refused)
    expect(await refusalOf(fileToSend('/p/gone', fakeFs({ lstat: null })))).toBe(refused)
  })

  it('refuses a file that is no longer the one listed when it is read: another file, or a folder now', async () => {
    const refused = REMOTE_COPY.copyReadFailed
    const other = await fileToSend('/p/a.bin', fakeFs({ lstat: stat({ size: 4, ino: 1 }), opened: stat({ size: 4, ino: 2 }), data: Buffer.from('abcd') }))
    expect(await refusalOf(other.read(0, 4))).toBe(refused)
    const folder = await fileToSend('/p/a.bin', fakeFs({ lstat: stat({ size: 4 }), opened: stat({ kind: 'dir', size: 4 }), data: Buffer.from('abcd') }))
    expect(await refusalOf(folder.read(0, 4))).toBe(refused)
  })

  it('answers a short part when the file ends before the part is full', async () => {
    const f = await fileToSend('/p/a.bin', fakeFs({ lstat: stat({ size: 10 }), data: Buffer.from('abcd'), step: 3 }))
    expect((await f.read(0, 10)).toString()).toBe('abcd')
  })
})

describe('fileToSend on the disk', () => {
  // a link to a folder is a junction on Windows (no privilege needed) and a symlink elsewhere
  it('refuses a link to a folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-link-'))
    const folder = join(dir, 'sub')
    mkdirSync(folder)
    symlinkSync(folder, join(dir, 'folder-link'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await refusalOf(fileToSend(join(dir, 'folder-link')))).toBe(REMOTE_COPY.copyReadFailed)
  })

  // a FIFO is refused by its listing: a read of it would wait for a writer, so no byte may be read to refuse it
  it.skipIf(process.platform === 'win32')('refuses a FIFO before any byte is read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-fifo-'))
    const fifo = join(dir, 'pipe')
    execFileSync('mkfifo', [fifo])
    expect(await refusalOf(fileToSend(fifo))).toBe(REMOTE_COPY.copyReadFailed)
  })

  // a symlink to a file needs privilege on Windows (EPERM without it): there the link is covered by the fake file system above
  it.skipIf(process.platform === 'win32')('reads a link to a file through the link', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-link-'))
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'abcd')
    symlinkSync(file, join(dir, 'file-link'))
    const f = await fileToSend(join(dir, 'file-link'))
    expect(f.size).toBe(4)
    expect((await f.read(0, 4)).toString()).toBe('abcd')
  })
})

describe('RemoteCopies', () => {
  /** what a device answers for a copy: the paths the files are saved at, and the text typed for them */
  const sentOf = (tabId: string, files: OutgoingFile[]): { paths: string[]; text: string } => {
    const paths = files.map((f) => `/received/${tabId}/${f.name}`)
    return { paths, text: paths.map((p) => `"${p}"`).join(' ') }
  }

  /** a copier with the toasts, the sent files and the timers recorded; the timers run only when the test fires them */
  function harness(o: { name?: string | null; send?: (tabId: string, files: OutgoingFile[]) => Promise<{ paths: string[]; text: string }> } = {}) {
    const toasts: string[] = []
    const timers = new Map<number, () => void>()
    let next = 1
    const copies = new RemoteCopies({
      toast: (m) => toasts.push(m),
      sendFiles: o.send ?? (async (tabId, files) => sentOf(tabId, files)),
      nameOf: () => (o.name === undefined ? 'Studio' : o.name),
      timers: {
        set: (fn) => {
          const id = next++
          timers.set(id, fn)
          return id
        },
        clear: (id) => {
          timers.delete(id as number)
        }
      },
      slowMs: COPY_TOAST_MS
    })
    return { copies, toasts, timers }
  }
  const file = (name: string, size = 1): OutgoingFile => ({ name, size, read: async () => Buffer.alloc(0) })

  it('says the copy is running once it runs past the slow time, and not before', async () => {
    let finish: (sent: { paths: string[]; text: string }) => void = () => {}
    const { copies, toasts, timers } = harness({ send: () => new Promise((resolve) => { finish = resolve }) })
    const running = copies.copy('t1', async () => [file('a.png')])
    expect(toasts).toEqual([])
    expect(timers.size).toBe(1)
    ;[...timers.values()][0]()
    expect(toasts).toEqual([REMOTE_COPY.copying('Studio')])
    // the files are ready and sent once the event loop has run
    await new Promise((resolve) => setImmediate(resolve))
    finish(sentOf('t1', [file('a.png')]))
    expect(await running).toEqual(sentOf('t1', [file('a.png')]))
    expect(timers.size).toBe(0)
  })

  it('refuses a second copy of the same tab while the first runs, with the copying toast; another tab is not held up', async () => {
    let finish: (sent: { paths: string[]; text: string }) => void = () => {}
    let sends = 0
    const { copies, toasts } = harness({
      send: async (tabId, files) => {
        sends++
        if (tabId === 't1' && sends === 1) return new Promise<{ paths: string[]; text: string }>((resolve) => { finish = resolve })
        return sentOf(tabId, files)
      }
    })
    const first = copies.copy('t1', async () => [file('a.png')])
    expect(await copies.copy('t1', async () => [file('b.png')])).toBeNull()
    expect(toasts).toEqual([REMOTE_COPY.copying('Studio')])
    expect(sends).toBe(1)
    expect(await copies.copy('t2', async () => [file('c.png')])).toEqual(sentOf('t2', [file('c.png')]))
    finish(sentOf('t1', [file('a.png')]))
    expect(await first).toEqual(sentOf('t1', [file('a.png')]))
  })

  it('releases the tab and the timer on every path: success, too large, a failure, and nothing to copy', async () => {
    const cases: { name: string; prepare: () => Promise<OutgoingFile[] | null>; send?: () => Promise<{ paths: string[]; text: string }>; expect: (r: { paths: string[]; text: string } | null, toasts: string[]) => void }[] = [
      { name: 'success', prepare: async () => [file('a.png')], expect: (r) => expect(r).toEqual(sentOf('t1', [file('a.png')])) },
      {
        name: 'too large',
        prepare: async () => [file('big', MAX_TRANSFER_BYTES), file('more', 1)],
        expect: (r, toasts) => {
          expect(r).toBeNull()
          expect(toasts).toEqual([REMOTE_COPY.copyTooLarge('Studio')])
        }
      },
      {
        name: 'a failure',
        prepare: async () => [file('a.png')],
        send: async () => { throw new CallError('Studio is not connected') },
        expect: (r, toasts) => {
          expect(r).toBeNull()
          expect(toasts).toEqual([REMOTE_COPY.copyFailed('Studio', 'Studio is not connected')])
        }
      },
      { name: 'nothing to copy', prepare: async () => null, expect: (r, toasts) => {
        expect(r).toBeNull()
        expect(toasts).toEqual([])
      } }
    ]
    for (const c of cases) {
      let failing = c.send !== undefined
      const { copies, toasts, timers } = harness({ send: (tabId, files) => (failing ? c.send!() : Promise.resolve(sentOf(tabId, files))) })
      c.expect(await copies.copy('t1', c.prepare), toasts)
      expect(timers.size, c.name).toBe(0)
      // the tab takes a copy again
      failing = false
      expect(await copies.copy('t1', async () => [file('again.png')]), c.name).toEqual(sentOf('t1', [file('again.png')]))
      expect(timers.size, c.name).toBe(0)
    }
  })

  it('the copying toast comes at COPY_TOAST_MS by default, and not a millisecond before', async () => {
    // a clock the test moves: a timer runs once its time is reached
    let now = 0
    let next = 1
    const pending: { id: number; due: number; run: () => void }[] = []
    const toasts: string[] = []
    let finish: (sent: { paths: string[]; text: string }) => void = () => {}
    const copies = new RemoteCopies({
      toast: (m) => toasts.push(m),
      sendFiles: () => new Promise<{ paths: string[]; text: string }>((resolve) => { finish = resolve }),
      nameOf: () => 'Studio',
      timers: {
        set: (run, ms) => {
          const id = next++
          pending.push({ id, due: now + ms, run })
          return id
        },
        clear: (id) => {
          const i = pending.findIndex((p) => p.id === id)
          if (i >= 0) pending.splice(i, 1)
        }
      }
    })
    const running = copies.copy('t1', async () => [file('a.png')])
    // the prepare of the copy runs first: the send is then pending, and the slow timer is the only one
    await new Promise((resolve) => setImmediate(resolve))
    const runAt = (at: number): void => {
      now = at
      for (const p of pending.filter((x) => x.due <= now)) {
        pending.splice(pending.indexOf(p), 1)
        p.run()
      }
    }
    runAt(COPY_TOAST_MS - 1)
    expect(toasts).toEqual([])
    expect(pending).toHaveLength(1)
    runAt(COPY_TOAST_MS)
    expect(toasts).toEqual([REMOTE_COPY.copying('Studio')])
    finish(sentOf('t1', [file('a.png')]))
    expect(await running).toEqual(sentOf('t1', [file('a.png')]))
  })

  it('refuses a tab that is not remote, with no toast and no timer', async () => {
    const { copies, toasts, timers } = harness({ name: null })
    expect(await copies.copy('t1', async () => [file('a.png')])).toBeNull()
    expect(toasts).toEqual([])
    expect(timers.size).toBe(0)
  })

  it('refuse toasts the words with the device name and takes no slot', async () => {
    const { copies, toasts } = harness()
    expect(copies.refuse('t1', REMOTE_COPY.copyTooManyFiles)).toBeNull()
    expect(toasts).toEqual([REMOTE_COPY.copyFailed('Studio', REMOTE_COPY.copyTooManyFiles)])
    expect(await copies.copy('t1', async () => [file('a.png')])).toEqual(sentOf('t1', [file('a.png')]))
  })

  it('answers the text the device answers, unchanged, with the paths', async () => {
    const { copies } = harness({ send: async () => ({ paths: ['/r/a.png'], text: "'/r/a.png'" }) })
    expect(await copies.copy('t1', async () => [file('a.png')])).toEqual({ paths: ['/r/a.png'], text: "'/r/a.png'" })
  })
})
