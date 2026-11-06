import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pathKey } from '../../src/main/path-key'
import { TranscriptFeed } from '../../src/main/transcript-feed'
import { editResultLine } from '../fixtures/transcript'

// The feed's file reads and folder listings, as the tests see them. They finish at once (the work underneath is
// synchronous), so fake timers step the feed tick by tick over real files.
const io = vi.hoisted(() => ({ opened: [] as { path: string; at: number }[], listed: [] as number[] }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    open: async (path: string) => {
      io.opened.push({ path, at: Date.now() })
      const fd = fs.openSync(path, 'r')
      return {
        stat: async () => fs.fstatSync(fd),
        read: async (buffer: Buffer, offset: number, length: number, position: number) => ({ bytesRead: fs.readSync(fd, buffer, offset, length, position), buffer }),
        close: async () => fs.closeSync(fd)
      }
    },
    readdir: async (dir: string) => {
      io.listed.push(Date.now())
      return fs.readdirSync(dir)
    }
  }
})

// listing the subagents folder must not be a blocking call: the spy shows whether one is made
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) }
})

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const BASE = 100
const MAIN_MAX = 400
const SUB_MAX = 1600
const RECENT = 1000
const SCAN = 200
const SCAN_MAX = 1600

const edit = (toolUseId: string): string => editResultLine({ toolUseId, filePath: '/p/a.ts' }) + '\n'

const feeds: TranscriptFeed[] = []

beforeEach(() => {
  vi.useFakeTimers({ now: 0 })
  io.opened.length = 0
  io.listed.length = 0
})

afterEach(() => {
  for (const f of feeds.splice(0)) f.stop()
  vi.useRealTimers()
})

/** a session whose main transcript holds edit m0 and whose subagents folder is empty; `agent` writes an agent's transcript into it */
function setup(o: { onEdit?: (toolUseId: string, feed: TranscriptFeed) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ct-poll-'))
  const projectDir = join(root, 'projects', 'D--x')
  const transcriptPath = join(projectDir, `${SID}.jsonl`)
  const subagentDir = join(projectDir, SID, 'subagents')
  mkdirSync(subagentDir, { recursive: true })
  writeFileSync(transcriptPath, edit('m0'))
  const edits: { id: string; at: number }[] = []
  const feed: TranscriptFeed = new TranscriptFeed({
    transcriptPath, sessionId: SID, cacheRoot: join(root, 'cache'), fileExists: existsSync, onImage: () => {},
    onEditEvent: (ev) => {
      if (ev.kind !== 'edit') return
      edits.push({ id: ev.toolUseId, at: Date.now() })
      o.onEdit?.(ev.toolUseId, feed)
    },
    pollMs: BASE, pollMaxMs: MAIN_MAX, subagentPollMaxMs: SUB_MAX, subagentRecentMs: RECENT, subagentScanMs: SCAN, subagentScanMaxMs: SCAN_MAX
  })
  feeds.push(feed)
  const agent = (name: string, ...toolUseIds: string[]): string => {
    const p = join(subagentDir, `agent-${name}.jsonl`)
    writeFileSync(p, toolUseIds.map(edit).join(''))
    return p
  }
  return { transcriptPath, agent, feed, edits }
}

/** when the feed opened the file, in ms of fake time */
const opens = (file: string): number[] => io.opened.filter((o) => pathKey(o.path) === pathKey(file)).map((o) => o.at)
const gaps = (times: number[]): number[] => times.slice(1).map((t, i) => t - times[i])

describe('TranscriptFeed polling', () => {
  // fails when every transcript is read on every tick, or when the wait has no cap
  it('reads an idle subagent transcript less and less often, and never more rarely than its cap', async () => {
    const { agent, feed } = setup()
    const sub = agent('a1', 's1')
    feed.start()
    await vi.advanceTimersByTimeAsync(8000)
    expect(gaps(opens(sub))).toEqual([100, 200, 400, 800, 1600, 1600, 1600, 1600])
  })

  // fails when the main transcript waits as long as a subagent's transcript (one cap for both)
  it('waits at most its own shorter cap between reads of the main transcript', async () => {
    const { transcriptPath, feed } = setup()
    feed.start()
    await vi.advanceTimersByTimeAsync(3000)
    expect(gaps(opens(transcriptPath))).toEqual([100, 200, 400, 400, 400, 400, 400, 400])
  })

  // fails when new lines do not bring the wait back to the base interval, or when a line is read twice
  it('reads lines written to a backed-off transcript within the cap, once, and then reads it every tick again', async () => {
    const { agent, feed, edits } = setup()
    const sub = agent('a1', 's1')
    feed.start()
    await vi.advanceTimersByTimeAsync(3200)
    expect(opens(sub).at(-1)).toBe(3100)
    appendFileSync(sub, edit('s2') + edit('s3'))
    await vi.advanceTimersByTimeAsync(SUB_MAX)
    expect(edits).toEqual([{ id: 'm0', at: 0 }, { id: 's1', at: 0 }, { id: 's2', at: 4700 }, { id: 's3', at: 4700 }])
    await vi.advanceTimersByTimeAsync(2000)
    expect(opens(sub).filter((t) => t >= 4700)).toEqual([4700, 4800, 5000, 5400, 6200])
    expect(edits.map((e) => e.id)).toEqual(['m0', 's1', 's2', 's3'])
  })

  // fails when wake() leaves the main transcript or a lately active subagent's one to its wait, or when it reads the
  // transcript of an agent long finished too
  it('wake() has the next tick read the main transcript and a subagent\'s that brought lines lately, not one long idle', async () => {
    const { transcriptPath, agent, feed, edits } = setup()
    const active = agent('a1', 's1')
    const idle = agent('a2', 'i1')
    feed.start()
    await vi.advanceTimersByTimeAsync(2000)
    appendFileSync(active, edit('s2'))
    await vi.advanceTimersByTimeAsync(1900)
    // a1 brought s2 at 3100 and is read next at 4600; the main transcript at 4300; a2, idle since 0, at 4700
    expect(edits.at(-1)).toEqual({ id: 's2', at: 3100 })
    appendFileSync(transcriptPath, edit('m1'))
    appendFileSync(active, edit('s3'))
    appendFileSync(idle, edit('i2'))
    feed.wake()
    await vi.advanceTimersByTimeAsync(BASE)
    expect(edits.slice(4)).toEqual([{ id: 'm1', at: 4000 }, { id: 's3', at: 4000 }])
    expect(opens(idle).filter((t) => t > 3900)).toEqual([])
    await vi.advanceTimersByTimeAsync(700)
    expect(edits.at(-1)).toEqual({ id: 'i2', at: 4700 })
  })

  // fails when wake(agentId) does not read that agent's transcript at the next tick
  it('wake(agentId) has the next tick read that agent\'s transcript, also when it was idle long', async () => {
    const { agent, feed, edits } = setup()
    const named = agent('a1', 's1')
    const other = agent('a2', 'i1')
    feed.start()
    await vi.advanceTimersByTimeAsync(3200)
    appendFileSync(named, edit('s2'))
    appendFileSync(other, edit('i2'))
    feed.wake('a1')
    await vi.advanceTimersByTimeAsync(BASE)
    expect(edits.slice(3)).toEqual([{ id: 's2', at: 3300 }])
    expect(opens(other).filter((t) => t > 3200)).toEqual([])
  })

  // fails when the folder is listed with a blocking call, on every tick, or never again once the listings backed off
  it('lists the subagents folder less and less often without a blocking call, and still finds a new agent within the cap', async () => {
    const { agent, feed, edits } = setup()
    vi.mocked(readdirSync).mockClear()
    feed.start()
    await vi.advanceTimersByTimeAsync(3100)
    expect(gaps(io.listed)).toEqual([200, 400, 800, 1600])
    agent('a2', 'n1')
    await vi.advanceTimersByTimeAsync(SCAN_MAX)
    expect(edits.at(-1)).toEqual({ id: 'n1', at: 4600 })
    expect(readdirSync).not.toHaveBeenCalled()
  })

  // fails when wake() does not list the subagents folder again at the next tick
  it('finds a new agent at the next tick after wake()', async () => {
    const { agent, feed, edits } = setup()
    feed.start()
    await vi.advanceTimersByTimeAsync(3100)
    agent('a2', 'n1')
    feed.wake()
    await vi.advanceTimersByTimeAsync(BASE)
    expect(edits.at(-1)).toEqual({ id: 'n1', at: 3200 })
  })

  // fails when stop() leaves a timer running, or when a read under way goes on to the next transcript after stop()
  it('stop() leaves no timer and no read behind, also when it comes in the middle of a read', async () => {
    let stoppedAt = -1
    const { transcriptPath, agent, feed, edits } = setup({ onEdit: (id, f) => { if (id === 'm1') { stoppedAt = Date.now(); f.stop() } } })
    const sub = agent('a1', 's1')
    feed.start()
    await vi.advanceTimersByTimeAsync(600)
    // both transcripts are read next at 700, the main one first
    appendFileSync(transcriptPath, edit('m1'))
    appendFileSync(sub, edit('s2'))
    await vi.advanceTimersByTimeAsync(BASE)
    expect(stoppedAt).toBe(700)
    expect(opens(sub).filter((t) => t >= stoppedAt)).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    const seen = io.opened.length + io.listed.length
    feed.wake()
    await vi.advanceTimersByTimeAsync(SCAN_MAX + SUB_MAX)
    expect(io.opened.length + io.listed.length).toBe(seen)
    expect(edits.map((e) => e.id)).toEqual(['m0', 's1', 'm1'])
  })

  // fails when the end of a turn reads the subagents' transcripts as well: they keep their waits and none is opened
  it('pollMain reads only the main transcript now and leaves the subagents\' waits as they were', async () => {
    const { transcriptPath, agent, feed } = setup()
    const sub = agent('a1', 's1')
    feed.start()
    await vi.advanceTimersByTimeAsync(3200)
    await feed.pollMain()
    expect(opens(transcriptPath)).toContain(3200)
    await vi.advanceTimersByTimeAsync(4800)
    expect(opens(sub)).toEqual([0, 100, 300, 700, 1500, 3100, 4700, 6300, 7900])
  })

  // fails when a poll that waits behind a read in progress resolves before a read started after it has finished
  it('two polls made while a read is in progress both read the lines written before they were called', async () => {
    const late: Promise<void>[] = []
    const { transcriptPath, feed, edits } = setup({
      onEdit: (id, f) => {
        // inside the first read, after it has looked at the file: a line written now is not in that read
        if (id !== 'm0') return
        appendFileSync(transcriptPath, edit('m1'))
        late.push(f.pollMain(), f.pollMain())
      }
    })
    await feed.pollMain()
    // the second caller first: it must not resolve before the read that takes its line has consumed it
    await late[1]
    expect(edits.map((e) => e.id)).toEqual(['m0', 'm1'])
    await late[0]
    expect(edits.map((e) => e.id)).toEqual(['m0', 'm1'])
  })
})
