# Linux Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ClaudeTerm runs on Linux x64 desktops (Debian/Ubuntu family) with the features it has on Windows — shell and Claude tabs, status bar, notifications, the image panel, session restore, recent sessions, auto-update — and every release ships a `.deb` next to the Windows installer.

**Architecture:** Windows code paths stay as they are. Each place that assumed Windows gets a second branch picked by `process.platform === 'win32'`; pure functions take the platform (or the `node:path` flavour, `win32` / `posix`) as a parameter defaulting to the running one, so both branches are unit-tested on either OS. The named pipe becomes a Unix socket, the `.cmd` hook wrapper a `.sh`, `where.exe` / PowerShell / WSL lookups become `/etc/shells` and login-shell lookups, PowerShell's SoundPlayer becomes `paplay` / `pw-play` / `aplay`, and the scratchpad is found where Claude Code puts it on Linux. CI runs typecheck, unit, integration and e2e tests on Ubuntu as well, and the release workflow adds the `.deb`.

**Tech Stack:** Electron 44 (Node 22.23 inside), node-pty 1.1.0 (no Linux prebuild: `npm ci` compiles it; N-API, so the Node build works in Electron), xterm.js 6, recursive `fs.watch` (on Linux Node builds it from one inotify watch per file and folder), electron-builder 26 (`deb` target), electron-updater 6 (`DebUpdater`), Vitest, Playwright Electron, GitHub Actions `ubuntu-latest`.

**Spec:** no separate spec — the user asked for this plan straight after a feasibility review in chat ("пока только линукс, делай план"), and asked to bring it up to date after 0.1.7 ("там поменялась логика актуализируй план"). The decisions it rests on are in **Design decisions** below; review those first.

## What changed since the first draft (0.1.7)

- **The image panel follows the conversation** (user's standing decision): its sources are the transcript, `show_image` and the session's scratchpad. The project folder is never watched — so no project-folder work is needed on Linux, and nothing in this plan may bring it back.
- **The watcher is one recursive `fs.watch`** on the scratchpad (chokidar is gone). On Linux, Node implements it in JavaScript: an inotify watch per file and folder, a `readdirSync` of a folder on each of its changes, and the watched folder's own deletion reported as an empty file name (`''`). The events it raises for files already there fire inside `watch()`, before `fs.watch` attaches the listener, so they are lost, as on Windows: an image already in the scratchpad is reported only once it changes. Windows reports that deletion as `\\?\D:\…`, which `isRootGoneEvent` knows; `''` it does not → Task 2.
- **Release notes come from `CHANGELOG.md`** (`scripts/release-notes.mjs`, `--notes-file`); the release workflow in Task 10 keeps that, and the version that ships Linux needs its changelog lines.

## Design decisions

1. **Scope:** Linux x64 only. No macOS work: code branches on "Windows or not", nothing claims Mac support.
2. **Package:** `.deb` only (Debian, Ubuntu, Mint, Pop!_OS…). It installs to `/opt/ClaudeTerm`, links `/usr/bin/claudeterm`, adds a menu entry and electron-builder's AppArmor profile (needed on Ubuntu 24.04+). **AppImage is deferred:** its AppRun puts `--no-sandbox` *before* the arguments when user namespaces are restricted (Ubuntu 24.04), which breaks `ELECTRON_RUN_AS_NODE` (Node rejects the option, so the MCP server would not start), and its mount path changes on every start, so the registered MCP server would point at a path that no longer exists. rpm is deferred too.
3. **Updates:** electron-updater's `DebUpdater` installs the downloaded `.deb` through `pkexec`/`sudo`, which asks for the password. On Linux an update therefore installs only when the user clicks the banner's restart button, never silently on quit.
4. **Socket:** `$XDG_RUNTIME_DIR/claudeterm-<user>.sock`; without an absolute `XDG_RUNTIME_DIR`, `/tmp/claudeterm-<uid>/claudeterm-<user>.sock` in a folder ClaudeTerm creates with mode 0700 and refuses to use unless only this user can access it. A socket file left by a crash is removed at start (the single-instance lock means no other ClaudeTerm of this user listens there); anything at that path that is not a socket is never removed.
5. **Hook wrapper:** `session-hook.sh` — `#!/bin/sh`, `ELECTRON_RUN_AS_NODE=1 '<exe>' '<script>' "$@"`, `exit 0`, mode 0755.
6. **Shells:** profiles are named after the program. The login shell (passwd entry, else `$SHELL`) comes first, then `bash`, `zsh`, `fish` found in `/etc/shells` or in `/bin`, `/usr/bin`, `/usr/local/bin`; one profile per name, each started as a login shell (`-l`). "Automatic" = the first profile = the login shell. Claude tabs: bash `--login -i -c '<claude…>; exec bash --login -i'`, zsh `-l -i -c '<claude…>; exec zsh -l -i'`, fish `-l -C '<claude…>'` (fish runs the init command and stays interactive).
7. **Finding claude:** a desktop-launched app does not get the PATH that `~/.bashrc` / `~/.zshrc` build (nvm, the Claude Code installer's `~/.local/bin`). ClaudeTerm asks the login shell once — `$SHELL -l -i -c 'printf …"$PATH"…'` (fish without `-i`), stdin closed, killed after 10 s — looks for an executable `claude` on that PATH (else on its own), and runs `claude mcp …` with that PATH, so an npm-installed claude finds `node`.
8. **Sounds:** "System sound" plays `/usr/share/sounds/freedesktop/stereo/message-new-instant.oga` when it exists, else Electron's beep. A file plays with the first of `paplay`, `pw-play`, `aplay` found on PATH (`aplay` for `.wav` only). The settings file still accepts `.wav` only.
9. **The scratchpad** (the only folder watched for images): Linux `<CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>/<project key>/<session id>`; Windows `<CLAUDE_CODE_TMPDIR or %TEMP%>\claude\<project key>\<session id>` (Windows now honours `CLAUDE_CODE_TMPDIR` too). Read from the Claude Code 2.x binary (`join(CLAUDE_CODE_TMPDIR, \`claude-${getuid()}\`)`); the `/tmp` default is confirmed on a real machine in Task 10.
10. **Watching it on Linux:** the same recursive `fs.watch`. An empty file name means the scratchpad itself was deleted: the watcher lets go and waits for it to come back, as it does on Windows.
11. **Killing a tab:** Windows ends every program of the console at once. On Linux SIGHUP reaches the shell, which passes it on; the programs it ran (claude) save and quit by themselves. The PTY's exit is reported only when no live process of its session is left, or after 2 s, so a restart never runs two Claude Code processes on one conversation. Nothing is SIGKILLed: `nohup` jobs survive, as in any Linux terminal.
12. **Image paste key:** Claude Code reads a clipboard image on Alt+V on Windows and on Ctrl+V elsewhere; ClaudeTerm's smart paste sends the right one.
13. **Paths:** Linux paths compare with case, Windows paths without.
14. **Explorer's "Open Claude Code here"** stays Windows-only; `claudeterm --claude <dir>` works on Linux.
15. **xterm's `windowsPty`** (ConPTY reflow heuristics) is set on Windows only.

## Global Constraints

- Windows behaviour and every existing Windows test stay as they are. Windows-only test steps are marked `it.runIf(WIN)` / `describe.runIf(WIN)`, never deleted; Linux-only ones `runIf(!WIN)`.
- Branch on `process.platform === 'win32'`; no `darwin` branches.
- No new dependencies.
- The image panel's sources stay the transcript, `show_image` and the scratchpad: nothing watches or scans the project folder (user's standing decision).
- UI strings on Linux: `System sound` (Windows keeps `Windows default`), `(your login shell)` (Windows keeps `(PowerShell 7 if installed, else Windows PowerShell)`).
- Package file `ClaudeTerm-${version}.deb`, executable `claudeterm`, update feed `latest-linux.yml`.
- Constants: `SESSION_EXIT_WAIT_MS = 2000`; login-shell PATH lookup limit 10 000 ms; marker `__CLAUDETERM_PATH__`.
- **No commits.** The user's global rule: leave every change in the working tree and, at the end, list what is ready to commit. Subagents must not commit either. (Where the template says "Commit", this plan says "Leave uncommitted".)
- **No local installer builds** (user's standing rule): the `.deb` is built by CI only. No version bump or tag either — releasing is the user's call.
- Release notes are hand-written `CHANGELOG.md` sections (user's standing rule), never commit lists.
- Each task is checked on Windows (this checkout) **and** on the Linux bench below.

## Review Focus

1. ClaudeTerm started from the desktop menu while `claude` lives under nvm or `~/.local/bin`, which only `~/.bashrc` adds to PATH — claude is found, the MCP server registered, no "claude not found" toast. → Task 6, test "finds claude on the login shell PATH, not the app PATH".
2. The previous run crashed and left its socket file — the next start listens normally. → Task 3, test "a socket left behind is replaced".
3. Restarting a Claude tab while the old claude is still saving after SIGHUP — the new one starts only after the old one is gone. → Task 8, integration test "kill() reports the exit once the programs the shell started have quit".
4. The scratchpad is deleted and created again (a session folder cleared, `/clear`) — images keep arriving, and the watcher neither spins nor goes deaf. → Task 2, `isRootGoneEvent('')` and the Linux run of `tests/integration/image-watcher.int.test.ts`.
5. The login shell's startup files print a banner or wait for an answer (an oh-my-zsh update prompt) — the PATH lookup still returns, within 10 s, and never hangs startup. → Task 6, `parseMarkedPath` test and the Linux integration test "a startup file that prints and waits for input".

## Linux bench (once, before Task 1)

Work happens in this Windows checkout. A copy in WSL Ubuntu runs the Linux side; `rsync` copies the working tree, uncommitted changes included, without the Windows-built `node_modules`. This machine has no Ubuntu distribution in WSL yet (only `docker-desktop`).

- [ ] **Step 1 (the user, elevated PowerShell; the first time may need a reboot):** `wsl --install -d Ubuntu-24.04`, then open Ubuntu once and create the Linux user.
- [ ] **Step 2: tools, Node 22 and the sync script** — in Ubuntu:

```bash
sudo apt-get update
sudo apt-get install -y build-essential python3 rsync curl xvfb
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
cat > ~/ct-sync.sh <<'EOF'
#!/bin/sh
# the Windows working tree, uncommitted changes included, without its Windows-built node_modules
exec rsync -a --delete --exclude node_modules --exclude out --exclude dist --exclude test-results --exclude .git /mnt/d/Workspace/ClaudeTerm/ "$HOME/ClaudeTerm/"
EOF
chmod +x ~/ct-sync.sh
~/ct-sync.sh && cd ~/ClaudeTerm && npm ci && npx playwright install-deps chromium
```

`npm ci` compiles node-pty; `playwright install-deps chromium` installs the libraries Electron needs as well.

- [ ] **Step 3: baseline** — from Windows:

```
wsl -d Ubuntu-24.04 -- bash -lc '~/ct-sync.sh && cd ~/ClaudeTerm && npx vitest run'
```

Note the failures; they are the platform-bound tests Tasks 1–4 and 8 deal with.

**Notation used below:** `LINUX <command>` means
`wsl -d Ubuntu-24.04 -- bash -lc '~/ct-sync.sh && cd ~/ClaudeTerm && <command>'`.
Electron on the bench (and in CI) needs `ELECTRON_DISABLE_SANDBOX=1`: neither has a setuid sandbox helper.

---

## File Structure

- Create `src/main/path-key.ts` — `nativePath`, `pathKey`, `isWindowsPath`.
- Create `src/main/socket-file.ts` — `prepareSocket` (private folder, stale socket).
- Create `src/main/login-env.ts` — login-shell PATH, `findExecutable`, `isExecutableFile`.
- Create `src/main/pty-session.ts` — `/proc` session scan, `waitSessionGone`.
- Modify `src/main/image-hub.ts` — path flavour for keys and relative paths.
- Modify `src/main/image-watcher.ts` — `claudeTempRoot`, `sessionTempDir` per platform, `isRootGoneEvent('')`.
- Modify `src/shared/protocol.ts` — `PipeContext`, `socketDir`, `defaultPipeName` per platform.
- Modify `src/main/claude-tab-settings.ts` — `.sh` wrapper, `hookPath`.
- Modify `src/main/profiles.ts`, `src/shared/types.ts` — POSIX detection, zsh/fish, `loginShell`, `detectInstalledProfiles`.
- Modify `src/main/mcp-registrar.ts` — runner options, `resolveClaudePosix`, `ClaudeCli.env`, `resolve` option.
- Modify `src/main/sound.ts` — player per platform, system sound file.
- Modify `src/main/pty-host.ts` — wait for the session after a kill.
- Modify `src/main/update-backend.ts` — `installOnQuit`.
- Modify `src/main/index.ts` — wiring for all of the above.
- Modify `src/shared/ipc.ts`, `src/preload/index.ts` — `CtApi.platform`, `AppInfo.windowsBuild: number | null`.
- Modify `src/renderer/settings-page.ts`, `src/renderer/terminal-view.ts`, `src/renderer/main.ts`, `src/renderer/keymap.ts`, `src/renderer/util.ts`.
- Tests: create `tests/fixtures/platform.ts`, `tests/unit/path-key.test.ts`, `tests/unit/socket-file.test.ts`, `tests/unit/login-env.test.ts`, `tests/unit/pty-session.test.ts`, `tests/integration/login-env.int.test.ts`; modify the unit, integration and e2e tests named in each task.
- Build and docs: `electron-builder.yml`, `package.json`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`.

---

### Task 1: Paths compare by the platform's rules

**Files:**
- Create: `src/main/path-key.ts`, `tests/fixtures/platform.ts`, `tests/unit/path-key.test.ts`
- Modify: `src/main/image-hub.ts`, `src/main/index.ts`
- Test: `tests/unit/image-hub.test.ts`, `tests/unit/session-history.test.ts`, `tests/unit/protocol.test.ts`

**Interfaces:**
- Produces: `nativePath: PlatformPath`, `pathKey(p: string, path?: PlatformPath): string` (`src/main/path-key.ts`); `WIN: boolean` (`tests/fixtures/platform.ts`); `ImageHubOptions.path?: PlatformPath`; `cardId(tabId: string, file: string, path?: PlatformPath): string`; `relPathOf(cwd: string, file: string, tempDir?: string | null, path?: PlatformPath): string`. `normalizeKey` is removed (replaced by `pathKey`).

- [ ] **Step 1: Write the fixture and the failing tests**

`tests/fixtures/platform.ts`:

```ts
/** true when the tests run on Windows; for the steps only one platform can run */
export const WIN = process.platform === 'win32'
```

`tests/unit/path-key.test.ts`:

```ts
import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pathKey } from '../../src/main/path-key'

describe('pathKey', () => {
  it('Windows paths compare without case and separator style', () => {
    expect(pathKey('D:\\Proj\\Plot.PNG', win32)).toBe(pathKey('d:/proj/plot.png', win32))
  })

  it('Linux paths keep their case and are normalized', () => {
    expect(pathKey('/proj/Plot.png', posix)).not.toBe(pathKey('/proj/plot.png', posix))
    expect(pathKey('/proj//out/../plot.png', posix)).toBe('/proj/plot.png')
  })
})
```

`tests/unit/image-hub.test.ts` — the existing tests use Windows paths, so they say so; add a Linux twin:

```ts
import { posix, win32, type PlatformPath } from 'node:path'
// …
function hub(maxItems = 200, path: PlatformPath = win32) {
  const onChange = vi.fn()
  let t = 1000
  return { h: new ImageHub({ maxItems: () => maxItems, onChange, now: () => ++t, path }), onChange }
}
```

Add to `describe('ImageHub')`:

```ts
  it('on Linux, paths that differ only in case are two images', () => {
    const { h } = hub(200, posix)
    h.addTab('t1', '/proj')
    h.add('t1', '/proj/plot.png', 'shown', null)
    h.add('t1', '/proj/Plot.png', 'shown', null)
    expect(h.list('t1').map((c) => c.relPath)).toEqual(['Plot.png', 'plot.png'])
  })
```

In `describe('helpers')` pass `win32` as the last argument of every existing `cardId(…)` and `relPathOf(…)` call — `relPathOf('D:\\proj', 'D:\\proj\\out\\a.png')` becomes `relPathOf('D:\\proj', 'D:\\proj\\out\\a.png', null, win32)`, `relPathOf('D:\\proj', 'C:\\T\\sid\\scratchpad\\a.png', 'C:\\T\\sid')` becomes `relPathOf('D:\\proj', 'C:\\T\\sid\\scratchpad\\a.png', 'C:\\T\\sid', win32)` — and add:

```ts
  it('on Linux, case counts in card ids, and scratchpad paths are shortened too', () => {
    expect(cardId('t1', '/a.png', posix)).not.toBe(cardId('t1', '/A.png', posix))
    expect(relPathOf('/proj', '/proj/out/a.png', null, posix)).toBe('out/a.png')
    expect(relPathOf('/proj', '/tmp/claude-1000/-proj/sid/scratchpad/a.png', '/tmp/claude-1000/-proj/sid', posix)).toBe('scratchpad/a.png')
    expect(relPathOf('/proj', '/other/a.png', '/tmp/claude-1000/-proj/sid', posix)).toBe('/other/a.png')
  })
```

`tests/unit/session-history.test.ts` — the in-memory file system splits on `\`, which only matches `join` on Windows:

```ts
import { join, sep } from 'node:path'
import { WIN } from '../fixtures/platform'
// in memFs.readdir:
      const prefix = dir + sep
      // …
      for (const p of Object.keys(files)) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split(sep)[0])
```

In the first `SessionHistory` test replace `` file('D--b', `${SID2}\\subagents\\agent-1.jsonl`) `` with `file('D--b', join(SID2, 'subagents', 'agent-1.jsonl'))`. Append ` (Windows folders)` to the title of `'a first message longer than both windows with nothing before it: the folder comes from the tail, mapped back to the project folder'` and change its `it(` to `it.runIf(WIN)(` — it walks `D:\a\sub` up with the platform's `dirname`. Add its Linux twin:

```ts
  it.runIf(!WIN)('a first message longer than both windows with nothing before it: the folder comes from the tail, mapped back to the project folder (Linux folders)', async () => {
    const image = { type: 'user', message: { role: 'user', content: [{ type: 'image', source: { data: 'i'.repeat(TAIL_BYTES + 50_000) } }, { type: 'text', text: 'what is this' }] }, cwd: '/a', entrypoint: 'cli', isSidechain: false }
    const text = jsonl(image, attachment('/a/sub'), { type: 'last-prompt', lastPrompt: 'what is this' })
    const { fs } = memFs({ [file('-a', `${SID1}.jsonl`)]: { text, mtimeMs: 7 } })
    expect(await new SessionHistory(ROOT, fs).list(10)).toEqual([
      { id: SID1, cwd: '/a', title: null, firstPrompt: null, lastPrompt: 'what is this', modifiedAt: 7 }
    ])
  })
```

`tests/unit/protocol.test.ts` — `parsePipeMessage` checks paths with the platform's `isAbsolute`, so the sample paths must be absolute where the test runs:

```ts
import { WIN } from '../fixtures/platform'

const PLOT = WIN ? 'D:\\proj\\out\\plot.png' : '/proj/out/plot.png'
const A_PNG = WIN ? 'C:\\a.png' : '/a.png'
const TP = WIN ? 'C:\\Users\\u\\.claude\\projects\\D--x\\s.jsonl' : '/home/u/.claude/projects/-x/s.jsonl'
const EVIL = WIN ? 'C:\\x\\evil.exe' : '/x/evil.exe'
```

Use them in place of the literals `'D:\\proj\\out\\plot.png'`, `'C:\\a.png'`, the `tp` constant and `'C:\\x\\evil.exe'`. Leave `'out\\a.png'` (relative on both platforms).

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/unit/path-key.test.ts tests/unit/image-hub.test.ts`
Expected: FAIL — `path-key` cannot be resolved; the `posix` hub test sees one card.
Run: `LINUX npx vitest run tests/unit/session-history.test.ts tests/unit/protocol.test.ts`
Expected: PASS — these two need test edits only; a failure here means a test edit is wrong.

- [ ] **Step 3: Implement**

`src/main/path-key.ts`:

```ts
import { posix, win32, type PlatformPath } from 'node:path'

/** node:path of the platform the app runs on. Functions take the flavour as a parameter, so tests can run both anywhere. */
export const nativePath: PlatformPath = process.platform === 'win32' ? win32 : posix

/** A path as a map key: Windows paths compare without case, Linux paths with it. */
export function pathKey(p: string, path: PlatformPath = nativePath): string {
  const n = path.normalize(p)
  return path.sep === '\\' ? n.toLowerCase() : n
}
```

`src/main/image-hub.ts` — replace the `node:path` import, `normalizeKey`, `cardId` and `relPathOf`, and add the option:

```ts
import { createHash } from 'node:crypto'
import type { PlatformPath } from 'node:path'
import type { ImageCard, ImageSource } from '../shared/types'
import { nativePath, pathKey } from './path-key'

export interface ImageHubOptions {
  maxItems(): number
  onChange(tabId: string): void
  now?(): number
  /** the flavour of the image paths; the platform's own unless a test says otherwise */
  path?: PlatformPath
}

// … Feed and SOURCE_RANK unchanged …

export function cardId(tabId: string, file: string, path: PlatformPath = nativePath): string {
  return createHash('sha1').update(`${tabId}\0${pathKey(file, path)}`).digest('hex').slice(0, 20)
}

/** `file` inside the tab's folder or the session's temp folder, else in full */
export function relPathOf(cwd: string, file: string, tempDir: string | null = null, path: PlatformPath = nativePath): string {
  for (const root of tempDir ? [cwd, tempDir] : [cwd]) {
    const r = path.relative(root, file)
    if (r && !r.startsWith('..') && !path.isAbsolute(r)) return r
  }
  return file
}
```

In `class ImageHub` add

```ts
  private get paths(): PlatformPath {
    return this.o.path ?? nativePath
  }
```

and pass it on: every `cardId(tabId, path)` in the class → `cardId(tabId, path, this.paths)` (two calls today); in the new card, `basename(path)` → `this.paths.basename(path)` and `relPathOf(f.cwd, path, f.tempDir)` → `relPathOf(f.cwd, path, f.tempDir, this.paths)`.

`src/main/index.ts` — `import { pathKey } from './path-key'`; in `attachTranscript` replace
`if (!s || s.transcriptPath?.toLowerCase() === transcriptPath.toLowerCase()) return` with
`if (!s || (s.transcriptPath !== null && pathKey(s.transcriptPath) === pathKey(transcriptPath))) return`.

- [ ] **Step 4: Run the tests on both platforms**

Run: `npx vitest run tests/unit/path-key.test.ts tests/unit/image-hub.test.ts tests/unit/session-history.test.ts tests/unit/protocol.test.ts`
Run: `LINUX npx vitest run tests/unit/path-key.test.ts tests/unit/image-hub.test.ts tests/unit/session-history.test.ts tests/unit/protocol.test.ts`
Expected: PASS on both.

- [ ] **Step 5: Typecheck and leave uncommitted**

Run: `npm run typecheck` — no errors. Do not commit.

---

### Task 2: The scratchpad on Linux

**Files:**
- Modify: `src/main/image-watcher.ts`, `src/main/index.ts`
- Test: `tests/unit/image-watcher.test.ts`, `tests/integration/image-watcher.int.test.ts` (run on Linux, unchanged)

**Interfaces:**
- Consumes: `nativePath` (Task 1).
- Produces: `claudeTempRoot(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; tmpdir: string; uid: number }): string`; `sessionTempDir(transcriptPath: string, sessionId: string, claudeRoot: string, path?: PlatformPath): string` (the third argument is now Claude's own temp root, not the system temp folder); `isRootGoneEvent('')` is `true`.

- [ ] **Step 1: Write the failing tests** — in `tests/unit/image-watcher.test.ts` import `posix`, `win32` and `claudeTempRoot`; replace `describe('sessionTempDir')`:

```ts
describe('Claude Code temp folders', () => {
  it('Windows: <CLAUDE_CODE_TMPDIR or %TEMP%>\\claude', () => {
    expect(claudeTempRoot({ platform: 'win32', env: {}, tmpdir: 'C:\\Users\\me\\AppData\\Local\\Temp', uid: -1 })).toBe('C:\\Users\\me\\AppData\\Local\\Temp\\claude')
    expect(claudeTempRoot({ platform: 'win32', env: { CLAUDE_CODE_TMPDIR: 'E:\\t' }, tmpdir: 'C:\\T', uid: -1 })).toBe('E:\\t\\claude')
  })

  it('Linux: <CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid>, whatever TMPDIR says', () => {
    expect(claudeTempRoot({ platform: 'linux', env: {}, tmpdir: '/var/tmp', uid: 1000 })).toBe('/tmp/claude-1000')
    expect(claudeTempRoot({ platform: 'linux', env: { CLAUDE_CODE_TMPDIR: '/scratch' }, tmpdir: '/tmp', uid: 1000 })).toBe('/scratch/claude-1000')
  })

  it('a session folder is <root>/<project key>/<session id>', () => {
    expect(sessionTempDir('C:\\Users\\me\\.claude\\projects\\D--Workspace\\5d2c.jsonl', '5d2c', 'C:\\Users\\me\\AppData\\Local\\Temp\\claude', win32))
      .toBe('C:\\Users\\me\\AppData\\Local\\Temp\\claude\\D--Workspace\\5d2c')
    expect(sessionTempDir('/home/me/.claude/projects/-home-me-ws/5d2c.jsonl', '5d2c', '/tmp/claude-1000', posix)).toBe('/tmp/claude-1000/-home-me-ws/5d2c')
  })
})
```

In `describe('isRootGoneEvent')` add to the existing test:

```ts
    // Node's recursive watcher on Linux names the watched folder itself by its path relative to itself
    expect(isRootGoneEvent('')).toBe(true)
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/unit/image-watcher.test.ts`
Expected: FAIL — `claudeTempRoot` is not exported; `isRootGoneEvent('')` is `false`.
Run: `LINUX npx vitest run tests/integration/image-watcher.int.test.ts`
Expected: FAIL in `'lets go of a watched folder that is deleted, without burning CPU, and watches it again once it is back'` — on Linux the deletion arrives as `''`, the watcher never lets go and never watches the folder again.

- [ ] **Step 3: Implement** — `src/main/image-watcher.ts`: import `posix`, `win32`, `type PlatformPath` from `node:path` (next to the names already imported) and `nativePath` from `./path-key`; replace `isRootGoneEvent` and `sessionTempDir`, add `claudeTempRoot`:

```ts
/**
 * A recursive watcher names files relative to its folder; an absolute name (`\\?\D:\proj` on Windows), or an empty
 * one (Node's recursive watcher on Linux, the folder relative to itself), is the folder itself going away. On Windows
 * its handle then reports that again and again, thousands of times a second, until closed.
 */
export function isRootGoneEvent(filename: string | null): boolean {
  return filename !== null && (filename === '' || filename.startsWith('\\\\?\\') || isAbsolute(filename))
}

/**
 * Claude Code's own temp folder: <CLAUDE_CODE_TMPDIR or %TEMP%>\claude on Windows,
 * <CLAUDE_CODE_TMPDIR or /tmp>/claude-<uid> elsewhere (Claude Code ignores TMPDIR there).
 */
export function claudeTempRoot(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; tmpdir: string; uid: number }): string {
  if (o.platform === 'win32') return win32.join(o.env.CLAUDE_CODE_TMPDIR || o.tmpdir, 'claude')
  return posix.join(o.env.CLAUDE_CODE_TMPDIR || '/tmp', `claude-${o.uid}`)
}

/** A session's own folder in it, where its scratchpad lives: <root>/<project key>/<session id> */
export function sessionTempDir(transcriptPath: string, sessionId: string, claudeRoot: string, path: PlatformPath = nativePath): string {
  return path.join(claudeRoot, path.basename(path.dirname(transcriptPath)), sessionId)
}
```

`onEvent` already turns a name into a string (`String(filename)`), and `''` is not `null`, so the empty name reaches `isRootGoneEvent` as it is.

`src/main/index.ts` — import `claudeTempRoot` with the other watcher names; after `const imageCacheRoot = …` add

```ts
  const claudeRoot = claudeTempRoot({ platform: process.platform, env: process.env, tmpdir: tmpdir(), uid: process.getuid?.() ?? -1 })
```

and replace `sessionTempDir(transcriptPath, sessionId, tmpdir())` with `sessionTempDir(transcriptPath, sessionId, claudeRoot)`.

- [ ] **Step 4: Run the tests on both platforms**

Run: `npx vitest run tests/unit/image-watcher.test.ts tests/integration/image-watcher.int.test.ts`
Run: `LINUX npx vitest run tests/unit/image-watcher.test.ts tests/integration/image-watcher.int.test.ts`
Expected: PASS on both. The Linux watcher reports changes through a per-file inotify watch and new files through the folder's own watch (a `readdirSync` on each of its changes), never a nameless event — so the "burst" test passes there without the rescan path. If it does not, debug with superpowers:systematic-debugging before changing the watcher; the Windows behaviour must stay as it is.

- [ ] **Step 5: Typecheck and leave uncommitted**

Run: `npm run typecheck`. Do not commit.

---

### Task 3: A Unix socket instead of the named pipe

**Files:**
- Create: `src/main/socket-file.ts`, `tests/unit/socket-file.test.ts`
- Modify: `src/shared/protocol.ts`, `src/main/index.ts`, `tests/fixtures/platform.ts`
- Test: `tests/unit/protocol.test.ts`, `tests/integration/pipe.test.ts`, `tests/integration/session-hook.int.test.ts`

**Interfaces:**
- Consumes: `WIN` (Task 1).
- Produces: `PipeContext { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; uid: number }`, `currentPipeContext(): PipeContext`, `socketDir(ctx: PipeContext): string`, `defaultPipeName(username: string, ctx?: PipeContext): string` (`src/shared/protocol.ts`); `prepareSocket(path: string, o: { privateDir: string; uid: number }): void`; `testPipeName(tag: string): string` (`tests/fixtures/platform.ts`).

- [ ] **Step 1: Write the failing tests**

`tests/fixtures/platform.ts` becomes:

```ts
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** true when the tests run on Windows; for the steps only one platform can run */
export const WIN = process.platform === 'win32'

/** A fresh address for a test server: a named pipe on Windows, a socket file in the temp folder elsewhere (kept short: a socket path has ~100 bytes) */
export function testPipeName(tag: string): string {
  const id = randomUUID()
  return WIN ? `\\\\.\\pipe\\claudeterm-${tag}-${id}` : join(tmpdir(), `ct-${tag}-${id.slice(0, 8)}.sock`)
}
```

`tests/unit/protocol.test.ts` — replace the `defaultPipeName` test:

```ts
  it('defaultPipeName: a named pipe on Windows, with the user name sanitized', () => {
    expect(defaultPipeName('John Doe', { platform: 'win32', env: {}, uid: -1 })).toBe('\\\\.\\pipe\\claudeterm-John_Doe')
  })

  it('defaultPipeName: a socket in XDG_RUNTIME_DIR on Linux, else in a private folder in /tmp', () => {
    expect(defaultPipeName('John Doe', { platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1000' }, uid: 1000 })).toBe('/run/user/1000/claudeterm-John_Doe.sock')
    expect(defaultPipeName('jd', { platform: 'linux', env: {}, uid: 1000 })).toBe('/tmp/claudeterm-1000/claudeterm-jd.sock')
    expect(defaultPipeName('jd', { platform: 'linux', env: { XDG_RUNTIME_DIR: 'relative' }, uid: 1000 })).toBe('/tmp/claudeterm-1000/claudeterm-jd.sock')
  })
```

`tests/unit/socket-file.test.ts`:

```ts
import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareSocket } from '../../src/main/socket-file'
import { WIN } from '../fixtures/platform'

const uid = process.getuid?.() ?? -1
const servers: Server[] = []
afterEach(() => { for (const s of servers.splice(0)) s.close() })

function listen(path: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    servers.push(s)
    s.once('error', reject)
    s.listen(path, () => resolve(s))
  })
}

const newDir = (): string => mkdtempSync(join(tmpdir(), 'ct-sock-'))

describe.runIf(!WIN)('prepareSocket', () => {
  it('creates the private folder, open to this user only', () => {
    const dir = join(newDir(), 'claudeterm-1')
    prepareSocket(join(dir, 'x.sock'), { privateDir: dir, uid })
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('refuses a private folder others can enter', () => {
    const dir = newDir()
    chmodSync(dir, 0o755)
    expect(() => prepareSocket(join(dir, 'x.sock'), { privateDir: dir, uid })).toThrow('must be a folder only you can access')
  })

  it('refuses a private folder that belongs to someone else', () => {
    const dir = newDir()
    chmodSync(dir, 0o700)
    expect(() => prepareSocket(join(dir, 'x.sock'), { privateDir: dir, uid: uid + 1 })).toThrow('must be a folder only you can access')
  })

  it('a socket left behind is replaced', async () => {
    const path = join(newDir(), 'x.sock')
    await listen(path) // stands for the socket of a run that crashed
    prepareSocket(path, { privateDir: '/nowhere', uid })
    await expect(listen(path)).resolves.toBeDefined()
  })

  it('never removes something that is not a socket', () => {
    const path = join(newDir(), 'x.sock')
    writeFileSync(path, 'mine')
    expect(() => prepareSocket(path, { privateDir: '/nowhere', uid })).toThrow('is not a socket')
  })
})
```

`tests/integration/pipe.test.ts`:

```ts
import { testPipeName, WIN } from '../fixtures/platform'

const newPipe = (): string => testPipeName('test')
const IMG = WIN ? 'C:\\x\\a.png' : '/x/a.png'
```

Drop the old `newPipe` and the `randomUUID` import; replace every image path literal (`'C:\\x\\a.png'`, `'C:\\a.png'`, `'C:/a.png'`) with `IMG`.

`tests/integration/session-hook.int.test.ts`: import `testPipeName`, `WIN`; in `listen()` use `const pipe = testPipeName('test')`; in the last test use `CLAUDETERM_PIPE: testPipeName('none')`; replace `TP` with
`const TP = WIN ? 'C:\\Users\\me\\.claude\\projects\\D--x\\s.jsonl' : '/home/me/.claude/projects/-x/s.jsonl'`.
Mark every test that runs `cmd.exe` with `it.runIf(WIN)` (Task 4 adds their Linux twins).

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/unit/protocol.test.ts`
Expected: FAIL — the Linux `defaultPipeName` case returns a `\\.\pipe\` name.
Run: `LINUX npx vitest run tests/unit/socket-file.test.ts tests/integration/pipe.test.ts`
Expected: `socket-file` FAILS (module missing); `pipe.test` PASSES with socket paths — Node's `net` serves both, so the server itself needs no change.

- [ ] **Step 3: Implement**

`src/shared/protocol.ts` — change the import to `import { isAbsolute, posix } from 'node:path'` and replace `defaultPipeName`:

```ts
export interface PipeContext {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  uid: number
}

export const currentPipeContext = (): PipeContext => ({ platform: process.platform, env: process.env, uid: process.getuid?.() ?? -1 })

/** Where ClaudeTerm keeps its socket outside Windows: the user's runtime folder, else a private folder in /tmp. */
export function socketDir(ctx: PipeContext): string {
  const xdg = ctx.env.XDG_RUNTIME_DIR
  return xdg && posix.isAbsolute(xdg) ? xdg : `/tmp/claudeterm-${ctx.uid}`
}

/** ClaudeTerm's address for this user: a named pipe on Windows, a Unix socket elsewhere. */
export function defaultPipeName(username: string, ctx: PipeContext = currentPipeContext()): string {
  const name = `claudeterm-${username.replace(/[^A-Za-z0-9_.-]/g, '_')}`
  return ctx.platform === 'win32' ? `\\\\.\\pipe\\${name}` : posix.join(socketDir(ctx), `${name}.sock`)
}
```

`src/main/socket-file.ts`:

```ts
import { lstatSync, mkdirSync, unlinkSync, type Stats } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Makes a Unix socket path ready to listen on. The private fallback folder is created (0700) and must be a folder
 * only this user can access. A socket left by a ClaudeTerm that crashed is removed: the single-instance lock
 * guarantees no other ClaudeTerm of this user listens there. Anything else at that path is left alone.
 */
export function prepareSocket(path: string, o: { privateDir: string; uid: number }): void {
  const dir = dirname(path)
  if (dir === o.privateDir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const d = lstatSync(dir)
    if (!d.isDirectory() || d.uid !== o.uid || (d.mode & 0o077) !== 0) throw new Error(`refusing to use ${dir}: it must be a folder only you can access`)
  }
  let st: Stats
  try {
    st = lstatSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw e
  }
  if (!st.isSocket()) throw new Error(`refusing to replace ${path}: it is not a socket`)
  unlinkSync(path)
}
```

`src/main/index.ts` — import `socketDir` from `../shared/protocol` and `prepareSocket` from `./socket-file`; directly before `startPipeServer(pipeName, {`:

```ts
  // a socket left by a run that crashed would refuse the new one
  if (process.platform !== 'win32') {
    try {
      const uid = process.getuid?.() ?? -1
      prepareSocket(pipeName, { privateDir: socketDir({ platform: process.platform, env: {}, uid }), uid })
    } catch (e) {
      log.error(`pipe server: ${(e as Error).message}`)
    }
  }
```

The hook (`src/hook/session-hook.ts`), the MCP server and `resolvePipeName` keep calling `defaultPipeName(username)`; the default context makes them agree.

- [ ] **Step 4: Run the tests on both platforms**

Run: `npx vitest run tests/unit/protocol.test.ts tests/unit/socket-file.test.ts tests/integration/pipe.test.ts tests/integration/session-hook.int.test.ts`
Run: `LINUX npx vitest run tests/unit/protocol.test.ts tests/unit/socket-file.test.ts tests/integration/pipe.test.ts tests/integration/session-hook.int.test.ts`
Expected: PASS (on Linux the `cmd.exe` session-hook tests are skipped).

- [ ] **Step 5: Typecheck and leave uncommitted**

Run: `npm run typecheck`. Do not commit.

---

### Task 4: The hook wrapper as a shell script

**Files:**
- Modify: `src/main/claude-tab-settings.ts`, `src/main/path-key.ts`
- Test: `tests/unit/claude-tab-settings.test.ts`, `tests/unit/path-key.test.ts`, `tests/integration/session-hook.int.test.ts`

**Interfaces:**
- Consumes: `WIN`, `testPipeName` (Tasks 1, 3).
- Produces: `isWindowsPath(p: string): boolean` (`src/main/path-key.ts`); `hookShContent(execPath: string, hookScriptPath: string): string`; `hookCommandString(hookPath: string): string`; `claudeTabSettingsJson(hookPath: string): string`; `writeClaudeTabFiles(dataDir: string, execPath: string, hookScriptPath: string, platform?: NodeJS.Platform): ClaudeTabFiles`; `ClaudeTabFiles { settingsPath: string; hookPath: string }` (renamed from `cmdPath`).

- [ ] **Step 1: Write the failing tests**

`tests/unit/path-key.test.ts`:

```ts
import { isWindowsPath, pathKey } from '../../src/main/path-key'
// …
describe('isWindowsPath', () => {
  it('drive and UNC paths, not Linux ones', () => {
    expect(isWindowsPath('C:\\a')).toBe(true)
    expect(isWindowsPath('c:/a')).toBe(true)
    expect(isWindowsPath('\\\\server\\share\\a')).toBe(true)
    expect(isWindowsPath('/home/a\\b')).toBe(false)
  })
})
```

`tests/unit/claude-tab-settings.test.ts` — import `statSync`, `hookShContent` and `WIN`; change the existing `writeClaudeTabFiles` test to the Windows platform and the new field name:

```ts
  it('writeClaudeTabFiles writes the .cmd and the settings on Windows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-hook-'))
    const files = writeClaudeTabFiles(dir, 'C:\\e.exe', 'C:\\h.js', 'win32')
    expect(files).toEqual({ settingsPath: join(dir, 'claude-tab-settings.json'), hookPath: join(dir, 'session-hook.cmd') })
    expect(readFileSync(files.hookPath, 'utf8')).toBe(hookCmdContent('C:\\e.exe', 'C:\\h.js'))
    expect(readFileSync(files.settingsPath, 'utf8')).toBe(claudeTabSettingsJson(files.hookPath))
  })
```

Add:

```ts
  it('hookShContent runs the script under ELECTRON_RUN_AS_NODE, passes the arguments on and always exits 0', () => {
    expect(hookShContent('/opt/ClaudeTerm/claudeterm', '/opt/ClaudeTerm/resources/hook/session-hook.js').split('\n')).toEqual([
      '#!/bin/sh',
      "ELECTRON_RUN_AS_NODE=1 '/opt/ClaudeTerm/claudeterm' '/opt/ClaudeTerm/resources/hook/session-hook.js' \"$@\"",
      'exit 0',
      ''
    ])
  })

  it('hookShContent quotes apostrophes for sh', () => {
    expect(hookShContent("/home/bob's/e", '/h.js')).toContain("'/home/bob'\\''s/e'")
  })

  it('hookCommandString keeps a Linux path as it is, escaping what bash would expand', () => {
    expect(hookCommandString('/home/me/.config/ClaudeTerm/session-hook.sh')).toBe('"/home/me/.config/ClaudeTerm/session-hook.sh"')
    expect(hookCommandString('/home/a\\b$c/session-hook.sh')).toBe('"/home/a\\\\b\\$c/session-hook.sh"')
  })

  it('writeClaudeTabFiles writes a runnable session-hook.sh on Linux', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-hook-'))
    const files = writeClaudeTabFiles(dir, '/e', '/h.js', 'linux')
    expect(files).toEqual({ settingsPath: join(dir, 'claude-tab-settings.json'), hookPath: join(dir, 'session-hook.sh') })
    expect(readFileSync(files.hookPath, 'utf8')).toBe(hookShContent('/e', '/h.js'))
    if (!WIN) expect(statSync(files.hookPath).mode & 0o777).toBe(0o755)
  })
```

`tests/integration/session-hook.int.test.ts` — rename `cmdPath` to `hookPath` in the existing tests and add the Linux twins (Claude Code runs hook commands with `sh -c`):

```ts
  it.runIf(!WIN)('the generated .sh, run by sh -c the way Claude Code runs hooks, passes stdin through', async () => {
    const { pipe, got } = await listen()
    const { hookPath } = writeClaudeTabFiles(join(work, 'data-sh'), process.execPath, bundle)
    const r = await run('/bin/sh', ['-c', hookCommandString(hookPath)], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe })
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([expected])
  })

  it.runIf(!WIN)('the .sh works from a folder with an apostrophe and a space', async () => {
    const { pipe, got } = await listen()
    const { hookPath } = writeClaudeTabFiles(join(work, "Bob's data sh"), process.execPath, bundle)
    const r = await run('/bin/sh', ['-c', hookCommandString(hookPath)], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe })
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([expected])
  })

  it.runIf(!WIN)('the statusLine command from the settings file forwards the status through sh', async () => {
    const { pipe, got } = await listen()
    const { settingsPath } = writeClaudeTabFiles(join(work, "Bob's status sh"), process.execPath, bundle)
    const command = (JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine: { command: string } }).statusLine.command
    const r = await run('/bin/sh', ['-c', command], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }, STATUS_INPUT)
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([expectedStatus])
  })

  it.runIf(!WIN)('Stop and AskUserQuestion via the .sh forward attention and print nothing', async () => {
    const { pipe, got } = await listen()
    const { hookPath } = writeClaudeTabFiles(join(work, 'data-attention-sh'), process.execPath, bundle)
    const env = { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }
    const ask = JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [] } })
    const stop = JSON.stringify({ session_id: SID, hook_event_name: 'Stop', stop_hook_active: false })
    expect(await run('/bin/sh', ['-c', hookCommandString(hookPath)], env, ask)).toEqual({ code: 0, stdout: '' })
    expect(await run('/bin/sh', ['-c', hookCommandString(hookPath)], env, stop)).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([
      { v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'question' },
      { v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'done' }
    ])
  })
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/unit/claude-tab-settings.test.ts tests/unit/path-key.test.ts`
Expected: FAIL — `hookShContent` / `isWindowsPath` are not exported; `hookPath` is undefined.

- [ ] **Step 3: Implement**

Append to `src/main/path-key.ts`:

```ts
/** C:\…, C:/… or \\server\share: a path Git Bash wants with forward slashes */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
}
```

`src/main/claude-tab-settings.ts`:

```ts
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isWindowsPath } from './path-key'

export function hookCmdContent(execPath: string, hookScriptPath: string): string {
  const esc = (p: string): string => p.replace(/%/g, '%%')
  return ['@echo off', 'chcp 65001 >nul 2>&1', 'set ELECTRON_RUN_AS_NODE=1', `"${esc(execPath)}" "${esc(hookScriptPath)}" %*`, 'exit /b 0', ''].join('\r\n')
}

/** The same wrapper for Linux: sh runs the hook script under ClaudeTerm's own Node and always succeeds. */
export function hookShContent(execPath: string, hookScriptPath: string): string {
  const q = (p: string): string => `'${p.replace(/'/g, "'\\''")}'`
  return ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 ${q(execPath)} ${q(hookScriptPath)} "$@"`, 'exit 0', ''].join('\n')
}

export function hookCommandString(hookPath: string): string {
  // Always double-quote: the command is run by bash (Git Bash, Linux) as well as cmd. Inside bash double quotes
  // only \ " $ ` are special, so escape those; ' & ( ) ; # and spaces are then literal. Git Bash takes C:/… paths.
  const p = (isWindowsPath(hookPath) ? hookPath.replace(/\\/g, '/') : hookPath).replace(/(["$`\\])/g, '\\$1')
  return `"${p}"`
}

export function claudeTabSettingsJson(hookPath: string): string {
  const command = hookCommandString(hookPath)
  // … the rest of the function body unchanged …
}

export interface ClaudeTabFiles {
  settingsPath: string
  hookPath: string
}

export function writeClaudeTabFiles(dataDir: string, execPath: string, hookScriptPath: string, platform: NodeJS.Platform = process.platform): ClaudeTabFiles {
  mkdirSync(dataDir, { recursive: true })
  const win = platform === 'win32'
  const hookPath = join(dataDir, win ? 'session-hook.cmd' : 'session-hook.sh')
  const settingsPath = join(dataDir, 'claude-tab-settings.json')
  writeFileSync(hookPath, win ? hookCmdContent(execPath, hookScriptPath) : hookShContent(execPath, hookScriptPath), 'utf8')
  if (!win) chmodSync(hookPath, 0o755)
  writeFileSync(settingsPath, claudeTabSettingsJson(hookPath), 'utf8')
  return { settingsPath, hookPath }
}
```

`src/main/index.ts` uses only `claudeFiles.settingsPath`: no change.

- [ ] **Step 4: Run the tests on both platforms**

Run: `npx vitest run tests/unit/claude-tab-settings.test.ts tests/unit/path-key.test.ts tests/integration/session-hook.int.test.ts`
Run: `LINUX npx vitest run tests/unit/claude-tab-settings.test.ts tests/unit/path-key.test.ts tests/integration/session-hook.int.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and leave uncommitted**

Run: `npm run typecheck`. Do not commit.

---

### Task 5: Shell profiles on Linux

**Files:**
- Modify: `src/shared/types.ts`, `src/main/profiles.ts`, `src/main/index.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/renderer/settings-page.ts`
- Test: `tests/unit/profiles.test.ts`

**Interfaces:**
- Consumes: `isWindowsPath` (Task 4).
- Produces: `ShellFamily` gains `'zsh' | 'fish'`; `PosixDetectDeps { loginShell: string | null; etcShells: string | null; exists(path: string): boolean }`; `detectPosixProfiles(d: PosixDetectDeps): ProfileDef[]`; `loginShell(): string | null`; `systemPosixDetectDeps(): PosixDetectDeps`; `detectInstalledProfiles(): ProfileDef[]`; `CtApi.platform: string` (renderer, synchronous).

- [ ] **Step 1: Write the failing tests** — append to `tests/unit/profiles.test.ts` (import `detectPosixProfiles` and `type PosixDetectDeps`):

```ts
const ZSH: ProfileDef = { name: 'zsh', command: '/usr/bin/zsh', args: ['-l'] }
const LBASH: ProfileDef = { name: 'bash', command: '/bin/bash', args: ['-l'] }
const FISH: ProfileDef = { name: 'fish', command: '/usr/bin/fish', args: ['-l'] }

describe('detectPosixProfiles', () => {
  const shells = '# /etc/shells: valid login shells\n/bin/sh\n/bin/bash\n/usr/bin/bash\n/usr/bin/zsh\n/usr/bin/fish\n'
  const installed = ['/bin/sh', '/bin/bash', '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/fish']
  const d = (o: Partial<PosixDetectDeps> = {}): PosixDetectDeps => ({ loginShell: '/usr/bin/zsh', etcShells: shells, exists: (p) => installed.includes(p), ...o })

  it('lists the login shell first, then bash, zsh and fish once each, as login shells', () => {
    expect(detectPosixProfiles(d())).toEqual([ZSH, LBASH, FISH])
  })

  it('keeps a login shell it does not know, and finds shells without /etc/shells', () => {
    expect(detectPosixProfiles(d({ loginShell: '/usr/bin/tcsh', etcShells: null, exists: (p) => p === '/usr/bin/tcsh' || p === '/bin/bash' })))
      .toEqual([{ name: 'tcsh', command: '/usr/bin/tcsh', args: ['-l'] }, LBASH])
  })

  it('skips shells that are listed but not installed', () => {
    expect(detectPosixProfiles(d({ loginShell: null, exists: (p) => p === '/bin/bash' })).map((p) => p.name)).toEqual(['bash'])
  })
})

describe('Linux shells', () => {
  const claude = { command: 'claude', settingsPath: '/home/me/.config/ClaudeTerm/claude-tab-settings.json', resumeSessionId: SID }
  const line = `claude --settings '/home/me/.config/ClaudeTerm/claude-tab-settings.json' --resume ${SID}`

  it('families: zsh and fish by name, bash and pwsh as on Windows', () => {
    expect(shellFamily(ZSH)).toBe('zsh')
    expect(shellFamily(FISH)).toBe('fish')
    expect(shellFamily(LBASH)).toBe('bash')
    expect(shellFamily({ name: 'pwsh', command: '/usr/bin/pwsh', args: [] })).toBe('powershell')
    expect([ZSH, FISH, LBASH].every(canHostClaude)).toBe(true)
  })

  it('Linux paths keep their backslashes; zsh quotes like bash, fish its own way', () => {
    const p = "/home/bob o'neil/.config/ClaudeTerm/a\\b.json"
    expect(quoteForShell('bash', p)).toBe("'/home/bob o'\\''neil/.config/ClaudeTerm/a\\b.json'")
    expect(quoteForShell('zsh', p)).toBe(quoteForShell('bash', p))
    expect(quoteForShell('fish', p)).toBe("'/home/bob o\\'neil/.config/ClaudeTerm/a\\\\b.json'")
  })

  it('bash and zsh run claude, then become the shell; fish runs it as its first command and stays', () => {
    expect(buildLaunch(LBASH, 'claude', claude)).toEqual({ file: '/bin/bash', args: ['--login', '-i', '-c', `${line}; exec bash --login -i`] })
    expect(buildLaunch(ZSH, 'claude', claude)).toEqual({ file: '/usr/bin/zsh', args: ['-l', '-i', '-c', `${line}; exec zsh -l -i`] })
    expect(buildLaunch(FISH, 'claude', claude)).toEqual({ file: '/usr/bin/fish', args: ['-l', '-C', line] })
  })

  it('Automatic is the first profile, the login shell', () => {
    expect(pickProfile([ZSH, LBASH], null)).toBe(ZSH)
    expect(pickClaudeProfile([ZSH, LBASH], null)).toEqual({ profile: ZSH, warning: null })
  })
})
```

The existing Windows `quoteForShell('bash', …)` expectation (a `C:\…` path turned into `C:/…`) stays as it is.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/unit/profiles.test.ts`
Expected: FAIL — `detectPosixProfiles` is not exported; `shellFamily(ZSH)` is `'other'`.

- [ ] **Step 3: Implement**

`src/shared/types.ts`: `export type ShellFamily = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish' | 'wsl' | 'other'`.

`src/main/profiles.ts` — imports become:

```ts
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { posix, win32 } from 'node:path'
import { isUuid } from '../shared/protocol'
import type { ProfileDef, ShellFamily, TabKind } from '../shared/types'
import { isWindowsPath } from './path-key'
```

Add after `detectProfiles`:

```ts
export interface PosixDetectDeps {
  /** the user's login shell; null when unknown */
  loginShell: string | null
  /** the text of /etc/shells; null when it cannot be read */
  etcShells: string | null
  exists(path: string): boolean
}

const POSIX_SHELLS = ['bash', 'zsh', 'fish']

/** The login shell first, then bash, zsh and fish from /etc/shells or the usual folders; one profile per name, each a login shell. */
export function detectPosixProfiles(d: PosixDetectDeps): ProfileDef[] {
  const listed = (d.etcShells ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/'))
  const usual = POSIX_SHELLS.flatMap((n) => [`/bin/${n}`, `/usr/bin/${n}`, `/usr/local/bin/${n}`])
  const out: ProfileDef[] = []
  for (const command of [...(d.loginShell ? [d.loginShell] : []), ...listed, ...usual]) {
    const name = posix.basename(command)
    if (command !== d.loginShell && !POSIX_SHELLS.includes(name)) continue
    if (out.some((p) => p.name === name) || !d.exists(command)) continue
    out.push({ name, command, args: ['-l'] })
  }
  return out
}

/** The user's login shell: the passwd entry, else $SHELL. */
export function loginShell(): string | null {
  try {
    const s = userInfo().shell
    if (s) return s
  } catch {
    // no passwd entry for this user
  }
  return process.env.SHELL || null
}

export function systemPosixDetectDeps(): PosixDetectDeps {
  let etcShells: string | null = null
  try {
    etcShells = readFileSync('/etc/shells', 'utf8')
  } catch {
    // no /etc/shells: the usual folders are still searched
  }
  return { loginShell: loginShell(), etcShells, exists: existsSync }
}

/** The shells installed here: Windows' own (where.exe, wsl.exe) or the POSIX ones. */
export function detectInstalledProfiles(): ProfileDef[] {
  return process.platform === 'win32' ? detectProfiles(systemDetectDeps()) : detectPosixProfiles(systemPosixDetectDeps())
}
```

In `shellFamily` add before the `bash` line:

```ts
  if (exe === 'zsh') return 'zsh'
  if (exe === 'fish') return 'fish'
```

`canHostClaude`: `return f === 'powershell' || f === 'cmd' || f === 'bash' || f === 'zsh' || f === 'fish'`.

`quoteForShell` — replace the `bash` case:

```ts
    case 'bash':
    case 'zsh':
      // Git Bash takes C:/… paths; a Linux path is used as it is
      return `'${(isWindowsPath(value) ? value.replace(/\\/g, '/') : value).replace(/'/g, "'\\''")}'`
    case 'fish':
      // inside fish single quotes only \ and ' are special
      return `'${value.replace(/[\\']/g, '\\$&')}'`
```

`buildLaunch` — add after the `bash` case:

```ts
    case 'zsh':
      return { file: profile.command, args: ['-l', '-i', '-c', `${buildClaudeCommandLine(family, claude)}; exec zsh -l -i`] }
    case 'fish':
      // fish runs the command after its config files and stays interactive: the shell is there when claude exits
      return { file: profile.command, args: ['-l', '-C', buildClaudeCommandLine(family, claude)] }
```

`src/main/index.ts`: import `detectInstalledProfiles` instead of `detectProfiles` and `systemDetectDeps`; the resolver becomes
`const resolveProfiles = profileResolver(detectInstalledProfiles, existsSync)`.

`src/shared/ipc.ts` — in `interface CtApi` add:

```ts
  /** process.platform of the app ('win32', 'linux'); known at once, without a round trip */
  readonly platform: string
```

`src/preload/index.ts` — in the `api` object add `platform: process.platform,` (a sandboxed preload has `process.platform`).

`src/renderer/settings-page.ts` — replace the `automaticHint` line:

```ts
const automaticHint = ct.platform === 'win32' ? '(PowerShell 7 if installed, else Windows PowerShell)' : '(your login shell)'
```

- [ ] **Step 4: Run the tests on both platforms**

Run: `npx vitest run tests/unit/profiles.test.ts tests/unit/settings-form.test.ts`
Run: `LINUX npx vitest run tests/unit/profiles.test.ts tests/unit/settings-form.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and leave uncommitted**

Run: `npm run typecheck`. Do not commit.

---

### Task 6: Finding claude from a desktop-launched app

**Files:**
- Create: `src/main/login-env.ts`, `tests/unit/login-env.test.ts`, `tests/integration/login-env.int.test.ts`
- Modify: `src/main/mcp-registrar.ts`, `src/main/index.ts`
- Test: `tests/unit/mcp-registrar.test.ts`

**Interfaces:**
- Consumes: `loginShell()` (Task 5), `WIN` (Task 1).
- Produces: `Runner = (file: string, args: string[], opts?: { verbatim?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<RunResult>`; `ClaudeCli.env?: NodeJS.ProcessEnv`; `resolveClaudePosix(o: { run: Runner; shell: string | null; env: NodeJS.ProcessEnv; isExecutable(path: string): boolean }): Promise<ClaudeCli | null>`; `ensureMcpRegistered` option `resolve?: () => Promise<ClaudeCli | null>`; `parseMarkedPath(stdout: string): string | null`, `loginShellPath(run: Runner, shell: string): Promise<string | null>`, `findExecutable(name: string, pathVar: string, isExecutable: (p: string) => boolean): string | null`, `isExecutableFile(p: string): boolean` (`src/main/login-env.ts`).

- [ ] **Step 1: Write the failing tests**

`tests/unit/login-env.test.ts`:

```ts
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findExecutable, isExecutableFile, loginShellPath, parseMarkedPath } from '../../src/main/login-env'
import type { Runner } from '../../src/main/mcp-registrar'
import { WIN } from '../fixtures/platform'

describe('parseMarkedPath', () => {
  it('takes the PATH between the markers, whatever the startup files print around it', () => {
    expect(parseMarkedPath('Welcome!\n__CLAUDETERM_PATH__/a:/b__CLAUDETERM_PATH__\nbye')).toBe('/a:/b')
    expect(parseMarkedPath('no markers here')).toBeNull()
    expect(parseMarkedPath('__CLAUDETERM_PATH____CLAUDETERM_PATH__')).toBeNull()
  })
})

describe('loginShellPath', () => {
  it('asks bash and zsh as interactive login shells, fish as a login shell, within 10 s', async () => {
    const calls: [string, string[], number | undefined][] = []
    const run: Runner = async (file, args, opts) => {
      calls.push([file, args.slice(0, -1), opts?.timeoutMs])
      return { code: 0, stdout: '__CLAUDETERM_PATH__/p__CLAUDETERM_PATH__', stderr: '' }
    }
    expect(await loginShellPath(run, '/usr/bin/zsh')).toBe('/p')
    await loginShellPath(run, '/usr/bin/fish')
    expect(calls).toEqual([['/usr/bin/zsh', ['-l', '-i', '-c'], 10_000], ['/usr/bin/fish', ['-l', '-c'], 10_000]])
  })
})

describe('findExecutable', () => {
  it('returns the first executable of that name on the PATH, skipping empty and relative entries', () => {
    const ok = new Set(['/b/claude', '/c/claude'])
    expect(findExecutable('claude', ':rel:/a:/b:/c', (p) => ok.has(p))).toBe('/b/claude')
    expect(findExecutable('claude', '/a', (p) => ok.has(p))).toBeNull()
  })
})

describe.runIf(!WIN)('isExecutableFile', () => {
  it('needs a file with the execute bit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-exe-'))
    const f = join(dir, 'claude')
    writeFileSync(f, '#!/bin/sh\n')
    chmodSync(f, 0o644)
    expect(isExecutableFile(f)).toBe(false)
    chmodSync(f, 0o755)
    expect(isExecutableFile(f)).toBe(true)
    mkdirSync(join(dir, 'sub'))
    expect(isExecutableFile(join(dir, 'sub'))).toBe(false)
    expect(isExecutableFile(join(dir, 'missing'))).toBe(false)
  })
})
```

`tests/integration/login-env.int.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loginShellPath } from '../../src/main/login-env'
import { execRunner, type Runner } from '../../src/main/mcp-registrar'
import { WIN } from '../fixtures/platform'

describe.runIf(!WIN)('loginShellPath with a real bash', () => {
  it('a startup file that prints and waits for input: the PATH it sets still comes back, quickly', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ct-home-'))
    writeFileSync(join(home, '.bash_profile'), 'echo "Welcome back"\nread answer\nexport PATH="/opt/ct-test-bin:$PATH"\n')
    const run: Runner = (f, a, o) => execRunner(f, a, { ...o, env: { ...process.env, HOME: home } })
    const started = Date.now()
    const path = await loginShellPath(run, '/bin/bash')
    expect(path?.split(':')[0]).toBe('/opt/ct-test-bin')
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
```

`tests/unit/mcp-registrar.test.ts` — import `resolveClaudePosix`; add:

```ts
describe('resolveClaudePosix', () => {
  const marked = (path: string): RunResult => ok(`Welcome!\n__CLAUDETERM_PATH__${path}__CLAUDETERM_PATH__`)

  it('finds claude on the login shell PATH, not the app PATH, and runs it with that PATH', async () => {
    const nvm = '/home/me/.nvm/versions/node/v22/bin'
    const { run, calls } = fakeRunner([(c) => (c.file === '/bin/bash' ? marked(`/usr/bin:${nvm}`) : null)])
    const cli = await resolveClaudePosix({ run, shell: '/bin/bash', env: { PATH: '/usr/bin', HOME: '/home/me' }, isExecutable: (p) => p === `${nvm}/claude` })
    expect(cli).toEqual({ file: `${nvm}/claude`, viaCmd: false, env: { PATH: `/usr/bin:${nvm}`, HOME: '/home/me' } })
    expect(calls[0].args.slice(0, 3)).toEqual(['-l', '-i', '-c'])
  })

  it('falls back to the app PATH when the login shell gives nothing; null when claude is nowhere', async () => {
    const { run } = fakeRunner([() => fail()])
    expect(await resolveClaudePosix({ run, shell: '/bin/zsh', env: { PATH: '/usr/local/bin' }, isExecutable: (p) => p === '/usr/local/bin/claude' }))
      .toEqual({ file: '/usr/local/bin/claude', viaCmd: false, env: { PATH: '/usr/local/bin' } })
    expect(await resolveClaudePosix({ run, shell: null, env: { PATH: '/usr/bin' }, isExecutable: () => false })).toBeNull()
  })
})

describe('runClaude with an environment', () => {
  it('passes the environment a Linux claude needs', async () => {
    const seen: (NodeJS.ProcessEnv | undefined)[] = []
    const run: Runner = async (_f, _a, opts) => { seen.push(opts?.env); return ok() }
    await runClaude(run, { file: '/x/claude', viaCmd: false, env: { PATH: '/x' } }, ['mcp', 'get', 'claudeterm'])
    expect(seen).toEqual([{ PATH: '/x' }])
  })
})
```

In `describe('ensureMcpRegistered')` add:

```ts
  it('uses the claude it is given instead of looking it up', async () => {
    const { run, calls } = fakeRunner([(c) => (c.args[1] === 'get' ? ok(`Command: ${EXE}\nArgs: ${SCRIPT}\n`) : null)])
    const resolve = async () => ({ file: '/x/claude', viaCmd: false })
    expect(await ensureMcpRegistered({ run, execPath: EXE, serverScript: SCRIPT, log: () => {}, resolve })).toBe('already')
    expect(calls.map((c) => c.file)).toEqual(['/x/claude'])
  })

  it('re-registers when the app moved, even if the server script path is the same', async () => {
    const { run, calls } = fakeRunner([whereFinds(CLAUDE), (c) => (c.args[1] === 'get' ? ok(`Command: C:\\old\\ClaudeTerm.exe\nArgs: ${SCRIPT}\n`) : null)])
    expect(await ensureMcpRegistered({ run, execPath: EXE, serverScript: SCRIPT, log: () => {} })).toBe('registered')
    expect(calls.at(-1)?.args[1]).toBe('add')
  })
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/unit/login-env.test.ts tests/unit/mcp-registrar.test.ts`
Expected: FAIL — `login-env` cannot be resolved; `resolveClaudePosix` is not exported; the "app moved" test returns `'already'`.

- [ ] **Step 3: Implement**

`src/main/login-env.ts`:

```ts
import { accessSync, constants, statSync } from 'node:fs'
import { posix } from 'node:path'
import type { Runner } from './mcp-registrar'

const MARK = '__CLAUDETERM_PATH__'
const LOOKUP_MS = 10_000

/** The PATH between the markers; whatever the shell's startup files print around it is ignored. */
export function parseMarkedPath(stdout: string): string | null {
  const m = new RegExp(`${MARK}(.*?)${MARK}`, 's').exec(stdout)
  return m && m[1].length > 0 ? m[1] : null
}

/**
 * The PATH a terminal would have. An app started from the desktop does not read ~/.bashrc or ~/.zshrc, where
 * installers (nvm, the Claude Code installer) put their folders, so ask the login shell. fish reads its config
 * without -i, and refuses -i together with -c in some versions.
 */
export async function loginShellPath(run: Runner, shell: string): Promise<string | null> {
  const fish = posix.basename(shell) === 'fish'
  const r = await run(shell, [...(fish ? ['-l'] : ['-l', '-i']), '-c', `printf '%s%s%s' ${MARK} "$PATH" ${MARK}`], { timeoutMs: LOOKUP_MS })
  return parseMarkedPath(r.stdout)
}

/** The first executable called `name` in the folders of a PATH value. */
export function findExecutable(name: string, pathVar: string, isExecutable: (p: string) => boolean): string | null {
  for (const dir of pathVar.split(':')) {
    if (!dir || !posix.isAbsolute(dir)) continue
    const p = posix.join(dir, name)
    if (isExecutable(p)) return p
  }
  return null
}

export function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return statSync(p).isFile()
  } catch {
    return false
  }
}
```

`src/main/mcp-registrar.ts` — runner options, environment, Linux lookup, registration check:

```ts
import { execFile } from 'node:child_process'
import { findExecutable, loginShellPath } from './login-env'

export type Runner = (file: string, args: string[], opts?: { verbatim?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<RunResult>

export const execRunner: Runner = (file, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      // SIGKILL: an interactive bash ignores SIGTERM
      { windowsHide: true, timeout: opts?.timeoutMs ?? 60_000, killSignal: 'SIGKILL', windowsVerbatimArguments: opts?.verbatim ?? false, env: opts?.env, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
    // nothing to read: a startup file that asks a question gets end-of-input instead of waiting
    child.stdin?.end()
  })

export interface ClaudeCli {
  file: string
  viaCmd: boolean
  /** the environment claude runs with: an npm-installed claude needs the login PATH to find node */
  env?: NodeJS.ProcessEnv
}

/** Linux: claude on the login shell's PATH, else on the app's own; it then runs with that PATH. */
export async function resolveClaudePosix(o: { run: Runner; shell: string | null; env: NodeJS.ProcessEnv; isExecutable(path: string): boolean }): Promise<ClaudeCli | null> {
  const pathVar = (o.shell ? await loginShellPath(o.run, o.shell) : null) ?? o.env.PATH ?? ''
  const file = findExecutable('claude', pathVar, o.isExecutable)
  return file ? { file, viaCmd: false, env: { ...o.env, PATH: pathVar } } : null
}
```

In `runClaude` the first line becomes `if (!cli.viaCmd) return run(cli.file, args, cli.env ? { env: cli.env } : undefined)`.

`ensureMcpRegistered`:

```ts
export async function ensureMcpRegistered(o: { run: Runner; execPath: string; serverScript: string; log(message: string): void; resolve?: () => Promise<ClaudeCli | null> }): Promise<RegisterResult> {
  const cli = await (o.resolve ?? (() => resolveClaude(o.run)))()
  if (!cli) return 'no-claude'
  const get = await runClaude(o.run, cli, ['mcp', 'get', 'claudeterm'])
  const out = get.stdout.toLowerCase()
  if (get.code === 0 && out.includes(o.serverScript.toLowerCase()) && out.includes(o.execPath.toLowerCase())) return 'already'
  // … remove / add unchanged …
}
```

`src/main/index.ts` — import `resolveClaudePosix`, `isExecutableFile` from `./login-env`, `loginShell` from `./profiles`; replace `void resolveClaude(execRunner).then((cli) => { claudeCli = cli })` with:

```ts
  // looked up once: on Linux this starts the login shell
  const findingClaude = process.platform === 'win32'
    ? resolveClaude(execRunner)
    : resolveClaudePosix({ run: execRunner, shell: loginShell(), env: process.env, isExecutable: isExecutableFile })
  void findingClaude.then((cli) => { claudeCli = cli })
```

and pass `resolve: () => findingClaude` to `ensureMcpRegistered`.

- [ ] **Step 4: Run the tests on both platforms**

Run: `npx vitest run tests/unit/login-env.test.ts tests/unit/mcp-registrar.test.ts`
Run: `LINUX npx vitest run tests/unit/login-env.test.ts tests/unit/mcp-registrar.test.ts tests/integration/login-env.int.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and leave uncommitted**

Run: `npm run typecheck`. Do not commit.

---

### Task 7: Sounds on Linux

**Files:**
- Modify: `src/main/sound.ts`, `src/main/index.ts`, `src/renderer/settings-page.ts`
- Test: `tests/unit/sound.test.ts`

**Interfaces:**
- Consumes: `findExecutable`, `isExecutableFile` (Task 6); `CtApi.platform` (Task 5).
- Produces: `SoundPlayerDeps { beep(): void; player(path: string): ProcessSpec | null; systemSound: string | null; spawn(p: ProcessSpec): SoundChild; warn(message: string): void }` (the `env` field goes); `linuxPlayer(file: string, has: (cmd: string) => boolean, env: NodeJS.ProcessEnv): ProcessSpec | null`; `linuxSoundDeps(env, has, exists): Pick<SoundPlayerDeps, 'player' | 'systemSound'>`; `FREEDESKTOP_SOUND`.

- [ ] **Step 1: Write the failing tests** — in `tests/unit/sound.test.ts` the setup gives the new deps:

```ts
import { createSoundPlayer, FREEDESKTOP_SOUND, linuxPlayer, linuxSoundDeps, type ProcessSpec, wavPlayer } from '../../src/main/sound'

function setup(o: { spawnThrows?: boolean; systemSound?: string | null; noPlayer?: boolean } = {}) {
  const calls: string[] = []
  const children: EventEmitter[] = []
  const play = createSoundPlayer({
    beep: () => calls.push('beep'),
    player: (p) => (o.noPlayer ? null : wavPlayer(p, { SystemRoot: 'C:\\Windows' })),
    systemSound: o.systemSound ?? null,
    spawn: (p: ProcessSpec) => {
      if (o.spawnThrows) throw new Error('spawn EPERM')
      calls.push(`spawn:${p.env.CLAUDETERM_SOUND}`)
      const child = new EventEmitter()
      children.push(child)
      return child
    },
    warn: (m) => calls.push(`warn:${m}`)
  })
  return { play, calls, children }
}
```

Rename `'"system" is the Windows default beep'` to `'"system" beeps where there is no system sound file'`. Add:

```ts
  it('"system" plays the system sound file where there is one, and beeps without a warning when it cannot', () => {
    const { play, calls, children } = setup({ systemSound: '/usr/share/sounds/x.oga' })
    play('system')
    children[0].emit('exit', 1)
    expect(calls).toEqual(['spawn:/usr/share/sounds/x.oga', 'beep'])
  })

  it('no player on this machine: beep, and say why once', () => {
    const { play, calls } = setup({ noPlayer: true })
    play('/s/a.wav')
    play('/s/a.wav')
    expect(calls).toEqual([
      'beep',
      'warn:Cannot play the attention sound /s/a.wav (no sound player found: paplay, pw-play or aplay); using the system sound',
      'beep'
    ])
  })
```

and

```ts
describe('linuxPlayer', () => {
  const env = { PATH: '/usr/bin' }

  it('prefers paplay, then pw-play, then aplay; the path is an argument, never shell text', () => {
    const path = "/home/me/my sounds/it's $(x).wav"
    expect(linuxPlayer(path, () => true, env)).toEqual({ file: 'paplay', args: [path], env })
    expect(linuxPlayer(path, (c) => c !== 'paplay', env)?.file).toBe('pw-play')
    expect(linuxPlayer(path, (c) => c === 'aplay', env)?.file).toBe('aplay')
    expect(linuxPlayer(path, () => false, env)).toBeNull()
  })

  it('aplay plays .wav only', () => {
    expect(linuxPlayer('/s/bell.oga', (c) => c === 'aplay', env)).toBeNull()
  })
})

describe('linuxSoundDeps', () => {
  it('the system sound is the freedesktop one when installed; players are looked up once', () => {
    const asked: string[] = []
    const has = (c: string): boolean => { asked.push(c); return c === 'pw-play' }
    const d = linuxSoundDeps({}, has, (p) => p === FREEDESKTOP_SOUND)
    expect(d.systemSound).toBe(FREEDESKTOP_SOUND)
    d.player('/a.wav')
    d.player('/b.wav')
    expect(asked).toEqual(['paplay', 'pw-play'])
    expect(linuxSoundDeps({}, has, () => false).systemSound).toBeNull()
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/unit/sound.test.ts`
Expected: FAIL — `linuxPlayer` is not exported; the deps type has no `player`.

- [ ] **Step 3: Implement** — `src/main/sound.ts`, replacing `SoundPlayerDeps` and `createSoundPlayer` (`wavPlayer` stays as it is):

```ts
export interface SoundPlayerDeps {
  beep(): void
  /** how to play a sound file; null when this machine has no player for it */
  player(path: string): ProcessSpec | null
  /** the file 'system' plays; null: the system beep */
  systemSound: string | null
  spawn(p: ProcessSpec): SoundChild
  /** told once per file that cannot be played */
  warn(message: string): void
}

/** 'system' plays the system sound (or beeps); a file plays in a separate process and falls back to the beep when it cannot. */
export function createSoundPlayer(d: SoundPlayerDeps): (sound: string) => void {
  const warned = new Set<string>()
  const playFile = (file: string, onFail: (reason: string) => void): void => {
    let failed = false
    const fail = (reason: string): void => {
      if (failed) return
      failed = true
      onFail(reason)
    }
    const spec = d.player(file)
    if (!spec) return fail('no sound player found: paplay, pw-play or aplay')
    try {
      const child = d.spawn(spec)
      child.on('error', (e) => fail(e.message))
      child.on('exit', (code) => { if (code !== 0) fail(`exit code ${String(code)}`) })
    } catch (e) {
      fail((e as Error).message)
    }
  }
  return (sound) => {
    if (sound === 'system') {
      if (d.systemSound) playFile(d.systemSound, () => d.beep())
      else d.beep()
      return
    }
    playFile(sound, (reason) => {
      d.beep()
      if (warned.has(sound)) return
      warned.add(sound)
      d.warn(`Cannot play the attention sound ${sound} (${reason}); using the system sound`)
    })
  }
}

/** The "message" sound of the freedesktop sound theme, installed with most Linux desktops */
export const FREEDESKTOP_SOUND = '/usr/share/sounds/freedesktop/stereo/message-new-instant.oga'
const LINUX_PLAYERS = ['paplay', 'pw-play', 'aplay']

/** paplay (PulseAudio and PipeWire), pw-play, or aplay, which plays .wav only. The path is an argument, never shell text. */
export function linuxPlayer(file: string, has: (cmd: string) => boolean, env: NodeJS.ProcessEnv): ProcessSpec | null {
  const wav = /\.wav$/i.test(file)
  const cmd = LINUX_PLAYERS.find((c) => (c !== 'aplay' || wav) && has(c))
  return cmd ? { file: cmd, args: [file], env } : null
}

export function linuxSoundDeps(env: NodeJS.ProcessEnv, has: (cmd: string) => boolean, exists: (path: string) => boolean): Pick<SoundPlayerDeps, 'player' | 'systemSound'> {
  const found = new Map<string, boolean>()
  const cached = (c: string): boolean => {
    if (!found.has(c)) found.set(c, has(c))
    return found.get(c)!
  }
  return { player: (f) => linuxPlayer(f, cached, env), systemSound: exists(FREEDESKTOP_SOUND) ? FREEDESKTOP_SOUND : null }
}
```

`src/main/index.ts` — import `linuxSoundDeps`, `wavPlayer` from `./sound` and `findExecutable` from `./login-env`; the player becomes:

```ts
  const playSound = createSoundPlayer({
    ...(process.platform === 'win32'
      ? { player: (f: string) => wavPlayer(f, process.env), systemSound: null }
      : linuxSoundDeps(process.env, (cmd) => findExecutable(cmd, process.env.PATH ?? '', isExecutableFile) !== null, existsSync)),
    beep: () => shell.beep(),
    spawn: (p) => spawn(p.file, p.args, { env: p.env, windowsHide: true, stdio: 'ignore' }),
    warn: toast
  })
```

`src/renderer/settings-page.ts` — in `soundField`, `' Windows default'` becomes `` ` ${ct.platform === 'win32' ? 'Windows default' : 'System sound'}` ``.

- [ ] **Step 4: Run the tests on both platforms**

Run: `npx vitest run tests/unit/sound.test.ts`
Run: `LINUX npx vitest run tests/unit/sound.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and leave uncommitted**

Run: `npm run typecheck`. Do not commit.

---

### Task 8: The terminal on Linux — PTY exit, ConPTY option, image paste key

**Files:**
- Create: `src/main/pty-session.ts`, `tests/unit/pty-session.test.ts`
- Modify: `src/main/pty-host.ts`, `src/main/index.ts`, `src/shared/ipc.ts`, `src/renderer/terminal-view.ts`, `src/renderer/util.ts`, `src/renderer/keymap.ts`, `src/renderer/main.ts`
- Test: `tests/integration/pty-host.test.ts`, `tests/unit/util.test.ts`, `tests/unit/keymap.test.ts`

**Interfaces:**
- Consumes: `CtApi.platform` (Task 5), `WIN` (Task 1).
- Produces: `parseStat(stat: string): { state: string; session: number } | null`, `sessionAlive(sid: number, proc?: string): boolean`, `waitSessionGone(sid: number, timeoutMs: number, alive?: (sid: number) => boolean, stepMs?: number): Promise<void>`; `SESSION_EXIT_WAIT_MS = 2000` (`pty-host.ts`); `AppInfo.windowsBuild: number | null`; `windowsPtyOption(build: number | null)` (`util.ts`); `imagePasteInput(platform: string): string` (`keymap.ts`).

- [ ] **Step 1: Write the failing tests**

`tests/unit/pty-session.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseStat, sessionAlive, waitSessionGone } from '../../src/main/pty-session'

const stat = (pid: number, comm: string, state: string, session: number): string => `${pid} (${comm}) ${state} 1 ${pid} ${session} 34816 0 -1 4194560`

function fakeProc(entries: [number, string, string, number][]): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-proc-'))
  for (const [pid, comm, state, session] of entries) {
    mkdirSync(join(dir, String(pid)))
    writeFileSync(join(dir, String(pid), 'stat'), stat(pid, comm, state, session))
  }
  mkdirSync(join(dir, 'self'))
  return dir
}

describe('parseStat', () => {
  it('reads state and session after the name, even a name with spaces and parentheses', () => {
    expect(parseStat(stat(42, 'claude', 'S', 40))).toEqual({ state: 'S', session: 40 })
    expect(parseStat(stat(42, 'a) b (c', 'R', 7))).toEqual({ state: 'R', session: 7 })
    expect(parseStat('garbage')).toBeNull()
  })
})

describe('sessionAlive', () => {
  it('true while a live process belongs to the session; zombies and other sessions do not count', () => {
    expect(sessionAlive(40, fakeProc([[41, 'claude', 'S', 40], [50, 'x', 'S', 50]]))).toBe(true)
    expect(sessionAlive(40, fakeProc([[41, 'claude', 'Z', 40], [50, 'x', 'S', 50]]))).toBe(false)
    expect(sessionAlive(40, join(tmpdir(), 'no-such-proc'))).toBe(false)
  })
})

describe('waitSessionGone', () => {
  it('resolves as soon as the session is empty, or at the time limit', async () => {
    let checks = 0
    await waitSessionGone(1, 5000, () => ++checks < 3, 10)
    expect(checks).toBe(3)
    const started = Date.now()
    await waitSessionGone(1, 100, () => true, 10)
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
  })
})
```

`tests/integration/pty-host.test.ts` — import `WIN`; mark the three `cmd.exe` tests `it.runIf(WIN)` and add:

```ts
const node = `'${process.execPath}'`
const probe = (onHup: string): string => `${node} -e "process.on('SIGHUP',()=>{${onHup}});console.log('child',process.pid);setInterval(()=>{},1000)" & wait`

async function startProbe(onHup: string): Promise<{ kill(): void; child: number; exitedAt(): number }> {
  let out = ''
  let exitedAt = 0
  const h = spawnPty({ file: '/bin/bash', args: ['-c', probe(onHup)], cwd: process.cwd(), env, cols: 80, rows: 24, onData: (d) => { out += d }, onExit: () => { exitedAt = Date.now() } })
  await vi.waitFor(() => expect(out).toMatch(/child \d+/), { timeout: 5000 })
  return { kill: () => h.kill(), child: Number(/child (\d+)/.exec(out)![1]), exitedAt: () => exitedAt }
}

describe.runIf(!WIN)('spawnPty on Linux', () => {
  it('runs a process and reports output and exit code', async () => {
    let out = ''
    const code = await new Promise<number>((resolve) => {
      spawnPty({ file: '/bin/sh', args: ['-c', 'echo pty-ok'], cwd: process.cwd(), env, cols: 80, rows: 24, onData: (d) => { out += d }, onExit: resolve })
    })
    expect(code).toBe(0)
    await vi.waitFor(() => expect(out).toContain('pty-ok'))
  })

  it('kill() reports the exit once the programs the shell started have quit', async () => {
    const p = await startProbe('setTimeout(()=>process.exit(0),800)')
    const killedAt = Date.now()
    p.kill()
    await vi.waitFor(() => expect(p.exitedAt()).toBeGreaterThan(0), { timeout: 5000 })
    expect(p.exitedAt() - killedAt).toBeGreaterThanOrEqual(700)
    expect(() => process.kill(p.child, 0)).toThrow()
  })

  it('kill() stops waiting after 2 s for a program that ignores SIGHUP, and leaves it running', async () => {
    const p = await startProbe('')
    const killedAt = Date.now()
    p.kill()
    await vi.waitFor(() => expect(p.exitedAt()).toBeGreaterThan(0), { timeout: 5000 })
    expect(p.exitedAt() - killedAt).toBeGreaterThanOrEqual(1900)
    expect(() => process.kill(p.child, 0)).not.toThrow()
    process.kill(p.child, 'SIGKILL')
  })
})
```

(The shell exits on SIGHUP at once; the kernel then sends SIGHUP to the session's foreground group, where the background `node` runs, since `bash -c` has no job control.)

`tests/unit/util.test.ts` — import `windowsPtyOption`:

```ts
describe('windowsPtyOption', () => {
  it('ConPTY handling on Windows only', () => {
    expect(windowsPtyOption(22631)).toEqual({ windowsPty: { backend: 'conpty', buildNumber: 22631 } })
    expect(windowsPtyOption(null)).toEqual({})
  })
})
```

`tests/unit/keymap.test.ts` — import `imagePasteInput`:

```ts
describe('imagePasteInput', () => {
  it('Alt+V for Claude Code on Windows, Ctrl+V elsewhere', () => {
    expect(imagePasteInput('win32')).toBe('\x1bv')
    expect(imagePasteInput('linux')).toBe('\x16')
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run tests/unit/pty-session.test.ts tests/unit/util.test.ts tests/unit/keymap.test.ts`
Expected: FAIL — `pty-session` cannot be resolved; `windowsPtyOption` / `imagePasteInput` are not exported.
Run: `LINUX npx vitest run tests/integration/pty-host.test.ts`
Expected: FAIL — "reports the exit once the programs … have quit": the exit comes ~200 ms after the kill.

- [ ] **Step 3: Implement**

`src/main/pty-session.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** State and session id from a /proc/<pid>/stat line; the program name in parentheses may hold spaces and ')'. */
export function parseStat(stat: string): { state: string; session: number } | null {
  const end = stat.lastIndexOf(')')
  if (end < 0) return null
  // after the name: state ppid pgrp session …
  const f = stat.slice(end + 2).split(' ')
  const session = Number(f[3])
  return f[0] && Number.isInteger(session) ? { state: f[0], session } : null
}

/** Whether a live (not zombie) process still belongs to the session. Reads /proc: false where there is none. */
export function sessionAlive(sid: number, proc = '/proc'): boolean {
  let names: string[]
  try {
    names = readdirSync(proc)
  } catch {
    return false
  }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue
    let line: string
    try {
      line = readFileSync(join(proc, n, 'stat'), 'utf8')
    } catch {
      continue // the process is gone
    }
    const s = parseStat(line)
    if (s && s.session === sid && s.state !== 'Z') return true
  }
  return false
}

/** Resolves once the session has no live process, or after timeoutMs. */
export async function waitSessionGone(sid: number, timeoutMs: number, alive: (sid: number) => boolean = sessionAlive, stepMs = 100): Promise<void> {
  const until = Date.now() + timeoutMs
  while (alive(sid) && Date.now() < until) await new Promise((r) => setTimeout(r, stepMs))
}
```

`src/main/pty-host.ts` — import `waitSessionGone` from `./pty-session`; add

```ts
/** how long a killed tab's programs get to quit after SIGHUP before its PTY counts as exited (not Windows) */
export const SESSION_EXIT_WAIT_MS = 2000
```

In `spawnPty` add `let killed = false` next to `let alive = true`, and replace the `onExit` handler:

```ts
  p.onExit(({ exitCode }) => {
    alive = false
    const report = (): void => {
      markExited()
      o.onExit(exitCode)
    }
    // ConPTY ends every program of the console at once. Elsewhere SIGHUP reaches the shell and the programs it ran
    // (claude) take a moment to save and quit: wait for them, so a restart never overlaps them.
    if (killed && process.platform !== 'win32') void waitSessionGone(p.pid, SESSION_EXIT_WAIT_MS).then(report)
    else report()
  })
```

In `kill` set `killed = true` right after `alive = false`. (node-pty makes the shell a session leader, so its pid is the session id.)

`src/shared/ipc.ts` — in `AppInfo`: `/** Windows build number, for xterm's ConPTY handling; null elsewhere */ windowsBuild: number | null`.

`src/main/index.ts` — in the `IPC.appInfo` handler: `windowsBuild: process.platform === 'win32' ? Number(release().split('.')[2]) || 0 : null`.

`src/renderer/util.ts`:

```ts
/** xterm's ConPTY handling, for Windows only */
export function windowsPtyOption(build: number | null): { windowsPty?: { backend: 'conpty'; buildNumber: number } } {
  return build === null ? {} : { windowsPty: { backend: 'conpty', buildNumber: build } }
}
```

`src/renderer/terminal-view.ts` — `windowsBuild: number | null` in the options, import `windowsPtyOption` from `./util`, and in the `Terminal` options replace the `windowsPty: …` line with `...windowsPtyOption(o.windowsBuild)`.

`src/renderer/keymap.ts`:

```ts
/** What makes claude read an image from the clipboard: Alt+V in Claude Code on Windows, Ctrl+V elsewhere */
export function imagePasteInput(platform: string): string {
  return platform === 'win32' ? '\x1bv' : '\x16'
}
```

`src/renderer/main.ts` — import `imagePasteInput`; in `paste()`:

```ts
  // image-only clipboard: Claude Code's image-paste key makes claude read the image from the clipboard itself
  else if (allowImage && clip.hasImage) handleInput(t.info.id, imagePasteInput(ct.platform))
```

- [ ] **Step 4: Run the tests on both platforms**

Run: `npx vitest run tests/unit/pty-session.test.ts tests/unit/util.test.ts tests/unit/keymap.test.ts tests/integration/pty-host.test.ts tests/unit/tab-manager.test.ts`
Run: `LINUX npx vitest run tests/unit/pty-session.test.ts tests/unit/util.test.ts tests/unit/keymap.test.ts tests/integration/pty-host.test.ts tests/unit/tab-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, full unit run on both, leave uncommitted**

Run: `npm run typecheck && npx vitest run` and `LINUX npx vitest run` — all pass (Windows-only steps skipped on Linux and the reverse). Do not commit.

---

### Task 9: End-to-end tests on Linux

**Files:**
- Modify: `tests/e2e/helpers.ts`, `tests/e2e/attention.spec.ts`, `tests/e2e/restart.spec.ts`, `tests/e2e/restore.spec.ts`, `tests/e2e/update.spec.ts`, `tests/e2e/settings.spec.ts`, `tests/e2e/images.spec.ts`

**Interfaces:**
- Consumes: `WIN`, `testPipeName` (Tasks 1, 3); `claudeTempRoot` (Task 2); every earlier task (the app must run on Linux).
- Produces: `TEST_SHELL: string`, `PROMPT: RegExp`, `bellCommand(after?: string): string`, `processAlive(marker: string): boolean`; `FAKE_CLAUDE_SETTINGS` per platform.

- [ ] **Step 1: Make the helpers platform-aware** — `tests/e2e/helpers.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { testPipeName, WIN } from '../fixtures/platform'

/** the shell the tests type into: Windows PowerShell, or bash without startup files (prompt "bash-5.2$ ") */
export const TEST_SHELL = WIN ? 'Windows PowerShell' : 'Test Bash'
const TEST_PROFILES = [{ name: 'Test Bash', command: '/bin/bash', args: ['--norc', '--noprofile', '-i'] }]
/** the test shell's prompt, once it waits for input */
export const PROMPT = WIN ? /PS .*>/ : /bash-[\d.]+\$ /

// "claude" prints its arguments instead of starting (on Linux also the folder it runs in, as PowerShell's prompt shows it)
export const FAKE_CLAUDE_SETTINGS = WIN
  ? { claude: { command: 'cmd /c echo fake-claude', shellProfile: TEST_SHELL }, defaultProfile: TEST_SHELL }
  : { claude: { command: 'pwd; echo fake-claude', shellProfile: TEST_SHELL }, defaultProfile: TEST_SHELL, profiles: TEST_PROFILES }

/** what to type for a terminal bell, then optionally a word that shows the line ran */
export function bellCommand(after?: string): string {
  if (WIN) return `Write-Host -NoNewline ([char]7)${after ? `; '${after}'` : ''}\r`
  return `printf '\\a'${after ? `; echo ${after}` : ''}\r`
}

/** whether a node process whose command line holds the marker is running */
export function processAlive(marker: string): boolean {
  if (WIN) {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' }).Count`], { encoding: 'utf8' }).trim() !== '0'
  }
  try {
    execFileSync('pgrep', ['-f', marker], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
```

In `launchApp` replace the pipe name with `const pipeName = testPipeName('e2e')` (drop the `randomUUID` import if unused).

- [ ] **Step 2: Use them in the specs**
- `attention.spec.ts`: `/PS .*>/` → `PROMPT` (2×). The two bell lines become
  `await page.evaluate(([id, text]) => window.ct.writePty(id, text), [shell, bellCommand()] as const)` and
  `await page.evaluate(([id, text]) => window.ct.writePty(id, text), [shell, bellCommand('after-bell')] as const)`.
- `restart.spec.ts`: `/PS .*>/` → `PROMPT` (4×); delete the local `probeAlive` and use `processAlive`; add
  `// Windows ends the console's programs at once; on Linux ClaudeTerm waits up to 2 s for them, so the probe quits within that`
  `const PROBE_QUIT_MS = WIN ? 8000 : 1000`
  and use `${PROBE_QUIT_MS}` in place of `8000` in the probe command. Import `WIN` from `../fixtures/platform`; drop the `execFileSync` import the old `probeAlive` needed.
- `restore.spec.ts`, `update.spec.ts`: every `profile: 'Windows PowerShell'` → `profile: TEST_SHELL`.
- `settings.spec.ts`: `toContain('Windows PowerShell')` and `toHaveText('Windows PowerShell')` → `TEST_SHELL`.
- `images.spec.ts`, the scratchpad test: on Linux Claude Code's temp root ignores `TEMP`/`TMP`, so the test redirects it with `CLAUDE_CODE_TMPDIR` there and finds the scratchpad under that root:

```ts
import { claudeTempRoot } from '../../src/main/image-watcher'
import { WIN } from '../fixtures/platform'
// …
  const temp = mkdtempSync(join(tmpdir(), 'ct-temp-'))
  const { app, page, work, tabId, pipeName } = await claudeTab(WIN ? { TEMP: temp, TMP: temp } : { CLAUDE_CODE_TMPDIR: temp })
  // …
  const scratchpad = join(claudeTempRoot({ platform: process.platform, env: WIN ? {} : { CLAUDE_CODE_TMPDIR: temp }, tmpdir: temp, uid: process.getuid?.() ?? -1 }), 'D--e2e', SID)
```

  (replacing `const scratchpad = join(temp, 'claude', 'D--e2e', SID)`; the comment above `const temp` becomes `// the app's temp folder; Claude Code keeps each session's scratchpad in <its temp root>/<project>/<session id>`).

- [ ] **Step 3: Run the suite on both platforms**

Run: `npm run test:e2e`
Expected: PASS (Windows unchanged).
Run: `LINUX npm run build && ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a npx playwright test`
Expected: PASS. A failure that is not about the shell (prompt, syntax) is a real Linux difference: debug it with superpowers:systematic-debugging, fix the code (not the test), and add the fix to the task that owns that code.

- [ ] **Step 4: Typecheck and leave uncommitted**

Run: `npm run typecheck`. Do not commit.

---

### Task 10: Package, updates, CI, docs, and a check on a real desktop

**Files:**
- Modify: `electron-builder.yml`, `package.json`, `src/main/update-backend.ts`, `src/main/index.ts`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`
- Test: `tests/unit/update-backend.test.ts`

**Interfaces:**
- Produces: `UpdateBackendOptions.installOnQuit?: boolean` (default `true`).

- [ ] **Step 1: Failing test** — add to `tests/unit/update-backend.test.ts`:

```ts
  it('on Linux an update waits for the restart button: installing it asks for the password', () => {
    const u = fakeUpdater(null)
    createUpdateBackend(u as unknown as AutoUpdaterLike, { log, installOnQuit: false })
    expect(u.autoInstallOnAppQuit).toBe(false)
  })
```

Run: `npx vitest run tests/unit/update-backend.test.ts` — FAIL (`autoInstallOnAppQuit` is `true`).

- [ ] **Step 2: Implement** — `src/main/update-backend.ts`: in `UpdateBackendOptions` add

```ts
  /** install a downloaded update when the app quits; off where installing asks for a password (Linux .deb) */
  installOnQuit?: boolean
```

and `u.autoInstallOnAppQuit = !o.testFeed && (o.installOnQuit ?? true)`. `src/main/index.ts`: pass `installOnQuit: process.platform === 'win32'` to `createUpdateBackend`.

Run: `npx vitest run tests/unit/update-backend.test.ts` — PASS.

- [ ] **Step 3: The `.deb` target** — append to `electron-builder.yml`:

```yaml
linux:
  target:
    - target: deb
      arch: [x64]
  executableName: claudeterm
  category: Development
  synopsis: A terminal built for Claude Code
  maintainer: Dmitry Vergasov
deb:
  artifactName: ClaudeTerm-${version}.${ext}
```

`package.json`: add the script `"dist:linux": "npm run build && electron-builder --linux deb"`; description → `"A terminal built for Claude Code, on Windows and Linux: tabs, a conversation image panel, a live status bar and session restore"`.

- [ ] **Step 4: CI on Ubuntu** — `.github/workflows/ci.yml`, the job becomes a matrix:

```yaml
jobs:
  test:
    name: Typecheck and tests (${{ matrix.os }})
    strategy:
      fail-fast: false
      matrix:
        os: [windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build

      - name: End-to-end tests
        if: runner.os == 'Windows'
        run: npx playwright test

      - name: End-to-end tests
        if: runner.os == 'Linux'
        # no display and no setuid sandbox helper on the runner
        env:
          ELECTRON_DISABLE_SANDBOX: '1'
        run: xvfb-run -a npx playwright test

      - name: Build the Linux package
        if: runner.os == 'Linux'
        run: npx electron-builder --linux deb --publish never

      - name: Keep the Linux package for a hand check
        if: runner.os == 'Linux'
        uses: actions/upload-artifact@v4
        with:
          name: linux-package
          path: dist/ClaudeTerm-*.deb
          retention-days: 7

      - name: Keep end-to-end results when they fail
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-results-${{ matrix.os }}
          path: test-results/
          if-no-files-found: ignore
```

- [ ] **Step 5: The release carries the `.deb`** — `.github/workflows/release.yml`: a `linux` job builds first, then the Windows job publishes everything at once, notes from `CHANGELOG.md` as today.

```yaml
jobs:
  linux:
    name: Build the Linux package
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Check that the tag matches package.json
        run: |
          expected="v$(node -p "require('./package.json').version")"
          if [ "$GITHUB_REF_NAME" != "$expected" ]; then
            echo "::error::Tag $GITHUB_REF_NAME does not match package.json version ($expected)"
            exit 1
          fi

      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run dist:linux -- --publish never

      - uses: actions/upload-artifact@v4
        with:
          name: linux-package
          # latest-linux.yml is what installed copies read to find a new version
          path: |
            dist/ClaudeTerm-*.deb
            dist/latest-linux.yml
          if-no-files-found: error

  release:
    name: Build the installer and publish the release
    needs: linux
    runs-on: windows-latest
    timeout-minutes: 30
    steps:
      # … checkout, setup-node, the tag check, "Take the release notes from CHANGELOG.md", npm ci, typecheck, test
      # and dist: unchanged …

      - uses: actions/download-artifact@v4
        with:
          name: linux-package
          path: dist

      - name: Publish the GitHub release
        shell: bash
        env:
          GH_TOKEN: ${{ github.token }}
        # latest.yml / latest-linux.yml are what installed copies read to find a new version (electron-updater);
        # the blockmap lets Windows download only the changed parts
        run: >
          gh release create "$GITHUB_REF_NAME"
          dist/ClaudeTerm-Setup-*.exe dist/ClaudeTerm-Setup-*.exe.blockmap dist/latest.yml
          dist/ClaudeTerm-*.deb dist/latest-linux.yml
          --title "ClaudeTerm ${GITHUB_REF_NAME#v}"
          --notes-file release-notes.md
```

- [ ] **Step 6: Docs** — `README.md`:
- tagline → `<b>A terminal built for Claude Code, on Windows and Linux.</b><br>`;
- badge → `https://img.shields.io/badge/platform-Windows%2010%20%7C%2011%20%7C%20Linux-0078d4`, alt `Windows 10 | 11 | Linux`; link text `Download for Windows or Linux`;
- notifications: "plays the Windows default sound" → "plays the system sound (on Linux the desktop's message sound, through `paplay`, `pw-play` or `aplay`)";
- shell profiles bullet: append "On Linux: your login shell, bash, zsh and fish.";
- "Proper Windows terminal behaviour — ConPTY, …" → "Proper terminal behaviour — ConPTY on Windows, a real PTY on Linux, …";
- "Open Claude Code here": append "Windows only; on Linux run `claudeterm --claude <folder>`.";
- Install: after the Windows steps add
  "**Linux (x64, Debian/Ubuntu and derivatives):** download `ClaudeTerm-<version>.deb` from the latest release and run `sudo apt install ./ClaudeTerm-<version>.deb`. ClaudeTerm downloads updates by itself; installing one asks for your password when you click restart. To paste images into Claude, Claude Code needs `xclip` (X11) or `wl-clipboard` (Wayland).";
- Requirements → "Windows 10 or 11 (x64), or a Debian/Ubuntu-based Linux (x64); and Claude Code.";
- settings location → "`%APPDATA%\ClaudeTerm\settings.json` (`~/.config/ClaudeTerm/settings.json` on Linux)"; the `defaultProfile` comment → `// profile name; null = PowerShell 7 if installed, else Windows PowerShell (Linux: your login shell)`;
- architecture: "over ConPTY" → "over ConPTY (a PTY on Linux)"; "over a named pipe" → "over a named pipe (a Unix socket on Linux)";
- building from source: "You need Windows 10/11 or Linux, Node.js 22.12+ and Git (on Linux also `build-essential` and `python3`: node-pty is compiled on install)."; add `npm run dist:linux   # build the .deb into dist/ (on Linux)`.

`CONTRIBUTING.md`: the requirements line as in the README; "A development copy keeps its data in `%APPDATA%\ClaudeTerm-dev` (`~/.config/ClaudeTerm-dev` on Linux) and listens on its own named pipe (Unix socket on Linux)"; a note "On Ubuntu 24.04 and in WSL the development Electron has no setuid sandbox helper: run `ELECTRON_DISABLE_SANDBOX=1 npm run dev`; headless end-to-end tests run under `xvfb-run -a`."; table row `| npm run dist:linux | Build the .deb into dist/ (Linux) |`.

`CHANGELOG.md`: the version that ships Linux needs its section before the tag (the release stops without one), and the version number is the user's call. Add the section at the top with a placeholder heading the user renames when releasing, `## Next`, holding:

```markdown
### New

- **ClaudeTerm runs on Linux.** Download `ClaudeTerm-<version>.deb` from the release and install it with `sudo apt install ./ClaudeTerm-<version>.deb` (x64, Debian, Ubuntu and their derivatives). Shell tabs open your login shell, bash, zsh or fish; Claude tabs, the status bar, notifications, the image panel, session restore and updates work as on Windows. Installing an update asks for your password. To paste images into Claude, install `xclip` (X11) or `wl-clipboard` (Wayland).
```

(`scripts/release-notes.mjs` matches `## <version>` only, so `## Next` can never be published by mistake; tell the user it must be renamed to the version before tagging.)

- [ ] **Step 7: Everything on both platforms**

Run: `npm run typecheck && npm test && npm run test:e2e`
Run: `LINUX npm run typecheck && npx vitest run && npm run build && ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a npx playwright test`
Expected: PASS.

- [ ] **Step 8: By hand on the bench (WSLg)** — `LINUX ELECTRON_DISABLE_SANDBOX=1 npm run dev` opens the window in Windows. With Claude Code installed in Ubuntu (`curl -fsSL https://claude.ai/install.sh | bash`, then `claude` once to log in):
  1. the first tab is the login shell; the ▾ menu lists the installed bash/zsh/fish;
  2. a Claude tab starts claude; the status bar shows the model;
  3. ask claude to save a PNG into its scratchpad: it shows in the image panel, and `ls -d /tmp/claude-$(id -u)/*/*/` lists the session folder — this confirms decision 9; if the folder is elsewhere, change `claudeTempRoot` and its test to match;
  4. ask claude to delete its scratchpad folder and then save another PNG there: the new image still shows (Review Focus 4);
  5. a permission prompt in a background tab plays the sound and marks the tab;
  6. **Restart session** resumes the conversation, and `pgrep -fc 'claude'` is the same before and after;
  7. with `xclip` installed, copy an image on the desktop and press Ctrl+V in the Claude tab: claude attaches it.

- [ ] **Step 9: By hand on a real desktop, once the branch has been pushed (the user's call)** — on an Ubuntu 24.04 desktop (a VM is fine): download the `linux-package` artifact of the CI run, `sudo apt install ./ClaudeTerm-<version>.deb`, start ClaudeTerm **from the app menu**, then:
  1. claude is found and `claude mcp get claudeterm` shows `/opt/ClaudeTerm/claudeterm` (Review Focus 1);
  2. the dock shows ClaudeTerm's icon. If it shows a generic one: read the window's class with `xprop WM_CLASS` (X11) or from the dock's desktop-entry match (Wayland), and add `desktop: { entry: { StartupWMClass: <that class> } }` under `linux:` in `electron-builder.yml`;
  3. `pkill -9 claudeterm`, start again: it works (stale socket, Review Focus 2);
  4. close the window with tabs open, start again: the restore offer appears.

- [ ] **Step 10: Leave uncommitted and report** — do not commit. List for the user every file the plan created or changed, grouped by task, the results of Steps 7–9, and that `## Next` in `CHANGELOG.md` must become the version before tagging.
