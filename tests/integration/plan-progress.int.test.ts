import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLAN_FILE_MAX_BYTES, PlanHub, readPlanFile } from '../../src/main/plan-hub'
import { TranscriptFeed } from '../../src/main/transcript-feed'
import { bashResultLine, toolUseLine } from '../fixtures/transcript'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const PLAN_TEXT = '# CSV Export Implementation Plan\n### Task 1: Rows\n### Task 2: Escaping\n### Task 3: Button\n'
const LEDGER = 'Task 1: complete (commits a..b, review clean)\n'

describe('readPlanFile', () => {
  it('text, missing, a missing parent folder, over the cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-plan-'))
    const file = join(dir, 'plan.md')
    writeFileSync(file, 'hello\n')
    expect(await readPlanFile(file)).toBe('hello\n')
    expect(await readPlanFile(join(dir, 'absent.md'))).toBe('missing')
    expect(await readPlanFile(join(file, 'x'))).toBe('missing')
    const big = join(dir, 'big.md')
    writeFileSync(big, Buffer.alloc(PLAN_FILE_MAX_BYTES + 1, 97))
    expect(await readPlanFile(big)).toBe('error')
  })
})

describe.skipIf(process.platform === 'win32')('readPlanFile on files that are not regular', () => {
  it('a device, a symlink to one and a FIFO give error without reading them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-plan-'))
    expect(await readPlanFile('/dev/zero')).toBe('error')
    const link = join(dir, 'plan.md')
    symlinkSync('/dev/zero', link)
    expect(await readPlanFile(link)).toBe('error')
    const fifo = join(dir, 'fifo.md')
    execFileSync('mkfifo', [fifo])
    expect(await readPlanFile(fifo)).toBe('error')
    expect(await readPlanFile(dir)).toBe('error')
  })
})

function layout() {
  const root = mkdtempSync(join(tmpdir(), 'ct-plan-'))
  const wt = join(root, 'wt')
  const ws = join(wt, '.superpowers', 'sdd', '2026-10-20-csv-export')
  const old = join(wt, '.superpowers', 'sdd', '2026-09-01-old')
  mkdirSync(ws, { recursive: true })
  mkdirSync(old, { recursive: true })
  mkdirSync(join(wt, 'docs', 'superpowers', 'plans'), { recursive: true })
  writeFileSync(join(wt, 'docs', 'superpowers', 'plans', '2026-10-20-csv-export.md'), PLAN_TEXT)
  writeFileSync(join(ws, 'plan-path'), 'docs/superpowers/plans/2026-10-20-csv-export.md\n')
  writeFileSync(join(ws, 'progress.md'), LEDGER)
  writeFileSync(join(wt, 'docs', 'superpowers', 'plans', '2026-09-01-old.md'), '# Old Import Implementation Plan\n### Task 1: Parse\n### Task 2: Map\n')
  writeFileSync(join(old, 'plan-path'), 'docs/superpowers/plans/2026-09-01-old.md\n')
  writeFileSync(join(old, 'progress.md'), 'Task 1: complete\nFinal review: clean\n')
  const projectDir = join(root, 'projects', 'D--x')
  const subagents = join(projectDir, SID, 'subagents')
  mkdirSync(subagents, { recursive: true })
  const transcriptPath = join(projectDir, `${SID}.jsonl`)
  writeFileSync(transcriptPath, toolUseLine('m1', 'Skill', { skill: 'superpowers:subagent-driven-development' }) + '\n')
  writeFileSync(join(subagents, 'agent-o1.jsonl'), [
    toolUseLine('s1', 'Bash', { command: 'bash /p/scripts/sdd-workspace docs/superpowers/plans/2026-10-20-csv-export.md' }),
    bashResultLine('s1', ws + '\n')
  ].join('\n') + '\n')
  return { root, ws, old, transcriptPath }
}

function wire(root: string, transcriptPath: string) {
  const hub = new PlanHub({ read: readPlanFile, onChange: () => {} })
  const feed = new TranscriptFeed({
    transcriptPath, sessionId: SID, cacheRoot: join(root, 'cache'), fileExists: existsSync, onImage: () => {},
    onPlanWorkspace: (p, at) => void hub.workspace('t', p, at)
  })
  return { hub, feed }
}

describe('plan progress', () => {
  it("a plan run in a worktree outside the tab's folder, found from an orchestrator subagent's transcript; old workspaces stay out", async () => {
    const { root, ws, transcriptPath } = layout()
    const { hub, feed } = wire(root, transcriptPath)
    feed.scanSubagents()
    await feed.poll()
    await expect.poll(() => hub.get('t').plan?.title, { timeout: 5000 }).toBe('CSV Export')
    expect(hub.get('t').plan?.done).toBe(1)
    appendFileSync(join(ws, 'progress.md'), 'Task 2: complete\n')
    await hub.refresh()
    expect(hub.get('t').plan?.done).toBe(2)
  })

  it('a replay reads the transcripts in file order: the newer plan of the main transcript beats an older one in a subagent transcript', async () => {
    const { root, ws, old, transcriptPath } = layout()
    const subagent = join(dirname(transcriptPath), SID, 'subagents', 'agent-o1.jsonl')
    writeFileSync(subagent, [
      toolUseLine('s1', 'Bash', { command: 'bash /p/scripts/sdd-workspace docs/superpowers/plans/2026-09-01-old.md' }, '2026-09-01T10:00:00.000Z'),
      bashResultLine('s1', old + '\n', '2026-09-01T10:00:01.000Z')
    ].join('\n') + '\n')
    writeFileSync(transcriptPath, [
      toolUseLine('m2', 'Bash', { command: 'bash /p/scripts/sdd-workspace docs/superpowers/plans/2026-10-20-csv-export.md' }, '2026-10-20T10:00:00.000Z'),
      bashResultLine('m2', ws + '\n', '2026-10-20T10:00:01.000Z')
    ].join('\n') + '\n')
    const { hub, feed } = wire(root, transcriptPath)
    feed.scanSubagents()
    await feed.poll()
    await expect.poll(() => hub.get('t').plan?.title, { timeout: 5000 }).toBe('CSV Export')
    await hub.refresh()
    expect(hub.get('t').plan?.title).toBe('CSV Export')
  })
})
