# ClaudeTerm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows-терминал для Claude Code: вкладки с шеллами и `claude`, открытие вкладки из контекстного меню Explorer, боковая лента картинок разговора (транскрипт + созданные файлы + `show_image`), «Продолжить предыдущие сессии», установщик `.exe`.

**Architecture:** Electron (main + sandboxed renderer). Main владеет вкладками/PTY (node-pty/ConPTY), named pipe для `show_image` и session id, лентами картинок и снимком сессии; renderer — xterm.js на вкладку, таб-бар, боковая лента, лайтбокс. MCP-сервер `show_image` и SessionStart-хук — отдельные JS-бандлы, запускаемые тем же exe с `ELECTRON_RUN_AS_NODE=1`.

**Tech Stack:** TypeScript ~5.9, Electron ^44, electron-vite ^5 + vite ^7, @xterm/xterm 6 + addons, node-pty 1.1.0, chokidar ^4, @modelcontextprotocol/sdk ^1.32 + zod ^4, esbuild, vitest ^5, @playwright/test ^1.63, electron-builder ^26 (NSIS).

**Spec:** `docs/superpowers/specs/2026-10-05-claudeterm-design.md` — читать вместе с планом.

## Global Constraints

- Платформа: только Windows 10/11 x64. Все тесты запускаются на Windows.
- Node.js для разработки: **≥ 22.12** (требование vitest 5 / vite 7 / electron-vite 5). Если `node --version` ниже — остановиться и попросить пользователя обновить Node (`winget upgrade OpenJS.NodeJS.LTS`), не обходить.
- Версии: electron ^44, electron-vite ^5, **vite ^7 (не 8 — electron-vite 5 не поддерживает 8)**, node-pty 1.1.0 (N-API prebuilds, пересборка под Electron не нужна, `npmRebuild: false`), chokidar ^4 (не 5 — v5 ESM-only), @xterm/xterm ^6, @modelcontextprotocol/sdk ^1.32, zod ^4, typescript ~5.9.
- **Никаких git-коммитов** (глобальное правило пользователя). Шаги «Checkpoint» в конце задач означают: тесты зелёные, изменения оставлены незакоммиченными. Субагентам — то же правило.
- Каталог данных: `%APPDATA%\ClaudeTerm` (установленная версия), `%APPDATA%\ClaudeTerm-dev` (dev, `!app.isPackaged`), переопределение `CLAUDETERM_DATA_DIR` (тесты).
- Пайп: `\\.\pipe\claudeterm-<username>` (установленная), `\\.\pipe\claudeterm-dev-<username>` (dev), переопределение `CLAUDETERM_PIPE_NAME` (тесты).
- Env каждого PTY: `CLAUDETERM_TAB_ID=<uuid>`, `CLAUDETERM_PIPE=<pipe>`; из env, передаваемого в PTY, удаляются все `CLAUDETERM_*` от родителя, `ELECTRON_RUN_AS_NODE`, `ELECTRON_RENDERER_URL`.
- Служебные env только для тестов: `CLAUDETERM_TEST=1` (тест-хук `window.__ct`, без WebGL), `CLAUDETERM_SKIP_MCP_REGISTER=1`.
- MCP-сервер: имя `claudeterm`, тул `show_image`. Расширения картинок по умолчанию: `png, jpg, jpeg, gif, webp, bmp`; лимит 50 МБ; `imagePanel.maxItems` 200.
- Хук: stdout всегда пустой, код выхода всегда 0.
- Безопасность renderer: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; картинки только через `ctimg://<cardId>`.
- Тексты UI — как в спеке: полоса восстановления, пункт меню восстановления, контекстное меню карточки и плашки watcher'а — по-русски; тосты и прочие подписи — по-английски.

## Review Focus

1. **Русская раскладка клавиатуры** при нажатии Ctrl+Shift+T/W/L/F/I/C/V — хоткеи должны срабатывать по физической клавише (`KeyboardEvent.code`), а не по `key` (с русской раскладкой `key === 'Е'`). Тест — Task 10, `keymap.test.ts`.
2. **ПКМ в Explorer на корне диска** (`D:\`) — `%V` приходит в argv как `D:"`; должна открыться вкладка в `D:\`, а авто-слежение картинок в корне диска — не запускаться. Тесты — Task 5 (`args.test.ts`) и Task 13 (`image-watcher.test.ts`).
3. **Пути с пробелами и апострофами** (`D:\My Projects\Bob's game`, имя пользователя с пробелом) в cwd, пути к `claude-tab-settings.json` и команде хука — экранирование под каждый шелл и рабочий запуск хука через `.cmd` из bash/cmd. Тесты — Task 4 (`profiles.test.ts`), Task 7 (`claude-tab-settings.test.ts`, `session-hook.int.test.ts`).
4. **Закрытие окна с открытыми вкладками** не должно обнулять снимок (dispose вкладок не пишет пустой снимок), а запуск, после которого вкладок не осталось, не должен затирать `previous-session.json`. Тесты — Task 8 (`tab-manager.test.ts`, disposeAll) и Task 11 (`session-store.test.ts`, e2e `restore.spec.ts`).
5. **Две Claude-вкладки в одной папке** — `show_image` и session id маршрутизируются по tabId, а не по cwd. Тесты — Task 8 (`setClaudeSession` для двух вкладок с одним cwd) и Task 12 (`image-hub.test.ts`, один путь в двух вкладках).

## File Structure

```
ClaudeTerm/
  package.json, tsconfig.json, electron.vite.config.ts, vitest.config.ts, playwright.config.ts, .gitignore
  electron-builder.yml, build/installer.nsh
  scripts/build-resources.mjs          esbuild-бандлы MCP-сервера и хука → resources/
  resources/mcp/, resources/hook/      (генерируются, в .gitignore)
  src/shared/
    types.ts          общие типы (вкладки, карточки, снимок, настройки)
    ipc.ts            каналы main↔renderer и интерфейс window.ct
    protocol.ts       протокол named pipe: типы, парсинг/валидация
    image-file.ts     проверка файла картинки (расширение/существование/размер)
    pipe-client.ts    клиент пайпа (MCP-сервер, хук, тесты)
  src/main/
    index.ts          composition root: single-instance, окно, IPC, проводка сервисов
    data-dir.ts       каталог данных и имя пайпа (dev/prod/тест)
    resources.ts      путь к resources/ (dev/prod)
    log.ts            лог-файл с ротацией
    window-state.ts   размер/позиция окна
    settings.ts       settings.json: дефолты, парсинг, валидация
    profiles.ts       автодетект шеллов, командные строки (вкл. Claude-вкладки)
    args.ts           разбор argv
    pty-host.ts       обёртка node-pty
    tab-manager.ts    реестр вкладок, PTY, события, снимок
    pipe-server.ts    сервер named pipe
    claude-tab-settings.ts  генерация session-hook.cmd и claude-tab-settings.json
    session-store.ts  session-state.json / previous-session.json
    image-hub.ts      ленты картинок по вкладкам
    image-watcher.ts  chokidar-слежение за картинками (cwd и temp-папка сессии)
    transcript-images.ts  разбор строки транскрипта → картинки
    transcript-feed.ts    инкрементальное чтение транскрипта + subagents, кэш base64
    img-protocol.ts   протокол ctimg://
    mcp-registrar.ts  регистрация MCP в Claude
  src/preload/index.ts  contextBridge → window.ct
  src/renderer/
    index.html, styles.css, env.d.ts
    main.ts           состояние вкладок renderer, проводка UI
    terminal-view.ts  xterm.js-обёртка
    themes.ts         цветовые темы
    util.ts           folderName
    tabbar.ts, menu.ts, toasts.ts, keymap.ts, search.ts,
    restore-banner.ts, image-url.ts, image-panel.ts, lightbox.ts
  src/mcp/show-image-tool.ts, src/mcp/show-image-server.ts
  src/hook/session-hook.ts, src/hook/main.ts
  tests/unit/*.test.ts, tests/integration/*.test.ts, tests/e2e/*.spec.ts + helpers.ts
```

---

### Task 1: Каркас проекта и вертикальный срез «одна вкладка с шеллом»

**Files:**
- Create: `package.json`, `tsconfig.json`, `electron.vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `.gitignore`, `scripts/build-resources.mjs`
- Create: `src/shared/types.ts`, `src/shared/ipc.ts`
- Create: `src/main/data-dir.ts`, `src/main/pty-host.ts`, `src/main/index.ts` (временная версия — заменяется в Task 9)
- Create: `src/preload/index.ts`
- Create: `src/renderer/index.html`, `src/renderer/styles.css`, `src/renderer/env.d.ts`, `src/renderer/themes.ts`, `src/renderer/terminal-view.ts`, `src/renderer/main.ts` (временная версия — заменяется в Task 9)
- Test: `tests/integration/pty-host.test.ts`, `tests/e2e/helpers.ts`, `tests/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `src/shared/types.ts`: `TabKind`, `ShellFamily`, `ProfileDef`, `TabInfo`, `OpenTabRequest`, `ImageSource`, `ImageCard`, `SessionSnapshotTab`, `SessionSnapshot`, `Settings` (точные поля ниже).
  - `src/shared/ipc.ts`: `IPC` (имена каналов), `AppInfo`, `ClipboardContent`, `ImageAction`, `ImagesUpdate`, `RestoreInfo`, `CtApi`.
  - `src/main/pty-host.ts`: `spawnPty(opts: SpawnOptions): PtyHandle`, `type SpawnPty`, `interface PtyHandle { pid; write(d); resize(c, r); kill() }`.
  - `src/main/data-dir.ts`: `initDataDir(): string`, `resolvePipeName(): string`.
  - `src/renderer/terminal-view.ts`: `class TerminalView` (`term`, `search`, `element`, `write`, `show`, `refit`, `setFont`, `setTheme`, `bufferText`, `dispose`).
  - `src/renderer/themes.ts`: `THEMES`, `resolveTheme(theme)`.
  - `tests/e2e/helpers.ts`: `ROOT`, `makeDataDir(settings?)`, `testEnv(dataDir, pipeName)`, `launchApp(opts)`, `typeInTerminal(page, text)`, `bufferText(page, tabId?)`, `FAKE_CLAUDE_SETTINGS`, `PNG_1x1`.

- [ ] **Step 0: Проверить Node**

Run: `node --version`
Expected: `v22.12.0` или выше (или `v24.x`). Если ниже — остановиться и сообщить пользователю: нужен `winget upgrade OpenJS.NodeJS.LTS`.

- [ ] **Step 1: Инициализировать проект и поставить зависимости**

```powershell
cd D:\Workspace\ClaudeTerm
git init
npm init -y
npm i node-pty@1.1.0 chokidar@^4.0.3
npm i -D electron@^44 electron-vite@^5 vite@^7 typescript@~5.9 vitest@^5 @playwright/test@^1.63 electron-builder@^26 esbuild@^0.28 @types/node@^22 @xterm/xterm@^6 @xterm/addon-fit @xterm/addon-search @xterm/addon-web-links @xterm/addon-webgl @xterm/addon-unicode11 @modelcontextprotocol/sdk@^1.32 zod@^4
```

Expected: установка без ошибок (warnings допустимы). `git init` не коммит — коммитить нельзя.

- [ ] **Step 2: Заполнить `package.json`**

Заменить всё, кроме секций `dependencies`/`devDependencies`, которые записал npm:

```json
{
  "name": "claudeterm",
  "productName": "ClaudeTerm",
  "version": "0.1.0",
  "private": true,
  "description": "Terminal for Claude Code with an image panel",
  "author": "ClaudeTerm",
  "main": "out/main/index.js",
  "scripts": {
    "build:resources": "node scripts/build-resources.mjs",
    "dev": "npm run build:resources && electron-vite dev",
    "build": "npm run build:resources && electron-vite build",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "test:e2e": "npm run build && playwright test",
    "dist": "npm run build && electron-builder --win nsis"
  }
}
```

- [ ] **Step 3: Конфиги**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "strict": true,
    "noUnusedLocals": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src", "tests", "*.config.ts"]
}
```

`electron.vite.config.ts` (electron-vite 5 по умолчанию берёт `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html` и externalize-ит `dependencies`):
```ts
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {}
})
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 20_000
  }
})
```

`playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list'
})
```

`.gitignore`:
```
node_modules/
out/
dist/
resources/mcp/*.js
resources/hook/*.js
test-results/
playwright-report/
```

`scripts/build-resources.mjs`:
```js
import { build } from 'esbuild'
import { existsSync } from 'node:fs'

const entries = [
  { in: 'src/mcp/show-image-server.ts', out: 'resources/mcp/show-image-server.js' },
  { in: 'src/hook/main.ts', out: 'resources/hook/session-hook.js' }
]

for (const e of entries) {
  if (!existsSync(e.in)) {
    console.log(`skip ${e.in} (not created yet)`)
    continue
  }
  await build({
    entryPoints: [e.in],
    outfile: e.out,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'info'
  })
}
```

- [ ] **Step 4: Общие типы и IPC-контракт**

`src/shared/types.ts`:
```ts
export type TabKind = 'claude' | 'shell'
export type ShellFamily = 'powershell' | 'cmd' | 'bash' | 'wsl' | 'other'

export interface ProfileDef {
  name: string
  command: string
  args: string[]
}

export interface TabInfo {
  id: string
  kind: TabKind
  profile: string
  cwd: string
  customTitle: string | null
  claudeSessionId: string | null
  exited: boolean
}

export interface OpenTabRequest {
  kind: TabKind
  cwd: string
  profile?: string | null
  title?: string | null
  resumeSessionId?: string | null
}

export type ImageSource = 'created' | 'shown' | 'read' | 'tool' | 'pasted'

export interface ImageCard {
  id: string
  tabId: string
  path: string
  name: string
  relPath: string
  source: ImageSource
  caption: string | null
  touchedAt: number
  version: number
  updated: boolean
  deleted: boolean
}

export interface SessionSnapshotTab {
  kind: TabKind
  profile: string
  cwd: string
  title: string | null
  claudeSessionId: string | null
}

export interface SessionSnapshot {
  version: 1
  savedAt: string
  tabs: SessionSnapshotTab[]
}

export interface Settings {
  defaultProfile: string | null
  claude: { command: string; shellProfile: string | null }
  profiles: ProfileDef[]
  font: { family: string; size: number }
  theme: string | Record<string, string>
  scrollback: number
  imageWatch: { enabled: boolean; extensions: string[]; ignore: string[]; maxDepth: number }
  imagePanel: { autoOpen: boolean; width: number; maxItems: number }
}
```

`src/shared/ipc.ts`:
```ts
import type { ImageCard, OpenTabRequest, Settings, TabInfo } from './types'

export const IPC = {
  appInfo: 'app:info',
  rendererReady: 'app:renderer-ready',
  bell: 'app:bell',
  tabsOpen: 'tabs:open',
  tabsClose: 'tabs:close',
  tabsActivate: 'tabs:activate',
  tabsRename: 'tabs:rename',
  tabsReorder: 'tabs:reorder',
  tabsRestart: 'tabs:restart',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  profilesList: 'profiles:list',
  settingsGet: 'settings:get',
  settingsOpen: 'settings:open',
  clipboardRead: 'clipboard:read',
  clipboardWriteText: 'clipboard:write-text',
  imagesList: 'images:list',
  imagesMarkSeen: 'images:mark-seen',
  imagesAction: 'images:action',
  restoreGet: 'restore:get',
  restoreRun: 'restore:run',
  openExternal: 'shell:open-external',
  evTabOpened: 'ev:tab-opened',
  evTabUpdated: 'ev:tab-updated',
  evTabClosed: 'ev:tab-closed',
  evTabActivated: 'ev:tab-activated',
  evTabsOrder: 'ev:tabs-order',
  evPtyData: 'ev:pty-data',
  evPtyExit: 'ev:pty-exit',
  evImages: 'ev:images',
  evToast: 'ev:toast',
  evSettings: 'ev:settings',
  evRestore: 'ev:restore'
} as const

export interface AppInfo {
  windowsBuild: number
  test: boolean
  homeDir: string
}

export interface ClipboardContent {
  text: string
  hasImage: boolean
}

export type ImageAction = 'open' | 'reveal' | 'copy-image' | 'copy-path' | 'remove'

export interface ImagesUpdate {
  tabId: string
  cards: ImageCard[]
  unseen: number
  notice: string | null
}

export interface RestoreInfo {
  tabs: number
  claudeTabs: number
  savedAt: string
}

export type Unsubscribe = () => void

export interface CtApi {
  appInfo(): Promise<AppInfo>
  rendererReady(): void
  bell(): void
  openTab(req: OpenTabRequest): Promise<TabInfo | null>
  closeTab(tabId: string): void
  activateTab(tabId: string): void
  renameTab(tabId: string, title: string | null): void
  reorderTabs(ids: string[]): void
  restartTab(tabId: string): void
  writePty(tabId: string, data: string): void
  resizePty(tabId: string, cols: number, rows: number): void
  listProfiles(): Promise<string[]>
  getSettings(): Promise<Settings>
  openSettingsFile(): void
  readClipboard(): Promise<ClipboardContent>
  writeClipboardText(text: string): void
  listImages(tabId: string): Promise<ImagesUpdate>
  markImagesSeen(tabId: string): void
  imageAction(cardId: string, action: ImageAction): void
  getRestoreInfo(): Promise<RestoreInfo | null>
  runRestore(): void
  openExternal(url: string): void
  pathForFile(file: File): string
  onTabOpened(cb: (tab: TabInfo) => void): Unsubscribe
  onTabUpdated(cb: (tab: TabInfo) => void): Unsubscribe
  onTabClosed(cb: (tabId: string) => void): Unsubscribe
  onTabActivated(cb: (tabId: string) => void): Unsubscribe
  onTabsOrder(cb: (ids: string[]) => void): Unsubscribe
  onPtyData(cb: (tabId: string, data: string) => void): Unsubscribe
  onPtyExit(cb: (tabId: string, code: number) => void): Unsubscribe
  onImages(cb: (update: ImagesUpdate) => void): Unsubscribe
  onToast(cb: (message: string) => void): Unsubscribe
  onSettings(cb: (settings: Settings) => void): Unsubscribe
  onRestore(cb: (info: RestoreInfo | null) => void): Unsubscribe
}
```

- [ ] **Step 5: Написать падающий интеграционный тест PTY**

`tests/integration/pty-host.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { spawnPty } from '../../src/main/pty-host'

const env = process.env as Record<string, string>

describe('spawnPty', () => {
  it('runs a process and reports output and exit code', async () => {
    let out = ''
    const code = await new Promise<number>((resolve) => {
      spawnPty({ file: 'cmd.exe', args: ['/c', 'echo pty-ok'], cwd: process.cwd(), env, cols: 80, rows: 24, onData: (d) => { out += d }, onExit: resolve })
    })
    expect(code).toBe(0)
    await vi.waitFor(() => expect(out).toContain('pty-ok'))
  })

  it('accepts a pre-built command line string', async () => {
    let out = ''
    await new Promise<number>((resolve) => {
      spawnPty({ file: 'cmd.exe', args: '/c echo "quoted arg"', cwd: process.cwd(), env, cols: 80, rows: 24, onData: (d) => { out += d }, onExit: resolve })
    })
    await vi.waitFor(() => expect(out).toContain('"quoted arg"'))
  })

  it('kill() is idempotent and write after kill is ignored', () => {
    const h = spawnPty({ file: 'cmd.exe', args: [], cwd: process.cwd(), env, cols: 80, rows: 24, onData: () => {}, onExit: () => {} })
    h.kill()
    expect(() => h.kill()).not.toThrow()
    expect(() => h.write('dir\r')).not.toThrow()
    expect(() => h.resize(100, 30)).not.toThrow()
  })
})
```

- [ ] **Step 6: Запустить — убедиться, что падает**

Run: `npx vitest run tests/integration/pty-host.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/pty-host'` (или аналог).

- [ ] **Step 7: Реализовать `pty-host.ts`**

`src/main/pty-host.ts`:
```ts
import * as pty from 'node-pty'

export interface PtyHandle {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface SpawnOptions {
  file: string
  args: string[] | string
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  onData(data: string): void
  onExit(exitCode: number): void
}

export type SpawnPty = (opts: SpawnOptions) => PtyHandle

export const spawnPty: SpawnPty = (o) => {
  const p = pty.spawn(o.file, o.args, {
    name: 'xterm-256color',
    cols: Math.max(o.cols, 2),
    rows: Math.max(o.rows, 1),
    cwd: o.cwd,
    env: o.env,
    useConpty: true
  })
  let alive = true
  p.onData(o.onData)
  p.onExit(({ exitCode }) => {
    alive = false
    o.onExit(exitCode)
  })
  return {
    pid: p.pid,
    write: (d) => { if (alive) p.write(d) },
    resize: (c, r) => { if (alive) p.resize(Math.max(c, 2), Math.max(r, 1)) },
    kill: () => {
      if (!alive) return
      alive = false
      try { p.kill() } catch { /* process already gone */ }
    }
  }
}
```

- [ ] **Step 8: Запустить — убедиться, что проходит**

Run: `npx vitest run tests/integration/pty-host.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Main (временная версия), каталог данных, preload**

`src/main/data-dir.ts`:
```ts
import { app } from 'electron'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { defaultPipeName } from '../shared/protocol'

export function initDataDir(): string {
  const override = process.env.CLAUDETERM_DATA_DIR
  if (override) app.setPath('userData', override)
  else if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'ClaudeTerm-dev'))
  return app.getPath('userData')
}

export function resolvePipeName(): string {
  const user = userInfo().username
  return process.env.CLAUDETERM_PIPE_NAME ?? defaultPipeName(app.isPackaged ? user : `dev-${user}`)
}
```

`data-dir.ts` импортирует `defaultPipeName` из `src/shared/protocol.ts`, который создаётся в Task 2. Чтобы Task 1 собирался, создать сейчас минимальный `src/shared/protocol.ts` (Task 2 заменит его полной версией):
```ts
export function defaultPipeName(username: string): string {
  return `\\\\.\\pipe\\claudeterm-${username.replace(/[^A-Za-z0-9_.-]/g, '_')}`
}
```

`src/main/index.ts` (временная версия — одна вкладка Windows PowerShell, Task 9 заменит файл целиком):
```ts
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { homedir, release } from 'node:os'
import { join } from 'node:path'
import { IPC, type AppInfo } from '../shared/ipc'
import type { TabInfo } from '../shared/types'
import { initDataDir } from './data-dir'
import { spawnPty, type PtyHandle } from './pty-host'

initDataDir()
const ptys = new Map<string, PtyHandle>()
let win: BrowserWindow | null = null

const send = (channel: string, ...args: unknown[]): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function openShellTab(): void {
  const id = randomUUID()
  const cwd = homedir()
  const tab: TabInfo = { id, kind: 'shell', profile: 'Windows PowerShell', cwd, customTitle: null, claudeSessionId: null, exited: false }
  send(IPC.evTabOpened, tab)
  const env = { ...(process.env as Record<string, string>), CLAUDETERM_TAB_ID: id }
  delete env.ELECTRON_RENDERER_URL
  ptys.set(id, spawnPty({
    file: 'powershell.exe', args: ['-NoLogo'], cwd, env, cols: 120, rows: 30,
    onData: (d) => send(IPC.evPtyData, id, d),
    onExit: (code) => send(IPC.evPtyExit, id, code)
  }))
  send(IPC.evTabActivated, id)
}

app.whenReady().then(() => {
  ipcMain.handle(IPC.appInfo, (): AppInfo => ({ windowsBuild: Number(release().split('.')[2]) || 0, test: process.env.CLAUDETERM_TEST === '1', homeDir: homedir() }))
  ipcMain.on(IPC.rendererReady, () => openShellTab())
  ipcMain.on(IPC.ptyWrite, (_e, id: string, data: string) => ptys.get(id)?.write(data))
  ipcMain.on(IPC.ptyResize, (_e, id: string, cols: number, rows: number) => ptys.get(id)?.resize(cols, rows))
  ipcMain.on(IPC.openExternal, (_e, url: string) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url) })
  win = new BrowserWindow({
    width: 1200, height: 760, backgroundColor: '#0C0C0C', autoHideMenuBar: true, title: 'ClaudeTerm',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
})

app.on('window-all-closed', () => {
  for (const p of ptys.values()) p.kill()
  app.quit()
})
```

`src/preload/index.ts` (финальная версия):
```ts
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC, type CtApi } from '../shared/ipc'

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}

const api: CtApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  rendererReady: () => ipcRenderer.send(IPC.rendererReady),
  bell: () => ipcRenderer.send(IPC.bell),
  openTab: (req) => ipcRenderer.invoke(IPC.tabsOpen, req),
  closeTab: (id) => ipcRenderer.send(IPC.tabsClose, id),
  activateTab: (id) => ipcRenderer.send(IPC.tabsActivate, id),
  renameTab: (id, title) => ipcRenderer.send(IPC.tabsRename, id, title),
  reorderTabs: (ids) => ipcRenderer.send(IPC.tabsReorder, ids),
  restartTab: (id) => ipcRenderer.send(IPC.tabsRestart, id),
  writePty: (id, data) => ipcRenderer.send(IPC.ptyWrite, id, data),
  resizePty: (id, cols, rows) => ipcRenderer.send(IPC.ptyResize, id, cols, rows),
  listProfiles: () => ipcRenderer.invoke(IPC.profilesList),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  openSettingsFile: () => ipcRenderer.send(IPC.settingsOpen),
  readClipboard: () => ipcRenderer.invoke(IPC.clipboardRead),
  writeClipboardText: (text) => ipcRenderer.send(IPC.clipboardWriteText, text),
  listImages: (tabId) => ipcRenderer.invoke(IPC.imagesList, tabId),
  markImagesSeen: (tabId) => ipcRenderer.send(IPC.imagesMarkSeen, tabId),
  imageAction: (cardId, action) => ipcRenderer.send(IPC.imagesAction, cardId, action),
  getRestoreInfo: () => ipcRenderer.invoke(IPC.restoreGet),
  runRestore: () => ipcRenderer.send(IPC.restoreRun),
  openExternal: (url) => ipcRenderer.send(IPC.openExternal, url),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onTabOpened: (cb) => on(IPC.evTabOpened, cb),
  onTabUpdated: (cb) => on(IPC.evTabUpdated, cb),
  onTabClosed: (cb) => on(IPC.evTabClosed, cb),
  onTabActivated: (cb) => on(IPC.evTabActivated, cb),
  onTabsOrder: (cb) => on(IPC.evTabsOrder, cb),
  onPtyData: (cb) => on(IPC.evPtyData, cb),
  onPtyExit: (cb) => on(IPC.evPtyExit, cb),
  onImages: (cb) => on(IPC.evImages, cb),
  onToast: (cb) => on(IPC.evToast, cb),
  onSettings: (cb) => on(IPC.evSettings, cb),
  onRestore: (cb) => on(IPC.evRestore, cb)
}

contextBridge.exposeInMainWorld('ct', api)
```

- [ ] **Step 10: Renderer (temporary main.ts, final terminal-view/themes/env/html/css)**

`src/renderer/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' ctimg: data:; style-src 'self' 'unsafe-inline'; script-src 'self'" />
    <title>ClaudeTerm</title>
  </head>
  <body>
    <div id="app">
      <div id="tabbar"></div>
      <div id="banner" hidden></div>
      <div id="workspace">
        <div id="terminals"></div>
        <div id="image-panel" class="collapsed"></div>
      </div>
    </div>
    <div id="search" hidden></div>
    <div id="lightbox" hidden></div>
    <div id="toasts"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`src/renderer/styles.css`:
```css
:root {
  --bg: #0c0c0c;
  --chrome: #1b1b1f;
  --chrome-2: #26262c;
  --fg: #d6d6d6;
  --muted: #8a8a93;
  --accent: #d97757;
  --border: #33333a;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 13px "Segoe UI", system-ui, sans-serif; overflow: hidden; }
#app { display: flex; flex-direction: column; height: 100vh; }
#workspace { flex: 1; display: flex; min-height: 0; }
#terminals { flex: 1; position: relative; min-width: 0; }
.terminal-host { position: absolute; inset: 0; padding: 4px 0 0 6px; }
```

`src/renderer/env.d.ts`:
```ts
import type { CtApi } from '../shared/ipc'

export interface CtTestHook {
  activeTabId(): string | null
  tabIds(): string[]
  tabTitle(id: string): string | null
  bufferText(id?: string): string
  images?(id?: string): { name: string; source: string; caption: string | null }[]
  restoreVisible?(): boolean
}

declare global {
  interface Window {
    ct: CtApi
    __ct?: CtTestHook
  }
}

export {}
```

`src/renderer/themes.ts`:
```ts
import type { ITheme } from '@xterm/xterm'

export const THEMES: Record<string, ITheme> = {
  Campbell: {
    background: '#0C0C0C', foreground: '#CCCCCC', cursor: '#FFFFFF', selectionBackground: '#FFFFFF40',
    black: '#0C0C0C', red: '#C50F1F', green: '#13A10E', yellow: '#C19C00', blue: '#0037DA', magenta: '#881798', cyan: '#3A96DD', white: '#CCCCCC',
    brightBlack: '#767676', brightRed: '#E74856', brightGreen: '#16C60C', brightYellow: '#F9F1A5', brightBlue: '#3B78FF', brightMagenta: '#B4009E', brightCyan: '#61D6D6', brightWhite: '#F2F2F2'
  },
  'One Half Dark': {
    background: '#282C34', foreground: '#DCDFE4', cursor: '#A3B3CC', selectionBackground: '#FFFFFF40',
    black: '#282C34', red: '#E06C75', green: '#98C379', yellow: '#E5C07B', blue: '#61AFEF', magenta: '#C678DD', cyan: '#56B6C2', white: '#DCDFE4',
    brightBlack: '#5A6374', brightRed: '#E06C75', brightGreen: '#98C379', brightYellow: '#E5C07B', brightBlue: '#61AFEF', brightMagenta: '#C678DD', brightCyan: '#56B6C2', brightWhite: '#DCDFE4'
  },
  'One Half Light': {
    background: '#FAFAFA', foreground: '#383A42', cursor: '#4F525D', selectionBackground: '#00000030',
    black: '#383A42', red: '#E45649', green: '#50A14F', yellow: '#C18301', blue: '#0184BC', magenta: '#A626A4', cyan: '#0997B3', white: '#FAFAFA',
    brightBlack: '#4F525D', brightRed: '#DF6C75', brightGreen: '#98C379', brightYellow: '#E4C07A', brightBlue: '#61AFEF', brightMagenta: '#C577DD', brightCyan: '#56B5C1', brightWhite: '#FFFFFF'
  }
}

export function resolveTheme(theme: string | Record<string, string>): ITheme {
  if (typeof theme === 'string') return THEMES[theme] ?? THEMES.Campbell
  return { ...THEMES.Campbell, ...theme }
}
```

`src/renderer/terminal-view.ts` (финальная версия):
```ts
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

export interface TerminalViewOptions {
  tabId: string
  container: HTMLElement
  fontFamily: string
  fontSize: number
  theme: ITheme
  scrollback: number
  windowsBuild: number
  useWebgl: boolean
  onInput(data: string): void
  onResize(cols: number, rows: number): void
  onTitle(title: string): void
  onBell(): void
  onLink(uri: string): void
  onKey?(e: KeyboardEvent): boolean
}

export class TerminalView {
  readonly term: Terminal
  readonly search: SearchAddon
  readonly element: HTMLDivElement
  private readonly fit: FitAddon
  private readonly ro: ResizeObserver

  constructor(o: TerminalViewOptions) {
    this.element = document.createElement('div')
    this.element.className = 'terminal-host'
    o.container.appendChild(this.element)
    this.term = new Terminal({
      allowProposedApi: true,
      fontFamily: o.fontFamily,
      fontSize: o.fontSize,
      theme: o.theme,
      scrollback: o.scrollback,
      cursorBlink: true,
      windowsPty: { backend: 'conpty', buildNumber: o.windowsBuild }
    })
    this.fit = new FitAddon()
    this.search = new SearchAddon()
    this.term.loadAddon(this.fit)
    this.term.loadAddon(this.search)
    this.term.loadAddon(new WebLinksAddon((_e, uri) => o.onLink(uri)))
    this.term.loadAddon(new Unicode11Addon())
    this.term.unicode.activeVersion = '11'
    this.term.open(this.element)
    if (o.useWebgl) {
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        this.term.loadAddon(webgl)
      } catch {
        // DOM renderer fallback
      }
    }
    if (o.onKey) this.term.attachCustomKeyEventHandler(o.onKey)
    this.term.onData(o.onInput)
    this.term.onTitleChange(o.onTitle)
    this.term.onBell(o.onBell)
    this.term.onResize(({ cols, rows }) => o.onResize(cols, rows))
    this.refit()
    o.onResize(this.term.cols, this.term.rows)
    this.ro = new ResizeObserver(() => this.refit())
    this.ro.observe(this.element)
  }

  refit(): void {
    if (this.element.offsetParent === null) return
    try { this.fit.fit() } catch { /* not measurable yet */ }
  }

  write(data: string): void { this.term.write(data) }

  show(visible: boolean): void {
    this.element.style.display = visible ? 'block' : 'none'
    if (visible) {
      this.refit()
      this.term.focus()
    }
  }

  setFont(family: string, size: number): void {
    this.term.options.fontFamily = family
    this.term.options.fontSize = size
    this.refit()
  }

  setTheme(theme: ITheme): void { this.term.options.theme = theme }

  bufferText(): string {
    const b = this.term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '')
    return lines.join('\n')
  }

  dispose(): void {
    this.ro.disconnect()
    this.term.dispose()
    this.element.remove()
  }
}
```

`src/renderer/main.ts` (временная версия — Task 9 заменит целиком):
```ts
import './styles.css'
import { TerminalView } from './terminal-view'
import { THEMES } from './themes'

const views = new Map<string, TerminalView>()
let activeId: string | null = null

async function boot(): Promise<void> {
  const info = await window.ct.appInfo()
  const host = document.getElementById('terminals')!
  window.ct.onTabOpened((tab) => {
    views.set(tab.id, new TerminalView({
      tabId: tab.id, container: host, fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 13,
      theme: THEMES.Campbell, scrollback: 10000, windowsBuild: info.windowsBuild, useWebgl: !info.test,
      onInput: (d) => window.ct.writePty(tab.id, d),
      onResize: (c, r) => window.ct.resizePty(tab.id, c, r),
      onTitle: () => {},
      onBell: () => {},
      onLink: (uri) => window.ct.openExternal(uri)
    }))
  })
  window.ct.onPtyData((id, d) => views.get(id)?.write(d))
  window.ct.onTabActivated((id) => {
    activeId = id
    for (const [vid, v] of views) v.show(vid === id)
  })
  if (info.test) {
    window.__ct = {
      activeTabId: () => activeId,
      tabIds: () => [...views.keys()],
      tabTitle: () => null,
      bufferText: (id) => views.get(id ?? activeId ?? '')?.bufferText() ?? ''
    }
  }
  window.ct.rendererReady()
}

void boot()
```

- [ ] **Step 11: E2E-хелперы и smoke-тест**

`tests/e2e/helpers.ts`:
```ts
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const ROOT = resolve(__dirname, '..', '..')

export const FAKE_CLAUDE_SETTINGS = { claude: { command: 'cmd /c echo fake-claude', shellProfile: 'Windows PowerShell' }, defaultProfile: 'Windows PowerShell' }

export const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

export function makeDataDir(settings?: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'ct-e2e-'))
  if (settings) writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings))
  return dir
}

export function testEnv(dataDir: string, pipeName: string): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    CLAUDETERM_TEST: '1',
    CLAUDETERM_DATA_DIR: dataDir,
    CLAUDETERM_PIPE_NAME: pipeName,
    CLAUDETERM_SKIP_MCP_REGISTER: '1'
  }
}

export interface Launched { app: ElectronApplication; page: Page; dataDir: string; pipeName: string }

export async function launchApp(o: { dataDir?: string; settings?: object; args?: string[] } = {}): Promise<Launched> {
  const dataDir = o.dataDir ?? makeDataDir(o.settings)
  const pipeName = `\\\\.\\pipe\\claudeterm-e2e-${randomUUID()}`
  const app = await electron.launch({ args: [ROOT, ...(o.args ?? [])], env: testEnv(dataDir, pipeName) })
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.__ct))
  return { app, page, dataDir, pipeName }
}

export async function typeInTerminal(page: Page, text: string): Promise<void> {
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

export function bufferText(page: Page, tabId?: string): Promise<string> {
  return page.evaluate((id) => window.__ct!.bufferText(id ?? undefined), tabId ?? null)
}
```

`tests/e2e/smoke.spec.ts`:
```ts
import { expect, test } from '@playwright/test'
import { bufferText, launchApp, typeInTerminal } from './helpers'

test('default tab runs a shell command', async () => {
  const { app, page } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  await typeInTerminal(page, "echo ('hel' + 'lo-ct')")
  await expect.poll(() => bufferText(page), { timeout: 15_000 }).toMatch(/^hello-ct$/m)
  await app.close()
})
```

- [ ] **Step 12: Собрать и прогнать e2e**

Run: `npm run typecheck` → Expected: без ошибок.
Run: `npm run test:e2e` → Expected: `1 passed`.

- [ ] **Step 13: Ручная проверка вертикального среза с настоящим claude**

Run: `npm run dev`. В открывшейся вкладке PowerShell выполнить `claude`. Проверить и записать в отчёт задачи: TUI отрисовывается без артефактов, ресайз окна перерисовывает корректно, цвета есть, Ctrl+C выходит. (Shift+Enter и вставка картинки проверяются в Task 10.)

- [ ] **Step 14: Checkpoint**

Run: `npm test` → Expected: PASS. Не коммитить.

---
### Task 2: Протокол пайпа и проверка файлов картинок

**Files:**
- Modify (полная замена временной версии из Task 1): `src/shared/protocol.ts`
- Create: `src/shared/image-file.ts`
- Test: `tests/unit/protocol.test.ts`, `tests/unit/image-file.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `protocol.ts`: `PROTOCOL_VERSION`, `interface ShowImageMessage { v: 1; type: 'show_image'; tabId: string | null; path: string; caption: string | null }`, `interface SessionMessage { v: 1; type: 'session'; tabId: string; sessionId: string; source: string; transcriptPath: string | null }`, `type PipeMessage`, `type PipeResponse = { ok: true } | { ok: false; error: string }`, `isUuid(v): v is string`, `defaultPipeName(username): string`, `parsePipeMessage(line): ParseResult`, `encodeMessage(msg): string` (JSON + `\n`).
  - `image-file.ts`: `DEFAULT_IMAGE_EXTENSIONS`, `MAX_IMAGE_BYTES`, `hasImageExtension(path, exts): boolean`, `checkImageFile(path, exts?): Promise<{ ok: true; size: number } | { ok: false; error: string }>`.

- [ ] **Step 1: Написать падающие тесты**

`tests/unit/protocol.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { defaultPipeName, encodeMessage, isUuid, parsePipeMessage } from '../../src/shared/protocol'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

describe('parsePipeMessage', () => {
  it('accepts a show_image message', () => {
    const r = parsePipeMessage(JSON.stringify({ v: 1, type: 'show_image', tabId: TAB, path: 'D:\\proj\\out\\plot.png', caption: 'Plot' }))
    expect(r).toEqual({ ok: true, message: { v: 1, type: 'show_image', tabId: TAB, path: 'D:\\proj\\out\\plot.png', caption: 'Plot' } })
  })

  it('defaults missing tabId and caption to null', () => {
    const r = parsePipeMessage(JSON.stringify({ v: 1, type: 'show_image', path: 'C:\\a.png' }))
    expect(r).toEqual({ ok: true, message: { v: 1, type: 'show_image', tabId: null, path: 'C:\\a.png', caption: null } })
  })

  it('truncates captions to 500 characters', () => {
    const r = parsePipeMessage(JSON.stringify({ v: 1, type: 'show_image', path: 'C:\\a.png', caption: 'x'.repeat(900) }))
    expect(r.ok && r.message.type === 'show_image' && r.message.caption?.length).toBe(500)
  })

  it('rejects relative paths, bad JSON, non-objects, unknown versions and types', () => {
    expect(parsePipeMessage(JSON.stringify({ v: 1, type: 'show_image', path: 'out\\a.png' })).ok).toBe(false)
    expect(parsePipeMessage('{not json').ok).toBe(false)
    expect(parsePipeMessage('[1,2]').ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ v: 2, type: 'show_image', path: 'C:\\a.png' })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ v: 1, type: 'run', cmd: 'calc' })).ok).toBe(false)
  })

  it('accepts a session message with transcript path', () => {
    const tp = 'C:\\Users\\u\\.claude\\projects\\D--x\\s.jsonl'
    const r = parsePipeMessage(JSON.stringify({ v: 1, type: 'session', tabId: TAB, sessionId: SID, source: 'clear', transcriptPath: tp }))
    expect(r).toEqual({ ok: true, message: { v: 1, type: 'session', tabId: TAB, sessionId: SID, source: 'clear', transcriptPath: tp } })
  })

  it('nulls an invalid transcript path and defaults source', () => {
    const r = parsePipeMessage(JSON.stringify({ v: 1, type: 'session', tabId: TAB, sessionId: SID, transcriptPath: 'C:\\x\\evil.exe' }))
    expect(r).toEqual({ ok: true, message: { v: 1, type: 'session', tabId: TAB, sessionId: SID, source: 'unknown', transcriptPath: null } })
  })

  it('rejects a session message with non-UUID ids', () => {
    expect(parsePipeMessage(JSON.stringify({ v: 1, type: 'session', tabId: TAB, sessionId: 'abc; rm -rf /' })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ v: 1, type: 'session', tabId: 'nope', sessionId: SID })).ok).toBe(false)
  })
})

describe('helpers', () => {
  it('isUuid', () => {
    expect(isUuid(SID)).toBe(true)
    expect(isUuid('5d2c1b7a')).toBe(false)
    expect(isUuid(42)).toBe(false)
  })

  it('defaultPipeName sanitizes the user name', () => {
    expect(defaultPipeName('John Doe')).toBe('\\\\.\\pipe\\claudeterm-John_Doe')
  })

  it('encodeMessage produces one line', () => {
    expect(encodeMessage({ ok: true })).toBe('{"ok":true}\n')
  })
})
```

`tests/unit/image-file.test.ts`:
```ts
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkImageFile, hasImageExtension, MAX_IMAGE_BYTES } from '../../src/shared/image-file'

const dir = mkdtempSync(join(tmpdir(), 'ct-img-'))

describe('hasImageExtension', () => {
  it('is case-insensitive and needs an extension', () => {
    expect(hasImageExtension('C:\\a\\Shot.PNG', ['png'])).toBe(true)
    expect(hasImageExtension('C:\\a\\notes.txt', ['png'])).toBe(false)
    expect(hasImageExtension('C:\\a\\png', ['png'])).toBe(false)
  })
})

describe('checkImageFile', () => {
  it('accepts an existing image', async () => {
    const p = join(dir, 'ok.png')
    writeFileSync(p, Buffer.from([1, 2, 3]))
    expect(await checkImageFile(p)).toEqual({ ok: true, size: 3 })
  })

  it('rejects missing files, wrong types, directories and huge files', async () => {
    expect((await checkImageFile(join(dir, 'missing.png'))).ok).toBe(false)
    const txt = join(dir, 'a.txt')
    writeFileSync(txt, 'x')
    expect((await checkImageFile(txt)).ok).toBe(false)
    const folder = join(dir, 'folder.png')
    mkdirSync(folder)
    expect((await checkImageFile(folder)).ok).toBe(false)
    const big = join(dir, 'big.png')
    const fd = openSync(big, 'w')
    ftruncateSync(fd, MAX_IMAGE_BYTES + 1)
    closeSync(fd)
    const r = await checkImageFile(big)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain('50 MB')
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падают**

Run: `npx vitest run tests/unit/protocol.test.ts tests/unit/image-file.test.ts`
Expected: FAIL (нет экспорта `parsePipeMessage`, нет модуля `image-file`).

- [ ] **Step 3: Реализовать**

`src/shared/protocol.ts`:
```ts
import { isAbsolute } from 'node:path'

export const PROTOCOL_VERSION = 1
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_CAPTION = 500

export interface ShowImageMessage {
  v: 1
  type: 'show_image'
  tabId: string | null
  path: string
  caption: string | null
}

export interface SessionMessage {
  v: 1
  type: 'session'
  tabId: string
  sessionId: string
  source: string
  transcriptPath: string | null
}

export type PipeMessage = ShowImageMessage | SessionMessage
export type PipeResponse = { ok: true } | { ok: false; error: string }
export type ParseResult = { ok: true; message: PipeMessage } | { ok: false; error: string }

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function defaultPipeName(username: string): string {
  return `\\\\.\\pipe\\claudeterm-${username.replace(/[^A-Za-z0-9_.-]/g, '_')}`
}

export function encodeMessage(msg: PipeMessage | PipeResponse): string {
  return JSON.stringify(msg) + '\n'
}

export function parsePipeMessage(line: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { ok: false, error: 'invalid JSON' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'message must be a JSON object' }
  const m = raw as Record<string, unknown>
  if (m.v !== PROTOCOL_VERSION) return { ok: false, error: `unsupported protocol version: ${String(m.v)}` }

  if (m.type === 'show_image') {
    if (typeof m.path !== 'string' || !isAbsolute(m.path)) return { ok: false, error: 'path must be an absolute path' }
    if (m.tabId !== undefined && m.tabId !== null && typeof m.tabId !== 'string') return { ok: false, error: 'tabId must be a string or null' }
    if (m.caption !== undefined && m.caption !== null && typeof m.caption !== 'string') return { ok: false, error: 'caption must be a string or null' }
    return {
      ok: true,
      message: {
        v: 1,
        type: 'show_image',
        tabId: typeof m.tabId === 'string' ? m.tabId : null,
        path: m.path,
        caption: typeof m.caption === 'string' ? m.caption.slice(0, MAX_CAPTION) : null
      }
    }
  }

  if (m.type === 'session') {
    if (!isUuid(m.tabId)) return { ok: false, error: 'tabId must be a UUID' }
    if (!isUuid(m.sessionId)) return { ok: false, error: 'sessionId must be a UUID' }
    const tp = m.transcriptPath
    const transcriptPath = typeof tp === 'string' && isAbsolute(tp) && tp.toLowerCase().endsWith('.jsonl') ? tp : null
    return {
      ok: true,
      message: { v: 1, type: 'session', tabId: m.tabId, sessionId: m.sessionId, source: typeof m.source === 'string' ? m.source : 'unknown', transcriptPath }
    }
  }

  return { ok: false, error: `unknown message type: ${String(m.type)}` }
}
```

`src/shared/image-file.ts`:
```ts
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'

export const DEFAULT_IMAGE_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024

export type ImageCheck = { ok: true; size: number } | { ok: false; error: string }

export function hasImageExtension(path: string, extensions: readonly string[]): boolean {
  const ext = extname(path).slice(1).toLowerCase()
  return ext.length > 0 && extensions.some((e) => e.toLowerCase().replace(/^\./, '') === ext)
}

export async function checkImageFile(path: string, extensions: readonly string[] = DEFAULT_IMAGE_EXTENSIONS): Promise<ImageCheck> {
  if (!hasImageExtension(path, extensions)) return { ok: false, error: `not a supported image type (${extensions.join(', ')}): ${path}` }
  let st
  try {
    st = await stat(path)
  } catch {
    return { ok: false, error: `file not found: ${path}` }
  }
  if (!st.isFile()) return { ok: false, error: `not a file: ${path}` }
  if (st.size > MAX_IMAGE_BYTES) return { ok: false, error: `image is larger than 50 MB: ${path}` }
  return { ok: true, size: st.size }
}
```

- [ ] **Step 4: Запустить — убедиться, что проходят**

Run: `npx vitest run tests/unit/protocol.test.ts tests/unit/image-file.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `npm test && npm run typecheck` → PASS. Не коммитить.

---

### Task 3: Настройки (`settings.json`)

**Files:**
- Create: `src/main/settings.ts`
- Test: `tests/unit/settings.test.ts`

**Interfaces:**
- Consumes: `Settings`, `ProfileDef` из `src/shared/types.ts`.
- Produces: `DEFAULT_SETTINGS: Settings`, `interface ParsedSettings { settings: Settings; errors: string[] }`, `parseSettings(text: string | null): ParsedSettings`, `loadSettingsFile(path: string): ParsedSettings` (если файла нет — создаёт его с дефолтами).

- [ ] **Step 1: Написать падающий тест**

`tests/unit/settings.test.ts`:
```ts
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, loadSettingsFile, parseSettings } from '../../src/main/settings'

describe('parseSettings', () => {
  it('returns defaults for null or empty text', () => {
    expect(parseSettings(null)).toEqual({ settings: DEFAULT_SETTINGS, errors: [] })
    expect(parseSettings('  ')).toEqual({ settings: DEFAULT_SETTINGS, errors: [] })
  })

  it('merges partial overrides', () => {
    const { settings, errors } = parseSettings(JSON.stringify({ font: { size: 16 }, claude: { shellProfile: 'Git Bash' } }))
    expect(errors).toEqual([])
    expect(settings.font).toEqual({ family: DEFAULT_SETTINGS.font.family, size: 16 })
    expect(settings.claude).toEqual({ command: 'claude', shellProfile: 'Git Bash' })
    expect(settings.imageWatch).toEqual(DEFAULT_SETTINGS.imageWatch)
  })

  it('reports invalid JSON and falls back to defaults', () => {
    const r = parseSettings('{ "font": ')
    expect(r.settings).toEqual(DEFAULT_SETTINGS)
    expect(r.errors[0]).toMatch(/^settings\.json:/)
  })

  it('replaces invalid values with defaults and names the key', () => {
    const r = parseSettings(JSON.stringify({ scrollback: -5, font: { size: 'big' }, imagePanel: { autoOpen: 'yes' } }))
    expect(r.settings.scrollback).toBe(DEFAULT_SETTINGS.scrollback)
    expect(r.settings.font.size).toBe(DEFAULT_SETTINGS.font.size)
    expect(r.settings.imagePanel.autoOpen).toBe(true)
    const all = r.errors.join('\n')
    expect(all).toContain('"scrollback"')
    expect(all).toContain('"font.size"')
    expect(all).toContain('"imagePanel.autoOpen"')
  })

  it('normalizes profiles without args', () => {
    const r = parseSettings(JSON.stringify({ profiles: [{ name: 'My Bash', command: 'C:\\x\\bash.exe' }] }))
    expect(r.settings.profiles).toEqual([{ name: 'My Bash', command: 'C:\\x\\bash.exe', args: [] }])
  })

  it('accepts a theme object', () => {
    expect(parseSettings(JSON.stringify({ theme: { background: '#000000' } })).settings.theme).toEqual({ background: '#000000' })
  })
})

describe('loadSettingsFile', () => {
  it('creates the file with defaults when missing', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'ct-set-')), 'sub', 'settings.json')
    expect(loadSettingsFile(p).settings).toEqual(DEFAULT_SETTINGS)
    expect(existsSync(p)).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual(DEFAULT_SETTINGS)
  })

  it('strips a UTF-8 BOM', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'ct-set-')), 'settings.json')
    writeFileSync(p, '\uFEFF' + JSON.stringify({ scrollback: 500 }), 'utf8')
    expect(loadSettingsFile(p)).toEqual({ settings: { ...DEFAULT_SETTINGS, scrollback: 500 }, errors: [] })
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run tests/unit/settings.test.ts`
Expected: FAIL (модуль не найден).

- [ ] **Step 3: Реализовать `src/main/settings.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ProfileDef, Settings } from '../shared/types'

export const DEFAULT_SETTINGS: Settings = {
  defaultProfile: null,
  claude: { command: 'claude', shellProfile: null },
  profiles: [],
  font: { family: 'Cascadia Mono, Consolas, monospace', size: 13 },
  theme: 'Campbell',
  scrollback: 10000,
  imageWatch: {
    enabled: true,
    extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
    ignore: ['.git', 'node_modules', 'Intermediate', 'DerivedDataCache', 'Binaries', '.vs', '.idea'],
    maxDepth: 8
  },
  imagePanel: { autoOpen: true, width: 320, maxItems: 200 }
}

export interface ParsedSettings {
  settings: Settings
  errors: string[]
}

type Guard<T> = (v: unknown) => v is T
interface RawProfile { name: string; command: string; args?: string[] }

const isStr: Guard<string> = (v): v is string => typeof v === 'string' && v.length > 0
const isNullableStr: Guard<string | null> = (v): v is string | null => v === null || isStr(v)
const isBool: Guard<boolean> = (v): v is boolean => typeof v === 'boolean'
const isStrArr: Guard<string[]> = (v): v is string[] => Array.isArray(v) && v.every(isStr)
const numIn = (min: number, max: number): Guard<number> => (v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const isPlainObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTheme: Guard<Settings['theme']> = (v): v is Settings['theme'] => isStr(v) || (isPlainObj(v) && Object.values(v).every((x) => typeof x === 'string'))
const isProfiles: Guard<RawProfile[]> = (v): v is RawProfile[] =>
  Array.isArray(v) && v.every((p) => isPlainObj(p) && isStr(p.name) && isStr(p.command) && (p.args === undefined || isStrArr(p.args)))

export function parseSettings(text: string | null): ParsedSettings {
  const d = structuredClone(DEFAULT_SETTINGS)
  if (text === null || text.trim() === '') return { settings: d, errors: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { settings: d, errors: [`settings.json: ${(e as Error).message}`] }
  }
  if (!isPlainObj(raw)) return { settings: d, errors: ['settings.json: root must be an object'] }

  const errors: string[] = []
  const take = <T>(key: string, value: unknown, ok: Guard<T>, fallback: T): T => {
    if (value === undefined) return fallback
    if (ok(value)) return value
    errors.push(`settings.json: invalid value for "${key}", using default`)
    return fallback
  }
  const obj = (v: unknown): Record<string, unknown> => (isPlainObj(v) ? v : {})
  const claude = obj(raw.claude)
  const font = obj(raw.font)
  const iw = obj(raw.imageWatch)
  const ip = obj(raw.imagePanel)

  const profiles: ProfileDef[] = take('profiles', raw.profiles, isProfiles, []).map((p) => ({ name: p.name, command: p.command, args: p.args ?? [] }))

  const settings: Settings = {
    defaultProfile: take('defaultProfile', raw.defaultProfile, isNullableStr, d.defaultProfile),
    claude: {
      command: take('claude.command', claude.command, isStr, d.claude.command),
      shellProfile: take('claude.shellProfile', claude.shellProfile, isNullableStr, d.claude.shellProfile)
    },
    profiles,
    font: {
      family: take('font.family', font.family, isStr, d.font.family),
      size: take('font.size', font.size, numIn(6, 72), d.font.size)
    },
    theme: take('theme', raw.theme, isTheme, d.theme),
    scrollback: take('scrollback', raw.scrollback, numIn(0, 1_000_000), d.scrollback),
    imageWatch: {
      enabled: take('imageWatch.enabled', iw.enabled, isBool, d.imageWatch.enabled),
      extensions: take('imageWatch.extensions', iw.extensions, isStrArr, d.imageWatch.extensions),
      ignore: take('imageWatch.ignore', iw.ignore, isStrArr, d.imageWatch.ignore),
      maxDepth: take('imageWatch.maxDepth', iw.maxDepth, numIn(0, 64), d.imageWatch.maxDepth)
    },
    imagePanel: {
      autoOpen: take('imagePanel.autoOpen', ip.autoOpen, isBool, d.imagePanel.autoOpen),
      width: take('imagePanel.width', ip.width, numIn(120, 4000), d.imagePanel.width),
      maxItems: take('imagePanel.maxItems', ip.maxItems, numIn(1, 10_000), d.imagePanel.maxItems)
    }
  }
  return { settings, errors }
}

export function loadSettingsFile(path: string): ParsedSettings {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8')
    return { settings: structuredClone(DEFAULT_SETTINGS), errors: [] }
  }
  return parseSettings(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
}
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `npx vitest run tests/unit/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `npm test && npm run typecheck` → PASS. Не коммитить.

---

### Task 4: Профили шеллов и командные строки Claude-вкладок

**Files:**
- Create: `src/main/profiles.ts`
- Test: `tests/unit/profiles.test.ts`

**Interfaces:**
- Consumes: `ProfileDef`, `ShellFamily`, `TabKind` (types.ts); `isUuid` (protocol.ts).
- Produces:
  - `interface DetectDeps { exists(p): boolean; env: Record<string, string | undefined>; findInPath(exe): string | null; listWslDistros(): string[] }`
  - `detectProfiles(deps): ProfileDef[]`, `mergeProfiles(detected, user): ProfileDef[]`, `pickProfile(profiles, preferred: string | null): ProfileDef` (бросает, если профилей нет), `canHostClaude(p): boolean`, `pickClaudeProfile(profiles, preferred): { profile: ProfileDef; warning: string | null }`
  - `shellFamily(p): ShellFamily`, `quoteForShell(family, value): string`
  - `interface ClaudeLaunch { command: string; settingsPath: string; resumeSessionId: string | null }`, `buildClaudeCommandLine(family, c): string`
  - `interface LaunchSpec { file: string; args: string[] | string }`, `buildLaunch(profile, kind, claude: ClaudeLaunch | null): LaunchSpec`
  - `systemDetectDeps(): DetectDeps`, `parseWslList(buf: Buffer): string[]`

- [ ] **Step 1: Написать падающий тест**

`tests/unit/profiles.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  buildClaudeCommandLine, buildLaunch, canHostClaude, detectProfiles, mergeProfiles, parseWslList,
  pickClaudeProfile, pickProfile, quoteForShell, shellFamily, type DetectDeps
} from '../../src/main/profiles'
import type { ProfileDef } from '../../src/shared/types'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const PS: ProfileDef = { name: 'Windows PowerShell', command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo'] }
const CMD: ProfileDef = { name: 'Command Prompt', command: 'C:\\Windows\\System32\\cmd.exe', args: [] }
const BASH: ProfileDef = { name: 'Git Bash', command: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] }
const WSL: ProfileDef = { name: 'WSL: Ubuntu', command: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'] }

function deps(files: string[], extra: Partial<DetectDeps> = {}): DetectDeps {
  return {
    exists: (p) => files.includes(p),
    env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
    findInPath: () => null,
    listWslDistros: () => ['Ubuntu', 'Debian'],
    ...extra
  }
}

describe('detectProfiles', () => {
  it('finds Windows PowerShell, cmd, Git Bash and WSL distros', () => {
    const found = detectProfiles(deps([PS.command, CMD.command, BASH.command, WSL.command]))
    expect(found.map((p) => p.name)).toEqual(['Windows PowerShell', 'Command Prompt', 'Git Bash', 'WSL: Ubuntu', 'WSL: Debian'])
    expect(found.find((p) => p.name === 'WSL: Debian')?.args).toEqual(['-d', 'Debian'])
  })

  it('prefers pwsh from PATH and lists it first', () => {
    const found = detectProfiles(deps([PS.command], { findInPath: (exe) => (exe === 'pwsh.exe' ? 'C:\\tools\\pwsh.exe' : null) }))
    expect(found[0]).toEqual({ name: 'PowerShell 7', command: 'C:\\tools\\pwsh.exe', args: ['-NoLogo'] })
  })

  it('falls back to Program Files for pwsh', () => {
    const found = detectProfiles(deps(['C:\\Program Files\\PowerShell\\7\\pwsh.exe']))
    expect(found[0].command).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  })
})

describe('profile selection', () => {
  it('mergeProfiles: user overrides by name and appends new ones', () => {
    const userBash = { ...BASH, args: ['-l'] }
    const custom = { name: 'Custom', command: 'C:\\x.exe', args: [] }
    expect(mergeProfiles([PS, BASH], [userBash, custom])).toEqual([PS, userBash, custom])
  })

  it('pickProfile: preferred, then PowerShell 7, then Windows PowerShell, then first', () => {
    const pwsh = { name: 'PowerShell 7', command: 'C:\\pwsh.exe', args: [] }
    expect(pickProfile([CMD, PS, pwsh], 'Command Prompt')).toBe(CMD)
    expect(pickProfile([CMD, PS, pwsh], null)).toBe(pwsh)
    expect(pickProfile([CMD, PS], 'Missing')).toBe(PS)
    expect(pickProfile([CMD], null)).toBe(CMD)
    expect(() => pickProfile([], null)).toThrow()
  })

  it('pickClaudeProfile refuses WSL and warns', () => {
    expect(canHostClaude(WSL)).toBe(false)
    const r = pickClaudeProfile([PS, WSL], 'WSL: Ubuntu')
    expect(r.profile).toBe(PS)
    expect(r.warning).toContain('cannot run claude')
    expect(pickClaudeProfile([PS, BASH], 'Git Bash')).toEqual({ profile: BASH, warning: null })
    expect(pickClaudeProfile([PS], 'Nope').warning).toContain('not found')
  })
})

describe('shell families and quoting', () => {
  it('shellFamily by executable name', () => {
    expect(shellFamily(PS)).toBe('powershell')
    expect(shellFamily({ ...PS, command: 'C:\\tools\\pwsh.exe' })).toBe('powershell')
    expect(shellFamily(CMD)).toBe('cmd')
    expect(shellFamily(BASH)).toBe('bash')
    expect(shellFamily(WSL)).toBe('wsl')
    expect(shellFamily({ name: 'x', command: 'C:\\nu.exe', args: [] })).toBe('other')
  })

  it('quotes paths with spaces and apostrophes for every shell', () => {
    const p = "C:\\Users\\Bob O'Neil\\AppData\\Roaming\\ClaudeTerm\\claude-tab-settings.json"
    expect(quoteForShell('powershell', p)).toBe("'C:\\Users\\Bob O''Neil\\AppData\\Roaming\\ClaudeTerm\\claude-tab-settings.json'")
    expect(quoteForShell('cmd', p)).toBe(`"${p}"`)
    expect(quoteForShell('bash', p)).toBe("'C:/Users/Bob O'\\''Neil/AppData/Roaming/ClaudeTerm/claude-tab-settings.json'")
    expect(() => quoteForShell('wsl', p)).toThrow()
  })
})

describe('claude launch', () => {
  const claude = { command: 'claude', settingsPath: 'C:\\Users\\me\\AppData\\Roaming\\ClaudeTerm\\claude-tab-settings.json', resumeSessionId: null }

  it('buildClaudeCommandLine adds --settings and optional --resume', () => {
    expect(buildClaudeCommandLine('powershell', claude)).toBe("claude --settings 'C:\\Users\\me\\AppData\\Roaming\\ClaudeTerm\\claude-tab-settings.json'")
    expect(buildClaudeCommandLine('cmd', { ...claude, resumeSessionId: SID })).toBe(`claude --settings "${claude.settingsPath}" --resume ${SID}`)
  })

  it('rejects a non-UUID resume id', () => {
    expect(() => buildClaudeCommandLine('cmd', { ...claude, resumeSessionId: 'x & calc' })).toThrow()
  })

  it('buildLaunch for shell tabs uses the profile as is', () => {
    expect(buildLaunch(BASH, 'shell', null)).toEqual({ file: BASH.command, args: ['--login', '-i'] })
  })

  it('buildLaunch for claude tabs keeps the shell open after claude exits', () => {
    expect(buildLaunch(PS, 'claude', claude)).toEqual({ file: PS.command, args: ['-NoLogo', '-NoExit', '-Command', buildClaudeCommandLine('powershell', claude)] })
    expect(buildLaunch(CMD, 'claude', claude)).toEqual({ file: CMD.command, args: `/k ${buildClaudeCommandLine('cmd', claude)}` })
    expect(buildLaunch(BASH, 'claude', claude)).toEqual({ file: BASH.command, args: ['--login', '-i', '-c', `${buildClaudeCommandLine('bash', claude)}; exec bash --login -i`] })
    expect(() => buildLaunch(WSL, 'claude', claude)).toThrow()
    expect(() => buildLaunch(PS, 'claude', null)).toThrow()
  })
})

describe('parseWslList', () => {
  it('decodes UTF-16LE output with BOM and blank lines', () => {
    expect(parseWslList(Buffer.from('\uFEFFUbuntu\r\nDebian\r\n\r\n', 'utf16le'))).toEqual(['Ubuntu', 'Debian'])
  })

  it('decodes UTF-8 output', () => {
    expect(parseWslList(Buffer.from('Ubuntu\nkali-linux\n', 'utf8'))).toEqual(['Ubuntu', 'kali-linux'])
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run tests/unit/profiles.test.ts`
Expected: FAIL (модуль не найден).

- [ ] **Step 3: Реализовать `src/main/profiles.ts`**

```ts
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { isUuid } from '../shared/protocol'
import type { ProfileDef, ShellFamily, TabKind } from '../shared/types'

export interface DetectDeps {
  exists(path: string): boolean
  env: Record<string, string | undefined>
  findInPath(exe: string): string | null
  listWslDistros(): string[]
}

export function detectProfiles(deps: DetectDeps): ProfileDef[] {
  const sysRoot = deps.env.SystemRoot ?? 'C:\\Windows'
  const progFiles = deps.env.ProgramFiles ?? 'C:\\Program Files'
  const out: ProfileDef[] = []

  const pwsh = deps.findInPath('pwsh.exe')
    ?? [win32.join(progFiles, 'PowerShell', '7', 'pwsh.exe'), win32.join(progFiles, 'PowerShell', '7-preview', 'pwsh.exe')].find((p) => deps.exists(p))
    ?? null
  if (pwsh) out.push({ name: 'PowerShell 7', command: pwsh, args: ['-NoLogo'] })

  const winPs = win32.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (deps.exists(winPs)) out.push({ name: 'Windows PowerShell', command: winPs, args: ['-NoLogo'] })

  const cmd = win32.join(sysRoot, 'System32', 'cmd.exe')
  if (deps.exists(cmd)) out.push({ name: 'Command Prompt', command: cmd, args: [] })

  const gitBash = win32.join(progFiles, 'Git', 'bin', 'bash.exe')
  if (deps.exists(gitBash)) out.push({ name: 'Git Bash', command: gitBash, args: ['--login', '-i'] })

  const wsl = win32.join(sysRoot, 'System32', 'wsl.exe')
  if (deps.exists(wsl)) {
    for (const distro of deps.listWslDistros()) out.push({ name: `WSL: ${distro}`, command: wsl, args: ['-d', distro] })
  }
  return out
}

export function mergeProfiles(detected: ProfileDef[], user: ProfileDef[]): ProfileDef[] {
  const result = detected.map((p) => user.find((u) => u.name === p.name) ?? p)
  for (const u of user) if (!detected.some((p) => p.name === u.name)) result.push(u)
  return result
}

export function pickProfile(profiles: ProfileDef[], preferred: string | null): ProfileDef {
  if (preferred) {
    const p = profiles.find((x) => x.name === preferred)
    if (p) return p
  }
  const fallback = profiles.find((x) => x.name === 'PowerShell 7') ?? profiles.find((x) => x.name === 'Windows PowerShell') ?? profiles[0]
  if (!fallback) throw new Error('no shell profiles available')
  return fallback
}

export function shellFamily(p: ProfileDef): ShellFamily {
  const exe = win32.basename(p.command).toLowerCase().replace(/\.exe$/, '')
  if (exe === 'pwsh' || exe === 'powershell') return 'powershell'
  if (exe === 'cmd') return 'cmd'
  if (exe === 'wsl') return 'wsl'
  if (exe === 'bash') return 'bash'
  return 'other'
}

export function canHostClaude(p: ProfileDef): boolean {
  const f = shellFamily(p)
  return f === 'powershell' || f === 'cmd' || f === 'bash'
}

export function pickClaudeProfile(profiles: ProfileDef[], preferred: string | null): { profile: ProfileDef; warning: string | null } {
  const hostable = profiles.filter(canHostClaude)
  if (preferred) {
    const p = profiles.find((x) => x.name === preferred)
    if (p && canHostClaude(p)) return { profile: p, warning: null }
    const warning = p ? `Profile "${preferred}" cannot run claude; using default` : `Profile "${preferred}" not found; using default`
    return { profile: pickProfile(hostable, null), warning }
  }
  return { profile: pickProfile(hostable, null), warning: null }
}

export function quoteForShell(family: ShellFamily, value: string): string {
  switch (family) {
    case 'powershell':
      return `'${value.replace(/'/g, "''")}'`
    case 'cmd':
      return `"${value}"`
    case 'bash':
      return `'${value.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`
    default:
      throw new Error(`cannot quote for shell family "${family}"`)
  }
}

export interface ClaudeLaunch {
  command: string
  settingsPath: string
  resumeSessionId: string | null
}

export function buildClaudeCommandLine(family: ShellFamily, c: ClaudeLaunch): string {
  let line = `${c.command} --settings ${quoteForShell(family, c.settingsPath)}`
  if (c.resumeSessionId !== null) {
    if (!isUuid(c.resumeSessionId)) throw new Error(`invalid session id: ${c.resumeSessionId}`)
    line += ` --resume ${c.resumeSessionId}`
  }
  return line
}

export interface LaunchSpec {
  file: string
  args: string[] | string
}

export function buildLaunch(profile: ProfileDef, kind: TabKind, claude: ClaudeLaunch | null): LaunchSpec {
  if (kind === 'shell') return { file: profile.command, args: profile.args }
  if (!claude) throw new Error('claude launch options are required for claude tabs')
  const family = shellFamily(profile)
  switch (family) {
    case 'powershell':
      return { file: profile.command, args: ['-NoLogo', '-NoExit', '-Command', buildClaudeCommandLine(family, claude)] }
    case 'cmd':
      // cmd.exe has its own quoting rules: pass a ready command line so node-pty does not re-escape quotes
      return { file: profile.command, args: `/k ${buildClaudeCommandLine(family, claude)}` }
    case 'bash':
      return { file: profile.command, args: ['--login', '-i', '-c', `${buildClaudeCommandLine(family, claude)}; exec bash --login -i`] }
    default:
      throw new Error(`profile "${profile.name}" cannot host claude`)
  }
}

export function parseWslList(buf: Buffer): string[] {
  const text = buf.includes(0) ? buf.toString('utf16le') : buf.toString('utf8')
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((s) => s.replace(/\0/g, '').trim())
    .filter((s) => s.length > 0)
}

export function systemDetectDeps(): DetectDeps {
  return {
    exists: existsSync,
    env: process.env,
    findInPath: (exe) => {
      try {
        const out = execFileSync('where.exe', [exe], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
        return out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? null
      } catch {
        return null
      }
    },
    listWslDistros: () => {
      try {
        return parseWslList(execFileSync('wsl.exe', ['-l', '-q'], { windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }))
      } catch {
        return []
      }
    }
  }
}
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `npx vitest run tests/unit/profiles.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `npm test && npm run typecheck` → PASS. Не коммитить.

---

### Task 5: Разбор аргументов командной строки

**Files:**
- Create: `src/main/args.ts`
- Test: `tests/unit/args.test.ts`

**Interfaces:**
- Consumes: —
- Produces: `type LaunchCommand = { kind: 'default' } | { kind: 'claude'; dir: string } | { kind: 'shell'; dir: string; profile: string | null }`, `normalizeDirArg(raw): string`, `parseArgs(argv: readonly string[]): LaunchCommand`, `resolveLaunchDir(dir, home, isDir: (p) => boolean): { cwd: string; warning: string | null }`.

- [ ] **Step 1: Написать падающий тест**

`tests/unit/args.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { normalizeDirArg, parseArgs, resolveLaunchDir } from '../../src/main/args'

const EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\ClaudeTerm\\ClaudeTerm.exe'

describe('parseArgs', () => {
  it('no flags → default', () => {
    expect(parseArgs([EXE])).toEqual({ kind: 'default' })
  })

  it('--claude with a path containing spaces', () => {
    expect(parseArgs([EXE, '--claude', 'D:\\My Projects\\game'])).toEqual({ kind: 'claude', dir: 'D:\\My Projects\\game' })
  })

  it('--shell with and without --profile', () => {
    expect(parseArgs([EXE, '--shell', 'D:\\x'])).toEqual({ kind: 'shell', dir: 'D:\\x', profile: null })
    expect(parseArgs([EXE, '--shell', 'D:\\x', '--profile', 'Git Bash'])).toEqual({ kind: 'shell', dir: 'D:\\x', profile: 'Git Bash' })
  })

  it('ignores chromium/electron flags and a dev app path', () => {
    expect(parseArgs(['electron.exe', '.', '--allow-file-access-from-files', '--claude', 'D:\\x'])).toEqual({ kind: 'claude', dir: 'D:\\x' })
  })

  it('a flag without a value is ignored', () => {
    expect(parseArgs([EXE, '--claude'])).toEqual({ kind: 'default' })
    expect(parseArgs([EXE, '--claude', '--shell', 'D:\\x'])).toEqual({ kind: 'shell', dir: 'D:\\x', profile: null })
  })

  it('Explorer drive root: %V = D:\\ arrives as D:" and is repaired', () => {
    expect(parseArgs([EXE, '--claude', 'D:"'])).toEqual({ kind: 'claude', dir: 'D:\\' })
  })
})

describe('normalizeDirArg', () => {
  it('trims quotes and whitespace and completes a bare drive', () => {
    expect(normalizeDirArg(' D:\\x" ')).toBe('D:\\x')
    expect(normalizeDirArg('C:')).toBe('C:\\')
  })
})

describe('resolveLaunchDir', () => {
  it('uses the directory when it exists', () => {
    expect(resolveLaunchDir('D:\\x', 'C:\\Users\\me', () => true)).toEqual({ cwd: 'D:\\x', warning: null })
  })

  it('falls back to home with a warning', () => {
    const r = resolveLaunchDir('D:\\gone', 'C:\\Users\\me', () => false)
    expect(r.cwd).toBe('C:\\Users\\me')
    expect(r.warning).toContain('D:\\gone')
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run tests/unit/args.test.ts`
Expected: FAIL (модуль не найден).

- [ ] **Step 3: Реализовать `src/main/args.ts`**

```ts
export type LaunchCommand =
  | { kind: 'default' }
  | { kind: 'claude'; dir: string }
  | { kind: 'shell'; dir: string; profile: string | null }

export function normalizeDirArg(raw: string): string {
  // Explorer passes "%V"; for a drive root that is "D:\" which Windows argv parsing turns into D:"
  let s = raw.trim().replace(/"+$/, '')
  if (/^[A-Za-z]:$/.test(s)) s += '\\'
  return s
}

export function parseArgs(argv: readonly string[]): LaunchCommand {
  const valueAfter = (flag: string): string | null => {
    const i = argv.indexOf(flag)
    if (i < 0) return null
    const v = argv[i + 1]
    return v !== undefined && !v.startsWith('--') ? v : null
  }
  const claudeDir = valueAfter('--claude')
  if (claudeDir !== null) return { kind: 'claude', dir: normalizeDirArg(claudeDir) }
  const shellDir = valueAfter('--shell')
  if (shellDir !== null) return { kind: 'shell', dir: normalizeDirArg(shellDir), profile: valueAfter('--profile') }
  return { kind: 'default' }
}

export function resolveLaunchDir(dir: string, home: string, isDir: (p: string) => boolean): { cwd: string; warning: string | null } {
  if (dir && isDir(dir)) return { cwd: dir, warning: null }
  return { cwd: home, warning: `Folder not found: ${dir} — opened in ${home}` }
}
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `npx vitest run tests/unit/args.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `npm test && npm run typecheck` → PASS. Не коммитить.

---

### Task 6: Named pipe — сервер и клиент

**Files:**
- Create: `src/shared/pipe-client.ts`, `src/main/pipe-server.ts`
- Test: `tests/integration/pipe.test.ts`

**Interfaces:**
- Consumes: `parsePipeMessage`, `encodeMessage`, `PipeMessage`, `PipeResponse`, `ShowImageMessage`, `SessionMessage` (Task 2).
- Produces:
  - `pipe-client.ts`: `class PipeUnavailableError extends Error`, `sendPipeMessage(pipeName: string, msg: PipeMessage, timeoutMs = 2000): Promise<PipeResponse>` (reject `PipeUnavailableError`, если пайпа нет/таймаут/соединение закрыто без ответа).
  - `pipe-server.ts`: `interface PipeHandlers { showImage(msg: ShowImageMessage): Promise<PipeResponse>; session(msg: SessionMessage): PipeResponse }`, `interface PipeServerHandle { close(): Promise<void> }`, `startPipeServer(pipeName, handlers): Promise<PipeServerHandle>`.

- [ ] **Step 1: Написать падающий тест**

`tests/integration/pipe.test.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startPipeServer, type PipeHandlers, type PipeServerHandle } from '../../src/main/pipe-server'
import { PipeUnavailableError, sendPipeMessage } from '../../src/shared/pipe-client'
import type { SessionMessage, ShowImageMessage } from '../../src/shared/protocol'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const newPipe = (): string => `\\\\.\\pipe\\claudeterm-test-${randomUUID()}`
const okHandlers: PipeHandlers = { showImage: async () => ({ ok: true }), session: () => ({ ok: true }) }

let server: PipeServerHandle | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

function rawLines(pipe: string, payload: string, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const s = connect(pipe)
    let buf = ''
    s.setEncoding('utf8')
    s.on('connect', () => s.write(payload))
    s.on('data', (c: string) => {
      buf += c
      const lines = buf.split('\n').filter(Boolean)
      if (lines.length >= count) {
        s.destroy()
        resolve(lines.slice(0, count))
      }
    })
    s.on('error', reject)
  })
}

describe('pipe server + client', () => {
  it('routes show_image to the handler and returns its response', async () => {
    const pipe = newPipe()
    const got: ShowImageMessage[] = []
    server = await startPipeServer(pipe, { ...okHandlers, showImage: async (m) => { got.push(m); return { ok: true } } })
    const res = await sendPipeMessage(pipe, { v: 1, type: 'show_image', tabId: TAB, path: 'C:\\x\\a.png', caption: null })
    expect(res).toEqual({ ok: true })
    expect(got).toEqual([{ v: 1, type: 'show_image', tabId: TAB, path: 'C:\\x\\a.png', caption: null }])
  })

  it('routes session messages', async () => {
    const pipe = newPipe()
    const got: SessionMessage[] = []
    server = await startPipeServer(pipe, { ...okHandlers, session: (m) => { got.push(m); return { ok: false, error: 'not a claude tab' } } })
    const msg: SessionMessage = { v: 1, type: 'session', tabId: TAB, sessionId: SID, source: 'startup', transcriptPath: null }
    expect(await sendPipeMessage(pipe, msg)).toEqual({ ok: false, error: 'not a claude tab' })
    expect(got).toEqual([msg])
  })

  it('returns validation errors for malformed lines', async () => {
    const pipe = newPipe()
    server = await startPipeServer(pipe, okHandlers)
    const [line] = await rawLines(pipe, '{"v":1,"type":"show_image","path":"rel.png"}\n', 1)
    expect(JSON.parse(line)).toEqual({ ok: false, error: 'path must be an absolute path' })
  })

  it('turns handler exceptions into ok:false', async () => {
    const pipe = newPipe()
    server = await startPipeServer(pipe, { ...okHandlers, showImage: async () => { throw new Error('boom') } })
    expect(await sendPipeMessage(pipe, { v: 1, type: 'show_image', tabId: null, path: 'C:\\a.png', caption: null })).toEqual({ ok: false, error: 'boom' })
  })

  it('answers several messages on one connection in order', async () => {
    const pipe = newPipe()
    let n = 0
    server = await startPipeServer(pipe, { ...okHandlers, showImage: async () => (++n === 1 ? { ok: true } : { ok: false, error: 'second' }) })
    const one = JSON.stringify({ v: 1, type: 'show_image', path: 'C:\\a.png' })
    const lines = await rawLines(pipe, `${one}\n${one}\n`, 2)
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ ok: true }, { ok: false, error: 'second' }])
  })

  it('client rejects with PipeUnavailableError when nobody listens', async () => {
    await expect(sendPipeMessage(newPipe(), { v: 1, type: 'show_image', tabId: null, path: 'C:\\a.png', caption: null }, 500)).rejects.toBeInstanceOf(PipeUnavailableError)
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run tests/integration/pipe.test.ts`
Expected: FAIL (модули не найдены).

- [ ] **Step 3: Реализовать клиент и сервер**

`src/shared/pipe-client.ts`:
```ts
import { connect } from 'node:net'
import { encodeMessage, type PipeMessage, type PipeResponse } from './protocol'

export class PipeUnavailableError extends Error {}

export function sendPipeMessage(pipeName: string, msg: PipeMessage, timeoutMs = 2000): Promise<PipeResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipeName)
    let buf = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new PipeUnavailableError(`timed out talking to ${pipeName}`))), timeoutMs)
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(encodeMessage(msg)))
    socket.on('data', (chunk: string) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const line = buf.slice(0, nl)
      finish(() => {
        try {
          resolve(JSON.parse(line) as PipeResponse)
        } catch {
          reject(new Error('invalid response from ClaudeTerm'))
        }
      })
    })
    socket.on('error', (e) => finish(() => reject(new PipeUnavailableError(e.message))))
    socket.on('close', () => finish(() => reject(new PipeUnavailableError('connection closed without a response'))))
  })
}
```

`src/main/pipe-server.ts`:
```ts
import { createServer, type Socket } from 'node:net'
import { encodeMessage, parsePipeMessage, type PipeResponse, type SessionMessage, type ShowImageMessage } from '../shared/protocol'

export interface PipeHandlers {
  showImage(msg: ShowImageMessage): Promise<PipeResponse>
  session(msg: SessionMessage): PipeResponse
}

export interface PipeServerHandle {
  close(): Promise<void>
}

const MAX_LINE = 64 * 1024

async function handleLine(line: string, h: PipeHandlers): Promise<PipeResponse> {
  const parsed = parsePipeMessage(line)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  try {
    return parsed.message.type === 'show_image' ? await h.showImage(parsed.message) : h.session(parsed.message)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

export function startPipeServer(pipeName: string, handlers: PipeHandlers): Promise<PipeServerHandle> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    let buf = ''
    let chain: Promise<void> = Promise.resolve()
    socket.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > MAX_LINE && !buf.includes('\n')) {
        buf = ''
        socket.end(encodeMessage({ ok: false, error: 'message too large' }))
        return
      }
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        chain = chain.then(async () => {
          const res = await handleLine(line, handlers)
          if (!socket.destroyed) socket.write(encodeMessage(res))
        })
      }
    })
    socket.on('error', () => { /* client went away */ })
    socket.on('close', () => sockets.delete(socket))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(pipeName, () => {
      server.off('error', reject)
      resolve({
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy()
            server.close(() => done())
          })
      })
    })
  })
}
```

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `npx vitest run tests/integration/pipe.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Checkpoint**

Run: `npm test && npm run typecheck` → PASS. Не коммитить.

---

### Task 7: Файлы Claude-вкладки и SessionStart-хук

**Files:**
- Create: `src/main/claude-tab-settings.ts`, `src/hook/session-hook.ts`, `src/hook/main.ts`
- Test: `tests/unit/claude-tab-settings.test.ts`, `tests/unit/session-hook.test.ts`, `tests/integration/session-hook.int.test.ts`

**Interfaces:**
- Consumes: `isUuid`, `defaultPipeName`, `SessionMessage`, `PipeResponse` (Task 2); `sendPipeMessage` (Task 6); `startPipeServer` (Task 6, только в тесте).
- Produces:
  - `claude-tab-settings.ts`: `hookCmdContent(execPath, hookScriptPath): string`, `hookCommandString(cmdPath): string`, `claudeTabSettingsJson(cmdPath): string`, `interface ClaudeTabFiles { settingsPath: string; cmdPath: string }`, `writeClaudeTabFiles(dataDir, execPath, hookScriptPath): ClaudeTabFiles`.
  - `hook/session-hook.ts`: `type Sender = (pipeName: string, msg: SessionMessage) => Promise<PipeResponse>`, `runSessionHook(stdinText, env, send): Promise<boolean>` (true — сообщение отправлено).
  - `hook/main.ts`: точка входа бандла `resources/hook/session-hook.js` (stdout пустой, exit 0).

- [ ] **Step 1: Написать падающие unit-тесты**

`tests/unit/claude-tab-settings.test.ts`:
```ts
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeTabSettingsJson, hookCmdContent, hookCommandString, writeClaudeTabFiles } from '../../src/main/claude-tab-settings'

describe('hook files', () => {
  it('hookCmdContent runs the script under ELECTRON_RUN_AS_NODE and always exits 0', () => {
    const c = hookCmdContent('C:\\Program Files\\ClaudeTerm\\ClaudeTerm.exe', 'C:\\Program Files\\ClaudeTerm\\resources\\hook\\session-hook.js')
    expect(c.split('\r\n')).toEqual([
      '@echo off',
      'chcp 65001 >nul 2>&1',
      'set ELECTRON_RUN_AS_NODE=1',
      '"C:\\Program Files\\ClaudeTerm\\ClaudeTerm.exe" "C:\\Program Files\\ClaudeTerm\\resources\\hook\\session-hook.js"',
      'exit /b 0',
      ''
    ])
  })

  it('escapes percent signs for cmd', () => {
    expect(hookCmdContent('C:\\100%\\a.exe', 'C:\\b.js')).toContain('"C:\\100%%\\a.exe"')
  })

  it('hookCommandString uses forward slashes and quotes only when needed', () => {
    expect(hookCommandString('C:\\Users\\me\\AppData\\Roaming\\ClaudeTerm\\session-hook.cmd')).toBe('C:/Users/me/AppData/Roaming/ClaudeTerm/session-hook.cmd')
    expect(hookCommandString('C:\\Users\\John Doe\\AppData\\Roaming\\ClaudeTerm\\session-hook.cmd')).toBe('"C:/Users/John Doe/AppData/Roaming/ClaudeTerm/session-hook.cmd"')
  })

  it('claudeTabSettingsJson declares one SessionStart command hook', () => {
    expect(JSON.parse(claudeTabSettingsJson('C:\\Users\\me\\AppData\\Roaming\\ClaudeTerm\\session-hook.cmd'))).toEqual({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'C:/Users/me/AppData/Roaming/ClaudeTerm/session-hook.cmd', timeout: 10 }] }] }
    })
  })

  it('writeClaudeTabFiles writes both files into the data dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-hook-'))
    const files = writeClaudeTabFiles(dir, 'C:\\e.exe', 'C:\\h.js')
    expect(files).toEqual({ settingsPath: join(dir, 'claude-tab-settings.json'), cmdPath: join(dir, 'session-hook.cmd') })
    expect(readFileSync(files.cmdPath, 'utf8')).toBe(hookCmdContent('C:\\e.exe', 'C:\\h.js'))
    expect(readFileSync(files.settingsPath, 'utf8')).toBe(claudeTabSettingsJson(files.cmdPath))
  })
})
```

`tests/unit/session-hook.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { runSessionHook } from '../../src/hook/session-hook'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const TP = 'C:\\Users\\me\\.claude\\projects\\D--x\\5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8.jsonl'
const input = JSON.stringify({ session_id: SID, transcript_path: TP, cwd: 'D:\\x', hook_event_name: 'SessionStart', source: 'clear' })

describe('runSessionHook', () => {
  it('sends the session id and transcript path for the tab', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    expect(await runSessionHook(input, { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: '\\\\.\\pipe\\x' }, send)).toBe(true)
    expect(send).toHaveBeenCalledWith('\\\\.\\pipe\\x', { v: 1, type: 'session', tabId: TAB, sessionId: SID, source: 'clear', transcriptPath: TP })
  })

  it('does nothing outside a ClaudeTerm tab', async () => {
    const send = vi.fn()
    expect(await runSessionHook(input, {}, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('ignores bad stdin and non-UUID session ids', async () => {
    const send = vi.fn()
    expect(await runSessionHook('not json', { CLAUDETERM_TAB_ID: TAB }, send)).toBe(false)
    expect(await runSessionHook(JSON.stringify({ session_id: 'x' }), { CLAUDETERM_TAB_ID: TAB }, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('swallows send failures', async () => {
    const send = vi.fn(async () => { throw new Error('no pipe') })
    await expect(runSessionHook(input, { CLAUDETERM_TAB_ID: TAB }, send)).resolves.toBe(false)
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падают**

Run: `npx vitest run tests/unit/claude-tab-settings.test.ts tests/unit/session-hook.test.ts`
Expected: FAIL (модули не найдены).

- [ ] **Step 3: Реализовать**

`src/main/claude-tab-settings.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function hookCmdContent(execPath: string, hookScriptPath: string): string {
  const esc = (p: string): string => p.replace(/%/g, '%%')
  return ['@echo off', 'chcp 65001 >nul 2>&1', 'set ELECTRON_RUN_AS_NODE=1', `"${esc(execPath)}" "${esc(hookScriptPath)}"`, 'exit /b 0', ''].join('\r\n')
}

export function hookCommandString(cmdPath: string): string {
  const p = cmdPath.replace(/\\/g, '/')
  return p.includes(' ') ? `"${p}"` : p
}

export function claudeTabSettingsJson(cmdPath: string): string {
  return JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hookCommandString(cmdPath), timeout: 10 }] }] } }, null, 2)
}

export interface ClaudeTabFiles {
  settingsPath: string
  cmdPath: string
}

export function writeClaudeTabFiles(dataDir: string, execPath: string, hookScriptPath: string): ClaudeTabFiles {
  mkdirSync(dataDir, { recursive: true })
  const cmdPath = join(dataDir, 'session-hook.cmd')
  const settingsPath = join(dataDir, 'claude-tab-settings.json')
  writeFileSync(cmdPath, hookCmdContent(execPath, hookScriptPath), 'utf8')
  writeFileSync(settingsPath, claudeTabSettingsJson(cmdPath), 'utf8')
  return { settingsPath, cmdPath }
}
```

`src/hook/session-hook.ts`:
```ts
import { userInfo } from 'node:os'
import { defaultPipeName, isUuid, type PipeResponse, type SessionMessage } from '../shared/protocol'

export type Sender = (pipeName: string, msg: SessionMessage) => Promise<PipeResponse>

export async function runSessionHook(stdinText: string, env: NodeJS.ProcessEnv, send: Sender): Promise<boolean> {
  const tabId = env.CLAUDETERM_TAB_ID
  if (!isUuid(tabId)) return false
  let input: unknown
  try {
    input = JSON.parse(stdinText)
  } catch {
    return false
  }
  if (typeof input !== 'object' || input === null) return false
  const i = input as Record<string, unknown>
  if (!isUuid(i.session_id)) return false
  const msg: SessionMessage = {
    v: 1,
    type: 'session',
    tabId,
    sessionId: i.session_id,
    source: typeof i.source === 'string' ? i.source : 'unknown',
    transcriptPath: typeof i.transcript_path === 'string' ? i.transcript_path : null
  }
  try {
    await send(env.CLAUDETERM_PIPE || defaultPipeName(userInfo().username), msg)
    return true
  } catch {
    return false
  }
}
```

`src/hook/main.ts`:
```ts
import { sendPipeMessage } from '../shared/pipe-client'
import { runSessionHook } from './session-hook'

// Never write to stdout: SessionStart hook stdout is added to Claude's context.
function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    const done = (): void => {
      clearTimeout(timer)
      resolve(data)
    }
    const timer = setTimeout(done, timeoutMs)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => { data += chunk })
    process.stdin.on('end', done)
    process.stdin.on('error', done)
  })
}

readStdin(3000)
  .then((text) => runSessionHook(text, process.env, (pipe, msg) => sendPipeMessage(pipe, msg, 2000)))
  .catch(() => false)
  .finally(() => process.exit(0))
```

- [ ] **Step 4: Запустить unit-тесты — убедиться, что проходят**

Run: `npx vitest run tests/unit/claude-tab-settings.test.ts tests/unit/session-hook.test.ts`
Expected: PASS.

- [ ] **Step 5: Написать интеграционный тест: бандл хука через node, через `.cmd` из cmd и из Git Bash**

`tests/integration/session-hook.int.test.ts`:
```ts
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { hookCommandString, writeClaudeTabFiles } from '../../src/main/claude-tab-settings'
import { startPipeServer, type PipeServerHandle } from '../../src/main/pipe-server'
import type { SessionMessage } from '../../src/shared/protocol'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const TP = 'C:\\Users\\me\\.claude\\projects\\D--x\\s.jsonl'
const INPUT = JSON.stringify({ session_id: SID, transcript_path: TP, hook_event_name: 'SessionStart', source: 'startup' })
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'

const work = mkdtempSync(join(tmpdir(), 'ct-hookint-'))
const bundle = join(work, 'session-hook.js')
let server: PipeServerHandle | null = null

beforeAll(async () => {
  await build({ entryPoints: [resolve(__dirname, '../../src/hook/main.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' })
})

afterEach(async () => {
  await server?.close()
  server = null
})

function run(file: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
  return new Promise((res) => {
    const p = spawn(file, args, { env: { ...(process.env as Record<string, string>), ...env }, windowsHide: true })
    let stdout = ''
    p.stdout.on('data', (d) => { stdout += String(d) })
    p.on('close', (code) => res({ code, stdout }))
    p.stdin.end(INPUT)
  })
}

async function listen(): Promise<{ pipe: string; got: SessionMessage[] }> {
  const pipe = `\\\\.\\pipe\\claudeterm-test-${randomUUID()}`
  const got: SessionMessage[] = []
  server = await startPipeServer(pipe, { showImage: async () => ({ ok: true }), session: (m) => { got.push(m); return { ok: true } } })
  return { pipe, got }
}

const expected = { v: 1, type: 'session', tabId: TAB, sessionId: SID, source: 'startup', transcriptPath: TP }

describe('session hook end to end', () => {
  it('node bundle: sends the session and prints nothing', async () => {
    const { pipe, got } = await listen()
    const r = await run(process.execPath, [bundle], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe })
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([expected])
  })

  it('generated .cmd via cmd.exe passes stdin through', async () => {
    const { pipe, got } = await listen()
    const { cmdPath } = writeClaudeTabFiles(join(work, 'data-cmd'), process.execPath, bundle)
    const r = await run('cmd.exe', ['/d', '/c', cmdPath], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe })
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([expected])
  })

  it.skipIf(!existsSync(GIT_BASH))('hook command string runs from Git Bash', async () => {
    const { pipe, got } = await listen()
    const { cmdPath } = writeClaudeTabFiles(join(work, 'data bash'), process.execPath, bundle)
    const r = await run(GIT_BASH, ['-c', hookCommandString(cmdPath)], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe })
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([expected])
  })

  it('exits 0 silently when ClaudeTerm is not running', async () => {
    const r = await run(process.execPath, [bundle], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: `\\\\.\\pipe\\claudeterm-none-${randomUUID()}` })
    expect(r).toEqual({ code: 0, stdout: '' })
  })
})
```

Тест «Git Bash» использует каталог `data bash` с пробелом — проверяет кавычки в `hookCommandString` (Review Focus #3).

- [ ] **Step 6: Запустить интеграционный тест**

Run: `npx vitest run tests/integration/session-hook.int.test.ts`
Expected: PASS (тест Git Bash пропускается, если Git не установлен). Если `.cmd`-тест падает из-за `chcp` (пустой/непустой stdout или код ≠ 0) — убрать строку `chcp 65001 >nul 2>&1` из `hookCmdContent` и из ожидания в unit-тесте, и сообщить об этом в отчёте задачи.

- [ ] **Step 7: Checkpoint**

Run: `npm test && npm run typecheck` → PASS. Не коммитить. Проверка с реальным claude — в Task 9.

---

### Task 8: TabManager

**Files:**
- Create: `src/main/tab-manager.ts`
- Test: `tests/unit/tab-manager.test.ts`

**Interfaces:**
- Consumes: `SpawnPty`, `PtyHandle`, `SpawnOptions` (Task 1); `LaunchSpec` (Task 4); `OpenTabRequest`, `TabInfo`, `SessionSnapshotTab` (types.ts).
- Produces:
  - `interface ResolvedLaunch { profileName: string; spec: LaunchSpec }`
  - `interface TabEvents { opened(tab); updated(tab); closed(tabId); activated(tabId); order(ids); data(tabId, data); exit(tabId, code) }`
  - `interface TabManagerDeps { spawn: SpawnPty; resolveLaunch(req): ResolvedLaunch; baseEnv(): Record<string, string>; pipeName: string; events: TabEvents; onTabStarted?(tab: TabInfo): void; onTabClosed?(tabId: string): void; onStateChanged?(): void; flushMs?: number }`
  - `class TabManager`: `open(req, opts?: { activate?: boolean }): TabInfo` (бросает, если `resolveLaunch` бросил), `close(id)`, `activate(id)`, `activeTabId(): string | null`, `rename(id, title | null)`, `reorder(ids)`, `restart(id)`, `write(id, data)`, `resize(id, cols, rows)`, `setClaudeSession(id, sessionId): boolean`, `list(): TabInfo[]`, `get(id): TabInfo | null`, `snapshot(): SessionSnapshotTab[]`, `disposeAll()`.

- [ ] **Step 1: Написать падающий тест**

`tests/unit/tab-manager.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PtyHandle, SpawnOptions } from '../../src/main/pty-host'
import { TabManager, type TabEvents, type TabManagerDeps } from '../../src/main/tab-manager'

const SID_A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID_B = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'

class FakePty implements PtyHandle {
  readonly pid = 1
  writes: string[] = []
  sizes: Array<[number, number]> = []
  killed = false
  constructor(readonly opts: SpawnOptions) {}
  write(d: string): void { this.writes.push(d) }
  resize(c: number, r: number): void { this.sizes.push([c, r]) }
  kill(): void { this.killed = true }
  emitData(d: string): void { this.opts.onData(d) }
  emitExit(code: number): void { this.opts.onExit(code) }
}

function setup(over: Partial<TabManagerDeps> = {}) {
  const ptys: FakePty[] = []
  const log: string[] = []
  const data: Array<[string, string]> = []
  const events: TabEvents = {
    opened: (t) => log.push(`opened:${t.id}`),
    updated: (t) => log.push(`updated:${t.id}:${t.exited}`),
    closed: (id) => log.push(`closed:${id}`),
    activated: (id) => log.push(`activated:${id}`),
    order: (ids) => log.push(`order:${ids.join(',')}`),
    data: (id, d) => data.push([id, d]),
    exit: (id, code) => log.push(`exit:${id}:${code}`)
  }
  const onStateChanged = vi.fn()
  const onTabStarted = vi.fn()
  const onTabClosed = vi.fn()
  const deps: TabManagerDeps = {
    spawn: (o) => {
      const p = new FakePty(o)
      ptys.push(p)
      return p
    },
    resolveLaunch: (req) => ({ profileName: req.profile ?? 'Windows PowerShell', spec: { file: 'powershell.exe', args: ['-NoLogo'] } }),
    baseEnv: () => ({ PATH: 'C:\\Windows' }),
    pipeName: '\\\\.\\pipe\\test',
    events,
    onStateChanged,
    onTabStarted,
    onTabClosed,
    ...over
  }
  return { tm: new TabManager(deps), ptys, log, data, onStateChanged, onTabStarted, onTabClosed }
}

afterEach(() => { vi.useRealTimers() })

describe('TabManager', () => {
  it('open spawns a PTY with the tab env and activates the tab', () => {
    const { tm, ptys, log, onStateChanged, onTabStarted } = setup()
    const tab = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    expect(ptys[0].opts).toMatchObject({ file: 'powershell.exe', args: ['-NoLogo'], cwd: 'D:\\x' })
    expect(ptys[0].opts.env).toEqual({ PATH: 'C:\\Windows', CLAUDETERM_TAB_ID: tab.id, CLAUDETERM_PIPE: '\\\\.\\pipe\\test' })
    expect(log).toEqual([`opened:${tab.id}`, `activated:${tab.id}`])
    expect(tm.activeTabId()).toBe(tab.id)
    expect(onTabStarted).toHaveBeenCalledWith(expect.objectContaining({ id: tab.id, cwd: 'D:\\x' }))
    expect(onStateChanged).toHaveBeenCalled()
  })

  it('open with activate:false does not change the active tab', () => {
    const { tm } = setup()
    const a = tm.open({ kind: 'shell', cwd: 'D:\\a' })
    tm.open({ kind: 'shell', cwd: 'D:\\b' }, { activate: false })
    expect(tm.activeTabId()).toBe(a.id)
  })

  it('a resolveLaunch failure creates no tab', () => {
    const { tm, ptys } = setup({ resolveLaunch: () => { throw new Error('no profiles') } })
    expect(() => tm.open({ kind: 'shell', cwd: 'D:\\x' })).toThrow('no profiles')
    expect(tm.list()).toEqual([])
    expect(ptys).toEqual([])
  })

  it('coalesces PTY output', () => {
    vi.useFakeTimers()
    const { tm, ptys, data } = setup()
    const tab = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    ptys[0].emitData('a')
    ptys[0].emitData('b')
    vi.advanceTimersByTime(10)
    expect(data).toEqual([[tab.id, 'ab']])
  })

  it('exit marks the tab exited; restart spawns again; writes go to the live PTY only', () => {
    const { tm, ptys, log } = setup()
    const tab = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    ptys[0].emitExit(3)
    expect(log).toContain(`exit:${tab.id}:3`)
    expect(tm.get(tab.id)?.exited).toBe(true)
    tm.write(tab.id, 'ignored')
    expect(ptys[0].writes).toEqual([])
    tm.restart(tab.id)
    expect(ptys).toHaveLength(2)
    expect(tm.get(tab.id)?.exited).toBe(false)
    tm.write(tab.id, 'dir\r')
    expect(ptys[1].writes).toEqual(['dir\r'])
    tm.restart(tab.id)
    expect(ptys).toHaveLength(2)
  })

  it('a spawn failure shows a message and marks the tab exited', () => {
    vi.useFakeTimers()
    const { tm, data, log } = setup({ spawn: () => { throw new Error('ENOENT') } })
    const tab = tm.open({ kind: 'shell', cwd: 'D:\\x' })
    expect(log).toContain(`exit:${tab.id}:-1`)
    expect(data[0][1]).toContain('ENOENT')
  })

  it('close kills the PTY, activates the neighbour and ignores late output', () => {
    vi.useFakeTimers()
    const { tm, ptys, data, onTabClosed } = setup()
    const a = tm.open({ kind: 'shell', cwd: 'D:\\a' })
    const b = tm.open({ kind: 'shell', cwd: 'D:\\b' })
    const c = tm.open({ kind: 'shell', cwd: 'D:\\c' })
    tm.activate(b.id)
    tm.close(b.id)
    expect(ptys[1].killed).toBe(true)
    expect(onTabClosed).toHaveBeenCalledWith(b.id)
    expect(tm.activeTabId()).toBe(c.id)
    ptys[1].emitData('late')
    vi.advanceTimersByTime(10)
    expect(data.filter(([id]) => id === b.id)).toEqual([])
    tm.close(c.id)
    expect(tm.activeTabId()).toBe(a.id)
    tm.close(a.id)
    expect(tm.activeTabId()).toBeNull()
  })

  it('reorder accepts only a permutation of the current tabs', () => {
    const { tm, log } = setup()
    const a = tm.open({ kind: 'shell', cwd: 'D:\\a' })
    const b = tm.open({ kind: 'shell', cwd: 'D:\\b' })
    tm.reorder([a.id])
    tm.reorder([a.id, a.id])
    expect(tm.list().map((t) => t.id)).toEqual([a.id, b.id])
    tm.reorder([b.id, a.id])
    expect(tm.list().map((t) => t.id)).toEqual([b.id, a.id])
    expect(log).toContain(`order:${b.id},${a.id}`)
  })

  it('rename trims and empty resets to automatic title', () => {
    const { tm } = setup()
    const a = tm.open({ kind: 'shell', cwd: 'D:\\a' })
    tm.rename(a.id, '  build  ')
    expect(tm.get(a.id)?.customTitle).toBe('build')
    tm.rename(a.id, '   ')
    expect(tm.get(a.id)?.customTitle).toBeNull()
  })

  it('session ids are tracked per tab, even for two claude tabs in the same folder', () => {
    const { tm } = setup()
    const a = tm.open({ kind: 'claude', cwd: 'D:\\same' })
    const b = tm.open({ kind: 'claude', cwd: 'D:\\same' })
    const s = tm.open({ kind: 'shell', cwd: 'D:\\same' })
    expect(tm.setClaudeSession(a.id, SID_A)).toBe(true)
    expect(tm.setClaudeSession(b.id, SID_B)).toBe(true)
    expect(tm.setClaudeSession(s.id, SID_A)).toBe(false)
    expect(tm.setClaudeSession('unknown', SID_A)).toBe(false)
    expect(tm.snapshot()).toEqual([
      { kind: 'claude', profile: 'Windows PowerShell', cwd: 'D:\\same', title: null, claudeSessionId: SID_A },
      { kind: 'claude', profile: 'Windows PowerShell', cwd: 'D:\\same', title: null, claudeSessionId: SID_B },
      { kind: 'shell', profile: 'Windows PowerShell', cwd: 'D:\\same', title: null, claudeSessionId: null }
    ])
  })

  it('open with resumeSessionId and title pre-fills the tab', () => {
    const { tm } = setup()
    const t = tm.open({ kind: 'claude', cwd: 'D:\\x', title: 'mine', resumeSessionId: SID_A })
    expect(t).toMatchObject({ customTitle: 'mine', claudeSessionId: SID_A })
  })

  it('disposeAll kills everything without reporting a state change', () => {
    const { tm, ptys, onStateChanged } = setup()
    tm.open({ kind: 'shell', cwd: 'D:\\a' })
    tm.open({ kind: 'claude', cwd: 'D:\\b' })
    onStateChanged.mockClear()
    tm.disposeAll()
    expect(ptys.every((p) => p.killed)).toBe(true)
    expect(onStateChanged).not.toHaveBeenCalled()
    expect(tm.list()).toEqual([])
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run tests/unit/tab-manager.test.ts`
Expected: FAIL (модуль не найден).

- [ ] **Step 3: Реализовать `src/main/tab-manager.ts`**

```ts
import { randomUUID } from 'node:crypto'
import type { OpenTabRequest, SessionSnapshotTab, TabInfo } from '../shared/types'
import type { LaunchSpec } from './profiles'
import type { PtyHandle, SpawnPty } from './pty-host'

export interface ResolvedLaunch {
  profileName: string
  spec: LaunchSpec
}

export interface TabEvents {
  opened(tab: TabInfo): void
  updated(tab: TabInfo): void
  closed(tabId: string): void
  activated(tabId: string): void
  order(ids: string[]): void
  data(tabId: string, data: string): void
  exit(tabId: string, code: number): void
}

export interface TabManagerDeps {
  spawn: SpawnPty
  resolveLaunch(req: OpenTabRequest): ResolvedLaunch
  baseEnv(): Record<string, string>
  pipeName: string
  events: TabEvents
  onTabStarted?(tab: TabInfo): void
  onTabClosed?(tabId: string): void
  onStateChanged?(): void
  flushMs?: number
}

interface TabRecord {
  info: TabInfo
  launch: ResolvedLaunch
  pty: PtyHandle | null
  buffer: string
  timer: ReturnType<typeof setTimeout> | null
  cols: number
  rows: number
}

export class TabManager {
  private readonly tabs = new Map<string, TabRecord>()
  private order: string[] = []
  private activeId: string | null = null
  private disposed = false

  constructor(private readonly deps: TabManagerDeps) {}

  open(req: OpenTabRequest, opts: { activate?: boolean } = {}): TabInfo {
    const launch = this.deps.resolveLaunch(req)
    const info: TabInfo = {
      id: randomUUID(),
      kind: req.kind,
      profile: launch.profileName,
      cwd: req.cwd,
      customTitle: req.title ?? null,
      claudeSessionId: req.kind === 'claude' ? req.resumeSessionId ?? null : null,
      exited: false
    }
    const rec: TabRecord = { info, launch, pty: null, buffer: '', timer: null, cols: 120, rows: 30 }
    this.tabs.set(info.id, rec)
    this.order.push(info.id)
    this.deps.events.opened({ ...info })
    this.deps.onTabStarted?.({ ...info })
    this.start(rec)
    if (opts.activate ?? true) this.activate(info.id)
    this.changed()
    return { ...info }
  }

  close(tabId: string): void {
    const rec = this.tabs.get(tabId)
    if (!rec) return
    const idx = this.order.indexOf(tabId)
    this.tabs.delete(tabId)
    this.order.splice(idx, 1)
    if (rec.timer) clearTimeout(rec.timer)
    rec.pty?.kill()
    this.deps.events.closed(tabId)
    this.deps.onTabClosed?.(tabId)
    if (this.activeId === tabId) {
      this.activeId = null
      const next = this.order[Math.min(idx, this.order.length - 1)]
      if (next) this.activate(next)
    }
    this.changed()
  }

  activate(tabId: string): void {
    if (!this.tabs.has(tabId)) return
    this.activeId = tabId
    this.deps.events.activated(tabId)
  }

  activeTabId(): string | null {
    return this.activeId
  }

  rename(tabId: string, title: string | null): void {
    const rec = this.tabs.get(tabId)
    if (!rec) return
    const t = title?.trim()
    rec.info.customTitle = t ? t : null
    this.deps.events.updated({ ...rec.info })
    this.changed()
  }

  reorder(ids: string[]): void {
    const valid = ids.length === this.order.length && new Set(ids).size === ids.length && ids.every((id) => this.tabs.has(id))
    if (!valid) return
    this.order = [...ids]
    this.deps.events.order([...ids])
    this.changed()
  }

  restart(tabId: string): void {
    const rec = this.tabs.get(tabId)
    if (!rec || !rec.info.exited) return
    rec.info.exited = false
    this.deps.events.updated({ ...rec.info })
    this.start(rec)
  }

  write(tabId: string, data: string): void {
    this.tabs.get(tabId)?.pty?.write(data)
  }

  resize(tabId: string, cols: number, rows: number): void {
    const rec = this.tabs.get(tabId)
    if (!rec || cols < 1 || rows < 1) return
    rec.cols = cols
    rec.rows = rows
    rec.pty?.resize(cols, rows)
  }

  setClaudeSession(tabId: string, sessionId: string): boolean {
    const rec = this.tabs.get(tabId)
    if (!rec || rec.info.kind !== 'claude') return false
    if (rec.info.claudeSessionId !== sessionId) {
      rec.info.claudeSessionId = sessionId
      this.deps.events.updated({ ...rec.info })
      this.changed()
    }
    return true
  }

  list(): TabInfo[] {
    return this.order.map((id) => ({ ...this.tabs.get(id)!.info }))
  }

  get(tabId: string): TabInfo | null {
    const rec = this.tabs.get(tabId)
    return rec ? { ...rec.info } : null
  }

  snapshot(): SessionSnapshotTab[] {
    return this.order.map((id) => {
      const i = this.tabs.get(id)!.info
      return { kind: i.kind, profile: i.profile, cwd: i.cwd, title: i.customTitle, claudeSessionId: i.claudeSessionId }
    })
  }

  disposeAll(): void {
    this.disposed = true
    for (const rec of this.tabs.values()) {
      if (rec.timer) clearTimeout(rec.timer)
      rec.pty?.kill()
    }
    this.tabs.clear()
    this.order = []
    this.activeId = null
  }

  private changed(): void {
    if (!this.disposed) this.deps.onStateChanged?.()
  }

  private start(rec: TabRecord): void {
    const env = { ...this.deps.baseEnv(), CLAUDETERM_TAB_ID: rec.info.id, CLAUDETERM_PIPE: this.deps.pipeName }
    try {
      rec.pty = this.deps.spawn({
        file: rec.launch.spec.file,
        args: rec.launch.spec.args,
        cwd: rec.info.cwd,
        env,
        cols: rec.cols,
        rows: rec.rows,
        onData: (d) => this.queue(rec, d),
        onExit: (code) => this.exited(rec, code)
      })
    } catch (e) {
      rec.pty = null
      this.queue(rec, `\r\n[failed to start ${rec.launch.spec.file}: ${(e as Error).message}]\r\n`)
      this.exited(rec, -1)
    }
  }

  private isLive(rec: TabRecord): boolean {
    return this.tabs.get(rec.info.id) === rec
  }

  private queue(rec: TabRecord, data: string): void {
    if (!this.isLive(rec)) return
    rec.buffer += data
    if (!rec.timer) rec.timer = setTimeout(() => this.flush(rec), this.deps.flushMs ?? 5)
  }

  private flush(rec: TabRecord): void {
    if (rec.timer) {
      clearTimeout(rec.timer)
      rec.timer = null
    }
    if (!rec.buffer || !this.isLive(rec)) return
    const d = rec.buffer
    rec.buffer = ''
    this.deps.events.data(rec.info.id, d)
  }

  private exited(rec: TabRecord, code: number): void {
    if (!this.isLive(rec)) return
    this.flush(rec)
    rec.pty = null
    rec.info.exited = true
    this.deps.events.exit(rec.info.id, code)
    this.deps.events.updated({ ...rec.info })
  }
}
```

Примечание к тесту «spawn failure»: `exited()` вызывает `flush()` синхронно, поэтому сообщение об ошибке уходит в `events.data` сразу, без таймера.

- [ ] **Step 4: Запустить — убедиться, что проходит**

Run: `npx vitest run tests/unit/tab-manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `npm test && npm run typecheck` → PASS. Не коммитить.

---

### Task 9: Приложение целиком — вкладки, single-instance, таб-бар, тосты, окно

**Files:**
- Create: `src/main/resources.ts`, `src/main/log.ts`, `src/main/window-state.ts`
- Modify (полная замена временной версии): `src/main/index.ts`, `src/renderer/main.ts`
- Create: `src/renderer/util.ts`, `src/renderer/menu.ts`, `src/renderer/toasts.ts`, `src/renderer/tabbar.ts`
- Modify: `src/renderer/styles.css` (дописать в конец)
- Test: `tests/unit/log.test.ts`, `tests/unit/util.test.ts`, `tests/e2e/tabs.spec.ts`

**Interfaces:**
- Consumes: всё из Tasks 1–8: `initDataDir`, `resolvePipeName`, `loadSettingsFile`, `detectProfiles`/`mergeProfiles`/`pickProfile`/`pickClaudeProfile`/`buildLaunch`/`systemDetectDeps`, `parseArgs`/`resolveLaunchDir`/`LaunchCommand`, `spawnPty`, `TabManager`, `startPipeServer`, `writeClaudeTabFiles`, `TerminalView`, `resolveTheme`, `CtApi`/`IPC`.
- Produces:
  - `resources.ts`: `resourcePath(rel: string): string` (`process.resourcesPath` в установленной версии, `<repo>/resources` в dev).
  - `log.ts`: `interface Logger { info; warn; error }`, `createLogger(dir): Logger` (`main.log`, ротация 1 МБ × 5 файлов).
  - `window-state.ts`: `loadWindowState(file): WindowState`, `trackWindowState(win, file): void`.
  - `index.ts` (main) — структура, в которую Tasks 11/16/18 добавляют код: функция `bootstrap()` с локальными `settings`, `profiles`, `claudeFiles`, `send`, `toast`, `tabs`, `openTab(req, activate = true)`, `openFromLaunch(cmd)`, вызов `startPipeServer(pipeName, { showImage, session })`, блок IPC-обработчиков, создание `win`, обработчики `before-quit`.
  - renderer `main.ts` — состояние `tabs: Map<string, TabState>`, `order`, `activeId`, функции `renderTabs()`, `addTab(info)`, `handleInput(tabId, data)`, `activate(tabId)`, `newTabMenu(anchor)`, `boot()`; тест-хук `window.__ct`.
  - `util.ts`: `folderName(cwd): string`.
  - `menu.ts`: `interface MenuItem { label; action?; disabled?; separator? }`, `showMenu(at: { x; y }, items)`, `closeMenu()`.
  - `toasts.ts`: `showToast(message, timeoutMs = 6000)`.
  - `tabbar.ts`: `interface TabBarItem { id; title; kind; bell; images; exited }`, `interface TabBarCallbacks { activate; close; rename; reorder; newTab; openMenu(anchor: HTMLElement) }`, `class TabBar { render(items, activeId) }`.

- [ ] **Step 1: Написать падающие unit-тесты**

`tests/unit/log.test.ts`:
```ts
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLogger } from '../../src/main/log'

describe('createLogger', () => {
  it('appends timestamped lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-log-'))
    createLogger(dir).warn('careful')
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toMatch(/^\d{4}-\d{2}-\d{2}T.* WARN careful\n$/)
  })

  it('rotates main.log above 1 MB and keeps five files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-log-'))
    const log = createLogger(dir)
    writeFileSync(join(dir, 'main.log'), 'x'.repeat(1024 * 1024 + 1))
    for (let i = 1; i <= 4; i++) writeFileSync(join(dir, `main.${i}.log`), `old${i}`)
    log.info('hello')
    expect(readFileSync(join(dir, 'main.log'), 'utf8')).toMatch(/INFO hello\n$/)
    expect(readFileSync(join(dir, 'main.1.log'), 'utf8').length).toBe(1024 * 1024 + 1)
    expect(readFileSync(join(dir, 'main.2.log'), 'utf8')).toBe('old1')
    expect(readFileSync(join(dir, 'main.4.log'), 'utf8')).toBe('old3')
    expect(existsSync(join(dir, 'main.5.log'))).toBe(false)
  })
})
```

`tests/unit/util.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { folderName } from '../../src/renderer/util'

describe('folderName', () => {
  it('returns the last path segment', () => {
    expect(folderName('D:\\Workspace\\LocHub')).toBe('LocHub')
    expect(folderName('C:\\Users\\me\\')).toBe('me')
    expect(folderName('D:\\')).toBe('D:')
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падают**

Run: `npx vitest run tests/unit/log.test.ts tests/unit/util.test.ts`
Expected: FAIL (модули не найдены).

- [ ] **Step 3: Реализовать `log.ts`, `util.ts`, `resources.ts`, `window-state.ts`**

`src/main/log.ts`:
```ts
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

const MAX_BYTES = 1024 * 1024
const KEEP = 5

export function createLogger(dir: string): Logger {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'main.log')
  const rotate = (): void => {
    try {
      if (!existsSync(file) || statSync(file).size < MAX_BYTES) return
      rmSync(join(dir, `main.${KEEP - 1}.log`), { force: true })
      for (let i = KEEP - 2; i >= 1; i--) {
        const f = join(dir, `main.${i}.log`)
        if (existsSync(f)) renameSync(f, join(dir, `main.${i + 1}.log`))
      }
      renameSync(file, join(dir, 'main.1.log'))
    } catch {
      // logging must never crash the app
    }
  }
  const write = (level: string, message: string): void => {
    rotate()
    try {
      appendFileSync(file, `${new Date().toISOString()} ${level} ${message}\n`)
    } catch {
      // ignore
    }
  }
  return { info: (m) => write('INFO', m), warn: (m) => write('WARN', m), error: (m) => write('ERROR', m) }
}
```

`src/renderer/util.ts`:
```ts
export function folderName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}
```

`src/main/resources.ts`:
```ts
import { app } from 'electron'
import { join } from 'node:path'

export function resourcePath(rel: string): string {
  return app.isPackaged ? join(process.resourcesPath, rel) : join(__dirname, '..', '..', 'resources', rel)
}
```

`src/main/window-state.ts`:
```ts
import { screen, type BrowserWindow, type Rectangle } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'

export interface WindowState {
  bounds: { x?: number; y?: number; width: number; height: number }
  maximized: boolean
}

const DEFAULT_STATE: WindowState = { bounds: { width: 1200, height: 760 }, maximized: false }

function intersects(a: Rectangle, b: Rectangle): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

export function loadWindowState(file: string): WindowState {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as WindowState
    const { x, y, width, height } = s.bounds ?? {}
    if (typeof width !== 'number' || typeof height !== 'number') return DEFAULT_STATE
    if (typeof x !== 'number' || typeof y !== 'number') return { bounds: { width, height }, maximized: Boolean(s.maximized) }
    const onScreen = screen.getAllDisplays().some((d) => intersects(d.workArea, { x, y, width, height }))
    return { bounds: onScreen ? { x, y, width, height } : { width, height }, maximized: Boolean(s.maximized) }
  } catch {
    return DEFAULT_STATE
  }
}

export function trackWindowState(win: BrowserWindow, file: string): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const save = (): void => {
    if (win.isDestroyed()) return
    const state: WindowState = { bounds: win.getNormalBounds(), maximized: win.isMaximized() }
    try {
      writeFileSync(file, JSON.stringify(state))
    } catch {
      // ignore
    }
  }
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 500)
  }
  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    save()
  })
}
```

- [ ] **Step 4: Запустить unit-тесты — проходят**

Run: `npx vitest run tests/unit/log.test.ts tests/unit/util.test.ts`
Expected: PASS.

- [ ] **Step 5: Main — полная версия `src/main/index.ts`**

```ts
import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import { statSync, watch } from 'node:fs'
import { homedir, release } from 'node:os'
import { join } from 'node:path'
import { IPC, type AppInfo, type ClipboardContent } from '../shared/ipc'
import type { OpenTabRequest, Settings, TabInfo } from '../shared/types'
import { parseArgs, resolveLaunchDir, type LaunchCommand } from './args'
import { writeClaudeTabFiles } from './claude-tab-settings'
import { initDataDir, resolvePipeName } from './data-dir'
import { createLogger } from './log'
import { startPipeServer, type PipeServerHandle } from './pipe-server'
import { buildLaunch, detectProfiles, mergeProfiles, pickClaudeProfile, pickProfile, systemDetectDeps } from './profiles'
import { spawnPty } from './pty-host'
import { resourcePath } from './resources'
import { loadSettingsFile } from './settings'
import { TabManager } from './tab-manager'
import { loadWindowState, trackWindowState } from './window-state'

const dataDir = initDataDir()
const log = createLogger(join(dataDir, 'logs'))
const pipeName = resolvePipeName()
const settingsPath = join(dataDir, 'settings.json')
const isTest = process.env.CLAUDETERM_TEST === '1'

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k.startsWith('CLAUDETERM_') || k === 'ELECTRON_RUN_AS_NODE' || k === 'ELECTRON_RENDERER_URL') continue
    env[k] = v
  }
  env.TERM_PROGRAM = 'ClaudeTerm'
  env.COLORTERM = 'truecolor'
  return env
}

if (!app.requestSingleInstanceLock({ argv: process.argv })) {
  app.quit()
} else {
  app.whenReady().then(bootstrap).catch((e: unknown) => {
    log.error(`bootstrap failed: ${String(e)}`)
    app.exit(1)
  })
}

function bootstrap(): void {
  let win: BrowserWindow | null = null
  let rendererReady = false
  let pipe: PipeServerHandle | null = null
  const pendingLaunches: LaunchCommand[] = [parseArgs(process.argv)]
  const startupNotices: string[] = []

  const loaded = loadSettingsFile(settingsPath)
  let settings: Settings = loaded.settings
  startupNotices.push(...loaded.errors)
  let profiles = mergeProfiles(detectProfiles(systemDetectDeps()), settings.profiles)
  const claudeFiles = writeClaudeTabFiles(dataDir, process.execPath, resourcePath('hook/session-hook.js'))

  const send = (channel: string, ...args: unknown[]): void => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }
  const toast = (message: string): void => {
    log.warn(message)
    if (rendererReady) send(IPC.evToast, message)
    else startupNotices.push(message)
  }

  const tabs = new TabManager({
    spawn: spawnPty,
    pipeName,
    baseEnv: childEnv,
    resolveLaunch: (req) => {
      if (req.kind === 'claude') {
        const { profile, warning } = pickClaudeProfile(profiles, settings.claude.shellProfile)
        if (warning) toast(warning)
        const claude = { command: settings.claude.command, settingsPath: claudeFiles.settingsPath, resumeSessionId: req.resumeSessionId ?? null }
        return { profileName: profile.name, spec: buildLaunch(profile, 'claude', claude) }
      }
      const profile = pickProfile(profiles, req.profile ?? settings.defaultProfile)
      if (req.profile && profile.name !== req.profile) toast(`Profile "${req.profile}" not found; using ${profile.name}`)
      return { profileName: profile.name, spec: buildLaunch(profile, 'shell', null) }
    },
    events: {
      opened: (t) => send(IPC.evTabOpened, t),
      updated: (t) => send(IPC.evTabUpdated, t),
      closed: (id) => send(IPC.evTabClosed, id),
      activated: (id) => send(IPC.evTabActivated, id),
      order: (ids) => send(IPC.evTabsOrder, ids),
      data: (id, d) => send(IPC.evPtyData, id, d),
      exit: (id, code) => send(IPC.evPtyExit, id, code)
    }
  })

  const openTab = (req: OpenTabRequest, activate = true): TabInfo | null => {
    try {
      return tabs.open(req, { activate })
    } catch (e) {
      toast(`Cannot open tab: ${(e as Error).message}`)
      return null
    }
  }

  const openFromLaunch = (cmd: LaunchCommand): void => {
    if (cmd.kind === 'default') {
      if (tabs.list().length === 0) openTab({ kind: 'shell', cwd: homedir() })
      return
    }
    const { cwd, warning } = resolveLaunchDir(cmd.dir, homedir(), isDirectory)
    if (warning) toast(warning)
    openTab(cmd.kind === 'claude' ? { kind: 'claude', cwd } : { kind: 'shell', cwd, profile: cmd.profile })
  }

  const focusWindow = (): void => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    // Windows foreground lock: briefly going always-on-top lets a background process bring the window forward
    win.setAlwaysOnTop(true)
    win.focus()
    win.setAlwaysOnTop(false)
    if (!win.isFocused()) win.flashFrame(true)
  }

  app.on('second-instance', (_e, argv, _cwd, additionalData) => {
    const data = additionalData as { argv?: string[] } | null
    const cmd = parseArgs(data?.argv ?? argv)
    if (rendererReady) openFromLaunch(cmd)
    else pendingLaunches.push(cmd)
    focusWindow()
  })

  startPipeServer(pipeName, {
    showImage: async () => ({ ok: false, error: 'image panel is not available in this build' }),
    session: (msg) => {
      log.info(`session ${msg.source} tab=${msg.tabId} id=${msg.sessionId} transcript=${msg.transcriptPath ?? '-'}`)
      return tabs.setClaudeSession(msg.tabId, msg.sessionId) ? { ok: true } : { ok: false, error: `unknown claude tab: ${msg.tabId}` }
    }
  })
    .then((h) => { pipe = h })
    .catch((e: unknown) => log.error(`pipe server failed: ${String(e)}`))

  ipcMain.handle(IPC.appInfo, (): AppInfo => ({ windowsBuild: Number(release().split('.')[2]) || 0, test: isTest, homeDir: homedir() }))
  ipcMain.on(IPC.rendererReady, () => {
    rendererReady = true
    for (const n of startupNotices.splice(0)) send(IPC.evToast, n)
    for (const cmd of pendingLaunches.splice(0)) openFromLaunch(cmd)
  })
  ipcMain.on(IPC.bell, () => { if (win && !win.isFocused()) win.flashFrame(true) })
  ipcMain.handle(IPC.tabsOpen, (_e, req: OpenTabRequest) => openTab(req))
  ipcMain.on(IPC.tabsClose, (_e, id: string) => {
    tabs.close(id)
    if (tabs.list().length === 0) win?.close()
  })
  ipcMain.on(IPC.tabsActivate, (_e, id: string) => tabs.activate(id))
  ipcMain.on(IPC.tabsRename, (_e, id: string, title: string | null) => tabs.rename(id, title))
  ipcMain.on(IPC.tabsReorder, (_e, ids: string[]) => tabs.reorder(ids))
  ipcMain.on(IPC.tabsRestart, (_e, id: string) => tabs.restart(id))
  ipcMain.on(IPC.ptyWrite, (_e, id: string, data: string) => tabs.write(id, data))
  ipcMain.on(IPC.ptyResize, (_e, id: string, cols: number, rows: number) => tabs.resize(id, cols, rows))
  ipcMain.handle(IPC.profilesList, () => profiles.map((p) => p.name))
  ipcMain.handle(IPC.settingsGet, () => settings)
  ipcMain.on(IPC.settingsOpen, () => { void shell.openPath(settingsPath) })
  ipcMain.handle(IPC.clipboardRead, (): ClipboardContent => ({ text: clipboard.readText(), hasImage: !clipboard.readImage().isEmpty() }))
  ipcMain.on(IPC.clipboardWriteText, (_e, text: string) => clipboard.writeText(text))
  ipcMain.on(IPC.openExternal, (_e, url: string) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url) })

  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  const settingsWatcher = watch(dataDir, (_event, file) => {
    if (file !== 'settings.json') return
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      const next = loadSettingsFile(settingsPath)
      settings = next.settings
      profiles = mergeProfiles(detectProfiles(systemDetectDeps()), settings.profiles)
      for (const err of next.errors) toast(err)
      send(IPC.evSettings, settings)
    }, 300)
  })

  const windowStatePath = join(dataDir, 'window-state.json')
  const state = loadWindowState(windowStatePath)
  win = new BrowserWindow({
    ...state.bounds,
    minWidth: 480,
    minHeight: 300,
    show: false,
    backgroundColor: '#0C0C0C',
    autoHideMenuBar: true,
    title: 'ClaudeTerm',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  if (state.maximized) win.maximize()
  trackWindowState(win, windowStatePath)
  win.once('ready-to-show', () => win?.show())
  win.on('focus', () => win?.flashFrame(false))
  win.on('closed', () => { win = null })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => {
    tabs.disposeAll()
    settingsWatcher.close()
    void pipe?.close()
  })
}
```

- [ ] **Step 6: Renderer — меню, тосты, таб-бар**

`src/renderer/menu.ts`:
```ts
export interface MenuItem {
  label: string
  action?: () => void
  disabled?: boolean
  separator?: boolean
}

let current: HTMLElement | null = null

export function closeMenu(): void {
  current?.remove()
  current = null
}

function onOutside(e: MouseEvent): void {
  if (!current) return
  if (current.contains(e.target as Node)) {
    document.addEventListener('mousedown', onOutside, { once: true })
    return
  }
  closeMenu()
}

export function showMenu(at: { x: number; y: number }, items: MenuItem[]): void {
  closeMenu()
  const menu = document.createElement('div')
  menu.className = 'menu'
  for (const it of items) {
    if (it.separator) {
      const sep = document.createElement('div')
      sep.className = 'menu-sep'
      menu.append(sep)
      continue
    }
    const row = document.createElement('div')
    row.className = `menu-item${it.disabled ? ' disabled' : ''}`
    row.textContent = it.label
    if (!it.disabled && it.action) {
      const action = it.action
      row.addEventListener('click', () => {
        closeMenu()
        action()
      })
    }
    menu.append(row)
  }
  document.body.append(menu)
  const r = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(0, Math.min(at.x, window.innerWidth - r.width - 4))}px`
  menu.style.top = `${Math.max(0, Math.min(at.y, window.innerHeight - r.height - 4))}px`
  current = menu
  setTimeout(() => document.addEventListener('mousedown', onOutside, { once: true }), 0)
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu()
})
```

`src/renderer/toasts.ts`:
```ts
export function showToast(message: string, timeoutMs = 6000): void {
  const host = document.getElementById('toasts')
  if (!host) return
  const el = document.createElement('div')
  el.className = 'toast'
  el.textContent = message
  el.addEventListener('click', () => el.remove())
  host.append(el)
  setTimeout(() => el.remove(), timeoutMs)
}
```

`src/renderer/tabbar.ts`:
```ts
import type { TabKind } from '../shared/types'

export interface TabBarItem {
  id: string
  title: string
  kind: TabKind
  bell: boolean
  images: number
  exited: boolean
}

export interface TabBarCallbacks {
  activate(id: string): void
  close(id: string): void
  rename(id: string, title: string | null): void
  reorder(ids: string[]): void
  newTab(): void
  openMenu(anchor: HTMLElement): void
}

function button(text: string, cls: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.className = cls
  b.textContent = text
  b.title = title
  b.addEventListener('click', onClick)
  return b
}

export class TabBar {
  private editing: string | null = null
  private dragId: string | null = null
  private items: TabBarItem[] = []
  private activeId: string | null = null

  constructor(private readonly root: HTMLElement, private readonly cb: TabBarCallbacks) {}

  render(items: TabBarItem[], activeId: string | null): void {
    this.items = items
    this.activeId = activeId
    if (this.editing) return
    const list = document.createElement('div')
    list.className = 'tabs'
    for (const item of items) list.append(this.renderTab(item, item.id === activeId))
    const plus = button('+', 'tab-new', 'New tab (Ctrl+Shift+T)', () => this.cb.newTab())
    const more = button('▾', 'tab-menu', 'Profiles', (e) => this.cb.openMenu(e.currentTarget as HTMLElement))
    this.root.replaceChildren(list, plus, more)
  }

  private renderTab(item: TabBarItem, active: boolean): HTMLElement {
    const el = document.createElement('div')
    el.className = `tab${active ? ' active' : ''}${item.exited ? ' exited' : ''}`
    el.dataset.tabId = item.id
    el.draggable = true
    el.title = item.title
    const icon = document.createElement('span')
    icon.className = 'tab-icon'
    icon.textContent = item.kind === 'claude' ? '✳' : '>'
    const label = document.createElement('span')
    label.className = 'tab-title'
    label.textContent = item.title
    el.append(icon, label)
    if (item.bell) {
      const b = document.createElement('span')
      b.className = 'tab-bell'
      b.textContent = '●'
      el.append(b)
    }
    if (item.images > 0) {
      const b = document.createElement('span')
      b.className = 'tab-images'
      b.textContent = `🖼${item.images}`
      el.append(b)
    }
    el.append(button('×', 'tab-close', 'Close (Ctrl+Shift+W)', (e) => {
      e.stopPropagation()
      this.cb.close(item.id)
    }))
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault()
        this.cb.close(item.id)
      }
    })
    el.addEventListener('click', () => this.cb.activate(item.id))
    el.addEventListener('dblclick', () => this.beginRename(label, item))
    el.addEventListener('dragstart', () => { this.dragId = item.id })
    el.addEventListener('dragover', (e) => { if (this.dragId) e.preventDefault() })
    el.addEventListener('drop', (e) => {
      e.preventDefault()
      this.dropOn(item.id)
    })
    el.addEventListener('dragend', () => { this.dragId = null })
    return el
  }

  private dropOn(targetId: string): void {
    const from = this.dragId
    this.dragId = null
    if (!from || from === targetId) return
    const all = this.items.map((i) => i.id)
    const fromIdx = all.indexOf(from)
    const toIdx = all.indexOf(targetId)
    const ids = all.filter((id) => id !== from)
    const t = ids.indexOf(targetId)
    ids.splice(fromIdx < toIdx ? t + 1 : t, 0, from)
    this.cb.reorder(ids)
  }

  private beginRename(label: HTMLElement, item: TabBarItem): void {
    this.editing = item.id
    const input = document.createElement('input')
    input.className = 'tab-rename'
    input.value = item.title
    label.replaceWith(input)
    input.focus()
    input.select()
    let done = false
    const finish = (commit: boolean): void => {
      if (done) return
      done = true
      this.editing = null
      const value = input.value.trim()
      if (commit) this.cb.rename(item.id, value === '' ? null : value)
      this.render(this.items, this.activeId)
    }
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') finish(true)
      else if (e.key === 'Escape') finish(false)
    })
    input.addEventListener('blur', () => finish(true))
  }
}
```

- [ ] **Step 7: Renderer — полная версия `src/renderer/main.ts`**

```ts
import './styles.css'
import type { AppInfo } from '../shared/ipc'
import type { Settings, TabInfo } from '../shared/types'
import { showMenu, type MenuItem } from './menu'
import { TabBar } from './tabbar'
import { TerminalView } from './terminal-view'
import { resolveTheme } from './themes'
import { showToast } from './toasts'
import { folderName } from './util'

interface TabState {
  info: TabInfo
  view: TerminalView
  oscTitle: string | null
  bell: boolean
  images: number
}

const ct = window.ct
const tabs = new Map<string, TabState>()
let order: string[] = []
let activeId: string | null = null
let settings: Settings
let appInfo: AppInfo
let fontSize = 13
let tabBar: TabBar

const titleOf = (t: TabState): string => t.info.customTitle ?? t.oscTitle ?? folderName(t.info.cwd)

function renderTabs(): void {
  const items = order.flatMap((id) => {
    const t = tabs.get(id)
    return t ? [{ id, title: titleOf(t), kind: t.info.kind, bell: t.bell, images: t.images, exited: t.info.exited }] : []
  })
  tabBar.render(items, activeId)
  const active = activeId ? tabs.get(activeId) : undefined
  document.title = active ? `${titleOf(active)} — ClaudeTerm` : 'ClaudeTerm'
}

function handleInput(tabId: string, data: string): void {
  const t = tabs.get(tabId)
  if (!t) return
  if (t.info.exited) {
    if (data === '\r') ct.restartTab(tabId)
    return
  }
  ct.writePty(tabId, data)
}

function addTab(info: TabInfo): void {
  const view = new TerminalView({
    tabId: info.id,
    container: document.getElementById('terminals')!,
    fontFamily: settings.font.family,
    fontSize,
    theme: resolveTheme(settings.theme),
    scrollback: settings.scrollback,
    windowsBuild: appInfo.windowsBuild,
    useWebgl: !appInfo.test,
    onInput: (data) => handleInput(info.id, data),
    onResize: (cols, rows) => ct.resizePty(info.id, cols, rows),
    onTitle: (title) => {
      const t = tabs.get(info.id)
      if (!t) return
      t.oscTitle = title.trim() || null
      renderTabs()
    },
    onBell: () => {
      const t = tabs.get(info.id)
      if (!t) return
      if (info.id !== activeId) {
        t.bell = true
        renderTabs()
      }
      if (!document.hasFocus()) ct.bell()
    },
    onLink: (uri) => ct.openExternal(uri)
  })
  view.show(false)
  tabs.set(info.id, { info, view, oscTitle: null, bell: false, images: 0 })
  if (!order.includes(info.id)) order.push(info.id)
  renderTabs()
}

function activate(tabId: string): void {
  activeId = tabId
  for (const [id, t] of tabs) t.view.show(id === tabId)
  const t = tabs.get(tabId)
  if (t) t.bell = false
  renderTabs()
}

function newTabMenu(anchor: HTMLElement): void {
  void ct.listProfiles().then((names) => {
    const active = activeId ? tabs.get(activeId) : undefined
    const items: MenuItem[] = [
      ...names.map((name) => ({ label: name, action: () => void ct.openTab({ kind: 'shell', cwd: appInfo.homeDir, profile: name }) })),
      { label: '', separator: true },
      { label: 'Claude Code', action: () => void ct.openTab({ kind: 'claude', cwd: active?.info.cwd ?? appInfo.homeDir }) }
    ]
    const r = anchor.getBoundingClientRect()
    showMenu({ x: r.left, y: r.bottom }, items)
  })
}

function applySettings(s: Settings): void {
  settings = s
  fontSize = s.font.size
  const theme = resolveTheme(s.theme)
  for (const t of tabs.values()) {
    t.view.setFont(s.font.family, fontSize)
    t.view.setTheme(theme)
  }
}

async function boot(): Promise<void> {
  appInfo = await ct.appInfo()
  settings = await ct.getSettings()
  fontSize = settings.font.size
  tabBar = new TabBar(document.getElementById('tabbar')!, {
    activate: (id) => ct.activateTab(id),
    close: (id) => ct.closeTab(id),
    rename: (id, title) => ct.renameTab(id, title),
    reorder: (ids) => ct.reorderTabs(ids),
    newTab: () => void ct.openTab({ kind: 'shell', cwd: appInfo.homeDir }),
    openMenu: (anchor) => newTabMenu(anchor)
  })
  ct.onTabOpened(addTab)
  ct.onTabUpdated((info) => {
    const t = tabs.get(info.id)
    if (!t) return
    t.info = info
    renderTabs()
  })
  ct.onTabClosed((id) => {
    const t = tabs.get(id)
    if (!t) return
    t.view.dispose()
    tabs.delete(id)
    order = order.filter((x) => x !== id)
    if (activeId === id) activeId = null
    renderTabs()
  })
  ct.onTabActivated(activate)
  ct.onTabsOrder((ids) => {
    order = ids.filter((id) => tabs.has(id))
    renderTabs()
  })
  ct.onPtyData((id, data) => tabs.get(id)?.view.write(data))
  ct.onPtyExit((id, code) => tabs.get(id)?.view.write(`\r\n\x1b[90m[process exited with code ${code}] Enter — restart, Ctrl+Shift+W — close\x1b[0m\r\n`))
  ct.onToast((m) => showToast(m))
  ct.onSettings(applySettings)
  window.addEventListener('focus', () => {
    const t = activeId ? tabs.get(activeId) : undefined
    t?.view.term.focus()
  })
  if (appInfo.test) {
    window.__ct = {
      activeTabId: () => activeId,
      tabIds: () => [...order],
      tabTitle: (id) => {
        const t = tabs.get(id)
        return t ? titleOf(t) : null
      },
      bufferText: (id) => tabs.get(id ?? activeId ?? '')?.view.bufferText() ?? ''
    }
  }
  ct.rendererReady()
}

void boot()
```

- [ ] **Step 8: Стили таб-бара, меню и тостов — дописать в конец `src/renderer/styles.css`**

```css
#tabbar { display: flex; align-items: stretch; height: 34px; background: var(--chrome); border-bottom: 1px solid var(--border); user-select: none; }
.tabs { display: flex; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.tab { display: flex; align-items: center; gap: 6px; max-width: 220px; min-width: 90px; padding: 0 6px 0 10px; border-right: 1px solid var(--border); color: var(--muted); cursor: default; }
.tab.active { background: var(--bg); color: var(--fg); box-shadow: inset 0 2px 0 var(--accent); }
.tab.exited .tab-title { text-decoration: line-through; }
.tab-icon { font-size: 11px; color: var(--accent); }
.tab-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab-bell { color: var(--accent); font-size: 10px; }
.tab-images { font-size: 11px; }
.tab-close, .tab-new, .tab-menu { background: none; border: 0; color: var(--muted); font-size: 14px; cursor: pointer; padding: 0 6px; }
.tab-close:hover, .tab-new:hover, .tab-menu:hover { color: var(--fg); }
.tab-rename { flex: 1; min-width: 0; background: var(--chrome-2); color: var(--fg); border: 1px solid var(--accent); font: inherit; padding: 1px 4px; }
.menu { position: fixed; z-index: 50; min-width: 200px; background: var(--chrome-2); border: 1px solid var(--border); border-radius: 6px; padding: 4px 0; box-shadow: 0 8px 24px #0008; }
.menu-item { padding: 6px 14px; cursor: pointer; white-space: nowrap; }
.menu-item:hover { background: #ffffff14; }
.menu-item.disabled { color: var(--muted); cursor: default; }
.menu-sep { height: 1px; margin: 4px 0; background: var(--border); }
#toasts { position: fixed; right: 12px; bottom: 12px; display: flex; flex-direction: column; gap: 8px; z-index: 60; }
.toast { max-width: 420px; padding: 8px 12px; background: var(--chrome-2); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 6px; cursor: pointer; }
```

- [ ] **Step 9: E2E — второй экземпляр и действия с вкладками**

`tests/e2e/tabs.spec.ts`:
```ts
import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchApp, ROOT, testEnv } from './helpers'

const electronExe = createRequire(__filename)('electron') as unknown as string

test('second instance opens a claude tab in the running window', async () => {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const { app, page, dataDir, pipeName } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--shell', work] })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await new Promise<void>((resolve) => {
    spawn(electronExe, [ROOT, '--claude', work], { env: testEnv(dataDir, pipeName) }).on('exit', () => resolve())
  })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const id = await page.evaluate(() => window.__ct!.activeTabId())
  await expect.poll(() => bufferText(page, id!), { timeout: 15_000 }).toMatch(/fake-claude --settings/)
  await app.close()
})

test('tabs can be renamed and closed', async () => {
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.locator('.tab-new').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await page.locator('.tab').first().dblclick()
  await page.locator('.tab-rename').fill('build')
  await page.keyboard.press('Enter')
  await expect(page.locator('.tab').first().locator('.tab-title')).toHaveText('build')
  await page.locator('.tab').first().locator('.tab-close').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await app.close()
})
```

- [ ] **Step 10: Прогнать всё**

Run: `npm run typecheck` → без ошибок.
Run: `npm test` → PASS.
Run: `npm run test:e2e` → PASS (`smoke.spec.ts` из Task 1 продолжает проходить: запуск без аргументов открывает вкладку профиля по умолчанию).

- [ ] **Step 11: Ручная проверка хука с настоящим claude (риск из спеки §12)**

1. `npm run dev`.
2. `▾` → «Claude Code». claude запускается во вкладке.
3. В claude выполнить `/clear`.
4. Открыть `%APPDATA%\ClaudeTerm-dev\logs\main.log`. Ожидается две строки `session startup …` и `session clear …` с **разными** `id=` и непустыми `transcript=`.

Если строк нет — **остановиться** и сообщить: хук через `--settings` не срабатывает (запасной вариант по спеке — `--session-id`, решение за пользователем). Результат проверки записать в отчёт задачи.

- [ ] **Step 12: Checkpoint**

Не коммитить.

---

### Task 10: Клавиатура и мышь как в Windows Terminal (+ Shift+Enter и вставка картинки для claude)

**Files:**
- Create: `src/renderer/keymap.ts`, `src/renderer/search.ts`
- Modify: `src/renderer/main.ts`, `src/renderer/styles.css`
- Test: `tests/unit/keymap.test.ts`, `tests/e2e/keys.spec.ts`

**Interfaces:**
- Consumes: renderer `main.ts` из Task 9 (`tabs`, `order`, `activeId`, `settings`, `appInfo`, `fontSize`, `handleInput`, `addTab`, `boot`), `TerminalView.onKey`/`search`/`element` (Task 1), `CtApi.readClipboard`/`writeClipboardText`/`pathForFile`/`openSettingsFile`.
- Produces:
  - `keymap.ts`: `type KeyAction` (union ниже), `interface KeyLike { type; key; code; ctrlKey; shiftKey; altKey; metaKey }`, `mapKey(e: KeyLike): KeyAction | null`.
  - `search.ts`: `class SearchBar { open(); close() }`.
  - renderer `main.ts`: `let toggleImagePanel: () => void` — заглушка, которую Task 16 переназначает на панель картинок; `runAction(action, tabId)`.

- [ ] **Step 1: Написать падающий тест keymap**

`tests/unit/keymap.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { mapKey, type KeyLike } from '../../src/renderer/keymap'

const k = (code: string, mods: Partial<KeyLike> = {}, key = ''): KeyLike => ({ type: 'keydown', key, code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods })
const cs = { ctrlKey: true, shiftKey: true }

describe('mapKey', () => {
  it('matches the physical key, so a Russian layout works', () => {
    expect(mapKey(k('KeyT', cs, 'Е'))).toEqual({ type: 'newTab' })
    expect(mapKey(k('KeyL', cs, 'Д'))).toEqual({ type: 'newClaudeTab' })
    expect(mapKey(k('KeyW', cs, 'Ц'))).toEqual({ type: 'closeTab' })
    expect(mapKey(k('KeyC', cs, 'С'))).toEqual({ type: 'copy' })
    expect(mapKey(k('KeyV', cs, 'М'))).toEqual({ type: 'paste' })
    expect(mapKey(k('KeyF', cs, 'А'))).toEqual({ type: 'find' })
    expect(mapKey(k('KeyI', cs, 'Ш'))).toEqual({ type: 'toggleImages' })
  })

  it('Shift+Enter sends ESC CR for a newline in the claude prompt', () => {
    expect(mapKey(k('Enter', { shiftKey: true }))).toEqual({ type: 'send', data: '\x1b\r' })
    expect(mapKey(k('NumpadEnter', { shiftKey: true }))).toEqual({ type: 'send', data: '\x1b\r' })
  })

  it('Ctrl+C and Ctrl+V are smart', () => {
    expect(mapKey(k('KeyC', { ctrlKey: true }, 'с'))).toEqual({ type: 'copyOrInterrupt' })
    expect(mapKey(k('KeyV', { ctrlKey: true }, 'м'))).toEqual({ type: 'smartPaste' })
  })

  it('tab navigation', () => {
    expect(mapKey(k('Tab', { ctrlKey: true }))).toEqual({ type: 'nextTab' })
    expect(mapKey(k('Tab', cs))).toEqual({ type: 'prevTab' })
    expect(mapKey(k('Digit1', { ctrlKey: true, altKey: true }))).toEqual({ type: 'gotoTab', index: 0 })
    expect(mapKey(k('Digit9', { ctrlKey: true, altKey: true }))).toEqual({ type: 'gotoTab', index: 8 })
  })

  it('zoom and settings', () => {
    expect(mapKey(k('Equal', { ctrlKey: true }))).toEqual({ type: 'zoomIn' })
    expect(mapKey(k('Minus', { ctrlKey: true }))).toEqual({ type: 'zoomOut' })
    expect(mapKey(k('Digit0', { ctrlKey: true }))).toEqual({ type: 'zoomReset' })
    expect(mapKey(k('Comma', { ctrlKey: true }))).toEqual({ type: 'openSettings' })
  })

  it('leaves everything else to the terminal', () => {
    expect(mapKey(k('Enter'))).toBeNull()
    expect(mapKey(k('KeyT', { ctrlKey: true }))).toBeNull()
    expect(mapKey({ ...k('Enter', { shiftKey: true }), type: 'keyup' })).toBeNull()
    expect(mapKey(k('KeyT', { ...cs, metaKey: true }))).toBeNull()
    expect(mapKey(k('KeyT', { ...cs, altKey: true }))).toBeNull()
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run tests/unit/keymap.test.ts`
Expected: FAIL (модуль не найден).

- [ ] **Step 3: Реализовать `src/renderer/keymap.ts` и `src/renderer/search.ts`**

`src/renderer/keymap.ts`:
```ts
export type KeyAction =
  | { type: 'newTab' }
  | { type: 'newClaudeTab' }
  | { type: 'closeTab' }
  | { type: 'nextTab' }
  | { type: 'prevTab' }
  | { type: 'gotoTab'; index: number }
  | { type: 'copy' }
  | { type: 'paste' }
  | { type: 'copyOrInterrupt' }
  | { type: 'smartPaste' }
  | { type: 'send'; data: string }
  | { type: 'find' }
  | { type: 'toggleImages' }
  | { type: 'zoomIn' }
  | { type: 'zoomOut' }
  | { type: 'zoomReset' }
  | { type: 'openSettings' }

export interface KeyLike {
  type: string
  key: string
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

// Uses KeyboardEvent.code (physical key) so shortcuts work with any keyboard layout.
export function mapKey(e: KeyLike): KeyAction | null {
  if (e.type !== 'keydown' || e.metaKey) return null
  const { ctrlKey: c, shiftKey: s, altKey: a, code } = e
  if (c && s && !a) {
    switch (code) {
      case 'KeyT': return { type: 'newTab' }
      case 'KeyL': return { type: 'newClaudeTab' }
      case 'KeyW': return { type: 'closeTab' }
      case 'KeyC': return { type: 'copy' }
      case 'KeyV': return { type: 'paste' }
      case 'KeyF': return { type: 'find' }
      case 'KeyI': return { type: 'toggleImages' }
      case 'Tab': return { type: 'prevTab' }
    }
    return null
  }
  if (c && !s && !a) {
    switch (code) {
      case 'Tab': return { type: 'nextTab' }
      case 'KeyC': return { type: 'copyOrInterrupt' }
      case 'KeyV': return { type: 'smartPaste' }
      case 'Equal':
      case 'NumpadAdd': return { type: 'zoomIn' }
      case 'Minus':
      case 'NumpadSubtract': return { type: 'zoomOut' }
      case 'Digit0':
      case 'Numpad0': return { type: 'zoomReset' }
      case 'Comma': return { type: 'openSettings' }
    }
    return null
  }
  if (c && a && !s && /^Digit[1-9]$/.test(code)) return { type: 'gotoTab', index: Number(code.slice(5)) - 1 }
  if (s && !c && !a && (code === 'Enter' || code === 'NumpadEnter')) return { type: 'send', data: '\x1b\r' }
  return null
}
```

`src/renderer/search.ts`:
```ts
import type { SearchAddon } from '@xterm/addon-search'

export class SearchBar {
  private readonly input: HTMLInputElement

  constructor(private readonly root: HTMLElement, private readonly addon: () => SearchAddon | null, private readonly onClose: () => void) {
    this.input = document.createElement('input')
    this.input.placeholder = 'Find — Enter / Shift+Enter, Esc to close'
    root.replaceChildren(this.input)
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        this.close()
        return
      }
      if (e.key !== 'Enter') return
      e.preventDefault()
      const a = this.addon()
      if (!a || !this.input.value) return
      if (e.shiftKey) a.findPrevious(this.input.value)
      else a.findNext(this.input.value)
    })
  }

  open(): void {
    this.root.hidden = false
    this.input.focus()
    this.input.select()
  }

  close(): void {
    this.root.hidden = true
    this.addon()?.clearDecorations()
    this.onClose()
  }
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `npx vitest run tests/unit/keymap.test.ts`
Expected: PASS.

- [ ] **Step 5: Подключить в `src/renderer/main.ts`**

5a. Добавить импорты:
```ts
import { mapKey, type KeyAction } from './keymap'
import { SearchBar } from './search'
```

5b. После строки `let tabBar: TabBar` добавить:
```ts
let searchBar: SearchBar
let toggleImagePanel = (): void => {}
```

5c. После функции `handleInput` добавить:
```ts
function setFontSize(size: number): void {
  fontSize = Math.min(72, Math.max(6, size))
  for (const t of tabs.values()) t.view.setFont(settings.font.family, fontSize)
}

function cycleTabs(delta: number): void {
  if (order.length === 0) return
  const i = activeId ? order.indexOf(activeId) : -1
  const next = order[(i + delta + order.length) % order.length]
  if (next) ct.activateTab(next)
}

function copySelection(t: TabState): boolean {
  if (!t.view.term.hasSelection()) return false
  ct.writeClipboardText(t.view.term.getSelection())
  t.view.term.clearSelection()
  return true
}

async function paste(t: TabState, allowImage: boolean): Promise<void> {
  const clip = await ct.readClipboard()
  if (clip.text.length > 0) t.view.term.paste(clip.text)
  // image-only clipboard: Alt+V makes claude read the image from the clipboard itself
  else if (allowImage && clip.hasImage) handleInput(t.info.id, '\x1bv')
}

function runAction(a: KeyAction, tabId: string | null): void {
  const t = tabId ? tabs.get(tabId) : undefined
  switch (a.type) {
    case 'newTab': void ct.openTab({ kind: 'shell', cwd: appInfo.homeDir }); break
    case 'newClaudeTab': void ct.openTab({ kind: 'claude', cwd: t?.info.cwd ?? appInfo.homeDir }); break
    case 'closeTab': if (tabId) ct.closeTab(tabId); break
    case 'nextTab': cycleTabs(1); break
    case 'prevTab': cycleTabs(-1); break
    case 'gotoTab': {
      const id = order[a.index]
      if (id) ct.activateTab(id)
      break
    }
    case 'copy': if (t) copySelection(t); break
    case 'paste': if (t) void paste(t, false); break
    case 'smartPaste': if (t) void paste(t, true); break
    case 'copyOrInterrupt': break
    case 'send': if (tabId) handleInput(tabId, a.data); break
    case 'find': searchBar.open(); break
    case 'toggleImages': toggleImagePanel(); break
    case 'zoomIn': setFontSize(fontSize + 1); break
    case 'zoomOut': setFontSize(fontSize - 1); break
    case 'zoomReset': setFontSize(settings.font.size); break
    case 'openSettings': ct.openSettingsFile(); break
  }
}

function onTerminalKey(tabId: string, e: KeyboardEvent): boolean {
  const action = mapKey(e)
  if (!action) return true
  if (action.type === 'copyOrInterrupt') {
    const t = tabs.get(tabId)
    if (t && copySelection(t)) {
      e.preventDefault()
      return false
    }
    return true // no selection: let xterm send ^C
  }
  // preventDefault on keydown also suppresses keypress and the native paste event
  e.preventDefault()
  runAction(action, tabId)
  return false
}

function attachTerminalMouse(tabId: string, view: TerminalView): void {
  view.element.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    const t = tabs.get(tabId)
    if (t && !copySelection(t)) void paste(t, true)
  })
  view.element.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
  })
  view.element.addEventListener('drop', (e) => {
    e.preventDefault()
    const paths = Array.from(e.dataTransfer?.files ?? []).map((f) => ct.pathForFile(f)).filter((p) => p.length > 0)
    if (paths.length > 0) handleInput(tabId, paths.map((p) => `"${p}"`).join(' '))
  })
}
```

5d. В `addTab` в объект опций `new TerminalView({...})` добавить свойство:
```ts
    onKey: (e) => onTerminalKey(info.id, e),
```
и сразу после строки `view.show(false)` добавить:
```ts
  attachTerminalMouse(info.id, view)
```

5e. В `boot()` сразу после создания `tabBar = new TabBar(...)` добавить:
```ts
  searchBar = new SearchBar(
    document.getElementById('search')!,
    () => (activeId ? tabs.get(activeId)?.view.search ?? null : null),
    () => { if (activeId) tabs.get(activeId)?.view.term.focus() }
  )
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null
    if (target?.closest('.xterm') || target?.tagName === 'INPUT') return
    const a = mapKey(e)
    if (!a || a.type === 'send' || a.type === 'copyOrInterrupt' || a.type === 'smartPaste' || a.type === 'paste' || a.type === 'copy') return
    e.preventDefault()
    runAction(a, activeId)
  })
  // a file dropped outside a terminal must not navigate the window
  document.addEventListener('dragover', (e) => e.preventDefault())
  document.addEventListener('drop', (e) => e.preventDefault())
```

- [ ] **Step 6: Стили поиска — дописать в `styles.css`**

```css
#search { position: fixed; top: 40px; right: 16px; z-index: 40; background: var(--chrome-2); border: 1px solid var(--border); border-radius: 6px; padding: 6px; }
#search input { width: 280px; background: var(--bg); color: var(--fg); border: 1px solid var(--border); padding: 4px 6px; font: inherit; }
```

- [ ] **Step 7: E2E на хоткеи**

`tests/e2e/keys.spec.ts`:
```ts
import { test } from '@playwright/test'
import { FAKE_CLAUDE_SETTINGS, launchApp } from './helpers'

test('Ctrl+Shift+T opens, Ctrl+Tab cycles, Ctrl+Shift+W closes', async () => {
  const { app, page } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const first = await page.evaluate(() => window.__ct!.activeTabId())
  await page.locator('.terminal-host:visible .xterm').click()
  await page.keyboard.press('Control+Shift+KeyT')
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await page.waitForFunction((id) => window.__ct!.activeTabId() !== id, first)
  await page.keyboard.press('Control+Tab')
  await page.waitForFunction((id) => window.__ct!.activeTabId() === id, first)
  await page.keyboard.press('Control+Shift+KeyW')
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await app.close()
})
```

- [ ] **Step 8: Прогнать**

Run: `npm run typecheck && npm test && npm run test:e2e` → PASS.

- [ ] **Step 9: Ручная проверка с настоящим claude (риск из спеки §12)**

`npm run dev` → `▾` → «Claude Code». Проверить и записать результат в отчёт:
1. Shift+Enter в промпте claude даёт перенос строки, а не отправку.
2. Win+Shift+S (скриншот в буфер) → Ctrl+V в claude → появляется `[Image #1]`.
3. Выделение мышью + Ctrl+C копирует; без выделения Ctrl+C прерывает claude.
4. ПКМ без выделения вставляет текст из буфера.
5. Перетаскивание файла из Explorer вставляет путь в кавычках.
6. Ctrl+Shift+F находит текст; клик по ссылке открывает браузер; Ctrl+= / Ctrl+- меняют шрифт.
7. Включить русскую раскладку — Ctrl+Shift+T открывает вкладку.

Если 1 или 2 не работают — остановиться и сообщить (нужна другая последовательность для Shift+Enter / вставки).

- [ ] **Step 10: Checkpoint**

Не коммитить.

---

### Task 11: Снимок вкладок и «Продолжить предыдущие сессии»

**Files:**
- Create: `src/main/session-store.ts`, `src/renderer/restore-banner.ts`
- Modify: `src/main/index.ts`, `src/renderer/main.ts`, `src/renderer/styles.css`
- Test: `tests/unit/session-store.test.ts`, `tests/unit/restore-banner.test.ts`, `tests/e2e/restore.spec.ts`

**Interfaces:**
- Consumes: `TabManager.snapshot()`, `TabManager.activate()`, `openTab(req, activate)`, `resolveLaunchDir`, `isDirectory`, `send`, `toast` (Task 9, main `index.ts`); `SessionSnapshot`, `SessionSnapshotTab`, `RestoreInfo`, `isUuid`.
- Produces:
  - `session-store.ts`: `parseSnapshot(text): SessionSnapshot | null`, `class SessionStore(dir, opts?: { debounceMs?; now?(): Date; onError?(m) })` с `statePath`, `previousPath`, `rotateOnStartup(): SessionSnapshot | null`, `readPrevious()`, `clearPrevious()`, `scheduleSave(tabs)`, `saveNow(tabs)`, `flush()`.
  - `restore-banner.ts`: `class RestoreBanner(root, onRestore) { update(info: RestoreInfo | null) }`, `plural(n): string`, `formatTime(iso): string`.

- [ ] **Step 1: Написать падающие тесты**

`tests/unit/session-store.test.ts`:
```ts
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseSnapshot, SessionStore } from '../../src/main/session-store'
import type { SessionSnapshot, SessionSnapshotTab } from '../../src/shared/types'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const claudeTab: SessionSnapshotTab = { kind: 'claude', profile: 'Windows PowerShell', cwd: 'D:\\x', title: null, claudeSessionId: SID }
const shellTab: SessionSnapshotTab = { kind: 'shell', profile: 'Git Bash', cwd: 'D:\\y', title: 'build', claudeSessionId: null }
const snap = (tabs: SessionSnapshotTab[]): SessionSnapshot => ({ version: 1, savedAt: '2026-10-05T10:00:00.000Z', tabs })
const newDir = (): string => mkdtempSync(join(tmpdir(), 'ct-sess-'))

afterEach(() => { vi.useRealTimers() })

describe('parseSnapshot', () => {
  it('round-trips a valid snapshot', () => {
    expect(parseSnapshot(JSON.stringify(snap([claudeTab, shellTab])))).toEqual(snap([claudeTab, shellTab]))
  })

  it('drops non-UUID session ids and rejects malformed files', () => {
    expect(parseSnapshot(JSON.stringify(snap([{ ...claudeTab, claudeSessionId: 'x; calc' }])))?.tabs[0].claudeSessionId).toBeNull()
    expect(parseSnapshot('{')).toBeNull()
    expect(parseSnapshot(JSON.stringify({ version: 2, savedAt: 'x', tabs: [] }))).toBeNull()
    expect(parseSnapshot(JSON.stringify(snap([{ ...shellTab, kind: 'evil' as 'shell' }])))).toBeNull()
  })
})

describe('SessionStore', () => {
  it('rotateOnStartup moves a non-empty state to previous', () => {
    const dir = newDir()
    const s = new SessionStore(dir)
    writeFileSync(s.statePath, JSON.stringify(snap([claudeTab])))
    expect(s.rotateOnStartup()).toEqual(snap([claudeTab]))
    expect(existsSync(s.statePath)).toBe(false)
    expect(existsSync(s.previousPath)).toBe(true)
  })

  it('an empty state does not overwrite an existing previous', () => {
    const dir = newDir()
    const s = new SessionStore(dir)
    writeFileSync(s.previousPath, JSON.stringify(snap([claudeTab])))
    writeFileSync(s.statePath, JSON.stringify(snap([])))
    expect(s.rotateOnStartup()).toEqual(snap([claudeTab]))
  })

  it('a corrupt state is not rotated and is reported', () => {
    const dir = newDir()
    const onError = vi.fn()
    const s = new SessionStore(dir, { onError })
    writeFileSync(s.previousPath, JSON.stringify(snap([shellTab])))
    writeFileSync(s.statePath, '{broken')
    expect(s.rotateOnStartup()).toEqual(snap([shellTab]))
    expect(onError).toHaveBeenCalled()
  })

  it('nothing saved → no previous', () => {
    expect(new SessionStore(newDir()).rotateOnStartup()).toBeNull()
  })

  it('saveNow writes atomically', () => {
    const dir = newDir()
    const s = new SessionStore(dir, { now: () => new Date('2026-10-05T10:00:00.000Z') })
    s.saveNow([shellTab])
    expect(JSON.parse(readFileSync(s.statePath, 'utf8'))).toEqual(snap([shellTab]))
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('scheduleSave debounces and flush writes the latest tabs immediately', () => {
    vi.useFakeTimers()
    const s = new SessionStore(newDir(), { debounceMs: 500 })
    s.scheduleSave([claudeTab])
    s.scheduleSave([shellTab])
    expect(existsSync(s.statePath)).toBe(false)
    vi.advanceTimersByTime(500)
    expect(parseSnapshot(readFileSync(s.statePath, 'utf8'))?.tabs).toEqual([shellTab])
    s.scheduleSave([claudeTab])
    s.flush()
    expect(parseSnapshot(readFileSync(s.statePath, 'utf8'))?.tabs).toEqual([claudeTab])
  })

  it('clearPrevious removes the previous snapshot', () => {
    const s = new SessionStore(newDir())
    writeFileSync(s.previousPath, JSON.stringify(snap([claudeTab])))
    s.clearPrevious()
    expect(s.readPrevious()).toBeNull()
  })
})
```

`tests/unit/restore-banner.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { plural } from '../../src/renderer/restore-banner'

describe('plural', () => {
  it('uses Russian plural forms for tabs', () => {
    expect([1, 2, 4, 5, 11, 12, 21, 22, 25].map(plural)).toEqual(['вкладка', 'вкладки', 'вкладки', 'вкладок', 'вкладок', 'вкладок', 'вкладка', 'вкладки', 'вкладок'])
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падают**

Run: `npx vitest run tests/unit/session-store.test.ts tests/unit/restore-banner.test.ts`
Expected: FAIL (модули не найдены).

- [ ] **Step 3: Реализовать**

`src/main/session-store.ts`:
```ts
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isUuid } from '../shared/protocol'
import type { SessionSnapshot, SessionSnapshotTab } from '../shared/types'

export function parseSnapshot(text: string): SessionSnapshot | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (r.version !== 1 || typeof r.savedAt !== 'string' || !Array.isArray(r.tabs)) return null
  const tabs: SessionSnapshotTab[] = []
  for (const t of r.tabs as unknown[]) {
    if (typeof t !== 'object' || t === null) return null
    const x = t as Record<string, unknown>
    if ((x.kind !== 'claude' && x.kind !== 'shell') || typeof x.profile !== 'string' || typeof x.cwd !== 'string') return null
    tabs.push({
      kind: x.kind,
      profile: x.profile,
      cwd: x.cwd,
      title: typeof x.title === 'string' ? x.title : null,
      claudeSessionId: isUuid(x.claudeSessionId) ? x.claudeSessionId : null
    })
  }
  return { version: 1, savedAt: r.savedAt, tabs }
}

export interface SessionStoreOptions {
  debounceMs?: number
  now?(): Date
  onError?(message: string): void
}

export class SessionStore {
  readonly statePath: string
  readonly previousPath: string
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: SessionSnapshotTab[] | null = null

  constructor(dir: string, private readonly opts: SessionStoreOptions = {}) {
    this.statePath = join(dir, 'session-state.json')
    this.previousPath = join(dir, 'previous-session.json')
  }

  rotateOnStartup(): SessionSnapshot | null {
    const current = this.read(this.statePath)
    if (current && current.tabs.length > 0) {
      try {
        renameSync(this.statePath, this.previousPath)
      } catch (e) {
        this.opts.onError?.(`cannot rotate session state: ${(e as Error).message}`)
      }
    }
    return this.readPrevious()
  }

  readPrevious(): SessionSnapshot | null {
    const s = this.read(this.previousPath)
    return s && s.tabs.length > 0 ? s : null
  }

  clearPrevious(): void {
    rmSync(this.previousPath, { force: true })
  }

  scheduleSave(tabs: SessionSnapshotTab[]): void {
    this.pending = tabs
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.opts.debounceMs ?? 500)
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.pending) return
    const tabs = this.pending
    this.pending = null
    this.saveNow(tabs)
  }

  saveNow(tabs: SessionSnapshotTab[]): void {
    const snap: SessionSnapshot = { version: 1, savedAt: (this.opts.now?.() ?? new Date()).toISOString(), tabs }
    const tmp = `${this.statePath}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(snap, null, 2), 'utf8')
      renameSync(tmp, this.statePath)
    } catch (e) {
      this.opts.onError?.(`cannot save session state: ${(e as Error).message}`)
    }
  }

  private read(path: string): SessionSnapshot | null {
    if (!existsSync(path)) return null
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      return null
    }
    const s = parseSnapshot(text)
    if (!s) this.opts.onError?.(`ignoring corrupt ${path}`)
    return s
  }
}
```

`src/renderer/restore-banner.ts`:
```ts
import type { RestoreInfo } from '../shared/ipc'

export function plural(n: number): string {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return 'вкладка'
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'вкладки'
  return 'вкладок'
}

export function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export class RestoreBanner {
  private dismissed = false

  constructor(private readonly root: HTMLElement, private readonly onRestore: () => void) {}

  update(info: RestoreInfo | null): void {
    if (!info || this.dismissed) {
      this.root.hidden = true
      this.root.replaceChildren()
      return
    }
    const text = document.createElement('span')
    text.textContent = `Предыдущая сессия: ${info.tabs} ${plural(info.tabs)} (${info.claudeTabs} Claude) · ${formatTime(info.savedAt)}`
    const go = document.createElement('button')
    go.className = 'banner-restore'
    go.textContent = 'Продолжить'
    go.addEventListener('click', () => this.onRestore())
    const close = document.createElement('button')
    close.className = 'banner-close'
    close.textContent = '×'
    close.title = 'Скрыть'
    close.addEventListener('click', () => {
      this.dismissed = true
      this.update(null)
    })
    this.root.replaceChildren(text, go, close)
    this.root.hidden = false
  }
}
```

- [ ] **Step 4: Запустить unit-тесты — проходят**

Run: `npx vitest run tests/unit/session-store.test.ts tests/unit/restore-banner.test.ts`
Expected: PASS.

- [ ] **Step 5: Подключить в main (`src/main/index.ts`)**

5a. Импорты: в существующий импорт из `'../shared/ipc'` добавить `type RestoreInfo`; добавить `import { SessionStore } from './session-store'`.

5b. В `bootstrap()` сразу после строки `const claudeFiles = writeClaudeTabFiles(...)` добавить:
```ts
  const sessions = new SessionStore(dataDir, { onError: (m) => log.warn(m) })
  let previous = sessions.rotateOnStartup()
  const restoreInfo = (): RestoreInfo | null =>
    previous ? { tabs: previous.tabs.length, claudeTabs: previous.tabs.filter((t) => t.kind === 'claude').length, savedAt: previous.savedAt } : null
```

5c. В объект опций `new TabManager({...})` добавить свойство:
```ts
    onStateChanged: () => sessions.scheduleSave(tabs.snapshot()),
```

5d. После функции `openFromLaunch` добавить:
```ts
  const runRestore = (): void => {
    const snap = previous
    if (!snap) return
    previous = null
    sessions.clearPrevious()
    send(IPC.evRestore, null)
    let first: string | null = null
    for (const t of snap.tabs) {
      const { cwd, warning } = resolveLaunchDir(t.cwd, homedir(), isDirectory)
      if (warning) toast(warning)
      const opened = openTab(
        { kind: t.kind, cwd, profile: t.kind === 'shell' ? t.profile : null, title: t.title, resumeSessionId: t.kind === 'claude' ? t.claudeSessionId : null },
        false
      )
      if (opened && first === null) first = opened.id
    }
    if (first) tabs.activate(first)
  }
```

5e. Рядом с остальными IPC-обработчиками добавить:
```ts
  ipcMain.handle(IPC.restoreGet, () => restoreInfo())
  ipcMain.on(IPC.restoreRun, () => runRestore())
```

5f. Сразу после строки `trackWindowState(win, windowStatePath)` добавить:
```ts
  win.on('close', () => sessions.flush())
```

5g. В обработчике `app.on('before-quit', ...)` первой строкой (до `tabs.disposeAll()`) добавить:
```ts
    sessions.flush()
```

- [ ] **Step 6: Подключить в renderer (`src/renderer/main.ts`)**

6a. Импорты: `import { RestoreBanner } from './restore-banner'`; в импорт из `'../shared/ipc'` добавить `type RestoreInfo`.

6b. После `let toggleImagePanel = ...` добавить:
```ts
let restoreInfo: RestoreInfo | null = null
let banner: RestoreBanner
```

6c. В `newTabMenu` после пункта `{ label: 'Claude Code', ... }` (внутри массива `items`) добавить:
```ts
      ...(restoreInfo ? [{ label: `Продолжить предыдущие сессии (${restoreInfo.tabs})`, action: () => ct.runRestore() }] : [])
```

6d. В `boot()` перед строкой `if (appInfo.test) {` добавить:
```ts
  banner = new RestoreBanner(document.getElementById('banner')!, () => ct.runRestore())
  restoreInfo = await ct.getRestoreInfo()
  banner.update(restoreInfo)
  ct.onRestore((info) => {
    restoreInfo = info
    banner.update(info)
  })
```

6e. В объект `window.__ct = {...}` добавить:
```ts
      restoreVisible: () => !document.getElementById('banner')!.hidden,
```

- [ ] **Step 7: Стили полосы — дописать в `styles.css`**

```css
#banner { display: flex; align-items: center; gap: 10px; padding: 6px 12px; background: #2a211d; border-bottom: 1px solid var(--accent); }
#banner span { flex: 1; }
#banner button { background: var(--accent); color: #111; border: 0; border-radius: 4px; padding: 4px 12px; cursor: pointer; font: inherit; }
#banner .banner-close { background: none; color: var(--muted); padding: 0 6px; font-size: 16px; }
```

- [ ] **Step 8: E2E**

`tests/e2e/restore.spec.ts`:
```ts
import { expect, test, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bufferText, FAKE_CLAUDE_SETTINGS, launchApp, makeDataDir } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

async function closeWindow(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close() }).catch(() => {})
  await closed
}

function snapshotFile(cwd: string): string {
  return JSON.stringify({ version: 1, savedAt: new Date().toISOString(), tabs: [{ kind: 'claude', profile: 'Windows PowerShell', cwd, title: 'mine', claudeSessionId: SID }] })
}

test('restores a claude tab with --resume and its title', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  writeFileSync(join(dataDir, 'session-state.json'), snapshotFile(work))
  const { app, page } = await launchApp({ dataDir })
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  await page.locator('.banner-restore').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  const id = await page.evaluate(() => window.__ct!.activeTabId())
  await expect.poll(() => bufferText(page, id!), { timeout: 15_000 }).toContain(`--resume ${SID}`)
  expect(await page.evaluate((i) => window.__ct!.tabTitle(i), id!)).toBe('mine')
  expect(await page.evaluate(() => window.__ct!.restoreVisible!())).toBe(false)
  expect(existsSync(join(dataDir, 'previous-session.json'))).toBe(false)
  await app.close()
})

test('closing the window keeps open tabs in the snapshot', async () => {
  const { app, page, dataDir } = await launchApp({ settings: FAKE_CLAUDE_SETTINGS })
  await page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  await page.locator('.tab-new').click()
  await page.waitForFunction(() => window.__ct!.tabIds().length === 2)
  await closeWindow(app)
  const saved = JSON.parse(readFileSync(join(dataDir, 'session-state.json'), 'utf8')) as { tabs: unknown[] }
  expect(saved.tabs).toHaveLength(2)
})

test('a run that ends with no tabs does not wipe the previous session', async () => {
  const dataDir = makeDataDir(FAKE_CLAUDE_SETTINGS)
  writeFileSync(join(dataDir, 'previous-session.json'), snapshotFile('D:\\'))
  const { app, page } = await launchApp({ dataDir })
  await expect.poll(() => page.evaluate(() => window.__ct!.restoreVisible!())).toBe(true)
  const closed = app.waitForEvent('close')
  await page.locator('.tab .tab-close').click()
  await closed
  expect(existsSync(join(dataDir, 'previous-session.json'))).toBe(true)
  const state = JSON.parse(readFileSync(join(dataDir, 'session-state.json'), 'utf8')) as { tabs: unknown[] }
  expect(state.tabs).toEqual([])
})
```

- [ ] **Step 9: Прогнать**

Run: `npm run typecheck && npm test && npm run test:e2e` → PASS.

- [ ] **Step 10: Ручная проверка**

`npm run dev` → открыть две Claude-вкладки в одной папке, в каждой задать claude разные вопросы, в одной сделать `/clear` и задать ещё вопрос → закрыть окно → `npm run dev` → «Продолжить» → каждая вкладка показывает свой разговор (после `/clear` — разговор после очистки). Записать результат в отчёт.

- [ ] **Step 11: Checkpoint**

Не коммитить.

---

### Task 12: ImageHub — ленты картинок по вкладкам

**Files:**
- Create: `src/main/image-hub.ts`
- Test: `tests/unit/image-hub.test.ts`

**Interfaces:**
- Consumes: `ImageCard`, `ImageSource` (types.ts).
- Produces: `normalizeKey(p)`, `cardId(tabId, path): string` (20 hex-символов, нижний регистр — используется как host в `ctimg://`), `relPathOf(cwd, p)`, `interface ImageHubOptions { maxItems(): number; onChange(tabId): void; now?(): number }`, `class ImageHub` с методами `addTab(tabId, cwd)`, `removeTab(tabId)`, `hasTab(tabId)`, `setNotice(tabId, notice | null)`, `add(tabId, path, source, caption, at?: number): ImageCard | null`, `markDeleted(tabId, path)`, `remove(cardId): ImageCard | null`, `get(cardId): ImageCard | null`, `list(tabId): ImageCard[]` (новые сверху), `unseenCount(tabId)`, `notice(tabId)`, `markSeen(tabId)`, `resolveTarget(tabId | null, activeTabId | null): string | null`.

Правило источника при повторном добавлении того же пути: побеждает более «явный» источник — ранг `created`=0, `read`/`tool`/`pasted`=1, `shown`=2; при равенстве — новый.

- [ ] **Step 1: Написать падающий тест**

`tests/unit/image-hub.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { cardId, ImageHub, relPathOf } from '../../src/main/image-hub'

function hub(maxItems = 200) {
  const onChange = vi.fn()
  let t = 1000
  return { h: new ImageHub({ maxItems: () => maxItems, onChange, now: () => ++t }), onChange }
}

describe('ImageHub', () => {
  it('adds new cards on top with relative paths', () => {
    const { h, onChange } = hub()
    h.addTab('t1', 'D:\\proj')
    h.add('t1', 'D:\\proj\\out\\a.png', 'created', null)
    h.add('t1', 'C:\\Temp\\b.png', 'tool', 'chrome')
    const list = h.list('t1')
    expect(list.map((c) => [c.name, c.relPath, c.source, c.caption])).toEqual([
      ['b.png', 'C:\\Temp\\b.png', 'tool', 'chrome'],
      ['a.png', 'out\\a.png', 'created', null]
    ])
    expect(list[0].id).toMatch(/^[0-9a-f]{20}$/)
    expect(onChange).toHaveBeenCalledWith('t1')
    expect(h.unseenCount('t1')).toBe(2)
  })

  it('re-adding a known path updates the card instead of duplicating it (case-insensitive)', () => {
    const { h } = hub()
    h.addTab('t1', 'D:\\proj')
    h.add('t1', 'D:\\proj\\plot.png', 'created', null)
    h.add('t1', 'D:\\proj\\other.png', 'created', null)
    h.add('t1', 'd:\\PROJ\\plot.png', 'created', null)
    const list = h.list('t1')
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ name: 'plot.png', version: 2, updated: true })
  })

  it('a more explicit source wins and show_image sets the caption', () => {
    const { h } = hub()
    h.addTab('t1', 'D:\\proj')
    h.add('t1', 'D:\\proj\\plot.png', 'created', null)
    h.add('t1', 'D:\\proj\\plot.png', 'shown', 'Revenue chart')
    h.add('t1', 'D:\\proj\\plot.png', 'created', null)
    expect(h.list('t1')[0]).toMatchObject({ source: 'shown', caption: 'Revenue chart' })
  })

  it('keeps an explicit timestamp for history images', () => {
    const { h } = hub()
    h.addTab('t1', 'D:\\proj')
    h.add('t1', 'D:\\proj\\a.png', 'read', null, 42)
    expect(h.list('t1')[0].touchedAt).toBe(42)
  })

  it('marks deleted files and removes cards', () => {
    const { h } = hub()
    h.addTab('t1', 'D:\\proj')
    const c = h.add('t1', 'D:\\proj\\a.png', 'created', null)!
    h.markDeleted('t1', 'D:\\proj\\a.png')
    expect(h.list('t1')[0].deleted).toBe(true)
    expect(h.remove(c.id)?.path).toBe('D:\\proj\\a.png')
    expect(h.list('t1')).toEqual([])
    expect(h.get(c.id)).toBeNull()
  })

  it('trims to maxItems, dropping the oldest', () => {
    const { h } = hub(2)
    h.addTab('t1', 'D:\\p')
    for (const n of ['1', '2', '3']) h.add('t1', `D:\\p\\${n}.png`, 'created', null)
    expect(h.list('t1').map((c) => c.name)).toEqual(['3.png', '2.png'])
    expect(h.unseenCount('t1')).toBe(2)
  })

  it('markSeen clears the unseen counter once', () => {
    const { h, onChange } = hub()
    h.addTab('t1', 'D:\\p')
    h.add('t1', 'D:\\p\\a.png', 'created', null)
    onChange.mockClear()
    h.markSeen('t1')
    h.markSeen('t1')
    expect(h.unseenCount('t1')).toBe(0)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('the same path in two tabs gives two independent cards', () => {
    const { h } = hub()
    h.addTab('t1', 'D:\\same')
    h.addTab('t2', 'D:\\same')
    const a = h.add('t1', 'D:\\same\\x.png', 'shown', 'from t1')!
    const b = h.add('t2', 'D:\\same\\x.png', 'shown', 'from t2')!
    expect(a.id).not.toBe(b.id)
    expect(h.list('t1')[0].caption).toBe('from t1')
    expect(h.list('t2')[0].caption).toBe('from t2')
  })

  it('resolveTarget: known tab, else the active tab, else null', () => {
    const { h } = hub()
    h.addTab('t1', 'D:\\p')
    h.addTab('t2', 'D:\\p')
    expect(h.resolveTarget('t2', 't1')).toBe('t2')
    expect(h.resolveTarget('unknown', 't1')).toBe('t1')
    expect(h.resolveTarget(null, 't1')).toBe('t1')
    expect(h.resolveTarget(null, null)).toBeNull()
    expect(h.add('nope', 'D:\\a.png', 'created', null)).toBeNull()
  })

  it('notices and tab removal', () => {
    const { h } = hub()
    h.addTab('t1', 'D:\\p')
    h.setNotice('t1', 'watch off')
    expect(h.notice('t1')).toBe('watch off')
    h.removeTab('t1')
    expect(h.hasTab('t1')).toBe(false)
    expect(h.list('t1')).toEqual([])
  })
})

describe('helpers', () => {
  it('cardId depends on tab and normalized path', () => {
    expect(cardId('t1', 'D:\\a.png')).toBe(cardId('t1', 'd:\\A.PNG'))
    expect(cardId('t1', 'D:\\a.png')).not.toBe(cardId('t2', 'D:\\a.png'))
  })

  it('relPathOf only shortens paths inside cwd', () => {
    expect(relPathOf('D:\\proj', 'D:\\proj\\out\\a.png')).toBe('out\\a.png')
    expect(relPathOf('D:\\proj', 'D:\\other\\a.png')).toBe('D:\\other\\a.png')
    expect(relPathOf('D:\\proj', 'C:\\a.png')).toBe('C:\\a.png')
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run tests/unit/image-hub.test.ts`
Expected: FAIL (модуль не найден).

- [ ] **Step 3: Реализовать `src/main/image-hub.ts`**

```ts
import { createHash } from 'node:crypto'
import { basename, isAbsolute, normalize, relative } from 'node:path'
import type { ImageCard, ImageSource } from '../shared/types'

export interface ImageHubOptions {
  maxItems(): number
  onChange(tabId: string): void
  now?(): number
}

interface Feed {
  cwd: string
  cards: ImageCard[]
  unseen: Set<string>
  notice: string | null
}

const SOURCE_RANK: Record<ImageSource, number> = { created: 0, read: 1, tool: 1, pasted: 1, shown: 2 }

export function normalizeKey(p: string): string {
  return normalize(p).toLowerCase()
}

export function cardId(tabId: string, path: string): string {
  return createHash('sha1').update(`${tabId}\0${normalizeKey(path)}`).digest('hex').slice(0, 20)
}

export function relPathOf(cwd: string, p: string): string {
  const r = relative(cwd, p)
  return r && !r.startsWith('..') && !isAbsolute(r) ? r : p
}

export class ImageHub {
  private readonly feeds = new Map<string, Feed>()

  constructor(private readonly o: ImageHubOptions) {}

  addTab(tabId: string, cwd: string): void {
    if (!this.feeds.has(tabId)) this.feeds.set(tabId, { cwd, cards: [], unseen: new Set(), notice: null })
  }

  removeTab(tabId: string): void {
    this.feeds.delete(tabId)
  }

  hasTab(tabId: string): boolean {
    return this.feeds.has(tabId)
  }

  setNotice(tabId: string, notice: string | null): void {
    const f = this.feeds.get(tabId)
    if (!f || f.notice === notice) return
    f.notice = notice
    this.o.onChange(tabId)
  }

  add(tabId: string, path: string, source: ImageSource, caption: string | null, at?: number): ImageCard | null {
    const f = this.feeds.get(tabId)
    if (!f) return null
    const id = cardId(tabId, path)
    const touchedAt = at ?? this.o.now?.() ?? Date.now()
    const idx = f.cards.findIndex((c) => c.id === id)
    let card: ImageCard
    if (idx >= 0) {
      const prev = f.cards[idx]
      f.cards.splice(idx, 1)
      card = {
        ...prev,
        version: prev.version + 1,
        updated: true,
        deleted: false,
        touchedAt,
        caption: caption ?? prev.caption,
        source: SOURCE_RANK[source] >= SOURCE_RANK[prev.source] ? source : prev.source
      }
    } else {
      card = { id, tabId, path, name: basename(path), relPath: relPathOf(f.cwd, path), source, caption, touchedAt, version: 1, updated: false, deleted: false }
    }
    f.cards.unshift(card)
    f.unseen.add(id)
    const max = Math.max(1, this.o.maxItems())
    while (f.cards.length > max) {
      const dropped = f.cards.pop()
      if (dropped) f.unseen.delete(dropped.id)
    }
    this.o.onChange(tabId)
    return { ...card }
  }

  markDeleted(tabId: string, path: string): void {
    const f = this.feeds.get(tabId)
    const c = f?.cards.find((x) => x.id === cardId(tabId, path))
    if (!c || c.deleted) return
    c.deleted = true
    this.o.onChange(tabId)
  }

  remove(id: string): ImageCard | null {
    for (const [tabId, f] of this.feeds) {
      const i = f.cards.findIndex((c) => c.id === id)
      if (i < 0) continue
      const [c] = f.cards.splice(i, 1)
      f.unseen.delete(id)
      this.o.onChange(tabId)
      return c
    }
    return null
  }

  get(id: string): ImageCard | null {
    for (const f of this.feeds.values()) {
      const c = f.cards.find((x) => x.id === id)
      if (c) return { ...c }
    }
    return null
  }

  list(tabId: string): ImageCard[] {
    return this.feeds.get(tabId)?.cards.map((c) => ({ ...c })) ?? []
  }

  unseenCount(tabId: string): number {
    return this.feeds.get(tabId)?.unseen.size ?? 0
  }

  notice(tabId: string): string | null {
    return this.feeds.get(tabId)?.notice ?? null
  }

  markSeen(tabId: string): void {
    const f = this.feeds.get(tabId)
    if (!f || f.unseen.size === 0) return
    f.unseen.clear()
    this.o.onChange(tabId)
  }

  resolveTarget(tabId: string | null, activeTabId: string | null): string | null {
    if (tabId && this.feeds.has(tabId)) return tabId
    if (activeTabId && this.feeds.has(activeTabId)) return activeTabId
    return null
  }
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `npx vitest run tests/unit/image-hub.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `npm test && npm run typecheck` → PASS. Не коммитить.

---

### Task 13: ImageWatcher — слежение за папкой вкладки и temp-папкой сессии

**Files:**
- Create: `src/main/image-watcher.ts`
- Test: `tests/unit/image-watcher.test.ts`, `tests/integration/image-watcher.int.test.ts`

**Interfaces:**
- Consumes: chokidar ^4.
- Produces: `interface WatchConfig { extensions: string[]; ignore: string[]; maxDepth: number }`, `interface WatchHandlers { added(p); changed(p); removed(p); error(err: Error) }`, `interface ImageWatcherHandle { ready: Promise<void>; close(): Promise<void> }`, `shouldWatchDir(dir, home): boolean`, `makeIgnored(root, cfg): (path: string, stats?: Stats) => boolean`, `watchImages(dir, cfg, handlers): ImageWatcherHandle`, `sessionTempDir(transcriptPath, sessionId, tmpRoot): string`.

- [ ] **Step 1: Написать падающие тесты**

`tests/unit/image-watcher.test.ts`:
```ts
import type { Stats } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { makeIgnored, sessionTempDir, shouldWatchDir } from '../../src/main/image-watcher'

const file = { isFile: () => true } as Stats
const dir = { isFile: () => false } as Stats
const cfg = { extensions: ['png', 'jpg'], ignore: ['.git', 'node_modules', 'Intermediate'], maxDepth: 8 }

describe('shouldWatchDir', () => {
  it('refuses drive roots and the home folder', () => {
    expect(shouldWatchDir('D:\\', 'C:\\Users\\me')).toBe(false)
    expect(shouldWatchDir('D:', 'C:\\Users\\me')).toBe(false)
    expect(shouldWatchDir('C:\\Users\\me', 'C:\\Users\\me')).toBe(false)
    expect(shouldWatchDir('c:\\users\\ME\\', 'C:\\Users\\me')).toBe(false)
  })

  it('accepts project folders', () => {
    expect(shouldWatchDir('D:\\Workspace\\LocHub', 'C:\\Users\\me')).toBe(true)
    expect(shouldWatchDir('C:\\Users\\me\\proj', 'C:\\Users\\me')).toBe(true)
  })
})

describe('makeIgnored', () => {
  const ignored = makeIgnored('D:\\proj', cfg)

  it('never ignores the root', () => {
    expect(ignored('D:\\proj', dir)).toBe(false)
  })

  it('ignores listed segments case-insensitively at any depth', () => {
    expect(ignored('D:\\proj\\node_modules', dir)).toBe(true)
    expect(ignored('D:\\proj\\Plugins\\X\\intermediate\\a.png', file)).toBe(true)
    expect(ignored('D:\\proj\\.git\\x', undefined)).toBe(true)
  })

  it('ignores non-image files only when stats say it is a file', () => {
    expect(ignored('D:\\proj\\notes.txt', file)).toBe(true)
    expect(ignored('D:\\proj\\shot.PNG', file)).toBe(false)
    expect(ignored('D:\\proj\\folder.v2', dir)).toBe(false)
    expect(ignored('D:\\proj\\notes.txt', undefined)).toBe(false)
  })
})

describe('sessionTempDir', () => {
  it('mirrors Claude Code temp layout: %TEMP%\\claude\\<project key>\\<session id>', () => {
    expect(sessionTempDir('C:\\Users\\me\\.claude\\projects\\D--Workspace\\5d2c.jsonl', '5d2c', 'C:\\Users\\me\\AppData\\Local\\Temp'))
      .toBe('C:\\Users\\me\\AppData\\Local\\Temp\\claude\\D--Workspace\\5d2c')
  })
})
```

`tests/integration/image-watcher.int.test.ts`:
```ts
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchImages, type ImageWatcherHandle } from '../../src/main/image-watcher'

const cfg = { extensions: ['png'], ignore: ['node_modules'], maxDepth: 8 }
let handle: ImageWatcherHandle | null = null
afterEach(async () => {
  await handle?.close()
  handle = null
})

describe('watchImages', () => {
  it('reports added, changed and removed images and skips ignored ones', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-watch-'))
    mkdirSync(join(root, 'node_modules'))
    mkdirSync(join(root, 'out'))
    const events: string[] = []
    handle = watchImages(root, cfg, {
      added: (p) => events.push(`add:${p}`),
      changed: (p) => events.push(`change:${p}`),
      removed: (p) => events.push(`unlink:${p}`),
      error: (e) => events.push(`error:${e.message}`)
    })
    await handle.ready
    const png = join(root, 'out', 'plot.png')
    writeFileSync(png, 'v1')
    writeFileSync(join(root, 'node_modules', 'x.png'), 'x')
    writeFileSync(join(root, 'notes.txt'), 'x')
    await vi.waitFor(() => expect(events).toContain(`add:${png}`), { timeout: 5000 })
    writeFileSync(png, 'v2-longer')
    await vi.waitFor(() => expect(events).toContain(`change:${png}`), { timeout: 5000 })
    unlinkSync(png)
    await vi.waitFor(() => expect(events).toContain(`unlink:${png}`), { timeout: 5000 })
    expect(events.filter((e) => e.includes('node_modules') || e.includes('notes.txt'))).toEqual([])
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падают**

Run: `npx vitest run tests/unit/image-watcher.test.ts tests/integration/image-watcher.int.test.ts`
Expected: FAIL (модуль не найден).

- [ ] **Step 3: Реализовать `src/main/image-watcher.ts`**

```ts
import { watch } from 'chokidar'
import type { Stats } from 'node:fs'
import { basename, dirname, extname, join, parse, relative, resolve } from 'node:path'

export interface WatchConfig {
  extensions: string[]
  ignore: string[]
  maxDepth: number
}

export interface WatchHandlers {
  added(path: string): void
  changed(path: string): void
  removed(path: string): void
  error(err: Error): void
}

export interface ImageWatcherHandle {
  ready: Promise<void>
  close(): Promise<void>
}

// path.resolve('D:') returns the current directory of drive D, so a bare drive is completed to its root first
const full = (p: string): string => resolve(/^[A-Za-z]:$/.test(p) ? `${p}\\` : p)
const canon = (p: string): string => full(p).replace(/[\\/]+$/, '').toLowerCase()

export function shouldWatchDir(dir: string, home: string): boolean {
  const d = canon(dir)
  const root = parse(full(dir)).root.replace(/[\\/]+$/, '').toLowerCase()
  return d !== root && d !== canon(home)
}

export function makeIgnored(root: string, cfg: WatchConfig): (path: string, stats?: Stats) => boolean {
  const ignore = new Set(cfg.ignore.map((s) => s.toLowerCase()))
  const exts = new Set(cfg.extensions.map((e) => e.toLowerCase().replace(/^\./, '')))
  return (p, stats) => {
    const rel = relative(root, p)
    if (rel === '') return false
    if (rel.split(/[\\/]/).some((seg) => ignore.has(seg.toLowerCase()))) return true
    if (stats?.isFile()) return !exts.has(extname(p).slice(1).toLowerCase())
    return false
  }
}

export function sessionTempDir(transcriptPath: string, sessionId: string, tmpRoot: string): string {
  return join(tmpRoot, 'claude', basename(dirname(transcriptPath)), sessionId)
}

export function watchImages(dir: string, cfg: WatchConfig, h: WatchHandlers): ImageWatcherHandle {
  const exts = new Set(cfg.extensions.map((e) => e.toLowerCase().replace(/^\./, '')))
  const isImage = (p: string): boolean => exts.has(extname(p).slice(1).toLowerCase())
  const w = watch(dir, {
    ignoreInitial: true,
    depth: cfg.maxDepth,
    ignored: makeIgnored(dir, cfg),
    ignorePermissionErrors: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
  })
  const ready = new Promise<void>((r) => w.once('ready', () => r()))
  w.on('add', (p) => { if (isImage(p)) h.added(p) })
  w.on('change', (p) => { if (isImage(p)) h.changed(p) })
  w.on('unlink', (p) => { if (isImage(p)) h.removed(p) })
  w.on('error', (e) => h.error(e instanceof Error ? e : new Error(String(e))))
  return { ready, close: () => w.close() }
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `npx vitest run tests/unit/image-watcher.test.ts tests/integration/image-watcher.int.test.ts`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Run: `npm test && npm run typecheck` → PASS. Не коммитить.

---

### Task 14: Разбор транскрипта Claude Code → картинки

**Files:**
- Create: `src/main/transcript-images.ts`, `tests/fixtures/transcript.ts`
- Test: `tests/unit/transcript-images.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `type ExtractedKind = 'read' | 'tool' | 'pasted'`
  - `interface ExtractedImage { kind: ExtractedKind; filePath: string | null; data: string; mediaType: string; caption: string | null; timestamp: number | null }`
  - `extForMediaType(mediaType): string | null` (png/jpg/gif/webp, иначе null)
  - `toolLabel(name, input): string` (`mcp__claude-in-chrome__computer` + `{action:'screenshot'}` → `claude-in-chrome · computer (screenshot)`)
  - `class TranscriptParser(opts: { subagent: boolean }) { parseLine(line): ExtractedImage[] }` — помнит `tool_use` из предыдущих строк того же файла.
  - `tests/fixtures/transcript.ts`: `PNG_B64`, `toolUseLine(id, name, input, timestamp?)`, `toolResultLine(toolUseId, opts?)`, `pastedLine(data?)`, `textLine` — строки повторяют структуру реальных транскриптов (`message.content[]`, `tool_result.content[]`, дубль в `toolUseResult`).

Структура реальных строк (проверено на транскриптах пользователя): картинка, вставленная пользователем, — `{"type":"user","message":{"content":[{"type":"text"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"…"}}]}}`; результат тула — `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_…","content":[…,{"type":"image","source":{…}}]}]},"toolUseResult":…}`; вызов тула — `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_…","name":"Read","input":{"file_path":"…"}}]}}`. Поле `toolUseResult` может дублировать те же image-блоки — поэтому поиск идёт только по `message.content`, если оно есть.

- [ ] **Step 1: Фикстуры**

`tests/fixtures/transcript.ts`:
```ts
export const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const image = (mediaType = 'image/png', data = PNG_B64): object => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })

export function toolUseLine(id: string, name: string, input: Record<string, unknown>, timestamp = '2026-10-05T10:00:00.000Z'): string {
  return JSON.stringify({ type: 'assistant', timestamp, isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
}

export function toolResultLine(toolUseId: string, opts: { mediaType?: string; data?: string; withText?: boolean; mirror?: boolean; timestamp?: string } = {}): string {
  const content = [...(opts.withText ? [{ type: 'text', text: 'done' }] : []), image(opts.mediaType, opts.data)]
  return JSON.stringify({
    type: 'user',
    timestamp: opts.timestamp ?? '2026-10-05T10:00:01.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
    ...(opts.mirror ? { toolUseResult: content } : {})
  })
}

export function pastedLine(data = PNG_B64): string {
  return JSON.stringify({ type: 'user', timestamp: '2026-10-05T10:00:02.000Z', imagePasteIds: [1], message: { role: 'user', content: [{ type: 'text', text: 'look at this' }, image('image/png', data)] } })
}

export const textLine = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })
```

- [ ] **Step 2: Написать падающий тест**

`tests/unit/transcript-images.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { extForMediaType, toolLabel, TranscriptParser } from '../../src/main/transcript-images'
import { PNG_B64, pastedLine, textLine, toolResultLine, toolUseLine } from '../fixtures/transcript'

const SHOT = 'C:\\Users\\me\\AppData\\Local\\Temp\\claude\\D--x\\sid\\scratchpad\\shot.png'

describe('TranscriptParser', () => {
  it('Read of an image file → kind read with the file path', () => {
    const p = new TranscriptParser({ subagent: false })
    expect(p.parseLine(toolUseLine('toolu_r1', 'Read', { file_path: SHOT }))).toEqual([])
    expect(p.parseLine(toolResultLine('toolu_r1', { mirror: true }))).toEqual([
      { kind: 'read', filePath: SHOT, data: PNG_B64, mediaType: 'image/png', caption: null, timestamp: Date.parse('2026-10-05T10:00:01.000Z') }
    ])
  })

  it('MCP screenshot → kind tool with a readable caption, not duplicated by toolUseResult', () => {
    const p = new TranscriptParser({ subagent: false })
    p.parseLine(toolUseLine('toolu_s1', 'mcp__claude-in-chrome__computer', { action: 'screenshot', tabId: 1 }))
    const out = p.parseLine(toolResultLine('toolu_s1', { mediaType: 'image/jpeg', withText: true, mirror: true }))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'tool', filePath: null, mediaType: 'image/jpeg', caption: 'claude-in-chrome · computer (screenshot)' })
  })

  it('image pasted by the user → kind pasted', () => {
    const out = new TranscriptParser({ subagent: false }).parseLine(pastedLine())
    expect(out).toEqual([{ kind: 'pasted', filePath: null, data: PNG_B64, mediaType: 'image/png', caption: 'вставлено вами', timestamp: Date.parse('2026-10-05T10:00:02.000Z') }])
  })

  it('subagent transcripts get a prefix', () => {
    const p = new TranscriptParser({ subagent: true })
    p.parseLine(toolUseLine('toolu_r1', 'Read', { file_path: SHOT }))
    p.parseLine(toolUseLine('toolu_s1', 'mcp__claude-in-chrome__computer', { action: 'screenshot' }))
    expect(p.parseLine(toolResultLine('toolu_r1'))[0].caption).toBe('субагент · Read')
    expect(p.parseLine(toolResultLine('toolu_s1'))[0].caption).toBe('субагент · claude-in-chrome · computer (screenshot)')
  })

  it('tool_result without a known tool_use → kind tool without caption', () => {
    expect(new TranscriptParser({ subagent: false }).parseLine(toolResultLine('toolu_unknown'))[0]).toMatchObject({ kind: 'tool', caption: null })
  })

  it('ignores lines without images, broken JSON and non-base64 sources', () => {
    const p = new TranscriptParser({ subagent: false })
    expect(p.parseLine(textLine)).toEqual([])
    expect(p.parseLine('{"type":"user","message":')).toEqual([])
    expect(p.parseLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] } }))).toEqual([])
  })

  it('still finds images when the line has no message wrapper (format drift)', () => {
    const line = JSON.stringify({ type: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } }] })
    expect(new TranscriptParser({ subagent: false }).parseLine(line)[0]).toMatchObject({ kind: 'pasted' })
  })
})

describe('helpers', () => {
  it('extForMediaType', () => {
    expect(extForMediaType('image/png')).toBe('png')
    expect(extForMediaType('IMAGE/JPEG')).toBe('jpg')
    expect(extForMediaType('image/webp')).toBe('webp')
    expect(extForMediaType('image/svg+xml')).toBeNull()
  })

  it('toolLabel', () => {
    expect(toolLabel('mcp__plugin_playwright__browser_take_screenshot', {})).toBe('plugin_playwright · browser_take_screenshot')
    expect(toolLabel('Bash', {})).toBe('Bash')
  })
})
```

- [ ] **Step 3: Запустить — убедиться, что падает**

Run: `npx vitest run tests/unit/transcript-images.test.ts`
Expected: FAIL (модуль не найден).

- [ ] **Step 4: Реализовать `src/main/transcript-images.ts`**

```ts
export type ExtractedKind = 'read' | 'tool' | 'pasted'

export interface ExtractedImage {
  kind: ExtractedKind
  filePath: string | null
  data: string
  mediaType: string
  caption: string | null
  timestamp: number | null
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

export function extForMediaType(mediaType: string): string | null {
  return EXT[mediaType.toLowerCase()] ?? null
}

export function toolLabel(name: string, input: Obj): string {
  const base = name.startsWith('mcp__') ? name.slice(5).split('__').join(' · ') : name
  return typeof input.action === 'string' ? `${base} (${input.action})` : base
}

interface ToolUse {
  name: string
  input: Obj
}

export class TranscriptParser {
  private readonly tools = new Map<string, ToolUse>()

  constructor(private readonly opts: { subagent: boolean }) {}

  parseLine(line: string): ExtractedImage[] {
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      return []
    }
    if (!isObj(obj)) return []
    // Search conversation content only: Claude Code mirrors tool output in `toolUseResult`, which would duplicate images.
    const root: unknown = isObj(obj.message) && 'content' in obj.message ? obj.message.content : obj
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : Number.NaN
    const timestamp = Number.isNaN(ts) ? null : ts
    this.collectToolUses(root)
    const out: ExtractedImage[] = []
    this.collectImages(root, null, timestamp, out)
    return out
  }

  private collectToolUses(node: unknown): void {
    if (Array.isArray(node)) {
      for (const n of node) this.collectToolUses(n)
      return
    }
    if (!isObj(node)) return
    if (node.type === 'tool_use' && typeof node.id === 'string' && typeof node.name === 'string') {
      this.tools.set(node.id, { name: node.name, input: isObj(node.input) ? node.input : {} })
    }
    for (const v of Object.values(node)) if (typeof v === 'object' && v !== null) this.collectToolUses(v)
  }

  private collectImages(node: unknown, toolUseId: string | null, timestamp: number | null, out: ExtractedImage[]): void {
    if (Array.isArray(node)) {
      for (const n of node) this.collectImages(n, toolUseId, timestamp, out)
      return
    }
    if (!isObj(node)) return
    if (node.type === 'image' && isObj(node.source)) {
      const s = node.source
      if (s.type === 'base64' && typeof s.data === 'string' && s.data.length > 0 && typeof s.media_type === 'string') {
        out.push(this.describe(toolUseId, s.data, s.media_type, timestamp))
      }
      return
    }
    const ctx = node.type === 'tool_result' && typeof node.tool_use_id === 'string' ? node.tool_use_id : toolUseId
    for (const v of Object.values(node)) if (typeof v === 'object' && v !== null) this.collectImages(v, ctx, timestamp, out)
  }

  private describe(toolUseId: string | null, data: string, mediaType: string, timestamp: number | null): ExtractedImage {
    const sub = this.opts.subagent
    if (toolUseId === null) {
      return { kind: 'pasted', filePath: null, data, mediaType, caption: sub ? 'субагент · входная картинка' : 'вставлено вами', timestamp }
    }
    const tool = this.tools.get(toolUseId)
    if (tool?.name === 'Read' && typeof tool.input.file_path === 'string') {
      return { kind: 'read', filePath: tool.input.file_path, data, mediaType, caption: sub ? 'субагент · Read' : null, timestamp }
    }
    const label = tool ? toolLabel(tool.name, tool.input) : null
    const caption = label ? (sub ? `субагент · ${label}` : label) : sub ? 'субагент' : null
    return { kind: 'tool', filePath: null, data, mediaType, caption, timestamp }
  }
}
```

- [ ] **Step 5: Запустить — проходит**

Run: `npx vitest run tests/unit/transcript-images.test.ts`
Expected: PASS.

- [ ] **Step 6: Checkpoint**

Run: `npm test && npm run typecheck` → PASS. Не коммитить.

---

### Task 15: TranscriptFeed — чтение транскрипта и субагентов, кэш картинок

**Files:**
- Create: `src/main/transcript-feed.ts`
- Test: `tests/integration/transcript-feed.int.test.ts`

**Interfaces:**
- Consumes: `TranscriptParser`, `extForMediaType`, `ExtractedImage`, `ExtractedKind` (Task 14); фикстуры `tests/fixtures/transcript.ts`.
- Produces:
  - `class LineTailer(file) { readNew(): Promise<string[] | null> }` — новые полные строки с прошлого вызова; `null`, если файл не открывается; корректно склеивает строку, дописанную в несколько приёмов, и многобайтовые UTF-8 символы на границе чтения.
  - `interface FeedImage { path: string; source: ExtractedKind; caption: string | null; at: number | null }`
  - `interface TranscriptFeedOptions { transcriptPath; sessionId; cacheRoot; fileExists(p): boolean; onImage(img: FeedImage): void; onError?(m): void; pollMs?: number; subagentScanMs?: number }`
  - `class TranscriptFeed(opts)`: `subagentDir` (`<dirname(transcript)>/<sessionId>/subagents`), `start()`, `stop()`, `scanSubagents()`, `poll(): Promise<void>`.
  - `cleanupImageCache(cacheRoot, maxAgeMs, now?)`.

- [ ] **Step 1: Написать падающий тест**

`tests/integration/transcript-feed.int.test.ts`:
```ts
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanupImageCache, LineTailer, TranscriptFeed, type FeedImage } from '../../src/main/transcript-feed'
import { PNG_B64, pastedLine, textLine, toolResultLine, toolUseLine } from '../fixtures/transcript'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ct-feed-'))
  const projectDir = join(root, 'projects', 'D--x')
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${SID}.jsonl`)
  const cacheRoot = join(root, 'cache')
  const images: FeedImage[] = []
  const errors: string[] = []
  const feed = new TranscriptFeed({ transcriptPath, sessionId: SID, cacheRoot, fileExists: existsSync, onImage: (i) => images.push(i), onError: (m) => errors.push(m) })
  return { root, projectDir, transcriptPath, cacheRoot, images, errors, feed }
}

describe('LineTailer', () => {
  it('returns only complete lines and joins a line written in two parts', async () => {
    const { transcriptPath } = setup()
    const t = new LineTailer(transcriptPath)
    expect(await t.readNew()).toBeNull()
    writeFileSync(transcriptPath, 'first\nsec')
    expect(await t.readNew()).toEqual(['first'])
    appendFileSync(transcriptPath, 'ond\n')
    expect(await t.readNew()).toEqual(['second'])
    expect(await t.readNew()).toEqual([])
  })

  it('handles a multi-byte character split across reads', async () => {
    const { transcriptPath } = setup()
    const t = new LineTailer(transcriptPath)
    const bytes = Buffer.from('вставлено\n', 'utf8')
    writeFileSync(transcriptPath, bytes.subarray(0, 3))
    expect(await t.readNew()).toEqual([])
    appendFileSync(transcriptPath, bytes.subarray(3))
    expect(await t.readNew()).toEqual(['вставлено'])
  })
})

describe('TranscriptFeed', () => {
  it('reads history from the start and caches tool screenshots', async () => {
    const { transcriptPath, cacheRoot, images, feed } = setup()
    writeFileSync(transcriptPath, [textLine, toolUseLine('toolu_s1', 'mcp__claude-in-chrome__computer', { action: 'screenshot' }), toolResultLine('toolu_s1', { mirror: true }), ''].join('\n'))
    await feed.poll()
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({ source: 'tool', caption: 'claude-in-chrome · computer (screenshot)', at: Date.parse('2026-10-05T10:00:01.000Z') })
    expect(images[0].path.startsWith(join(cacheRoot, SID))).toBe(true)
    expect(images[0].path.endsWith('.png')).toBe(true)
    expect(readFileSync(images[0].path).equals(Buffer.from(PNG_B64, 'base64'))).toBe(true)
  })

  it('Read points at the original file when it exists, otherwise at a cached copy', async () => {
    const { root, transcriptPath, cacheRoot, images, feed } = setup()
    const shot = join(root, 'shot.png')
    writeFileSync(shot, Buffer.from(PNG_B64, 'base64'))
    writeFileSync(transcriptPath, [toolUseLine('toolu_a', 'Read', { file_path: shot }), toolResultLine('toolu_a'), toolUseLine('toolu_b', 'Read', { file_path: join(root, 'gone.png') }), toolResultLine('toolu_b', { data: Buffer.from('other').toString('base64') }), ''].join('\n'))
    await feed.poll()
    expect(images.map((i) => [i.source, i.path.startsWith(cacheRoot)])).toEqual([['read', false], ['read', true]])
    expect(images[0].path).toBe(shot)
  })

  it('processes appended lines once and dedupes identical images in the cache', async () => {
    const { transcriptPath, cacheRoot, images, feed } = setup()
    writeFileSync(transcriptPath, '')
    await feed.poll()
    appendFileSync(transcriptPath, pastedLine() + '\n')
    await feed.poll()
    await feed.poll()
    appendFileSync(transcriptPath, pastedLine() + '\n')
    await feed.poll()
    expect(images).toHaveLength(2)
    expect(images[0].path).toBe(images[1].path)
    expect(images[0]).toMatchObject({ source: 'pasted', caption: 'вставлено вами' })
    expect(readdirSync(join(cacheRoot, SID))).toHaveLength(1)
  })

  it('picks up subagent transcripts', async () => {
    const { transcriptPath, images, feed } = setup()
    writeFileSync(transcriptPath, '')
    mkdirSync(feed.subagentDir, { recursive: true })
    writeFileSync(join(feed.subagentDir, 'agent-a1.jsonl'), [toolUseLine('toolu_s9', 'mcp__claude-in-chrome__computer', { action: 'screenshot' }), toolResultLine('toolu_s9'), ''].join('\n'))
    writeFileSync(join(feed.subagentDir, 'agent-a1.meta.json'), '{}')
    feed.scanSubagents()
    await feed.poll()
    expect(images.map((i) => i.caption)).toEqual(['субагент · claude-in-chrome · computer (screenshot)'])
  })

  it('reports a missing transcript once and stops after stop()', async () => {
    const { transcriptPath, images, errors, feed } = setup()
    await feed.poll()
    await feed.poll()
    expect(errors).toHaveLength(1)
    feed.stop()
    writeFileSync(transcriptPath, pastedLine() + '\n')
    await feed.poll()
    expect(images).toEqual([])
  })
})

describe('cleanupImageCache', () => {
  it('removes session folders older than the limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'ct-cache-'))
    mkdirSync(join(root, 'old'))
    mkdirSync(join(root, 'new'))
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000)
    utimesSync(join(root, 'old'), tenDaysAgo, tenDaysAgo)
    cleanupImageCache(root, 7 * 24 * 3600 * 1000)
    expect(readdirSync(root)).toEqual(['new'])
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run tests/integration/transcript-feed.int.test.ts`
Expected: FAIL (модуль не найден).

- [ ] **Step 3: Реализовать `src/main/transcript-feed.ts`**

```ts
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { extForMediaType, TranscriptParser, type ExtractedImage, type ExtractedKind } from './transcript-images'

export class LineTailer {
  private offset = 0
  private rest = ''
  private decoder = new StringDecoder('utf8')

  constructor(readonly file: string) {}

  /** New complete lines since the previous call; null when the file cannot be opened. */
  async readNew(): Promise<string[] | null> {
    let fh
    try {
      fh = await open(this.file, 'r')
    } catch {
      return null
    }
    try {
      const { size } = await fh.stat()
      if (size < this.offset) {
        this.offset = 0
        this.rest = ''
        this.decoder = new StringDecoder('utf8')
      }
      if (size === this.offset) return []
      const buf = Buffer.alloc(size - this.offset)
      const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset)
      this.offset += bytesRead
      const parts = (this.rest + this.decoder.write(buf.subarray(0, bytesRead))).split('\n')
      this.rest = parts.pop() ?? ''
      return parts.map((l) => l.replace(/\r$/, '')).filter((l) => l.trim().length > 0)
    } finally {
      await fh.close()
    }
  }
}

export interface FeedImage {
  path: string
  source: ExtractedKind
  caption: string | null
  at: number | null
}

export interface TranscriptFeedOptions {
  transcriptPath: string
  sessionId: string
  cacheRoot: string
  fileExists(path: string): boolean
  onImage(img: FeedImage): void
  onError?(message: string): void
  pollMs?: number
  subagentScanMs?: number
}

interface Source {
  tailer: LineTailer
  parser: TranscriptParser
}

export class TranscriptFeed {
  private readonly main: Source
  private readonly subagents = new Map<string, Source>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private scanTimer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private stopped = false
  private missingReported = false

  constructor(private readonly o: TranscriptFeedOptions) {
    this.main = { tailer: new LineTailer(o.transcriptPath), parser: new TranscriptParser({ subagent: false }) }
  }

  get subagentDir(): string {
    return join(dirname(this.o.transcriptPath), this.o.sessionId, 'subagents')
  }

  start(): void {
    this.scanSubagents()
    void this.poll()
    this.pollTimer = setInterval(() => void this.poll(), this.o.pollMs ?? 500)
    this.scanTimer = setInterval(() => this.scanSubagents(), this.o.subagentScanMs ?? 2000)
  }

  stop(): void {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.scanTimer) clearInterval(this.scanTimer)
  }

  scanSubagents(): void {
    let names: string[]
    try {
      names = readdirSync(this.subagentDir)
    } catch {
      return
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl') || this.subagents.has(n)) continue
      this.subagents.set(n, { tailer: new LineTailer(join(this.subagentDir, n)), parser: new TranscriptParser({ subagent: true }) })
    }
  }

  async poll(): Promise<void> {
    if (this.busy || this.stopped) return
    this.busy = true
    try {
      const lines = await this.main.tailer.readNew()
      if (lines === null) {
        if (!this.missingReported) {
          this.missingReported = true
          this.o.onError?.(`transcript not readable yet: ${this.o.transcriptPath}`)
        }
      } else {
        this.consume(this.main, lines)
      }
      for (const s of this.subagents.values()) {
        const subLines = await s.tailer.readNew()
        if (subLines) this.consume(s, subLines)
      }
    } finally {
      this.busy = false
    }
  }

  private consume(src: Source, lines: string[]): void {
    for (const line of lines) {
      for (const img of src.parser.parseLine(line)) {
        if (this.stopped) return
        const out = this.materialize(img)
        if (out) this.o.onImage(out)
      }
    }
  }

  private materialize(img: ExtractedImage): FeedImage | null {
    if (img.kind === 'read' && img.filePath && this.o.fileExists(img.filePath)) {
      return { path: img.filePath, source: 'read', caption: img.caption, at: img.timestamp }
    }
    const ext = extForMediaType(img.mediaType)
    if (!ext) return null
    const dir = join(this.o.cacheRoot, this.o.sessionId)
    const file = join(dir, `${createHash('sha1').update(img.data).digest('hex').slice(0, 16)}.${ext}`)
    try {
      if (!existsSync(file)) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(file, Buffer.from(img.data, 'base64'))
      }
    } catch (e) {
      this.o.onError?.(`cannot cache image: ${(e as Error).message}`)
      return null
    }
    return { path: file, source: img.kind, caption: img.caption, at: img.timestamp }
  }
}

export function cleanupImageCache(cacheRoot: string, maxAgeMs: number, now = Date.now()): void {
  let entries: string[]
  try {
    entries = readdirSync(cacheRoot)
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(cacheRoot, e)
    try {
      if (now - statSync(p).mtimeMs > maxAgeMs) rmSync(p, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `npx vitest run tests/integration/transcript-feed.int.test.ts`
Expected: PASS.

- [ ] **Step 5: Проверка на настоящем транскрипте (read-only)**

Run (подставить путь к любому своему транскрипту с картинками, например из `%USERPROFILE%\.claude\projects\D--Workspace-HardWorker\`):
```powershell
npx tsx -e "import('./src/main/transcript-images.ts').then(({TranscriptParser})=>{const fs=require('fs');const p=new TranscriptParser({subagent:false});let n={};for(const l of fs.readFileSync(process.argv[1],'utf8').split('\n')){for(const i of p.parseLine(l)){n[i.kind+':'+(i.caption??'')]=(n[i.kind+':'+(i.caption??'')]||0)+1}}console.log(n)})" "<путь к .jsonl>"
```
Если `tsx` не установлен — `npx -y tsx ...`. Expected: ненулевые счётчики `read:`, `tool:claude-in-chrome · computer (screenshot)` и/или `pasted:вставлено вами`. Записать вывод в отчёт задачи. Ничего в транскрипте не менять.

- [ ] **Step 6: Checkpoint**

Run: `npm test && npm run typecheck` → PASS. Не коммитить.

---

### Task 16: Лента картинок в UI и подключение всех источников

**Files:**
- Create: `src/main/img-protocol.ts`, `src/renderer/image-url.ts`, `src/renderer/image-panel.ts`, `src/renderer/lightbox.ts`
- Modify: `src/main/index.ts`, `src/renderer/main.ts`, `src/renderer/styles.css`
- Test: `tests/e2e/images.spec.ts`

**Interfaces:**
- Consumes: `ImageHub` (Task 12), `watchImages`/`shouldWatchDir`/`sessionTempDir`/`ImageWatcherHandle` (Task 13), `TranscriptFeed`/`cleanupImageCache` (Task 15), `checkImageFile`/`DEFAULT_IMAGE_EXTENSIONS` (Task 2), `sendPipeMessage` (Task 6, в e2e), фикстуры транскрипта (Task 14), main `index.ts` из Tasks 9/11, renderer `main.ts` из Tasks 9/10/11 (`toggleImagePanel`, `activate`, `handleInput`, `boot`).
- Produces:
  - `img-protocol.ts`: `IMG_SCHEME = 'ctimg'`, `registerImgScheme()` (до `app.ready`), `handleImgProtocol(hub, extensions: () => string[])`.
  - `image-url.ts`: `imageUrl(card): string` → `ctimg://<id>/?v=<version>`.
  - `image-panel.ts`: `class ImagePanel(root, callbacks, width, autoOpen: () => boolean)` с `visible`, `toggle()`, `setCollapsed(c)`, `show(update: ImagesUpdate)`; `interface ImagePanelCallbacks { action(cardId, action); insertPath(path); open(cards, index); markSeen(tabId) }`.
  - `lightbox.ts`: `class Lightbox(root) { open(cards, index); close(); isOpen }`.

- [ ] **Step 1: Написать падающий e2e-тест**

`tests/e2e/images.spec.ts`:
```ts
import { expect, test, type Page } from '@playwright/test'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import { pastedLine, toolResultLine, toolUseLine } from '../fixtures/transcript'
import { FAKE_CLAUDE_SETTINGS, launchApp, PNG_1x1 } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const images = (page: Page): Promise<{ name: string; source: string; caption: string | null }[]> => page.evaluate(() => window.__ct!.images!())

async function claudeTab() {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const launched = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', work] })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await launched.page.evaluate(() => window.__ct!.activeTabId()))!
  return { ...launched, work, tabId }
}

test('a PNG created in the claude tab folder appears and is served via ctimg', async () => {
  const { app, page, work } = await claudeTab()
  await page.waitForTimeout(1500) // let the folder watcher become ready
  writeFileSync(join(work, 'plot.png'), PNG_1x1)
  await expect.poll(() => images(page), { timeout: 10_000 }).toEqual([{ name: 'plot.png', source: 'created', caption: null }])
  await expect(page.locator('#image-panel')).not.toHaveClass(/collapsed/)
  await expect(page.locator('.card img').first()).toHaveJSProperty('naturalWidth', 1)
  await app.close()
})

test('show_image over the pipe lands in the tab with its caption', async () => {
  const { app, page, work, tabId, pipeName } = await claudeTab()
  const file = join(work, 'chart.png')
  writeFileSync(file, PNG_1x1)
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'show_image', tabId, path: file, caption: 'Revenue' })).toEqual({ ok: true })
  await expect.poll(() => images(page), { timeout: 10_000 }).toEqual([{ name: 'chart.png', source: 'shown', caption: 'Revenue' }])
  await app.close()
})

test('images from the session transcript appear, including lines appended later', async () => {
  const { app, page, tabId, pipeName } = await claudeTab()
  const projectDir = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'projects', 'D--e2e')
  mkdirSync(projectDir, { recursive: true })
  const transcriptPath = join(projectDir, `${SID}.jsonl`)
  writeFileSync(transcriptPath, [toolUseLine('toolu_s1', 'mcp__claude-in-chrome__computer', { action: 'screenshot' }), toolResultLine('toolu_s1'), ''].join('\n'))
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: SID, source: 'startup', transcriptPath })).toEqual({ ok: true })
  await expect.poll(() => images(page), { timeout: 10_000 }).toEqual([{ name: expect.stringMatching(/\.png$/), source: 'tool', caption: 'claude-in-chrome · computer (screenshot)' }])
  appendFileSync(transcriptPath, pastedLine(Buffer.from('second image').toString('base64')) + '\n')
  await expect.poll(async () => (await images(page)).map((i) => i.source), { timeout: 10_000 }).toEqual(['pasted', 'tool'])
  await app.close()
})
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npm run test:e2e -- images.spec.ts`
Expected: FAIL (`window.__ct.images` не определён / пайп отвечает `image panel is not available`).

- [ ] **Step 3: Протокол `ctimg://` — `src/main/img-protocol.ts`**

```ts
import { net, protocol } from 'electron'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { hasImageExtension } from '../shared/image-file'
import type { ImageHub } from './image-hub'

export const IMG_SCHEME = 'ctimg'

export function registerImgScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: IMG_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
}

export function handleImgProtocol(hub: ImageHub, extensions: () => string[]): void {
  protocol.handle(IMG_SCHEME, async (req) => {
    const card = hub.get(new URL(req.url).hostname)
    if (!card || !hasImageExtension(card.path, extensions()) || !existsSync(card.path)) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(card.path).toString())
  })
}
```

- [ ] **Step 4: Подключить источники в main (`src/main/index.ts`)**

4a. Импорты: в импорт из `'electron'` добавить `nativeImage`; импорт `node:fs` заменить на `import { existsSync, mkdirSync, statSync, watch } from 'node:fs'`; импорт `node:os` — на `import { homedir, release, tmpdir } from 'node:os'`; в импорт из `'../shared/ipc'` добавить `type ImageAction, type ImagesUpdate`. Добавить:
```ts
import { checkImageFile, DEFAULT_IMAGE_EXTENSIONS } from '../shared/image-file'
import { ImageHub } from './image-hub'
import { sessionTempDir, shouldWatchDir, watchImages, type ImageWatcherHandle } from './image-watcher'
import { handleImgProtocol, registerImgScheme } from './img-protocol'
import { cleanupImageCache, TranscriptFeed } from './transcript-feed'
```

4b. Сразу после строки `const isTest = process.env.CLAUDETERM_TEST === '1'` (уровень модуля, до `requestSingleInstanceLock`) добавить:
```ts
registerImgScheme()
```

4c. В `bootstrap()` **непосредственно перед** строкой `const tabs = new TabManager({` вставить:
```ts
  const imageCacheRoot = join(tmpdir(), 'ClaudeTerm', 'images')
  cleanupImageCache(imageCacheRoot, 7 * 24 * 60 * 60 * 1000)
  const imageTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const images = new ImageHub({
    maxItems: () => settings.imagePanel.maxItems,
    // coalesce bursts (e.g. transcript history on --resume) into one update per tab
    onChange: (tabId) => {
      if (imageTimers.has(tabId)) return
      imageTimers.set(tabId, setTimeout(() => {
        imageTimers.delete(tabId)
        send(IPC.evImages, imagesUpdate(tabId))
      }, 50))
    }
  })
  const imagesUpdate = (tabId: string): ImagesUpdate => ({ tabId, cards: images.list(tabId), unseen: images.unseenCount(tabId), notice: images.notice(tabId) })

  interface TabImageSources {
    cwdWatcher: ImageWatcherHandle | null
    tempWatcher: ImageWatcherHandle | null
    feed: TranscriptFeed | null
    transcriptPath: string | null
  }
  const sources = new Map<string, TabImageSources>()

  const watchDir = (tabId: string, dir: string, which: 'cwdWatcher' | 'tempWatcher'): ImageWatcherHandle =>
    watchImages(dir, settings.imageWatch, {
      added: (p) => images.add(tabId, p, 'created', null),
      changed: (p) => images.add(tabId, p, 'created', null),
      removed: (p) => images.markDeleted(tabId, p),
      error: (err) => {
        log.warn(`watcher ${dir}: ${err.message}`)
        const s = sources.get(tabId)
        if (s) {
          void s[which]?.close()
          s[which] = null
        }
        images.setNotice(tabId, `Авто-слежение остановлено: ${err.message}`)
      }
    })

  const startTabImages = (tab: TabInfo): void => {
    images.addTab(tab.id, tab.cwd)
    const s: TabImageSources = { cwdWatcher: null, tempWatcher: null, feed: null, transcriptPath: null }
    sources.set(tab.id, s)
    if (tab.kind !== 'claude' || !settings.imageWatch.enabled) return
    if (shouldWatchDir(tab.cwd, homedir())) s.cwdWatcher = watchDir(tab.id, tab.cwd, 'cwdWatcher')
    else images.setNotice(tab.id, 'Авто-слежение выключено для этой папки')
  }

  const stopTabImages = (tabId: string): void => {
    const s = sources.get(tabId)
    if (s) {
      void s.cwdWatcher?.close()
      void s.tempWatcher?.close()
      s.feed?.stop()
    }
    sources.delete(tabId)
    images.removeTab(tabId)
  }

  const attachTranscript = (tabId: string, sessionId: string, transcriptPath: string): void => {
    const s = sources.get(tabId)
    if (!s || s.transcriptPath?.toLowerCase() === transcriptPath.toLowerCase()) return
    s.feed?.stop()
    void s.tempWatcher?.close()
    s.tempWatcher = null
    s.transcriptPath = transcriptPath
    s.feed = new TranscriptFeed({
      transcriptPath,
      sessionId,
      cacheRoot: imageCacheRoot,
      fileExists: existsSync,
      onImage: (img) => images.add(tabId, img.path, img.source, img.caption, img.at ?? undefined),
      onError: (m) => log.warn(m)
    })
    s.feed.start()
    if (!settings.imageWatch.enabled) return
    const temp = sessionTempDir(transcriptPath, sessionId, tmpdir())
    try {
      mkdirSync(temp, { recursive: true })
      s.tempWatcher = watchDir(tabId, temp, 'tempWatcher')
    } catch (e) {
      log.warn(`cannot watch ${temp}: ${(e as Error).message}`)
    }
  }

  handleImgProtocol(images, () => [...DEFAULT_IMAGE_EXTENSIONS, ...settings.imageWatch.extensions])
```

4d. В объект опций `new TabManager({...})` добавить свойства:
```ts
    onTabStarted: startTabImages,
    onTabClosed: stopTabImages,
```

4e. В вызове `startPipeServer(pipeName, {...})` заменить оба обработчика на:
```ts
    showImage: async (msg) => {
      const check = await checkImageFile(msg.path, settings.imageWatch.extensions)
      if (!check.ok) return { ok: false, error: check.error }
      const target = images.resolveTarget(msg.tabId, tabs.activeTabId())
      if (!target) return { ok: false, error: 'no open tabs in ClaudeTerm' }
      images.add(target, msg.path, 'shown', msg.caption)
      return { ok: true }
    },
    session: (msg) => {
      log.info(`session ${msg.source} tab=${msg.tabId} id=${msg.sessionId} transcript=${msg.transcriptPath ?? '-'}`)
      if (!tabs.setClaudeSession(msg.tabId, msg.sessionId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      if (msg.transcriptPath) attachTranscript(msg.tabId, msg.sessionId, msg.transcriptPath)
      return { ok: true }
    }
```

4f. Рядом с остальными IPC-обработчиками добавить:
```ts
  ipcMain.handle(IPC.imagesList, (_e, tabId: string) => imagesUpdate(tabId))
  ipcMain.on(IPC.imagesMarkSeen, (_e, tabId: string) => images.markSeen(tabId))
  ipcMain.on(IPC.imagesAction, (_e, cardId: string, action: ImageAction) => {
    const card = images.get(cardId)
    if (!card) return
    switch (action) {
      case 'open':
        void shell.openPath(card.path)
        break
      case 'reveal':
        shell.showItemInFolder(card.path)
        break
      case 'copy-image': {
        const img = nativeImage.createFromPath(card.path)
        if (img.isEmpty()) toast(`Cannot copy this image format: ${card.path}`)
        else clipboard.writeImage(img)
        break
      }
      case 'copy-path':
        clipboard.writeText(card.path)
        break
      case 'remove':
        images.remove(cardId)
        break
    }
  })
```

4g. В `app.on('before-quit', ...)` после `sessions.flush()` добавить:
```ts
    for (const id of [...sources.keys()]) stopTabImages(id)
```

- [ ] **Step 5: Renderer-модули ленты**

`src/renderer/image-url.ts`:
```ts
import type { ImageCard } from '../shared/types'

export function imageUrl(card: ImageCard): string {
  return `ctimg://${card.id}/?v=${card.version}`
}
```

`src/renderer/image-panel.ts`:
```ts
import type { ImageAction, ImagesUpdate } from '../shared/ipc'
import type { ImageCard, ImageSource } from '../shared/types'
import { imageUrl } from './image-url'
import { showMenu } from './menu'

export interface ImagePanelCallbacks {
  action(cardId: string, action: ImageAction): void
  insertPath(path: string): void
  open(cards: ImageCard[], index: number): void
  markSeen(tabId: string): void
}

const SOURCE_LABEL: Record<ImageSource, string> = { created: 'created', shown: 'show_image', read: 'read', tool: 'tool', pasted: 'вы' }

export class ImagePanel {
  private collapsed = true
  private current: ImagesUpdate | null = null
  private readonly autoOpened = new Set<string>()
  private readonly list: HTMLElement
  private readonly noticeEl: HTMLElement

  constructor(private readonly root: HTMLElement, private readonly cb: ImagePanelCallbacks, private width: number, private readonly autoOpen: () => boolean) {
    const handle = document.createElement('div')
    handle.className = 'panel-resize'
    const header = document.createElement('div')
    header.className = 'panel-header'
    const title = document.createElement('span')
    title.textContent = 'Images'
    const hide = document.createElement('button')
    hide.textContent = '–'
    hide.title = 'Hide (Ctrl+Shift+I)'
    hide.addEventListener('click', () => this.setCollapsed(true))
    header.append(title, hide)
    this.noticeEl = document.createElement('div')
    this.noticeEl.className = 'panel-notice'
    this.list = document.createElement('div')
    this.list.className = 'panel-list'
    root.replaceChildren(handle, header, this.noticeEl, this.list)
    this.setupResize(handle)
    this.root.style.width = `${this.width}px`
    this.setCollapsed(true)
  }

  get visible(): boolean {
    return !this.collapsed
  }

  toggle(): void {
    this.setCollapsed(!this.collapsed)
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed
    this.root.classList.toggle('collapsed', collapsed)
    if (!collapsed && this.current && this.current.unseen > 0) this.cb.markSeen(this.current.tabId)
  }

  show(update: ImagesUpdate): void {
    this.current = update
    if (update.cards.length > 0 && this.collapsed && this.autoOpen() && !this.autoOpened.has(update.tabId)) {
      this.autoOpened.add(update.tabId)
      this.setCollapsed(false)
    }
    this.renderList()
    if (!this.collapsed && update.unseen > 0) this.cb.markSeen(update.tabId)
  }

  private renderList(): void {
    const u = this.current
    this.noticeEl.textContent = u?.notice ?? ''
    this.noticeEl.hidden = !u?.notice
    if (!u || u.cards.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'panel-empty'
      empty.textContent = 'No images yet'
      this.list.replaceChildren(empty)
      return
    }
    this.list.replaceChildren(...u.cards.map((card, index) => this.renderCard(card, index, u.cards)))
  }

  private renderCard(card: ImageCard, index: number, all: ImageCard[]): HTMLElement {
    const el = document.createElement('div')
    el.className = `card${card.deleted ? ' deleted' : ''}`
    el.dataset.cardId = card.id
    const img = document.createElement('img')
    img.src = imageUrl(card)
    img.alt = card.name
    img.draggable = false
    const meta = document.createElement('div')
    meta.className = 'card-meta'
    const name = document.createElement('div')
    name.className = 'card-name'
    name.textContent = card.name
    name.title = card.path
    const tags = [new Date(card.touchedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }), SOURCE_LABEL[card.source]]
    if (card.updated) tags.push('updated')
    if (card.deleted) tags.push('deleted')
    const sub = document.createElement('div')
    sub.className = 'card-sub'
    sub.textContent = `${card.relPath} · ${tags.join(' · ')}`
    meta.append(name, sub)
    if (card.caption) {
      const cap = document.createElement('div')
      cap.className = 'card-caption'
      cap.textContent = card.caption
      meta.append(cap)
    }
    el.append(img, meta)
    el.addEventListener('click', () => this.cb.open(all, index))
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      showMenu({ x: e.clientX, y: e.clientY }, [
        { label: 'Открыть в просмотрщике', action: () => this.cb.action(card.id, 'open') },
        { label: 'Показать в Explorer', action: () => this.cb.action(card.id, 'reveal') },
        { label: 'Копировать изображение', action: () => this.cb.action(card.id, 'copy-image') },
        { label: 'Копировать путь', action: () => this.cb.action(card.id, 'copy-path') },
        { label: 'Вставить путь в терминал', action: () => this.cb.insertPath(card.path) },
        { label: '', separator: true },
        { label: 'Убрать из ленты', action: () => this.cb.action(card.id, 'remove') }
      ])
    })
    return el
  }

  private setupResize(handle: HTMLElement): void {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = this.width
      const move = (ev: MouseEvent): void => {
        this.width = Math.min(Math.max(startW + (startX - ev.clientX), 180), Math.round(window.innerWidth * 0.7))
        this.root.style.width = `${this.width}px`
      }
      const up = (): void => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    })
  }
}
```

`src/renderer/lightbox.ts`:
```ts
import type { ImageCard } from '../shared/types'
import { imageUrl } from './image-url'

export class Lightbox {
  private cards: ImageCard[] = []
  private index = 0
  private scale = 1
  private tx = 0
  private ty = 0
  private readonly img: HTMLImageElement
  private readonly caption: HTMLElement

  constructor(private readonly root: HTMLElement) {
    this.img = document.createElement('img')
    this.img.draggable = false
    this.caption = document.createElement('div')
    this.caption.className = 'lightbox-caption'
    root.replaceChildren(this.img, this.caption)
    root.addEventListener('wheel', (e) => {
      e.preventDefault()
      this.scale = Math.min(Math.max(this.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.1), 20)
      this.apply()
    }, { passive: false })
    root.addEventListener('mousedown', (e) => {
      if (e.target !== this.img) {
        this.close()
        return
      }
      e.preventDefault()
      const sx = e.clientX - this.tx
      const sy = e.clientY - this.ty
      const move = (ev: MouseEvent): void => {
        this.tx = ev.clientX - sx
        this.ty = ev.clientY - sy
        this.apply()
      }
      const up = (): void => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
      }
      document.addEventListener('mousemove', move)
      document.addEventListener('mouseup', up)
    })
    // capture phase: handle Esc/arrows before the focused terminal sees them
    document.addEventListener('keydown', (e) => {
      if (this.root.hidden) return
      if (e.key === 'Escape') this.close()
      else if (e.key === 'ArrowRight') this.go(1)
      else if (e.key === 'ArrowLeft') this.go(-1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }, true)
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  open(cards: ImageCard[], index: number): void {
    this.cards = cards
    this.index = index
    this.root.hidden = false
    this.load()
  }

  close(): void {
    this.root.hidden = true
    this.img.removeAttribute('src')
  }

  private go(delta: number): void {
    if (this.cards.length === 0) return
    this.index = (this.index + delta + this.cards.length) % this.cards.length
    this.load()
  }

  private load(): void {
    const c = this.cards[this.index]
    if (!c) return
    this.scale = 1
    this.tx = 0
    this.ty = 0
    this.img.src = imageUrl(c)
    this.caption.textContent = `${c.name}${c.caption ? ` — ${c.caption}` : ''}  (${this.index + 1}/${this.cards.length})`
    this.apply()
  }

  private apply(): void {
    this.img.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`
  }
}
```

- [ ] **Step 6: Подключить в renderer (`src/renderer/main.ts`)**

6a. Импорты: в импорт из `'../shared/ipc'` добавить `type ImagesUpdate`; добавить:
```ts
import { ImagePanel } from './image-panel'
import { Lightbox } from './lightbox'
```

6b. После `let banner: RestoreBanner` добавить:
```ts
let imagePanel: ImagePanel
let lightbox: Lightbox
const imageUpdates = new Map<string, ImagesUpdate>()
```

6c. В конец функции `activate(tabId)` (после `renderTabs()`) добавить:
```ts
  imagePanel.show(imageUpdates.get(tabId) ?? { tabId, cards: [], unseen: 0, notice: null })
```

6d. В обработчике `ct.onTabClosed((id) => {...})` после `tabs.delete(id)` добавить:
```ts
    imageUpdates.delete(id)
```

6e. В `boot()` сразу после строки `document.addEventListener('drop', (e) => e.preventDefault())` (Task 10) добавить:
```ts
  lightbox = new Lightbox(document.getElementById('lightbox')!)
  imagePanel = new ImagePanel(
    document.getElementById('image-panel')!,
    {
      action: (id, action) => ct.imageAction(id, action),
      insertPath: (p) => {
        if (!activeId) return
        handleInput(activeId, `"${p}" `)
        tabs.get(activeId)?.view.term.focus()
      },
      open: (cards, index) => lightbox.open(cards, index),
      markSeen: (tabId) => ct.markImagesSeen(tabId)
    },
    settings.imagePanel.width,
    () => settings.imagePanel.autoOpen
  )
  toggleImagePanel = () => imagePanel.toggle()
  ct.onImages((u) => {
    imageUpdates.set(u.tabId, u)
    const t = tabs.get(u.tabId)
    if (t) {
      t.images = u.unseen
      renderTabs()
    }
    if (u.tabId === activeId) imagePanel.show(u)
  })
```

6f. В объект `window.__ct = {...}` добавить:
```ts
      images: (id) => (imageUpdates.get(id ?? activeId ?? '')?.cards ?? []).map((c) => ({ name: c.name, source: c.source, caption: c.caption })),
```

- [ ] **Step 7: Стили ленты и лайтбокса — дописать в `styles.css`**

```css
#image-panel { position: relative; display: flex; flex-direction: column; background: var(--chrome); border-left: 1px solid var(--border); min-width: 180px; }
#image-panel.collapsed { display: none; }
.panel-resize { position: absolute; left: -3px; top: 0; bottom: 0; width: 6px; cursor: col-resize; z-index: 5; }
.panel-header { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--border); color: var(--muted); }
.panel-header button { background: none; border: 0; color: var(--muted); cursor: pointer; font-size: 16px; }
.panel-notice { padding: 6px 10px; color: #e5c07b; font-size: 12px; border-bottom: 1px solid var(--border); }
.panel-list { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 10px; }
.panel-empty { color: var(--muted); text-align: center; margin-top: 24px; }
.card { background: var(--chrome-2); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; cursor: zoom-in; flex-shrink: 0; }
.card img { display: block; width: 100%; max-height: 260px; object-fit: contain; background: #111; }
.card.deleted img { filter: grayscale(1) opacity(0.4); }
.card-meta { padding: 6px 8px; }
.card-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-sub { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-caption { margin-top: 4px; font-size: 12px; }
#lightbox { position: fixed; inset: 0; z-index: 70; background: #000d; display: flex; align-items: center; justify-content: center; overflow: hidden; }
#lightbox img { max-width: 92vw; max-height: 88vh; cursor: grab; transform-origin: center; }
.lightbox-caption { position: absolute; bottom: 12px; left: 0; right: 0; text-align: center; color: #ddd; }
```

- [ ] **Step 8: Прогнать**

Run: `npm run typecheck && npm test && npm run test:e2e` → PASS (включая три теста `images.spec.ts`).

- [ ] **Step 9: Ручная проверка с настоящим claude**

`npm run dev` → `▾` → «Claude Code» в любом проекте. Попросить claude:
1. «сделай скриншот google.com через Chrome» (если Chrome MCP подключён) → карточка `tool` с подписью `claude-in-chrome · computer (screenshot)`;
2. «сохрани любой PNG в свой scratchpad и посмотри его через Read» → карточка `read` (и/или `created` из temp-папки сессии);
3. «запусти субагента, который откроет эту картинку» → карточка с подписью «субагент · Read»;
4. вставить свою картинку (Win+Shift+S → Ctrl+V) и отправить → карточка «вы».
Клик по карточке открывает лайтбокс (колесо — зум, ←/→, Esc); ПКМ → «Показать в Explorer» и «Вставить путь в терминал» работают; Ctrl+Shift+I скрывает/показывает ленту. Записать результат в отчёт.

- [ ] **Step 10: Checkpoint**

Не коммитить.

---

### Task 17: MCP-сервер `show_image`

**Files:**
- Create: `src/mcp/show-image-tool.ts`, `src/mcp/show-image-server.ts`
- Test: `tests/unit/show-image-tool.test.ts`, `tests/integration/mcp.int.test.ts`

**Interfaces:**
- Consumes: `checkImageFile`, `DEFAULT_IMAGE_EXTENSIONS` (Task 2); `defaultPipeName`, `isUuid`, `ShowImageMessage`, `PipeResponse` (Task 2); `sendPipeMessage` (Task 6); `startPipeServer` (Task 6, в тесте).
- Produces:
  - `show-image-tool.ts`: `interface ShowImageDeps { cwd: string; tabId: string | null; pipeName: string; send(pipeName, msg: ShowImageMessage): Promise<PipeResponse> }`, `interface ToolResult { text: string; isError: boolean }`, `handleShowImage(input: { path: string; caption?: string }, deps): Promise<ToolResult>`.
  - `show-image-server.ts`: точка входа бандла `resources/mcp/show-image-server.js` (MCP stdio, сервер `claudeterm`, тул `show_image`).

- [ ] **Step 1: Написать падающий unit-тест**

`tests/unit/show-image-tool.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { handleShowImage, type ShowImageDeps } from '../../src/mcp/show-image-tool'
import { PipeUnavailableError } from '../../src/shared/pipe-client'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const cwd = mkdtempSync(join(tmpdir(), 'ct-mcp-'))
writeFileSync(join(cwd, 'plot.png'), Buffer.from([1, 2, 3]))
writeFileSync(join(cwd, 'notes.txt'), 'x')

function deps(send: ShowImageDeps['send']): ShowImageDeps {
  return { cwd, tabId: TAB, pipeName: '\\\\.\\pipe\\x', send }
}

describe('handleShowImage', () => {
  it('resolves a relative path and sends it with the tab id', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    const r = await handleShowImage({ path: 'plot.png', caption: 'Plot' }, deps(send))
    expect(r).toEqual({ text: `Shown in ClaudeTerm: ${join(cwd, 'plot.png')}`, isError: false })
    expect(send).toHaveBeenCalledWith('\\\\.\\pipe\\x', { v: 1, type: 'show_image', tabId: TAB, path: join(cwd, 'plot.png'), caption: 'Plot' })
  })

  it('reports missing files and non-images as tool errors', async () => {
    const send = vi.fn()
    expect((await handleShowImage({ path: 'missing.png' }, deps(send))).isError).toBe(true)
    const txt = await handleShowImage({ path: join(cwd, 'notes.txt') }, deps(send))
    expect(txt.isError).toBe(true)
    expect(txt.text).toContain('not a supported image type')
    expect(send).not.toHaveBeenCalled()
  })

  it('is not an error when ClaudeTerm is not running', async () => {
    const r = await handleShowImage({ path: 'plot.png' }, deps(async () => { throw new PipeUnavailableError('ENOENT') }))
    expect(r).toEqual({ text: `ClaudeTerm is not running; image is at ${join(cwd, 'plot.png')}`, isError: false })
  })

  it('surfaces a rejection from ClaudeTerm', async () => {
    const r = await handleShowImage({ path: 'plot.png' }, deps(async () => ({ ok: false as const, error: 'no open tabs in ClaudeTerm' })))
    expect(r).toEqual({ text: 'ClaudeTerm rejected the image: no open tabs in ClaudeTerm', isError: true })
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run tests/unit/show-image-tool.test.ts`
Expected: FAIL (модуль не найден).

- [ ] **Step 3: Реализовать**

`src/mcp/show-image-tool.ts`:
```ts
import { isAbsolute, resolve } from 'node:path'
import { checkImageFile, DEFAULT_IMAGE_EXTENSIONS } from '../shared/image-file'
import type { PipeResponse, ShowImageMessage } from '../shared/protocol'

export interface ShowImageDeps {
  cwd: string
  tabId: string | null
  pipeName: string
  send(pipeName: string, msg: ShowImageMessage): Promise<PipeResponse>
}

export interface ToolResult {
  text: string
  isError: boolean
}

export async function handleShowImage(input: { path: string; caption?: string }, deps: ShowImageDeps): Promise<ToolResult> {
  const abs = isAbsolute(input.path) ? input.path : resolve(deps.cwd, input.path)
  const check = await checkImageFile(abs, DEFAULT_IMAGE_EXTENSIONS)
  if (!check.ok) return { text: check.error, isError: true }
  let res: PipeResponse
  try {
    res = await deps.send(deps.pipeName, { v: 1, type: 'show_image', tabId: deps.tabId, path: abs, caption: input.caption ?? null })
  } catch {
    return { text: `ClaudeTerm is not running; image is at ${abs}`, isError: false }
  }
  return res.ok ? { text: `Shown in ClaudeTerm: ${abs}`, isError: false } : { text: `ClaudeTerm rejected the image: ${res.error}`, isError: true }
}
```

`src/mcp/show-image-server.ts`:
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { userInfo } from 'node:os'
import { z } from 'zod'
import { sendPipeMessage } from '../shared/pipe-client'
import { defaultPipeName, isUuid } from '../shared/protocol'
import { handleShowImage } from './show-image-tool'

const server = new McpServer({ name: 'claudeterm', version: '0.1.0' })

server.registerTool(
  'show_image',
  {
    title: 'Show image in ClaudeTerm',
    description: 'Show an image file to the user in the ClaudeTerm image panel. Use after creating or finding an image the user should see.',
    inputSchema: {
      path: z.string().describe('Absolute path (preferred) or a path relative to the current working directory'),
      caption: z.string().optional().describe('Short caption shown under the image')
    }
  },
  async ({ path, caption }) => {
    const tabId = process.env.CLAUDETERM_TAB_ID
    const r = await handleShowImage(
      { path, caption },
      {
        cwd: process.cwd(),
        tabId: isUuid(tabId) ? tabId : null,
        pipeName: process.env.CLAUDETERM_PIPE || defaultPipeName(userInfo().username),
        send: (pipe, msg) => sendPipeMessage(pipe, msg, 3000)
      }
    )
    return { content: [{ type: 'text', text: r.text }], isError: r.isError }
  }
)

void server.connect(new StdioServerTransport())
```

- [ ] **Step 4: Запустить unit-тест — проходит**

Run: `npx vitest run tests/unit/show-image-tool.test.ts`
Expected: PASS.

- [ ] **Step 5: Интеграционный тест: настоящий MCP-клиент ↔ бандл сервера ↔ пайп**

`tests/integration/mcp.int.test.ts`:
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { build } from 'esbuild'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startPipeServer, type PipeServerHandle } from '../../src/main/pipe-server'
import type { ShowImageMessage } from '../../src/shared/protocol'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const work = mkdtempSync(join(tmpdir(), 'ct-mcpint-'))
const bundle = join(work, 'show-image-server.js')
const pipe = `\\\\.\\pipe\\claudeterm-test-${randomUUID()}`
const got: ShowImageMessage[] = []
let server: PipeServerHandle

beforeAll(async () => {
  await build({ entryPoints: [resolve(__dirname, '../../src/mcp/show-image-server.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' })
  server = await startPipeServer(pipe, { showImage: async (m) => { got.push(m); return { ok: true } }, session: () => ({ ok: true }) })
  mkdirSync(join(work, 'out'))
  writeFileSync(join(work, 'out', 'plot.png'), Buffer.from([1, 2, 3]))
})

afterAll(async () => { await server.close() })

describe('show_image MCP server', () => {
  it('lists the tool and forwards a call to ClaudeTerm', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      cwd: work,
      env: { ...(process.env as Record<string, string>), CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }
    })
    const client = new Client({ name: 'claudeterm-test', version: '1.0.0' })
    await client.connect(transport)
    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(['show_image'])
    const res = await client.callTool({ name: 'show_image', arguments: { path: 'out/plot.png', caption: 'Plot' } })
    expect(res.isError).toBeFalsy()
    expect(res.content).toEqual([{ type: 'text', text: `Shown in ClaudeTerm: ${join(work, 'out', 'plot.png')}` }])
    expect(got).toEqual([{ v: 1, type: 'show_image', tabId: TAB, path: join(work, 'out', 'plot.png'), caption: 'Plot' }])
    await client.close()
  })
})
```

- [ ] **Step 6: Запустить**

Run: `npx vitest run tests/integration/mcp.int.test.ts`
Expected: PASS.
Run: `npm run build:resources` → Expected: создан `resources/mcp/show-image-server.js` (и `resources/hook/session-hook.js`).

- [ ] **Step 7: Checkpoint**

Run: `npm test && npm run typecheck` → PASS. Не коммитить.

---

### Task 18: Регистрация MCP в Claude и тост «claude не найден»

**Files:**
- Create: `src/main/mcp-registrar.ts`
- Modify: `src/main/index.ts`
- Test: `tests/unit/mcp-registrar.test.ts`

**Interfaces:**
- Consumes: `resourcePath` (Task 9), `log`, `toast`, `settings` в main `index.ts`.
- Produces: `interface RunResult { code: number; stdout: string; stderr: string }`, `type Runner = (file, args, opts?: { verbatim?: boolean }) => Promise<RunResult>`, `execRunner: Runner`, `interface ClaudeCli { file: string; viaCmd: boolean }`, `resolveClaude(run): Promise<ClaudeCli | null>`, `runClaude(run, cli, args): Promise<RunResult>`, `type RegisterResult = 'registered' | 'already' | 'no-claude' | 'failed'`, `ensureMcpRegistered(o: { run; execPath; serverScript; log(m) }): Promise<RegisterResult>`.

- [ ] **Step 1: Написать падающий тест**

`tests/unit/mcp-registrar.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { ensureMcpRegistered, resolveClaude, runClaude, type RunResult, type Runner } from '../../src/main/mcp-registrar'

const EXE = 'C:\\Users\\me\\AppData\\Local\\Programs\\ClaudeTerm\\ClaudeTerm.exe'
const SCRIPT = 'C:\\Users\\me\\AppData\\Local\\Programs\\ClaudeTerm\\resources\\mcp\\show-image-server.js'
const CLAUDE = 'C:\\Users\\me\\.local\\bin\\claude.exe'

type Call = { file: string; args: string[]; verbatim: boolean }

function fakeRunner(responses: Array<(c: Call) => RunResult | null>): { run: Runner; calls: Call[] } {
  const calls: Call[] = []
  const run: Runner = async (file, args, opts) => {
    const c = { file, args, verbatim: opts?.verbatim ?? false }
    calls.push(c)
    for (const r of responses) {
      const out = r(c)
      if (out) return out
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr = 'x'): RunResult => ({ code: 1, stdout: '', stderr })
const whereFinds = (out: string) => (c: Call) => (c.file === 'where.exe' ? ok(out) : null)

describe('resolveClaude', () => {
  it('prefers the native exe', async () => {
    const { run } = fakeRunner([whereFinds(`C:\\npm\\claude\r\n${CLAUDE}\r\nC:\\npm\\claude.cmd\r\n`)])
    expect(await resolveClaude(run)).toEqual({ file: CLAUDE, viaCmd: false })
  })

  it('falls back to a .cmd shim and returns null when nothing is found', async () => {
    expect(await resolveClaude(fakeRunner([whereFinds('C:\\npm\\claude.cmd\r\n')]).run)).toEqual({ file: 'C:\\npm\\claude.cmd', viaCmd: true })
    expect(await resolveClaude(fakeRunner([(c) => (c.file === 'where.exe' ? fail() : null)]).run)).toBeNull()
  })
})

describe('runClaude', () => {
  it('runs a .cmd shim through cmd.exe with verbatim quoting', async () => {
    const { run, calls } = fakeRunner([])
    await runClaude(run, { file: 'C:\\npm\\claude.cmd', viaCmd: true }, ['mcp', 'get', 'claudeterm'])
    expect(calls[0]).toEqual({ file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', '""C:\\npm\\claude.cmd" "mcp" "get" "claudeterm""'], verbatim: true })
  })
})

describe('ensureMcpRegistered', () => {
  it('does nothing when already registered for this install', async () => {
    const { run, calls } = fakeRunner([whereFinds(CLAUDE), (c) => (c.args[1] === 'get' ? ok(`claudeterm:\n  Command: ${EXE}\n  Args: ${SCRIPT}\n`) : null)])
    expect(await ensureMcpRegistered({ run, execPath: EXE, serverScript: SCRIPT, log: () => {} })).toBe('already')
    expect(calls.map((c) => c.args[1])).toEqual([undefined, 'get'])
  })

  it('re-registers when missing or pointing elsewhere', async () => {
    const { run, calls } = fakeRunner([whereFinds(CLAUDE), (c) => (c.args[1] === 'get' ? fail('not found') : null)])
    expect(await ensureMcpRegistered({ run, execPath: EXE, serverScript: SCRIPT, log: () => {} })).toBe('registered')
    expect(calls.slice(2)).toEqual([
      { file: CLAUDE, args: ['mcp', 'remove', '--scope', 'user', 'claudeterm'], verbatim: false },
      { file: CLAUDE, args: ['mcp', 'add', '--scope', 'user', 'claudeterm', '-e', 'ELECTRON_RUN_AS_NODE=1', '--', EXE, SCRIPT], verbatim: false }
    ])
  })

  it('reports no-claude and failed', async () => {
    expect(await ensureMcpRegistered({ run: fakeRunner([(c) => (c.file === 'where.exe' ? fail() : null)]).run, execPath: EXE, serverScript: SCRIPT, log: () => {} })).toBe('no-claude')
    const logs: string[] = []
    const { run } = fakeRunner([whereFinds(CLAUDE), (c) => (c.args[1] === 'get' || c.args[1] === 'add' ? fail('boom') : null)])
    expect(await ensureMcpRegistered({ run, execPath: EXE, serverScript: SCRIPT, log: (m) => logs.push(m) })).toBe('failed')
    expect(logs[0]).toContain('boom')
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run tests/unit/mcp-registrar.test.ts`
Expected: FAIL (модуль не найден).

- [ ] **Step 3: Реализовать `src/main/mcp-registrar.ts`**

```ts
import { execFile } from 'node:child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export type Runner = (file: string, args: string[], opts?: { verbatim?: boolean }) => Promise<RunResult>

export const execRunner: Runner = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 60_000, windowsVerbatimArguments: opts?.verbatim ?? false, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })

export interface ClaudeCli {
  file: string
  viaCmd: boolean
}

export async function resolveClaude(run: Runner): Promise<ClaudeCli | null> {
  const r = await run('where.exe', ['claude'])
  if (r.code !== 0) return null
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
  const exe = lines.find((l) => l.toLowerCase().endsWith('.exe'))
  if (exe) return { file: exe, viaCmd: false }
  const shim = lines.find((l) => /\.(cmd|bat)$/i.test(l))
  return shim ? { file: shim, viaCmd: true } : null
}

export function runClaude(run: Runner, cli: ClaudeCli, args: string[]): Promise<RunResult> {
  if (!cli.viaCmd) return run(cli.file, args)
  // .cmd shims cannot be spawned without a shell; cmd /s /c strips the outer quotes
  const line = [cli.file, ...args].map((a) => `"${a}"`).join(' ')
  return run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { verbatim: true })
}

export type RegisterResult = 'registered' | 'already' | 'no-claude' | 'failed'

export async function ensureMcpRegistered(o: { run: Runner; execPath: string; serverScript: string; log(message: string): void }): Promise<RegisterResult> {
  const cli = await resolveClaude(o.run)
  if (!cli) return 'no-claude'
  const get = await runClaude(o.run, cli, ['mcp', 'get', 'claudeterm'])
  if (get.code === 0 && get.stdout.toLowerCase().includes(o.serverScript.toLowerCase())) return 'already'
  await runClaude(o.run, cli, ['mcp', 'remove', '--scope', 'user', 'claudeterm'])
  const add = await runClaude(o.run, cli, ['mcp', 'add', '--scope', 'user', 'claudeterm', '-e', 'ELECTRON_RUN_AS_NODE=1', '--', o.execPath, o.serverScript])
  if (add.code !== 0) {
    o.log(`claude mcp add failed (${add.code}): ${add.stderr || add.stdout}`)
    return 'failed'
  }
  return 'registered'
}
```

- [ ] **Step 4: Запустить — проходит**

Run: `npx vitest run tests/unit/mcp-registrar.test.ts`
Expected: PASS.

- [ ] **Step 5: Подключить в main (`src/main/index.ts`)**

5a. Импорт: `import { ensureMcpRegistered, execRunner, resolveClaude, type ClaudeCli } from './mcp-registrar'`.

5b. Непосредственно перед строкой `const tabs = new TabManager({` добавить:
```ts
  let claudeCli: ClaudeCli | null | undefined
  void resolveClaude(execRunner).then((cli) => { claudeCli = cli })
```

5c. В `resolveLaunch` внутри ветки `if (req.kind === 'claude') {` первой строкой добавить:
```ts
        if (claudeCli === null && settings.claude.command === 'claude') toast('claude not found in PATH — install Claude Code: https://claude.com/claude-code')
```

5d. Сразу после цепочки `startPipeServer(...).then(...).catch(...)` добавить:
```ts
  if (app.isPackaged && process.env.CLAUDETERM_SKIP_MCP_REGISTER !== '1') {
    void ensureMcpRegistered({ run: execRunner, execPath: process.execPath, serverScript: resourcePath('mcp/show-image-server.js'), log: (m) => log.warn(m) })
      .then((r) => log.info(`mcp registration: ${r}`))
  }
```

В dev-режиме (`!app.isPackaged`) регистрация не выполняется, чтобы dev-сборка не перезаписала регистрацию установленной версии.

- [ ] **Step 6: Прогнать**

Run: `npm run typecheck && npm test && npm run test:e2e` → PASS.

- [ ] **Step 7: Checkpoint**

Не коммитить.

---

### Task 19: Установщик `.exe`

**Files:**
- Create: `electron-builder.yml`, `build/installer.nsh`

**Interfaces:**
- Consumes: собранные `out/**`, `resources/mcp/show-image-server.js`, `resources/hook/session-hook.js`.
- Produces: `dist/ClaudeTerm-Setup-0.1.0.exe`.

Отклонение от спеки §9, осознанное: `oneClick: true` вместо `false`. В electron-builder при `oneClick: false` + `perMachine: false` установщик показывает выбор «для всех / только для меня» (а «для всех» требует админа и ставит в Program Files). `oneClick: true` + `perMachine: false` даёт ровно то, что требует спека: установка для текущего пользователя в `%LOCALAPPDATA%\Programs\ClaudeTerm` без админа и без лишних экранов. Ярлык на рабочем столе создаётся всегда (в one-click-установщике нет страницы выбора).

- [ ] **Step 1: `electron-builder.yml`**

```yaml
appId: dev.claudeterm.app
productName: ClaudeTerm
executableName: ClaudeTerm
directories:
  output: dist
  buildResources: build
files:
  - out/**/*
  - package.json
asarUnpack:
  - node_modules/node-pty/**
extraResources:
  - from: resources/mcp
    to: mcp
    filter: ["*.js"]
  - from: resources/hook
    to: hook
    filter: ["*.js"]
npmRebuild: false
win:
  target:
    - target: nsis
      arch: [x64]
nsis:
  oneClick: true
  perMachine: false
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: ClaudeTerm
  include: build/installer.nsh
  artifactName: ClaudeTerm-Setup-${version}.${ext}
```

- [ ] **Step 2: `build/installer.nsh`**

```nsis
!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerm.Claude" "" "Open Claude Code here"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerm.Claude" "Icon" "$INSTDIR\ClaudeTerm.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerm.Claude\command" "" '"$INSTDIR\ClaudeTerm.exe" --claude "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerm.Claude" "" "Open Claude Code here"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerm.Claude" "Icon" "$INSTDIR\ClaudeTerm.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerm.Claude\command" "" '"$INSTDIR\ClaudeTerm.exe" --claude "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerm.Shell" "" "Open ClaudeTerm here"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerm.Shell" "Icon" "$INSTDIR\ClaudeTerm.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ClaudeTerm.Shell\command" "" '"$INSTDIR\ClaudeTerm.exe" --shell "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerm.Shell" "" "Open ClaudeTerm here"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerm.Shell" "Icon" "$INSTDIR\ClaudeTerm.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ClaudeTerm.Shell\command" "" '"$INSTDIR\ClaudeTerm.exe" --shell "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\ClaudeTerm.Claude"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ClaudeTerm.Claude"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\ClaudeTerm.Shell"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ClaudeTerm.Shell"
  ${ifNot} ${isUpdated}
    nsExec::Exec 'cmd.exe /d /c claude mcp remove --scope user claudeterm'
    Pop $0
  ${endIf}
!macroend
```

- [ ] **Step 3: Собрать установщик**

Run: `npm run dist`
Expected: `dist\ClaudeTerm-Setup-0.1.0.exe` создан (при первом запуске electron-builder скачивает NSIS — нужен интернет).

- [ ] **Step 4: Проверить содержимое сборки**

Run:
```powershell
Test-Path dist\win-unpacked\resources\app.asar.unpacked\node_modules\node-pty\prebuilds\win32-x64\conpty.node
Test-Path dist\win-unpacked\resources\mcp\show-image-server.js
Test-Path dist\win-unpacked\resources\hook\session-hook.js
```
Expected: `True` три раза.

- [ ] **Step 5: Установить и проверить реестр и MCP**

1. Запустить `dist\ClaudeTerm-Setup-0.1.0.exe` (SmartScreen: «Подробнее → Выполнить в любом случае»).
2. Run: `reg query "HKCU\Software\Classes\Directory\Background\shell\ClaudeTerm.Claude\command"` → Expected: `"…\Programs\ClaudeTerm\ClaudeTerm.exe" --claude "%V"`.
3. Запустить ClaudeTerm из меню Пуск, подождать ~10 с, закрыть.
4. Run: `claude mcp get claudeterm` → Expected: команда указывает на установленный `ClaudeTerm.exe` и `resources\mcp\show-image-server.js`.

- [ ] **Step 6: Ручной чек-лист перед релизом (спека §10)**

Пройти и записать результат по каждому пункту:
- ПКМ по папке и по фону папки в Explorer → «Show more options» → «Open Claude Code here» → вкладка в уже открытом окне; ПКМ на корне диска (`D:\`) → вкладка в `D:\`.
- Claude Code во вкладке: ресайз, цвета, Shift+Enter, Ctrl+V картинки, `/`-меню, длинный вывод, Ctrl+C.
- `mcp__claudeterm__show_image` из реальной сессии попадает в правильную вкладку при двух открытых Claude-вкладках (попросить claude: «покажи мне <путь к png> через show_image»).
- Реальная сессия: скриншот через Chrome MCP; картинка в scratchpad + Read; субагент смотрит картинку; своя вставленная картинка → все в ленте. `/clear` → новые картинки продолжают появляться.
- Две Claude-вкладки в одной папке, в одной `/clear` → закрыть окно → открыть → «Продолжить» → каждая вкладка со своим разговором, в ленте видны картинки истории.
- PowerShell, cmd, Git Bash, WSL: интерактивные программы (vim/less/htop в WSL).
- Установка на второй машине без Node (или в чистой VM).
- Удаление через «Установка и удаление программ» → пункты контекстного меню исчезли, `claude mcp get claudeterm` сообщает, что сервера нет.

- [ ] **Step 7: Checkpoint**

Не коммитить. Сообщить пользователю путь к установщику и результаты чек-листа.
