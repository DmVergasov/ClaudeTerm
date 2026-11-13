import { describe, expect, it } from 'vitest'
import { PlanWorkspaceFinder } from '../../src/main/transcript-plan'
import { bashResultLine, editResultLine, toolUseLine } from '../fixtures/transcript'

const WS = '/w/acme-shop/.superpowers/sdd/2026-10-20-csv-export'
const RUN = 'cd /w/acme-shop && bash /p/skills/subagent-driven-development/scripts/sdd-workspace docs/superpowers/plans/2026-10-20-csv-export.md; ls /p/skills/subagent-driven-development'
const BRIEF = `cd /w/acme-shop && bash ${WS}/scripts/task-brief docs/superpowers/plans/2026-10-20-csv-export.md 3`
const PACKAGE = 'bash /p/skills/subagent-driven-development/scripts/review-package docs/superpowers/plans/2026-10-20-csv-export.md a1b2c3d HEAD'
const LEDGER = '# SDD ledger — plan: docs/superpowers/plans/2026-10-20-csv-export.md\n\nTask 1: complete (commits a1b2c3d..e4f5a6b, review clean)\n'

describe('PlanWorkspaceFinder', () => {
  it('the workspace path an sdd-workspace run printed, among the other output of the command', () => {
    const f = new PlanWorkspaceFinder()
    expect(f.parseLine(toolUseLine('toolu_1', 'Skill', { skill: 'superpowers:subagent-driven-development' }))).toBeNull()
    expect(f.parseLine(toolUseLine('toolu_2', 'Bash', { command: RUN }))).toBeNull()
    expect(f.parseLine(bashResultLine('toolu_2', `${WS}\nSKILL.md\nimplementer-prompt.md\nscripts/\n`))?.printed).toBe(WS)
  })
  it('MSYS and Windows paths come back as printed; text blocks are read too', () => {
    const f = new PlanWorkspaceFinder()
    f.parseLine(toolUseLine('a', 'Bash', { command: RUN }))
    expect(f.parseLine(bashResultLine('a', '/d/Work/acme-shop/.superpowers/sdd/x\r\n'))?.printed).toBe('/d/Work/acme-shop/.superpowers/sdd/x')
    f.parseLine(toolUseLine('b', 'Bash', { command: RUN }))
    const blocks = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'C:\\Work\\a\\.superpowers\\sdd\\y' }] }] } })
    expect(f.parseLine(blocks)?.printed).toBe('C:\\Work\\a\\.superpowers\\sdd\\y')
  })
  it('results of other Bash calls are ignored, even when they list workspaces', () => {
    const f = new PlanWorkspaceFinder()
    f.parseLine(toolUseLine('c', 'Bash', { command: 'ls -d /w/acme-shop/.superpowers/sdd/*' }))
    expect(f.parseLine(bashResultLine('c', `${WS}\n/w/acme-shop/.superpowers/sdd/2026-09-01-old\n`))).toBeNull()
    f.parseLine(toolUseLine('c2', 'Bash', { command: 'cat /w/acme-shop/notes.txt' }))
    expect(f.parseLine(bashResultLine('c2', `wrote ${WS}/task-1-brief.md: 12 lines\n`))).toBeNull()
  })
  it('without an sdd-workspace run: the workspace of the brief a task-brief run wrote, and of the package a review-package run wrote', () => {
    const f = new PlanWorkspaceFinder()
    expect(f.parseLine(toolUseLine('b1', 'Bash', { command: BRIEF }))).toBeNull()
    expect(f.parseLine(bashResultLine('b1', `wrote ${WS}/task-3-brief.md: 42 lines\n`, '2026-10-05T10:00:02.000Z'))).toEqual({ printed: WS, at: Date.parse('2026-10-05T10:00:02.000Z') })
    expect(f.parseLine(toolUseLine('r1', 'Bash', { command: PACKAGE }))).toBeNull()
    expect(f.parseLine(bashResultLine('r1', `wrote ${WS}/review-a1b2c3d..e4f5a6b.diff: 2 commit(s), 5120 bytes\n`))?.printed).toBe(WS)
  })
  it('a brief path with spaces, in Windows form or among other output is found whole', () => {
    const f = new PlanWorkspaceFinder()
    const run = (id: string, out: string) => {
      f.parseLine(toolUseLine(id, 'Bash', { command: BRIEF }))
      return f.parseLine(bashResultLine(id, out))?.printed
    }
    expect(run('t1', 'wrote /c/Users/Jane Doe/acme-shop/.superpowers/sdd/2026-10-20-csv-export/task-1-brief.md: 7 lines\r\n')).toBe('/c/Users/Jane Doe/acme-shop/.superpowers/sdd/2026-10-20-csv-export')
    expect(run('t2', 'wrote C:\\Work\\acme-shop\\.superpowers\\sdd\\y\\task-2-brief.md: 7 lines\n')).toBe('C:\\Work\\acme-shop\\.superpowers\\sdd\\y')
    expect(run('t3', `Task 2 brief:\nwrote ${WS}/task-2-brief.md: 7 lines\n---\n### Task 2: Escaping\n`)).toBe(WS)
  })
  it('a brief written outside a workspace, deeper in one or at a relative path gives nothing; so does a failed run', () => {
    const f = new PlanWorkspaceFinder()
    const run = (id: string, out: string) => {
      f.parseLine(toolUseLine(id, 'Bash', { command: BRIEF }))
      return f.parseLine(bashResultLine(id, out))
    }
    expect(run('o1', 'wrote /tmp/task-3-brief.md: 42 lines\n')).toBeNull()
    expect(run('o2', `wrote ${WS}/briefs/task-3-brief.md: 42 lines\n`)).toBeNull()
    expect(run('o3', 'wrote .superpowers/sdd/2026-10-20-csv-export/task-3-brief.md: 42 lines\n')).toBeNull()
    expect(run('o4', 'wrote /w/acme-shop/.superpowers/sdd/task-3-brief.md: 42 lines\n')).toBeNull()
    expect(run('o5', "task 3 not found in docs/superpowers/plans/2026-10-20-csv-export.md (no heading matching 'Task 3')\nExit code 3\n")).toBeNull()
    expect(run('o6', `cat: ${WS}/task-3-brief.md: No such file or directory\n`)).toBeNull()
  })
  it('a ledger written into a workspace with its heading, once the write is done', () => {
    const f = new PlanWorkspaceFinder()
    const file = 'D:\\Work\\acme-shop\\.superpowers\\sdd\\2026-10-20-csv-export\\progress.md'
    expect(f.parseLine(toolUseLine('w1', 'Write', { file_path: file, content: LEDGER }))).toBeNull()
    expect(f.parseLine(editResultLine({ toolUseId: 'w1', filePath: file, created: true, timestamp: '2026-10-05T10:00:04.000Z' }))).toEqual({
      printed: 'D:\\Work\\acme-shop\\.superpowers\\sdd\\2026-10-20-csv-export',
      at: Date.parse('2026-10-05T10:00:04.000Z')
    })
    f.parseLine(toolUseLine('w2', 'Write', { file_path: `${WS}/progress.md`, content: LEDGER.replace('—', '-') }))
    expect(f.parseLine(editResultLine({ toolUseId: 'w2', filePath: `${WS}/progress.md`, created: false }))?.printed).toBe(WS)
  })
  it('other writes give nothing: no ledger heading, another file, outside a workspace, a relative path, a write that failed', () => {
    const f = new PlanWorkspaceFinder()
    const write = (id: string, file: string, content: string, failed = false) => {
      f.parseLine(toolUseLine(id, 'Write', { file_path: file, content }))
      return f.parseLine(
        failed
          ? JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'The user rejected the write', is_error: true }] } })
          : editResultLine({ toolUseId: id, filePath: file, created: true })
      )
    }
    expect(write('x1', `${WS}/progress.md`, '# Progress\n\nTask 1: complete\n')).toBeNull()
    expect(write('x2', `${WS}/task-1-report.md`, LEDGER)).toBeNull()
    expect(write('x3', '/w/acme-shop/.superpowers/sdd/progress.md', LEDGER)).toBeNull()
    expect(write('x4', '/w/acme-shop/docs/progress.md', LEDGER)).toBeNull()
    expect(write('x5', '.superpowers/sdd/2026-10-20-csv-export/progress.md', LEDGER)).toBeNull()
    expect(write('x6', `${WS}/progress.md`, LEDGER, true)).toBeNull()
    f.parseLine(toolUseLine('x7', 'Write', { file_path: 42, content: LEDGER }))
    expect(f.parseLine(editResultLine({ toolUseId: 'x7', filePath: `${WS}/progress.md` }))).toBeNull()
  })
  it('a run that printed no workspace gives nothing and is forgotten; malformed lines give nothing', () => {
    const f = new PlanWorkspaceFinder()
    f.parseLine(toolUseLine('d', 'Bash', { command: RUN }))
    expect(f.parseLine(bashResultLine('d', 'no such plan file: docs/x.md\n'))).toBeNull()
    expect(f.parseLine(bashResultLine('d', `${WS}\n`))).toBeNull()
    expect(f.parseLine('{"type":"user","message":')).toBeNull()
  })
  it('a path printed with a prefix, in quotes or with a trailing slash is found', () => {
    const f = new PlanWorkspaceFinder()
    const run = (id: string, out: string) => {
      f.parseLine(toolUseLine(id, 'Bash', { command: RUN }))
      return f.parseLine(bashResultLine(id, out))?.printed
    }
    expect(run('p1', `WS=${WS}\nSKILL.md\n`)).toBe(WS)
    expect(run('p2', `W=${WS}\n`)).toBe(WS)
    expect(run('p3', `WS="${WS}"\n`)).toBe(WS)
    expect(run('p4', `${WS}/\n`)).toBe(WS)
    expect(run('p5', 'WS=C:\\Work\\a\\.superpowers\\sdd\\y\n')).toBe('C:\\Work\\a\\.superpowers\\sdd\\y')
    expect(run('p6', 'WS=D:/Work/a/.superpowers/sdd/y\n')).toBe('D:/Work/a/.superpowers/sdd/y')
  })
  it('a path with spaces is found whole: bare, after a prefix or in quotes', () => {
    const f = new PlanWorkspaceFinder()
    const run = (id: string, out: string) => {
      f.parseLine(toolUseLine(id, 'Bash', { command: RUN }))
      return f.parseLine(bashResultLine(id, out))?.printed
    }
    const SP = '/c/Users/Jane Doe/acme-shop/.superpowers/sdd/2026-10-20-csv-export'
    expect(run('s1', `${SP}\nSKILL.md\n`)).toBe(SP)
    expect(run('s2', `WS=${SP}\n`)).toBe(SP)
    expect(run('s3', `WS="${SP}/"\n`)).toBe(SP)
    expect(run('s4', 'C:\\Users\\Jane Doe\\acme-shop\\.superpowers\\sdd\\y\n')).toBe('C:\\Users\\Jane Doe\\acme-shop\\.superpowers\\sdd\\y')
  })
  it('a plan or a design kept right in .superpowers/sdd, beside the workspaces, is no workspace', () => {
    const f = new PlanWorkspaceFinder()
    f.parseLine(toolUseLine('k', 'Bash', { command: `wc -l ${WS}/task-1-review-package.diff /w/acme-shop/.superpowers/sdd/2026-10-20-csv-export.md` }))
    expect(f.parseLine(bashResultLine('k', `  80 ${WS}/task-1-review-package.diff\n 530 /w/acme-shop/.superpowers/sdd/2026-10-20-csv-export.md\n 610 total\n`))).toBeNull()
    f.parseLine(toolUseLine('k2', 'Bash', { command: RUN }))
    expect(f.parseLine(bashResultLine('k2', 'D:\\Work\\acme-shop\\.superpowers\\sdd\\2026-10-20-csv-export-design.MD\n'))).toBeNull()
  })
  it('a line that merely mentions a path in the middle gives nothing', () => {
    const f = new PlanWorkspaceFinder()
    f.parseLine(toolUseLine('q', 'Bash', { command: RUN }))
    expect(f.parseLine(bashResultLine('q', `ls: cannot access '${WS}/progress.md': No such file\n`))).toBeNull()
  })
  it('the time of the result entry comes with the path; 0 when it has none', () => {
    const f = new PlanWorkspaceFinder()
    f.parseLine(toolUseLine('r', 'Bash', { command: RUN }))
    expect(f.parseLine(bashResultLine('r', `${WS}\n`, '2026-10-05T10:00:01.000Z'))).toEqual({ printed: WS, at: Date.parse('2026-10-05T10:00:01.000Z') })
    f.parseLine(toolUseLine('s', 'Bash', { command: RUN }))
    const o = JSON.parse(bashResultLine('s', `${WS}\n`))
    delete o.timestamp
    expect(f.parseLine(JSON.stringify(o))).toEqual({ printed: WS, at: 0 })
  })
})
