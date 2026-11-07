import { MessageChannel } from 'node:worker_threads'
import { SerializeAddon } from '@xterm/addon-serialize'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PortMirrors, type PortLike } from '../../src/main/sync/mirror-port'
import { ScreenMirrors } from '../../src/main/sync/screen-mirror'
import { serveMirrors, snapshotLimitOf } from '../../src/main/sync/screen-worker'
import { boundedSerialize } from '../../src/shared/screen-serialize'
import { fed, numbered, replay, textOf } from '../fixtures/screen'
import { until } from '../fixtures/sync'

const T1 = 'a0000000-0000-4000-8000-000000000001'
const T9 = 'a0000000-0000-4000-8000-000000000009'

/** a port the test drives: `emit` delivers an event to the listeners the code registered on it */
function fakePort() {
  const listeners = new Map<string, ((m: unknown) => void)[]>()
  const sent: unknown[] = []
  let terminated = 0
  const port: PortLike = {
    postMessage: (m) => { sent.push(m) },
    on: (event, cb) => { listeners.set(event, [...(listeners.get(event) ?? []), cb]) },
    terminate: () => { terminated++ }
  }
  return {
    port,
    sent,
    terminated: () => terminated,
    emit: (event: string, m?: unknown) => { for (const cb of listeners.get(event) ?? []) cb(m) }
  }
}

describe('screen copies', () => {
  let m: ScreenMirrors
  let titles: [string, string][]

  beforeEach(() => {
    m = new ScreenMirrors({ maxSnapshotBytes: 1024 * 1024 })
    titles = []
    m.onTitle((id, t) => titles.push([id, t]))
  })
  afterEach(() => m.dispose())

  it('a snapshot written into a fresh terminal gives the same screen and scrollback', async () => {
    m.open(T1, 40, 10, 1000); m.write(T1, 1, numbered(30)); m.write(T1, 2, '\x1b[31mred\x1b[0m')
    const s = (await m.snapshot(T1))!
    expect(s).toMatchObject({ seq: 2, cols: 40, rows: 10 })
    expect(textOf(await replay(s))).toEqual(textOf(await fed(40, 10, numbered(30) + '\x1b[31mred\x1b[0m')))
  })

  it('the snapshot brings back the alternate screen and the modes', async () => {
    m.open(T1, 40, 10, 1000); m.write(T1, 1, '\x1b[?1049h\x1b[?2004h\x1b[?1hTUI')
    const t = await replay((await m.snapshot(T1))!)
    expect(t.buffer.active.type).toBe('alternate'); expect(t.modes.bracketedPasteMode).toBe(true)
    expect(t.modes.applicationCursorKeysMode).toBe(true); expect(textOf(t).join('\n')).toContain('TUI')
  })

  it('a snapshot taken while a program has the alternate screen keeps the normal buffer\'s history', async () => {
    m.open(T1, 40, 10, 1000); m.write(T1, 1, numbered(300) + '\x1b[?1049hTUI')
    const t = await replay((await m.snapshot(T1))!)
    await new Promise<void>((resolve) => t.write('\x1b[?1049l', resolve))
    expect(textOf(t)).toContain('line 0')
  })

  it('a scrollback of 1 000 000 lines is cut to fit maxSnapshotBytes, keeping the newest lines', async () => {
    const m = new ScreenMirrors({ maxSnapshotBytes: 64 * 1024 }); m.open(T1, 80, 24, 1_000_000); m.write(T1, 1, numbered(5000))
    const s = (await m.snapshot(T1))!
    expect(Buffer.byteLength(JSON.stringify(s.data))).toBeLessThanOrEqual(64 * 1024); expect(textOf(await replay(s)).join('\n')).toContain('line 4999')
    m.dispose()
  })

  it('a copy that waits for its seed holds the output, then shows the seed and the output after it, each once', async () => {
    m.open(T1, 40, 10, 1000, { seq: 7, awaitSeed: true }); m.write(T1, 8, 'after\r\n')
    const snap = m.snapshot(T1); m.seed(T1, 'before\r\n')
    const s = (await snap)!; expect(s.seq).toBe(8)
    expect(textOf(await replay(s)).filter((l) => l !== '')).toEqual(['before', 'after'])
  })

  it('without a seed in seedWaitMs the held output shows alone, and a late seed is ignored', async () => {
    const m = new ScreenMirrors({ maxSnapshotBytes: 1024 * 1024, seedWaitMs: 50 }); m.open(T1, 40, 10, 100, { awaitSeed: true }); m.write(T1, 1, 'only')
    const s = (await m.snapshot(T1))!; m.seed(T1, 'late'); expect(textOf(await replay(s))[0]).toBe('only')
    expect(textOf(await replay((await m.snapshot(T1))!))[0]).toBe('only')
    m.dispose()
  })

  it('reset starts clean, resize changes the size, an empty write moves the number on, a title a program sets is reported', async () => {
    m.open(T1, 40, 10, 100); m.write(T1, 1, 'x\x1b]0;build\x07'); m.reset(T1, 2); m.resize(T1, 50, 12); m.write(T1, 3, '')
    const s = (await m.snapshot(T1))!; expect(s).toMatchObject({ seq: 3, cols: 50, rows: 12 }); expect(textOf(await replay(s))[0]).toBe(''); expect(titles).toContainEqual([T1, 'build'])
  })

  it('a snapshot of a tab it does not have is null', async () => expect(await m.snapshot(T9)).toBeNull())

  it('boundedSerialize asks for the scrollback first, then a smaller count that scales to fit', () => {
    const asked: number[] = []
    const text = boundedSerialize((n) => { asked.push(n); return 'x'.repeat(n) }, 1000, 300)
    expect(asked[0]).toBe(1000)
    expect(asked[1]).toBeLessThan(1000)
    expect(new TextEncoder().encode(JSON.stringify(text)).length).toBeLessThanOrEqual(300)
  })

  it('boundedSerialize starts from the lines the buffer holds, not from the scrollback setting', () => {
    const asked: number[] = []
    boundedSerialize((n) => { asked.push(n); return 'x'.repeat(10) }, 1_000_000, 300, 50)
    expect(asked[0]).toBe(50)
  })

  it('at 0 boundedSerialize returns serialize(0), whatever its size', () => {
    const asked: number[] = []
    const text = boundedSerialize((n) => { asked.push(n); return 'x'.repeat(n + 500) }, 10, 5)
    expect(asked.at(-1)).toBe(0)
    expect(text).toHaveLength(500)
  })

  it('through a message port the copies answer the same', async () => {
    const { port1, port2 } = new MessageChannel(); serveMirrors(port2, new ScreenMirrors({ maxSnapshotBytes: 1024 * 1024 })); const p = new PortMirrors(port1)
    p.onTitle((id, t) => titles.push([id, t])); p.open(T1, 40, 10, 100); p.write(T1, 1, '\x1b]0;build\x07hello')
    expect((await p.snapshot(T1))!.seq).toBe(1); await until(() => titles.at(-1)?.[1] === 'build'); p.dispose(); port1.close()
  })

  it('a snapshot the worker never answers resolves null after snapshotTimeoutMs, and a late answer for it changes nothing', async () => {
    const { port1, port2 } = new MessageChannel()
    const requests: number[] = []
    port2.on('message', (r: { op: string; req?: number }) => {
      if (r.op !== 'snapshot' || r.req === undefined) return
      requests.push(r.req)
      if (r.req > 1) port2.postMessage({ op: 'snapshot', req: r.req, snap: { data: 'second', seq: 5, cols: 40, rows: 10 } })
    })
    const p = new PortMirrors(port1, { snapshotTimeoutMs: 50 })
    p.onTitle((id, t) => titles.push([id, t]))
    expect(await p.snapshot(T1)).toBeNull()
    port2.postMessage({ op: 'snapshot', req: 1, snap: { data: 'late', seq: 99, cols: 40, rows: 10 } })
    port2.postMessage({ op: 'title', tabId: T1, title: 'marker' })
    await until(() => titles.some((t) => t[1] === 'marker'))
    expect(await p.snapshot(T1)).toMatchObject({ seq: 5 })
    expect(requests).toEqual([1, 2])
    p.dispose(); port1.close(); port2.close()
  })

  it('a malformed event from the worker is ignored, and a later good answer still resolves', async () => {
    const { port1, port2 } = new MessageChannel()
    const p = new PortMirrors(port1)
    p.onTitle((id, t) => titles.push([id, t]))
    const snap = p.snapshot(T1)
    port2.postMessage({ op: 'snapshot', req: 'one', snap: { data: 'x', seq: 1, cols: 1, rows: 1 } })
    port2.postMessage({ op: 'snapshot' })
    port2.postMessage({ op: 'title', tabId: T1, title: 3 })
    port2.postMessage({ op: 'nonsense' })
    port2.postMessage({ op: 'snapshot', req: 1, snap: { data: 'x', seq: 4, cols: 2, rows: 2 } })
    expect((await snap)).toMatchObject({ seq: 4, cols: 2, rows: 2 })
    expect(titles).toEqual([])
    p.dispose(); port1.close(); port2.close()
  })

  it('more than maxHeldChars held writes show the held output alone, and a later seed is ignored', async () => {
    const m = new ScreenMirrors({ maxSnapshotBytes: 1024 * 1024, maxHeldChars: 10 })
    m.open(T1, 40, 10, 100, { awaitSeed: true }); m.write(T1, 1, 'aaaaa'); m.write(T1, 2, 'bbbbbbbb')
    const s = (await m.snapshot(T1))!; m.seed(T1, 'SEED')
    expect(s.seq).toBe(2); expect(textOf(await replay(s))[0]).toBe('aaaaabbbbbbbb')
    expect(textOf(await replay((await m.snapshot(T1))!)).join('\n')).not.toContain('SEED')
    m.dispose()
  })

  it('closing a copy that waits drops its held output: no write follows, and its snapshot is null', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      m.open(T1, 40, 10, 100, { awaitSeed: true }); m.write(T1, 1, '\x1b]0;held\x07')
      const snap = m.snapshot(T1)
      m.close(T1)
      expect(await snap).toBeNull()
      vi.advanceTimersByTime(10_000)
      expect(titles).toEqual([])
      expect(await m.snapshot(T1)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a reset and a resize held while the copy waits are applied in order with the held output', async () => {
    m.open(T1, 40, 10, 100, { awaitSeed: true })
    m.write(T1, 1, 'one\r\n'); m.resize(T1, 50, 12); m.write(T1, 2, 'two\r\n'); m.reset(T1, 3); m.write(T1, 4, 'four')
    const snap = m.snapshot(T1); m.seed(T1, 'seed\r\n')
    const s = (await snap)!
    expect(s).toMatchObject({ seq: 4, cols: 50, rows: 12 })
    expect(textOf(await replay(s)).filter((l) => l !== '')).toEqual(['four'])
  })

  it('an error while a snapshot is taken answers null, and the copy keeps working', async () => {
    m.open(T1, 40, 10, 100); m.write(T1, 1, 'hello')
    const spy = vi.spyOn(SerializeAddon.prototype, 'serialize').mockImplementationOnce(() => { throw new Error('boom') })
    try {
      expect(await m.snapshot(T1)).toBeNull()
    } finally {
      spy.mockRestore()
    }
    expect(textOf(await replay((await m.snapshot(T1))!))[0]).toBe('hello')
  })

  it('a copy takes the scrollback it asks for from the buffer it holds, not from the setting', async () => {
    m.open(T1, 40, 10, 1_000_000); m.write(T1, 1, numbered(50))
    const spy = vi.spyOn(SerializeAddon.prototype, 'serialize')
    try {
      await m.snapshot(T1)
      expect(spy.mock.calls[0][0]?.scrollback).toBeLessThan(1000)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('PortMirrors over a fake port', () => {
  it('onExit fires once when the worker exits', () => {
    const f = fakePort(); const p = new PortMirrors(f.port); let n = 0
    p.onExit(() => n++)
    f.emit('exit'); f.emit('exit')
    expect(n).toBe(1)
  })

  it('onExit fires once when the worker fails, and not again on exit', () => {
    const f = fakePort(); const p = new PortMirrors(f.port); let n = 0
    p.onExit(() => n++)
    f.emit('error', new Error('boom')); f.emit('exit')
    expect(n).toBe(1)
  })

  it('dispose does not fire onExit, and stops the worker', () => {
    const f = fakePort(); const p = new PortMirrors(f.port); let n = 0
    p.onExit(() => n++)
    p.dispose(); f.emit('exit')
    expect(n).toBe(0)
    expect(f.terminated()).toBe(1)
  })

  it('a throwing onExit callback does not stop the others', () => {
    const f = fakePort(); const p = new PortMirrors(f.port); const ran: string[] = []
    p.onExit(() => { ran.push('first'); throw new Error('boom') })
    p.onExit(() => { ran.push('second') })
    expect(() => f.emit('exit')).not.toThrow()
    expect(ran).toEqual(['first', 'second'])
  })

  it('a snapshot answer that fails the check resolves its request null at once, not after the time limit', async () => {
    const f = fakePort(); const p = new PortMirrors(f.port)
    const snap = p.snapshot(T1)
    let got: unknown = 'pending'
    snap.then((s) => { got = s })
    f.emit('message', { op: 'snapshot', req: 1, snap: { data: '', seq: 0, cols: 0, rows: 24 } })
    await new Promise((r) => setImmediate(r))
    expect(got).toBeNull()
    p.dispose()
  })
})

describe('the worker side', () => {
  it('a null or malformed message to the worker changes nothing, and a later snapshot still answers', async () => {
    const { port1, port2 } = new MessageChannel()
    serveMirrors(port2, new ScreenMirrors({ maxSnapshotBytes: 1024 * 1024 }))
    const p = new PortMirrors(port1)
    p.open(T1, 40, 10, 100); p.write(T1, 1, 'hello')
    port1.postMessage(null); port1.postMessage({ op: 'nope' })
    expect(await p.snapshot(T1)).toMatchObject({ seq: 1 })
    p.dispose(); port1.close()
  })

  it('the snapshot limit comes from workerData, and 8 MiB when it is not a positive safe integer', () => {
    expect(snapshotLimitOf(4096)).toBe(4096)
    for (const bad of [undefined, null, 0, -1, 1.5, '4096', Number.MAX_SAFE_INTEGER + 2]) expect(snapshotLimitOf(bad)).toBe(8 * 1024 * 1024)
  })
})
