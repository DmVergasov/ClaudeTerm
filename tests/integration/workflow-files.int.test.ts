import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RUN_FILE_CAP, readRunFile } from '../../src/main/workflow-files'

// A Workflow run's file, as Claude Code writes it when the run ends: read from the session folder, checked and typed

const RUN = 'wf_55e3c3ec-b29'

let root: string
let session: string

/** a link to a folder: a junction on Windows, which needs no privilege */
const linkDir = (target: string, path: string) => symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')

/** the run file's text as Claude Code writes it, with what the test changes */
function runJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    runId: RUN,
    taskId: 'w9ehhq53f',
    workflowName: 'crash-triage',
    status: 'completed',
    startTime: '2026-11-19T10:00:00.000Z',
    durationMs: 134_000,
    agentCount: 2,
    workflowProgress: [
      { type: 'workflow_phase', index: 0, title: 'Triage' },
      { type: 'workflow_agent', index: 0, label: 'triage-a', phaseIndex: 0, phaseTitle: 'Triage', agentId: 'a1b2c3d4', model: 'claude-haiku-5-5', state: 'done', attempt: 1, promptPreview: 'Look at crash 1' },
      { type: 'workflow_agent', index: 1, label: 'triage-b', phaseIndex: 0, phaseTitle: 'Triage', agentId: 'e5f6a7b8', state: 'error', attempt: 1 },
    ],
    ...over,
  })
}

/** the run file of the session, written under its workflows folder */
function writeRun(text: string, runId = RUN): void {
  mkdirSync(join(session, 'workflows'), { recursive: true })
  writeFileSync(join(session, 'workflows', `${runId}.json`), text)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workflow-files-'))
  session = join(root, 'projects', 'work', '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8')
  mkdirSync(session, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('readRunFile', () => {
  it('a finished run file gives its fields: completed is done, an ISO start is its ms, the rows are parsed', async () => {
    writeRun(runJson())
    const file = await readRunFile(session, RUN)
    expect(file).toMatchObject({
      taskId: 'w9ehhq53f', name: 'crash-triage', state: 'done', startedAt: Date.parse('2026-11-19T10:00:00.000Z'), ms: 134_000,
    })
    expect(file?.rows?.phases).toEqual([{ index: 0, title: 'Triage' }])
    expect(file?.rows?.agents).toMatchObject([
      { key: '0', agentId: 'a1b2c3d4', label: 'triage-a', phase: 0, state: 'done', model: 'claude-haiku-5-5' },
      { key: '1', agentId: 'e5f6a7b8', label: 'triage-b', phase: 0, state: 'failed' },
    ])
  })

  it('a start given as ms is kept as ms', async () => {
    writeRun(runJson({ startTime: 1_700_000_000_000 }))
    expect((await readRunFile(session, RUN))?.startedAt).toBe(1_700_000_000_000)
  })

  it('an unknown status is stopped', async () => {
    writeRun(runJson({ status: 'weird' }))
    expect((await readRunFile(session, RUN))?.state).toBe('stopped')
  })

  it('a file over 1 MiB gives null', async () => {
    writeRun(runJson({ padding: 'x'.repeat(RUN_FILE_CAP) }))
    expect(await readRunFile(session, RUN)).toBeNull()
  })

  it('a file that is not JSON gives null', async () => {
    writeRun('{ not json')
    expect(await readRunFile(session, RUN)).toBeNull()
  })

  it('a run id that is not a run id gives null, and no file is read for it', async () => {
    writeRun(runJson(), RUN)
    expect(await readRunFile(session, '../x')).toBeNull()
    expect(await readRunFile(session, 'wf_55e3c3ec-b29/../../x')).toBeNull()
  })

  it('a workflows folder that is a junction or symlink leading outside the session gives null', async () => {
    const outside = join(root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, `${RUN}.json`), runJson())
    await linkDir(outside, join(session, 'workflows'))
    expect(await readRunFile(session, RUN)).toBeNull()
  })
})
