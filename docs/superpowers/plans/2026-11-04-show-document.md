# show_document Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `show_document` MCP tool that opens a Markdown, PDF or HTML file in a new **Docs** tab of the side panel; Markdown is formatted and can be commented on and sent back to Claude like the Changes panel.

**Architecture:** The MCP tool checks the file and sends a `show_document` pipe message; main keeps each Claude tab's documents in a `DocHub` and pushes `DocsUpdate`s to the renderer; files reach the window only through a new privileged `ctdoc://<docId>/<path>` scheme with per-kind rules; the renderer's `DocPanel` draws Markdown with the Changes panel's markdown-it setup and comment helpers, and PDF/HTML in iframes.

**Tech Stack:** Electron 44, TypeScript (strict), markdown-it, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-04-show-document-design.md`

## Global Constraints

- **Do not commit.** The user's global rule: never `git commit` (not even where a skill says to). Leave every change in the working tree.
- Read `AGENTS.md` first; it is the rulebook. Comments, logs and UI strings in English. Match the surrounding code's naming, comment density and idioms. No UI framework in the renderer.
- Existing files use CRLF line endings: keep them (edit with the Edit tool, never rewrite a whole existing file).
- Paths are compared with `pathKey` (`src/main/path-key.ts`), never as raw strings.
- Everything from the pipe and from the renderer is untrusted: validate (`src/shared/protocol.ts`, `src/main/ipc-guards.ts`).
- Tests never touch the real `~/.claude`, `%APPDATA%\ClaudeTerm`, or start the real `claude`; e2e tests use `tests/e2e/helpers.ts` (`launchClaudeTab`, `FAKE_CLAUDE_SETTINGS`).
- A feature's tests are written first and seen failing.
- Exact values from the spec: types `.md`, `.markdown` → `markdown`; `.pdf` → `pdf`; `.html`, `.htm` → `html`. Limits: Markdown 5 MB, HTML 20 MB, PDF 200 MB. Title at most 100 characters. At most 30 documents per tab. Scheme name `ctdoc`. Markdown image extensions `png jpg jpeg gif webp bmp svg`. Live check every 1000 ms. Shortcut Ctrl+Shift+O (⌘O on macOS).
- Exact texts:
  - `show_document works only in a ClaudeTerm Claude tab`
  - `ClaudeTerm is not running; the document is at <abs path>`
  - `Opened <relPath> in the Docs panel. The user can comment on it; their comments come back to you as a message.` (Markdown) / `Opened <relPath> in the Docs panel.` (PDF, HTML)
  - `not a supported document type (md, markdown, pdf, html, htm): <path>`, `file not found: <path>`, `not a file: <path>`, `the document is larger than <N> MB: <path>`
  - Send heading `Comments on <relPath>:`
  - `File not found: <path>` (panel notice)
- Commands: `npm run typecheck`, `npx vitest run <file>`, `npm test`, `npm run build` then `npx playwright test tests/e2e/<file>`.

## Review Focus

1. **File names with spaces, `#`, `%` or non-ASCII letters** — a document `отчёт/my report #1 %.html` must load: `docUrl` encodes each segment and `resolveDocRequest` decodes it back (Task 5 round-trip test).
2. **The document file itself is a symlink or sits behind a junction** — the page must still load: the document's own file is served before the containment check (Task 5 test), and containment compares real paths on both sides.
3. **CRLF Markdown** — lines, quotes and line numbers must not carry `\r` (Task 7 `docLines` test).
4. **The shown document is removed, or its tab closed, while the panel shows it** — the panel switches to the newest remaining document or falls back to Media, never throws (Task 9 e2e).
5. **The same file shown twice with another spelling** (`C:\A\x.md` vs `c:/a/x.md` on Windows) — one entry, moved to the front (Task 4 test).

---

### Task 1: Document types and file checks

**Files:**
- Create: `src/shared/docs.ts` (pure, no Node imports — the renderer imports it)
- Create: `src/shared/doc-file.ts` (uses `node:fs/promises`; main and the MCP server import it)
- Test: `tests/unit/docs.test.ts`, `tests/unit/doc-file.test.ts`

**Interfaces:**
- Produces (`src/shared/docs.ts`):
  - `type DocKind = 'markdown' | 'pdf' | 'html'`
  - `const DOC_TYPES = 'md, markdown, pdf, html, htm'`
  - `const MAX_DOC_BYTES: Record<DocKind, number>` = markdown 5 MiB, html 20 MiB, pdf 200 MiB
  - `const MAX_DOC_TITLE = 100`, `const DOC_SCHEME = 'ctdoc'`
  - `const DOC_IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']`
  - `interface DocInfo { id: string; path: string; relPath: string; name: string; title: string | null; kind: DocKind; url: string }` — `url` is the document's own `ctdoc://` address
  - `interface DocsUpdate { tabId: string; docs: DocInfo[]; reveal: string | null }` — `docs` newest first; `reveal` the id `show_document` just showed
  - `type DocAction = 'open' | 'reveal' | 'copy-path' | 'remove'`, `const DOC_ACTIONS: readonly DocAction[]`
  - `type DocRead = { ok: true; text: string; stamp: string } | { ok: false; error: string }`
  - `function docKindOf(path: string): DocKind | null` — by the extension after the last `/` or `\`, case-insensitive
  - `function docImageUrl(doc: { id: string; url: string }, src: string): string | null` — the `ctdoc://` address of a relative image of a Markdown document
- Produces (`src/shared/doc-file.ts`):
  - `type DocCheck = { ok: true; kind: DocKind; size: number } | { ok: false; error: string }`
  - `function checkDocFile(path: string): Promise<DocCheck>`
  - `function readDocText(path: string): Promise<DocRead>` — Markdown only; strips a leading BOM
  - `function docStamp(path: string): Promise<string | null>` — `` `${mtimeMs}:${size}` `` of a regular file, else null

- [ ] **Step 1: Write the failing tests**

`tests/unit/docs.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { docImageUrl, docKindOf } from '../../src/shared/docs'

describe('docKindOf', () => {
  it('tells the kind by the extension, in any case', () => {
    expect(docKindOf('C:\\a\\Spec.MD')).toBe('markdown')
    expect(docKindOf('/a/b.markdown')).toBe('markdown')
    expect(docKindOf('/a/r.pdf')).toBe('pdf')
    expect(docKindOf('/a/index.HTM')).toBe('html')
    expect(docKindOf('/a/index.html')).toBe('html')
  })
  it('refuses other files, and a dot in a folder name', () => {
    expect(docKindOf('/a/notes.txt')).toBeNull()
    expect(docKindOf('/a.md/readme')).toBeNull()
    expect(docKindOf('C:\\x.pdf\\file')).toBeNull()
  })
})

describe('docImageUrl', () => {
  const doc = { id: '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11', url: 'ctdoc://0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11/docs/specs/x.md' }
  it('resolves a relative address against the document', () => {
    expect(docImageUrl(doc, 'img/a.png')).toBe('ctdoc://0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11/docs/specs/img/a.png')
    expect(docImageUrl(doc, '../../images/shot%201.png')).toBe('ctdoc://0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11/images/shot%201.png')
  })
  it('leaves out addresses with a scheme, absolute ones and fragments', () => {
    for (const src of ['https://x.org/a.png', 'data:image/png;base64,AA', 'file:///C:/a.png', '/abs.png', '\\\\server\\a.png', '#top', '']) {
      expect(docImageUrl(doc, src)).toBeNull()
    }
  })
})
```

`tests/unit/doc-file.test.ts` — files in a `mkdtempSync` folder:

```ts
it('checkDocFile takes Markdown, PDF and HTML files', async () => {
  expect(await checkDocFile(md)).toEqual({ ok: true, kind: 'markdown', size: 8 })   // md = '# Title\n'
})
it('checkDocFile names what is wrong', async () => {
  expect(await checkDocFile(txt)).toEqual({ ok: false, error: `not a supported document type (md, markdown, pdf, html, htm): ${txt}` })
  expect(await checkDocFile(join(dir, 'gone.md'))).toEqual({ ok: false, error: `file not found: ${join(dir, 'gone.md')}` })
  expect(await checkDocFile(folderNamedMd)).toEqual({ ok: false, error: `not a file: ${folderNamedMd}` })   // a folder "x.md"
})
it('checkDocFile refuses a Markdown file over 5 MB', async () => {
  // big.md: 5 * 1024 * 1024 + 1 bytes
  expect(await checkDocFile(big)).toEqual({ ok: false, error: `the document is larger than 5 MB: ${big}` })
})
it('readDocText reads Markdown without its BOM, with the stamp of the file it read', async () => {
  // bom.md = '\uFEFF# T\r\n'
  const r = await readDocText(bom)
  expect(r).toEqual({ ok: true, text: '# T\r\n', stamp: await docStamp(bom) })
})
it('readDocText refuses a PDF', async () => {
  expect(await readDocText(pdf)).toEqual({ ok: false, error: `not a Markdown document: ${pdf}` })
})
it('docStamp changes with the file and is null when it is gone', async () => {
  const before = await docStamp(md)
  writeFileSync(md, '# Title, longer\n')
  expect(await docStamp(md)).not.toBe(before)
  rmSync(md)
  expect(await docStamp(md)).toBeNull()
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/unit/docs.test.ts tests/unit/doc-file.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/shared/docs.ts` and `src/shared/doc-file.ts`**

`docImageUrl`: null for an empty `src`, one starting with `/`, `\` or `#`, or with a scheme (`/^[a-z][a-z0-9+.-]*:/i`); otherwise `new URL(src, doc.url).href` (in `try`; null on a throw) if it starts with `` `${DOC_SCHEME}://${doc.id}/` ``, else null. `checkDocFile` checks the type first, then `stat` (file not found / not a file), then `MAX_DOC_BYTES[kind]` (`N` in the message is `MAX_DOC_BYTES[kind] / 1024 / 1024`). `readDocText` runs `checkDocFile`, refuses a non-Markdown kind with `not a Markdown document: <path>`, reads UTF-8, drops one leading `\uFEFF`; its stamp is made from the same `stat` as the check. Follow `src/shared/image-file.ts` for style.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run tests/unit/docs.test.ts tests/unit/doc-file.test.ts`
Expected: PASS.

---

### Task 2: The show_document pipe message

**Files:**
- Modify: `src/shared/protocol.ts` (message type, union, parser)
- Modify: `src/main/pipe-server.ts` (`PipeHandlers.showDocument`, the `switch`)
- Modify: every handlers object in tests that implements `PipeHandlers` (`tests/integration/pipe.test.ts`, `tests/integration/mcp.int.test.ts`): add `showDocument: async () => ({ ok: true })` (mcp.int.test gets its real stub in Task 3)
- Modify: `src/main/index.ts` — a temporary `showDocument: async () => ({ ok: false, error: 'show_document works only in a ClaudeTerm Claude tab' })` in the `startPipeServer` handlers, replaced in Task 6
- Test: `tests/unit/protocol.test.ts`

**Interfaces:**
- Produces: `interface ShowDocumentMessage { v: 1; type: 'show_document'; tabId: string | null; path: string; title: string | null }` in `src/shared/protocol.ts`; `PipeHandlers.showDocument(msg: ShowDocumentMessage): Promise<PipeResponse>`.

- [ ] **Step 1: Write the failing tests** (in `tests/unit/protocol.test.ts`, following its existing `show_diff` cases)

```ts
describe('show_document', () => {
  const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
  const abs = process.platform === 'win32' ? 'C:\\w\\spec.md' : '/w/spec.md'
  it('parses a message and cuts a long title', () => {
    const r = parsePipeMessage(JSON.stringify({ v: 1, type: 'show_document', tabId: TAB, path: abs, title: 'x'.repeat(150) }))
    expect(r).toEqual({ ok: true, message: { v: 1, type: 'show_document', tabId: TAB, path: abs, title: 'x'.repeat(100) } })
  })
  it('takes no tab and no title as null', () => {
    expect(parsePipeMessage(JSON.stringify({ v: 1, type: 'show_document', path: abs }))).toEqual({ ok: true, message: { v: 1, type: 'show_document', tabId: null, path: abs, title: null } })
  })
  it('refuses a relative path, a tab that is not a UUID and a title that is not a string', () => {
    expect(parsePipeMessage(JSON.stringify({ v: 1, type: 'show_document', tabId: TAB, path: 'spec.md' }))).toEqual({ ok: false, error: 'path must be an absolute path' })
    expect(parsePipeMessage(JSON.stringify({ v: 1, type: 'show_document', tabId: 'x', path: abs }))).toEqual({ ok: false, error: 'tabId must be a UUID or null' })
    expect(parsePipeMessage(JSON.stringify({ v: 1, type: 'show_document', tabId: TAB, path: abs, title: 3 }))).toEqual({ ok: false, error: 'title must be a string or null' })
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/protocol.test.ts`
Expected: FAIL — `unknown message type: show_document`.

- [ ] **Step 3: Implement** the message, its branch in `parsePipeMessage` (the title through the existing `label()`, which cuts at 100 and makes `''` null), the `PipeHandlers` member and the `case 'show_document': return await h.showDocument(m)`; add the stubs listed under **Files** so `npm run typecheck` passes.

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/unit/protocol.test.ts && npm run typecheck`
Expected: PASS, no type errors.

---

### Task 3: The show_document MCP tool

**Files:**
- Create: `src/mcp/show-document-tool.ts`
- Modify: `src/mcp/show-image-server.ts` (register the tool)
- Test: `tests/unit/show-document-tool.test.ts`, `tests/integration/mcp.int.test.ts`

**Interfaces:**
- Consumes: `checkDocFile` (Task 1), `ShowDocumentMessage` (Task 2), `ToolResult` from `src/mcp/show-image-tool.ts`, `PipeUnavailableError` from `src/shared/pipe-client.ts`.
- Produces: `interface ShowDocumentDeps { cwd: string; tabId: string | null; pipeName: string; send(pipeName: string, msg: ShowDocumentMessage): Promise<PipeResponse> }` and `handleShowDocument(input: { path: string; title?: string }, deps: ShowDocumentDeps): Promise<ToolResult>`.

- [ ] **Step 1: Write the failing unit tests** (`tests/unit/show-document-tool.test.ts`, modelled on `tests/unit/show-diff-tool.test.ts`; real temp files)

```ts
it('needs a ClaudeTerm Claude tab', async () => {
  expect(await handleShowDocument({ path: md }, { ...deps, tabId: null })).toEqual({ text: 'show_document works only in a ClaudeTerm Claude tab', isError: true })
})
it('resolves a relative path against its folder and sends the message', async () => {
  const sent: ShowDocumentMessage[] = []
  const r = await handleShowDocument({ path: 'docs/spec.md', title: '  Spec  ' }, { ...deps, cwd: dir, send: async (_p, m) => { sent.push(m); return { ok: true, info: 'Opened docs/spec.md in the Docs panel.' } } })
  expect(sent).toEqual([{ v: 1, type: 'show_document', tabId: TAB, path: join(dir, 'docs', 'spec.md'), title: 'Spec' }])
  expect(r).toEqual({ text: 'Opened docs/spec.md in the Docs panel.', isError: false })
})
it('cuts the title at 100 characters and sends an empty one as null', ...)   // title: 'x'.repeat(120) → 'x'.repeat(100); title: '   ' → null
it('refuses a file of another type without asking ClaudeTerm', ...)          // error text from checkDocFile, send not called
it('says where the document is when ClaudeTerm is not running', async () => {
  const r = await handleShowDocument({ path: md }, { ...deps, send: async () => { throw new PipeUnavailableError('x') } })
  expect(r).toEqual({ text: `ClaudeTerm is not running; the document is at ${md}`, isError: false })
})
it('passes on a refusal of ClaudeTerm as an error', ...)                       // send → { ok: false, error: 'nope' } → { text: 'nope', isError: true }
```

Check `PipeUnavailableError`'s constructor in `src/shared/pipe-client.ts` before writing the throw.

- [ ] **Step 2: Extend the integration test** in `tests/integration/mcp.int.test.ts`: collect `ShowDocumentMessage`s in the pipe stub (`showDocument: async (m) => { docs.push(m); return { ok: true, info: 'Opened out/spec.md in the Docs panel.' } }`), write `out/spec.md` in `beforeAll`, expect the tool list to be `['show_diff', 'show_document', 'show_image']`, and add:

```ts
it('forwards show_document with its path resolved against its folder', async () => {
  // same client setup as the show_diff case
  const res = await client.callTool({ name: 'show_document', arguments: { path: 'out/spec.md' } })
  expect(res.isError).toBeFalsy()
  expect(res.content).toEqual([{ type: 'text', text: 'Opened out/spec.md in the Docs panel.' }])
  expect(docs).toEqual([{ v: 1, type: 'show_document', tabId: TAB, path: join(work, 'out', 'spec.md'), title: null }])
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/unit/show-document-tool.test.ts tests/integration/mcp.int.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement** `handleShowDocument` in this order: tab check; `abs` = `isAbsolute ? path : resolve(cwd, path)`; `checkDocFile(abs)` (its error as `isError: true`); title trimmed, cut to `MAX_DOC_TITLE`, `''` → null; send; `PipeUnavailableError` → the not-running text; another throw → `` `ClaudeTerm request failed: ${message}` `` (as `show_diff`); `res.ok` → `res.info ?? 'Opened in the Docs panel.'`, else `res.error` as an error. Register it in `show-image-server.ts` after `show_diff`: title `Show a document in ClaudeTerm`, the description from the spec's **The tool** section word for word, `inputSchema` `{ path: z.string().describe('Absolute path (preferred) or a path relative to the current working directory'), title: z.string().optional().describe('A short title shown instead of the file name') }`, send timeout 3000 ms.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run tests/unit/show-document-tool.test.ts tests/integration/mcp.int.test.ts`
Expected: PASS.

---

### Task 4: DocHub — each tab's documents

**Files:**
- Create: `src/main/doc-hub.ts`
- Modify: `src/main/path-key.ts` (add `isWithin`)
- Test: `tests/unit/doc-hub.test.ts`, `tests/unit/path-key.test.ts`

**Interfaces:**
- Consumes: `DocInfo`, `DocsUpdate`, `DocKind`, `DOC_SCHEME` (Task 1); `relPathFor` from `src/main/review-sources.ts`; `PipeResponse`.
- Produces:
  - `isWithin(dir: string, path: string, path?: PlatformPath): boolean` in `path-key.ts` — `path` is `dir` or inside it, compared by `pathKey`
  - `interface DocEntry extends DocInfo { tabId: string; root: string }` — `root`: the folder `ctdoc://` paths of this document are relative to
  - `const MAX_DOCS = 30`
  - `function docUrl(id: string, root: string, path: string): string` — `` `ctdoc://${id}/` `` + `relative(root, path)` split on the platform separator, each segment `encodeURIComponent`-ed, joined with `/`
  - `interface DocHubDeps { publish(update: DocsUpdate): void; newId(): string }`
  - `class DocHub { addTab(tabId: string, folder: string, claude: boolean): void; removeTab(tabId: string): void; show(tabId: string | null, path: string, title: string | null, kind: DocKind): PipeResponse; get(docId: string): DocEntry | undefined; remove(docId: string): void }`

Rules for `show`: an unknown or non-Claude tab → `{ ok: false, error: 'show_document works only in a ClaudeTerm Claude tab' }`. A file the tab already has (same `pathKey`) keeps its id, takes the new title and goes to the front; a new one gets `newId()`. `root` = the tab's folder for a Markdown file inside it, else `dirname(path)`. `relPath = relPathFor(folder, path)`, `name = basename(path)`, `url = docUrl(id, root, path)`. Keep at most `MAX_DOCS`, newest first. Publish `{ tabId, docs, reveal: id }` where `docs` are plain `DocInfo` objects (no `tabId`/`root`). Answer `{ ok: true, info }` with the spec's two texts. `remove` drops the entry and publishes `{ tabId, docs, reveal: null }`; `removeTab` forgets silently.

- [ ] **Step 1: Write the failing tests**

```ts
const FOLDER = process.platform === 'win32' ? 'C:\\proj' : '/proj'
const p = (...s: string[]) => join(FOLDER, ...s)
let n = 0
const make = () => { const updates: DocsUpdate[] = []; const hub = new DocHub({ publish: (u) => updates.push(u), newId: () => `id${++n}` }); hub.addTab('t1', FOLDER, true); hub.addTab('sh', FOLDER, false); return { hub, updates } }

it('shows a Markdown file of the tab folder, rooted at the folder', () => {
  const { hub, updates } = make()
  expect(hub.show('t1', p('docs', 'my spec.md'), null, 'markdown')).toEqual({ ok: true, info: 'Opened docs/my spec.md in the Docs panel. The user can comment on it; their comments come back to you as a message.' })
  const d = updates[0]!.docs[0]!
  expect(d).toEqual({ id: d.id, path: p('docs', 'my spec.md'), relPath: 'docs/my spec.md', name: 'my spec.md', title: null, kind: 'markdown', url: `ctdoc://${d.id}/docs/my%20spec.md` })
  expect(updates[0]!.reveal).toBe(d.id)
  expect(hub.get(d.id)?.root).toBe(FOLDER)
})
it('roots an HTML or PDF file, and a file outside the folder, at its own folder', ...)  // p('cov','index.html') → url ctdoc://<id>/index.html, root p('cov'); answer 'Opened cov/index.html in the Docs panel.'
it('the same file again keeps its id, takes the new title and comes first', ...)        // on Windows also with another case and '/' separators
it('keeps the 30 newest', ...)                                                           // show 31 files → 30 docs, the first one gone, get(firstId) undefined
it('refuses a shell tab and an unknown tab', ...)                                        // both → the 'works only' error, nothing published
it('remove drops a document and publishes without reveal; a closed tab forgets its documents', ...)
```

`path-key.test.ts`: `isWithin('C:\\a', 'c:/A/b.md', win32)` true; `isWithin('C:\\a', 'C:\\ab\\x', win32)` false; `isWithin('/a', '/a', posix)` true; `isWithin('/a', '/A/x', posix)` false.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/doc-hub.test.ts tests/unit/path-key.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** `isWithin` and `DocHub` as described.

- [ ] **Step 4: Run to verify they pass** (same command). Expected: PASS.

---

### Task 5: The ctdoc:// scheme and the frame navigation guard

**Files:**
- Create: `src/main/doc-protocol.ts`
- Modify: `src/main/img-protocol.ts` — `registerImgScheme(extra: CustomScheme[] = [])` registers `[ctimg, ...extra]` (Electron allows `registerSchemesAsPrivileged` only once)
- Test: `tests/unit/doc-protocol.test.ts`, `tests/integration/doc-protocol.int.test.ts`

**Interfaces:**
- Consumes: `DocEntry`, `docUrl` (Task 4); `isWithin`, `pathKey`; `DOC_SCHEME`, `DOC_IMAGE_EXTENSIONS` (Task 1).
- Produces:
  - `const DOC_SCHEME_PRIVILEGES: CustomScheme` = `{ scheme: 'ctdoc', privileges: { standard: true, secure: true, supportFetchAPI: true } }`
  - `interface DocFs { realpath(p: string): Promise<string>; isFile(p: string): Promise<boolean> }`, `const nodeDocFs: DocFs`
  - `resolveDocRequest(url: string, find: (id: string) => DocEntry | undefined, fs: DocFs): Promise<{ path: string; doc: DocEntry } | null>`
  - `docResponseHeaders(doc: DocEntry, path: string): Record<string, string>`
  - `frameNavigationAllowed(url: string, known: (id: string) => boolean): boolean`
  - `handleDocProtocol(find: (id: string) => DocEntry | undefined, fs?: DocFs): void`

`resolveDocRequest`:

```
parse url (null on a throw); protocol must be 'ctdoc:'; doc = find(hostname) or null
segments = pathname split on '/', empties dropped, each decodeURIComponent (null on a throw)
null if no segment, or a segment is '.' or '..' or holds '/', '\' or '\0'
target = join(doc.root, ...segments)
the document's own file (pathKey(target) === pathKey(doc.path)): served for pdf and html if fs.isFile(target)
pdf: nothing else
markdown: only DOC_IMAGE_EXTENSIONS (lower-cased extension)
html, markdown: real = realpath(target), realRoot = realpath(doc.root) (null on a throw);
               served as { path: real } if isWithin(realRoot, real) and fs.isFile(real)
```

`docResponseHeaders`: a `Content-Type` from the extension (`pdf` → `application/pdf`, `html`/`htm` → `text/html; charset=utf-8`, `css` → `text/css`, `js`/`mjs` → `text/javascript`, `json` → `application/json`, `svg` → `image/svg+xml`, `png`, `jpg`/`jpeg`, `gif`, `webp`, `bmp` → their `image/*`; none for others); for an HTML document also `Content-Security-Policy: default-src ctdoc://<id> data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'none'; base-uri 'none'` and `Access-Control-Allow-Origin: *`.

`frameNavigationAllowed`: true for `about:blank`, `about:srcdoc`, an address starting with `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/` (Chromium's PDF viewer), and a `ctdoc:` address whose host is a known id; false otherwise (including unparsable).

`handleDocProtocol`: `protocol.handle('ctdoc', …)` — 404 `not found` when unresolved; else `net.fetch(pathToFileURL(path))`, copy its headers, set `docResponseHeaders`, return a new `Response` with its body and status. Follow `img-protocol.ts`.

- [ ] **Step 1: Write the failing unit tests** (`doc-protocol.test.ts`, a fake `DocFs` over a `Set` of files and a `Map` of links; entries built by hand with `docUrl`)

```ts
it('serves a PDF document its own file only', ...)        // ctdoc://id/r.pdf → the file; ctdoc://id/other.pdf → null
it('serves an HTML report the files under its folder', ...) // ctdoc://id/index.html, ctdoc://id/assets/app.js → served
it('refuses what leads out of the folder', ...)              // a fake link root/up → parent: ctdoc://id/up/secret.txt → null; '%2e%2e' segment, '%5c' segment, '%00' → null
it('serves the document itself even when it is a link to elsewhere', ...)   // doc.path is a fake link to /elsewhere/r.html → served
it('serves a Markdown document image files under its root only', ...)       // images/a.png served; notes.txt under root → null; images/a.PNG served
it('round-trips names with spaces, # and % and non-ASCII letters', async () => {
  // doc at join(root, 'отчёт', 'my report #1 %.html'); url = docUrl(id, root, path)
  expect(await resolveDocRequest(entry.url, find, fs)).toEqual({ path: entry.path, doc: entry })
})
it('refuses an unknown id, another scheme and garbage', ...)
it('frameNavigationAllowed lets frames go to documents and the PDF viewer only', ...)
  // true: about:blank, ctdoc://<known>/x.html, chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html
  // false: ctdoc://<unknown>/x, https://example.com/, file:///C:/x, javascript:alert(1), 'nonsense'
it('docResponseHeaders keeps an HTML report to its own document', ...)       // CSP and ACAO exact; a PDF gets only Content-Type application/pdf
```

- [ ] **Step 2: Write the failing integration test** (`doc-protocol.int.test.ts`, real disk with `nodeDocFs`): a temp folder with `report/index.html`, `secret.txt`, and a junction (`symlinkSync(target, link, 'junction')`; a directory symlink elsewhere) `report/up` → the temp folder. `ctdoc://id/index.html` resolves; `ctdoc://id/up/secret.txt` is null; a root given by its 8.3 / non-real spelling (`realpathSync` vs `tmpdir()`, which differ on macOS and on the Windows CI runner) still serves `index.html`.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/unit/doc-protocol.test.ts tests/integration/doc-protocol.int.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement** `doc-protocol.ts` and the `registerImgScheme(extra)` change (its existing test in `tests/unit/img-protocol.test.ts` must still pass).

- [ ] **Step 5: Run to verify they pass** (same command, then `npx vitest run tests/unit/img-protocol.test.ts`). Expected: PASS.

---

### Task 6: Main wiring, IPC and the bridge

**Files:**
- Modify: `src/shared/ipc.ts` — channels `docsRead: 'docs:read'`, `docsStamp: 'docs:stamp'`, `docsAction: 'docs:action'`, `docsOpenEditor: 'docs:open-editor'`, `evDocs: 'ev:docs'`; `CtApi` members below
- Modify: `src/preload/index.ts`
- Modify: `src/main/ipc-guards.ts` — `isDocAction`
- Modify: `src/main/index.ts`
- Test: `tests/unit/ipc-guards.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 4, 5.
- Produces (`CtApi`):
  - `readDoc(docId: string): Promise<DocRead>`
  - `docStamp(docId: string): Promise<string | null>`
  - `docAction(docId: string, action: DocAction): void`
  - `openDocInEditor(docId: string, line: number): void`
  - `onDocs(cb: (update: DocsUpdate) => void): Unsubscribe`
  - `isDocAction(v: unknown): v is DocAction` in `ipc-guards.ts`

Main (`src/main/index.ts`):
- `registerImgScheme([DOC_SCHEME_PRIVILEGES])` where `registerImgScheme()` is called now; `handleDocProtocol((id) => docs.get(id))` next to `handleImgProtocol`.
- `const docs = new DocHub({ publish: (u) => send(IPC.evDocs, u), newId: () => randomUUID() })` near `review`; `docs.addTab(tab.id, tab.cwd, tab.kind === 'claude')` in `startTabImages`; `docs.removeTab(tabId)` in `onTabClosed`.
- Pipe handler (replaces Task 2's stub): `checkDocFile(msg.path)`; its error as `{ ok: false, error }`; else `docs.show(msg.tabId, msg.path, msg.title, check.kind)`.
- `ipcMain.handle(IPC.docsRead, …)`: an unknown id → `{ ok: false, error: 'unknown document' }`, else `readDocText(doc.path)`.
- `ipcMain.handle(IPC.docsStamp, …)`: unknown → null, else `docStamp(doc.path)`.
- `ipcMain.on(IPC.docsAction, …)`: `open` → `shell.openPath(path)`, a non-empty answer toasted; `reveal` → `revealInFolder(path, nodeRevealDeps(...))` as `IPC.reviewReveal` does; `copy-path` → `clipboard.writeText(path)`; `remove` → `docs.remove(id)`.
- `ipcMain.on(IPC.docsOpenEditor, …)`: a known Markdown document and `isLineNo(line)` → `launchEditor(settings.review.editor, path, line, …)` with the same deps as `IPC.reviewOpenEditor`.
- `win.webContents.on('will-frame-navigate', (e) => { if (!e.isMainFrame && !frameNavigationAllowed(e.url, (id) => docs.get(id) !== undefined)) e.preventDefault() })` next to the `will-navigate` handler.

- [ ] **Step 1: Write the failing test** in `tests/unit/ipc-guards.test.ts`: `isDocAction` is true for `'open'`, `'reveal'`, `'copy-path'`, `'remove'` and false for `'copy-image'`, `''`, `1`, `null`.

- [ ] **Step 2: Run to verify it fails**: `npx vitest run tests/unit/ipc-guards.test.ts` → FAIL.

- [ ] **Step 3: Implement** the guard, the channels, the bridge and the main wiring above.

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/unit/ipc-guards.test.ts && npm run typecheck && npm test`
Expected: PASS, no type errors. (The wiring's behavior is proven by the e2e tests of Tasks 9–11.)

---

### Task 7: Shared Markdown and comment helpers for documents

**Files:**
- Modify: `src/renderer/markdown-diff.ts`
- Modify: `src/renderer/review-comments.ts`
- Create: `src/renderer/doc-lines.ts`
- Test: `tests/unit/markdown-diff.test.ts`, `tests/unit/review-comments.test.ts`, `tests/unit/doc-lines.test.ts`

**Interfaces:**
- Produces:
  - `interface MdEnv { imageUrl?(src: string): string | null }` and `markdownSegments(lines: ReviewLine[], env: MdEnv = {}): MdSegment[]` in `markdown-diff.ts`. The image rule: when `env.imageUrl(src)` gives an address, `<img class="md-img" src="<escaped address>" alt="<escaped text>" title="<escaped src>">`; otherwise the `md-image` span as today. Every `md.render`/`md.parse` call gets a fresh `{ ...env }` (markdown-it writes into env).
  - `interface CommentFile { path: string; relPath: string; note: ReviewFileNote | null; hunks: { lines: ReviewLine[] }[] }` in `review-comments.ts`; `anchorOf`, `locate`, `moveAnchor`, `reanchorComment` take `CommentFile`/`CommentFile[]` instead of `ReviewFile` (`ReviewFile` still fits).
  - `formatDocMessage(relPath: string, comments: ReviewComment[]): string` — `` `Comments on ${relPath}:` ``, an empty line, then the same numbered blocks as `formatSendMessage` (move the block-building into one shared function both use).
  - `docLines(text: string): ReviewLine[]` in `doc-lines.ts` — one `context` line per line (`/\r?\n/`), `oldNo = newNo = index + 1`, without the empty line after a final newline; `''` → `[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// doc-lines.test.ts
it('makes numbered context lines without \\r', () => {
  expect(docLines('# T\r\n\r\nBody\r\n')).toEqual([
    { kind: 'context', text: '# T', oldNo: 1, newNo: 1 },
    { kind: 'context', text: '', oldNo: 2, newNo: 2 },
    { kind: 'context', text: 'Body', oldNo: 3, newNo: 3 }
  ])
  expect(docLines('a')).toEqual([{ kind: 'context', text: 'a', oldNo: 1, newNo: 1 }])
  expect(docLines('')).toEqual([])
})
it('a document is formatted as unchanged blocks', () => {
  expect(markdownSegments(docLines('# T\n\nBody\n')).map((s) => [s.kind, s.from, s.to])).toEqual([['same', 0, 0], ['same', 2, 2]])
})

// markdown-diff.test.ts
it('shows an image the env gives an address for', () => {
  const [seg] = markdownSegments(docLines('![shot](img/a.png)\n'), { imageUrl: (src) => (src === 'img/a.png' ? 'ctdoc://id/img/a.png' : null) })
  expect(seg!.html).toContain('<img class="md-img" src="ctdoc://id/img/a.png" alt="shot" title="img/a.png">')
})
it('without an address an image stays text', ...)   // imageUrl → null: html contains 'class="md-image"', no '<img'

// review-comments.test.ts
it('formatDocMessage heads the comments with the document', () => {
  const lines = docLines('# Spec\n\nBody text.\n')
  const file = { path: '/p/notes/spec.md', relPath: 'notes/spec.md', note: null, hunks: [{ lines }] }
  const c = { id: 'c1', anchor: anchorOf(file, lines.slice(2, 3), 'doc:x'), text: 'Clarify this', outdated: false }
  expect(formatDocMessage('notes/spec.md', [c])).toBe('Comments on notes/spec.md:\n\n1. notes/spec.md:3\n   > Body text.\n   Clarify this')
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/doc-lines.test.ts tests/unit/markdown-diff.test.ts tests/unit/review-comments.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the three changes; `formatSendMessage`'s output must not change (its existing tests prove it).

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/unit/doc-lines.test.ts tests/unit/markdown-diff.test.ts tests/unit/review-comments.test.ts && npm run typecheck`
Expected: PASS.

---

### Task 8: Docs in the side panel, the tab bar and the keymap

**Files:**
- Modify: `src/renderer/side-panel.ts`
- Modify: `src/renderer/review-panel.ts` (`panel.tools.append(...)` → `panel.tools.changes.append(...)`)
- Modify: `src/renderer/tabbar.ts`
- Modify: `src/renderer/keymap.ts`
- Modify: `src/renderer/main.ts` (only: the `SidePanel` widths get `docs: settings.review.width`; `runAction` `case 'toggleDocs': sidePanel.toggle('docs'); break`; the tab bar callback `toggleDocs` like `toggleChanges`; `refreshPanelButtons` calls `tabBar.setDocs(false, sidePanel.isShowing('docs'))` — Task 9 gives it the real availability)
- Modify: `src/renderer/index.html` (CSP: `img-src 'self' ctimg: ctdoc: data:` and add `frame-src ctdoc:`)
- Modify: `src/renderer/styles.css` (`.panel-tool-group { display: flex; gap: 2px; align-items: center; } .panel-tool-group[hidden] { display: none; }`)
- Modify: `tests/e2e/helpers.ts` (`KEYS.docs`: `'Control+Shift+KeyO'` / `'Meta+KeyO'`; `KEY_LABELS.docs`: `'Ctrl+Shift+O'` / `'⌘O'`)
- Test: `tests/unit/keymap.test.ts`

**Interfaces:**
- Produces:
  - `type PanelTab = 'images' | 'changes' | 'docs'`; `SidePanel.tools: Record<PanelTab, HTMLElement>` — one `span.panel-tool-group` per tab inside the existing `.panel-tools` box; the box is hidden while the current tab's group is empty-by-design (`images`), and only the current tab's group shows.
  - Docs: label `Docs`, max share 0.85, not available at start; `setExpanded(true)` works for `changes` and `docs`; `open(tab)` keeps an expanded panel only when switching between those two.
  - `setAvailable(tab, false)` on the current tab falls back to the first available tab of `['images', 'changes', 'docs']` other than it (`images` is always available).
  - `TabBarCallbacks.toggleDocs(): void`; `TabBar.setDocs(available: boolean, visible: boolean): void` — a `tab-docs-toggle` button, no badge, right after the Changes button in the bar, title `` `Docs (${shortcutLabel('toggleDocs', platform)})` ``, hidden unless available, `active` while visible, a document icon in the style of the others (16×16 `viewBox`, stroke `currentColor`, e.g. a page with three text lines).
  - `KeyAction` `{ type: 'toggleDocs' }`; `LABELS.toggleDocs = ['Ctrl+Shift+O', '⌘O']`; `KeyO` with Ctrl+Shift (Windows, Linux) and with ⌘ alone (macOS).

- [ ] **Step 1: Write the failing keymap tests** (in `tests/unit/keymap.test.ts`, like the `toggleChanges` cases): Ctrl+Shift+KeyO → `{ type: 'toggleDocs' }` on `win32` and `linux`; Meta+KeyO → `{ type: 'toggleDocs' }` on `darwin`; `shortcutLabel('toggleDocs', 'win32')` = `'Ctrl+Shift+O'`, `'darwin'` = `'⌘O'`.

- [ ] **Step 2: Run to verify they fail**: `npx vitest run tests/unit/keymap.test.ts` → FAIL.

- [ ] **Step 3: Implement** the list above.

- [ ] **Step 4: Verify nothing that exists broke**

Run: `npx vitest run tests/unit/keymap.test.ts && npm run typecheck && npm run build && npx playwright test tests/e2e/side-panel.spec.ts tests/e2e/review.spec.ts tests/e2e/images.spec.ts`
Expected: PASS (the Docs button stays hidden; Media and Changes behave as before).

---

### Task 9: The Docs panel — showing documents

**Files:**
- Create: `src/renderer/doc-panel.ts`
- Modify: `src/renderer/main.ts`
- Modify: `src/renderer/styles.css`
- Create: `tests/e2e/docs.spec.ts`

**Interfaces:**
- Consumes: `SidePanel` (Task 8), `DocsUpdate`/`DocInfo`/`DocRead`/`DocAction`/`docImageUrl` (Task 1), `CtApi` (Task 6), `markdownSegments`/`MdEnv` and `docLines` (Task 7), `showMenu` (`src/renderer/menu.ts`).
- Produces:
  - `interface DocPanelCallbacks { read(docId: string): Promise<DocRead>; stamp(docId: string): Promise<string | null>; action(docId: string, action: DocAction): void; openEditor(docId: string, line: number): void; copyText(text: string): void; openLink(url: string): void; send(tabId: string, message: string): Promise<string | null> }`
  - `class DocPanel { constructor(root: HTMLElement, panel: SidePanel, cb: DocPanelCallbacks, platform: string); show(update: DocsUpdate): void; panelChanged(): void }` — `show` takes the active tab's list; when `update.reveal` is set it selects that document.

Panel layout: `root` = `div.panel-notice` (hidden when empty), `div.doc-content` (scrolls), `div.review-footer` (Task 10). Tools in `panel.tools.docs`: `select.doc-select` (one `option` per document, value = id, text = title or name, `title` = relPath), `button.doc-more` `⋯` (title `More`), `button.doc-expand` `⤢` (title `Expand`, toggles `panel.setExpanded`). The ⋯ menu (`showMenu`): `Open in default app` → `open`, `Show in Explorer` → `reveal`, `Copy path` → `copy-path`, `Remove from list` → `remove`. Per tab the panel remembers the selected id; a selection no longer in the list falls back to the newest. A Markdown document: `cb.read(id)` → on `ok`, `div.review-md.doc-md` holding one `div.md-seg same` per `markdownSegments(docLines(text), { imageUrl: (src) => docImageUrl(doc, src) })` segment, each with `span.review-plus.md-plus` (Task 10 wires it) and `div.md-body` (`innerHTML` = the segment's HTML — markdown-it with raw HTML off, as in Changes); on an error, the notice shows it. A click on `.doc-md a` never navigates: `http(s)` → `cb.openLink`. A read that comes back after the selection changed is dropped.

`main.ts`: `docUpdates = new Map<string, DocsUpdate>()`, `pendingDocReveal = new Map<string, string>()`; `ct.onDocs(u)` stores it, remembers `u.reveal` for its tab, and for the active tab: `docPanel.show(u)`, `sidePanel.setAvailable('docs', u.docs.length > 0)`, a pending reveal → `sidePanel.open('docs')`; `refreshPanelButtons` → `tabBar.setDocs(claude && hasDocs, sidePanel.isShowing('docs'))`; tab activation does the same with the stored update (an empty `{ tabId, docs: [], reveal: null }` for none), the pending reveal included; `sidePanel.onChange` also calls `docPanel.panelChanged()`.

- [ ] **Step 1: Write the failing e2e tests** (`tests/e2e/docs.spec.ts`; reuse the `reviewTab`-style setup from `tests/e2e/review.spec.ts`: `launchClaudeTab()` in a temp folder, then a `session` pipe message so Send can work in Task 10; `stubShell`/`shellCalls` as in review.spec)

```ts
const show = (pipeName: string, tabId: string, path: string, title: string | null = null) =>
  sendPipeMessage(pipeName, { v: 1, type: 'show_document', tabId, path, title })

test('show_document opens Docs with the formatted document; the button and Ctrl+Shift+O toggle it', async () => {
  // work/notes/spec.md = '# Spec\n\nBody text.\n'
  expect(await show(pipeName, tabId, spec)).toEqual({ ok: true, info: 'Opened notes/spec.md in the Docs panel. The user can comment on it; their comments come back to you as a message.' })
  await expect(panelTitle(page)).toHaveText('Docs')
  await expect(page.locator('.doc-md h1')).toHaveText('Spec')
  await expect(docsTab(page)).toHaveClass(/active/)
  await expect(docsTab(page)).toHaveAttribute('title', `Docs (${KEY_LABELS.docs})`)
  await page.keyboard.press(KEYS.docs)
  await expect(panel(page)).toHaveClass(/collapsed/)
  await docsTab(page).click()
  await expect(page.locator('.doc-md h1')).toHaveText('Spec')
})
test('show_document refuses a file of another type', ...)        // notes.txt → { ok: false, error: `not a supported document type (md, markdown, pdf, html, htm): ${txt}` }
test('two documents switch in the selector; the menu acts on the one shown; Remove from list drops it', async () => {
  // show a.md then b.md (title 'Bee'); options ['Bee', 'a.md']; b shown; selectOption(a's id) shows a's heading
  // ⋯ → Show in Explorer → shellCalls ['show ' + a]; ⋯ → Open in default app → ['show ' + a, 'open ' + a]
  // ⋯ → Remove from list → one option left, b shown; remove b → Docs button hidden, panel title 'Media'
})
test('a document shown in a tab behind shows when the tab comes to the front; a shell tab has no Docs button', async () => {
  // open a shell tab (KEYS.newTab), show_document for the Claude tab: the shell tab's panel stays as it was and the Docs button is hidden
  // window.ct.activateTab(claudeTabId) → panel title 'Docs', the document's heading shown
})
```

- [ ] **Step 2: Build and run to verify they fail**

Run: `npm run build && npx playwright test tests/e2e/docs.spec.ts`
Expected: FAIL (no Docs panel).

- [ ] **Step 3: Implement** `DocPanel` (display part), the `main.ts` wiring and the styles (`.doc-content { flex: 1; min-height: 0; overflow: auto; }`, `.doc-select { max-width: 220px; … }` in the look of the panel's other controls, `.md-body img.md-img { max-width: 100%; }`).

- [ ] **Step 4: Run to verify they pass**

Run: `npm run build && npx playwright test tests/e2e/docs.spec.ts`
Expected: PASS.

---

### Task 10: Comments on Markdown documents and Send

**Files:**
- Modify: `src/renderer/doc-panel.ts`
- Modify: `tests/e2e/docs.spec.ts`

**Interfaces:**
- Consumes: `anchorOf`, `locate`, `reanchorComment`, `describeLines`, `location`, `attemptSend`, `draftAfterSend`, `formatDocMessage`, `ReviewComment`, `CommentAnchor` (Task 7 / `review-comments.ts`); `segmentOf` (`markdown-diff.ts`).

Behavior, as the formatted Markdown of the Changes panel (`renderMarkdown`, `renderDraft`, `renderComment`, `saveDraft`, `sendAll`, `renderFooter` in `src/renderer/review-panel.ts` — same classes, same keys, same texts): mousedown on a block's `+` starts a drag over blocks, mouseup opens a draft for the blocks covered (`.md-seg.selected` while dragging); the draft (`textarea.review-comment-input`, placeholder `Comment for Claude`, buttons `Cancel` / `Add comment`, Ctrl+Enter or ⌘Enter saves, Esc cancels) and each comment (`.review-comment` with `Edit` / `Delete`, meta `` `${relPath} · ${describeLines(anchor)}` ``, `· outdated` when outdated) show under the block holding their last line (`segmentOf`); comments that cannot be located show after the last block. Right-click a block: `Comment`, `` `Open in editor at line ${from + 1}` `` → `cb.openEditor(id, from + 1)`, `Copy path:line` → `cb.copyText(location(anchor))`. Comments and the draft are kept per tab and per document id, with `viewKey` `` `doc:${id}` ``; a document that leaves the list takes its comments with it. Footer (Markdown only): `span.review-count` `` `${n} comment${n === 1 ? '' : 's'}` `` or the last Send error, `button.review-send` `Send to Claude`, disabled with no comments or while sending; Send → `attemptSend(() => cb.send(tabId, formatDocMessage(doc.relPath, comments)))`; success clears the comments and keeps a draft being typed (`draftAfterSend`).

`main.ts`: `send: (id, message) => sendToClaude(id, message)`, `openEditor: (id, line) => ct.openDocInEditor(id, line)`, `copyText: (t) => ct.writeClipboardText(t)`.

- [ ] **Step 1: Write the failing e2e tests**

```ts
test('a comment on a block is sent to Claude as one message followed by Enter', async () => {
  // spec.md = '# Spec\n\nBody text.\n'
  const row = page.locator('.doc-md .md-seg').nth(1)
  await row.hover()
  await row.locator('.md-plus').click()
  await page.locator('.review-comment-input').fill('Clarify this')
  await page.locator('.review-btn.primary').click()
  await expect(page.locator('.review-count')).toHaveText('1 comment')
  await page.locator('.review-send').click()
  await expect(page.locator('.review-count')).toHaveText('0 comments')
  const sent = (await page.evaluate((id) => window.__ct!.ptyInput!(id), tabId)).replace(/\x1b\[20[01]~/g, '')
  expect(sent).toContain('Comments on notes/spec.md:\r\r1. notes/spec.md:3\r   > Body text.\r   Clarify this\r')
})
test('right-click a block opens the document at its line, and copies path:line', ...)
  // no review.editor: 'Open in editor at line 3' → shellCalls ['show ' + spec]; the menu items are ['Comment', 'Open in editor at line 3', 'Copy path:line']
test('comments are kept per document', ...)   // comment on a.md, switch to b.md: '0 comments'; back to a.md: '1 comment'
```

- [ ] **Step 2: Run to verify they fail**: `npm run build && npx playwright test tests/e2e/docs.spec.ts` → the new tests FAIL.

- [ ] **Step 3: Implement** the comments, the menu and the footer.

- [ ] **Step 4: Run to verify they pass**: same command → PASS.

---

### Task 11: PDF, HTML, images and live updates

**Files:**
- Modify: `src/renderer/doc-panel.ts`
- Modify: `src/renderer/styles.css` (`.doc-frame { flex: 1; width: 100%; height: 100%; border: 0; background: #fff; }`, the content box a flex column when it holds a frame)
- Modify: `tests/e2e/docs.spec.ts`
- Create: `tests/fixtures/docs/` — `report/index.html`, `report/app.js`, `report/page2.html`, a one-page `sample.pdf` (a minimal hand-written PDF with the text `HELLO PDF` is enough), `shot.png` (any small valid PNG)

**Interfaces:**
- Consumes: Task 9's panel; `cb.stamp`.

Behavior: a PDF document is `iframe.doc-frame` with `src` = `doc.url`; an HTML document is `iframe.doc-frame` with `sandbox="allow-scripts"` and `src` = `doc.url`. While Docs is shown with a document (`panel.isShowing('docs')`), a 1000 ms timer asks `cb.stamp(id)`; the first answer is remembered (a Markdown read's own `stamp` counts as one); a different non-null stamp redraws: Markdown is read again and drawn with its comments moved by `reanchorComment(c, [file], samePath)` and the scroll position kept; a frame gets `src` = `` `${doc.url}?v=${encodeURIComponent(stamp)}` ``. A null stamp shows the notice `File not found: <path>` and keeps what is drawn; the next non-null stamp clears it and redraws. The timer stops when Docs is hidden, the tab changes or the panel shows nothing (`panelChanged`, `show`).

Fixtures: `index.html` holds `<h1 id="t">Report</h1><a id="next" href="page2.html">next</a> <a id="out" href="https://example.invalid/">out</a><script src="app.js"></script>`; `app.js`:

```js
let parentReach = 'open'
try { void window.parent.ct; parentReach = typeof window.parent.ct === 'undefined' ? 'hidden' : 'open' } catch { parentReach = 'blocked' }
document.getElementById('t').textContent = 'Report ready · parent ' + parentReach
```

`page2.html` holds `<h1>Page 2</h1>`.

- [ ] **Step 1: Write the failing e2e tests**

```ts
test('a change of the Markdown file shows in the panel, and a comment follows its line', async () => {
  // comment 'Clarify this' on 'Body text.'; write '# Spec v2\n\nIntro.\n\nBody text.\n'
  await expect(page.locator('.doc-md h1')).toHaveText('Spec v2')
  await expect(page.locator('.review-comment-meta')).toHaveText('notes/spec.md · Line 5')
})
test('a deleted document says so above its last content, and comes back', ...)   // rm → '.panel-notice' 'File not found: <spec>' and h1 still shown; write again → notice hidden
test('a relative image of a Markdown document loads', async () => {
  // work/notes/img/shot.png (copied from fixtures), spec.md = '![shot](img/shot.png)\n'
  await expect.poll(() => page.locator('.doc-md img.md-img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0)
})
test('a PDF document loads in the PDF viewer', async () => {
  expect(await show(pipeName, tabId, pdf)).toEqual({ ok: true, info: 'Opened sample.pdf in the Docs panel.' })
  await expect(page.locator('iframe.doc-frame')).toHaveAttribute('src', /^ctdoc:\/\//)
  await expect.poll(() => page.frames().some((f) => f.url().startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/'))).toBe(true)
})
test('an HTML report runs its script in a sandboxed frame; its own links work, a link out goes nowhere', async () => {
  // copy fixtures/docs/report to work/cov; show cov/index.html
  const frame = page.frameLocator('iframe.doc-frame')
  await expect(page.locator('iframe.doc-frame')).toHaveAttribute('sandbox', 'allow-scripts')
  await expect(frame.locator('#t')).toHaveText('Report ready · parent blocked')
  await frame.locator('#out').click()
  await page.waitForTimeout(1000)
  await expect(frame.locator('#t')).toHaveText('Report ready · parent blocked')
  await frame.locator('#next').click()
  await expect(frame.locator('h1')).toHaveText('Page 2')
})
```

- [ ] **Step 2: Run to verify they fail**: `npm run build && npx playwright test tests/e2e/docs.spec.ts` → the new tests FAIL.

- [ ] **Step 3: Implement** the frames, the live timer and the fixtures.

- [ ] **Step 4: Run to verify they pass**: same command → PASS.

---

### Task 12: README and the full check

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** In `README.md`: the MCP registration paragraph (around line 151) names `show_image`, `show_diff` and `show_document`; the mermaid diagram's label (around line 257) `"MCP: show_image"` becomes `"MCP: show_image, show_diff, show_document"` only if the diagram lists tools — otherwise leave it; add a short **Docs** section after the Changes panel section, in the README's voice: Claude shows a Markdown, PDF or HTML file with `show_document` ("show me the spec"), the Docs button and Ctrl+Shift+O (⌘O), comments and Send to Claude on Markdown, PDF in the built-in viewer, HTML reports in a sandboxed frame that cannot reach the network, the panel follows changes of the file. No screenshot.

- [ ] **Step 2: Run everything**

Run: `npm run typecheck && npm test && npm run test:e2e`
Expected: all green. Report the counts; do not commit.
