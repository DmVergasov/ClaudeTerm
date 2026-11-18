import { describe, expect, it } from 'vitest'
import { posix, win32 } from 'node:path'
import { asFinished, fromGitBashPath, parseLedger, parsePlan, planFileOf, planStatus } from '../../src/main/plan-files'

const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), title: `T${i + 1}` }))
/** the ids of the tasks a ledger records complete, in the order it first names them */
const complete = (l: ReturnType<typeof parseLedger>) => [...l.tasks.values()].filter((t) => t.closed === 'complete').map((t) => t.id)

describe('parsePlan', () => {
  it('reads the title without " Implementation Plan" and the tasks in order', () => {
    expect(parsePlan('# CSV Export Implementation Plan\n\n> For agentic workers…\n\n### Task 1: Report rows to CSV lines\n- [ ] step\n### Task 2: Escape quotes and separators\n'))
      .toEqual({ title: 'CSV Export', tasks: [{ id: '1', title: 'Report rows to CSV lines' }, { id: '2', title: 'Escape quotes and separators' }] })
  })
  it('takes headings of levels 2 to 4 with a note before the colon, CRLF and any language', () => {
    expect(parsePlan('# Экспорт в CSV — план реализации\r\n## Task 1: Один\r\n#### Task 2 (условная): Два\r\n##### Task 3: no\r\n# Task 4: no\r\n'))
      .toEqual({ title: 'Экспорт в CSV — план реализации', tasks: [{ id: '1', title: 'Один' }, { id: '2', title: 'Два' }] })
  })
  it('skips headings inside ``` and ~~~ code fences', () => {
    const text = '# P\n### Task 1: Real\n```markdown\n### Task 9: Example\n```\n~~~\n### Task 8: Example\n~~~\n### Task 2: Also real\n'
    expect(parsePlan(text)?.tasks.map((t) => t.id)).toEqual(['1', '2'])
  })
  it('null without tasks; null title without a # heading; an empty title after the colon; the first of two equal numbers', () => {
    expect(parsePlan('# Title\nno tasks here\n')).toBeNull()
    expect(parsePlan('### Task 1:\n### Task 1: Again\n')).toEqual({ title: null, tasks: [{ id: '1', title: '' }] })
  })
})

describe('parseLedger', () => {
  it('counts only "Task <N>: complete" lines', () => {
    const l = parseLedger([
      '# SDD ledger — plan: docs/superpowers/plans/2026-10-20-csv-export.md',
      '- T1→T2: rows ← writer — consistent, complete',
      'Task 1: complete (commits a1b2c3d..d4e5f6a, review clean)',
      'Task 2: fix round 1/5 (1 addressed, 0 open; commits d4e5f6a..b7c8d9e)',
      'Task 2: parked — slow on 1M rows — Ruling: out of scope',
      'Task 3: Ruling: complete rewrite declined',
      'Task 4: minor (deferred): rename helper'
    ].join('\r\n'))
    expect(complete(l)).toEqual(['1'])
    expect(l.final).toBe(false)
  })
  it('a line starting with Final records the final review', () => {
    expect(parseLedger('Task 1: complete\nFinal review: clean\n').final).toBe(true)
    expect(parseLedger('Pre-flight: Final check later\n').final).toBe(false)
  })
  it('reads the lines as ledgers write them: list items, bold, headings, upper case', () => {
    const l = parseLedger([
      '- Task 1: complete (commits c4d35dc0f..98a1ac8f5, review clean)',
      '- **Task 2: complete** (commits 98a1ac8f5..ca320d797)',
      '**Task 3: complete**',
      '## Task 4: complete',
      '- Task 5: **complete**',
      'Task 6: COMPLETE',
      '- Task 7: review Approved (Opus), spec ✅.',
      '- Task 8: Ruling: complete rewrite declined'
    ].join('\n'))
    expect(complete(l)).toEqual(['1', '2', '3', '4', '5', '6'])
    expect(l.final).toBe(false)
    expect(parseLedger('- Final review: clean\n').final).toBe(true)
    expect(parseLedger('- **Final**: suite green\n').final).toBe(true)
    expect(parseLedger('- Final3 rerun\n').final).toBe(false)
  })
  it('a "Task <N>: complete" sentence that ends a line counts; the words inside a sentence do not', () => {
    const l = parseLedger([
      'Task 1: fix round 1 verified by controller (no blank lines in RunTest, CRLF). Task 1: complete',
      'Task 2: fix round 1 DONE (build rc=0), controller checked; Task 2: complete (review clean)',
      'Task 3: BASE = working tree after Task 2. **Task 3: complete**',
      'Task 4: blocked until Task 3: complete is verified',
      'Note: the ledger line Task 5: complete comes later'
    ].join('\r\n'))
    expect(complete(l)).toEqual(['1', '2', '3'])
    expect(l.final).toBe(false)
  })
})

describe('planStatus', () => {
  it('a task the ledger has no complete line for stays open, even when the run went past it; the next open one after the last closed one is current', () => {
    const s = planStatus({ title: 'Status bar', tasks: tasks(10) }, parseLedger([2, 3, 4, 5, 6, 7, 8].map((n) => `Task ${n}: complete`).join('\n')), 'fallback')
    expect(s.tasks.map((t) => t.state)).toEqual(['left', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'current', 'left'])
    expect(s).toMatchObject({ title: 'Status bar', done: 7, total: 10, finished: false })
  })
  it('nothing complete: Task 1 is current; a complete line for a task the plan lacks changes nothing', () => {
    const s = planStatus({ title: null, tasks: tasks(3) }, parseLedger('Task 99: complete\n'), '2026-10-20-csv-export')
    expect(s.tasks.map((t) => t.state)).toEqual(['current', 'left', 'left'])
    expect(s).toMatchObject({ title: '2026-10-20-csv-export', done: 0, finished: false })
  })
  it('finished when every task is complete or the ledger has a Final line: every task done', () => {
    expect(planStatus({ title: 'P', tasks: tasks(3) }, parseLedger('Task 3: complete\n'), 'f')).toMatchObject({ done: 1, finished: false })
    expect(planStatus({ title: 'P', tasks: tasks(3) }, parseLedger('Task 3: complete\nTask 1: complete\nTask 2: complete\n'), 'f')).toMatchObject({ done: 3, finished: true })
    const s = planStatus({ title: 'P', tasks: tasks(3) }, parseLedger('Task 1: complete\nFinal review: clean\n'), 'f')
    expect(s.tasks.every((t) => t.state === 'done')).toBe(true)
    expect(asFinished(planStatus({ title: 'P', tasks: tasks(3) }, parseLedger(''), 'f'))).toMatchObject({ done: 3, total: 3, finished: true })
  })
  it('the tasks are numbered in the order shown, and a task without a title is named by its id', () => {
    const s = planStatus({ title: 'P', tasks: [{ id: '0', title: '' }, { id: '9a', title: 'Main side' }] }, parseLedger(''), 'f')
    expect(s.tasks).toEqual([{ n: 1, title: 'Task 0', state: 'current' }, { n: 2, title: 'Main side', state: 'left' }])
  })
})

/** a plan of `titles`, numbered from 1, as superpowers writes one */
const planText = (titles: string[]): string => ['# Import Implementation Plan', '', ...titles.flatMap((t, i) => [`### Task ${i + 1}: ${t}`, '- [ ] step', ''])].join('\n')
const EIGHT = ['Rules', 'Types', 'Tools', 'Store', 'Gate', 'Cookies', 'Mapping', 'Docs']
/** where a plan stands, from its text and its ledger's, as the hub reads them */
const progress = (plan: string, ledger: string) => planStatus(parsePlan(plan)!, parseLedger(ledger), 'fallback')
const rows = (s: ReturnType<typeof progress>) => s.tasks.map((t) => `${t.title} ${t.state}`)

describe('a plan run out of order', () => {
  it('counts each task by its own ledger line: a task the run went past without one is not done', () => {
    const s = progress(planText(EIGHT), [
      '# SDD ledger — plan: docs/superpowers/plans/2026-11-17-import.md',
      'Task 1: complete (commits a1b2c3d..b2c3d4e, review clean)',
      'Task 2: complete (commits b2c3d4e..c3d4e5f, review clean)',
      'Task 6: dispatched (haiku, background)',
      'Task 6: complete (commits c3d4e5f..d4e5f6a, review clean)',
      'Task 7: complete (commits d4e5f6a..e5f6a7b, review clean)'
    ].join('\n'))
    expect(s).toMatchObject({ done: 4, total: 8, finished: false })
    expect(rows(s)).toEqual(['Rules done', 'Types done', 'Tools left', 'Store left', 'Gate left', 'Cookies done', 'Mapping done', 'Docs current'])
  })
  it('the open task the ledger names after the last closed one is current; else the first open one after it, from the top when none follows', () => {
    const ledger = 'Task 1: complete\nTask 5: complete\nTask 3: dispatched (haiku)\n'
    expect(rows(progress(planText(EIGHT), ledger))).toEqual(['Rules done', 'Types left', 'Tools current', 'Store left', 'Gate done', 'Cookies left', 'Mapping left', 'Docs left'])
    expect(rows(progress(planText(EIGHT), ledger + 'Task 3: fix round 1/5\nTask 7: complete\n')).filter((r) => r.endsWith('current'))).toEqual(['Docs current'])
    const s = progress(planText(['Rules', 'Types', 'Docs']), 'Task 3: complete\n')
    expect(rows(s)).toEqual(['Rules current', 'Types left', 'Docs done'])
    expect(s).toMatchObject({ done: 1, total: 3, finished: false })
  })
  it('finished only when every task is closed, or the final review is recorded', () => {
    expect(progress(planText(['Rules', 'Types']), 'Task 2: complete\nTask 1: complete\n')).toMatchObject({ done: 2, total: 2, finished: true })
    const s = progress(planText(['Rules', 'Types']), 'Task 2: complete\nFinal review: clean\n')
    expect(s).toMatchObject({ done: 2, total: 2, finished: true })
    expect(s.tasks.every((t) => t.state === 'done')).toBe(true)
  })
  it('sub-tasks in the plan: 9a and 9b are tasks of their own, a deeper 3a heading under Task 3 is a part of it', () => {
    const plan = '# P\n### Task 3: Hub\n#### Task 3a: the pipe side\n#### Task 3b: the window side\n### Task 9a: Main side\n### Task 9b: Panel\n### Task 10: Docs\n'
    const s = progress(plan, 'Task 9b: complete\nTask 9A: dispatched\n')
    expect(rows(s)).toEqual(['Hub left', 'Main side current', 'Panel done', 'Docs left'])
    expect(s).toMatchObject({ done: 1, total: 4 })
    expect(rows(progress(plan, 'Task 3: complete\nTask 3a: complete\n'))).toEqual(['Hub done', 'Main side current', 'Panel left', 'Docs left'])
  })
  it('a task split along the way is shown as the parts the ledger names, each counted by its own line', () => {
    const ledger = [
      'Ruling 12: Task 2 split into 2a (main) and 2b (panel)',
      'Task 2a: complete (trees 516deb8..4ebd43d on its paths, review clean after 3 fix rounds)',
      'Task 2b: dispatched (haiku, background)',
      'Task 1: complete',
      'Task 2c: dispatched (haiku) — a small task added after 2b'
    ].join('\n')
    const s = progress(planText(['Rules', 'Tab browsers', 'Docs']), ledger)
    expect(rows(s)).toEqual(['Rules done', '2a · Tab browsers done', '2b · Tab browsers left', '2c · Tab browsers current', 'Docs left'])
    expect(s).toMatchObject({ done: 2, total: 5, finished: false })
    // a task the ledger records complete as a whole stays one task; Task 12 is not a part of Task 1
    expect(rows(progress(planText(['Rules', 'Tab browsers', 'Docs']), ledger + '\nTask 2: complete\nTask 12: complete\n')))
      .toEqual(['Rules done', 'Tab browsers done', 'Docs current'])
  })
  it('a task the ledger drops (skipped, declined, cancelled…) is closed and shown as dropped; the word inside a sentence does not drop it', () => {
    const s = progress(planText(['Rules', 'Types', 'Tools', 'Store', 'Gate']), [
      'Task 1: complete',
      'Task 2: skipped, see the ruling above.',
      '- **Task 3: declined** (the person: not needed)',
      'Task 4: skipped 2 flaky tests on Windows',
      'Ruling: Task 5 dropped — no hits in the trace'
    ].join('\n'))
    expect(rows(s)).toEqual(['Rules done', 'Types (dropped) done', 'Tools (dropped) done', 'Store current', 'Gate left'])
    expect(s).toMatchObject({ done: 3, total: 5, finished: false })
  })
  it('a ledger naming a flood of parts shows the task whole rather than thousands of rows', () => {
    const flood = Array.from({ length: 2000 }, (_, i) => `Task 2.${i + 1}: complete`).join('\n')
    const s = progress(planText(['Rules', 'Types', 'Docs']), flood)
    expect(rows(s)).toEqual(['Rules current', 'Types left', 'Docs left'])
  })
})

describe('paths', () => {
  it('fromGitBashPath turns MSYS drive paths into Windows ones, and leaves others to the flavour', () => {
    expect(fromGitBashPath('/d/Work/acme-shop/x', win32)).toBe('D:\\Work\\acme-shop\\x')
    expect(fromGitBashPath('/c/Users/RUNNER~1/AppData', win32)).toBe('C:\\Users\\RUNNER~1\\AppData')
    expect(fromGitBashPath('C:/Work/a', win32)).toBe('C:\\Work\\a')
    expect(fromGitBashPath('/d/Work/x', posix)).toBe('/d/Work/x')
  })
  it('planFileOf resolves plan-path against the workspace root, absolute and MSYS paths as they are', () => {
    const ws = '/w/acme-shop/.superpowers/sdd/2026-10-20-csv-export'
    expect(planFileOf(ws, 'docs/superpowers/plans/2026-10-20-csv-export.md\n', posix)).toBe('/w/acme-shop/docs/superpowers/plans/2026-10-20-csv-export.md')
    expect(planFileOf(ws, '/plans/x.md', posix)).toBe('/plans/x.md')
    expect(planFileOf(ws, '  \n', posix)).toBeNull()
    expect(planFileOf('D:\\Work\\acme-shop\\.superpowers\\sdd\\x', '/d/Work/elsewhere/plan.md\r\n', win32)).toBe('D:\\Work\\elsewhere\\plan.md')
    expect(planFileOf('D:\\Work\\acme-shop\\.superpowers\\sdd\\x', 'docs/p.md\r\n', win32)).toBe('D:\\Work\\acme-shop\\docs\\p.md')
  })
})
