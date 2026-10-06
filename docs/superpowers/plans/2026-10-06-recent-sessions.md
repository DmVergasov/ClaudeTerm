# Recent Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Recent sessions" window (Ctrl+Shift+H, ▾ menu) that lists the latest interactive Claude Code sessions from all projects and continues the chosen one in a tab.

**Architecture:** The main process reads Claude Code's own transcripts in `<config>/projects/*/*.jsonl` — only the first 64 KB and the last 256 KB (2 MB if needed) of each — and caches the result per file by size and mtime (`SessionHistory`). Two IPC calls connect it to the renderer: `sessions:list` returns the summaries with an `open` flag, `sessions:open(id)` activates the tab already in that conversation or opens a Claude tab with `--resume <id>` in the session's folder. The renderer shows a modal list with search and keyboard control.

**Tech Stack:** Electron 44 (main/preload/renderer), TypeScript, Vitest (unit), Playwright Electron (e2e).

**Spec:** `docs/superpowers/specs/2026-10-06-recent-sessions-design.md`

## Global Constraints

- UI strings are English: window heading `Recent sessions`, menu item `Recent sessions…`, `● open`, `(untitled)`, `No Claude Code sessions yet`, `Nothing matches`, toast `The folder of this session no longer exists: <path>`.
- Shortcut: `Ctrl+Shift+H` (physical key `KeyH`, works with any layout).
- List size: 100 sessions, newest first by file modification time.
- Read windows: first 64 KB, last 256 KB, second tail read of 2 MB only when the 256 KB tail has no `custom-title`/`ai-title`/`last-prompt` and the file is larger than 256 KB.
- Title priority: `customTitle` (/rename) → `aiTitle` → first message → `(untitled)`. Text is one line (whitespace runs → one space), at most 200 characters.
- Sessions: `<uuid>.jsonl` directly in a project folder; first entry with a `cwd` is not a sidechain and has `entrypoint` absent or `cli`; a non-sidechain `user` entry in the head or a `last-prompt` in the tail.
- `<config>` is `CLAUDE_CONFIG_DIR` when set, else `~/.claude`.
- Age format: `just now`, `N min ago`, `N h ago`, `yesterday`, `N days ago` (< 7 calendar days), `5 Oct`, `5 Oct 2025` (another year).
- No git commits beyond the plan's commit steps; the user delegated those commits for this feature.

## Review Focus

1. A transcript that Claude Code is writing while the list is read (the last line is half-written) — the session is still listed with its latest complete title; nothing throws. → Task 1 test "a half-written last line is ignored".
2. A first message that is a pasted image or a huge paste, so the first `user` line is longer than the 64 KB head — the session is listed (cwd from a leading entry, title from the tail), with no first message. → Task 1 test "a first message longer than the head window".
3. Two ClaudeTerm tabs in the same folder, one of them in the chosen conversation — Enter goes to the tab with that conversation, not to the other one. → Task 2 e2e asserts the activated tab id.
4. A session folder that was deleted or renamed — a toast, no tab, the window closed. → Task 2 e2e "a session whose folder is gone".
5. Opening the window while a previous load is still running, or closing it before the list arrives — no stale list replaces a newer one, and a closed window does not reappear. → Task 3: `RecentSessionsWindow.open` drops results of an outdated load (`loadId`), covered by the e2e reopening the window and by code review.

---

## File Structure

- Create `src/main/session-history.ts` — transcript window parsers, the injected file system, `SessionHistory` with its cache, `claudeProjectsDir`.
- Modify `src/shared/types.ts` — `SessionSummary`, `RecentSession`.
- Modify `src/shared/ipc.ts`, `src/preload/index.ts` — `sessions:list`, `sessions:open`, `CtApi.listSessions`, `CtApi.openSession`.
- Modify `src/main/index.ts` — create `SessionHistory`, the two IPC handlers.
- Create `src/renderer/recent-sessions.ts` — `formatAge`, `filterSessions`, `displayTitle`, `RecentSessionsWindow`.
- Modify `src/renderer/keymap.ts` — `recentSessions` action on Ctrl+Shift+H.
- Modify `src/renderer/main.ts`, `src/renderer/index.html`, `src/renderer/styles.css` — wiring, menu item, overlay root, styles.
- Modify `tests/e2e/helpers.ts` — `launchApp({ env })`.
- Create tests: `tests/unit/session-history.test.ts`, `tests/unit/recent-sessions.test.ts`, `tests/e2e/recent-sessions.spec.ts`; modify `tests/unit/keymap.test.ts`.
- Modify `README.md` — feature section and shortcut row.

---

### Task 1: Transcript reader — `SessionHistory`

**Files:**
- Create: `src/main/session-history.ts`
- Modify: `src/shared/types.ts` (append)
- Test: `tests/unit/session-history.test.ts`

**Interfaces:**
- Consumes: `isUuid(value: unknown): value is string` from `src/shared/protocol.ts`.
- Produces:
  - `interface SessionSummary { id: string; cwd: string; title: string | null; firstPrompt: string | null; lastPrompt: string | null; modifiedAt: number }` and `interface RecentSession extends SessionSummary { open: boolean }` in `src/shared/types.ts`.
  - `class SessionHistory { constructor(projectsDir: string, fs?: HistoryFs); list(limit: number): Promise<SessionSummary[]> }`
  - `function claudeProjectsDir(env: NodeJS.ProcessEnv, home: string): string`
  - `parseSessionHead(text: string, whole: boolean): SessionHead | null`, `parseSessionTail(text: string, fromStart: boolean): SessionTail`, `oneLine(v: unknown): string | null`, `HEAD_BYTES`, `TAIL_BYTES`, `WIDE_TAIL_BYTES`, `interface HistoryFs`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/session-history.test.ts`:

```ts
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeProjectsDir, HEAD_BYTES, oneLine, parseSessionHead, parseSessionTail, SessionHistory, TAIL_BYTES, WIDE_TAIL_BYTES,
  type HistoryFs
} from '../../src/main/session-history'

const SID1 = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID2 = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
const SID3 = '6e3d2c8b-9f50-4b4c-a2d3-e4f5a6b7c8d9'
const ROOT = join('C:', 'cfg', 'projects')

const jsonl = (...entries: object[]): string => entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
const user = (cwd: string, content: unknown, over: object = {}): object => ({ type: 'user', cwd, entrypoint: 'cli', isSidechain: false, message: { role: 'user', content }, ...over })
const attachment = (cwd: string, size = 100): object => ({ type: 'attachment', cwd, entrypoint: 'cli', isSidechain: false, attachment: 'x'.repeat(size) })

/** an in-memory file system keyed by full path; reads are recorded as "<path>@<start>+<length>" */
function memFs(files: Record<string, { text: string; mtimeMs: number }>, failing: string[] = []) {
  const reads: string[] = []
  const fs: HistoryFs = {
    readdir: async (dir) => {
      const prefix = dir + '\\'
      const names = new Set<string>()
      for (const p of Object.keys(files)) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('\\')[0])
      if (names.size === 0) throw new Error(`ENOENT ${dir}`)
      return [...names]
    },
    stat: async (path) => {
      const f = files[path]
      if (!f) return { size: 0, mtimeMs: 0, isFile: () => false }
      return { size: Buffer.byteLength(f.text), mtimeMs: f.mtimeMs, isFile: () => true }
    },
    read: async (path, start, length) => {
      if (failing.includes(path)) throw new Error('EBUSY')
      reads.push(`${path}@${start}+${length}`)
      return Buffer.from(files[path].text).subarray(start, start + length).toString('utf8')
    }
  }
  return { fs, reads }
}

describe('oneLine', () => {
  it('collapses whitespace, trims, cuts to 200 characters; nothing → null', () => {
    expect(oneLine('  fix   the\nlogin  ')).toBe('fix the login')
    expect(oneLine('x'.repeat(500))).toHaveLength(200)
    expect(oneLine('   ')).toBeNull()
    expect(oneLine(7)).toBeNull()
  })
})

describe('parseSessionHead', () => {
  it('reads the folder, the first message and that a conversation started', () => {
    const text = jsonl({ type: 'mode', mode: 'default' }, user('D:\\a', '  fix   the\nlogin  '))
    expect(parseSessionHead(text, true)).toEqual({ cwd: 'D:\\a', firstPrompt: 'fix the login', hasUser: true })
  })

  it('takes the folder from a leading attachment when no user entry is in the window', () => {
    expect(parseSessionHead(jsonl({ type: 'last-prompt', lastPrompt: 'x' }, attachment('D:\\a')), true)).toEqual({ cwd: 'D:\\a', firstPrompt: null, hasUser: false })
  })

  it('claude -p runs, sidechains and files without a folder are not sessions', () => {
    expect(parseSessionHead(jsonl(user('D:\\a', 'hi', { entrypoint: 'sdk-cli' })), true)).toBeNull()
    expect(parseSessionHead(jsonl(user('D:\\a', 'hi', { isSidechain: true })), true)).toBeNull()
    expect(parseSessionHead(jsonl({ type: 'bridge-session', id: 'b' }), true)).toBeNull()
    expect(parseSessionHead('', true)).toBeNull()
  })

  it('a missing entrypoint (older Claude Code) counts as interactive', () => {
    const text = jsonl({ type: 'user', cwd: 'D:\\a', message: { role: 'user', content: 'hi' } })
    expect(parseSessionHead(text, true)?.firstPrompt).toBe('hi')
  })

  it('skips meta entries, command wrappers and tool results for the first message; joins text blocks', () => {
    const text = jsonl(
      user('D:\\a', 'Caveat: the messages below were generated…', { isMeta: true }),
      user('D:\\a', '<command-name>/clear</command-name>'),
      user('D:\\a', [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]),
      user('D:\\a', [{ type: 'text', text: 'add' }, { type: 'image', source: {} }, { type: 'text', text: 'payments' }])
    )
    expect(parseSessionHead(text, true)?.firstPrompt).toBe('add payments')
  })

  it('drops the line cut by the window end and broken lines', () => {
    const text = jsonl(user('D:\\a', 'first')) + 'not json\n' + '{"type":"user","cwd":"D:\\\\b","message":{"content":"cut'
    expect(parseSessionHead(text, false)).toEqual({ cwd: 'D:\\a', firstPrompt: 'first', hasUser: true })
  })

  it('a first message longer than the head window: folder from a leading entry, no first message', () => {
    const big = jsonl(attachment('D:\\a'), user('D:\\a', 'p'.repeat(HEAD_BYTES * 2)))
    const head = Buffer.from(big).subarray(0, HEAD_BYTES).toString('utf8')
    expect(parseSessionHead(head, false)).toEqual({ cwd: 'D:\\a', firstPrompt: null, hasUser: false })
  })
})

describe('parseSessionTail', () => {
  it('the last title and message win; a /rename name is kept apart from the generated title', () => {
    const text = jsonl(
      { type: 'ai-title', aiTitle: 'A1' }, { type: 'last-prompt', lastPrompt: 'p1' },
      { type: 'custom-title', customTitle: 'Mine' }, { type: 'ai-title', aiTitle: 'A2' }, { type: 'last-prompt', lastPrompt: 'p2' }
    )
    expect(parseSessionTail(text, true)).toEqual({ customTitle: 'Mine', aiTitle: 'A2', lastPrompt: 'p2' })
  })

  it('drops the first line when the window starts inside the file', () => {
    const text = '"ai-title","aiTitle":"cut"}\n' + jsonl({ type: 'ai-title', aiTitle: 'whole' })
    expect(parseSessionTail(text, false).aiTitle).toBe('whole')
  })

  it('a half-written last line is ignored', () => {
    const text = jsonl({ type: 'ai-title', aiTitle: 'Done' }) + '{"type":"ai-title","aiTitle":"Half'
    expect(parseSessionTail(text, true)).toEqual({ customTitle: null, aiTitle: 'Done', lastPrompt: null })
  })
})

describe('claudeProjectsDir', () => {
  it('uses CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    expect(claudeProjectsDir({ CLAUDE_CONFIG_DIR: 'E:\\cfg' }, 'C:\\Users\\me')).toBe(join('E:\\cfg', 'projects'))
    expect(claudeProjectsDir({}, 'C:\\Users\\me')).toBe(join('C:\\Users\\me', '.claude', 'projects'))
  })
})

describe('SessionHistory', () => {
  const file = (folder: string, name: string): string => join(ROOT, folder, name)

  it('lists sessions newest first and skips claude -p runs, other files and subagent folders', async () => {
    const { fs } = memFs({
      [file('D--a', `${SID1}.jsonl`)]: { text: jsonl(user('D:\\a', 'one?'), { type: 'ai-title', aiTitle: 'One' }, { type: 'last-prompt', lastPrompt: 'one?' }), mtimeMs: 1000 },
      [file('D--b', `${SID2}.jsonl`)]: { text: jsonl(user('D:\\b', 'two?'), { type: 'custom-title', customTitle: 'Two' }), mtimeMs: 3000 },
      [file('D--b', `${SID3}.jsonl`)]: { text: jsonl(user('D:\\b', 'scripted', { entrypoint: 'sdk-cli' })), mtimeMs: 4000 },
      [file('D--b', 'notes.jsonl')]: { text: jsonl(user('D:\\b', 'x')), mtimeMs: 5000 },
      [file('D--b', `${SID2}\\subagents\\agent-1.jsonl`)]: { text: jsonl(user('D:\\b', 'sub')), mtimeMs: 6000 }
    })
    expect(await new SessionHistory(ROOT, fs).list(10)).toEqual([
      { id: SID2, cwd: 'D:\\b', title: 'Two', firstPrompt: 'two?', lastPrompt: null, modifiedAt: 3000 },
      { id: SID1, cwd: 'D:\\a', title: 'One', firstPrompt: 'one?', lastPrompt: 'one?', modifiedAt: 1000 }
    ])
  })

  it('the limit counts listed sessions only', async () => {
    const { fs } = memFs({
      [file('D--a', `${SID1}.jsonl`)]: { text: jsonl(user('D:\\a', 'old')), mtimeMs: 1000 },
      [file('D--a', `${SID2}.jsonl`)]: { text: jsonl(user('D:\\a', 'mid')), mtimeMs: 2000 },
      [file('D--a', `${SID3}.jsonl`)]: { text: jsonl(user('D:\\a', 'p', { entrypoint: 'sdk-cli' })), mtimeMs: 3000 }
    })
    expect((await new SessionHistory(ROOT, fs).list(1)).map((s) => s.id)).toEqual([SID2])
  })

  it('reads the last 2 MB once when the last 256 KB hold no title or message', async () => {
    const filler = Array.from({ length: 400 }, () => attachment('D:\\a', 1000))
    const text = jsonl(user('D:\\a', 'start'), { type: 'ai-title', aiTitle: 'Deep' }, ...filler)
    const path = file('D--a', `${SID1}.jsonl`)
    const { fs, reads } = memFs({ [path]: { text, mtimeMs: 1 } })
    const [s] = await new SessionHistory(ROOT, fs).list(10)
    expect(s.title).toBe('Deep')
    const size = Buffer.byteLength(text)
    expect(reads).toEqual([`${path}@0+${HEAD_BYTES}`, `${path}@${size - TAIL_BYTES}+${TAIL_BYTES}`, `${path}@0+${size}`])
    expect(size).toBeLessThan(WIDE_TAIL_BYTES)
  })

  it('a conversation proven only by last-prompt is listed; a file with neither user entry nor last-prompt is not', async () => {
    const lead = Array.from({ length: 80 }, () => attachment('D:\\a', 1000))
    const { fs } = memFs({
      [file('D--a', `${SID1}.jsonl`)]: { text: jsonl(...lead, user('D:\\a', 'late'), { type: 'last-prompt', lastPrompt: 'go on' }), mtimeMs: 2 },
      [file('D--a', `${SID2}.jsonl`)]: { text: jsonl(attachment('D:\\a')), mtimeMs: 1 }
    })
    expect(await new SessionHistory(ROOT, fs).list(10)).toEqual([
      { id: SID1, cwd: 'D:\\a', title: null, firstPrompt: null, lastPrompt: 'go on', modifiedAt: 2 }
    ])
  })

  it('reuses what it read until a file changes', async () => {
    const files = {
      [file('D--a', `${SID1}.jsonl`)]: { text: jsonl(user('D:\\a', 'a')), mtimeMs: 1 },
      [file('D--a', `${SID2}.jsonl`)]: { text: jsonl(user('D:\\a', 'b')), mtimeMs: 2 }
    }
    const { fs, reads } = memFs(files)
    const h = new SessionHistory(ROOT, fs)
    await h.list(10)
    const first = reads.length
    await h.list(10)
    expect(reads).toHaveLength(first)
    files[file('D--a', `${SID1}.jsonl`)] = { text: jsonl(user('D:\\a', 'a'), { type: 'ai-title', aiTitle: 'Changed' }), mtimeMs: 5 }
    const list = await h.list(10)
    expect(list[0]).toMatchObject({ id: SID1, title: 'Changed' })
    expect(reads.slice(first).every((r) => r.startsWith(file('D--a', `${SID1}.jsonl`)))).toBe(true)
  })

  it('a missing projects folder gives an empty list; an unreadable file is skipped', async () => {
    expect(await new SessionHistory(join('C:', 'nowhere'), memFs({}).fs).list(10)).toEqual([])
    const bad = file('D--a', `${SID1}.jsonl`)
    const { fs } = memFs({
      [bad]: { text: jsonl(user('D:\\a', 'a')), mtimeMs: 2 },
      [file('D--a', `${SID2}.jsonl`)]: { text: jsonl(user('D:\\a', 'b')), mtimeMs: 1 }
    }, [bad])
    expect((await new SessionHistory(ROOT, fs).list(10)).map((s) => s.id)).toEqual([SID2])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/session-history.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/main/session-history"`.

- [ ] **Step 3: Add the shared types**

Append to `src/shared/types.ts`:

```ts
/** A Claude Code conversation found in Claude Code's transcripts. */
export interface SessionSummary {
  id: string
  cwd: string
  /** the /rename name, else Claude Code's generated title; null when neither is there */
  title: string | null
  firstPrompt: string | null
  lastPrompt: string | null
  /** ms since epoch: when the transcript last changed */
  modifiedAt: number
}

export interface RecentSession extends SessionSummary {
  /** a ClaudeTerm tab is in this conversation */
  open: boolean
}
```

- [ ] **Step 4: Write `src/main/session-history.ts`**

```ts
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isUuid } from '../shared/protocol'
import type { SessionSummary } from '../shared/types'

export const HEAD_BYTES = 64 * 1024
export const TAIL_BYTES = 256 * 1024
export const WIDE_TAIL_BYTES = 2 * 1024 * 1024
const MAX_TEXT = 200

/** Claude Code keeps every conversation under <config>/projects; CLAUDE_CONFIG_DIR moves <config>. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects')
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** One line, whitespace collapsed, at most 200 characters; null for nothing. */
export function oneLine(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, MAX_TEXT) : null
}

/** The JSON objects of a window of a transcript; a line cut by a window edge, or broken, is skipped. */
function entries(text: string, cutStart: boolean, cutEnd: boolean): Obj[] {
  const lines = text.split('\n')
  if (cutStart) lines.shift()
  if (cutEnd) lines.pop()
  const out: Obj[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const o: unknown = JSON.parse(line)
      if (isObj(o)) out.push(o)
    } catch {
      // a broken or half-written line
    }
  }
  return out
}

/** The text the user typed: a string or text blocks; tool results and <command…>/caveat wrappers are not. */
function typedText(content: unknown): string | null {
  let text: string | null = null
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    const parts = content.filter((b): b is Obj => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string)
    if (parts.length > 0) text = parts.join(' ')
  }
  if (text === null || text.trimStart().startsWith('<')) return null
  return oneLine(text)
}

export interface SessionHead {
  cwd: string
  firstPrompt: string | null
  /** a user entry of the main conversation is in the window */
  hasUser: boolean
}

/**
 * The start of a transcript. `whole` tells whether the window holds the entire file (otherwise its last line
 * may be cut). Null when the file is not a session for the list: no folder, a sidechain, a `claude -p` run.
 */
export function parseSessionHead(text: string, whole: boolean): SessionHead | null {
  const list = entries(text, false, !whole)
  // user, attachment and system entries carry the folder; the first user entry can be far in
  const first = list.find((e) => typeof e.cwd === 'string' && e.cwd.length > 0)
  if (!first || first.isSidechain === true) return null
  if (first.entrypoint !== undefined && first.entrypoint !== 'cli') return null
  let hasUser = false
  let firstPrompt: string | null = null
  for (const e of list) {
    if (e.type !== 'user' || e.isSidechain === true) continue
    hasUser = true
    if (firstPrompt === null && e.isMeta !== true) firstPrompt = typedText(isObj(e.message) ? e.message.content : undefined)
  }
  return { cwd: first.cwd as string, firstPrompt, hasUser }
}

export interface SessionTail {
  customTitle: string | null
  aiTitle: string | null
  lastPrompt: string | null
}

/**
 * The end of a transcript. Claude Code appends its title and the last prompt again as the conversation goes
 * on, so the last occurrence is the current one. `fromStart` tells whether the window starts at the file's start.
 */
export function parseSessionTail(text: string, fromStart: boolean): SessionTail {
  const t: SessionTail = { customTitle: null, aiTitle: null, lastPrompt: null }
  for (const e of entries(text, !fromStart, false)) {
    if (e.type === 'custom-title') t.customTitle = oneLine(e.customTitle) ?? t.customTitle
    else if (e.type === 'ai-title') t.aiTitle = oneLine(e.aiTitle) ?? t.aiTitle
    else if (e.type === 'last-prompt') t.lastPrompt = oneLine(e.lastPrompt) ?? t.lastPrompt
  }
  return t
}

export interface HistoryFs {
  readdir(dir: string): Promise<string[]>
  stat(path: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean }>
  /** `length` bytes from `start`, as UTF-8 (a character cut at an edge only spoils the line that gets dropped) */
  read(path: string, start: number, length: number): Promise<string>
}

export const nodeHistoryFs: HistoryFs = {
  readdir: (dir) => readdir(dir),
  stat: (path) => stat(path),
  read: async (path, start, length) => {
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await fh.read(buf, 0, length, start)
      return buf.toString('utf8', 0, bytesRead)
    } finally {
      await fh.close()
    }
  }
}

interface TranscriptFile {
  path: string
  id: string
  size: number
  mtimeMs: number
}

/** The most recently active Claude Code sessions, read from Claude Code's transcripts. */
export class SessionHistory {
  private readonly cache = new Map<string, { size: number; mtimeMs: number; summary: SessionSummary | null }>()

  constructor(private readonly projectsDir: string, private readonly fs: HistoryFs = nodeHistoryFs) {}

  async list(limit: number): Promise<SessionSummary[]> {
    const files = await this.transcripts()
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const out: SessionSummary[] = []
    for (const f of files) {
      if (out.length >= limit) break
      const s = await this.summary(f)
      if (s) out.push(s)
    }
    return out
  }

  /** <uuid>.jsonl directly in each project folder; subagent transcripts live deeper */
  private async transcripts(): Promise<TranscriptFile[]> {
    let projects: string[]
    try {
      projects = await this.fs.readdir(this.projectsDir)
    } catch {
      return []
    }
    const files: TranscriptFile[] = []
    for (const project of projects) {
      let names: string[]
      try {
        names = await this.fs.readdir(join(this.projectsDir, project))
      } catch {
        continue // a file, or gone meanwhile
      }
      for (const name of names) {
        const id = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : ''
        if (!isUuid(id)) continue
        const path = join(this.projectsDir, project, name)
        try {
          const s = await this.fs.stat(path)
          if (s.isFile()) files.push({ path, id, size: s.size, mtimeMs: s.mtimeMs })
        } catch {
          // gone meanwhile
        }
      }
    }
    return files
  }

  private async summary(f: TranscriptFile): Promise<SessionSummary | null> {
    const cached = this.cache.get(f.path)
    if (cached && cached.size === f.size && cached.mtimeMs === f.mtimeMs) return cached.summary
    let summary: SessionSummary | null
    try {
      summary = await this.read(f)
    } catch {
      return null // locked or gone: try again next time
    }
    this.cache.set(f.path, { size: f.size, mtimeMs: f.mtimeMs, summary })
    return summary
  }

  private async read(f: TranscriptFile): Promise<SessionSummary | null> {
    const head = parseSessionHead(await this.fs.read(f.path, 0, Math.min(f.size, HEAD_BYTES)), f.size <= HEAD_BYTES)
    if (!head) return null
    let tail = await this.tail(f, TAIL_BYTES)
    if (!tail.customTitle && !tail.aiTitle && !tail.lastPrompt && f.size > TAIL_BYTES) tail = await this.tail(f, WIDE_TAIL_BYTES)
    if (!head.hasUser && !tail.lastPrompt) return null
    return { id: f.id, cwd: head.cwd, title: tail.customTitle ?? tail.aiTitle, firstPrompt: head.firstPrompt, lastPrompt: tail.lastPrompt, modifiedAt: f.mtimeMs }
  }

  private async tail(f: TranscriptFile, bytes: number): Promise<SessionTail> {
    const start = Math.max(0, f.size - bytes)
    return parseSessionTail(await this.fs.read(f.path, start, f.size - start), start === 0)
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/session-history.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck` — Expected: no errors.

```bash
git add src/main/session-history.ts src/shared/types.ts tests/unit/session-history.test.ts
git commit -m "feat: read recent Claude Code sessions from their transcripts"
```

---

### Task 2: Main-process IPC — list and open sessions

**Files:**
- Modify: `src/shared/ipc.ts` (IPC table, `CtApi`)
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts` (imports, a `SessionHistory`, two handlers next to `IPC.tabsOpen`)
- Modify: `tests/e2e/helpers.ts` (`launchApp` gets `env`)
- Test: `tests/e2e/recent-sessions.spec.ts` (first part)

**Interfaces:**
- Consumes: `SessionHistory`, `claudeProjectsDir` (Task 1); `SessionSummary`, `RecentSession` (Task 1); in `index.ts`: `tabs.list()`, `tabs.activate(id)`, `openTab(req)`, `isDirectory(p)`, `toast(message)`, `isId`.
- Produces:
  - `IPC.sessionsList = 'sessions:list'`, `IPC.sessionsOpen = 'sessions:open'`.
  - `CtApi.listSessions(): Promise<RecentSession[]>`, `CtApi.openSession(id: string): void`.
  - `launchApp(o: { dataDir?; settings?; args?; env?: Record<string, string> })`.

- [ ] **Step 1: Let e2e tests pass extra environment**

In `tests/e2e/helpers.ts` change `launchApp`:

```ts
export async function launchApp(o: { dataDir?: string; settings?: object; args?: string[]; env?: Record<string, string> } = {}): Promise<Launched> {
  const dataDir = o.dataDir ?? makeDataDir(o.settings)
  const pipeName = `\\\\.\\pipe\\claudeterm-e2e-${randomUUID()}`
  const app = await electron.launch({ args: [ROOT, ...(o.args ?? [])], env: { ...testEnv(dataDir, pipeName), ...o.env } })
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.__ct))
  return { app, page, dataDir, pipeName }
}
```

- [ ] **Step 2: Write the failing e2e tests**

`tests/e2e/recent-sessions.spec.ts`:

```ts
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchApp } from './helpers'

const SID_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID_B = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
const SID_C = '6e3d2c8b-9f50-4b4c-a2d3-e4f5a6b7c8d9'

const user = (cwd: string, text: string, entrypoint = 'cli'): object => ({ type: 'user', cwd, entrypoint, isSidechain: false, message: { role: 'user', content: text } })

function writeSession(config: string, cwd: string, id: string, entries: object[], minutesAgo: number): void {
  const dir = join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const at = new Date(Date.now() - minutesAgo * 60_000)
  utimesSync(file, at, at)
}

/** two interactive sessions (B newer) and a newer `claude -p` run that must not be listed */
function makeConfig(): { config: string; workA: string; workB: string } {
  const config = mkdtempSync(join(tmpdir(), 'ct-claude-config-'))
  const workA = mkdtempSync(join(tmpdir(), 'ct-work-a-'))
  const workB = mkdtempSync(join(tmpdir(), 'ct-work-b-'))
  writeSession(config, workA, SID_A, [user(workA, 'why does login fail'), { type: 'ai-title', aiTitle: 'Fix the login bug' }, { type: 'last-prompt', lastPrompt: 'why does login fail' }], 120)
  writeSession(config, workB, SID_B, [user(workB, 'add yookassa'), { type: 'ai-title', aiTitle: 'Something else' }, { type: 'custom-title', customTitle: 'Payments' }, { type: 'last-prompt', lastPrompt: 'add yookassa' }], 5)
  writeSession(config, workA, SID_C, [user(workA, 'scripted', 'sdk-cli')], 1)
  return { config, workA, workB }
}

test('the main process lists sessions newest first and opens one in a Claude tab, or goes to its tab', async () => {
  const { config, workA } = makeConfig()
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const list = await page.evaluate(() => window.ct.listSessions())
  expect(list.map((s) => [s.id, s.title, s.open])).toEqual([[SID_B, 'Payments', false], [SID_A, 'Fix the login bug', false]])
  expect(list[1]).toMatchObject({ cwd: workA, firstPrompt: 'why does login fail', lastPrompt: 'why does login fail' })

  await page.evaluate((id) => window.ct.openSession(id), SID_A)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const tabA = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect.poll(() => bufferText(page, tabA), { timeout: 15_000 }).toContain(`--resume ${SID_A}`)
  await expect.poll(() => bufferText(page, tabA), { timeout: 15_000 }).toContain(workA)
  expect((await page.evaluate(() => window.ct.listSessions())).find((s) => s.id === SID_A)?.open).toBe(true)

  // a second tab in the same folder, then back to the conversation's own tab
  await page.evaluate((cwd) => window.ct.openTab({ kind: 'shell', cwd }), workA)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 3)
  await page.evaluate((id) => window.ct.openSession(id), SID_A)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tabA)
  expect(await page.evaluate(() => window.__ct!.tabIds().length)).toBe(3)
  await app.close()
})

test('a session whose folder is gone is not opened', async () => {
  const { config, workB } = makeConfig()
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.evaluate(() => window.ct.listSessions())
  rmSync(workB, { recursive: true, force: true })
  await page.evaluate((id) => window.ct.openSession(id), SID_B)
  await expect(page.locator('.toast', { hasText: 'The folder of this session no longer exists' })).toBeVisible()
  expect(await page.evaluate(() => window.__ct!.tabIds().length)).toBe(1)
  await app.close()
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npm run build && npx playwright test tests/e2e/recent-sessions.spec.ts`
Expected: FAIL — `window.ct.listSessions is not a function`.

- [ ] **Step 4: Add the IPC channels and the API**

`src/shared/ipc.ts`:
- import: `import type { AgentStatus, ImageCard, MainStatus, OpenTabRequest, RecentSession, Settings, TabInfo, UpdateState } from './types'`
- in `IPC`, after `restoreRun: 'restore:run',` add:

```ts
  sessionsList: 'sessions:list',
  sessionsOpen: 'sessions:open',
```

- in `CtApi`, after `runRestore(): void` add:

```ts
  /** the most recent Claude Code sessions, newest first */
  listSessions(): Promise<RecentSession[]>
  /** go to the tab in that conversation, or resume it in a new Claude tab */
  openSession(id: string): void
```

`src/preload/index.ts`, after the `runRestore` line add:

```ts
  listSessions: () => ipcRenderer.invoke(IPC.sessionsList),
  openSession: (id) => ipcRenderer.send(IPC.sessionsOpen, id),
```

- [ ] **Step 5: Handle them in the main process**

`src/main/index.ts`:
- imports: add `RecentSession, SessionSummary` to the `../shared/types` type import, and `import { claudeProjectsDir, SessionHistory } from './session-history'`.
- after `const sessions = new SessionStore(...)` and the restore lines, add:

```ts
  const history = new SessionHistory(claudeProjectsDir(process.env, homedir()))
  // what the window was last shown; opening looks the id up here, so the renderer only passes an id
  let listedSessions = new Map<string, SessionSummary>()
```

- next to `ipcMain.handle(IPC.tabsOpen, …)` add:

```ts
  ipcMain.handle(IPC.sessionsList, async (): Promise<RecentSession[]> => {
    const list = await history.list(100)
    listedSessions = new Map(list.map((s) => [s.id, s]))
    const open = new Set(tabs.list().map((t) => t.claudeSessionId))
    return list.map((s) => ({ ...s, open: open.has(s.id) }))
  })
  ipcMain.on(IPC.sessionsOpen, (_e, id: unknown) => {
    const s = isId(id) ? listedSessions.get(id) : undefined
    if (!s) return
    const tab = tabs.list().find((t) => t.claudeSessionId === s.id)
    if (tab) {
      tabs.activate(tab.id)
      return
    }
    // Claude Code finds a conversation by its folder: resuming it anywhere else fails
    if (!isDirectory(s.cwd)) {
      toast(`The folder of this session no longer exists: ${s.cwd}`)
      return
    }
    openTab({ kind: 'claude', cwd: s.cwd, resumeSessionId: s.id })
  })
```

- [ ] **Step 6: Run the e2e tests to verify they pass**

Run: `npm run build && npx playwright test tests/e2e/recent-sessions.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck` — Expected: no errors.

```bash
git add src/shared/ipc.ts src/preload/index.ts src/main/index.ts tests/e2e/helpers.ts tests/e2e/recent-sessions.spec.ts
git commit -m "feat: list recent sessions and resume one through IPC"
```

---

### Task 3: The Recent sessions window

**Files:**
- Create: `src/renderer/recent-sessions.ts`
- Modify: `src/renderer/keymap.ts`, `src/renderer/main.ts`, `src/renderer/index.html`, `src/renderer/styles.css`, `README.md`
- Test: `tests/unit/recent-sessions.test.ts`, `tests/unit/keymap.test.ts`, `tests/e2e/recent-sessions.spec.ts` (append)

**Interfaces:**
- Consumes: `RecentSession`, `SessionSummary` (Task 1); `ct.listSessions()`, `ct.openSession(id)` (Task 2); `folderName(cwd)` from `src/renderer/util.ts`.
- Produces: `formatAge(at: number, now: number): string`, `filterSessions(list: RecentSession[], query: string): RecentSession[]`, `displayTitle(s: SessionSummary): string`, `class RecentSessionsWindow { constructor(root: HTMLElement, cb: { load(): Promise<RecentSession[]>; open(id: string): void; closed(): void }); readonly isOpen: boolean; open(): Promise<void>; close(): void }`, key action `{ type: 'recentSessions' }`.

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/recent-sessions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { displayTitle, filterSessions, formatAge } from '../../src/renderer/recent-sessions'
import type { RecentSession } from '../../src/shared/types'

const s = (over: Partial<RecentSession>): RecentSession => ({ id: 'x', cwd: 'D:\\Workspace\\Offroad', title: null, firstPrompt: null, lastPrompt: null, modifiedAt: 0, open: false, ...over })

describe('formatAge', () => {
  const now = new Date(2026, 9, 6, 12, 0).getTime()
  const at = (d: number, h: number, m = 0, y = 2026, mo = 9): number => new Date(y, mo, d, h, m).getTime()
  it('minutes and hours today, then days, then a date', () => {
    expect(formatAge(now - 30_000, now)).toBe('just now')
    expect(formatAge(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(formatAge(now - 3 * 3_600_000, now)).toBe('3 h ago')
    expect(formatAge(at(5, 9), now)).toBe('yesterday')
    expect(formatAge(at(3, 9), now)).toBe('3 days ago')
    expect(formatAge(at(28, 9, 0, 2026, 8), now)).toBe('28 Sep')
    expect(formatAge(at(5, 9, 0, 2025, 9), now)).toBe('5 Oct 2025')
  })
})

describe('filterSessions', () => {
  const list = [
    s({ id: '1', title: 'Fix the login bug', lastPrompt: 'why does login fail' }),
    s({ id: '2', title: 'Payments', cwd: 'D:\\Workspace\\Shop', firstPrompt: 'add YooKassa' })
  ]
  it('every word must match the title, folder or messages, ignoring case', () => {
    expect(filterSessions(list, '').map((x) => x.id)).toEqual(['1', '2'])
    expect(filterSessions(list, 'LOGIN').map((x) => x.id)).toEqual(['1'])
    expect(filterSessions(list, 'shop yookassa').map((x) => x.id)).toEqual(['2'])
    expect(filterSessions(list, 'offroad').map((x) => x.id)).toEqual(['1'])
    expect(filterSessions(list, 'login payments')).toEqual([])
  })
})

describe('displayTitle', () => {
  it('title, else the first message, else (untitled)', () => {
    expect(displayTitle(s({ title: 'T', firstPrompt: 'f' }))).toBe('T')
    expect(displayTitle(s({ firstPrompt: 'f' }))).toBe('f')
    expect(displayTitle(s({}))).toBe('(untitled)')
  })
})
```

In `tests/unit/keymap.test.ts`, inside `it('matches the physical key, so a Russian layout works', …)` add:

```ts
    expect(mapKey(k('KeyH', cs, 'Р'))).toEqual({ type: 'recentSessions' })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/unit/recent-sessions.test.ts tests/unit/keymap.test.ts`
Expected: FAIL — unresolved import `../../src/renderer/recent-sessions`; keymap: `expected null to deeply equal { type: 'recentSessions' }`.

- [ ] **Step 3: Write `src/renderer/recent-sessions.ts`**

```ts
import type { RecentSession, SessionSummary } from '../shared/types'
import { folderName } from './util'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 86_400_000

const startOfDay = (ms: number): number => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** When a session was last active, as the list shows it. */
export function formatAge(at: number, now: number): string {
  const min = Math.floor((now - at) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  if (min < 24 * 60) return `${Math.floor(min / 60)} h ago`
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS)
  if (days <= 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  const d = new Date(at)
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === new Date(now).getFullYear() ? date : `${date} ${d.getFullYear()}`
}

export const displayTitle = (s: SessionSummary): string => s.title ?? s.firstPrompt ?? '(untitled)'

/** Sessions where every typed word appears in the title, the folder or a message, ignoring case. */
export function filterSessions(list: RecentSession[], query: string): RecentSession[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return list
  return list.filter((s) => {
    const text = [s.title, s.cwd, s.firstPrompt, s.lastPrompt].filter((x) => x !== null).join('\n').toLowerCase()
    return words.every((w) => text.includes(w))
  })
}

export interface RecentSessionsCallbacks {
  load(): Promise<RecentSession[]>
  open(id: string): void
  /** the window closed without opening anything, or before opening: give the keyboard back */
  closed(): void
}

/** A modal list of recent sessions with a search field; Enter continues the selected one. */
export class RecentSessionsWindow {
  private sessions: RecentSession[] = []
  private shown: RecentSession[] = []
  private selected = 0
  private loading = false
  private loadId = 0
  private readonly input: HTMLInputElement
  private readonly rows: HTMLElement

  constructor(private readonly root: HTMLElement, private readonly cb: RecentSessionsCallbacks) {
    const box = document.createElement('div')
    box.className = 'sessions-box'
    const heading = document.createElement('div')
    heading.className = 'sessions-heading'
    heading.textContent = 'Recent sessions'
    this.input = document.createElement('input')
    this.input.className = 'sessions-search'
    this.input.placeholder = 'Search by title, folder or message'
    this.input.spellcheck = false
    this.rows = document.createElement('div')
    this.rows.className = 'sessions-list'
    box.append(heading, this.input, this.rows)
    root.replaceChildren(box)
    root.addEventListener('mousedown', (e) => { if (e.target === root) this.close() })
    this.input.addEventListener('input', () => {
      this.selected = 0
      this.render()
    })
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') this.move(1)
      else if (e.key === 'ArrowUp') this.move(-1)
      else if (e.key === 'Enter') this.choose(this.shown[this.selected])
      else if (e.key === 'Escape') this.close()
      else return
      e.preventDefault()
    })
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  async open(): Promise<void> {
    const id = ++this.loadId
    this.root.hidden = false
    this.input.value = ''
    this.selected = 0
    this.sessions = []
    this.loading = true
    this.render()
    this.input.focus()
    const list = await this.cb.load().catch(() => [] as RecentSession[])
    // a newer open() or a close() came first: this result is stale
    if (id !== this.loadId) return
    this.sessions = list
    this.loading = false
    this.render()
  }

  close(): void {
    if (this.root.hidden) return
    this.loadId++
    this.root.hidden = true
    this.cb.closed()
  }

  private move(delta: number): void {
    if (this.shown.length === 0) return
    this.selected = Math.min(Math.max(this.selected + delta, 0), this.shown.length - 1)
    this.render()
  }

  private choose(s: RecentSession | undefined): void {
    if (!s) return
    this.close()
    this.cb.open(s.id)
  }

  private render(): void {
    this.shown = filterSessions(this.sessions, this.input.value)
    if (this.shown.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'sessions-empty'
      empty.textContent = this.loading ? 'Loading…' : this.sessions.length === 0 ? 'No Claude Code sessions yet' : 'Nothing matches'
      this.rows.replaceChildren(empty)
      return
    }
    const now = Date.now()
    this.rows.replaceChildren(...this.shown.map((s, i) => this.row(s, i === this.selected, now)))
    this.rows.querySelector('.session-row.selected')?.scrollIntoView({ block: 'nearest' })
  }

  private row(s: RecentSession, selected: boolean, now: number): HTMLElement {
    const row = document.createElement('div')
    row.className = `session-row${selected ? ' selected' : ''}`
    row.dataset.id = s.id
    const top = document.createElement('div')
    top.className = 'session-top'
    const title = document.createElement('span')
    title.className = 'session-title'
    title.textContent = displayTitle(s)
    top.append(title)
    if (s.open) {
      const open = document.createElement('span')
      open.className = 'session-open'
      open.textContent = '● open'
      top.append(open)
    }
    const meta = document.createElement('div')
    meta.className = 'session-meta'
    const folder = document.createElement('span')
    folder.textContent = folderName(s.cwd)
    folder.title = s.cwd
    meta.append(folder, ` · ${formatAge(s.modifiedAt, now)}`)
    row.append(top, meta)
    if (s.lastPrompt && s.lastPrompt !== displayTitle(s)) {
      const last = document.createElement('div')
      last.className = 'session-last'
      last.textContent = s.lastPrompt
      row.append(last)
    }
    row.addEventListener('click', () => this.choose(s))
    return row
  }
}
```

- [ ] **Step 4: Add the key**

`src/renderer/keymap.ts`: add `| { type: 'recentSessions' }` to `KeyAction`, and in the `c && s && !a` switch add `case 'KeyH': return { type: 'recentSessions' }` after `case 'KeyI'`.

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `npx vitest run tests/unit/recent-sessions.test.ts tests/unit/keymap.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing e2e tests for the window**

Append to `tests/e2e/recent-sessions.spec.ts`:

```ts
test('Ctrl+Shift+H opens the window: newest first, filter as you type, Enter continues the session', async () => {
  const { config, workB } = makeConfig()
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press('Control+Shift+KeyH')
  const win = page.locator('#sessions')
  await expect(win).toBeVisible()
  await expect(win.locator('.session-title')).toHaveText(['Payments', 'Fix the login bug'])
  const first = win.locator('.session-row').first()
  await expect(first).toHaveClass(/selected/)
  await expect(first.locator('.session-meta')).toContainText('5 min ago')
  await expect(first.locator('.session-meta span')).toHaveAttribute('title', workB)
  await expect(win.locator('.session-last').last()).toHaveText('why does login fail')
  await page.keyboard.type('login')
  await expect(win.locator('.session-title')).toHaveText(['Fix the login bug'])
  await page.keyboard.press('Enter')
  await expect(win).toBeHidden()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const id = (await page.evaluate(() => window.__ct!.activeTabId()))!
  await expect.poll(() => bufferText(page, id), { timeout: 15_000 }).toContain(`--resume ${SID_A}`)
  await app.close()
})

test('the ▾ menu opens the window; an open session is marked and goes to its tab; Esc closes', async () => {
  const { config } = makeConfig()
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.evaluate(() => window.ct.listSessions())
  await page.evaluate((sid) => window.ct.openSession(sid), SID_A)
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const tabA = (await page.evaluate(() => window.__ct!.activeTabId()))!
  const [shellTab] = await page.evaluate(() => window.__ct!.tabIds())
  await page.evaluate((id) => window.ct.activateTab(id), shellTab)
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, shellTab)

  await page.locator('.tab-menu').click()
  await page.locator('.menu-item', { hasText: 'Recent sessions…' }).click()
  const win = page.locator('#sessions')
  await expect(win.locator('.session-row', { hasText: 'Fix the login bug' }).locator('.session-open')).toHaveText('● open')
  await page.keyboard.press('ArrowDown')
  await expect(win.locator('.session-row').nth(1)).toHaveClass(/selected/)
  await page.keyboard.press('Enter')
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, tabA)
  expect(await page.evaluate(() => window.__ct!.tabIds().length)).toBe(2)

  await page.keyboard.press('Control+Shift+KeyH')
  await expect(win).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(win).toBeHidden()
  await app.close()
})

test('empty states', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'ct-claude-config-'))
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: empty } })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press('Control+Shift+KeyH')
  await expect(page.locator('#sessions .sessions-empty')).toHaveText('No Claude Code sessions yet')
  await app.close()

  const { config } = makeConfig()
  const second = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, env: { CLAUDE_CONFIG_DIR: config } })
  await second.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await second.page.locator('.terminal-host:visible .xterm').click()
  await second.page.keyboard.press('Control+Shift+KeyH')
  await expect(second.page.locator('#sessions .session-row')).toHaveCount(2)
  await second.page.keyboard.type('zzz')
  await expect(second.page.locator('#sessions .sessions-empty')).toHaveText('Nothing matches')
  await second.app.close()
})
```

- [ ] **Step 7: Run them to verify they fail**

Run: `npm run build && npx playwright test tests/e2e/recent-sessions.spec.ts`
Expected: the 3 new tests FAIL (`#sessions` not found / not visible); the 2 Task 2 tests still pass.

- [ ] **Step 8: Wire the window into the renderer**

`src/renderer/index.html`: after `<div id="lightbox" hidden></div>` add `<div id="sessions" hidden></div>`.

`src/renderer/styles.css`, append:

```css
#sessions { position: fixed; inset: 0; z-index: 45; display: flex; justify-content: center; align-items: flex-start; padding: 60px 16px 0; background: #0007; }
.sessions-box { width: min(640px, 100%); max-height: calc(100vh - 120px); display: flex; flex-direction: column; background: var(--chrome-2); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 12px 32px #0009; overflow: hidden; }
.sessions-heading { padding: 10px 14px 0; color: var(--muted); font-size: 12px; }
.sessions-search { margin: 8px 12px; padding: 6px 8px; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; font: inherit; outline: none; }
.sessions-search:focus { border-color: var(--accent); }
.sessions-list { overflow-y: auto; padding-bottom: 6px; }
.session-row { padding: 6px 14px; cursor: pointer; }
.session-row:hover { background: #ffffff0d; }
.session-row.selected { background: #ffffff1a; box-shadow: inset 2px 0 0 var(--accent); }
.session-top { display: flex; gap: 8px; align-items: baseline; }
.session-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-open { color: var(--accent); font-size: 12px; white-space: nowrap; }
.session-meta, .session-last { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-last { opacity: 0.75; }
.sessions-empty { padding: 12px 14px; color: var(--muted); }
```

`src/renderer/main.ts`:
- import: `import { RecentSessionsWindow } from './recent-sessions'`
- module state next to `let lightbox: Lightbox`: `let sessionsWindow: RecentSessionsWindow`
- `runAction`: add `case 'recentSessions': void sessionsWindow.open(); break`
- `newTabMenu`: after the `Claude Code` item add `{ label: 'Recent sessions…', action: () => void sessionsWindow.open() },`
- in `boot()`, right after `lightbox = new Lightbox(...)`:

```ts
  sessionsWindow = new RecentSessionsWindow(document.getElementById('sessions')!, {
    load: () => ct.listSessions(),
    open: (id) => ct.openSession(id),
    closed: () => { if (activeId) tabs.get(activeId)?.view.term.focus() }
  })
```

- the window `focus` listener: do not take the keyboard from the open window:

```ts
  window.addEventListener('focus', () => {
    if (sessionsWindow.isOpen) return
    const t = activeId ? tabs.get(activeId) : undefined
    t?.view.term.focus()
  })
```

- [ ] **Step 9: Run the e2e tests to verify they pass**

Run: `npm run build && npx playwright test tests/e2e/recent-sessions.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 10: README**

After the `### 🔁 Continue previous sessions` paragraph add:

```markdown

**Recent sessions** (`Ctrl+Shift+H`, or **Recent sessions…** in the ▾ menu) lists your latest Claude Code conversations from every project — also ones started outside ClaudeTerm — with their titles, folders and last messages. Type to filter, Enter to continue one: ClaudeTerm opens a Claude tab in that folder with `claude --resume`, or switches to the tab that already has it.
```

In the shortcut table, after the `Show / hide the image panel` row add:

```markdown
| Recent sessions | `Ctrl+Shift+H` |
```

- [ ] **Step 11: Full check and commit**

Run: `npm run typecheck && npm test` — Expected: no type errors; all unit and integration tests pass.

```bash
git add src/renderer/recent-sessions.ts src/renderer/keymap.ts src/renderer/main.ts src/renderer/index.html src/renderer/styles.css README.md tests/unit/recent-sessions.test.ts tests/unit/keymap.test.ts tests/e2e/recent-sessions.spec.ts
git commit -m "feat: Recent sessions window (Ctrl+Shift+H) to continue a Claude Code conversation"
```
