import { describe, expect, it } from 'vitest'
import { posix, win32 } from 'node:path'
import { asFinished, fromGitBashPath, parseLedger, parsePlan, planFileOf, planStatus } from '../../src/main/plan-files'

const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ n: i + 1, title: `T${i + 1}` }))

describe('parsePlan', () => {
  it('reads the title without " Implementation Plan" and the tasks in order', () => {
    expect(parsePlan('# CSV Export Implementation Plan\n\n> For agentic workers…\n\n### Task 1: Report rows to CSV lines\n- [ ] step\n### Task 2: Escape quotes and separators\n'))
      .toEqual({ title: 'CSV Export', tasks: [{ n: 1, title: 'Report rows to CSV lines' }, { n: 2, title: 'Escape quotes and separators' }] })
  })
  it('takes headings of levels 2 to 4 with a note before the colon, CRLF and any language', () => {
    expect(parsePlan('# Экспорт в CSV — план реализации\r\n## Task 1: Один\r\n#### Task 2 (условная): Два\r\n##### Task 3: no\r\n# Task 4: no\r\n'))
      .toEqual({ title: 'Экспорт в CSV — план реализации', tasks: [{ n: 1, title: 'Один' }, { n: 2, title: 'Два' }] })
  })
  it('skips headings inside ``` and ~~~ code fences', () => {
    const text = '# P\n### Task 1: Real\n```markdown\n### Task 9: Example\n```\n~~~\n### Task 8: Example\n~~~\n### Task 2: Also real\n'
    expect(parsePlan(text)?.tasks.map((t) => t.n)).toEqual([1, 2])
  })
  it('null without tasks; null title without a # heading; an empty title after the colon; the first of two equal numbers', () => {
    expect(parsePlan('# Title\nno tasks here\n')).toBeNull()
    expect(parsePlan('### Task 1:\n### Task 1: Again\n')).toEqual({ title: null, tasks: [{ n: 1, title: '' }] })
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
    expect([...l.complete]).toEqual([1])
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
    expect([...l.complete]).toEqual([1, 2, 3, 4, 5, 6])
    expect(l.final).toBe(false)
    expect(parseLedger('- Final review: clean\n').final).toBe(true)
    expect(parseLedger('- **Final**: suite green\n').final).toBe(true)
    expect(parseLedger('- Final3 rerun\n').final).toBe(false)
  })
})

describe('planStatus', () => {
  it('the first task after the furthest complete one is current; every task before it is done', () => {
    const s = planStatus({ title: 'Status bar', tasks: tasks(10) }, { complete: new Set([2, 3, 4, 5, 6, 7, 8]), final: false }, 'fallback')
    expect(s.tasks.map((t) => t.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'done', 'done', 'current', 'left'])
    expect(s).toMatchObject({ title: 'Status bar', done: 8, total: 10, finished: false })
  })
  it('nothing complete: Task 1 is current; a complete line for a task the plan lacks changes nothing', () => {
    const s = planStatus({ title: null, tasks: tasks(3) }, { complete: new Set([99]), final: false }, '2026-10-20-csv-export')
    expect(s.tasks.map((t) => t.state)).toEqual(['current', 'left', 'left'])
    expect(s).toMatchObject({ title: '2026-10-20-csv-export', done: 0, finished: false })
  })
  it('finished when the last task is complete or the ledger has a Final line: every task done', () => {
    expect(planStatus({ title: 'P', tasks: tasks(3) }, { complete: new Set([3]), final: false }, 'f')).toMatchObject({ done: 3, finished: true })
    const s = planStatus({ title: 'P', tasks: tasks(3) }, { complete: new Set([1]), final: true }, 'f')
    expect(s.tasks.every((t) => t.state === 'done')).toBe(true)
    expect(asFinished(planStatus({ title: 'P', tasks: tasks(3) }, { complete: new Set(), final: false }, 'f'))).toMatchObject({ done: 3, total: 3, finished: true })
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
