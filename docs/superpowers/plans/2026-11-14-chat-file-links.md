# File paths in Claude's chat answers are links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Claude's text in the chat, a path that names a file of the tab is a link: a document opens in the Docs panel, any other file opens in the editor from Settings at its line; a path to nothing stays text.

**Architecture:** A pure shared module says what a path looks like. The chat's Markdown renderer wraps each path-shaped token of a text item in a pending element; a small window-side class asks main, debounced, which of them are files of the tab (new IPC `chatFileLinks`), and turns those into links. A click sends `chatOpenFile`; main checks the file again and opens it through `DocHub.show` or `launchEditor`.

**Tech Stack:** Electron 44, TypeScript (strict), markdown-it 15, plain DOM renderer, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-14-chat-file-links-design.md`

## Global Constraints

- Comments, logs and UI strings in English; match the surrounding code's naming and comment density; no UI framework.
- Keep each file's line endings. In the working tree these are CRLF: `src/main/index.ts`, `src/main/ipc-guards.ts`, `src/preload/index.ts`, `src/shared/ipc.ts`, `src/renderer/main.ts`, `src/renderer/chat/chat-items.ts`, `src/renderer/chat/chat-view.ts`, `src/renderer/chat/chat.css`, `tests/e2e/chat-helpers.ts`, `tests/unit/ipc-guards.test.ts`. LF: `src/renderer/chat/chat-markdown.ts`, `tests/unit/chat-markdown.test.ts`. New files: LF.
- Shape of a path in text and inline code: a whitespace-separated token, with leading `` ( [ { " ' ` < “ ‘ `` and trailing `` . , ; : ! ? ) ] } " ' ` > ” ’ `` stripped (repeatedly), that is not a URL (`^[A-Za-z][A-Za-z0-9+.-]*:` unless it is a drive letter followed by `\` or `/`), contains `/` or `\`, has none of whitespace `* ? < > | "` or control characters, and whose last part has an extension (a dot not at the start of the part, then 1–12 of `[A-Za-z0-9_]` with at least one letter); an optional `:line`, `:line:col` or `:line-line` suffix gives the line (the first number; 0 is no line).
- A Markdown link target (`[x](target)`) that is not an http(s) link is a path when it is not a URL, has no `* ? < > | "` or control character, and its last part has an extension; it needs no `/` (`[x](README.md)`), may hold spaces (`[x](<my file.md>)`), and a `#L12` or `#L12-L20` fragment gives line 12 (another fragment is dropped).
- At most `MAX_FILE_LINKS = 200` paths per `chatFileLinks` call; each path text 1 to `MAX_PATH_TEXT` (4096, `src/shared/remote.ts`) characters with no control character.
- Relative paths resolve against the tab's `TabInfo.folder` (where Claude works now: a worktree it entered, a cd); `~`/`~/x`/`~\x` against the home folder; absolute paths as they are. Network paths (starting with `\\` or `//`) are never looked at.
- Only a local Claude tab (`isLocalClaudeTab`) gets answers; a remote tab gets `[]`, and the window does not ask for one.
- Main opens only a file an earlier `chatFileLinks` answer of the same tab named (compared with `pathKey`), and checks again that it is a regular file. A document (`docKindOf` not null) opens through `docs.show(tabId, file, null, kind)` after `checkDocFile` and `htmlFolderRefused` pass; a document they refuse, and every other file, opens through `launchEditor(settings.review.editor, file, line ?? 1, { spawn: spawnDetached, reveal: (p) => shell.showItemInFolder(p), onError: toast })`. Never `shell.openPath` a linked file.
- Exact copy: toast `File not found: <file>`; link title `Open <file> in Docs` (document) or `Open <file>[:<line>] in the editor` (any other file).
- Markup: pending element `<span class="chat-path" data-path="<path[:line]>">…</span>`, or the Markdown link itself `<a class="chat-link chat-path" data-path="…">`. Its `data-link` is `asked` while main is asked, `none` when main said it is not a file, `file` once it is a link; a link also gets class `chat-file-link`, `data-file`, `data-line` (only with a line) and its title.
- Only `text` items get pending paths; prompts, plan cards and Heads up cards render as today. Only the main conversation's column asks main (an agent page's paths stay text).
- Tests never touch the real home folder or `~/.claude`; e2e tests never take the machine's window focus. Builds and e2e runs go through the shared lock: `node .superpowers/shared-lock.cjs "npm run build"`, then `node .superpowers/shared-lock.cjs "node scripts/e2e.mjs --workers=2 <specs>"` (scripts/e2e.mjs does not build).
- Implementers do not commit; the controller commits. Never commit `out/`, `dist/`, `resources/hook/*.js`, `resources/mcp/*.js`.

## Review Focus

- A file Claude names before it writes it in the same turn: the text becomes a link when the turn ends (Task 5, `a path Claude names before the file is written becomes a link when the turn ends`).
- A path that streams in pieces (the tail is drawn again every frame): links come once the text settles, and the partial tokens do not flood main (Task 5, the first test streams its answer in 6 chunks).
- GitHub-style `#L12` targets and `:12-20` ranges that Claude writes: they open at line 12 (Task 1 `linkPath`/`splitLine` tests, Task 2 `[src/a.ts](src/a.ts#L12)`).
- A linked file deleted before the click: a toast says so and nothing opens (Task 3, `a file that is gone says so and opens nothing`).
- A network path `\\server\share\x.md`: never stat'ed, so an unreachable server cannot stall main's file system threads (Task 3, `FileLinks` test asserts `isFile` is never called with it).

---

### Task 1: The shape of a path (shared)

**Files:**
- Create: `src/shared/chat-paths.ts`
- Test: `tests/unit/chat-paths.test.ts`

**Interfaces:**
- Produces (all exported from `src/shared/chat-paths.ts`; no `node:` imports, the window imports it):
  - `interface PathRef { path: string; line: number | null }`
  - `interface PathMatch { start: number; end: number; ref: PathRef }`
  - `interface FileLink { path: string; file: string; kind: 'doc' | 'file'; line: number | null }` — `path` is the text the window sent, `file` the absolute file.
  - `const MAX_FILE_LINKS = 200`
  - `splitLine(text: string): PathRef`
  - `findPaths(text: string): PathMatch[]`
  - `linkPath(target: string): PathRef | null`
  - `pathRefText(ref: PathRef): string` — `path`, or `path:line`.

- [ ] **Step 1: Write the failing tests** in `tests/unit/chat-paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { findPaths, linkPath, pathRefText, splitLine } from '../../src/shared/chat-paths'

/** each path found: its text, its path and its line */
const found = (text: string) => findPaths(text).map((m) => [text.slice(m.start, m.end), m.ref.path, m.ref.line])

describe('findPaths', () => {
  it('finds a path in a dot folder', () => {
    const p = '.superpowers/sdd/2026-11-12-hub-fade-material-swap-design.md'
    expect(found(`see ${p} now`)).toEqual([[p, p, null]])
  })
  it('finds relative, ./, ../ and ~/ paths', () => {
    expect(found('src/main/index.ts ./run.md ../up/x.md ~/notes/a.md')).toEqual([
      ['src/main/index.ts', 'src/main/index.ts', null], ['./run.md', './run.md', null],
      ['../up/x.md', '../up/x.md', null], ['~/notes/a.md', '~/notes/a.md', null]
    ])
  })
  it('finds Windows and POSIX absolute paths', () => {
    expect(found('D:\\Work\\notes.md, C:/Users/x.md and /usr/lib/x.so')).toEqual([
      ['D:\\Work\\notes.md', 'D:\\Work\\notes.md', null], ['C:/Users/x.md', 'C:/Users/x.md', null], ['/usr/lib/x.so', '/usr/lib/x.so', null]
    ])
  })
  it('keeps a :line, :line:col or :line-line suffix, the first number as the line', () => {
    expect(found('at src/main/index.ts:120 and src/a.ts:12:5 or src/b.ts:7-9')).toEqual([
      ['src/main/index.ts:120', 'src/main/index.ts', 120], ['src/a.ts:12:5', 'src/a.ts', 12], ['src/b.ts:7-9', 'src/b.ts', 7]
    ])
  })
  it('leaves surrounding punctuation, quotes and backticks out', () => {
    expect(found('(src/a.ts), "src/b.ts". [src/c.ts]; src/d.ts:4: \'src/e.ts\' `src/f.ts:3`').map(([text]) => text))
      .toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts:4', 'src/e.ts', 'src/f.ts:3'])
  })
  it('says where each path is in the text', () => {
    expect(findPaths('(src/a.ts)')).toEqual([{ start: 1, end: 9, ref: { path: 'src/a.ts', line: null } }])
  })
  it('a URL is not a path', () => {
    expect(found('https://x.dev/a.md file:///c/a.md mailto:me@x.dev/a.md')).toEqual([])
  })
  it('a word with a dot, a version, a fraction, a folder, a glob and a dotfile are not paths', () => {
    expect(found('node.js e.g. v1.2.3 README.md and/or 1/2.5 docs/ src/**/*.ts src/.env')).toEqual([])
  })
})

describe('splitLine', () => {
  it('splits a :line, :line:col or :line-line suffix off; a drive letter stays', () => {
    expect(splitLine('src/a.ts:12')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(splitLine('src/a.ts:12:5')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(splitLine('src/a.ts:12-20')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(splitLine('C:\\Work\\notes.md')).toEqual({ path: 'C:\\Work\\notes.md', line: null })
    expect(splitLine('C:\\Work\\a.ts:7')).toEqual({ path: 'C:\\Work\\a.ts', line: 7 })
    expect(splitLine('src/a.ts:0')).toEqual({ path: 'src/a.ts', line: null })
  })
})

describe('linkPath', () => {
  it('a link target that names a file is a path, with or without a folder, spaces allowed', () => {
    expect(linkPath('docs/spec.md')).toEqual({ path: 'docs/spec.md', line: null })
    expect(linkPath('README.md')).toEqual({ path: 'README.md', line: null })
    expect(linkPath('my file.md')).toEqual({ path: 'my file.md', line: null })
    expect(linkPath('C:\\x.md')).toEqual({ path: 'C:\\x.md', line: null })
  })
  it('takes the line from :line or a #L fragment, and drops another fragment', () => {
    expect(linkPath('src/a.ts:7')).toEqual({ path: 'src/a.ts', line: 7 })
    expect(linkPath('src/a.ts#L12')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(linkPath('src/a.ts#L12-L20')).toEqual({ path: 'src/a.ts', line: 12 })
    expect(linkPath('docs/spec.md#goals')).toEqual({ path: 'docs/spec.md', line: null })
  })
  it('a web or file address, an anchor, a folder, a name with no extension and a query are not paths', () => {
    for (const t of ['https://x.dev/a.md', 'file:///a.md', 'mailto:a@b.md', '#top', 'docs/', 'Makefile', '', 'a.md?raw=1']) expect(linkPath(t)).toBeNull()
  })
})

describe('pathRefText', () => {
  it('is the path, with its line after a colon', () => {
    expect(pathRefText({ path: 'src/a.ts', line: 12 })).toBe('src/a.ts:12')
    expect(pathRefText({ path: 'docs/spec.md', line: null })).toBe('docs/spec.md')
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/chat-paths.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/chat-paths`.

- [ ] **Step 3: Implement `src/shared/chat-paths.ts`** with the rules of the Global Constraints (shape, link target, suffix), importing `MAX_PATH_TEXT` from `./remote` as the longest token looked at. `splitLine` matches `^(.*?):(\d{1,7})(?:[:-]\d{1,7})?$` (dot-all). `findPaths` walks `/\S+/g`, strips the leading and trailing punctuation sets repeatedly, and checks the core; a private `pathShape(core): PathRef | null` holds the shape rule. `linkPath` splits at the first `#` (a fragment `^L(\d{1,7})(?:-L?\d{1,7})?$` gives the line), then `splitLine`s the rest. A one-line doc comment on each export.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/unit/chat-paths.test.ts` then `npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Report** (no commit: the controller commits)

### Task 2: Pending paths in Claude's Markdown

**Files:**
- Modify: `src/renderer/chat/chat-markdown.ts` (the `md.renderer.rules` block, `chatMarkdownHtml`)
- Test: `tests/unit/chat-markdown.test.ts`

**Interfaces:**
- Consumes: `findPaths`, `linkPath`, `pathRefText` (Task 1).
- Produces: `chatMarkdownHtml(text: string, o?: { paths?: boolean }): string` — with `paths: true`, the pending markup of the Global Constraints; without it, the HTML is exactly as today. `chatMarkdownText` is unchanged.

- [ ] **Step 1: Write the failing tests** — a new `describe` in `tests/unit/chat-markdown.test.ts` (the existing tests stay as they are):

```ts
describe('chatMarkdownHtml with paths', () => {
  it("a path in Claude's text is a pending element that carries the path and its line", () => {
    expect(chatMarkdownHtml('see src/a.ts:12.', { paths: true }))
      .toBe('<p>see <span class="chat-path" data-path="src/a.ts:12">src/a.ts:12</span>.</p>\n')
  })
  it('a path in an inline code span is one too', () => {
    expect(chatMarkdownHtml('`src/main/index.ts:120`', { paths: true }))
      .toBe('<p><code><span class="chat-path" data-path="src/main/index.ts:120">src/main/index.ts:120</span></code></p>\n')
  })
  it('a Markdown link to a path carries the path; its text is not wrapped again', () => {
    expect(chatMarkdownHtml('[spec](docs/spec.md)', { paths: true }))
      .toBe('<p><a class="chat-link chat-path" data-path="docs/spec.md">spec</a></p>\n')
    expect(chatMarkdownHtml('[src/a.ts](src/a.ts#L12)', { paths: true }))
      .toBe('<p><a class="chat-link chat-path" data-path="src/a.ts:12">src/a.ts</a></p>\n')
    expect(chatMarkdownHtml('[x](<my file.md>)', { paths: true }))
      .toBe('<p><a class="chat-link chat-path" data-path="my file.md">x</a></p>\n')
  })
  it('a web link and its text, a code fence and a word with a dot are not paths', () => {
    for (const s of ['see https://x.dev/a/b.md', '[x](https://x.dev/a.md)', '[`src/a.ts`](https://x.dev)', '```\nsrc/a.ts\n```', 'node.js and README.md']) {
      expect(chatMarkdownHtml(s, { paths: true })).not.toContain('chat-path')
    }
  })
  it('a path is escaped in its text and in its attribute', () => {
    const html = chatMarkdownHtml('see src/a&b.ts', { paths: true })
    expect(html).toContain('data-path="src/a&amp;b.ts"')
    expect(html).toContain('>src/a&amp;b.ts</span>')
  })
  it('without the paths option nothing is wrapped', () => {
    expect(chatMarkdownHtml('see src/a.ts and `src/b.ts`')).toBe('<p>see src/a.ts and <code>src/b.ts</code></p>\n')
    expect(chatMarkdownHtml('[a](src/a.ts)')).toBe('<p><a class="chat-link">a</a></p>\n')
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/unit/chat-markdown.test.ts`
Expected: FAIL — the new cases have no `chat-path`.

- [ ] **Step 3: Implement in `src/renderer/chat/chat-markdown.ts`**
  - `chatMarkdownHtml(text, o = {})` renders with the env `{ paths: o.paths === true, links: 0 }`.
  - A private `wrapPaths(text: string, env): string`: the text escaped with `md.utils.escapeHtml`; when `env.paths` and no link is open (`!env.links`), each `findPaths` match becomes `<span class="chat-path" data-path="${escaped pathRefText(ref)}">${escaped matched text}</span>`.
  - `rules.text` returns `wrapPaths(content, env)`; `rules.code_inline` returns `<code${self.renderAttrs(t)}>${wrapPaths(t.content, env)}</code>`.
  - `link_open` counts the open links (`env.links = (env.links ?? 0) + 1`); a new `link_close` counts down and renders the token with `self.renderToken`. In `link_open`, a link that is not openable keeps no `href` as today, and when `env.paths` and `linkPath(md.normalizeLinkText(href))` is not null it gets `class="chat-link chat-path"` and `data-path` = `pathRefText(ref)`, set in that order; any other link keeps `class="chat-link"`.
  - Update the doc comment of `chatMarkdownHtml` to say what `paths` does.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npx vitest run tests/unit/chat-markdown.test.ts` then `npm run typecheck`
Expected: PASS (old and new cases), no type errors.

- [ ] **Step 5: Report** (no commit: the controller commits)

### Task 3: Main resolves and opens a linked file

**Files:**
- Create: `src/main/chat/file-links.ts`
- Modify: `src/main/ipc-guards.ts` (two guards, beside `isLineNo`)
- Test: `tests/unit/file-links.test.ts`, `tests/integration/chat-file-links.int.test.ts`, `tests/unit/ipc-guards.test.ts`

**Interfaces:**
- Consumes: `splitLine`, `FileLink`, `MAX_FILE_LINKS` (Task 1); `docKindOf`, `DocKind` (`src/shared/docs.ts`); `DocCheck` (`src/shared/doc-file.ts`); `pathKey`, `nativePath` (`src/main/path-key.ts`).
- Produces, from `src/main/chat/file-links.ts`:
  - `resolveLinkPath(folder: string, text: string, home: string, path: PlatformPath = nativePath): { file: string; line: number | null } | null` — null for an empty path or a network path.
  - `isRegularFile(path: string): Promise<boolean>` — `stat` (links followed) says a regular file; false on any error.
  - `interface FileLinkDeps { isFile(path: string): Promise<boolean>; home: string }`
  - `const MAX_LINKED = 10_000` — the files remembered per tab; the oldest goes first.
  - `class FileLinks { constructor(d: FileLinkDeps, path: PlatformPath = nativePath); resolve(tabId: string, folder: string, texts: readonly string[]): Promise<FileLink[]>; linked(tabId: string, file: string): boolean; removeTab(tabId: string): void }` — `resolve` answers one entry per distinct text that is a file, in the order given (`kind: 'doc'` when `docKindOf(file) !== null`), and remembers each answered file for the tab by `pathKey(file, path)`.
  - `interface OpenFileDeps { isFile(path: string): Promise<boolean>; checkDoc(path: string): Promise<DocCheck>; htmlRefused(path: string): boolean; showDoc(tabId: string, file: string, kind: DocKind): void; edit(file: string, line: number): void; toast(message: string): void }`
  - `openFileLink(tabId: string, file: string, line: number | null, d: OpenFileDeps): Promise<void>`
- Produces, from `src/main/ipc-guards.ts`: `isFileLinkPaths(v: unknown): v is string[]` (an array of at most `MAX_FILE_LINKS` strings of 1 to `MAX_PATH_TEXT` characters, none with a control character) and `isOptionalLineNo(v: unknown): v is number | null` (null or `isLineNo`).

- [ ] **Step 1: Write the failing unit tests** in `tests/unit/file-links.test.ts`:

```ts
import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileLinks, openFileLink, resolveLinkPath, type OpenFileDeps } from '../../src/main/chat/file-links'
import { pathKey } from '../../src/main/path-key'
import type { DocCheck } from '../../src/shared/doc-file'

describe('resolveLinkPath', () => {
  it('on Windows: relative with / or \\, ./ and ../, absolute, ~, and a line', () => {
    const r = (t: string) => resolveLinkPath('C:\\proj', t, 'C:\\Users\\me', win32)
    expect(r('src/a.ts:12')).toEqual({ file: 'C:\\proj\\src\\a.ts', line: 12 })
    expect(r('src\\a.ts')).toEqual({ file: 'C:\\proj\\src\\a.ts', line: null })
    expect(r('./x/y.md')).toEqual({ file: 'C:\\proj\\x\\y.md', line: null })
    expect(r('../up/x.md')).toEqual({ file: 'C:\\up\\x.md', line: null })
    expect(r('D:\\Work\\notes.md')).toEqual({ file: 'D:\\Work\\notes.md', line: null })
    expect(r('D:/Work/notes.md:3')).toEqual({ file: 'D:\\Work\\notes.md', line: 3 })
    expect(r('~/notes/a.md')).toEqual({ file: 'C:\\Users\\me\\notes\\a.md', line: null })
    expect(r('~\\a.md')).toEqual({ file: 'C:\\Users\\me\\a.md', line: null })
  })
  it('on Linux and macOS: relative, absolute and ~', () => {
    const r = (t: string) => resolveLinkPath('/proj', t, '/home/me', posix)
    expect(r('.superpowers/sdd/plan.md')).toEqual({ file: '/proj/.superpowers/sdd/plan.md', line: null })
    expect(r('/usr/lib/x.so:4:2')).toEqual({ file: '/usr/lib/x.so', line: 4 })
    expect(r('~/a.md')).toEqual({ file: '/home/me/a.md', line: null })
  })
  it('a network path and an empty one resolve to nothing', () => {
    expect(resolveLinkPath('C:\\proj', '\\\\server\\share\\n.md', 'C:\\Users\\me', win32)).toBeNull()
    expect(resolveLinkPath('/proj', '//server/share/n.md', '/home/me', posix)).toBeNull()
    expect(resolveLinkPath('/proj', '', '/home/me', posix)).toBeNull()
  })
})

describe('FileLinks', () => {
  const make = () => {
    const files = new Set(['C:\\proj\\docs\\spec.md', 'C:\\proj\\src\\a.ts'].map((f) => pathKey(f, win32)))
    const asked: string[] = []
    const links = new FileLinks({ isFile: async (p) => { asked.push(p); return files.has(pathKey(p, win32)) }, home: 'C:\\Users\\me' }, win32)
    return { links, asked }
  }
  it('answers the paths that are files, once each, in the order given, with their kind and line; a network path is never looked at', async () => {
    const { links, asked } = make()
    expect(await links.resolve('t', 'C:\\proj', ['docs/spec.md', 'src/a.ts:12', 'missing/x.md', 'src/a.ts:12', '\\\\server\\share\\n.md'])).toEqual([
      { path: 'docs/spec.md', file: 'C:\\proj\\docs\\spec.md', kind: 'doc', line: null },
      { path: 'src/a.ts:12', file: 'C:\\proj\\src\\a.ts', kind: 'file', line: 12 }
    ])
    expect(asked.some((p) => p.startsWith('\\\\'))).toBe(false)
  })
  it('linked: only a file an answer of the same tab named, compared as pathKey; removeTab forgets', async () => {
    const { links } = make()
    await links.resolve('t', 'C:\\proj', ['src/a.ts', 'missing/x.md'])
    expect(links.linked('t', 'c:\\PROJ\\SRC\\A.TS')).toBe(true)
    expect(links.linked('t', 'C:\\proj\\missing\\x.md')).toBe(false)
    expect(links.linked('t2', 'C:\\proj\\src\\a.ts')).toBe(false)
    links.removeTab('t')
    expect(links.linked('t', 'C:\\proj\\src\\a.ts')).toBe(false)
  })
  it('on Linux, linked keeps the case', async () => {
    const links = new FileLinks({ isFile: async () => true, home: '/home/me' }, posix)
    await links.resolve('t', '/proj', ['src/a.ts'])
    expect(links.linked('t', '/proj/src/a.ts')).toBe(true)
    expect(links.linked('t', '/PROJ/SRC/A.TS')).toBe(false)
  })
})

describe('openFileLink', () => {
  const deps = (o: { file?: boolean; doc?: DocCheck; refused?: boolean } = {}) => {
    const calls: string[] = []
    const d: OpenFileDeps = {
      isFile: async () => o.file ?? true,
      checkDoc: async () => o.doc ?? { ok: true, kind: 'markdown', size: 10 },
      htmlRefused: () => o.refused ?? false,
      showDoc: (tabId, file, kind) => { calls.push(`doc ${tabId} ${file} ${kind}`) },
      edit: (file, line) => { calls.push(`edit ${file} ${line}`) },
      toast: (m) => { calls.push(`toast ${m}`) }
    }
    return { d, calls }
  }
  it('a document opens in the Docs panel', async () => {
    const { d, calls } = deps()
    await openFileLink('t', '/p/docs/spec.md', 3, d)
    expect(calls).toEqual(['doc t /p/docs/spec.md markdown'])
  })
  it('another file opens in the editor at its line, at line 1 without one', async () => {
    const { d, calls } = deps()
    await openFileLink('t', '/p/src/a.ts', 12, d)
    await openFileLink('t', '/p/src/b.ts', null, d)
    expect(calls).toEqual(['edit /p/src/a.ts 12', 'edit /p/src/b.ts 1'])
  })
  it('a document the Docs panel refuses opens in the editor', async () => {
    const big = deps({ doc: { ok: false, error: 'the document is larger than 5 MB: /p/big.md' } })
    await openFileLink('t', '/p/big.md', null, big.d)
    expect(big.calls).toEqual(['edit /p/big.md 1'])
    const home = deps({ doc: { ok: true, kind: 'html', size: 1 }, refused: true })
    await openFileLink('t', '/p/index.html', null, home.d)
    expect(home.calls).toEqual(['edit /p/index.html 1'])
  })
  it('a file that is gone says so and opens nothing', async () => {
    const { d, calls } = deps({ file: false })
    await openFileLink('t', '/p/gone.md', null, d)
    expect(calls).toEqual(['toast File not found: /p/gone.md'])
  })
})
```

And in `tests/unit/ipc-guards.test.ts` (add both names to its import):

```ts
it('isFileLinkPaths accepts at most 200 path texts of 1 to 4096 characters, each on one line', () => {
  for (const v of [[], ['src/a.ts:12', 'C:\\x.md'], Array(200).fill('a/b.md')]) expect(isFileLinkPaths(v)).toBe(true)
  for (const v of [Array(201).fill('a/b.md'), [''], ['x'.repeat(4097)], ['a\nb.md'], [42], 'a/b.md', null, undefined]) expect(isFileLinkPaths(v)).toBe(false)
})

it('isOptionalLineNo accepts null or a line number', () => {
  for (const v of [null, 1, 12]) expect(isOptionalLineNo(v)).toBe(true)
  for (const v of [0, -1, 1.5, '12', undefined]) expect(isOptionalLineNo(v)).toBe(false)
})
```

- [ ] **Step 2: Write the failing integration test** in `tests/integration/chat-file-links.int.test.ts`, against a real temp folder. Setup, in a `beforeAll`: `root = mkdtempSync(join(tmpdir(), 'ct-links-long-folder-'))` (a long name has an 8.3 short name on Windows), `folder = join(root, 'work')` with `src/a.ts`, `docs/spec.md` and a folder `dir.md`; `home = join(root, 'home')` with `notes/n.md`; `links = new FileLinks({ isFile: isRegularFile, home })`.

```ts
it('relative, absolute and ~ paths that are files are links; a missing file and a folder are not', async () => {
  expect(await links.resolve('t', folder, ['src/a.ts:12', join(folder, 'docs', 'spec.md'), '~/notes/n.md', 'missing/file.md', 'dir.md'])).toEqual([
    { path: 'src/a.ts:12', file: join(folder, 'src', 'a.ts'), kind: 'file', line: 12 },
    { path: join(folder, 'docs', 'spec.md'), file: join(folder, 'docs', 'spec.md'), kind: 'doc', line: null },
    { path: '~/notes/n.md', file: join(home, 'notes', 'n.md'), kind: 'doc', line: null }
  ])
})

it('a path through a junction or a symbolic link to a folder is a link', async () => {
  symlinkSync(join(folder, 'src'), join(folder, 'via'), process.platform === 'win32' ? 'junction' : 'dir')
  expect((await links.resolve('t', folder, ['via/a.ts'])).map((l) => l.file)).toEqual([join(folder, 'via', 'a.ts')])
})

it.runIf(process.platform === 'win32')('on Windows, / and \\ name the same file, case does not matter, and linked compares as pathKey', async () => {
  const r = await links.resolve('t', folder, ['src\\a.ts', 'SRC/A.TS'])
  expect(r.map((l) => l.file)).toEqual([join(folder, 'src', 'a.ts'), join(folder, 'SRC', 'A.TS')])
  expect(links.linked('t', join(folder, 'src', 'a.ts').toUpperCase())).toBe(true)
})

it.runIf(process.platform === 'win32')('on Windows, a tab folder named by its 8.3 short name resolves its paths', async () => {
  // a volume without short names gives the long name, and the test still runs; verbatim: cmd reads its quotes as they are
  const short = spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${folder}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim()
  const r = await links.resolve('t', short, ['src/a.ts'])
  expect(r.map((l) => l.path)).toEqual(['src/a.ts'])
  expect(links.linked('t', r[0]!.file)).toBe(true)
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run tests/unit/file-links.test.ts tests/unit/ipc-guards.test.ts tests/integration/chat-file-links.int.test.ts`
Expected: FAIL — `../../src/main/chat/file-links` cannot be resolved; `isFileLinkPaths` is not exported.

- [ ] **Step 4: Implement `src/main/chat/file-links.ts` and the two guards**
  - `resolveLinkPath`: `splitLine(text)`; a path starting with `\\` or `//` (either slash) or an empty path is null; `~`, `~/…`, `~\…` join the home folder with the rest; otherwise `path.resolve(folder, p)`.
  - `FileLinks.resolve`: distinct texts in order, each resolved; the `isFile` checks run together (`Promise.all`); every answered file is remembered in the tab's `Set` of `pathKey`s, the oldest dropped past `MAX_LINKED`.
  - `openFileLink`: not `isFile` → `toast(`File not found: ${file}`)`; `docKindOf(file) !== null` → `checkDoc`, and when it is ok and not (`kind === 'html'` and `htmlRefused(file)`) → `showDoc(tabId, file, check.kind)`; everything else → `edit(file, line ?? 1)`.
  - Comments in the style of `src/main/doc-hub.ts` (one line per export, saying what and why).

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run tests/unit/file-links.test.ts tests/unit/ipc-guards.test.ts tests/integration/chat-file-links.int.test.ts` then `npm run typecheck`
Expected: PASS (the Windows-only cases run on Windows), no type errors.

- [ ] **Step 6: Report** (no commit: the controller commits)

### Task 4: The IPC calls `chatFileLinks` and `chatOpenFile`

**Files:**
- Modify: `src/shared/ipc.ts` (channels after `chatFiles: 'chat:files'`; `CtApi` members after `chatFiles(...)`; import `FileLink` from `./chat-paths`)
- Modify: `src/preload/index.ts` (after `chatFiles: ...`)
- Modify: `src/main/index.ts` (imports; `const fileLinks = new FileLinks(...)` right after `const docs = new DocHub(...)`; `fileLinks.removeTab(tabId)` right after `docs.removeTab(tabId)`; both handlers right after the `IPC.chatFiles` handler)
- Modify: `tests/e2e/chat-helpers.ts` (`launchChatTab` option `review`)
- Create: `tests/e2e/chat-file-links.spec.ts`

**Interfaces:**
- Consumes: `FileLink` (Task 1); `FileLinks`, `isRegularFile`, `openFileLink`, `OpenFileDeps`, `isFileLinkPaths`, `isOptionalLineNo` (Task 3).
- Produces:
  - `IPC.chatFileLinks = 'chat:file-links'` (invoke), `IPC.chatOpenFile = 'chat:open-file'` (send).
  - `CtApi.chatFileLinks(tabId: string, paths: string[]): Promise<FileLink[]>` — the paths that are files of a local Claude tab; `[]` for any other tab or bad arguments.
  - `CtApi.chatOpenFile(tabId: string, file: string, line: number | null): void` — opens a file an answer named (a document in Docs, another file in the editor).
  - `launchChatTab(script, { …, review?: object })` — settings gain `review: o.review` when given.
  - In `tests/e2e/chat-file-links.spec.ts`: `standInEditor(): { command: string; runs(): string[][] }` and `project(): string` (below), for Task 5.

- [ ] **Step 1: Add the helper option, the helpers and the failing e2e test.** In `launchChatTab`'s options add `review?: object` and spread `...(o.review ? { review: o.review } : {})` into its settings. Then `tests/e2e/chat-file-links.spec.ts`:

```ts
import { expect, test } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchChatTab } from './chat-helpers'

/** a stand-in editor: each run appends `<file>\t<line>` as a line; the test never starts a real editor */
function standInEditor(): { command: string; runs(): string[][] } {
  const dir = mkdtempSync(join(tmpdir(), 'ct-editor-'))
  const script = join(dir, 'editor.js')
  const record = join(dir, 'runs.txt')
  writeFileSync(script, `require('fs').appendFileSync(${JSON.stringify(record)}, process.argv.slice(2).join('\\t') + '\\n')\n`)
  return {
    command: `node "${script}" {file} {line}`,
    runs: () => (existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter((l) => l !== '').map((l) => l.split('\t')) : [])
  }
}

/** a work folder with source files and Markdown documents */
function project(): string {
  const work = mkdtempSync(join(tmpdir(), 'ct-links-'))
  for (const dir of ['src', 'docs', join('.superpowers', 'sdd')]) mkdirSync(join(work, dir), { recursive: true })
  writeFileSync(join(work, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(work, 'src', 'b.ts'), 'export const b = 2\n')
  writeFileSync(join(work, 'docs', 'spec.md'), '# Spec\n\nBody.\n')
  writeFileSync(join(work, '.superpowers', 'sdd', 'plan.md'), '# The plan\n\nSteps.\n')
  writeFileSync(join(work, 'notes.md'), '# Notes\n')
  return work
}

test('main answers the paths that are files of a local Claude tab, and opens only a file it answered', async () => {
  const editor = standInEditor()
  const work = project()
  const { app, page, tabId } = await launchChatTab({ turns: {} }, { work, review: { editor: editor.command } })
  try {
    const ask = (id: unknown, paths: unknown) => page.evaluate(({ id, paths }) => window.ct.chatFileLinks(id as string, paths as string[]), { id, paths })
    const open = (file: string, line: number | null) => page.evaluate(({ id, file, line }) => window.ct.chatOpenFile(id, file, line), { id: tabId, file, line })
    const answer = await ask(tabId, ['src/a.ts:12', 'docs/spec.md', 'missing/file.md', 'src'])
    expect(answer.map((l) => [l.path, l.kind, l.line])).toEqual([['src/a.ts:12', 'file', 12], ['docs/spec.md', 'doc', null]])
    expect(realpathSync.native(answer[0]!.file)).toBe(realpathSync.native(join(work, 'src', 'a.ts')))
    // what is not a local Claude tab's list of at most 200 paths is refused
    expect(await ask('no-such-tab', ['src/a.ts'])).toEqual([])
    expect(await ask(tabId, Array(201).fill('src/a.ts'))).toEqual([])
    expect(await ask(tabId, [42])).toEqual([])
    expect(await ask(tabId, 'src/a.ts')).toEqual([])
    // a file no answer named is not opened; one that was opens in the editor at its line
    await open(join(work, 'src', 'b.ts'), 3)
    await open(answer[0]!.file, 12)
    await expect.poll(() => editor.runs().length).toBe(1)
    await page.waitForTimeout(500)
    expect(editor.runs()).toEqual([[answer[0]!.file, '12']])
    // a document opens in the Docs panel
    await open(answer[1]!.file, null)
    await expect(page.locator('.panel-title')).toHaveText('Docs')
    await expect(page.locator('.doc-md h1')).toHaveText('Spec')
  } finally {
    await app.close()
  }
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `node .superpowers/shared-lock.cjs "npm run build"` then `node .superpowers/shared-lock.cjs "node scripts/e2e.mjs --workers=2 chat-file-links.spec.ts"`
Expected: FAIL — `window.ct.chatFileLinks is not a function` (the typecheck fails the same way until Step 3).

- [ ] **Step 3: Implement the channels, the API, the preload calls and the handlers**
  - `src/preload/index.ts`: `chatFileLinks` → `ipcRenderer.invoke(IPC.chatFileLinks, tabId, paths)`; `chatOpenFile` → `ipcRenderer.send(IPC.chatOpenFile, tabId, file, line)`.
  - `src/main/index.ts`: `const fileLinks = new FileLinks({ isFile: isRegularFile, home: homedir() })`. `IPC.chatFileLinks` handler: the tab is `isLocalClaudeTab(tabId) ? tabs.get(tabId) : null`; no tab or `!isFileLinkPaths(paths)` → `[]`; else `fileLinks.resolve(tab.id, tab.folder, paths)`. `IPC.chatOpenFile` (`ipcMain.on`): only when `isLocalClaudeTab(tabId) && isAbsPath(file) && isOptionalLineNo(line) && fileLinks.linked(tabId, file)`, then `void openFileLink(tabId, file, line, openLinkDeps)` with `isFile: isRegularFile`, `checkDoc: checkDocFile`, `htmlRefused: (f) => htmlFolderRefused(f, homedir())`, `showDoc: (id, f, kind) => { docs.show(id, f, null, kind) }`, `edit` as the Global Constraints' `launchEditor` call (it reads `settings` when it runs), `toast`. A one-line comment above each handler, as its neighbours have.

- [ ] **Step 4: Run the typecheck, the build and the e2e test**

Run: `npm run typecheck`, then `node .superpowers/shared-lock.cjs "npm run build"`, then `node .superpowers/shared-lock.cjs "node scripts/e2e.mjs --workers=2 chat-file-links.spec.ts"`
Expected: no type errors; 1 passed.

- [ ] **Step 5: Report** (no commit: the controller commits)

### Task 5: The links in the chat

**Files:**
- Create: `src/renderer/chat/file-linker.ts`
- Modify: `src/renderer/chat/chat-markdown.ts` (`markdownClick`)
- Modify: `src/renderer/chat/chat-items.ts` (`ItemCallbacks.openFile`; `textNode` and `streamText` render with `{ paths: true }`)
- Modify: `src/renderer/chat/chat-view.ts` (`ChatViewOptions`, `this.cb`, the linker, `reconcile`, `apply` case `'state'`, `dispose`)
- Modify: `src/renderer/main.ts` (`makeChat`)
- Modify: `src/renderer/chat/chat.css` (after the `.chat-text a:not([href])` rule)
- Test: `tests/e2e/chat-file-links.spec.ts`

**Interfaces:**
- Consumes: `chatMarkdownHtml(text, { paths: true })` (Task 2); `FileLink`, `MAX_FILE_LINKS` (Task 1); `CtApi.chatFileLinks`, `CtApi.chatOpenFile`, `launchChatTab`'s `review`, `standInEditor`, `project` (Task 4).
- Produces:
  - `const ASK_DELAY_MS = 250` and `class FileLinker { constructor(root: HTMLElement, resolve: (paths: string[]) => Promise<FileLink[]>); scan(): void; recheck(): void; dispose(): void }` in `src/renderer/chat/file-linker.ts`.
  - `ItemCallbacks.openFile(file: string, line: number | null): void`; `markdownClick`'s callbacks gain an optional `openFile?(file: string, line: number | null): void`.
  - `ChatViewOptions.fileLinks: ((paths: string[]) => Promise<FileLink[]>) | null` (null on a remote tab) and `ChatViewOptions.openFile(file: string, line: number | null): void`.

- [ ] **Step 1: Write the failing e2e tests** in `tests/e2e/chat-file-links.spec.ts` (import `sendMessage` from `./chat-helpers` too):

```ts
test('paths in an answer that are files are links: a document opens in Docs, another file in the editor at its line; a missing one stays text', async () => {
  const editor = standInEditor()
  const work = project()
  const { app, page } = await launchChatTab({ turns: { files: [{ text: 'Read .superpowers/sdd/plan.md, then `src/a.ts:12`, [the notes](notes.md) and missing/file.md.', chunks: 6, pace: 60 }] } }, { work, review: { editor: editor.command } })
  try {
    await sendMessage(page, 'files')
    const links = page.locator('.chat-text .chat-file-link')
    await expect(links).toHaveText(['.superpowers/sdd/plan.md', 'src/a.ts:12', 'the notes'])
    await expect(page.locator('.chat-text')).toContainText('missing/file.md')
    await expect(links.nth(0)).toHaveCSS('cursor', 'pointer')
    await expect(links.nth(0)).toHaveAttribute('title', /^Open .*plan\.md in Docs$/)
    await expect(links.nth(1)).toHaveAttribute('title', /^Open .*a\.ts:12 in the editor$/)
    await links.nth(0).click()
    await expect(page.locator('.panel-title')).toHaveText('Docs')
    await expect(page.locator('.doc-md h1')).toHaveText('The plan')
    await links.nth(1).click()
    await expect.poll(() => editor.runs().length).toBe(1)
    const [file, line] = editor.runs()[0]!
    expect(realpathSync.native(file!)).toBe(realpathSync.native(join(work, 'src', 'a.ts')))
    expect(line).toBe('12')
  } finally {
    await app.close()
  }
})

test('a path Claude names before the file is written becomes a link when the turn ends', async () => {
  const work = project()
  const { app, page, config } = await launchChatTab({ turns: { later: [{ text: 'I will write notes/later.md next.' }, { gate: 'write' }, { text: 'Written.' }] } }, { work })
  try {
    await sendMessage(page, 'later')
    // main was asked while the file is missing: the path stays text
    await expect(page.locator('.chat-text .chat-path[data-link="none"]')).toHaveText(['notes/later.md'])
    mkdirSync(join(work, 'notes'))
    writeFileSync(join(work, 'notes', 'later.md'), '# Later\n')
    writeFileSync(join(config, 'write'), '')
    await expect(page.locator('.chat-text', { hasText: 'Written.' })).toHaveCount(1)
    await expect(page.locator('.chat-text .chat-file-link')).toHaveText(['notes/later.md'])
  } finally {
    await app.close()
  }
})

test('an answer naming more paths than one request carries links them all', async () => {
  const work = project()
  mkdirSync(join(work, 'f'))
  const names = Array.from({ length: 205 }, (_, i) => `f/${i}.md`)
  for (const name of names) writeFileSync(join(work, name), '# x\n')
  const { app, page } = await launchChatTab({ turns: { many: [{ text: names.join(' ') }] } }, { work })
  try {
    await sendMessage(page, 'many')
    await expect(page.locator('.chat-text .chat-file-link')).toHaveCount(205)
  } finally {
    await app.close()
  }
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `node .superpowers/shared-lock.cjs "npm run build"` then `node .superpowers/shared-lock.cjs "node scripts/e2e.mjs --workers=2 chat-file-links.spec.ts"`
Expected: the three new tests FAIL (no `.chat-file-link`); Task 4's test passes.

- [ ] **Step 3: Implement `FileLinker` in `src/renderer/chat/file-linker.ts`.** It holds a cache `Map<string, FileLink | null>` by path text, the texts in flight, one timer, and a disposed flag:
  - `scan()`: (re)starts the `ASK_DELAY_MS` timer (a debounce: a streaming text asks once it pauses or settles); the timer runs `ask()`.
  - `ask()`: first applies the cache to every `.chat-path` under the root whose `data-link` is not `file` or `none`; then the elements with no `data-link`: a text in flight marks its element `asked`; the other texts, at most `MAX_FILE_LINKS` distinct ones, are sent in one `resolve` call and their elements marked `asked`. Its answer caches each text sent (the link, or null), then `ask()` runs again (it applies the answers and sends the next batch, if any). A failed call caches nothing and marks its elements `none`. Nothing happens after `dispose()`.
  - Applying null sets `data-link="none"`; applying a link sets `data-link="file"`, class `chat-file-link`, `data-file`, `data-line` (only with a line) and the title of the Global Constraints (`kind === 'doc'` → `Open ${file} in Docs`).
  - `recheck()`: drops the null entries of the cache, removes `data-link` from the elements marked `none`, and calls `scan()`.
  - `dispose()`: clears the timer and sets the flag.

- [ ] **Step 4: Wire it in**
  - `chat-markdown.ts` `markdownClick`: before the `closest('a')` branch, a `.chat-file-link` with a `data-file` under the target, when `cb.openFile` is given, prevents the default and calls `cb.openFile(file, data-line as a number, or null)`, then returns. The doc comment says so.
  - `chat-items.ts`: `ItemCallbacks.openFile` with a doc comment; `textNode` and both `chatMarkdownHtml` calls in `streamText` pass `{ paths: true }`.
  - `chat-view.ts`: the two options (doc comments: null on a remote tab, whose files are on its device); `this.cb.openFile` → `o.openFile`; `private readonly links: FileLinker | null`, made in the constructor over `this.column` when `o.fileLinks` is not null; `this.links?.scan()` at the end of `reconcile()` (every drawing path ends there); in `apply`'s `'state'` case, when the turn was not `'idle'` and the new one is, `this.links?.recheck()` after the state is taken (comment: Claude may have written the files since); `this.links?.dispose()` in `dispose()`.
  - `main.ts` `makeChat`: `fileLinks: remote ? null : (paths) => ct.chatFileLinks(tabId, paths)` and `openFile: (file, line) => ct.chatOpenFile(tabId, file, line)`, with a one-line comment.
  - `chat.css`, after `.chat-text a:not([href])`:

```css
/* a path Claude wrote that is a file of the tab: a link, with or without an address */
.chat-text .chat-file-link,
.chat-text a.chat-file-link:not([href]) {
  color: var(--blue);
  cursor: pointer;
}

.chat-text .chat-file-link:hover {
  text-decoration: underline;
}
```

- [ ] **Step 5: Run the typecheck, the unit tests, the build and the e2e tests**

Run: `npm run typecheck`, `npm test`, then `node .superpowers/shared-lock.cjs "npm run build"`, then `node .superpowers/shared-lock.cjs "node scripts/e2e.mjs --workers=2 chat-file-links.spec.ts chat-conversation.spec.ts chat-cards.spec.ts chat-heads-up.spec.ts docs.spec.ts"`
Expected: no type errors; all unit and integration tests pass; every listed spec passes (`chat-conversation.spec.ts`'s `a link opens in the browser, a file link does not` still passes: its `notes.md` does not exist, so it stays text).

- [ ] **Step 6: Report** (no commit: the controller commits)
