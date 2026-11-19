# Built-in browser for Claude tabs: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Browser tab in the right-hand side panel of every local Claude tab. Claude drives it through new `browser_*` tools of the bundled `claudeterm` MCP server, under per-site permission. The browser has profiles of its own, and cookies can be imported into a profile from installed browsers.

**Architecture:** The MCP server validates each call and sends one `browser` pipe message to main. Main owns one `TabBrowser` per Claude tab: its pages are `WebContentsView`s in a persistent partition of the tab's profile, laid over the panel body. Main drives each page with `webContents.debugger` (CDP) behind a `SiteGate`. Cookie import copies the source profile, runs the real browser on the copy with `--remote-debugging-pipe`, reads `Storage.getCookies` and writes the cookies into the target partition. Firefox's `cookies.sqlite` is read with `node:sqlite`.

**Tech Stack:** Electron 44.5 (Chromium 152, Node 24.21), TypeScript (strict), `node:sqlite`, `@modelcontextprotocol/sdk`, zod, Vitest, Playwright for Electron. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-17-builtin-browser-design.md`. Read it before any task: it is the source of every behaviour and every UI string below.

## Global Constraints

- **No git commits.** The person's global rule: leave all changes uncommitted, and never run `git commit`, `git stash` or `git push`. Each task ends by listing the files it changed.
- Work only in the worktree `D:\Workspace\ClaudeTerm\.claude\worktrees\feat-builtin-browser`. Never touch the main checkout `D:\Workspace\ClaudeTerm`, nor other worktrees. If a build, a lock or a shared file collides with another agent's work, stop and report it to the controller. Do not work around it.
- Follow AGENTS.md: match the surrounding code, strict TypeScript (`noUnusedLocals`), English comments, logs and UI strings, keep the file's existing line endings, and run git only through `execGit` (not needed here).
- **No cookie name or value ever goes into a log, an error message, an MCP result, a test fixture or a snapshot.** Fixtures use invented names and values like `sid` / `test-value-1`.
- **Tests never read a real browser profile, never start a real browser and never touch the real `~/.claude` or `%APPDATA%\ClaudeTerm`.** Everything is built under `tmpdir()`. The only exception is the opt-in `CLAUDETERM_REAL_BROWSER_TEST=1` test (Task 15).
- Pages run in `WebContentsView`s with `partition: partitionOf(profileId)`, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `backgroundThrottling: false`, `disableDialogs: true` (added 2026-11-18), no preload. ClaudeTerm's `ctimg://` / `ctdoc://` handlers are never registered in a browser partition.
- Allowed page URL schemes: `http:`, `https:`, `file:`, and the URL `about:blank`. Everything else is refused.
- Every IPC argument from a renderer is checked in `src/main/ipc-guards.ts`. Every pipe message is checked in `src/shared/protocol.ts`.
- The main process must not block: CDP calls are async, every command has a time limit (navigation 60 s, other commands 30 s, site permission 600 s), and import runs async with its own limit (120 s once the browser is closed).
- Values pinned by the spec: `SITE_ANSWER_MS = 600_000`, ring buffers of 500 console messages and 500 requests per page, `SNAPSHOT_LIMIT = 60_000` characters, `browser_wait_for` at most 60 s, the "Claude is using the browser" line shown while a command runs and for 5 s after it, navigations a command causes held while it runs and for 3 s after it, session cookies imported with an expiry 30 days from now.
- UI strings (English, exact):
  - panel line: `Claude is using the browser`, `Stop`, `You have control`, `Hand back to Claude`;
  - card: `Claude wants to open <site>` / `Claude wants to use <site>`, `Allow in this tab`, `Always allow`, `Deny`;
  - profile switch (added 2026-11-19): `Always allow all sites`, and the warning line `Claude opens any website in this profile without asking, signed in with its cookies.`;
  - empty state: `Claude can open pages here, or type an address above.`;
  - import: `Import cookies…`, `Close <Browser> to continue. The import starts as soon as it is closed.`, `If it keeps running in the background, quit it from the tray icon.`, `Imported <N> cookies for <M> sites.` (each number on its own: `1 cookie`, `1 site`, the plural otherwise; so `Imported 1 cookie for 1 site.`; final 2026-11-19), `Sites that keep their sign-in outside cookies need you to sign in again here.`, `Google sign-ins are not carried over: <Browser> ties them to this computer.` (the source browser: Chrome, Edge, Brave, and Vivaldi/Chromium where it applies; 2026-11-19);
  - the sheet shows `importing` (spinner and Cancel) from the start of a copy or a Firefox read, not only once the cookies are read (2026-11-19);
  - live import (Windows Chrome/Edge/Brave, added 2026-11-18): source label `<Browser> · open profiles`; `<Browser> opened its remote debugging page. Turn on remote debugging there; the import goes on by itself.`; `Allow the connection in <Browser>.`; `Which <Browser> profile?`; `To import another profile, open a window of it in <Browser>.`; profile label `<N> tabs: <title>, <title>, <title>` (`1 tab: …`; titles of http(s) pages, each cut to 30 characters, at most 3; `<N> tabs` alone when none); `You can turn remote debugging off again on the same page.`; `Open a window of the profile in <Browser> first.`; `<Browser> did not offer a connection. Check that remote debugging is on.`; `The connection was not allowed in <Browser>.` (the person pressed Deny: the import stops, no retry); `<Browser> did not answer. Try the import again.`; `Cancelled. <N> cookies were already imported.` (a cancel after some were written; `Cancelled. 1 cookie was already imported.` for one); `The cookies were added, but saving them to disk failed; they may be gone after ClaudeTerm restarts.`; `This browser is no longer available.`
- Messages to Claude (exact):
  - `The browser works only in a ClaudeTerm Claude tab.`, `ClaudeTerm is not running; the browser is not available.`;
  - `The person did not allow <site>.`, `The person did not answer about <site>. Let them know you are waiting for the Browser panel in ClaudeTerm.`;
  - `The person took control of the browser. Ask them before using it again.`, `Stopped by the person.`;
  - `The page changed; take a new snapshot.`; footer line `- Dialog: <type> "<message>" → <OK|Cancel|closed>` (changed 2026-11-18: no dialog is ever open, so there is no "A dialog is open" error);
  - a page whose `beforeunload` guard asks "Leave site?" is left: ClaudeTerm answers the guard OK (`will-prevent-unload` is prevented, so the unload goes ahead), and the footer of the reply shows `- Dialog: beforeunload "Leave site?" → OK` (Task 10b, 2026-11-19); a beforeunload the page opens is never recorded by the page driver;
  - `The ClaudeTerm window is minimized; ask the person to restore it, then take the screenshot again.` (added 2026-11-18);
  - `The person allowed <site>; the form was not sent. Submit it again.` (Task 10 fix round 1: a held form POST is never sent again by ClaudeTerm).
  - the footer's URL line for a page the tab may not use (final fix wave, 2026-11-19): `- URL: a page on <site>`; then no `- Title:` line, no console error and no dialog line; its download lines stay. A `file:` page outside the tab's folder shows `- URL: a local file outside the tab's folder`, and `browser_tabs list` masks it the same way (no path, no title). `browser_tabs list` never shows the title or address of such a page;
  - a response body the tab may not read: `### Response body` is followed by `(not shown: <site> is not allowed in this tab)`; the headers stay (2026-11-19);
  - a local file outside the tab's folder (the tab's folder is the folder it works in; a file inside it is free): the card says `Claude wants to open <path>` / `Claude wants to use <path>` with its path in the OS form, and offers only `Allow in this tab` and `Deny` (no `Always allow`); a grant covers that exact file in that tab only (2026-11-19);
  - `a local file outside the tab's folder` (the masked form above, also in the list);
  - `The person did not allow a local file outside the tab's folder.` and `The person did not answer about a local file outside the tab's folder. …` (round 2: a `use` of a file Claude did not ask for by URL; Claude's own `navigate` to a file keeps its path);
  - `The person allowed a local file outside the tab's folder; the form was not sent. Submit it again.` (round 2);
  - a `file:` URL with a host other than `localhost` (a network share) is refused like any other URL that cannot be opened: `The ClaudeTerm browser opens only http, https and file addresses.` (2026-11-19).
- Shortcut for the Browser panel: `Ctrl+Shift+B` (Windows and Linux) and `⌘B` (macOS). Task 9 checks that both are free.

## Review Focus

1. **Redirect chains during a Claude command**: a local page that redirects twice to a non-allowed site must raise one card, not two. A Deny must leave the page where it was. Test in Task 10: `holds a redirect chain once`.
2. **A Claude tab closes while a card waits or a command runs**: the pending command must resolve (as `stopped`), the views must be destroyed, and no state event may name the closed tab afterwards. Test in Task 9: `closing the tab ends its pending command`.
3. **The MCP server goes away mid-command** (Claude interrupted, pipe socket closed): main's command ends, the card goes away, and the tab stays usable. Test in Task 10: `a closed pipe drops the card`.
4. **Cookie edge cases on import**: `__Host-` cookies, domain cookies with a leading dot, `SameSite=None` without `Secure`, expiry already past, an IPv4 host, and a non-ASCII value. None may abort the import. Each is counted as imported or skipped. Test in Task 13: `maps awkward cookies without failing`.
5. **Profile deleted while tabs use it**: those tabs move to Default, their pages reopen there, and their session restore no longer names the deleted profile. Test in Task 11: `deleting a profile moves its tabs to Default`.

---

### Task 0: Workspace and baseline

**Files:** none changed.

- [ ] **Step 1: Install packages in the worktree.** Run `npm ci` in the worktree root. Do not link the main checkout's `node_modules`. Expected: exit 0, and `node_modules/electron/dist` exists.
- [ ] **Step 2: Check the baseline.** Run `npm run typecheck`, then `npm test`. Expected: both pass. If either fails on untouched code, stop and report the output to the controller.

### Task 1: Spike — prove the risky assumptions (no product code)

This task writes throwaway scripts only, in a scratch folder **outside the repository** (`<tmpdir>/ct-browser-spike/`). The folder is deleted at the end. The result is a short findings report to the controller.

**Checks and how to run them:**

- [ ] **Step 1: Hidden view keeps working (Electron).** Write `spike-view.cjs` and run it with the worktree's Electron (`node_modules/.bin/electron spike-view.cjs`). It must:
  - create a `BaseWindow` 800×600 and a `WebContentsView` with `partition: 'persist:spike'` and `backgroundThrottling: false`, then load `data:text/html,<input id=a><button onclick="document.title='clicked'">B</button>`;
  - run `debugger.attach('1.3')`, `Page.enable`, `DOM.enable`, `Accessibility.enable`;
  - (a) with the view added to `contentView`, call `Accessibility.getFullAXTree`, then click the button through `DOM.getBoxModel` + `Input.dispatchMouseEvent`, then `Page.captureScreenshot`;
  - (b) repeat after `contentView.removeChildView(view)`;
  - (c) repeat with the view added but `view.setVisible(false)`.

  Record for each case whether the title became `clicked` and whether the screenshot returned within 5 s.
- [ ] **Step 2: JavaScript dialogs.** In the same script, load a page that calls `alert('x')` on a button click. Check whether `Page.javascriptDialogOpening` arrives and `Page.handleJavaScriptDialog({accept:true})` closes it, with no native dialog showing.
- [ ] **Step 3: DevTools with the debugger attached.** Call `webContents.openDevTools({mode:'detach'})` while the debugger is attached. Record whether both keep working: send a CDP command after DevTools opens.
- [ ] **Step 4: Session cookies across a restart.** Set a cookie without `expirationDate` via `session.fromPartition('persist:spike').cookies.set`, call `flushStore()`, and quit. Run a second script on the same partition and record whether `cookies.get({})` still returns it.
- [ ] **Step 5: Chrome on a copied profile (Windows; also macOS/Linux if available).**
  1. Find the installed Chrome.
  2. Make a throwaway user-data folder `A` under the scratch folder. Launch Chrome with `--user-data-dir=A --remote-debugging-pipe --no-first-run --no-default-browser-check --headless=new`. Send `Network.setCookie {name:'spike', value:'spike-value', domain:'example.com', path:'/', secure:true, expires:<now+3600>}`, then `Browser.close`.
  3. Open `A/Default/Network/Cookies` with `node:sqlite` and record **only** the first 3 bytes of `encrypted_value` for that row (`v10`/`v11`/`v20`). Never print a value.
  4. Copy `A/Local State` and `A/Default/Network/Cookies*` into a new folder `B`, keeping the same layout.
  5. Launch Chrome on `B` with `--profile-directory=Default` and the same switches. Call `Storage.getCookies` and record whether a cookie named `spike` comes back with value `spike-value`.
  6. Repeat steps 1–5 with `--no-startup-window` instead of `--headless=new`.
- [ ] **Step 6: Report.** Send the controller a findings table for steps 1–5. If step 5's prefix was not `v20`, say so plainly: the throwaway profile did not exercise App-Bound Encryption. The controller then asks the person whether the check may run on a copy of their own Chrome profile, printing only counts and prefixes. **Do not do that without the person's yes.** Delete the scratch folder and end every process you started.

The controller turns the findings into decisions before Task 8:
- which hidden-view mode to use (default: keep views added with `setVisible(false)`);
- whether `browser_handle_dialog` stays (fallback: dialogs are auto-dismissed — alert accepted, confirm false, prompt null — and the page footer reports `A dialog was dismissed: <type> "<message>"`);
- whether `Open DevTools` stays;
- whether session cookies need the 30-day expiry (it stays in any case);
- the Chromium launch switches. If the copy cannot be decrypted on Windows, **stop before Task 15 and report to the person**.

### Task 2: Site rules (shared, pure)

**Files:**
- Create: `src/shared/site.ts`
- Test: `tests/unit/site.test.ts`

**Interfaces:**
- Produces:
  - `isWebUrl(url: string): boolean`: true for `http:`, `https:` and `file:` URLs and the exact URL `about:blank`.
  - `isLocalUrl(url: string): boolean`: true for `file:`, `about:blank`, and `http(s)` with host `localhost`, `*.localhost`, `127.0.0.0/8` or `[::1]`.
  - `siteOf(url: string): string | null`: the lower-cased host of an http(s) URL with one leading `www.` removed, but only when the rest still contains a dot. The port is dropped and IPv6 keeps its brackets. Null otherwise.
  - `siteCovers(allowed: string, site: string): boolean`: `site === allowed || site.endsWith('.' + allowed)`.
  - `normalizeAddress(text: string): string | null`: parses what the person typed in the address field (rules below).

- [ ] **Step 1: Write the failing tests** in `tests/unit/site.test.ts`:
  - `isLocalUrl` is true for `http://localhost:5173/`, `https://app.localhost/x`, `http://127.0.0.1:8080`, `http://127.9.9.9/`, `http://[::1]:3000/`, `file:///C:/x.html` and `about:blank`.
  - `isLocalUrl` is false for `http://localhost.evil.com/`, `http://128.0.0.1/`, `http://192.168.1.1/`, `https://example.com/` and `javascript:alert(1)`.
  - `siteOf`: `https://www.GitHub.com/a` → `github.com`; `https://gist.github.com` → `gist.github.com`; `https://www.co` → `www.co`; `http://example.co.uk:81/` → `example.co.uk`; `http://[::1]:3/` → `[::1]`; `file:///x` → `null`; `not a url` → `null`.
  - `siteCovers('github.com','api.github.com')` is true, `siteCovers('github.com','evilgithub.com')` is false, and `siteCovers('example.co.uk','co.uk')` is false.
  - `normalizeAddress`:
    - `'  '` → `null`;
    - `'localhost:5173/x'` → `'http://localhost:5173/x'`;
    - `'127.0.0.1:3000'` → `'http://127.0.0.1:3000/'`;
    - `'example.com'` → `'https://example.com/'`;
    - `'https://a.b/c?d'` → unchanged;
    - `'file:///C:/a.html'` → unchanged;
    - `'how to x'` → `null`;
    - `'javascript:alert(1)'` → `null`;
    - `'chrome://settings'` → `null`.
  - `isWebUrl('data:text/html,x')` is false and `isWebUrl('about:blank')` is true.
- [ ] **Step 2: Run the tests and see them fail.** `npx vitest run tests/unit/site.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `src/shared/site.ts`.** Parse with `new URL()` inside `try`.
  - `normalizeAddress` rules:
    - trim, and empty → null;
    - an explicit scheme other than http/https/file → null;
    - no scheme, starting with `localhost`, `127.` or `[::1]` → prefix `http://`;
    - no scheme, no whitespace, containing a dot → prefix `https://`;
    - anything else → null;
    - return the result as `new URL(x).href`.
- [ ] **Step 4: Run the tests and see them pass.**
- [ ] **Step 5: List the changed files** (no commit).

### Task 3: Shared browser types, the command parser and the pipe message

**Files:**
- Create: `src/shared/browser.ts`
- Modify: `src/shared/protocol.ts`: add `BrowserMessage` to `PipeMessage`, parse it in `parsePipeMessage`, add `image?: PipeImage` to the ok variant of `PipeResponse`.
- Modify: `src/main/pipe-server.ts`: add `browser(msg: BrowserMessage, closed: AbortSignal): Promise<PipeResponse>` to `PipeHandlers` and dispatch `case 'browser'`.
- Modify: every place that builds a full `PipeHandlers` object, so typecheck passes. Find them with `grep -rn "startPipeServer(" src tests`; they include `src/main/index.ts`, `tests/integration/mcp.int.test.ts` and `tests/integration/pipe.test.ts`. The test stubs return `{ ok: true }`. In `index.ts`, add `browser: async () => ({ ok: false, error: 'The browser works only in a ClaudeTerm Claude tab.' })` for now; Task 9 replaces it.
- Test: `tests/unit/browser-command.test.ts`, and extend `tests/unit/protocol.test.ts`.

**Interfaces:**
- Produces, in `src/shared/browser.ts`:

```ts
export const BROWSER_TOOL_NAMES = ['browser_navigate', 'browser_navigate_back', 'browser_navigate_forward', 'browser_reload', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press_key', 'browser_hover', 'browser_select_option', 'browser_scroll', 'browser_wait_for', 'browser_take_screenshot', 'browser_evaluate', 'browser_console_messages', 'browser_network_requests', 'browser_network_request', 'browser_handle_dialog', 'browser_tabs'] as const
export type BrowserCommand =
  | { op: 'navigate'; url: string } | { op: 'back' } | { op: 'forward' } | { op: 'reload' } | { op: 'snapshot' }
  | { op: 'click'; ref: string; element: string; button: 'left' | 'right' | 'middle'; doubleClick: boolean }
  | { op: 'type'; ref: string; element: string; text: string; submit: boolean; slowly: boolean }
  | { op: 'press_key'; key: string } | { op: 'hover'; ref: string; element: string }
  | { op: 'select_option'; ref: string; element: string; values: string[] }
  | { op: 'scroll'; ref: string | null; direction: 'up' | 'down' | 'left' | 'right'; amount: number }
  | { op: 'wait_for'; text: string | null; textGone: string | null; time: number | null }
  | { op: 'screenshot'; fullPage: boolean; ref: string | null }
  | { op: 'evaluate'; function: string; ref: string | null }
  | { op: 'console'; onlyErrors: boolean } | { op: 'network' } | { op: 'network_request'; id: string }
  | { op: 'handle_dialog'; accept: boolean; promptText: string | null }
  | { op: 'tabs'; action: 'list' | 'new' | 'select' | 'close'; index: number | null; url: string | null }
export type BrowserOp = BrowserCommand['op']
export const MAX_URL = 8192, MAX_TEXT = 20_000, MAX_FUNCTION = 30_000, MAX_ELEMENT = 300, MAX_KEY = 64, MAX_VALUES = 50, MAX_VALUE = 1000, MAX_WAIT_SECONDS = 60, MAX_SCROLL = 10_000, DEFAULT_SCROLL = 600, MAX_PAGES = 20
export const REF_RE = /^e[0-9]{1,7}$/, REQUEST_ID_RE = /^r[0-9]{1,7}$/
export function parseBrowserCommand(v: unknown): { ok: true; command: BrowserCommand } | { ok: false; error: string }

export const DEFAULT_PROFILE_ID = 'default'
export const PROFILE_ID_RE = /^(default|[a-z0-9]{8})$/
export const MAX_PROFILE_NAME = 40
export const partitionOf = (profileId: string): string => `persist:browser-${profileId}`
export type SiteAnswer = 'tab' | 'always' | 'deny'
export interface SiteCard { id: string; site: string; kind: 'open' | 'use' }
export type BrowserControl = 'idle' | 'claude' | 'person'
export interface BrowserPageView { url: string; title: string; loading: boolean }
export interface BrowserPanelState { tabId: string; profileId: string; profiles: { id: string; name: string }[]; pages: BrowserPageView[]; current: number | null; control: BrowserControl; card: SiteCard | null; canBack: boolean; canForward: boolean; devtools: boolean }
export type BrowserPanelAction =
  | { type: 'navigate'; url: string } | { type: 'back' } | { type: 'forward' } | { type: 'reload' }
  | { type: 'newPage' } | { type: 'selectPage'; index: number } | { type: 'closePage'; index: number }
  | { type: 'setProfile'; profileId: string } | { type: 'stop' } | { type: 'handBack' }
  | { type: 'answer'; cardId: string; answer: SiteAnswer } | { type: 'devtools' } | { type: 'manageProfiles' } | { type: 'clearData' }
export interface BrowserProfileView { id: string; name: string; allowed: string[] }
export interface BrowserProfilesView { profiles: BrowserProfileView[]; defaultId: string }
export type BrowserProfileAction =
  | { type: 'add'; name: string } | { type: 'rename'; id: string; name: string } | { type: 'remove'; id: string }
  | { type: 'setDefault'; id: string } | { type: 'disallow'; id: string; site: string } | { type: 'clearData'; id: string }
export interface BrowserTabState { profile: string; pages: string[]; current: number }
export function parseBrowserTabState(v: unknown): BrowserTabState | null
export interface ImportSourceView { id: string; label: string; available: boolean }
export type ImportStatus =
  | { state: 'idle' } | { state: 'waiting-close'; browser: string } | { state: 'importing' }
  | { state: 'done'; imported: number; sites: number; skipped: number; notes: string[] }
  | { state: 'failed'; error: string } | { state: 'cancelled' }
```

- Produces, in `protocol.ts`:
  - `export interface BrowserMessage { v: 1; type: 'browser'; tabId: string; command: BrowserCommand }`
  - `export interface PipeImage { data: string; mimeType: 'image/png' | 'image/jpeg' }`
  - `PipeResponse = { ok: true; info?: string; image?: PipeImage } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing tests.** In `tests/unit/browser-command.test.ts`, each op with valid args parses to the exact object, with defaults filled in:
  - `click`: button `'left'`, doubleClick `false`;
  - `type`: submit `false`, slowly `false`;
  - `scroll`: amount `600`, ref `null`;
  - `screenshot`: fullPage `false`, ref `null`;
  - `wait_for` and `tabs`: missing fields → `null`.

  Rejections:
  - unknown op;
  - `navigate` without a url, or a url over 8192 characters;
  - a ref `'x1'`;
  - `type` text over 20 000 characters, and `evaluate` function over 30 000;
  - `wait_for` time 61, and `wait_for` with no field at all;
  - `scroll` amount 0 or 10 001;
  - `select_option` with 51 values;
  - `network_request` id `'5'`;
  - `tabs` action `'open'`, and `tabs` `select` without index;
  - `press_key` key `''`.

  `parseBrowserTabState`:
  - `{profile:'default', pages:['http://localhost:1/'], current:0}` stays as it is;
  - a page `javascript:x` is dropped, and current is clamped into range;
  - a bad profile id gives `null`;
  - more than 20 pages are cut to 20.

  In `protocol.test.ts`: a `browser` line with a UUID tabId and a valid command parses; a non-UUID tabId and a bad command are refused with an error.
- [ ] **Step 2: Run and see them fail.** `npx vitest run tests/unit/browser-command.test.ts tests/unit/protocol.test.ts`
- [ ] **Step 3: Implement** `parseBrowserCommand`, `parseBrowserTabState` (keeping pages that pass `isWebUrl` from Task 2), the protocol types and parsing, and the `pipe-server.ts` case. Update the `PipeHandlers` stubs.
- [ ] **Step 4: Run `npm run typecheck` and the two test files.** Expected: PASS.
- [ ] **Step 5: List the changed files.**

### Task 4: The `browser_*` MCP tools and their pre-allowance

**Files:**
- Create: `src/mcp/browser-tools.ts`
- Modify: `src/mcp/show-image-server.ts`: call `registerBrowserTools(server, browserDeps)` and append `BROWSER_INSTRUCTIONS` to the server instructions.
- Modify: `src/main/claude-tab-settings.ts`: add `...BROWSER_TOOL_NAMES.map((n) => 'mcp__claudeterm__' + n)` to `permissions.allow`.
- Test: `tests/integration/browser-mcp.int.test.ts` (new; same setup as `mcp.int.test.ts`: esbuild the server, a pipe server with stub handlers, the MCP `Client`), and `tests/unit/claude-tab-settings.test.ts` (extend).

**Interfaces:**
- Consumes: `BrowserCommand`, `BROWSER_TOOL_NAMES` and the limits (Task 3); `BrowserMessage` and `PipeResponse` (Task 3); `sendPipeMessage` and `PipeUnavailableError` (`src/shared/pipe-client.ts`).
- Produces:

```ts
export interface BrowserToolDeps { tabId: string | null; pipeName: string; send(pipeName: string, msg: BrowserMessage): Promise<PipeResponse> }
export type BrowserToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export interface BrowserToolResult { content: BrowserToolContent[]; isError: boolean }
export async function runBrowserCommand(command: BrowserCommand, deps: BrowserToolDeps): Promise<BrowserToolResult>
export function registerBrowserTools(server: McpServer, deps: () => BrowserToolDeps): void
export const BROWSER_INSTRUCTIONS: string
export const BROWSER_PIPE_TIMEOUT_MS = 720_000
```

- Tool to op: `browser_navigate`→`navigate`, `browser_navigate_back`→`back`, `browser_navigate_forward`→`forward`, `browser_reload`→`reload`, `browser_snapshot`→`snapshot`, `browser_click`→`click`, `browser_type`→`type`, `browser_press_key`→`press_key`, `browser_hover`→`hover`, `browser_select_option`→`select_option`, `browser_scroll`→`scroll`, `browser_wait_for`→`wait_for`, `browser_take_screenshot`→`screenshot`, `browser_evaluate`→`evaluate`, `browser_console_messages`→`console`, `browser_network_requests`→`network`, `browser_network_request`→`network_request`, `browser_handle_dialog`→`handle_dialog`, `browser_tabs`→`tabs`. Zod input fields use the same names as the `BrowserCommand` fields.
- `BROWSER_INSTRUCTIONS`, verbatim: `ClaudeTerm's built-in browser (browser_* tools) shows its pages to the person in the Browser panel of this tab. On local pages (localhost, 127.0.0.1, files) you work freely; any other site needs the person's permission, which ClaudeTerm asks for when you first open or use it, and the call waits for the answer. Take browser_snapshot before clicking or typing, and use the refs it gives.`
- Each tool description is one sentence about what it does. Put the permission sentence in `browser_navigate`'s description too.

- [ ] **Step 1: Write the failing tests.** In `browser-mcp.int.test.ts`:
  - (a) `listTools` contains all 19 names;
  - (b) `browser_click {ref:'e3', element:'Sign in'}` sends `{v:1,type:'browser',tabId:TAB,command:{op:'click',ref:'e3',element:'Sign in',button:'left',doubleClick:false}}` and returns the stub's `info` as text;
  - (c) a stub response `{ok:true, info:'shot', image:{data:'AAAA', mimeType:'image/png'}}` to `browser_take_screenshot` returns content `[{type:'image',data:'AAAA',mimeType:'image/png'},{type:'text',text:'shot'}]`;
  - (d) `{ok:false,error:'The person did not allow example.com.'}` returns `isError: true` with that text;
  - (e) without `CLAUDETERM_TAB_ID`, the result is `The browser works only in a ClaudeTerm Claude tab.`;
  - (f) a pipe name nobody listens on returns `ClaudeTerm is not running; the browser is not available.`;
  - (g) `browser_type` with a 20 001-character text is refused by the tool's zod schema, and no pipe message is sent.

  In `claude-tab-settings.test.ts`, the generated `permissions.allow` contains `mcp__claudeterm__browser_navigate` and `mcp__claudeterm__browser_evaluate`.
- [ ] **Step 2: Run and see them fail.** `npx vitest run tests/integration/browser-mcp.int.test.ts tests/unit/claude-tab-settings.test.ts`
- [ ] **Step 3: Implement.** zod schemas enforce the same limits as `parseBrowserCommand`. `runBrowserCommand` builds the message and calls `deps.send` with `BROWSER_PIPE_TIMEOUT_MS`. Wire `browserDeps` in the server like the other tools: `tabId` from `CLAUDETERM_TAB_ID` checked by `isUuid`, `pipeName` from `CLAUDETERM_PIPE` or `defaultPipeName`, `send: (p, m) => sendPipeMessage(p, m, BROWSER_PIPE_TIMEOUT_MS)`.
- [ ] **Step 4: Run and see them pass.** Also run `npx vitest run tests/integration/mcp.int.test.ts`; it must still pass.
- [ ] **Step 5: List the changed files.**

### Task 5: Browser profiles store

**Files:**
- Create: `src/main/browser/profiles-store.ts`
- Test: `tests/unit/browser-profiles-store.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_PROFILE_ID`, `PROFILE_ID_RE`, `MAX_PROFILE_NAME` and `BrowserProfilesView` (Task 3).
- Produces:

```ts
export class BrowserProfilesStore {
  constructor(file: string, o?: { onError?(message: string): void; newId?(): string })
  view(): BrowserProfilesView
  has(id: string): boolean
  name(id: string): string | null
  defaultId(): string
  add(name: string): string | null          // trimmed, 1..40 chars, unique ignoring case; returns the new id
  rename(id: string, name: string): boolean // same name rules
  remove(id: string): boolean               // never 'default'; a removed default makes 'default' the default
  setDefault(id: string): boolean
  allowed(id: string): string[]             // sorted
  allow(id: string, site: string): void
  disallow(id: string, site: string): boolean
}
```

- File format: `{ "version": 1, "defaultId": "default", "profiles": [{ "id": "default", "name": "Default", "allowed": [], "allowAll": false }] }` (`allowAll` added 2026-11-19; a missing or non-`true` value loads as off), written to `file + '.tmp'` then renamed. A missing or broken file starts with Default only. A file whose profiles lack `default` gets it added. `newId` defaults to 8 random characters from `[a-z0-9]` (`crypto.randomBytes`).

- [ ] **Step 1: Write the failing tests** (files under `mkdtempSync(join(tmpdir(),'ct-bprof-'))`):
  - a fresh store has view `{profiles:[{id:'default',name:'Default',allowed:[]}],defaultId:'default'}`;
  - `add('Work')` returns an id matching `PROFILE_ID_RE`, and a second store on the same file sees it;
  - `add('work')` after `add('Work')` returns `null`, and so do `add('')` and `add('x'.repeat(41))`;
  - `remove('default')` is false;
  - removing the default profile makes `defaultId()` `'default'`;
  - `allow(id,'github.com')` twice keeps one entry, and `disallow` removes it;
  - a file with `{"version":1,"profiles":"x"}` loads as Default only and calls `onError`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see them pass.**
- [ ] **Step 5: List the changed files.**

### Task 6: Site gate

**Files:**
- Create: `src/main/browser/site-gate.ts`
- Test: `tests/unit/site-gate.test.ts` (uses `vi.useFakeTimers()`)

**Interfaces:**
- Consumes: `isLocalUrl`, `siteOf` and `siteCovers` (Task 2); `SiteCard` and `SiteAnswer` (Task 3).
- Produces:

```ts
export type GateResult = 'allowed' | 'denied' | 'timeout' | 'stopped'
export const SITE_ANSWER_MS = 600_000
export interface SiteGateDeps {
  allowedAlways(profileId: string): string[]
  allowAlways(profileId: string, site: string): void
  showCard(tabId: string, card: SiteCard | null): void
  /** the tab asks for attention on this device only (never forwarded to paired devices) */
  signal(tabId: string): void
  answerMs?: number
  newId?(): string
}
export class SiteGate {
  constructor(d: SiteGateDeps)
  isAllowed(tabId: string, profileId: string, url: string): boolean
  check(tabId: string, profileId: string, url: string, kind: 'open' | 'use', signal?: AbortSignal): Promise<GateResult>
  answer(tabId: string, cardId: string, answer: SiteAnswer): void
  stop(tabId: string): void
  removeTab(tabId: string): void
  card(tabId: string): SiteCard | null
}
```

- Rules:
  - `isAllowed`: true for a local URL, or when a tab grant or the profile's always list covers `siteOf(url)`. A URL with no site that is not local (for example `data:`) is never allowed.
  - `check`: resolves `allowed` at once when allowed. Otherwise it shows a card `{id, site, kind}`, calls `signal(tabId)` once per card, and waits:
    - `tab` adds a tab grant;
    - `always` calls `allowAlways`;
    - `deny` → `denied`;
    - `SITE_ANSWER_MS` → `timeout`;
    - `stop(tabId)` or an aborted `signal` → `stopped`.
  - One card per tab at a time. A second `check` for the same site joins the open card. A check for another site waits its turn in FIFO order. When a card resolves, `showCard(tabId, next card | null)`.
  - `removeTab` resolves everything pending as `stopped` and forgets the tab's grants.
  - A stale `cardId` is ignored.

- [ ] **Step 1: Write the failing tests:**
  - a local URL is allowed with no card;
  - `https://github.com/x` shows a card `{site:'github.com',kind:'open'}` and calls `signal` once;
  - answer `tab` resolves `allowed`, and a later `check` for `https://api.github.com` in the same tab needs no card, while another tab still gets a card;
  - answer `always` calls `allowAlways('p1','github.com')`;
  - `deny` → `denied`;
  - advancing 600 000 ms → `timeout` and `showCard(tab,null)`;
  - `stop` → `stopped`;
  - an aborted signal → `stopped`;
  - two concurrent checks for the same site share one card;
  - checks for `a.com` then `b.com` show `a.com` first, then `b.com` after the answer;
  - `removeTab` resolves pending checks as `stopped`;
  - a stale card id changes nothing.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see them pass.**
- [ ] **Step 5: List the changed files.**

### Task 7: Pure helpers — snapshot text, keys, result footer

**Files:**
- Create: `src/main/browser/snapshot.ts`, `src/main/browser/keys.ts`, `src/main/browser/result-text.ts`
- Test: `tests/unit/browser-snapshot.test.ts`, `tests/unit/browser-keys.test.ts`, `tests/unit/browser-result-text.test.ts`, fixture `tests/fixtures/ax-tree-login.json` (a hand-written CDP `Accessibility.getFullAXTree` result for an invented login form: a heading, two textboxes, a checkbox, a button, a link and static texts)

**Interfaces:**
- Produces:

```ts
// snapshot.ts
export interface AXValue { type?: string; value?: unknown }
export interface AXNode { nodeId: string; ignored: boolean; role?: AXValue; name?: AXValue; value?: AXValue; properties?: { name: string; value: AXValue }[]; childIds?: string[]; parentId?: string; backendDOMNodeId?: number }
export interface Snapshot { text: string; refs: Map<string, number>; truncated: boolean }
export const SNAPSHOT_LIMIT = 60_000
export function formatSnapshot(nodes: AXNode[], limit?: number): Snapshot
// keys.ts
export interface KeyEvent { type: 'keyDown' | 'rawKeyDown' | 'keyUp'; key: string; code: string; windowsVirtualKeyCode: number; modifiers: number; text?: string }
export function keyEvents(combo: string): KeyEvent[] | null
// result-text.ts
export interface PageFooter { url: string; title: string; newErrors: string[]; downloads: string[]; dialog: { type: string; message: string } | null; dismissed: { type: string; message: string } | null }
export function withFooter(text: string, f: PageFooter): string
```

- Snapshot format (exact):
  - Start at the children of the first node without `parentId`, at depth 0, indented two spaces per depth.
  - Ignored nodes and the roles `none`, `generic`, `InlineTextBox` and `LineBreak` print nothing; their children print at the same depth.
  - A `StaticText` node prints `- text: "<name>"`, unless its name equals the name of the nearest printed ancestor.
  - Any other node prints `- <role>` + ` "<name>"` (when the name is not empty). Then ` [checked]` / ` [disabled]` / ` [expanded]` / ` [selected]` for those boolean properties when true, and ` [level=N]` for `level`. For `textbox`, `searchbox` and `combobox`, a non-empty value adds `: "<value>"`. Last comes ` [ref=eN]` when `backendDOMNodeId` is set, with N counting from 1 in document order.
  - Names and values are cut to 200 code points with `…`.
  - Once the next line would push the text past `limit`, stop, set `truncated`, and add the final line `- … (snapshot cut at <limit> characters; use browser_evaluate or browser_take_screenshot for the rest)`.
- Keys:
  - Modifiers: `Alt=1`, `Control=2`, `Meta=4`, `Shift=8`. The combo is split on `+`. Modifier names are `Alt`, `Control`, `Ctrl`, `Meta`, `Command`, `Shift`.
  - Named keys with virtual key codes: `Enter` 13, `Tab` 9, `Escape` 27, `Backspace` 8, `Delete` 46, `ArrowUp` 38, `ArrowDown` 40, `ArrowLeft` 37, `ArrowRight` 39, `Home` 36, `End` 35, `PageUp` 33, `PageDown` 34, `Space` 32 (key `' '`), `F1`–`F12` 112–123.
  - A single character: a letter gives code `Key<UPPER>` with its upper-case char code; a digit gives `Digit<d>`; other printable characters get code `''` and `charCodeAt(0)`.
  - Event order: each modifier `keyDown`; then the main key as `keyDown` with `text` when it is printable (or Enter → `'\r'`) and no Control/Alt/Meta is held, otherwise `rawKeyDown`; then its `keyUp`; then the modifiers' `keyUp` in reverse order.
  - Unknown → `null`.
- Footer, exactly this shape: the text, a blank line, `### Page`, `- URL: <url>`, `- Title: <title>`. Then, only when present:
  - `- New console errors (<n>):` followed by the first 5 errors, each on its own line, cut to 300 characters, prefixed with two spaces and `- `;
  - `- Downloaded: <path>, <path>`;
  - `- Open dialog: <type> "<message>"`;
  - `- A dialog was dismissed: <type> "<message>"`.

- [ ] **Step 1: Write the failing tests.**
  - Snapshot of the fixture equals an exact expected string. Write it by hand from the rules and keep it in the test.
  - Refs map `e1`… to the fixture's backend ids.
  - A limit of 120 truncates and ends with the cut line.
  - A `StaticText` whose name equals its button's name is not printed.
  - `keyEvents('Enter')` is `[{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:0,text:'\r'},{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:0}]`.
  - `keyEvents('Control+a')` has 4 events, the main one a `rawKeyDown` with `modifiers:2` and no `text`.
  - `keyEvents('Shift+Tab')`, `keyEvents('Bogus')` → `null`, and `keyEvents('é')` (key `'é'`, `text:'é'`).
  - `withFooter` with no errors prints only URL and Title; with 7 errors it prints the count 7 and only the first 5 lines.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see them pass.**
- [ ] **Step 5: List the changed files.**

### Task 8: Page driver (CDP)

**Files:**
- Create: `src/main/browser/page-driver.ts`
- Test: `tests/unit/page-driver.test.ts` (a fake `Cdp` that records `send` calls and lets the test emit events)

**Interfaces:**
- Consumes: `formatSnapshot`, `keyEvents`, `PipeImage` and `REQUEST_ID_RE`. Also the controller's Task 1 decisions on dialogs.
- Produces:

```ts
export interface Cdp { send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>; on(event: string, fn: (params: any) => void): void }
export class StaleRefError extends Error {}           // message: 'The page changed; take a new snapshot.'
export class PageDriver {
  constructor(cdp: Cdp)
  enable(): Promise<void>                               // Page, Runtime, Network, Log, DOM, Accessibility .enable
  snapshot(): Promise<string>                           // stores refs; refs reset on main-frame navigation
  click(ref: string, button: 'left' | 'right' | 'middle', doubleClick: boolean): Promise<void>
  type(ref: string, text: string, submit: boolean, slowly: boolean): Promise<void>
  pressKey(combo: string): Promise<void>                // throws Error('Unknown key: <combo>')
  hover(ref: string): Promise<void>
  selectOption(ref: string, values: string[]): Promise<string[]>
  scroll(ref: string | null, direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void>
  waitFor(text: string | null, textGone: string | null, time: number | null, signal: AbortSignal): Promise<void>
  screenshot(fullPage: boolean, ref: string | null): Promise<PipeImage>
  evaluate(fn: string, ref: string | null): Promise<string>  // JSON of the result, cut to 50_000 chars
  consoleText(onlyErrors: boolean): string
  networkText(): string
  requestText(id: string): Promise<string>             // headers and body, body cut to 100_000 chars
  dialog(): { type: string; message: string } | null
  handleDialog(accept: boolean, promptText: string | null): Promise<void>
  takeFooterNews(): { newErrors: string[]; dismissed: { type: string; message: string } | null }
}
```

- CDP recipes:
  - **ref → node:** `refs.get(ref)` → `backendNodeId`; a missing ref throws `StaleRefError`.
  - **click:** `DOM.scrollIntoViewIfNeeded {backendNodeId}` and `DOM.getBoxModel {backendNodeId}`; the centre of `model.content` (8 numbers) is the point. Then `Input.dispatchMouseEvent`: `mouseMoved`, `mousePressed` and `mouseReleased` with `button` and `clickCount` 1. A double click adds a second pressed/released pair with `clickCount` 2. A `getBoxModel` error throws `StaleRefError`.
  - **type:** `DOM.focus {backendNodeId}`, then `Input.insertText {text}` (or, when slowly, `keyEvents(char)` for each character), then `keyEvents('Enter')` if submit.
  - **hover:** `mouseMoved` at the centre.
  - **select:** `DOM.resolveNode` → `objectId`, then `Runtime.callFunctionOn` with a function that selects the options whose value or label matches, dispatches `input` and `change`, and returns the selected values (`returnByValue: true`).
  - **scroll:** `mouseWheel` at the element centre, or at the viewport centre from `Page.getLayoutMetrics().cssVisualViewport`, with `deltaX` / `deltaY` = ±amount.
  - **wait_for:** poll `Runtime.evaluate {expression:'document.body ? document.body.innerText : ""', returnByValue:true}` every 250 ms; or sleep `time` seconds; at most 60 s, then throw `Error('Timed out waiting for "<text>".')`.
  - **screenshot:** `Page.captureScreenshot {format:'png', captureBeyondViewport: fullPage}`, with a clip from `Page.getLayoutMetrics().cssContentSize` for a full page or from the element's box. If the base64 is over 4 000 000 characters, take it again as `jpeg` with quality 70.
  - **evaluate:** without a ref, `Runtime.evaluate {expression:'(' + fn + ')()', awaitPromise:true, returnByValue:true}`; with a ref, `DOM.resolveNode` + `Runtime.callFunctionOn {functionDeclaration: fn, arguments:[{objectId}], awaitPromise:true, returnByValue:true}`. `exceptionDetails` throws `Error(<description>)`.
  - **Console ring (500):** `Runtime.consoleAPICalled` (type and args joined via `value ?? description`), `Runtime.exceptionThrown` (`exceptionDetails.exception.description ?? text`, as an error) and `Log.entryAdded` (level `error` is an error). Line format: `[<level>] <text>`.
  - **Network ring (500):** `Network.requestWillBeSent`, `responseReceived` and `loadingFailed`. Ids are `r1`, `r2`… mapped to CDP `requestId`s. Line format: `r<n> <METHOD> <url> → <status|failed: errorText|pending> <resourceType>`.
  - Both rings and the refs clear on `Page.frameNavigated` without `frame.parentId`.
  - **Dialogs:** `Page.javascriptDialogOpening` / `javascriptDialogClosed`. If Task 1 found that CDP cannot answer dialogs in Electron, handle each with `Page.handleJavaScriptDialog {accept: type === 'alert'}` at once, and record it for `takeFooterNews().dismissed` instead.

- [ ] **Step 1: Write the failing tests** with the fake `Cdp`:
  - `enable` sends the six `.enable` calls;
  - `snapshot` uses the fixture from Task 7 and returns its text;
  - `click('e2','left',false)` sends `DOM.scrollIntoViewIfNeeded`, `DOM.getBoxModel` and three `Input.dispatchMouseEvent` with x/y at the box centre;
  - `click('e99',…)` rejects with `StaleRefError`;
  - after a `Page.frameNavigated` event without `parentId`, `click('e2',…)` rejects with `StaleRefError`;
  - 501 `Runtime.consoleAPICalled` events keep 500 lines;
  - `consoleText(true)` lists only errors;
  - `takeFooterNews().newErrors` returns new errors once, then `[]`;
  - network events produce the line `r1 GET http://localhost:1/a → 200 Document`;
  - a `Page.javascriptDialogOpening` makes `dialog()` return `{type:'alert',message:'x'}`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see them pass.**
- [ ] **Step 5: List the changed files.**

### Task 9: Tab browsers in main, the pipe handler, and the Browser panel

The core end-to-end slice: Claude's commands work on local pages, and the person sees and uses the panel. The site gate is wired here but tested in Task 10. Profiles use only Default until Task 11.

**Files:**
- Create: `src/main/browser/tab-browser.ts`, `src/main/browser/browser-hub.ts`
- Create: `src/renderer/browser-panel.ts`, plus styles in `src/renderer/styles.css`
- Modify:
  - `src/main/index.ts`: create the hub and stores, replace the `browser` pipe stub, add the IPC handlers, call `browserHub.removeTab` in `onTabClosed`, add test-mode switches;
  - `src/shared/ipc.ts`: channels and `CtApi`;
  - `src/preload/index.ts`;
  - `src/main/ipc-guards.ts`: `isBrowserPanelAction`, `isPanelRect`;
  - `src/renderer/side-panel.ts`: the `browser` tab, label `Browser`, `MAX_SHARE` 0.85, unavailable by default;
  - `src/renderer/keymap.ts`: `toggleBrowser`, Ctrl+Shift+B / ⌘B, and its label;
  - `src/renderer/main.ts`: construct `BrowserPanel`, availability = a local Claude tab in front, the `toggleBrowser` action, the open-panel event.
- Test:
  - `tests/e2e/browser-helpers.ts` (new): `startSiteServer()`, `browserCmd()`;
  - `tests/e2e/browser.spec.ts` (new);
  - extend `tests/unit/ipc-guards.test.ts`.

**Interfaces:**
- Consumes: Tasks 2–8.
- Produces:

```ts
// browser-hub.ts
export interface Rect { x: number; y: number; width: number; height: number }
export interface BrowserHubDeps {
  window(): BrowserWindow | null
  profiles: BrowserProfilesStore
  isLocalClaudeTab(tabId: string): boolean
  forkParent(tabId: string): string | null
  signal(tabId: string): void                 // attention.notify(tabId,'permission') only: no startAttention, no remote ring
  sendState(state: BrowserPanelState): void
  sendClosed(tabId: string): void
  sendStill(tabId: string, dataUrl: string | null): void
  openPanel(tabId: string): void
  sessionChanged(): void
  downloadsDir(): string
  answerMs?: number
  log: { info(m: string): void; warn(m: string): void }
}
export class BrowserHub {
  constructor(d: BrowserHubDeps)
  command(msg: BrowserMessage, closed: AbortSignal): Promise<PipeResponse>
  action(tabId: string, a: BrowserPanelAction): void
  state(tabId: string): BrowserPanelState | null
  setBounds(tabId: string | null, rect: Rect | null): void   // the tab whose current page shows, and where; null hides all
  setCovered(covered: boolean): void
  removeTab(tabId: string): void
  saved(tabId: string): BrowserTabState | null
  restore(tabId: string, s: BrowserTabState): void
  profileRemoved(id: string): void
  dispose(): void
}
// tab-browser.ts
export class TabBrowser {
  constructor(tabId: string, profileId: string, d: TabBrowserDeps)
  run(command: BrowserCommand, closed: AbortSignal): Promise<PipeResponse>
  personAction(a: BrowserPanelAction): void
  state(): BrowserPanelState
  saved(): BrowserTabState | null
  currentView(): WebContentsView | null
  setProfile(profileId: string): void
  dispose(): void
}
```

`TabBrowserDeps` is the builder's internal interface between the hub and a tab: view creation, the gate, `changed`, `openPanel`, and the downloads dir.

- IPC (in `IPC`):
  - renderer → main: `browserBounds: 'browser:bounds'` (send: `tabId: string | null, rect: Rect | null`), `browserCovered: 'browser:covered'` (send: `boolean`), `browserAction: 'browser:action'` (send: `tabId, action`), `browserState: 'browser:state'` (invoke: `tabId` → `BrowserPanelState | null`);
  - main → renderer: `evBrowserState: 'ev:browser-state'`, `evBrowserClosed: 'ev:browser-closed'`, `evBrowserStill: 'ev:browser-still'`, `evBrowserOpen: 'ev:browser-open'`.
- `CtApi`: `browserBounds(tabId, rect)`, `browserCovered(covered)`, `browserAction(tabId, action)`, `browserState(tabId)`, `onBrowserState(cb)`, `onBrowserClosed(cb)`, `onBrowserStill(cb: (tabId: string, dataUrl: string | null) => void)`, `onBrowserOpen(cb: (tabId: string) => void)`.
- `BrowserHub.command`, in order:
  1. Refuse a tab that is not a local Claude tab, with the message from Global Constraints.
  2. Get or create the tab's `TabBrowser`: a fork starts on its parent's profile, otherwise on the default profile.
  3. Commands run one at a time per tab (a promise chain).
  4. If control is `person`, return the "took control" error. If the page has an open dialog and the op is not `handle_dialog`, return the "A dialog is open" error.
  5. Gate `navigate` (target URL, `open`) and every page command (current URL, `use`) with `SiteGate.check`.
  6. Run the command through `PageDriver` with the time limits.
  7. Return `{ ok: true, info: withFooter(...) }`, plus `image` for screenshots.
  8. The `closed` signal and `stop` abort the wait; an aborted command returns `Stopped by the person.`.
- `tabs` op:
  - `list` prints `<i>: <title> — <url>` for each page, with `*` for the current one. A page whose site is not allowed shows only `a page on <site>`.
  - `new`: a new page, opened at `url` if one is given; the URL goes through the gate.
  - `select` / `close` by index.
  - More than `MAX_PAGES` pages → error `At most 20 pages per tab.`
- Panel open: the first `navigate` of a tab calls `openPanel(tabId)`. The renderer opens the Browser panel only if that tab is in front and the person has not closed the panel since that tab's last `open` event.
- Views:
  - Create each page's view with the Global Constraints' webPreferences and attach `PageDriver` with `enable()` on creation.
  - A page's `setWindowOpenHandler` returns `deny` and opens the URL as a new page in the strip.
  - `will-navigate` refuses non-web schemes (`isWebUrl`).
  - The session's `setPermissionRequestHandler` and `setPermissionCheckHandler` deny everything except `clipboard-sanitized-write`.
  - `will-download` saves to `downloadsDir()` under a unique name and records the path for the next footer.
  - Per the Task 1 decision, views that are not shown stay working.
  - `setBounds` shows only the given tab's current view, at `rect` (rounded to integers).
  - `setCovered(true)` captures the shown view (`webContents.capturePage()` → `toDataURL()`), sends `evBrowserStill`, then hides the view; `false` shows the view again and sends `null`.
- Renderer `BrowserPanel` (`constructor(body: HTMLElement, tools: HTMLElement, panel: SidePanel, ct: CtApi)`, plus `show(tabId: string | null)`, `setState(s)`, `setStill(tabId, dataUrl)`, `closed(tabId)`):
  - Layout: the profile selector, the page strip, the navigation row (back, forward, reload, the address input, the `⋯` menu), the card and the control line, as drawn in the spec. With no page, the body shows `Claude can open pages here, or type an address above.`
  - The `⋯` menu: `Open DevTools` (only when `state.devtools` is true; it opens detached DevTools for the current page, per the Task 1 decision) and `Manage profiles…`. Tasks 11 and 16 add their own items.
  - The address input on Enter calls `normalizeAddress`. An invalid entry shakes the field and sends nothing.
  - It reports the body's rect (`getBoundingClientRect`, in CSS pixels) through `browserBounds` whenever it changes: a `ResizeObserver`, `sidePanel.onChange`, a window resize, and the shown tab changing. It sends `null` when the Browser panel is not the panel shown.
  - **Covered:** a `MutationObserver` on `document.body` (`childList`, `subtree`, `attributes: ['hidden','class']`) and the panel's own menu check whether any element matching `.menu, .remote-popover, .status-tasks, .account-scrim, .mcp-add-scrim, #lightbox:not([hidden]), #sessions:not([hidden]), #folder-dialog:not([hidden]), #plan-list:not([hidden])` intersects the body rect, and call `browserCovered` on each change.
  - While the Browser panel shows, `document.body` gets the class `browser-shown` and the CSS variable `--browser-panel-width`; `#toasts` moves left of the panel with `right: calc(var(--browser-panel-width) + 12px)`.
- Test mode in `index.ts` (`isTest`), before `app` is ready:
  - `app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.test 127.0.0.1')`;
  - `downloadsDir` = `join(dataDir, 'downloads')`;
  - `answerMs` from `CLAUDETERM_TEST_SITE_ANSWER_MS` when set.
- `tests/e2e/browser-helpers.ts`:
  - `startSiteServer(): Promise<{ port: number; url(path: string, host?: string): string; close(): Promise<void> }>` serves, on 127.0.0.1 port 0, the pages listed below.
  - `browserCmd(pipeName: string, tabId: string, command: object, timeoutMs = 60_000) => sendPipeMessage(pipeName, { v: 1, type: 'browser', tabId, command }, timeoutMs)`.

  The pages `startSiteServer` serves:
  - `/form`: input `#name`, button `Save` that writes `saved:<value>` into `#out`, title `Form`;
  - `/console`: `console.error('boom')` on load;
  - `/link`: a link `Other` to `http://other.test:<port>/page`;
  - `/redirect`: a 302 to `http://other.test:<port>/page`;
  - `/redirect2`: a 302 to `/redirect`;
  - `/page`: title `Other page`;
  - `/cookie`: shows the request's `Cookie` header in `#c`;
  - `/download`: a `Content-Disposition: attachment; filename=a.txt` response.

- [ ] **Step 1: Write the failing e2e tests** in `tests/e2e/browser.spec.ts`. Each test uses `launchClaudeTab` and `startSiteServer`, and closes both.
  - `navigates and snapshots a local page`: `browserCmd(navigate /form)` → ok, with info containing `- URL: http://127.0.0.1:<port>/form` and `- Title: Form`. Then `snapshot` → info containing `textbox` and `button "Save"` with a ref.
  - `clicks and types through refs`: type `Ada` into the textbox ref, click the `Save` ref, `wait_for {text:'saved:Ada'}` → ok.
  - `returns a screenshot image`: `screenshot` → response `image.mimeType === 'image/png'` and data longer than 1000 characters.
  - `reports console errors`: navigate `/console`, `console {onlyErrors:true}` → info containing `boom`.
  - `the panel shows the page`: after a navigate, the Browser panel opens (`#image-panel` showing the `Browser` title), the address input has the URL, and the strip shows one page titled `Form`.
  - `the person types an address`: type `127.0.0.1:<port>/page` + Enter into the address input; then `browserCmd(tabs {action:'list'})` lists `Other page`.
  - `two Claude tabs keep their own pages`: open a second Claude tab and navigate it to `/page`; tab 1's `tabs list` still shows `Form` only.
  - `closing the tab ends its pending command` (Review Focus 2): start `wait_for {time: 30}` and close the tab with `KEYS.closeTab` → the command resolves (ok false, or the `Stopped by the person.` text) within 5 s.
  - `a download is reported`: navigate `/form`, `evaluate {function:"() => { location.href = '/download' }"}`, then `snapshot` → info contains `Downloaded:`, and the file exists under the test data dir's `downloads`.
  - `the shortcut toggles the panel`: `Control+Shift+KeyB` / `Meta+KeyB` shows and hides the Browser panel.
  - In `ipc-guards.test.ts`: `isBrowserPanelAction` accepts each action shape and refuses unknown types, non-integer or negative indexes, a url over 8192 characters and an unknown answer. `isPanelRect` refuses `NaN`, negative sizes and values over 4000.
- [ ] **Step 2: Check the shortcut is free.** Confirm that Ctrl+Shift+B and ⌘B are mapped nowhere in `keymap.ts`, nor in the chat composer or the terminal key handling (`grep -rn "KeyB" src/renderer`). If either is taken, stop and report to the controller.
- [ ] **Step 3: Build and see the tests fail.** `npm run build`, then `npx playwright test tests/e2e/browser.spec.ts --project=e2e`. Expected: FAIL.
- [ ] **Step 4: Implement the main side.** Hub, tab browser, IPC, pipe handler, test-mode switches.
- [ ] **Step 5: Implement the renderer side.** Side panel tab, keymap, `BrowserPanel`, styles, wiring in `main.ts`.
- [ ] **Step 6: Build and run** `npm run typecheck`, `npm test` and the spec file. Expected: PASS.
- [ ] **Step 7: List the changed files.**

### Task 10: Permission cards, held navigations, Stop and Hand back

**Files:**
- Modify: `src/main/browser/tab-browser.ts`, `src/main/browser/browser-hub.ts` (held navigations, control state, the closed signal), `src/renderer/browser-panel.ts` (the card and the control line), `src/main/index.ts` (`signal` → `attention.notify(tabId, 'permission')` only)
- Test: `tests/e2e/browser-permission.spec.ts` (new)

**Interfaces:**
- Consumes: `SiteGate` (Task 6), `BrowserHub` and `TabBrowser` (Task 9).
- Produces no new public names.
- Behaviour:
  - **Held navigations:** while a Claude command of the tab runs, and for 3 s after it ends:
    - a main-frame `will-navigate`, `will-frame-navigate` (main frame only) or `will-redirect` to a URL the gate does not allow is prevented, and `gate.check(url, 'open')` runs. Allowed → `webContents.loadURL(url)`. Denied, timeout or stopped → the page stays where it was.
    - the window-open handler does the same before it opens a new page.
    - A held navigation's card blocks the tab's next command until it resolves, since commands are serialized behind it.
  - **Control line:** `claude` from a command's start until 5 s after its end; `idle` otherwise.
  - **Stop:** `stop` sets `person`. It calls `gate.stop(tabId)`, aborts the running command (its result becomes `Stopped by the person.`) and refuses new commands. `handBack` sets `idle`.
  - **Remote viewers:** the card's attention is never forwarded: `signal` must not call `startAttention` or `raiseAttention`.
  - **The card opens the panel:** a new card calls `openPanel(tabId)`. For a card, the renderer opens the Browser panel whenever that tab is in front, even if the person closed it before.

- [ ] **Step 1: Write the failing e2e tests.** The site server from Task 9; `CLAUDETERM_TEST_SITE_ANSWER_MS=3000` in the app env for the timeout test.
  - `asks before opening another site`: `navigate http://site.test:<port>/page`. The card shows `Claude wants to open site.test` with three buttons. While it waits, the command is not done. Click `Allow in this tab` → the command resolves ok with title `Other page`. A second `navigate http://site.test:<port>/form` needs no card.
  - `always allow is kept in the profile`: click `Always allow`. Then `browserProfiles` (after Task 11; for now read it through `app.evaluate` on the store file under the data dir) lists `site.test` for Default.
  - `deny refuses`: click `Deny` → ok false, error `The person did not allow site.test.`, and the page stays on its old URL.
  - `no answer times out`: wait 3 s → the error starts with `The person did not answer about site.test.` and the card is gone.
  - `holds a click that leaves the site`: on `/link`, snapshot and click `Other` → the card `Claude wants to open other.test` shows and the page URL is still `/link`. Deny → still `/link`.
  - `holds a redirect chain once` (Review Focus 1): `navigate /redirect2` → exactly one card (`other.test`). Allow → the title is `Other page`.
  - `a page the person opened asks on use`: the person types `site.test:<port>/page` in the address field (no card); then `snapshot` → the card says `Claude wants to use site.test`.
  - `stop takes control`: start `wait_for {time:20}` and click `Stop` → the command returns `Stopped by the person.`; the line shows `You have control`; a new `snapshot` returns the "took control" error. Click `Hand back to Claude` → `snapshot` works.
  - `a closed pipe drops the card` (Review Focus 3): send `navigate http://site.test:<port>/page` on a raw socket and destroy the socket before answering → the card goes away within 2 s, and a new command works.
  - `the card asks for attention here`: with a second tab in front, a card marks the browser's tab with the same tab mark a permission prompt gives (find the mark's selector in `tests/e2e/attention.spec.ts`). That the signal is not forwarded to paired devices is checked in code review: `signal` calls only `attention.notify(tabId, 'permission')`.
- [ ] **Step 2: Build and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Build and run the spec, plus Task 9's spec.** Expected: PASS.
- [ ] **Step 5: List the changed files.**

### Task 11: Profiles in the panel and in Settings, and session restore

**Files:**
- Create: `src/renderer/browser-settings.ts`
- Modify:
  - `src/renderer/settings-page.ts`: a `browser` tab labelled `Browser`, and `SECTIONS` gets `['browser','browser']`;
  - `src/shared/ipc.ts`: `SettingsSection` adds `'browser'`, and `isSettingsSection` with it;
  - `src/main/index.ts`: profile IPC; `manageProfiles` opens `settingsWindow.open('browser')`; save and restore;
  - `src/main/tab-manager.ts`: `snapshot(browserOf?: (tabId: string) => BrowserTabState | null)` adds `browser` when non-null (tested in `tests/unit/tab-manager.test.ts`);
  - `src/shared/types.ts`: `SessionSnapshotTab.browser?: BrowserTabState`;
  - `src/main/session-store.ts`: parse `browser` with `parseBrowserTabState`, Claude tabs only;
  - `src/main/browser/browser-hub.ts`: `setProfile`, `profileRemoved`, `restore`, `saved`;
  - `src/renderer/browser-panel.ts`: the profile selector and `Manage profiles…`.
- Test: `tests/e2e/browser-profiles.spec.ts` (new), extend `tests/unit/session-store.test.ts` and `tests/unit/tab-manager.test.ts` (if it exists; else the snapshot test that covers `snapshot()`).

**Interfaces:**
- Consumes: `BrowserProfilesStore` (Task 5), `BrowserProfilesView` / `BrowserProfileAction` / `BrowserTabState` (Task 3).
- Produces:
  - IPC `browserProfiles: 'browser:profiles'` (invoke → `BrowserProfilesView`), `browserProfileAction: 'browser:profile-action'` (invoke: action → `BrowserProfilesView`; a refused action returns the view unchanged), and `evBrowserProfiles: 'ev:browser-profiles'` (broadcast to every window on change).
  - `CtApi`: `browserProfiles()`, `browserProfileAction(a)`, `onBrowserProfiles(cb)`.
  - Guard `isBrowserProfileAction`.
- Behaviour:
  - **Settings › Browser** lists the profiles. Each row has: the name (rename in place), `Default` (a radio button), `Import cookies…` (disabled until Task 16), `Always allowed sites` (each with a `×` that sends `disallow`), `Clear data…` (confirm dialog → `clearData`: `session.clearStorageData()` and `clearCache()` on its partition) and `Delete` (not for `default`; confirm). An `Add profile` field and button sit under the list.
  - **Panel selector:** choosing another profile calls `setProfile`, which closes the tab's views and opens the same URLs in the new partition.
  - **Panel `⋯` menu:** `Clear this profile's data…` asks for confirmation in the panel, then sends `{type:'clearData'}`, which clears the tab's profile as Settings does.
  - **Delete:** `profileRemoved(id)` moves the tabs on it to `default` the same way and clears the partition's data.
  - **Save and restore:** the hub calls `sessionChanged()` on any page or profile change, and `index.ts` passes `(id) => browserHub.saved(id)` to `tabs.snapshot`. On restore, after a tab opens, `browserHub.restore(opened.id, t.browser)` runs; its pages are created on first show or first command. A restored profile that no longer exists becomes `default`.

- [ ] **Step 1: Write the failing tests.**
  - In `session-store.test.ts`: a snapshot with `browser:{profile:'default',pages:['http://localhost:1/'],current:0}` on a Claude tab round-trips. On a shell tab it is dropped. A bad `browser` value is dropped while the tab is kept.
  - E2E `profiles can be added, renamed and made default`, in Settings › Browser.
  - E2E `a tab's profile switch keeps the URLs`: navigate `/page`, choose `Work` in the panel; the page reloads (`tabs list` shows the same URL) and the panel shows `Work`.
  - E2E `cookies stay in their profile`: navigate `/form` in Default, `evaluate {function:"() => { document.cookie = 'k=default-1; path=/' }"}`; switch to `Work`, navigate `/cookie` → `#c` is empty; back to Default → `#c` shows `k=default-1`.
  - E2E `deleting a profile moves its tabs to Default` (Review Focus 5).
  - E2E `pages come back after a restart`: navigate two pages, close the app the way `tests/e2e/restore.spec.ts` does, relaunch with the same data dir → the tab's panel shows two pages, the second current. Then `tabs list` (which loads the page) shows the URLs.
  - E2E `the always list can be edited`: after `Always allow` for `site.test` (Task 10 flow), Settings lists it; `×` removes it; the next navigate asks again.
- [ ] **Step 2: Build and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Build; run `npm run typecheck`, `npm test` and the three browser e2e specs.** Expected: PASS.
- [ ] **Step 5: List the changed files.**

### Task 12: Encrypted cookie store

**Files:**
- Modify: `electron-builder.yml` (add `electronFuses: { enableCookieEncryption: true }` at the top level); `.github/workflows/ci.yml` (in the Linux and macOS packaging jobs that already run `electron-builder`, add a step that runs `npx @electron/fuses read --app <packaged binary>` and fails unless the output shows `EnableCookieEncryption is Enabled`); `README.md` (one sentence in the browser section, Task 17); `docs/` none.
- Test: `tests/unit/build-config.test.ts` (new)

- [ ] **Step 1: Write the failing test** `turns on cookie encryption for packaged builds`. It reads `electron-builder.yml` as text and expects it to match `/^electronFuses:\s*\n(?:[ \t]+.*\n)*?[ \t]+enableCookieEncryption:\s*true\s*$/m`.
- [ ] **Step 2: Run and see it fail.** `npx vitest run tests/unit/build-config.test.ts`
- [ ] **Step 3: Add the config and the CI step.**
  - Packaged binary paths, from the existing CI steps: Linux `dist/linux-unpacked/claudeterm`; macOS `dist/mac-arm64/ClaudeTerm.app` and `dist/mac/ClaudeTerm.app`.
  - Confirm `npx @electron/fuses read --help` works locally first. If the CLI's output wording differs, match what it prints for an enabled fuse.
  - Do not change Windows packaging beyond the shared config.
- [ ] **Step 4: Run the test.** Expected: PASS. Run `npx electron-builder --dir --win` locally only if time allows, and delete the `dist/` output after (AGENTS.md: no unrequested builds left behind).
- [ ] **Step 5: List the changed files.**

### Task 13: Import — cookie mapping

**Files:**
- Create: `src/main/browser-import/cookie-map.ts`
- Test: `tests/unit/cookie-map.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ImportedCookie { name: string; value: string; domain: string; hostOnly: boolean; path: string; secure: boolean; httpOnly: boolean; sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'; expires: number | null }
export interface CdpCookie { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; session?: boolean; sameSite?: 'Strict' | 'Lax' | 'None'; partitionKey?: unknown }
export interface FirefoxRow { name: string; value: string; host: string; path: string; expiry: number; isSecure: number; isHttpOnly: number; sameSite: number; originAttributes: string; isPartitionedAttributeSet?: number }
export const SESSION_COOKIE_DAYS = 30
export function fromChromium(c: CdpCookie, nowS: number): ImportedCookie | null   // null: partitioned or expired
export function fromFirefox(r: FirefoxRow, nowS: number): ImportedCookie | null   // null: container/partitioned or expired
export function toElectron(c: ImportedCookie, nowS: number): Electron.CookiesSetDetails
export function siteCount(cookies: ImportedCookie[]): number
```

- Rules:
  - `hostOnly` is true when `domain` / `host` does not start with `.`.
  - Chromium: `expires <= 0 || session` → `null` expiry. Otherwise `expires` in seconds; already past → skipped.
  - Firefox: `expiry > 100_000_000_000` is milliseconds (divide by 1000); `sameSite` 0 → `no_restriction`, 1 → `lax`, 2 → `strict`, anything else → `unspecified`; `originAttributes !== ''` or `isPartitionedAttributeSet === 1` → skipped.
  - `toElectron`:
    - `url = (secure ? 'https://' : 'http://') + domain-without-leading-dot + path`;
    - `domain` only when not host-only;
    - a `__Host-` cookie always has no domain and path `/`;
    - `SameSite=None` (`no_restriction`) without `secure` becomes `secure: true` with an https URL, since Chromium refuses it otherwise;
    - `expirationDate = expires ?? nowS + SESSION_COOKIE_DAYS * 86400`.
  - `siteCount` counts distinct `domain`s without the leading `.` and `www.`.

- [ ] **Step 1: Write the failing tests**, including `maps awkward cookies without failing` (Review Focus 4): a `__Host-sid` with domain `example.com`, a `.example.com` domain cookie, a `SameSite=None` cookie without `Secure`, an expired one (→ null), a host `127.0.0.1`, and a value `значение`. Assert each result exactly. Also: partitioned → null; the Firefox ms/s expiry; Firefox container → null; `siteCount` of `a.com`, `.a.com` and `www.a.com` → 1.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see them pass.**
- [ ] **Step 5: List the changed files.**

### Task 14: Import — source discovery and the Firefox reader

**Files:**
- Create: `src/main/browser-import/sources.ts`, `src/main/browser-import/firefox-reader.ts`, `src/main/browser-import/temp-copy.ts`
- Test: `tests/integration/browser-sources.int.test.ts`, `tests/integration/firefox-reader.int.test.ts`

**Interfaces:**
- Consumes: `FirefoxRow` / `fromFirefox` (Task 13); `findExecutable` (`src/main/login-env.ts`).
- Produces:

```ts
// sources.ts
export type BrowserKind = 'chrome' | 'edge' | 'brave' | 'vivaldi' | 'chromium' | 'firefox'
export interface BrowserBinary { file: string; args: string[]; env?: Record<string, string> }
export interface ImportSource { id: string; kind: BrowserKind; browser: string; label: string; family: 'chromium' | 'firefox'; userDataDir: string; profileDir: string; profileName: string; email: string | null; hasCookies: boolean; binary: BrowserBinary | null }
export interface SourceEnv { platform: NodeJS.Platform; home: string; appData: string | null; localAppData: string | null; programFiles: string[]; pathVar: string; isExecutable(path: string): boolean }
export function findSources(env: SourceEnv): Promise<ImportSource[]>
export function readLocalState(userDataDir: string): Promise<{ dir: string; name: string; email: string | null }[]>
export function readFirefoxProfiles(iniPath: string): Promise<{ dir: string; name: string }[]>
// temp-copy.ts
export function makePrivateTemp(prefix: string): Promise<string>   // mkdtemp under tmpdir(), mode 0o700 where supported
export function removeTemp(dir: string): Promise<void>              // rm -rf, never throws
export function copyIfExists(src: string, dst: string): Promise<boolean>
export const TEMP_PREFIX = 'ct-cookie-import-'
export function removeStaleTemps(): Promise<void>                   // deletes leftover TEMP_PREFIX* folders in tmpdir() at startup
// firefox-reader.ts
export function readFirefoxCookies(profileDir: string, nowS: number): Promise<{ cookies: ImportedCookie[]; skipped: number }>
```

- Locations, with `<L>` = `localAppData`, `<A>` = `appData` and `<H>` = `home`:
  - **Windows:**
    - Chrome `<L>\Google\Chrome\User Data`, Edge `<L>\Microsoft\Edge\User Data`, Brave `<L>\BraveSoftware\Brave-Browser\User Data`, Vivaldi `<L>\Vivaldi\User Data`, Chromium `<L>\Chromium\User Data`, Firefox `<A>\Mozilla\Firefox\profiles.ini`;
    - binaries: `<PF>\Google\Chrome\Application\chrome.exe` and `<L>\Google\Chrome\Application\chrome.exe`; `<PF>\Microsoft\Edge\Application\msedge.exe`; `<PF>\BraveSoftware\Brave-Browser\Application\brave.exe` and the same under `<L>`; `<L>\Vivaldi\Application\vivaldi.exe` and `<PF>\Vivaldi\Application\vivaldi.exe`; `<L>\Chromium\Application\chrome.exe`. `<PF>` is each of `programFiles`.
  - **macOS:**
    - `<H>/Library/Application Support/` + `Google/Chrome`, `Microsoft Edge`, `BraveSoftware/Brave-Browser`, `Vivaldi`, `Chromium`; Firefox `<H>/Library/Application Support/Firefox/profiles.ini`;
    - binaries: `/Applications/<App>.app/Contents/MacOS/<Exe>` and the same under `<H>/Applications`, for `Google Chrome`, `Microsoft Edge`, `Brave Browser`, `Vivaldi` and `Chromium`.
  - **Linux:**
    - `<H>/.config/` + `google-chrome`, `microsoft-edge`, `BraveSoftware/Brave-Browser`, `vivaldi`, `chromium`; Firefox `<H>/.mozilla/firefox/profiles.ini` and `<H>/snap/firefox/common/.mozilla/firefox/profiles.ini`;
    - binaries on `pathVar`: `google-chrome-stable` / `google-chrome`, `microsoft-edge-stable` / `microsoft-edge`, `brave-browser` / `brave`, `vivaldi-stable` / `vivaldi`, `chromium` / `chromium-browser`.
- Fields:
  - `id` = `<kind>:<profile dir name>`;
  - `label` = `Chrome · Work (name@example.com)`, without the parenthesis when there is no email;
  - `hasCookies`: Chromium `<profile>/Network/Cookies` exists; Firefox `cookies.sqlite` exists;
  - a Chromium source with no binary is still listed, with `binary: null`;
  - Firefox `profiles.ini`: `[ProfileN]` sections with `Name`, `Path` and `IsRelative`.
- Firefox reader: copy `cookies.sqlite` and its `-wal` / `-shm` into a private temp folder, open it with `new DatabaseSync(copy)` (not read-only: it is our copy), run `SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite, originAttributes FROM moz_cookies`, map each row with `fromFirefox`, and delete the copy in `finally`. Add `isPartitionedAttributeSet` to the select only when `PRAGMA table_info(moz_cookies)` lists it.

- [ ] **Step 1: Write the failing tests.**
  - Sources: build a fake tree under `mkdtempSync` for the current platform's layout (and run the Windows layout on every OS by passing `platform: 'win32'` with fake dirs):
    - a Chrome `User Data` with `Local State` naming two profiles (`Default`: `Person 1`; `Profile 1`: `Work`, `name@example.com`), each with `Network/Cookies`;
    - an Edge folder with no `Local State`, which is skipped;
    - a Firefox `profiles.ini` with one relative profile containing `cookies.sqlite`;
    - a fake `chrome.exe` under a fake `programFiles` dir.

    Expect the exact `ImportSource` list (ids, labels, `hasCookies`, `binary.file`).
  - Firefox reader:
    - create `cookies.sqlite` with `node:sqlite` in WAL mode (`PRAGMA journal_mode=WAL`) with the real `moz_cookies` columns. Insert, while the writing connection stays open, three invented rows: a normal one, a container row (`originAttributes '^userContextId=1'`) and an expired one. The rows must still be in the `-wal` file.
    - Read → exactly one cookie, `skipped: 2`.
    - The temp copy is gone afterwards (no `ct-cookie-import-*` left in `tmpdir()`).
    - `removeStaleTemps` deletes a planted `ct-cookie-import-x` folder.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see them pass.**
- [ ] **Step 5: List the changed files.**

### Task 15: Import — Chromium readers: "run the browser on a copy" (Part A) and "read the running browser" (Part B)

> **Changed 2026-11-18** (see the spec's "Result and the person's decision"): a copy cannot decrypt App-Bound `v20`
> cookies on Windows, so Chrome, Edge and Brave on `win32` are read from the running browser (Part B). Part A stays for
> Vivaldi and Chromium on Windows and every Chromium browser on macOS and Linux. Build Part A and Part B as two dispatches
> (15a, 15b); they share no file except `sources.ts`, which only 15b changes.

#### Part A (15a): the copy reader

**Files:**
- Create: `src/main/browser-import/cdp-pipe.ts`, `src/main/browser-import/chromium-reader.ts`
- Create: `tests/fixtures/stand-in-browser.mjs`
- Test: `tests/integration/chromium-reader.int.test.ts`, `tests/integration/real-chrome-import.int.test.ts` (opt-in)

**Interfaces:**
- Consumes: `ImportSource`, `BrowserBinary` and the temp helpers (Task 14); `CdpCookie` / `fromChromium` (Task 13); the launch switches decided after Task 1.
- Produces:

```ts
// cdp-pipe.ts — CDP over --remote-debugging-pipe: NUL-terminated JSON; parent writes child fd 3, reads child fd 4
export class CdpPipe {
  constructor(write: NodeJS.WritableStream, read: NodeJS.ReadableStream)
  send<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>
  close(): void
}
// chromium-reader.ts
export interface ChromiumReadDeps {
  spawn: typeof import('node:child_process').spawn
  copyFile(src: string, dst: string): Promise<void>      // rejects with code EBUSY/EPERM while the browser holds the file
  onWaiting(): void                                       // the browser holds its cookie file: ask the person to close it
  signal: AbortSignal
  retryMs?: number                                        // default 1000
  timeoutMs?: number                                      // default 120_000, counted after the copy is made
}
export function readChromiumCookies(source: ImportSource, nowS: number, deps: ChromiumReadDeps): Promise<{ cookies: ImportedCookie[]; skipped: number }>
```

- Steps inside `readChromiumCookies`:
  1. Make a private temp dir.
  2. Copy `<userDataDir>/Local State` and `<profileDir>/Network/{Cookies,Cookies-journal,Cookies-wal,Cookies-shm}` (those that exist) into `<temp>/<profile dir name>/Network/`. On EBUSY/EPERM/EACCES for `Cookies`, call `onWaiting()` once and retry every `retryMs` until it copies or `signal` aborts (→ throw `Error('cancelled')`).
  3. Spawn `binary.file` with `[...binary.args, '--user-data-dir=<temp>', '--profile-directory=<dir>', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--disable-background-networking', '--disable-component-update', <the Task 1 window switch>]`. Pass `stdio: ['ignore','ignore','ignore','pipe','pipe']` and `env: {...process.env, ...binary.env}`.
  4. `Storage.getCookies` (10 s limit), then `Browser.close`. Kill the process if it has not exited 3 s later.
  5. Map with `fromChromium` and delete the temp dir in `finally`, on every path.

  A missing binary throws `Error('<Browser> is not installed where ClaudeTerm looks for it')`. Error messages never contain a cookie.
- `tests/fixtures/stand-in-browser.mjs`: a Node script that:
  - parses `--user-data-dir` and `--profile-directory`;
  - exits 3 if `<udd>/Local State` is missing;
  - reads `<udd>/<profile>/Network/Cookies` as JSON (an array of `CdpCookie`, invented values);
  - answers `Storage.getCookies` with `{cookies}` and `Browser.close` with `{}` (then exits 0) on fd 4, reading fd 3 (NUL-delimited);
  - writes its argv as JSON to `<udd>/../stand-in-args.json`, so the test can check the switches;
  - if the env var `STAND_IN_HANG=1` is set, never answers.

- [ ] **Step 1: Write the failing tests** (binary = `{ file: process.execPath, args: [standInPath] }`):
  - `reads cookies through a copy`: the fake source's `Network/Cookies` holds two invented cookies, one expired → one imported, `skipped 1`; the switches include `--remote-debugging-pipe` and the profile dir; the temp folder is deleted.
  - `waits while the cookie file is held`: `copyFile` rejects with `EBUSY` twice, then works → `onWaiting` is called once and the read succeeds.
  - `cancel while waiting`: abort during the EBUSY loop → rejects `cancelled` and the temp is deleted.
  - `a hanging browser is ended`: `STAND_IN_HANG=1` → rejects within the 10 s limit and the child process is gone.
  - `missing binary`: rejects with the "not installed" text.
  - Opt-in `real-chrome-import.int.test.ts`: `describe.skipIf(process.env.CLAUDETERM_REAL_BROWSER_TEST !== '1')`. It finds the installed Chrome (or skips), creates a throwaway user data dir under `tmpdir()`, sets one invented cookie through CDP as in the Task 1 spike, closes Chrome, then imports with `readChromiumCookies` and expects that cookie back. It never touches the default profile.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see them pass.** Run the opt-in test once locally with `CLAUDETERM_REAL_BROWSER_TEST=1` on Windows, and report its result.
- [ ] **Step 5: List the changed files.**

#### Part B (15b): the live reader (Windows Chrome / Edge / Brave)

**Files:**
- Create: `src/main/browser-import/cdp-socket.ts`, `src/main/browser-import/live-reader.ts`, `tests/fixtures/stand-in-devtools.mjs`
- Modify: `src/main/browser-import/sources.ts` (live sources)
- Test: `tests/integration/live-reader.int.test.ts`, `tests/integration/browser-sources.int.test.ts` (extend)

**Interfaces:**

```ts
// sources.ts (extended)
export interface ImportSource { /* … as before … */ mode: 'copy' | 'live' }
//   win32 + kind chrome | edge | brave: ONE source per installed browser (its User Data folder exists):
//   id `<kind>:open`, label `<Browser> · open profiles`, family 'chromium', mode 'live', profileDir = userDataDir,
//   profileName = '', email = null, hasCookies = true, binary as found (null → the source is listed but unavailable).
//   Every other Chromium source keeps one source per profile with mode 'copy'; Firefox sources get mode 'copy'.
export function inspectUrl(kind: BrowserKind): string   // chrome://, edge://, brave:// + 'inspect/#remote-debugging'

// cdp-socket.ts — CDP over a WebSocket (Node's global WebSocket; no dependency)
export interface CdpSocket {
  send<T = unknown>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<T>
  close(): void
}
export function connectCdp(url: string, onPending: () => void, signal: AbortSignal): Promise<CdpSocket>
//   resolves on open; rejects with Error('refused') when the socket errors or closes before opening; calls onPending()
//   once if it is still not open after 1 s (the browser is showing its "Allow?" prompt); rejects Error('cancelled') on
//   abort; rejects Error('timeout') after 120 s. A send without an answer rejects after timeoutMs (default 30 s); all
//   pending sends reject when the socket closes. Messages that are not JSON objects are ignored.

// live-reader.ts
export interface OpenProfile { contextId: string; label: string }
export interface LiveReadDeps {
  readFile(path: string): Promise<string>                       // <userDataDir>/DevToolsActivePort
  connect(url: string, onPending: () => void, signal: AbortSignal): Promise<CdpSocket>
  openSetupPage(): void                                          // runs the browser with inspectUrl(kind)
  onStatus(s: { state: 'setup' } | { state: 'allow' }): void
  pickProfile(profiles: OpenProfile[]): Promise<string>          // the person's choice (a contextId); only when > 1
  signal: AbortSignal
  retryMs?: number                                               // default 1000
  setupTimeoutMs?: number                                        // default 600_000
}
export function readLiveCookies(source: ImportSource, nowS: number, deps: LiveReadDeps): Promise<{ cookies: ImportedCookie[]; skipped: number }>
export function profileLabel(pages: { title: string; url: string }[]): string   // `12 tabs: GitHub, Gmail, Jira`
```

- Steps inside `readLiveCookies`:
  1. Read `DevToolsActivePort`: line 1 a port 1..65535, line 2 a path matching `^/devtools/browser/[A-Za-z0-9._-]+$`;
     anything else counts as "not on". Connect to `ws://127.0.0.1:<port><path>`. When the file is missing or invalid, or
     the connection is refused: the first time call `openSetupPage()` and `onStatus({state:'setup'})`, then retry every
     `retryMs` until it connects, `signal` aborts (`Error('cancelled')`) or `setupTimeoutMs` passes
     (`Error('<Browser> did not offer a connection. Check that remote debugging is on.')`).
  2. `onPending` → `onStatus({state:'allow'})`.
  3. `Target.getTargets`; page targets (`type === 'page'`) grouped by `browserContextId` (targets without one are
     skipped). No group → `Error('Open a window of the profile in <Browser> first.')`. One group → it. Several →
     `pickProfile(groups)` (labels from `profileLabel`, in the order the groups first appear).
  4. Pick a page of that group (the first http(s) one, else the first), `Target.attachToTarget {targetId, flatten: true}`,
     `Network.getAllCookies` on that session (30 s), `Target.detachFromTarget {sessionId}`, then `close()` the socket in
     `finally` on every path. **Never** send `Browser.close`, `Page.navigate`, `Target.closeTarget` or anything that
     changes the person's browser.
  5. Map with `fromChromium`; `skipped` counts the nulls.
- Error messages never contain a cookie, a URL or a page title.
- `tests/fixtures/stand-in-devtools.mjs`: a Node script standing in for a running Chromium browser with remote debugging
  on. It parses `--user-data-dir=<udd>`, implements a minimal WebSocket server on `127.0.0.1:0` (HTTP upgrade with
  `Sec-WebSocket-Accept = base64(sha1(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'))`, masked client text frames with
  7/16/64-bit lengths, unmasked server text frames, a close frame answered and the socket ended), writes
  `<udd>/DevToolsActivePort` (`<port>\n/devtools/browser/stand-in`), and answers from `<udd>/stand-in-contexts.json`
  (`[{ contextId, pages: [{ targetId, title, url }], cookies: CdpCookie[] }]`, invented values): `Target.getTargets`,
  `Target.attachToTarget` (sessionId `s-<targetId>`), `Network.getAllCookies` on a session (that context's cookies),
  `Target.detachFromTarget`. It appends every method it receives to `<udd>/stand-in-methods.log`, delays its handshake
  answer by `STAND_IN_ALLOW_MS` ms when set (the "Allow?" prompt), and exits when its client closes or after 60 s idle.
  An argument `chrome://inspect/#remote-debugging` (or edge://, brave://) is appended to `<udd>/stand-in-opened.log`.

- [ ] **Step 1: Write the failing tests.**
  - Sources: on `platform: 'win32'` the fake Chrome `User Data` (two profiles in `Local State`) gives ONE source
    `chrome:open`, label `Chrome · open profiles`, mode `live`; a fake Vivaldi gives per-profile `copy` sources; on
    `linux` the same Chrome layout gives per-profile `copy` sources.
  - `profileLabel`: 12 pages with titles → `12 tabs: GitHub, Gmail, Jira`; a 40-character title is cut to 30 with `…`;
    chrome:// pages are not named; one page → `1 tab: …`; no web page → `3 tabs`.
  - Live reader against the stand-in (started by the test with `process.execPath`, stopped in `afterEach`):
    - `reads the only open profile`: one context with two invented cookies (one expired) → one imported, `skipped: 1`;
      the methods log contains `Target.attachToTarget`, `Network.getAllCookies`, `Target.detachFromTarget` and never
      `Browser.close`.
    - `asks which profile`: two contexts → `pickProfile` receives two labels; choosing the second returns its cookies.
    - `opens the setup page when remote debugging is off`: no `DevToolsActivePort` at first → `openSetupPage` is called
      once and status `setup` is reported; the test then starts the stand-in → the read completes.
    - `waits for Allow`: `STAND_IN_ALLOW_MS=1500` → status `allow` is reported, then the read completes.
    - `cancel while waiting for setup` → rejects `cancelled`.
    - `no open window` → rejects with `Open a window of the profile in Chrome first.`
    - `a stale DevToolsActivePort` (a port nothing listens on) counts as "not on" (setup opened).
    - `connectCdp`: a send with no answer rejects after its limit; closing the socket rejects pending sends; a non-JSON
      message is ignored.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see them pass.**
- [ ] **Step 5: List the changed files.**

### Task 16: Import flow and the import sheet

**Files:**
- Create: `src/main/browser-import/import-flow.ts`
- Modify:
  - `src/main/index.ts`: IPC; `removeStaleTemps()` at startup; test-mode source env;
  - `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc-guards.ts`;
  - `src/renderer/browser-settings.ts`: the `Import cookies…` sheet;
  - `src/renderer/browser-panel.ts`: `Import cookies…` in the `⋯` menu opens Settings › Browser.
- Test: `tests/unit/import-flow.test.ts`, `tests/e2e/browser-import.spec.ts` (new)

**Interfaces:**
- Consumes: Tasks 13–15, `ImportStatus` / `ImportSourceView` (Task 3), `partitionOf`.
- Produces:

```ts
export interface ImportFlowDeps {
  sources(): Promise<ImportSource[]>
  readFirefox(source: ImportSource): Promise<{ cookies: ImportedCookie[]; skipped: number }>
  readChromium(source: ImportSource, onWaiting: () => void, signal: AbortSignal): Promise<{ cookies: ImportedCookie[]; skipped: number }>
  // live sources (mode 'live', Task 15b): the flow passes its own hooks through to readLiveCookies
  readLive(source: ImportSource, hooks: Pick<LiveReadDeps, 'onStatus' | 'pickProfile' | 'signal'>): Promise<{ cookies: ImportedCookie[]; skipped: number }>
  setCookie(profileId: string, details: Electron.CookiesSetDetails): Promise<boolean>   // false: Electron refused it
  flush(profileId: string): Promise<void>
  status(s: ImportStatus): void
  platform: NodeJS.Platform
  now(): number
}
export class ImportFlow {
  constructor(d: ImportFlowDeps)
  start(sourceId: string, profileId: string): void   // one at a time; a second start while running is ignored
  pick(contextId: string): void                       // the person's answer to `pick-profile`; ignored otherwise
  cancel(): void
}
// src/shared/browser.ts (Task 3's file; this task extends it)
export type ImportStatus =
  | { state: 'idle' } | { state: 'waiting-close'; browser: string } | { state: 'importing' }
  | { state: 'setup'; browser: string } | { state: 'allow'; browser: string }
  | { state: 'pick-profile'; browser: string; profiles: { contextId: string; label: string }[] }
  | { state: 'done'; imported: number; sites: number; skipped: number; notes: string[] }
  | { state: 'failed'; error: string } | { state: 'cancelled' }
```

- Live sources (2026-11-18): `readLive` → `setup` / `allow` statuses from `onStatus`, `pick-profile` from `pickProfile`
  (resolved by `pick`, rejected by `cancel`), then `importing` and `done`. A live `done` adds the note
  `You can turn remote debugging off again on the same page.` The sheet shows `setup`/`allow` with a spinner and Cancel,
  and `pick-profile` as a list of buttons (`Which <Browser> profile?`, the labels, and the hint
  `To import another profile, open a window of it in <Browser>.`).
- IPC addition: `browserImportPick: 'browser:import-pick'` (send `contextId`, a string of at most 200 characters).
- Test mode addition: `CLAUDETERM_TEST_BROWSER_PLATFORM` (test mode only) sets the source env's `platform`, so the
  Windows live path runs on every OS. A live source's test binary is `{ file: process.execPath, args:
  [<CLAUDETERM_TEST_BROWSER_DEVTOOLS>, '--user-data-dir=<its userDataDir>'], env: { ELECTRON_RUN_AS_NODE: '1' } }`, so
  `openSetupPage` starts `tests/fixtures/stand-in-devtools.mjs`, which then offers the connection.

- IPC:
  - `browserImportSources: 'browser:import-sources'` (invoke → `ImportSourceView[]`, `available = hasCookies && (family === 'firefox' || binary !== null)`);
  - `browserImportStart: 'browser:import-start'` (send `sourceId, profileId`);
  - `browserImportCancel: 'browser:import-cancel'`;
  - `evBrowserImport: 'ev:browser-import'` (broadcast);
  - plus the `CtApi` methods.
- Statuses:
  - `waiting-close` with the browser name;
  - `importing`;
  - `done` with `imported`, `sites`, `skipped` (the readers' skips + refused `setCookie`s) and `notes`:
    - always `Sites that keep their sign-in outside cookies need you to sign in again here.`;
    - plus `Google sign-ins are not carried over: Chrome ties them to this computer.` when `platform === 'win32'` and the family is Chromium;
  - `failed` with the reader's message;
  - `cancelled`.
- The sheet shows these with the exact strings from Global Constraints. Its `From` select lists unavailable sources disabled; `Cancel` sends `browserImportCancel`.
- Test mode: the source env comes from `CLAUDETERM_TEST_BROWSER_ROOT` as `{home: <root>/home, appData: <root>/appdata, localAppData: <root>/localappdata, programFiles: [<root>/programfiles], pathVar: ''}`. With no root there are no sources at all. Every Chromium source's binary is `{ file: process.execPath, args: [<CLAUDETERM_TEST_BROWSER_STANDIN>], env: { ELECTRON_RUN_AS_NODE: '1' } }`.

- [ ] **Step 1: Write the failing tests.**
  - Unit (fake deps):
    - a Firefox import of 3 cookies with 1 refused by `setCookie` → `done {imported:2, sites:..., skipped:1}`, and on `win32` the notes are only the outside-cookies note;
    - a Chromium import on `win32` adds the Google note, and on `darwin` it does not;
    - `onWaiting` → status `waiting-close` with `Chrome`;
    - `cancel` while waiting → `cancelled`;
    - a reader error → `failed` with its message;
    - a second `start` while running is ignored.
    - live: `onStatus({state:'setup'})` → status `setup` with `Chrome`; `allow` likewise; `pickProfile` → status
      `pick-profile` with the labels, and `pick('c2')` resolves it with `c2`; `cancel` during `pick-profile` →
      `cancelled`; a live `done` has the remote-debugging note (and on `win32` the Google note).
  - E2E `imports from a running Chrome (live)`: `CLAUDETERM_TEST_BROWSER_PLATFORM=win32`, a fake Chrome `User Data`
    (`Local State` with two profiles) and a `stand-in-contexts.json` with two contexts (pages with invented titles; one
    invented cookie `live=live-value-1` for `127.0.0.1` in the second) → in Settings › Browser › Work, `Import cookies…`,
    pick `Chrome · open profiles`, `Import` → the setup text shows, then `Which Chrome profile?` with two labels → pick the
    second → `Imported 1 cookies for 1 sites.` and `You can turn remote debugging off again on the same page.`; a Claude
    command `navigate /cookie` in a tab on Work shows `live=live-value-1`; `stand-in-opened.log` names
    `chrome://inspect/#remote-debugging`; `stand-in-methods.log` has no `Browser.close`.
  - E2E `imports from Firefox into a profile`: lay out a fake Firefox profile (WAL `cookies.sqlite` with one invented cookie `ff=ff-value-1` for `127.0.0.1`, path `/`) under a temp root and launch with `CLAUDETERM_TEST_BROWSER_ROOT`. In Settings › Browser › Default, use `Import cookies…`, pick the source and press `Import` → `Imported 1 cookies for 1 sites.` Then a Claude command `navigate /cookie` shows `ff=ff-value-1` in `#c`.
  - E2E `imports from a Chromium browser into another profile`: a fake Chrome `User Data` with a `Network/Cookies` JSON for the stand-in, and `CLAUDETERM_TEST_BROWSER_STANDIN` set → import into `Work`; the cookie shows on `/cookie` in a tab on `Work` and not in one on `Default`.
  - E2E `no sources outside test roots`: launched without `CLAUDETERM_TEST_BROWSER_ROOT`, the sheet lists no source and shows `No browsers found.`.
- [ ] **Step 2: Build and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Build; run `npm run typecheck`, `npm test` and all the browser e2e specs.** Expected: PASS.
- [ ] **Step 5: List the changed files.**

### Task 17: Docs and the full check

**Files:**
- Modify: `README.md`: a short "Browser" section.

The section says:
- what the panel does;
- that Claude uses it through `browser_*` tools;
- the per-site permission and its residual risk, with the spec's wording;
- profiles;
- cookie import, with the Windows close-the-browser step and the Google note;
- that only cookies are imported;
- that the cookie store is encrypted in the installed app, and that on Windows another program running as the same user can still decrypt it.

No screenshots are regenerated in this task. If the person wants a README image, that is a separate request.

- [ ] **Step 1: Write the README section.**
- [ ] **Step 2: Run the full checks.** `npm run typecheck`, then `npm test`, then `npm run test:e2e`. Expected: all pass. On failure, fix in the owning task's files and rerun the full set.
- [ ] **Step 3: Clean up** what the work made and no longer needs: scratch folders, `dist/`, `out/` from builds (they are ignored, so leave `out/`), and processes started (the app, servers). Check that no `ct-cookie-import-*` or spike folder is left in the temp folder.
- [ ] **Step 4: Report to the controller.** List the changed files and the check results. macOS and Linux are verified by CI after the person pushes. Say so; do not claim them.
