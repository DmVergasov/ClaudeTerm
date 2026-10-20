# Plan Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While Claude carries out a superpowers plan in a Claude tab, the status bar shows `3/7 · <current task>` and a click lists every task as done, current or left.

**Architecture:** The tab's `TranscriptFeed` spots the workspace path that an `sdd-workspace` run printed (main or subagent transcript) and hands it to a new `PlanHub` in main. The hub reads `plan-path`, the plan file and `progress.md` asynchronously, re-reads them every second, and sends a `PlanUpdate` to the renderer on a new IPC event. The renderer draws a `plan` segment in the status bar and a task list that opens above it.

**Tech Stack:** Electron 44, TypeScript (strict), plain DOM renderer, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-20-plan-progress-design.md`

## Global Constraints

- No git commits: the user's global rule forbids them unless asked in the conversation. Leave every change uncommitted; there are no commit steps.
- TypeScript is strict with `noUnusedLocals`; the tests are type-checked (`npm run typecheck`). No UI framework in the renderer.
- Comments, logs and every UI-visible string are English. Text taken from the plan (titles) is shown as it is.
- Transcript lines, `plan-path`, the plan file and `progress.md` are untrusted: validate, ignore what does not parse, read at most `PLAN_FILE_MAX_BYTES` (4 MiB) of a file, and degrade to the last good state or no segment — never a wrong one.
- ClaudeTerm only reads the workspace, the plan and the repository. It never writes to them.
- The main process must not block: the plan source uses `node:fs/promises` only.
- Paths are compared with `pathKey`. Expect `/` and `\`, MSYS paths printed by Git Bash on Windows (`/d/Work/…` for `D:\Work\…`), 8.3 short names (`C:\Users\RUNNER~1`), junctions and symlinks.
- Tests use invented plans and paths in temp folders only; nothing reads the real `~/.claude`, `%APPDATA%\ClaudeTerm` or a real repository.
- New files use LF; edited files keep their line endings.
- CI must be green on Windows, Ubuntu and macOS: `npm run typecheck`, `npm test`, `npm run test:e2e`.

## Review Focus

- A plan whose code blocks contain example headings (```` ```markdown ```` with `### Task 9: …` inside): they must not become tasks — Task 1 tests it.
- A real `sdd-workspace` Bash call is chained with other commands (`cd … && bash …/sdd-workspace plan.md; ls …`) and prints more lines after the path — Task 2 tests it.
- Esc pressed to close the list while the terminal has focus must not reach Claude: Esc interrupts Claude's turn, so closing the list would stop the plan run — Task 5 tests it.
- On Windows both the printed workspace and `plan-path` are MSYS paths, under an 8.3 temp folder on CI — Task 3 tests it.
- A file read mid-write (an empty or cut plan, a ledger the OS refuses for a moment) must not make the segment blink or drop to 0 — Task 3 tests it.

---

### Task 1: Plan and ledger parsing

**Files:**
- Create: `src/main/plan-files.ts`
- Modify: `src/shared/types.ts` (add the plan types after `AgentStatus`)
- Test: `tests/unit/plan-files.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - in `src/shared/types.ts`:
    ```ts
    export type PlanTaskState = 'done' | 'current' | 'left'
    export interface PlanTask { n: number; title: string; state: PlanTaskState }
    export interface PlanStatus { title: string; tasks: PlanTask[]; done: number; total: number; finished: boolean }
    ```
  - in `src/main/plan-files.ts`:
    ```ts
    export interface ParsedPlan { title: string | null; tasks: { n: number; title: string }[] }
    export interface ParsedLedger { complete: Set<number>; final: boolean }
    export function parsePlan(text: string): ParsedPlan | null
    export function parseLedger(text: string): ParsedLedger
    export function planStatus(plan: ParsedPlan, ledger: ParsedLedger, fallbackTitle: string): PlanStatus
    export function asFinished(s: PlanStatus): PlanStatus
    export function fromGitBashPath(p: string, path: PlatformPath): string
    export function planFileOf(workspace: string, planPathText: string, path: PlatformPath): string | null
    ```

- [ ] **Step 1: Write the failing tests** in `tests/unit/plan-files.test.ts`

```ts
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
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/unit/plan-files.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/main/plan-files"`.

- [ ] **Step 3: Add the types to `src/shared/types.ts` and implement `src/main/plan-files.ts`**

Rules the tests pin:
- A task heading is `^#{2,4}\s+Task\s+(\d+)\b[^:\r\n]*:\s*(.*)$` outside a fence. A fence opens and closes on a line starting with ```` ``` ```` or `~~~`. The title is the first `# ` heading line, with a trailing ` Implementation Plan` removed.
- A ledger line counts when it matches `^\s*Task\s+(\d+):\s*complete\b`. `final` is set by `^\s*Final\b`.
- `planStatus`: the furthest index is the highest plan-order index whose task number is in `complete`. `finished` is true when the last task is complete or `ledger.final` is set, and then every task is `done`. Otherwise tasks up to the furthest index are `done`, the next one is `current`, and the rest are `left`. The title falls back to `fallbackTitle` when null.
- `fromGitBashPath` with a `\` separator flavour maps `^/([A-Za-z])(/|$)` to `X:\`, then `path.normalize`. `planFileOf`: first non-empty trimmed line → `fromGitBashPath` → absolute as is, else joined to the workspace root (three `dirname`s up from the workspace).

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/plan-files.test.ts`
Expected: PASS, all tests in the file.

---

### Task 2: Spotting the workspace in the transcript

**Files:**
- Create: `src/main/transcript-plan.ts`
- Modify: `src/main/transcript-feed.ts` (`TranscriptFeedOptions` ~line 115, `Source` ~line 138, the constructor ~line 157, `scanSubagents` ~line 187, `consume` ~line 242)
- Modify: `tests/fixtures/transcript.ts` (add `bashResultLine`)
- Test: `tests/unit/transcript-plan.test.ts`, `tests/integration/transcript-feed.int.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  ```ts
  // src/main/transcript-plan.ts
  export class PlanWorkspaceFinder {
    /** the workspace an sdd-workspace run printed, exactly as printed (an MSYS path on Windows), or null */
    parseLine(line: string): string | null
  }
  // src/main/transcript-feed.ts, TranscriptFeedOptions
  /** an sdd-workspace run in any of the session's transcripts printed this workspace path */
  onPlanWorkspace?(printed: string): void
  // tests/fixtures/transcript.ts
  export function bashResultLine(toolUseId: string, stdout: string, timestamp?: string): string
  ```

- [ ] **Step 1: Add the fixture and write the failing tests**

`bashResultLine` writes what Claude Code stores for a Bash result:
`{ type: 'user', timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content: stdout, is_error: false }] }, toolUseResult: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } }`.

`tests/unit/transcript-plan.test.ts`:

```ts
const WS = '/w/acme-shop/.superpowers/sdd/2026-10-20-csv-export'
const RUN = 'cd /w/acme-shop && bash /p/skills/subagent-driven-development/scripts/sdd-workspace docs/superpowers/plans/2026-10-20-csv-export.md; ls /p/skills/subagent-driven-development'

it('the workspace path an sdd-workspace run printed, among the other output of the command', () => {
  const f = new PlanWorkspaceFinder()
  expect(f.parseLine(toolUseLine('toolu_1', 'Skill', { skill: 'superpowers:subagent-driven-development' }))).toBeNull()
  expect(f.parseLine(toolUseLine('toolu_2', 'Bash', { command: RUN }))).toBeNull()
  expect(f.parseLine(bashResultLine('toolu_2', `${WS}\nSKILL.md\nimplementer-prompt.md\nscripts/\n`))).toBe(WS)
})
it('MSYS and Windows paths come back as printed; text blocks are read too', () => {
  const f = new PlanWorkspaceFinder()
  f.parseLine(toolUseLine('a', 'Bash', { command: RUN }))
  expect(f.parseLine(bashResultLine('a', '/d/Work/acme-shop/.superpowers/sdd/x\r\n'))).toBe('/d/Work/acme-shop/.superpowers/sdd/x')
  f.parseLine(toolUseLine('b', 'Bash', { command: RUN }))
  const blocks = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'C:\\Work\\a\\.superpowers\\sdd\\y' }] }] } })
  expect(f.parseLine(blocks)).toBe('C:\\Work\\a\\.superpowers\\sdd\\y')
})
it('results of other Bash calls are ignored, even when they list workspaces', () => {
  const f = new PlanWorkspaceFinder()
  f.parseLine(toolUseLine('c', 'Bash', { command: 'ls -d /w/acme-shop/.superpowers/sdd/*' }))
  expect(f.parseLine(bashResultLine('c', `${WS}\n/w/acme-shop/.superpowers/sdd/2026-09-01-old\n`))).toBeNull()
})
it('a run that printed no workspace gives nothing and is forgotten; malformed lines give nothing', () => {
  const f = new PlanWorkspaceFinder()
  f.parseLine(toolUseLine('d', 'Bash', { command: RUN }))
  expect(f.parseLine(bashResultLine('d', 'no such plan file: docs/x.md\n'))).toBeNull()
  expect(f.parseLine(bashResultLine('d', `${WS}\n`))).toBeNull()
  expect(f.parseLine('{"type":"user","message":')).toBeNull()
})
```

In `tests/integration/transcript-feed.int.test.ts`, a new test `reports the workspace an sdd-workspace run printed, in the main transcript and in a subagent's`. Build the feed with `onPlanWorkspace: (p) => printed.push(p)`. Write the tool use and result pair to the main transcript, and another pair with a different workspace to `<projectDir>/<SID>/subagents/agent-o1.jsonl`. Call `feed.scanSubagents()` and `await feed.poll()`, then assert `printed` equals both paths, main first.

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/unit/transcript-plan.test.ts tests/integration/transcript-feed.int.test.ts`
Expected: FAIL — `transcript-plan` cannot be resolved, and the feed test gets `printed` `[]`.

- [ ] **Step 3: Implement `PlanWorkspaceFinder` and feed it from `TranscriptFeed`**

- Before parsing JSON, skip lines that contain neither `sdd-workspace` (a tool use) nor `"tool_use_id"` while a run is pending.
- A pending run is a `tool_use` block named `Bash` whose `input.command` string contains `sdd-workspace`. Keep the pending ids in a `Set`, and clear it if it ever exceeds 100 entries.
- On a `tool_result` for a pending id, delete the id first. Then take the text from the result's `content` (a string, or the `text` of its text blocks), falling back to `toolUseResult.stdout`. Return the first trimmed line that matches `^(?:[A-Za-z]:)?[\\/].*[\\/]\.superpowers[\\/]sdd[\\/][^\\/]+$`.
- Each `Source` gets its own `plan: PlanWorkspaceFinder`, since tool uses and results pair up within one transcript. `consume` calls `reportPlan(src, line)`, which runs the finder and calls `onPlanWorkspace`, with try/catch through `report` like `reportReview`.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/transcript-plan.test.ts tests/integration/transcript-feed.int.test.ts`
Expected: PASS.

---

### Task 3: PlanHub — the per-tab plan state in main

**Files:**
- Create: `src/main/plan-hub.ts`
- Modify: `src/shared/ipc.ts` (add `PlanUpdate` next to `StatusUpdate`)
- Test: `tests/unit/plan-hub.test.ts`, `tests/integration/plan-progress.int.test.ts`

**Interfaces:**
- Consumes: Task 1 `parsePlan`, `parseLedger`, `planStatus`, `asFinished`, `fromGitBashPath`, `planFileOf`, `PlanStatus`. Task 2 `PlanWorkspaceFinder` (indirectly, through `TranscriptFeed` in the integration test).
- Produces:
  ```ts
  // src/shared/ipc.ts
  export interface PlanUpdate { tabId: string; plan: PlanStatus | null }
  // src/main/plan-hub.ts
  export type PlanRead = string | 'missing' | 'error'
  export const PLAN_FILE_MAX_BYTES = 4 * 1024 * 1024
  /** a file's text; 'missing' for ENOENT/ENOTDIR, 'error' for any other failure or a file over the cap */
  export function readPlanFile(file: string): Promise<PlanRead>
  export interface PlanHubDeps { read(file: string): Promise<PlanRead>; onChange(tabId: string): void; path?: PlatformPath }
  export class PlanHub {
    session(tabId: string, sessionId: string): void
    sessionEnd(tabId: string, sessionId: string): void
    workspace(tabId: string, printed: string): Promise<void>
    refresh(): Promise<void>
    removeTab(tabId: string): void
    get(tabId: string): PlanUpdate
  }
  ```

- [ ] **Step 1: Write the failing unit tests** in `tests/unit/plan-hub.test.ts`

Fixture: a `files: Record<string, string | 'error'>` map behind a fake `read` (absent key → `'missing'`). `PlanHub` gets `path: posix` unless the test says win32, and `onChange` pushes to `changes`.

```ts
const WS = '/w/acme-shop/.superpowers/sdd/2026-10-20-csv-export'
const PLAN = '/w/acme-shop/docs/superpowers/plans/2026-10-20-csv-export.md'
const PLAN_TEXT = '# CSV Export Implementation Plan\n### Task 1: Rows\n### Task 2: Escaping\n### Task 3: Button\n### Task 4: Save dialog\n'
const LEDGER = '# SDD ledger — plan: docs/superpowers/plans/2026-10-20-csv-export.md\nTask 1: complete (commits a..b, review clean)\n'
const run = () => ({ [`${WS}/plan-path`]: 'docs/superpowers/plans/2026-10-20-csv-export.md\n', [PLAN]: PLAN_TEXT, [`${WS}/progress.md`]: LEDGER })
```

Tests, each asserting `h.get('t').plan` (and `changes` where named):
- `a reported workspace shows its plan` → `{ title: 'CSV Export', done: 1, total: 4, finished: false }`, states `['done','current','left','left']`, `changes` `['t']`.
- `a completed task shows on the next refresh; an unchanged refresh sends nothing` → append `Task 2: complete\n` to the ledger and `await h.refresh()` → `done: 2`. Refresh again → `changes.length` stays 2.
- `no ledger yet: Task 1 is current` → `done: 0`, first state `current`.
- `the workspace deleted: finished, every task done, kept on later refreshes` → delete the three keys and refresh → `{ done: 4, finished: true }`, still the same after another refresh.
- `the workspace back after a git clean: follows the files again` → restore the keys and refresh → `{ done: 1, finished: false }`.
- `a failed or half-written read keeps the last state` → each in turn, with a refresh after it: plan `'error'`, plan `''`, plan `'# CSV'` (cut before the tasks), ledger `'error'`, plan-path `'error'` → `done: 1` every time, and no new `changes`.
- `a workspace already gone (a restart after a clean run) shows nothing` → empty `files` → `plan: null`, no `changes`.
- `a printed path that is not absolute is ignored` → `workspace('t', '.superpowers/sdd/x')` → `plan: null`.
- `a second workspace replaces the first; the same one reported again keeps its state` → report `WS2` with its own plan → its title. Report `WS2` again while its plan file reads `'error'` → still `WS2`'s title.
- `a workspace reported while a read runs wins` → the reader holds the first read of `WS` on a deferred promise. Report `WS2`, then release the deferred → the plan is `WS2`'s.
- `a new session clears the plan; the same session id (compaction) keeps it` → `session('t','s1')` keeps it; `session('t','s2')` → `plan: null` and a change sent.
- `a session that ends hides the plan; the same session starting again shows it` → `sessionEnd('t','s1')` → `null`; `session('t','s1')` and refresh → plan back. This covers Claude exiting and the tab restarting into the same session, where `attachTranscript` keeps the old feed and nothing is replayed.
- `a late end of a replaced session changes nothing` → after `session('t','s2')` and a new workspace, `sessionEnd('t','s1')` → the plan stays.
- `removeTab forgets the tab` → `get` → `plan: null`, and `refresh` reads nothing for it (the fake reader records calls).
- `Windows: MSYS workspace and plan-path under an 8.3 folder; another spelling of the same workspace keeps it` → `path: win32`. Report `/c/Users/RUNNER~1/AppData/Local/Temp/acme-shop/.superpowers/sdd/x`, with files keyed `C:\Users\RUNNER~1\AppData\Local\Temp\acme-shop\.superpowers\sdd\x\plan-path` (content `/c/Users/RUNNER~1/AppData/Local/Temp/acme-shop/docs/p.md`) and so on → plan shown. Report `C:\users\runner~1\AppData\Local\Temp\acme-shop\.superpowers\sdd\x` while the plan file reads `'error'` → plan still shown.

- [ ] **Step 2: Write the failing integration tests** in `tests/integration/plan-progress.int.test.ts`

Real files in `mkdtempSync(join(tmpdir(), 'ct-plan-'))`, a real `TranscriptFeed` (`onPlanWorkspace: (p) => void hub.workspace('t', p)`) and `PlanHub({ read: readPlanFile, onChange })`:
- `readPlanFile: text, missing, a missing parent folder, over the cap` → text; `'missing'` for an absent file; `'missing'` for `<file>/x` where `<file>` is a regular file (ENOTDIR); `'error'` for a file of `PLAN_FILE_MAX_BYTES + 1` bytes.
- `a plan run in a worktree outside the tab's folder, found from an orchestrator subagent's transcript; old workspaces stay out`. The repo `wt/` holds the plan file, its workspace `wt/.superpowers/sdd/2026-10-20-csv-export/` (`plan-path`, `progress.md`), and an old workspace `wt/.superpowers/sdd/2026-09-01-old/` with its own complete ledger. The main transcript has only a `Skill` call without `args`. The subagent transcript `agent-o1.jsonl` has the `sdd-workspace` run printing the new workspace. After `feed.scanSubagents()` and `await feed.poll()`, wait until `hub.get('t').plan` has `title: 'CSV Export'` and `done: 1`. Append `Task 2: complete\n` to `progress.md`, `await hub.refresh()` → `done: 2`.
- `a resumed session finds its plan again from the start of its transcript` → write the whole transcript first, then create a fresh feed and hub and `await feed.poll()` → the plan is shown.

- [ ] **Step 3: Run the tests and see them fail**

Run: `npx vitest run tests/unit/plan-hub.test.ts tests/integration/plan-progress.int.test.ts`
Expected: FAIL — `plan-hub` cannot be resolved.

- [ ] **Step 4: Implement `PlanHub` and `readPlanFile`, and add `PlanUpdate` to `src/shared/ipc.ts`**

- Per tab, keep `{ sessionId, ended, dir, status, sent }`. `get` returns `plan: ended ? null : status`. `onChange` fires only when `JSON.stringify(get(tabId))` differs from the last one sent.
- `workspace` converts with `fromGitBashPath` and ignores a path that is not absolute. The same `pathKey` keeps the state and reads again. A new one drops the state and reads it.
- Reads of one tab never overlap. A read requested while one runs runs once more after it, and results for a workspace that has since been replaced are dropped. The promise `workspace` returns resolves once the read it asked for has finished.
- A read goes: `plan-path` `'missing'` → the workspace is gone, so a held state becomes `asFinished` and no state stays none. `'error'` or no plan file → keep. Then the plan file and `progress.md` together: a plan that is not a string or has no tasks → keep; ledger `'error'` → keep; ledger `'missing'` → `''`. Then `planStatus(plan, ledger, <plan file basename without .md>)`.
- `session` with another id drops everything. With the same id it clears `ended` and reads again. `sessionEnd` with the current id sets `ended`.
- `refresh` reads every tab that has a workspace and has not ended.
- `readPlanFile` does `stat` then `readFile(…, 'utf8')` from `node:fs/promises`. Over the cap → `'error'`; ENOENT or ENOTDIR → `'missing'`.

- [ ] **Step 5: Run the tests and see them pass**

Run: `npx vitest run tests/unit/plan-hub.test.ts tests/integration/plan-progress.int.test.ts`
Expected: PASS.

---

### Task 4: The plan segment in the status bar

**Files:**
- Modify: `src/shared/ipc.ts` (`IPC.evPlan: 'ev:plan'` after `evStatus`; `CtApi.onPlan` after `onStatus`)
- Modify: `src/preload/index.ts` (`onPlan` after `onStatus`, line 77)
- Modify: `src/main/index.ts` (the hub next to `statusHub` ~line 191; `onTabClosed` ~line 327; `attachTranscript` ~line 289; pipe `session` ~line 508 and `sessionEnd` ~line 530)
- Modify: `src/renderer/status-bar.ts`, `src/renderer/main.ts`, `src/renderer/styles.css`
- Test: `tests/unit/status-bar.test.ts`, `tests/e2e/plan.spec.ts` (new)

**Interfaces:**
- Consumes: Task 3 `PlanHub`, `readPlanFile`, `PlanUpdate`; Task 2 `onPlanWorkspace`; Task 1 `PlanStatus`.
- Produces:
  ```ts
  // src/shared/ipc.ts
  onPlan(cb: (update: PlanUpdate) => void): Unsubscribe
  // src/renderer/status-bar.ts
  export interface Segment { key: 'account' | 'model' | 'context' | 'limit' | 'week' | 'agents' | 'plan' | 'changes'; text: string; title: string; level: Level; fill?: number }
  export function planSegment(p: PlanStatus): Segment
  constructor(el: HTMLElement, onChangesClick?: () => void, onAccountClick?: (anchor: HTMLElement) => void, onPlanClick?: (anchor: HTMLElement) => void)
  render(u: StatusUpdate | null, changes?: ReviewCounter | null, account?: string | null, plan?: PlanStatus | null, now?: number): void
  ```
  - DOM: the segment is `#statusbar .status-plan`, placed right before `.status-changes`.
  - `tests/e2e/plan.spec.ts` exports nothing, but Task 5 adds tests to the same file and reuses its local helpers `planRun()` and `startPlan()`. `planRun(): { root, ws, ledger, planFile }` writes the invented run below. `startPlan(pipeName, tabId, ws)` writes a transcript with the `sdd-workspace` pair and sends the `session` message. `SID` is a constant session id, as in `status.spec.ts`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/status-bar.test.ts`:

```ts
const plan = (done: number, finished = false, current = 'Save dialog and file writing'): PlanStatus => ({
  title: 'CSV Export', done, total: 7, finished,
  tasks: Array.from({ length: 7 }, (_, i) => ({ n: i + 1, title: i === done ? current : `T${i + 1}`, state: finished || i < done ? 'done' : i === done ? 'current' : 'left' }))
})
it('planSegment: done/total and the current task; ✓ when finished; Task N for an untitled task', () => {
  expect(planSegment(plan(3))).toEqual({ key: 'plan', text: '3/7 · Save dialog and file writing', title: 'CSV Export — 3 of 7 done. Click for the task list', level: 'normal', fill: 3 / 7 })
  expect(planSegment(plan(7, true))).toMatchObject({ text: '✓ 7/7', fill: 1 })
  expect(planSegment(plan(3, false, '')).text).toBe('3/7 · Task 4')
})
```

`tests/e2e/plan.spec.ts`. `planRun()` writes, in `mkdtempSync(join(tmpdir(), 'ct-plan-'))`:
- `repo/docs/superpowers/plans/2026-10-20-csv-export.md` with `# CSV Export Implementation Plan` and four tasks: `Report rows to CSV lines`, `Escape quotes and separators`, `Export button in the toolbar`, `Save dialog and file writing`;
- `repo/.superpowers/sdd/2026-10-20-csv-export/plan-path` = `docs/superpowers/plans/2026-10-20-csv-export.md`;
- `progress.md` = header + `Task 1: complete (commits a1b2c3d..d4e5f6a, review clean)`.

`startPlan()` writes `<tmp>/projects/D--e2e/<SID>.jsonl` with `toolUseLine('toolu_1','Bash',{ command: 'bash /p/sdd-workspace docs/superpowers/plans/2026-10-20-csv-export.md' })` and `bashResultLine('toolu_1', ws + '\n')`. Then it sends `{ v: 1, type: 'session', tabId, sessionId: SID, source: 'startup', transcriptPath }`.

```ts
test('a plan run shows its progress, follows the ledger and ends with ✓ when its workspace is deleted', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  const run = planRun()
  await startPlan(pipeName, tabId, run.ws)
  const seg = page.locator('#statusbar .status-plan')
  await expect(seg).toHaveText('1/4 · Escape quotes and separators')
  await expect(seg).toHaveAttribute('title', 'CSV Export — 1 of 4 done. Click for the task list')
  appendFileSync(run.ledger, 'Task 2: complete (commits d4e5f6a..b7c8d9e, review clean)\n')
  await expect(seg).toHaveText('2/4 · Export button in the toolbar')
  rmSync(run.ws, { recursive: true, force: true })
  await expect(seg).toHaveText('✓ 4/4')
  await app.close()
})

test('the plan segment goes when the session ends', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  await startPlan(pipeName, tabId, planRun().ws)
  await expect(page.locator('#statusbar .status-plan')).toHaveCount(1)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session_end', tabId, sessionId: SID })).toEqual({ ok: true })
  await expect(page.locator('#statusbar .status-plan')).toHaveCount(0)
  await app.close()
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/unit/status-bar.test.ts` → FAIL (`planSegment` is not exported).
Run: `npm run test:e2e -- plan.spec.ts` → FAIL (`.status-plan` never appears).

- [ ] **Step 3: Implement**

- `planSegment`: text `✓ ${total}/${total}` when finished, otherwise `${done}/${total} · ${current.title || `Task ${current.n}`}`. Title `${title} — ${done} of ${total} done. Click for the task list`. `fill = done / total`.
- `fill()` in `status-bar.ts` sets `--plan-fill` (a percentage) on the span when `s.fill` is defined.
- `render` puts `planSegment(plan)` between Claude's segments and the Changes counter, so it shows without a `statusLine` too. The click handler calls `onPlanClick(span)` for `.status-plan`.
- `styles.css` next to the other `#statusbar` rules:
  - `.status-plan` gets `cursor: pointer`, the hover colour, and `max-width: 40ch; overflow: hidden; text-overflow: ellipsis` so a long title cannot push the other segments away;
  - `.status-plan::before` is a 48×5px rounded bar, `linear-gradient(to right, var(--accent) var(--plan-fill), var(--border) var(--plan-fill))`, `inline-block`, `margin-right: 6px`, vertically centred.
- `src/main/index.ts`:
  - `const planHub = new PlanHub({ read: readPlanFile, onChange: (tabId) => send(IPC.evPlan, planHub.get(tabId)) })`;
  - `setInterval(() => void planHub.refresh(), 1000)`;
  - `onPlanWorkspace: (printed) => void planHub.workspace(tabId, printed)` in `attachTranscript`;
  - `planHub.session(msg.tabId, msg.sessionId)` in the pipe `session` handler, before `attachTranscript`;
  - `planHub.sessionEnd(msg.tabId, msg.sessionId)` in `sessionEnd`;
  - `planHub.removeTab(tabId)` in `onTabClosed`.
- `src/renderer/main.ts`:
  - a `planUpdates = new Map<string, PlanStatus>()`, filled by `ct.onPlan`, which re-renders the status when the update is for the active tab;
  - `renderStatus` passes `planUpdates.get(tabId) ?? null`;
  - `onTabClosed` deletes the entry. The `onPlanClick` argument stays the default no-op until Task 5.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/status-bar.test.ts` → PASS.
Run: `npm run test:e2e -- plan.spec.ts status.spec.ts` → PASS. The existing status tests still pass, including `a shell tab has no status bar`.

---

### Task 5: The task list and the README

**Files:**
- Create: `src/renderer/plan-list.ts`
- Modify: `src/renderer/index.html` (`<div id="plan-list" hidden></div>` after `#search`), `src/renderer/main.ts`, `src/renderer/styles.css`
- Modify: `README.md` (the "📊 A status bar" section, after its first paragraph)
- Test: `tests/unit/plan-list.test.ts`, `tests/e2e/plan.spec.ts`

**Interfaces:**
- Consumes: Task 4 `StatusBar`'s `onPlanClick(anchor)`, `planUpdates`, the e2e helpers `planRun()` and `startPlan()`. Task 1 `PlanStatus`.
- Produces:
  ```ts
  // src/renderer/plan-list.ts
  export const PLAN_MARKS: Record<PlanTaskState, string>   // { done: '✓', current: '●', left: '○' }
  export function planCountText(p: PlanStatus): string      // '3 of 7 done'
  export class PlanList {
    constructor(el: HTMLElement, onClosed: () => void)
    get isOpen(): boolean
    toggle(anchor: HTMLElement, plan: PlanStatus): void
    update(plan: PlanStatus | null): void
    close(): void
  }
  ```
  DOM inside `#plan-list`:
  - `.plan-head`, holding `.plan-title` and `.plan-count`;
  - one `.plan-task.done|.current|.left` per task, each holding `.plan-mark` and `.plan-task-title`. The title of an untitled task is `Task N`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/plan-list.test.ts`: `planCountText({ …, done: 3, total: 7 })` → `'3 of 7 done'`, and `PLAN_MARKS` equals `{ done: '✓', current: '●', left: '○' }`.

`tests/e2e/plan.spec.ts`:

```ts
test('a click on the segment lists the tasks, and the open list follows the ledger', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  const run = planRun()
  await startPlan(pipeName, tabId, run.ws)
  await page.locator('#statusbar .status-plan').click()
  const list = page.locator('#plan-list')
  await expect(list).toBeVisible()
  await expect(list.locator('.plan-title')).toHaveText('CSV Export')
  await expect(list.locator('.plan-count')).toHaveText('1 of 4 done')
  await expect(list.locator('.plan-task-title')).toHaveText(['Report rows to CSV lines', 'Escape quotes and separators', 'Export button in the toolbar', 'Save dialog and file writing'])
  await expect(list.locator('.plan-mark')).toHaveText(['✓', '●', '○', '○'])
  await expect(list.locator('.plan-task').nth(1)).toHaveClass(/current/)
  appendFileSync(run.ledger, 'Task 2: complete\n')
  await expect(list.locator('.plan-count')).toHaveText('2 of 4 done')
  await expect(list.locator('.plan-mark')).toHaveText(['✓', '✓', '●', '○'])
  await app.close()
})

test('Esc closes the list without reaching Claude and gives the terminal the focus; a second click, a click outside and a tab switch close it too', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  await startPlan(pipeName, tabId, planRun().ws)
  const seg = page.locator('#statusbar .status-plan')
  const list = page.locator('#plan-list')
  await seg.click()
  await page.locator('.terminal-host:visible .xterm-helper-textarea').focus()
  await page.keyboard.press('Escape')
  await expect(list).toBeHidden()
  expect(await page.evaluate((id) => window.__ct!.ptyInput(id), tabId)).not.toContain('\x1b')
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.xterm')))).toBe(true)
  await seg.click()
  await expect(list).toBeVisible()
  await seg.click()
  await expect(list).toBeHidden()
  await seg.click()
  await page.locator('.terminal-host:visible').click()
  await expect(list).toBeHidden()
  await seg.click()
  await page.keyboard.press(KEYS.newTab)
  await expect(list).toBeHidden()
  await app.close()
})
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run tests/unit/plan-list.test.ts` → FAIL (no module).
Run: `npm run test:e2e -- plan.spec.ts` → the two new tests FAIL (`#plan-list` stays hidden).

- [ ] **Step 3: Implement**

- `PlanList` renders into its element with `position: fixed`:
  - its bottom edge 4px above the status bar's top;
  - its left edge at the anchor's left, kept inside the window like `showMenu` does;
  - `width: 340px; max-height: 60vh; overflow: auto`.
- Style it like `.menu`: `var(--chrome)` background, `var(--border)`, a shadow. Done tasks are muted and the current one is highlighted with `var(--chrome-2)`, as in mockup A.
- While the list is open, two capture-phase listeners on `document`:
  - `keydown`: Escape → `preventDefault`, `stopPropagation`, `close()`. Capture plus `stopPropagation` keeps the key from reaching xterm, so Claude's turn is not interrupted;
  - `mousedown` outside both the list and `.status-plan` → `close()`. A mousedown on the segment is left to its click, which toggles.

  Both are removed on close. `close()` calls `onClosed`.
- `update(null)` closes the list. An open list re-renders on every `update`.
- `src/renderer/main.ts`:
  - `planList = new PlanList(document.getElementById('plan-list')!, () => { if (activeId) tabs.get(activeId)?.view.term.focus() })`;
  - `onPlanClick: (anchor) => { const p = activeId ? planUpdates.get(activeId) : undefined; if (p) planList.toggle(anchor, p) }`;
  - `ct.onPlan` for the active tab also calls `planList.update(u.plan)`;
  - `activate()` and the active tab's `onTabClosed` call `planList.close()`.
- README, after the status bar paragraph: "While Claude carries out a superpowers plan (`subagent-driven-development` or `executing-plans`), the status bar shows how far it has got — `3/7 · Save dialog and file writing` — and a click on it lists every task as done, current or still to come. It follows the plan's progress ledger and ends with ✓ when the plan is finished." No screenshot changes: `status-bar.png` is clipped before the new segment.

- [ ] **Step 4: Run the tests and see them pass**

Run: `npx vitest run tests/unit/plan-list.test.ts` → PASS.
Run: `npm run test:e2e -- plan.spec.ts` → PASS, all four tests.

- [ ] **Step 5: Full check**

Run: `npm run typecheck` → no errors.
Run: `npm test` → all unit and integration tests pass.
Run: `npm run test:e2e` → the whole suite passes.
