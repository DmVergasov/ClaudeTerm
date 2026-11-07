import { chmodSync, existsSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileReceiver, plainName } from '../../src/main/sync/file-receiver'
import { REMOTE_COPY } from '../../src/shared/remote'
import { WIN } from '../fixtures/platform'
import { until } from '../fixtures/sync'

// The receiver of the files pasted into a remote tab: its folders, its transfers and the names it keeps. Every folder is a
// temp folder of the test; the receiver's root is one under it, never the machine's received folder.

// The fs/promises calls that the races and the failures need to hold or to break, and that count the open handles: each is
// the real call unless a test sets the gate. A test that sets the gate resets it.
const gate = vi.hoisted(() => ({
  /** when set, mkdtemp waits for it; `entered` counts the calls that reach it */
  hold: null as Promise<void> | null,
  entered: 0,
  /** a path whose open fails, when this returns true */
  failOpen: null as ((path: string) => boolean) | null,
  /** the next file opened gets a handle whose writes fail */
  failWrite: false,
  /** when set, the next write of an open file runs at once, and only its answer waits for this */
  holdWrite: null as Promise<void> | null,
  /** when set, the next open runs at once, and only its answer waits for this */
  holdOpen: null as Promise<void> | null,
  /** the opens made, and the handles open now (by identity) and the most open at once */
  opens: 0,
  live: new Set<object>(),
  maxLive: 0,
  /** the next removal of a folder is refused, as Windows refuses one under an open handle */
  failRm: false
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    mkdtemp: async (prefix: string) => {
      gate.entered++
      if (gate.hold) await gate.hold
      return real.mkdtemp(prefix)
    },
    rm: async (path: string, options?: object) => {
      if (gate.failRm) {
        gate.failRm = false
        throw new Error(`EPERM: operation not permitted, ${path}`)
      }
      return real.rm(path, options)
    },
    open: async (path: string, flags: string) => {
      if (gate.failOpen?.(path)) throw new Error(`EACCES: permission denied, ${path}`)
      const handle = await real.open(path, flags)
      // the file is open already; a held open answers late, as a disk that is slow to answer does. Only the next open is held
      const held = gate.holdOpen
      gate.holdOpen = null
      if (held) await held
      const failWrites = gate.failWrite
      gate.failWrite = false
      gate.opens++
      const proxy: FileHandle = new Proxy(handle, {
        get: (target, key) => {
          if (key === 'write' && failWrites) return async () => Promise.reject(new Error('ENOSPC: no space left'))
          if (key === 'write' && gate.holdWrite) {
            const hold = gate.holdWrite
            gate.holdWrite = null
            // the write runs at once, as production starts it; only its answer waits for the hold
            return async (...args: unknown[]) => {
              const written = Reflect.apply(target.write, target, args) as Promise<unknown>
              const outcome = written.then(
                (value) => ({ ok: true as const, value }),
                (error: unknown) => ({ ok: false as const, error })
              )
              await hold
              const settled = await outcome
              if (!settled.ok) throw settled.error
              return settled.value
            }
          }
          if (key === 'close') {
            return async () => {
              gate.live.delete(proxy)
              return target.close()
            }
          }
          const value: unknown = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      gate.live.add(proxy)
      gate.maxLive = Math.max(gate.maxLive, gate.live.size)
      return proxy
    }
  }
})

const DAY = 24 * 60 * 60 * 1000
const UNKNOWN = '00000000-0000-4000-8000-000000000000'
const OWNER = 'device-b'

let base: string
let root: string
let r: FileReceiver
const receivers: FileReceiver[] = []
const elsewheres: string[] = []

function make(o: { idleMs?: number; maxBytes?: number; minDeadlineMs?: number; bytesPerSecond?: number } = {}): FileReceiver {
  const x = new FileReceiver({ root, ...o })
  receivers.push(x)
  return x
}

/** a folder outside the receiver's root, the target of a planted link */
function elsewhere(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-elsewhere-'))
  elsewheres.push(dir)
  return dir
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ct-recv-'))
  root = join(base, 'ClaudeTerm', 'received')
  r = make()
})

afterEach(() => {
  gate.hold = null
  gate.failOpen = null
  gate.failWrite = false
  gate.holdWrite = null
  gate.holdOpen = null
  gate.failRm = false
  for (const x of receivers.splice(0)) x.dispose()
  // a removal that is still running after dispose() may hold a file of the folder for a moment on Windows
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  for (const dir of elsewheres.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('plainName', () => {
  it('makes a sent name a plain file name', () => {
    expect(plainName('../../evil.sh')).toBe('evil.sh')
    expect(plainName('a\\b.png')).toBe('b.png')
    expect(plainName('CON.txt')).toBe('_CON.txt')
    expect(plainName('..')).toBe('file')
    expect(plainName('a"$b`.png')).toBe('a__b_.png')
    expect(plainName('x'.repeat(300) + '.png')).toHaveLength(199)
  })

  it('keeps the rules for control characters, reserved names and dots and spaces', () => {
    expect(plainName('COM¹.txt')).toBe('_COM¹.txt')
    expect(plainName('a\u0000b.txt')).toBe('a_b.txt')
    expect(plainName('name. ')).toBe('name')
    expect(plainName('NUL')).toBe('_NUL')
    expect(plainName('lpt0.log')).toBe('_lpt0.log')
  })

  it('cuts a name to 200 UTF-8 bytes at a character boundary, keeping its extension', () => {
    const cjk = plainName('漢'.repeat(100) + '.txt')
    expect(Buffer.byteLength(cjk)).toBeLessThanOrEqual(200)
    expect(cjk.endsWith('.txt')).toBe(true)
    expect(Buffer.from(cjk).toString('utf8')).toBe(cjk)
    const emoji = plainName('😀'.repeat(60) + '.png')
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(200)
    expect(emoji.endsWith('.png')).toBe(true)
    expect(Buffer.from(emoji).toString('utf8')).toBe(emoji)
  })

  it('leaves no trailing dot or space after the cut, and falls back to file', () => {
    expect(plainName('a'.repeat(199) + '.' + 'b'.repeat(20))).toBe('a'.repeat(199))
    expect(plainName('a'.repeat(199) + ' b')).toBe('a'.repeat(199))
    expect(plainName('.'.repeat(300))).toBe('file')
  })

  it('a name that the cut leaves reserved is not reserved after the cut, and stays within the limit', () => {
    const reservedStem = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i
    for (const name of ['NUL' + ' '.repeat(197) + 'x', 'NUL' + ' '.repeat(193) + 'x.txt']) {
      const out = plainName(name)
      expect(reservedStem.test(out.split('.')[0].replace(/ +$/, ''))).toBe(false)
      expect(Buffer.byteLength(out)).toBeLessThanOrEqual(200)
    }
  })

  it('replaces each Unicode quote, C1 control and bidi control with an underscore', () => {
    const replaced: number[] = []
    for (let c = 0x2018; c <= 0x201f; c++) replaced.push(c)
    for (let c = 0x80; c <= 0x9f; c++) replaced.push(c)
    for (let c = 0x202a; c <= 0x202e; c++) replaced.push(c)
    for (let c = 0x2066; c <= 0x2069; c++) replaced.push(c)
    for (const c of replaced) expect(plainName(`a${String.fromCodePoint(c)}b.txt`)).toBe('a_b.txt')
  })
})

describe('the folders of the receiver', () => {
  it('a link planted at received (a junction on Windows) is refused and nothing is written through it', async () => {
    const target = elsewhere()
    mkdirSync(join(base, 'ClaudeTerm'))
    symlinkSync(target, root, 'junction')
    await expect(r.begin([{ name: 'a.png', size: 1 }], OWNER)).rejects.toThrow(REMOTE_COPY.receiveUnsafe)
    expect(readdirSync(target)).toEqual([])
  })

  it('a link planted at ClaudeTerm is refused the same way', async () => {
    const target = elsewhere()
    symlinkSync(target, join(base, 'ClaudeTerm'), 'junction')
    await expect(r.begin([{ name: 'a.png', size: 1 }], OWNER)).rejects.toThrow(REMOTE_COPY.receiveUnsafe)
    expect(readdirSync(target)).toEqual([])
  })

  it.skipIf(WIN)('a root that others can write to is refused, and nothing is written', async () => {
    mkdirSync(join(base, 'ClaudeTerm'), { mode: 0o700 })
    mkdirSync(root, { mode: 0o777 })
    chmodSync(root, 0o777)
    await expect(r.begin([{ name: 'a.png', size: 1 }], OWNER)).rejects.toThrow(REMOTE_COPY.receiveUnsafe)
    expect(readdirSync(root)).toEqual([])
  })

  it.skipIf(WIN)('a parent folder that others can write to is refused, and one only its group can write is not', async () => {
    mkdirSync(join(base, 'ClaudeTerm'), { mode: 0o700 })
    chmodSync(join(base, 'ClaudeTerm'), 0o777)
    await expect(r.begin([{ name: 'a.png', size: 1 }], OWNER)).rejects.toThrow(REMOTE_COPY.receiveUnsafe)
    chmodSync(join(base, 'ClaudeTerm'), 0o775)
    expect(await r.begin([{ name: 'a.png', size: 1 }], OWNER)).toBeTruthy()
  })

  it('cleanup does not remove anything through a planted link', async () => {
    const target = elsewhere()
    writeFileSync(join(target, 'old.txt'), 'x')
    const old = new Date(Date.now() - 30 * DAY)
    utimesSync(join(target, 'old.txt'), old, old)
    mkdirSync(join(base, 'ClaudeTerm'))
    symlinkSync(target, root, 'junction')
    await r.cleanup(7 * DAY)
    expect(readdirSync(target)).toEqual(['old.txt'])
  })

  it('cleanup removes the old transfer folders and keeps the new ones', async () => {
    mkdirSync(root, { recursive: true })
    const oldDir = join(root, 't-old')
    mkdirSync(oldDir)
    writeFileSync(join(oldDir, 'a.bin'), 'x')
    const old = new Date(Date.now() - 30 * DAY)
    utimesSync(oldDir, old, old)
    await r.begin([{ name: 'a.bin', size: 1 }], OWNER)
    await r.cleanup(7 * DAY)
    expect(existsSync(oldDir)).toBe(false)
    expect(readdirSync(root)).toHaveLength(1)
  })

  it('cleanup removes only t- folders: an old folder of another name is left alone', async () => {
    mkdirSync(join(root, 'keep-old'), { recursive: true })
    const old = new Date(Date.now() - 30 * DAY)
    utimesSync(join(root, 'keep-old'), old, old)
    await r.cleanup(7 * DAY)
    expect(existsSync(join(root, 'keep-old'))).toBe(true)
  })

  it('cleanup leaves a link planted inside the root alone, and never follows it', async () => {
    const target = elsewhere()
    writeFileSync(join(target, 'old.txt'), 'x')
    const old = new Date(Date.now() - 30 * DAY)
    utimesSync(join(target, 'old.txt'), old, old)
    mkdirSync(root, { recursive: true })
    symlinkSync(target, join(root, 't-link'), 'junction')
    // the link's own mtime is old, so only the isDirectory check keeps it
    lutimesSync(join(root, 't-link'), old, old)
    await r.cleanup(7 * DAY)
    expect(readdirSync(target)).toEqual(['old.txt'])
    expect(readdirSync(root)).toEqual(['t-link'])
  })

  it('cleanup skips an old transfer that is still open', async () => {
    const t = await r.begin([{ name: 'a.bin', size: 2 }], OWNER)
    expect(t).toBeTruthy()
    const folder = join(root, readdirSync(root)[0])
    const old = new Date(Date.now() - 30 * DAY)
    utimesSync(folder, old, old)
    await r.cleanup(7 * DAY)
    expect(existsSync(folder)).toBe(true)
  })

  it('each transfer gets its own new folder, private on POSIX', async () => {
    await r.begin([{ name: 'a.png', size: 1 }], 'device-b')
    await r.begin([{ name: 'a.png', size: 1 }], 'device-c')
    const dirs = readdirSync(root)
    expect(dirs).toHaveLength(2)
    if (!WIN) for (const d of dirs) expect(statSync(join(root, d)).mode & 0o777).toBe(0o700)
  })
})

describe('the parts of a transfer', () => {
  it('a part at a wrong offset or past its size, for an unknown transfer, or an end before every byte is refused', async () => {
    const t = await r.begin([{ name: 'a.bin', size: 4 }], OWNER)
    await expect(r.part(t, 0, 2, Buffer.from('xx'), OWNER)).rejects.toThrow('bad arguments')
    await expect(r.part(UNKNOWN, 0, 0, Buffer.from('x'), OWNER)).rejects.toThrow(REMOTE_COPY.receiveUnknown)
    await r.part(t, 0, 0, Buffer.from('ab'), OWNER)
    await expect(r.end(t, OWNER)).rejects.toThrow('bad arguments')
    await expect(r.part(t, 0, 2, Buffer.from('cde'), OWNER)).rejects.toThrow('bad arguments')
    await expect(r.part(t, 1, 0, Buffer.from('x'), OWNER)).rejects.toThrow('bad arguments')
  })

  it('a part of a later file before the earlier ones are complete is refused', async () => {
    const t = await r.begin([{ name: 'a.bin', size: 2 }, { name: 'b.bin', size: 2 }], OWNER)
    await expect(r.part(t, 1, 0, Buffer.from('xy'), OWNER)).rejects.toThrow('bad arguments')
  })

  it('a transfer left unfinished goes after idleMs, with its folder, and a part for it says it took too long', async () => {
    const r50 = make({ idleMs: 50 })
    const t = await r50.begin([{ name: 'a.bin', size: 4 }], OWNER)
    await r50.part(t, 0, 0, Buffer.from('ab'), OWNER)
    const folder = join(root, readdirSync(root)[0])
    await until(() => !existsSync(folder))
    await expect(r50.part(t, 0, 2, Buffer.from('cd'), OWNER)).rejects.toThrow(REMOTE_COPY.receiveTimedOut)
  })

  it('a transfer is dropped at its deadline while parts keep arriving, and no part restarts the deadline', async () => {
    const rd = make({ minDeadlineMs: 600 })
    const t = await rd.begin([{ name: 'a.bin', size: 1000 }], OWNER)
    const folder = join(root, readdirSync(root)[0])
    const started = Date.now()
    let sent = 0
    while (existsSync(folder) && sent < 100) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      try {
        await rd.part(t, 0, sent, Buffer.from('x'), OWNER)
        sent++
      } catch {
        break
      }
    }
    const elapsed = Date.now() - started
    expect(sent).toBeGreaterThanOrEqual(5)
    expect(sent).toBeLessThan(100)
    expect(elapsed).toBeLessThan(2000)
    await until(() => !existsSync(folder))
    await expect(rd.part(t, 0, sent, Buffer.from('x'), OWNER)).rejects.toThrow(REMOTE_COPY.receiveTimedOut)
  })

  it('the deadline grows with the size: a large transfer gets more than the minimum', async () => {
    // 2 KiB at 1 KiB per second is 2 s, longer than the 150 ms minimum: it is still there after 400 ms
    const rd = make({ minDeadlineMs: 150, bytesPerSecond: 1024 })
    const t = await rd.begin([{ name: 'a.bin', size: 2048 }], OWNER)
    const folder = join(root, readdirSync(root)[0])
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(existsSync(folder)).toBe(true)
    await rd.part(t, 0, 0, Buffer.from('ab'), OWNER)
  })

  it('a transfer that ends keeps its files, and its idle timer is released', async () => {
    // the idle time is long enough for begin, part and end to finish inside it on a slow runner
    const r1s = make({ idleMs: 1000 })
    const t = await r1s.begin([{ name: 'a.bin', size: 2 }], OWNER)
    await r1s.part(t, 0, 0, Buffer.from('ab'), OWNER)
    const paths = await r1s.end(t, OWNER)
    // past the idle time: the released timer does not drop the files
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(readFileSync(paths[0], 'utf8')).toBe('ab')
  })

  it('a transfer belongs to the device that began it', async () => {
    const t = await r.begin([{ name: 'a.bin', size: 2 }], 'device-b')
    await expect(r.part(t, 0, 0, Buffer.from('a'), 'device-c')).rejects.toThrow(REMOTE_COPY.receiveUnknown)
    await expect(r.end(t, 'device-c')).rejects.toThrow(REMOTE_COPY.receiveUnknown)
    await r.part(t, 0, 0, Buffer.from('ab'), 'device-b')
    const paths = await r.end(t, 'device-b')
    expect(readFileSync(paths[0], 'utf8')).toBe('ab')
  })

  it('more than maxBytes in all is refused and nothing is written', async () => {
    const small = make({ maxBytes: 10 })
    await expect(small.begin([{ name: 'a.bin', size: 6 }, { name: 'b.bin', size: 6 }], OWNER)).rejects.toThrow(REMOTE_COPY.receiveTooLarge)
    expect(existsSync(root) ? readdirSync(root) : []).toEqual([])
  })
})

describe('a transfer dropped by the time it has', () => {
  it('a part or end for a transfer dropped at its deadline says it took too long; another owner gets unknown', async () => {
    const rd = make({ minDeadlineMs: 20 })
    const t = await rd.begin([{ name: 'a.bin', size: 4 }], OWNER)
    const folder = join(root, readdirSync(root)[0])
    await until(() => !existsSync(folder))
    await expect(rd.part(t, 0, 0, Buffer.from('ab'), OWNER)).rejects.toThrow(REMOTE_COPY.receiveTimedOut)
    await expect(rd.end(t, OWNER)).rejects.toThrow(REMOTE_COPY.receiveTimedOut)
    await expect(rd.end(t, 'device-c')).rejects.toThrow(REMOTE_COPY.receiveUnknown)
    await expect(rd.part(UNKNOWN, 0, 0, Buffer.from('ab'), OWNER)).rejects.toThrow(REMOTE_COPY.receiveUnknown)
  })

  it('a part in flight when the idle timer drops its transfer answers that it took too long', async () => {
    const ri = make({ idleMs: 50 })
    const t = await ri.begin([{ name: 'a.bin', size: 4 }], OWNER)
    const folder = join(root, readdirSync(root)[0])
    let release: () => void = () => {}
    gate.holdWrite = new Promise<void>((resolve) => {
      release = resolve
    })
    const sent = ri.part(t, 0, 0, Buffer.from('ab'), OWNER).then(
      () => 'written',
      (e: Error) => e.message
    )
    // the write runs at once, but its answer is held past the idle time: the timer drops the transfer while the write is in flight
    await until(() => !existsSync(folder))
    release()
    expect(await sent).toBe(REMOTE_COPY.receiveTimedOut)
  })

  it('a last part in flight when the idle timer drops its transfer answers that it took too long, and leaves no file', async () => {
    const ri = make({ idleMs: 50 })
    const t = await ri.begin([{ name: 'a.bin', size: 2 }], OWNER)
    const folder = join(root, readdirSync(root)[0])
    let release: () => void = () => {}
    gate.holdWrite = new Promise<void>((resolve) => {
      release = resolve
    })
    const sent = ri.part(t, 0, 0, Buffer.from('ab'), OWNER).then(
      () => 'written',
      (e: Error) => e.message
    )
    // the write of the last byte has run; its answer is held past the idle time, and the timer drops the transfer
    await until(() => !existsSync(folder))
    release()
    expect(await sent).toBe(REMOTE_COPY.receiveTimedOut)
    expect(readdirSync(root)).toEqual([])
  })

  it('an open in flight when the idle timer drops its transfer answers that it took too long', async () => {
    const ri = make({ idleMs: 50 })
    const t = await ri.begin([{ name: 'a.bin', size: 4 }], OWNER)
    let release: () => void = () => {}
    gate.holdOpen = new Promise<void>((resolve) => {
      release = resolve
    })
    const sent = ri.part(t, 0, 0, Buffer.from('ab'), OWNER).then(
      () => 'written',
      (e: Error) => e.message
    )
    // the first part's open is answered late: the idle time passes while it waits, and the timer drops the transfer. Nothing
    // here waits for the folder to go: removing it under an open handle is refused on Windows
    await new Promise((resolve) => setTimeout(resolve, 300))
    release()
    expect(await sent).toBe(REMOTE_COPY.receiveTimedOut)
  })

  it('a late open that closes after its transfer was dropped leaves no folder, even when the removal at the drop was refused', async () => {
    const ri = make({ idleMs: 50 })
    const t = await ri.begin([{ name: 'a.bin', size: 4 }], OWNER)
    let release: () => void = () => {}
    gate.holdOpen = new Promise<void>((resolve) => {
      release = resolve
    })
    // the drop's removal runs while the open is held, and is refused, as Windows refuses one under an open handle
    gate.failRm = true
    const sent = ri.part(t, 0, 0, Buffer.from('ab'), OWNER).then(
      () => 'written',
      (e: Error) => e.message
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(gate.failRm).toBe(false)
    release()
    expect(await sent).toBe(REMOTE_COPY.receiveTimedOut)
    // once the late handle is closed, the folder goes
    await until(() => readdirSync(root).length === 0)
  })

  it('dispose forgets the transfers that timed out: a late part for one of them is unknown after it', async () => {
    const rd = make({ minDeadlineMs: 20 })
    const t = await rd.begin([{ name: 'a.bin', size: 4 }], OWNER)
    const folder = join(root, readdirSync(root)[0])
    await until(() => !existsSync(folder))
    await expect(rd.part(t, 0, 0, Buffer.from('ab'), OWNER)).rejects.toThrow(REMOTE_COPY.receiveTimedOut)
    rd.dispose()
    await expect(rd.part(t, 0, 0, Buffer.from('ab'), OWNER)).rejects.toThrow(REMOTE_COPY.receiveUnknown)
  })

  it('only the last 16 stopped transfers are remembered: an older one answers unknown', async () => {
    const rd = make({ minDeadlineMs: 5 })
    const ids: string[] = []
    for (let i = 0; i < 17; i++) {
      ids.push(await rd.begin([{ name: `f${i}.bin`, size: 4 }], OWNER))
      await until(() => readdirSync(root).length === 0)
    }
    await expect(rd.part(ids[0], 0, 0, Buffer.from('ab'), OWNER)).rejects.toThrow(REMOTE_COPY.receiveUnknown)
    await expect(rd.part(ids[16], 0, 0, Buffer.from('ab'), OWNER)).rejects.toThrow(REMOTE_COPY.receiveTimedOut)
  })
})

describe('the limits of the transfers', () => {
  it('five begins at once: four are taken and the fifth is busy, the owners spread so that the owner limit is not what refuses', async () => {
    const results = await Promise.allSettled(['o1', 'o2', 'o3', 'o4', 'o5'].map((o, i) => r.begin([{ name: `f${i}.bin`, size: 1 }], o)))
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(4)
    const refusals = results.flatMap((x) => (x.status === 'rejected' ? [(x.reason as Error).message] : []))
    expect(refusals).toEqual([REMOTE_COPY.receiveBusy])
    expect(readdirSync(root)).toHaveLength(4)
  })

  it('a fifth transfer at once is refused as busy and writes nothing; a new one is taken once one ends', async () => {
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push(await r.begin([{ name: `f${i}.bin`, size: 1 }], `o${i}`))
    await expect(r.begin([{ name: 'x.bin', size: 1 }], 'o9')).rejects.toThrow(REMOTE_COPY.receiveBusy)
    expect(readdirSync(root)).toHaveLength(4)
    await r.part(ids[0], 0, 0, Buffer.from('x'), 'o0')
    await r.end(ids[0], 'o0')
    expect(await r.begin([{ name: 'x.bin', size: 1 }], 'o9')).toBeTruthy()
  })

  it('one owner holds at most two open transfers: its third begin is busy, and another device can still begin', async () => {
    await r.begin([{ name: 'a.bin', size: 1 }], 'device-b')
    await r.begin([{ name: 'b.bin', size: 1 }], 'device-b')
    await expect(r.begin([{ name: 'c.bin', size: 1 }], 'device-b')).rejects.toThrow(REMOTE_COPY.receiveBusy)
    expect(readdirSync(root)).toHaveLength(2)
    expect(await r.begin([{ name: 'c.bin', size: 1 }], 'device-c')).toBeTruthy()
  })

  it('a begin with the names of the same case both arrive, the second renamed', async () => {
    const t = await r.begin([{ name: 'A.txt', size: 1 }, { name: 'a.txt', size: 1 }], OWNER)
    await r.part(t, 0, 0, Buffer.from('x'), OWNER)
    await r.part(t, 1, 0, Buffer.from('y'), OWNER)
    const paths = await r.end(t, OWNER)
    expect(paths.map((p) => basename(p))).toEqual(['A.txt', 'a (2).txt'])
  })

  it('a begin with the same name in NFC and in NFD both arrive, the second renamed', async () => {
    const t = await r.begin([{ name: 'é.txt', size: 1 }, { name: 'é.txt', size: 1 }], OWNER)
    await r.part(t, 0, 0, Buffer.from('x'), OWNER)
    await r.part(t, 1, 0, Buffer.from('y'), OWNER)
    const paths = await r.end(t, OWNER)
    // a normalizing file system (macOS) takes the two names for one file: they must differ once normalized
    expect(paths.map((p) => basename(p).normalize('NFC').toLowerCase())).toEqual(['é.txt', 'é (2).txt'])
  })

  it('two empty files with the same name in NFC and in NFD both arrive, the second renamed', async () => {
    const t = await r.begin([{ name: 'é.txt', size: 0 }, { name: 'é.txt', size: 0 }], OWNER)
    const paths = await r.end(t, OWNER)
    expect(paths.map((p) => basename(p).normalize('NFC').toLowerCase())).toEqual(['é.txt', 'é (2).txt'])
  })

  it('three 2-byte files: none is open after begin, at most one handle is open at a time, and none once its file is complete', async () => {
    gate.opens = 0
    gate.live.clear()
    gate.maxLive = 0
    const t = await r.begin(
      [
        { name: 'a.bin', size: 2 },
        { name: 'b.bin', size: 2 },
        { name: 'c.bin', size: 2 }
      ],
      OWNER
    )
    expect(gate.opens).toBe(0)
    for (let i = 0; i < 3; i++) {
      await r.part(t, i, 0, Buffer.from('x'), OWNER)
      expect(gate.live.size).toBe(1)
      await r.part(t, i, 1, Buffer.from('y'), OWNER)
      expect(gate.live.size).toBe(0)
    }
    expect(gate.opens).toBe(3)
    expect(gate.maxLive).toBe(1)
    await r.end(t, OWNER)
  })
})

describe('the races and the failures of a transfer', () => {
  it('dispose during the begin: the transfer is not kept and its folder is removed', async () => {
    let release: () => void = () => {}
    gate.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = gate.entered
    const begun = r.begin([{ name: 'a.bin', size: 1 }], OWNER).then(
      () => 'taken',
      (e: Error) => e.message
    )
    await until(() => gate.entered > entered)
    r.dispose()
    gate.hold = null
    release()
    expect(await begun).toBe(REMOTE_COPY.receiveFailed)
    await until(() => readdirSync(root).length === 0)
  })

  it('abandon of the owner during its begin: the transfer is not kept and its folder is removed', async () => {
    let release: () => void = () => {}
    gate.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = gate.entered
    const begun = r.begin([{ name: 'a.bin', size: 1 }], OWNER).then(
      () => 'taken',
      (e: Error) => e.message
    )
    await until(() => gate.entered > entered)
    r.abandon(OWNER)
    gate.hold = null
    release()
    expect(await begun).toBe(REMOTE_COPY.receiveFailed)
    await until(() => readdirSync(root).length === 0)
  })

  it('a failed open at begin removes the folder and answers receiveFailed', async () => {
    gate.failOpen = (p) => p.endsWith('empty.bin')
    await expect(r.begin([{ name: 'a.bin', size: 2 }, { name: 'empty.bin', size: 0 }], OWNER)).rejects.toThrow(REMOTE_COPY.receiveFailed)
    expect(readdirSync(root)).toEqual([])
  })

  it('a failed write drops the transfer: its folder is removed, and its next part is refused', async () => {
    const t = await r.begin([{ name: 'a.bin', size: 4 }], OWNER)
    gate.failWrite = true
    await expect(r.part(t, 0, 0, Buffer.from('ab'), OWNER)).rejects.toThrow(REMOTE_COPY.receiveFailed)
    await until(() => readdirSync(root).length === 0)
    await expect(r.part(t, 0, 2, Buffer.from('cd'), OWNER)).rejects.toThrow(REMOTE_COPY.receiveUnknown)
  })

  it('a transfer is dropped by its link closing: its files and folder are removed', async () => {
    const t = await r.begin([{ name: 'a.bin', size: 4 }], OWNER)
    await r.part(t, 0, 0, Buffer.from('ab'), OWNER)
    r.abandon(OWNER)
    await until(() => readdirSync(root).length === 0)
  })
})

describe('the release of a transfer', () => {
  it('dispose closes the open files and removes the unfinished folders, then refuses new transfers', async () => {
    const x = make()
    const t = await x.begin([{ name: 'a.bin', size: 4 }], OWNER)
    await x.part(t, 0, 0, Buffer.from('ab'), OWNER)
    const folder = join(root, readdirSync(root)[0])
    x.dispose()
    await until(() => !existsSync(folder))
    await expect(x.begin([{ name: 'b.bin', size: 1 }], OWNER)).rejects.toThrow(REMOTE_COPY.receiveFailed)
  })

  it('abandon removes the transfers of one device, the link of which is gone, and keeps the others', async () => {
    const keep = await r.begin([{ name: 'k.bin', size: 2 }], 'device-b')
    await r.begin([{ name: 'g.bin', size: 2 }], 'device-c')
    r.abandon('device-c')
    await until(() => readdirSync(root).length === 1)
    await r.part(keep, 0, 0, Buffer.from('ab'), 'device-b')
    expect(await r.end(keep, 'device-b')).toHaveLength(1)
  })
})
