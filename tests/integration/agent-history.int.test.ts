import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { symlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LINE_CAP, agentTranscriptPath, readAgentPage, resolveAgentTranscript } from '../../src/main/chat/agent-history'

// An agent's transcript is read from disk in pages: its paths are checked, its lines parsed backward from the end, and its links refused
// when they lead outside the project folder. Every file is under a temp folder of the test's own.

const SESSION = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const AGENT = 'a1b2c3d4e5'

/** a line of a transcript: an object with its number, so a page's lines can be told apart */
const line = (n: number): string => JSON.stringify({ type: 'assistant', uuid: `u${n}`, n })

/** the numbers of a page's lines, in the order the page gives them */
const numbers = (lines: Record<string, unknown>[]): number[] => lines.map(l => l.n as number)

/** a symbolic link to a folder: a junction on Windows, which needs no privilege */
const linkDir = (target: string, path: string) => symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')

let root: string
let projects: string
let project: string
let transcript: string
let subagents: string
let agentFile: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-history-'))
  projects = join(root, 'projects')
  project = join(projects, 'acme')
  transcript = join(project, `${SESSION}.jsonl`)
  subagents = join(project, SESSION, 'subagents')
  agentFile = join(subagents, `agent-${AGENT}.jsonl`)
  mkdirSync(subagents, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** writes the agent's transcript: one line per number, each ended by a line break */
function writeLines(file: string, count: number): void {
  writeFileSync(file, Array.from({ length: count }, (_, n) => `${line(n)}\n`).join(''))
}

describe('agent history', () => {
  it('reads a transcript in pages, newest first', async () => {
    writeLines(agentFile, 2500)
    const resolved = await resolveAgentTranscript(agentFile)
    expect(resolved).not.toBeNull()
    const first = await readAgentPage(resolved!, null)
    expect(first.lines).toHaveLength(2000)
    expect(numbers(first.lines)).toEqual(Array.from({ length: 2000 }, (_, i) => 500 + i))
    expect(first.start).toBeGreaterThan(0)
    const second = await readAgentPage(resolved!, first.start)
    expect(numbers(second.lines)).toEqual(Array.from({ length: 500 }, (_, i) => i))
    expect(second.start).toBe(0)
  })

  it('a broken line is skipped, and so is a line over 4 MiB', async () => {
    const huge = `{"type":"user","pad":"${'x'.repeat(LINE_CAP)}","n":99}`
    writeFileSync(agentFile, [line(0), 'not json', '[1,2]', line(1), huge, line(2)].join('\n') + '\n')
    const page = await readAgentPage(agentFile, null)
    expect(numbers(page.lines)).toEqual([0, 1, 2])
    expect(page.start).toBe(0)
  })

  it('a page stops at PAGE_BYTES counting the lines it skips, but not before it has a line', async () => {
    // two lines over the cap, then a good one: the page reads back past the two long lines, which are 10 MiB
    const over = `{"type":"user","pad":"${'x'.repeat(LINE_CAP + 100)}"}`
    writeFileSync(agentFile, [line(0), over, over.replace('"user"', '"other"'), line(1)].join('\n') + '\n')
    const page = await readAgentPage(agentFile, null)
    expect(numbers(page.lines)).toEqual([1])
    expect(page.start).toBeGreaterThan(0)
    // a run of lines that do not parse, longer than a page's bytes: the page goes on until it has a good line, so it reaches the first one
    const junk = `${'j'.repeat(1024 * 1024 - 1)}\n`
    writeFileSync(agentFile, line(0) + '\n' + junk.repeat(10))
    const rest = await readAgentPage(agentFile, null)
    expect(numbers(rest.lines)).toEqual([0])
    expect(rest.start).toBe(0)
  })

  it('a half-written last line is left for later', async () => {
    writeFileSync(agentFile, `${line(0)}\n${line(1)}\n{"type":"assistant","n":2,"pa`)
    expect(numbers((await readAgentPage(agentFile, null)).lines)).toEqual([0, 1])
    appendFileSync(agentFile, `d":1}\n`)
    expect(numbers((await readAgentPage(agentFile, null)).lines)).toEqual([0, 1, 2])
  })

  it('a line written while the page is read is not cut', async () => {
    writeFileSync(agentFile, `${line(0)}\n${line(1)}\n`)
    const end = statSync(agentFile).size
    // the writer goes on past the end the reader took: its lines, whole or half-written, are not part of this page
    appendFileSync(agentFile, `${line(2)}\n{"type":"assistant","n":3,"par`)
    const page = await readAgentPage(agentFile, end)
    expect(numbers(page.lines)).toEqual([0, 1])
    expect(page.start).toBe(0)
  })

  it('an id that fails the pattern builds no path', () => {
    expect(agentTranscriptPath(transcript, SESSION, '../x')).toBeNull()
    expect(agentTranscriptPath(transcript, SESSION, 'a\\b')).toBeNull()
    expect(agentTranscriptPath(transcript, SESSION, 'a'.repeat(129))).toBeNull()
    expect(agentTranscriptPath(transcript, 'not-a-session', AGENT)).toBeNull()
    expect(agentTranscriptPath(transcript, SESSION, 'a'.repeat(128))).toBe(join(dirname(transcript), SESSION, 'subagents', `agent-${'a'.repeat(128)}.jsonl`))
    expect(agentTranscriptPath(transcript, SESSION, AGENT)).toBe(join(dirname(transcript), SESSION, 'subagents', `agent-${AGENT}.jsonl`))
  })

  it('a subagents folder that is a junction or symlink to outside is not read', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeLines(join(outside, `agent-${AGENT}.jsonl`), 3)
    rmSync(subagents, { recursive: true, force: true })
    await linkDir(outside, subagents)
    const path = agentTranscriptPath(transcript, SESSION, AGENT)
    expect(path).not.toBeNull()
    expect(await resolveAgentTranscript(path!)).toBeNull()
  })

  it('an agent file that is a symlink to outside is not read', async ctx => {
    const outside = join(root, 'outside.jsonl')
    writeLines(outside, 3)
    try {
      await symlink(outside, agentFile, 'file')
    } catch (e) {
      // a platform that refuses a file link (Windows without developer mode) skips this case
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
      throw e
    }
    expect(await resolveAgentTranscript(agentFile)).toBeNull()
  })

  it.runIf(process.platform === 'win32')('on Windows, a config folder named by its 8.3 short name is read', async () => {
    writeLines(agentFile, 3)
    // the folder's short name; a volume without short names gives the long name, and the test still runs
    // verbatim: cmd reads its quotes as they are, not as Node escapes them
    const short = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${root}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim()
    const shortAgent = join(short, 'projects', 'acme', SESSION, 'subagents', `agent-${AGENT}.jsonl`)
    const resolved = await resolveAgentTranscript(shortAgent)
    expect(resolved).not.toBeNull()
    expect(numbers((await readAgentPage(resolved!, null)).lines)).toEqual([0, 1, 2])
  })
})
