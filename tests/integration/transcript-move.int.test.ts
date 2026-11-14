import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyAt, copyTranscript, decideMove, findCopies, type TranscriptCopy } from '../../src/main/transcript-move'

// real folders under tmpdir(): an account's projects/ with a conversation and its <id>/ folder beside it

const ID = 'session-1'
const PROJECT = 'D--Work-my_project-x'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'transcript-move-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** writes <projects>/<project>/<ID>.jsonl with its <ID>/ folder and returns the copy as findCopies reports it */
function writeCopy(projects: string, project: string, text: string, mtimeSec: number, account: string | null): TranscriptCopy {
  const folder = join(projects, project)
  mkdirSync(join(folder, ID, 'subagents'), { recursive: true })
  const path = join(folder, `${ID}.jsonl`)
  writeFileSync(path, text)
  writeFileSync(join(folder, ID, 'subagents', 'agent.txt'), `agent of ${text}`)
  utimesSync(path, mtimeSec, mtimeSec)
  return { account, projects, project, path, mtimeMs: mtimeSec * 1000 }
}

describe('copyTranscript', () => {
  it('the transcript and its folder go under the source\'s project folder name', async () => {
    const main = join(dir, 'main', 'projects')
    const work = join(dir, 'work', 'projects')
    const from = writeCopy(main, PROJECT, 'line one\n', 1_700_000_000, null)

    await copyTranscript(from, work)

    expect(readFileSync(join(work, PROJECT, `${ID}.jsonl`), 'utf8')).toBe('line one\n')
    expect(readFileSync(join(work, PROJECT, ID, 'subagents', 'agent.txt'), 'utf8')).toBe('agent of line one\n')
    // Claude Code's own folder name is kept, not recomputed from the cwd
    expect(readdirSync(work)).toEqual([PROJECT])
    expect(readdirSync(join(work, PROJECT)).sort()).toEqual([`${ID}`, `${ID}.jsonl`])
  })

  it('the copy keeps the source\'s modification time', async () => {
    const main = join(dir, 'main', 'projects')
    const work = join(dir, 'work', 'projects')
    const from = writeCopy(main, PROJECT, 'text', 1_600_000_000, null)

    await copyTranscript(from, work)

    const copied = statSync(join(work, PROJECT, `${ID}.jsonl`)).mtimeMs
    expect(Math.abs(copied - from.mtimeMs)).toBeLessThan(1)
  })

  it('a copy of a fractional source time is the same conversation both ways', async () => {
    const main = join(dir, 'main', 'projects')
    const work = join(dir, 'work', 'projects')
    const from = writeCopy(main, PROJECT, 'text', 1_700_000_000, null)
    utimesSync(from.path, 1_700_000_000.1234567, 1_700_000_000.1234567)
    const src = { ...from, mtimeMs: statSync(from.path).mtimeMs }

    await copyTranscript(src, work)

    const roots = [
      { account: null, projects: main },
      { account: 'work', projects: work },
    ]
    const copies = await findCopies(roots, ID)
    const mainCopy = copyAt(src.path, copies)
    const workCopy = copyAt(join(work, PROJECT, `${ID}.jsonl`), copies)
    expect(mainCopy).not.toBeNull()
    expect(workCopy).not.toBeNull()
    expect(decideMove({ explicit: true, target: main, source: workCopy, copies })).toEqual({ kind: 'none' })
    expect(decideMove({ explicit: true, target: work, source: mainCopy, copies })).toEqual({ kind: 'none' })
  })

  it('a source without a folder leaves the target\'s folder where it is', async () => {
    const main = join(dir, 'main', 'projects')
    const work = join(dir, 'work', 'projects')
    mkdirSync(join(main, PROJECT), { recursive: true })
    const path = join(main, PROJECT, `${ID}.jsonl`)
    writeFileSync(path, 'new text')
    utimesSync(path, 1_700_000_000, 1_700_000_000)
    const from: TranscriptCopy = { account: null, projects: main, project: PROJECT, path, mtimeMs: statSync(path).mtimeMs }
    // the target's own subagent transcripts sit in its <id>/ folder
    writeCopy(work, PROJECT, 'old text', 1_600_000_000, 'work')

    await copyTranscript(from, work)

    expect(readFileSync(join(work, PROJECT, `${ID}.jsonl`), 'utf8')).toBe('new text')
    expect(readFileSync(join(work, PROJECT, ID, 'subagents', 'agent.txt'), 'utf8')).toBe('agent of old text')
    expect(readdirSync(join(work, PROJECT)).sort()).toEqual([`${ID}`, `${ID}.jsonl`])
  })

  it('an older copy and its folder are replaced', async () => {
    const main = join(dir, 'main', 'projects')
    const work = join(dir, 'work', 'projects')
    const from = writeCopy(main, PROJECT, 'new text', 1_700_000_000, null)
    const old = writeCopy(work, PROJECT, 'old text', 1_600_000_000, 'work')
    writeFileSync(join(work, PROJECT, ID, 'stale.txt'), 'stale')

    await copyTranscript(from, work)

    expect(readFileSync(old.path, 'utf8')).toBe('new text')
    expect(existsSync(join(work, PROJECT, ID, 'stale.txt'))).toBe(false)
    expect(readFileSync(join(work, PROJECT, ID, 'subagents', 'agent.txt'), 'utf8')).toBe('agent of new text')
    expect(readdirSync(join(work, PROJECT)).sort()).toEqual([`${ID}`, `${ID}.jsonl`])
  })

  it('a failed copy leaves no temporary file and the target as it was', async () => {
    const main = join(dir, 'main', 'projects')
    const work = join(dir, 'work', 'projects')
    const from = writeCopy(main, PROJECT, 'text', 1_700_000_000, null)
    // the target project path is a file: the copy cannot make its folder
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, PROJECT), 'not a folder')

    await expect(copyTranscript(from, work)).rejects.toThrow()

    expect(readFileSync(join(work, PROJECT), 'utf8')).toBe('not a folder')
    expect(readdirSync(work)).toEqual([PROJECT])
    expect(readdirSync(join(main, PROJECT)).sort()).toEqual([`${ID}`, `${ID}.jsonl`])
  })

  it('a failed transcript rename puts the older folder back', async () => {
    const main = join(dir, 'main', 'projects')
    const work = join(dir, 'work', 'projects')
    const from = writeCopy(main, PROJECT, 'new text', 1_700_000_000, null)
    writeCopy(work, PROJECT, 'old text', 1_600_000_000, 'work')
    // a folder where the transcript goes: renaming the copy over it fails after the folder was swapped
    rmSync(join(work, PROJECT, `${ID}.jsonl`))
    mkdirSync(join(work, PROJECT, `${ID}.jsonl`))
    writeFileSync(join(work, PROJECT, ID, 'stale.txt'), 'stale')

    await expect(copyTranscript(from, work)).rejects.toThrow()

    expect(existsSync(join(work, PROJECT, ID, 'stale.txt'))).toBe(true)
    expect(readdirSync(join(work, PROJECT)).sort()).toEqual([`${ID}`, `${ID}.jsonl`])
  })
})

describe('findCopies', () => {
  it('findCopies finds every account\'s copy and skips a missing root', async () => {
    const main = join(dir, 'main', 'projects')
    const work = join(dir, 'work', 'projects')
    const missing = join(dir, 'gone', 'projects')
    const a = writeCopy(main, PROJECT, 'a', 1_700_000_000, null)
    const b = writeCopy(work, 'D--Other', 'b', 1_710_000_000, 'work')
    mkdirSync(join(main, 'D--Empty'))

    const found = await findCopies(
      [
        { account: null, projects: main },
        { account: 'work', projects: work },
        { account: 'gone', projects: missing },
      ],
      ID,
    )

    expect(found.map((c) => [c.account, c.project, c.path, c.mtimeMs])).toEqual([
      [null, PROJECT, a.path, a.mtimeMs],
      ['work', 'D--Other', b.path, b.mtimeMs],
    ])
  })

  it('a session id with a path separator or .. finds nothing', async () => {
    const main = join(dir, 'main', 'projects')
    writeCopy(main, PROJECT, 'a', 1_700_000_000, null)
    expect(await findCopies([{ account: null, projects: main }], '../' + ID)).toEqual([])
    expect(await findCopies([{ account: null, projects: main }], '..')).toEqual([])
    expect(await findCopies([{ account: null, projects: main }], '')).toEqual([])
  })
})
