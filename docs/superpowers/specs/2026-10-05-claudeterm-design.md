# ClaudeTerm — дизайн v1

Дата: 2026-10-05
Статус: утверждён (2026-10-05)

## 1. Цель

Личный терминал под Windows 11 для работы с Claude Code:

1. Функционал обычной консоли на уровне Windows Terminal (без сплитов — см. «Вне скоупа»).
2. ПКМ по папке в Explorer → «Open Claude Code here» → сессия `claude` открывается **новой вкладкой** в уже запущенном окне ClaudeTerm (или запускает его).
3. Картинки разговора видны прямо в окне — в боковой ленте вкладки, как в мобильном приложении Claude: всё, что есть в разговоре (скриншоты из любых тулов/MCP, картинки, которые агент или субагенты открыли через Read — откуда угодно, включая temp/scratchpad, картинки, вставленные пользователем), плюс файлы, которые агент создал, и явный `show_image`.
4. Всё ставится одним `.exe`-установщиком на другой компьютер.
5. После перезагрузки/перезапуска — кнопка «Продолжить предыдущие сессии»: открывает те же вкладки, и каждая Claude-вкладка продолжает **свой** разговор.

### Критерии успеха

- Claude Code, обычный PowerShell, Git Bash и WSL работают во вкладках без артефактов отрисовки (цвета, ресайз, Unicode, мышь, Shift+Enter).
- ПКМ по папке → вкладка с `claude` в этой папке появляется в существующем окне за ≤ 2 с.
- Агент сохранил `out/plot.png` → карточка в ленте этой вкладки появляется в течение ~1 с после окончания записи.
- Агент вызвал `show_image` → картинка в ленте **той вкладки, где работает этот агент**.
- Агент сделал скриншот через Chrome MCP или сохранил скриншот в scratchpad и открыл его через Read (сам или через субагента) → картинка в ленте этой вкладки в течение ~1 с после появления в разговоре.
- «Продолжить» для Claude-вкладки → в ленте снова видны картинки из истории этого разговора.
- На чистом Windows 11 (без Node) достаточно запустить установщик и иметь установленный `claude`.
- Были открыты две Claude-вкладки в одной папке с разными разговорами → перезагрузка → «Продолжить» → две вкладки, каждая со своим разговором (включая случай, когда в одной из них делали `/clear`).

## 2. Скоуп

### В v1

- Профили с автодетектом: PowerShell 7 (`pwsh.exe`), Windows PowerShell, cmd, Git Bash, дистрибутивы WSL.
- Вкладки: новая (кнопка `+` с выпадающим списком профилей), закрыть, переименовать (двойной клик), перетаскивание, переключение хоткеями.
- Отдельный тип вкладки «Claude» — `claude`, запущенный внутри шелла.
- Копипаст, вставка по ПКМ, поиск по скроллбэку, кликабельные ссылки, зум шрифта.
- Темы/шрифт через `settings.json`.
- Боковая лента картинок на вкладку + полноэкранный просмотр.
- MCP-тул `show_image`.
- Пункты контекстного меню Explorer.
- NSIS-установщик для текущего пользователя (без админа).
- Сохранение размера/позиции окна.
- Продолжение предыдущих сессий (§6.5).

### Вне скоупа v1 (кандидаты в v2)

- Сплиты панелей, Quake-режим, несколько окон.
- Автоматическое (без кнопки) восстановление вкладок.
- Сессии `claude`, запущенные вручную в обычной шелл-вкладке: для них нет SessionStart-хука, поэтому нет ни восстановления, ни картинок из транскрипта, ни watcher'а; работает только `show_image`. Закрывается опцией «глобальный хук в `~/.claude/settings.json`» — отложено до явного решения пользователя.
- Персистентная лента (после перезапуска лента пустая).
- Настраиваемые хоткеи (в v1 фиксированный набор).
- Автообновление.
- Превью SVG/PDF.
- Подпись кода (установщик неподписан → SmartScreen: «Подробнее → Выполнить в любом случае»).
- Картинки, которые агент создал **вне** папки проекта и temp-папки сессии и ни разу не открыл (их нет ни в разговоре, ни под наблюдением) — только через `show_image`.

## 3. Стек

TypeScript; Electron + electron-vite; xterm.js (`@xterm/xterm` + addons: fit, search, web-links, webgl, unicode11); node-pty (ConPTY); chokidar; `@modelcontextprotocol/sdk`; electron-builder (NSIS); vitest; Playwright (Electron). Renderer — vanilla TS, без UI-фреймворка.

Обоснование выбора Electron вместо Tauri/WezTerm: xterm.js + node-pty — та же связка, что в терминале VS Code, поэтому паритет с Windows Terminal получаем почти бесплатно; боковая лента — обычный HTML; single-instance и NSIS-упаковка есть из коробки. Цена — размер (~100 МБ) и RAM, для личного инструмента приемлемо.

## 4. Архитектура

```
Explorer ПКМ ──► ClaudeTerm.exe --claude "D:\proj"
                    │ (второй экземпляр)
                    ▼ requestSingleInstanceLock / 'second-instance'
┌──────────────────────── Main process ────────────────────────┐
│ Args ─► TabManager ──► PtyHost (node-pty, env CLAUDETERM_TAB_ID)│
│              │                                                │
│              ├──► ImageWatcher (cwd + temp-папка сессии)      │
│              │          │                                     │
│ PipeServer ◄─┼──────────┼─── \\.\pipe\claudeterm-<user>       │
│     │        ▼          ▼                                     │
│     ├────► ImageHub (ленты по tabId) ──► img-протокол ctimg://│
│     ├────► TranscriptFeed (транскрипт + subagents/*.jsonl) ─► ImageHub │
│     └────► TabManager.setClaudeSession(tabId, sessionId)       │
│ SessionStore (session-state.json / previous-session.json)     │
│ Settings, Profiles, McpRegistrar, ClaudeTabSettings           │
└───────────────┬──────────────────────────────────────────────┘
                │ IPC (preload, contextIsolation)
┌───────────────▼──────── Renderer ────────────────────────────┐
│ TabBar │ TerminalView (xterm.js на вкладку) │ ImagePanel │ Lightbox │
└──────────────────────────────────────────────────────────────┘

claude (во вкладке) ──spawn──► ClaudeTerm.exe (ELECTRON_RUN_AS_NODE=1) show-image-server.js
                                  │ наследует CLAUDETERM_TAB_ID
                                  └──► PipeServer: {type:"show_image", tabId, path}

claude (Claude-вкладка, запущена с --settings claude-tab-settings.json)
   └─ SessionStart hook ──► resources\hook\session-hook.cmd ──► ClaudeTerm.exe (ELECTRON_RUN_AS_NODE=1) session-hook.js
                               (stdin: JSON хука, env: CLAUDETERM_TAB_ID)
                               └──► PipeServer: {type:"session", tabId, sessionId, transcriptPath}
```

### 4.1 Модули main process

| Модуль | Ответственность | Зависит от |
|---|---|---|
| `args.ts` | Разбор argv (первый и второй экземпляр) в команду `OpenTab` | — |
| `settings.ts` | Загрузка/валидация `settings.json`, дефолты, слежение за изменениями | — |
| `profiles.ts` | Автодетект шеллов, построение команды запуска для профиля и для Claude-вкладки | settings |
| `pty-host.ts` | Создание/ресайз/запись/убийство PTY, стрим данных в renderer | node-pty |
| `tab-manager.ts` | Реестр вкладок (id, тип, cwd, профиль, состояние), связывает PTY, watcher и ленту | pty-host, image-watcher, image-hub |
| `image-watcher.ts` | chokidar на каталог (cwd вкладки или temp-папка сессии), фильтры, «дождаться окончания записи», события `added/changed/removed` | chokidar |
| `transcript-images.ts` | Разбор строки транскрипта (JSONL) → список картинок (Read с путём к файлу, картинки тулов, вставленные пользователем) с подписями | — |
| `transcript-feed.ts` | Инкрементальное чтение транскрипта сессии и `<sessionId>/subagents/*.jsonl`, декодирование base64 в кэш, передача картинок в ImageHub | transcript-images |
| `image-hub.ts` | Ленты картинок по tabId: добавление, дедуп/«updated», лимит, счётчик непросмотренных | — |
| `pipe-server.ts` | Named pipe, NDJSON-протокол, валидация сообщений → image-hub | image-hub |
| `img-protocol.ts` | Кастомный протокол `ctimg://<imageId>?v=<n>`: отдаёт только зарегистрированные в image-hub файлы | image-hub |
| `mcp-registrar.ts` | При старте: проверить/зарегистрировать MCP в user-конфиге Claude | — |
| `claude-tab-settings.ts` | При старте: сгенерировать `%APPDATA%\ClaudeTerm\session-hook.cmd` и `claude-tab-settings.json` с SessionStart-хуком, указывающим на него | — |
| `session-store.ts` | Снимок вкладок → `session-state.json` (debounce); на старте — перенос в `previous-session.json` (только если в снимке есть Claude-вкладка с session id); чтение/удаление снимка для восстановления | — |

### 4.2 Renderer

- `tabbar.ts` — вкладки, `+` с выпадающим списком профилей и пунктами «Claude Code» и «Продолжить предыдущие сессии» (если есть снимок), индикаторы, drag-reorder, переименование.
- `restore-banner.ts` — полоса над терминалом «Предыдущая сессия: N вкладок (M Claude) · <время> — [Продолжить] [×]».
- `terminal-view.ts` — экземпляр xterm.js на вкладку, аддоны, клавиатурные перехваты (см. §6.3).
- `image-panel.ts` — сворачиваемая правая панель (ширина изменяется перетаскиванием), карточки, контекстное меню карточки.
- `lightbox.ts` — полноэкранный просмотр: зум колесом, перетаскивание, ←/→ по ленте, Esc.

### 4.3 MCP-сервер `show-image-server.ts`

Отдельная точка входа, собирается в `resources/mcp/show-image-server.js`. Запускается тем же `ClaudeTerm.exe` с `ELECTRON_RUN_AS_NODE=1`, поэтому Node на машине не нужен.

### 4.4 Хук `session-hook`

`src/hook/session-hook.ts` собирается в `resources/hook/session-hook.js`. Обёртку `session-hook.cmd` приложение **генерирует при каждом старте** в `%APPDATA%\ClaudeTerm\` с абсолютными путями (так она работает и в установленной версии, и в dev-режиме, где exe — `electron.exe`):

```bat
@echo off
set ELECTRON_RUN_AS_NODE=1
"<process.execPath>" "<путь к resources\hook\session-hook.js>"
exit /b 0
```

`.cmd`-обёртка нужна, чтобы команда хука не зависела от того, через какой шелл claude запускает хуки (bash/cmd/PowerShell одинаково запускают путь к `.cmd`). Скрипт читает JSON хука из stdin (`session_id`, `source`, `transcript_path`), берёт `CLAUDETERM_TAB_ID`/`CLAUDETERM_PIPE` из env, отправляет `session` в пайп (таймаут 2 с) и **ничего не пишет в stdout** (stdout SessionStart-хука попадает в контекст claude). Код выхода — всегда 0.

## 5. Интерфейсы

### 5.1 Аргументы командной строки

| Вызов | Поведение |
|---|---|
| `ClaudeTerm.exe` | Окно с вкладкой профиля по умолчанию в `%USERPROFILE%` (если окно уже есть — просто фокус) |
| `ClaudeTerm.exe --claude "<dir>"` | Новая Claude-вкладка в `<dir>` |
| `ClaudeTerm.exe --shell "<dir>" [--profile "<name>"]` | Новая вкладка профиля (по умолчанию — `defaultProfile`) в `<dir>` |

Если `<dir>` не существует — вкладка открывается в `%USERPROFILE%` и показывается тост. Второй экземпляр передаёт argv первому через `second-instance` и завершается; первый открывает вкладку и выводит окно на передний план (restore + focus + `flashFrame`, если фокус не получен).

### 5.2 Реестр (HKCU, пишет установщик)

```
HKCU\Software\Classes\Directory\shell\ClaudeTerm.Claude
  (Default) = "Open Claude Code here"
  Icon      = "<install>\ClaudeTerm.exe"
  command\(Default) = "<install>\ClaudeTerm.exe" --claude "%V"
HKCU\Software\Classes\Directory\Background\shell\ClaudeTerm.Claude   — то же
```

На Windows 11 пункт виден в классическом меню («Show more options» / Shift+ПКМ). Пункт «Open ClaudeTerm here» (`ClaudeTerm.Shell`) убран по решению пользователя; деинсталлятор удаляет ключи `ClaudeTerm.Claude`, а также ключи `ClaudeTerm.Shell`, оставшиеся от ранних версий.

### 5.3 Переменная окружения вкладки

Каждый PTY получает `CLAUDETERM_TAB_ID=<uuid>` и `CLAUDETERM_PIPE=\\.\pipe\claudeterm-<username>`. `claude` и запущенные им MCP-серверы наследуют их.

### 5.4 Named pipe протокол

Пайп: `\\.\pipe\claudeterm-<username>`. Сообщения — одна JSON-строка на запрос, завершается `\n`; ответ — одна JSON-строка.

Запросы:
```json
{"v":1,"type":"show_image","tabId":"<uuid|null>","path":"<абсолютный путь>","caption":"<строка|null>"}
{"v":1,"type":"session","tabId":"<uuid>","sessionId":"<uuid>","source":"startup|resume|clear|compact","transcriptPath":"<абсолютный путь к .jsonl|null>"}
```
Ответ:
```json
{"ok":true}
{"ok":false,"error":"<текст>"}
```

Main валидирует: `v === 1`, `type` известен.
- `show_image`: `path` абсолютный, файл существует, расширение из списка §6.4, размер ≤ 50 МБ. Неизвестный/`null` `tabId` → картинка уходит в активную вкладку.
- `session`: `tabId` — существующая Claude-вкладка, `sessionId` — UUID; иначе `{"ok":false}` и сообщение игнорируется. `transcriptPath` — абсолютный путь с расширением `.jsonl` или `null` (любое другое значение → `null`).

### 5.5 MCP-тул

Регистрация (выполняет `mcp-registrar` при каждом старте приложения, асинхронно, не блокируя UI): если `claude mcp get claudeterm` завершился с ошибкой или его вывод не содержит путь текущего exe — `claude mcp remove --scope user claudeterm` (ошибка игнорируется), затем:

```
claude mcp add --scope user claudeterm -e ELECTRON_RUN_AS_NODE=1 -- "<install>\ClaudeTerm.exe" "<install>\resources\mcp\show-image-server.js"
```

(форма с `--` — та же, что в примере `claude mcp --help`; `--` завершает variadic-флаг `-e`).

Путь к `claude` резолвится через `where.exe claude`: `.exe` вызывается через `execFile` без шелла; если найден только `.cmd` (npm-установка) — через `cmd.exe /d /s /c` с кавычками вокруг каждого аргумента.

Для агента тул виден как `mcp__claudeterm__show_image`.

- `name`: `show_image`
- `description`: «Show an image file to the user in the ClaudeTerm image panel. Use after creating or finding an image the user should see.»
- `inputSchema`: `{ path: string (обязательно; абсолютный или относительно cwd сервера), caption?: string }`
- Результат: текст `Shown in ClaudeTerm: <path>` либо ошибка (§7).

Если `claude` не найден в PATH во время регистрации — регистрация пропускается молча и повторяется при следующем старте.

### 5.6 `settings.json`

Путь: `%APPDATA%\ClaudeTerm\settings.json`. Отсутствующие поля берутся из дефолтов; при изменении файла настройки применяются без перезапуска (кроме профилей уже открытых вкладок).

```jsonc
{
  "defaultProfile": "PowerShell 7",          // имя профиля
  "claude": {
    "command": "claude",
    "shellProfile": "PowerShell 7"           // в каком шелле запускать claude
  },
  "profiles": [                               // дополняют/переопределяют автодетект по name
    { "name": "Git Bash", "command": "C:\\Program Files\\Git\\bin\\bash.exe", "args": ["--login", "-i"] }
  ],
  "font": { "family": "Cascadia Mono", "size": 13 },
  "theme": "Campbell",                        // встроенные: Campbell, One Half Dark, One Half Light; или объект цветов xterm ITheme
  "scrollback": 10000,
  "imageWatch": {
    "enabled": true,                          // только для Claude-вкладок
    "extensions": ["png", "jpg", "jpeg", "gif", "webp", "bmp"],
    "ignore": [".git", "node_modules", "Intermediate", "DerivedDataCache", "Binaries", ".vs", ".idea"],
    "maxDepth": 8
  },
  "imagePanel": { "autoOpen": true, "width": 320, "maxItems": 200 }
}
```

Дефолт `defaultProfile` и `claude.shellProfile`: PowerShell 7, если найден, иначе Windows PowerShell.

## 6. Поведение

### 6.1 Профили и запуск Claude-вкладки

Автодетект: `pwsh.exe` (PATH и `%ProgramFiles%\PowerShell\*`), `powershell.exe`, `cmd.exe`, Git Bash (`%ProgramFiles%\Git\bin\bash.exe`), WSL (`wsl.exe -l -q` → профиль на дистрибутив).

Claude-вкладка запускает шелл `claude.shellProfile` так, чтобы после выхода из claude остаться в шелле. Командная строка claude (`<cl>`):

```
<claude.command> --settings <путь к claude-tab-settings.json> [--resume <sessionId>]
```

`--resume` добавляется только при восстановлении (§6.5). Путь к settings-файлу экранируется по правилам шелла (PowerShell — одинарные кавычки, cmd — двойные, bash — одинарные и прямые слэши).

| Шелл | Аргументы |
|---|---|
| pwsh / powershell | `-NoLogo -NoExit -Command <cl>` |
| cmd | `/k <cl>` |
| bash | `--login -i -c "<cl>; exec bash --login -i"` |

WSL как `claude.shellProfile` в v1 не поддерживается (валидация настроек → дефолт + тост).

### 6.2 Вкладки

- Заголовок: OSC 0/2 title из процесса; если пусто — имя папки; ручное переименование имеет приоритет.
- Индикатор `●`: BEL пришёл в неактивной вкладке. Если окно не в фокусе — дополнительно `flashFrame`. Сбрасывается при активации вкладки.
- Индикатор `🖼N`: N непросмотренных карточек ленты; сбрасывается, когда панель этой вкладки открыта и видна.
- Завершение процесса: в терминал печатается `[process exited with code N] Enter — restart, Ctrl+Shift+W — close`; Enter перезапускает ту же команду в том же cwd.
- Закрытие последней вкладки закрывает окно.

### 6.3 Клавиши и мышь (фиксированные в v1)

| Действие | Привязка |
|---|---|
| Новая вкладка (профиль по умолчанию) | Ctrl+Shift+T |
| Новая Claude-вкладка в cwd текущей вкладки | Ctrl+Shift+L |
| Закрыть вкладку | Ctrl+Shift+W |
| След./пред. вкладка | Ctrl+Tab / Ctrl+Shift+Tab |
| Вкладка N | Ctrl+Alt+1…9 |
| Копировать / вставить | Ctrl+Shift+C / Ctrl+Shift+V |
| Ctrl+C | при выделении — копировать и снять выделение; иначе — передать в процесс |
| Ctrl+V | текст в буфере — вставить; в буфере только картинка — отправить Alt+V (`ESC v`), claude сам заберёт её из буфера |
| Shift+Enter | отправить `ESC CR` (перенос строки в промпте claude) |
| Поиск | Ctrl+Shift+F |
| Панель картинок | Ctrl+Shift+I |
| Зум шрифта | Ctrl+= / Ctrl+- / Ctrl+0 |
| Открыть `settings.json` | Ctrl+, |
| ПКМ в терминале | есть выделение — копировать; нет — вставить |
| Drag&drop файла в терминал | вставить путь в кавычках |

«cwd текущей вкладки» в v1 — начальный cwd вкладки (текущий каталог шелла не отслеживается).

### 6.4 Лента картинок

Источники:

1. **Транскрипт сессии (TranscriptFeed)** — главный источник, «как в мобильном приложении». Запускается для Claude-вкладки, когда приходит `session` с `transcriptPath`; при смене пути (`/clear`, `/resume`) старое чтение останавливается и начинается новое. Читает файл транскрипта **с начала** (поэтому при `--resume` в ленту попадает история разговора), затем дочитывает новые строки (опрос размера файла каждые 500 мс), а также все `<dirname(transcript)>/<sessionId>/subagents/*.jsonl` (список файлов опрашивается каждые 2 с). Из каждой строки JSONL извлекаются image-блоки (`{"type":"image","source":{"type":"base64","media_type":…,"data":…}}`) — рекурсивно по всей структуре строки, чтобы пережить изменения формата:
   - блок внутри `tool_result` тула `Read` (имя тула берётся из ранее встреченного `tool_use` с тем же id) → `source: "read"`; если `input.file_path` существует — карточка ссылается **на этот файл**, иначе (файл уже удалён, например temp очищен) — base64 декодируется в кэш;
   - блок внутри `tool_result` любого другого тула (в т.ч. MCP) → base64 декодируется в кэш, `source: "tool"`, подпись: имя тула без `mcp__`, `__` → ` · `, плюс `input.action`, если есть (`claude-in-chrome · computer (screenshot)`);
   - блок прямо в сообщении пользователя (не внутри `tool_result`) → в кэш, `source: "pasted"`, подпись «вставлено вами»;
   - строки из `subagents/*.jsonl` получают префикс подписи «субагент · ».
   Кэш: `%TEMP%\ClaudeTerm\images\<sessionId>\<sha1(data)[0..16]>.<ext>` (ext из `media_type`: png/jpg/gif/webp); одинаковые картинки → один файл → одна карточка. При старте приложения подкаталоги кэша старше 7 дней удаляются. Нераспознаваемые строки и блоки молча пропускаются.
2. **ImageWatcher** — только для Claude-вкладок при `imageWatch.enabled`, два каталога: cwd вкладки (с момента открытия) и temp-папка сессии `%TEMP%\claude\<basename(dirname(transcriptPath))>\<sessionId>\` (с момента получения `session`, создаётся при необходимости; меняется вместе с сессией). chokidar с `ignoreInitial: true`, `depth: maxDepth`, `ignored` по сегментам пути из `imageWatch.ignore`, `awaitWriteFinish: { stabilityThreshold: 500 }`. Учитываются расширения из `imageWatch.extensions`. Watcher cwd **не запускается**, если cwd — корень диска или `%USERPROFILE%` (в ленте плашка «авто-слежение выключено для этой папки»); temp-папка сессии отслеживается всегда.
3. **PipeServer** — сообщения `show_image`.

ImageHub, лента вкладки:

- Ключ карточки — нормализованный абсолютный путь (lowercase на Windows).
- Новый путь → карточка сверху, `source: "created" | "shown" | "read" | "tool" | "pasted"`, `caption`, время.
- Уже известный путь → карточка обновляется (новая версия `v` для сброса кэша), поднимается наверх, метка «updated». `show_image` на уже известный путь проставляет `caption`.
- Удаление файла → карточка остаётся, помечается «deleted» (миниатюра серая).
- Больше `maxItems` → удаляются самые старые.
- При закрытии вкладки её лента, watcher'ы и чтение транскрипта уничтожаются (кэш на диске остаётся до очистки по возрасту).

UI:

- Панель изначально свёрнута; первая картинка вкладки раскрывает её, если `autoOpen`.
- Карточка: миниатюра (по ширине панели), имя файла, относительный путь от cwd вкладки, время, источник/подпись.
- Клик → Lightbox. ПКМ → «Открыть в просмотрщике», «Показать в Explorer», «Копировать изображение», «Копировать путь», «Вставить путь в терминал», «Убрать из ленты».
- Renderer загружает картинки только через `ctimg://<imageId>?v=<n>`; прямых `file://` путей в renderer нет.

### 6.5 Продолжение предыдущих сессий

**Отслеживание session id.** Каждая Claude-вкладка запускается с `--settings %APPDATA%\ClaudeTerm\claude-tab-settings.json`. Файл перезаписывается при каждом старте приложения:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "C:/Users/<user>/AppData/Roaming/ClaudeTerm/session-hook.cmd", "timeout": 10 } ] }
    ]
  }
}
```

Путь в `command` — с прямыми слэшами; если содержит пробел — в двойных кавычках. Хук срабатывает на `startup`, `resume`, `clear`, `compact`, поэтому после `/clear` или `/resume` внутри claude вкладка узнаёт новый id. TabManager хранит у вкладки последний полученный `claudeSessionId`.

Почему не `claude --continue`: он берёт последний разговор в папке — две вкладки в одной папке продолжили бы один и тот же разговор.

**Снимок.** `%APPDATA%\ClaudeTerm\session-state.json`:

```json
{
  "version": 1,
  "savedAt": "2026-10-05T14:02:11.000Z",
  "tabs": [
    { "kind": "claude", "profile": "Windows PowerShell", "cwd": "D:\\Workspace\\LocHub", "title": null, "claudeSessionId": "1f0c…" },
    { "kind": "shell",  "profile": "Git Bash",           "cwd": "D:\\Workspace\\Offroad", "title": "build", "claudeSessionId": null }
  ]
}
```

- `title` — только ручное переименование (иначе `null`).
- Пишется атомарно (tmp + rename) с debounce 500 мс при: открытии/закрытии/перестановке/переименовании вкладки, смене `claudeSessionId`; и синхронно при закрытии окна.
- Окно закрыто с открытыми вкладками → снимок с этими вкладками. Закрыта последняя вкладка вручную → снимок пустой. Перезагрузка/падение → последний записанный снимок.

**Старт приложения.** Если `session-state.json` содержит хотя бы одну Claude-вкладку с `claudeSessionId` (валидный UUID) — он переносится в `previous-session.json` (с заменой). Иначе (снимок пустой или отсутствует, только шелл-вкладки, либо Claude-вкладки без session id) существующий `previous-session.json` **не** трогается и остаётся доступным для восстановления. Затем текущий запуск начинает писать свой `session-state.json`.

**UI.** Если `previous-session.json` существует:
- над терминалом полоса: «Предыдущая сессия: N вкладок (M Claude) · <время сохранения> — [Продолжить] [×]»; `×` скрывает полосу до следующего запуска;
- в выпадающем меню `+` — пункт «Продолжить предыдущие сессии (N)».

**Восстановление** (кнопка или пункт меню):
- вкладки открываются в сохранённом порядке после уже открытых, активируется первая восстановленная;
- Claude-вкладка с `claudeSessionId` → `claude --settings … --resume <id>`; без id → обычный запуск claude;
- шелл-вкладка → тот же профиль (если профиля больше нет — `defaultProfile`) и cwd;
- `title` восстанавливается;
- несуществующий cwd → `%USERPROFILE%` + тост;
- после восстановления `previous-session.json` удаляется, полоса и пункт меню скрываются.
- вкладка, которую приложение само открыло при запуске без аргументов, при восстановлении закрывается, если пользователь ничего в неё не вводил; явно открытые вкладки (Explorer, `+`) не закрываются.

Работает и при холодном старте из контекстного меню Explorer: новая вкладка открывается, полоса «Продолжить» тоже показывается.

## 7. Обработка ошибок

| Ситуация | Поведение |
|---|---|
| `show_image`: пайп недоступен (ClaudeTerm не запущен) | Успешный результат тула с текстом `ClaudeTerm is not running; image is at <path>` |
| `show_image`: файл не существует / не картинка / > 50 МБ | Ошибка тула (`isError: true`) с текстом причины |
| Неизвестный `tabId` | Картинка в активную вкладку |
| Ошибка watcher (EPERM, исчерпание дескрипторов и т.п.) | Watcher вкладки останавливается, плашка в ленте; `show_image` продолжает работать |
| `claude` не найден при запуске Claude-вкладки | Шелл остаётся открытым, его собственная ошибка видна; дополнительно тост «claude not found in PATH — install Claude Code: https://claude.com/claude-code» |
| Невалидный `settings.json` | Дефолты + тост с текстом ошибки парсинга/валидации |
| Профиль из настроек не найден на диске | Профиль скрыт из списка, тост |
| Падение PTY | Как выход процесса (§6.2) |
| Пайп с таким именем занят (второй экземпляр без lock) | Невозможно при single-instance; на всякий случай — лог и работа без пайпа |
| Хук: пайп недоступен / нет `CLAUDETERM_TAB_ID` / битый stdin | Тихо выходит с кодом 0, stdout пустой |
| `--resume <id>`: разговор удалён или не найден | claude сам печатает ошибку, шелл остаётся открытым; вкладка сохраняет старый id до следующего сообщения хука |
| Битый `session-state.json` / `previous-session.json` | Файл игнорируется (не переносится, полоса не показывается), запись в лог |
| Транскрипт не существует / не читается | Чтение повторяется при следующем опросе; ошибок в UI нет, запись в лог один раз |
| Строка транскрипта не JSON / неизвестная структура / битый base64 | Строка/блок пропускается молча |
| Запись в кэш картинок не удалась | Картинка пропускается, запись в лог |

Логи main: `%APPDATA%\ClaudeTerm\logs\main.log` (ротация 5 × 1 МБ).

## 8. Безопасность

- Renderer: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; API только через preload.
- `ctimg://` отдаёт файлы только по id, зарегистрированным в ImageHub; файл перечитывается и проверяется расширение при каждом запросе.
- Пайп именован по пользователю; используется стандартный DACL Windows для named pipe (запись — только владелец, SYSTEM и администраторы). Сообщения валидируются (§5.4); main ничего из сообщения не исполняет — только показывает картинку или запоминает session id вкладки (id попадает в командную строку только после валидации как UUID).
- Ссылки из терминала открываются через `shell.openExternal` только для `http(s)`.

## 9. Упаковка

- electron-builder, target `nsis`, `oneClick: true` (установка только для текущего пользователя без диалогов; `oneClick: false` в electron-builder показывает выбор «для всех/для меня», требующий админа), `perMachine: false` → `%LOCALAPPDATA%\Programs\ClaudeTerm`.
- `build/installer.nsh`: `customInstall` пишет ключи §5.2; `customUnInstall` удаляет их и выполняет `claude mcp remove --scope user claudeterm` (ошибки игнорируются).
- node-pty 1.1.0 поставляет N-API prebuilds для win32-x64 — пересборка под Electron не нужна (`npmRebuild: false`), `asarUnpack` для node-pty.
- MCP-сервер собирается в один самодостаточный JS-файл (все зависимости, включая `@modelcontextprotocol/sdk`, забандлены) и кладётся через `extraResources` в `resources/mcp/show-image-server.js`.
- Хук аналогично: `resources/hook/session-hook.js` (бандл) через `extraResources`; `.cmd`-обёртка генерируется приложением (§4.4).
- Ярлыки: меню Пуск и рабочий стол (one-click установщик создаёт оба).
- Артефакт: `ClaudeTerm-Setup-<version>.exe`.

## 10. Тестирование

**Unit (vitest)** — без Electron:
- `args.ts`: все формы из §5.1, кавычки и пробелы в путях, несуществующая папка.
- `settings.ts`: дефолты, частичные настройки, невалидный JSON, невалидные значения.
- `profiles.ts`: построение команд для Claude-вкладки по таблице §6.1 (детект шеллов — через инжектируемую функцию проверки файлов).
- `image-hub.ts`: добавление, дедуп/«updated», caption от `show_image`, deleted, лимит `maxItems`, маршрутизация неизвестного tabId в активную вкладку.
- `image-watcher.ts` (фильтры): ignore по сегментам, расширения, отказ для корня диска и home.
- Валидация сообщений пайпа.
- Обработчик тула `show_image` с подменённым клиентом пайпа: успех, пайп недоступен, файла нет, не картинка.
- `session-store.ts`: перенос непустого снимка в previous; пустой/отсутствующий снимок не затирает previous; битый JSON игнорируется; атомарная запись; debounce.
- `profiles.ts`: командная строка claude с `--settings` и `--resume` для каждого шелла, путь с пробелами и одинарной кавычкой.
- `claude-tab-settings.ts`: JSON хука, путь с прямыми слэшами, кавычки при пробелах.
- Валидация сообщения `session` (неизвестная вкладка, шелл-вкладка, не-UUID, `transcriptPath`).
- `transcript-images.ts` на фикстурах со структурой реальных транскриптов: Read-картинка (путь существует / не существует), скриншот MCP-тула с подписью из `input.action`, вставленная пользователем картинка, картинка субагента, строка без картинок, битый JSON, `tool_result` без предшествующего `tool_use`.

**Интеграционные (vitest, реальные процессы/ФС):**
- Реальный `PipeServer` + реальный MCP-сервер, запущенный через `node`, вызов тула через MCP SDK client → сообщение дошло в ImageHub с правильным tabId.
- Реальный ImageWatcher на временной папке: новый PNG → `added`; перезапись → `changed`; файл в `node_modules/` игнорируется.
- `session-hook.js`, запущенный через `node` с JSON на stdin и `CLAUDETERM_TAB_ID` в env → PipeServer получил `session` с `transcriptPath`; без пайпа → код 0 и пустой stdout.
- `transcript-feed.ts` на временных файлах: история читается с начала; дописанная строка (в т.ч. частичная, дописанная в два приёма) обрабатывается один раз; новый файл в `subagents/` подхватывается; одинаковая картинка дважды → один файл в кэше; `stop()` прекращает чтение.

**E2E smoke (Playwright для Electron):**
- Запуск → вкладка → `echo hello` → `hello` в буфере xterm.
- Запуск с `--shell <tmp>`, второй запуск с `--claude <tmp>` (с `claude.command` подменённым на `cmd /c echo fake-claude`) → две вкладки в одном окне.
- Положить PNG в cwd Claude-вкладки → карточка в ленте.
- Отправить в пайп `session` с `transcriptPath` на фикстуру-транскрипт со скриншотом MCP-тула → карточка `tool` с подписью в ленте.
- Подготовленный `session-state.json` с Claude-вкладкой (`claudeSessionId` задан) и `claude.command` = скрипт, печатающий свои аргументы → после старта видна полоса «Продолжить», клик → вкладка печатает `--resume <id>`.

**Ручной чек-лист (перед релизом):**
- Две Claude-вкладки в одной папке, в одной `/clear` → закрыть окно → открыть → «Продолжить» → каждая вкладка продолжает свой разговор.
- Установка на чистую машину/VM без Node, SmartScreen, пункты контекстного меню (папка и фон папки), деинсталляция чистит реестр и MCP.
- Claude Code во вкладке: ресайз, цвета, Shift+Enter, Ctrl+V картинки, `/` меню, длинный вывод, Ctrl+C.
- `mcp__claudeterm__show_image` из реальной сессии попадает в правильную вкладку при двух открытых Claude-вкладках.
- Реальная сессия: попросить claude сделать скриншот страницы через Chrome MCP; сохранить картинку в scratchpad и открыть её; запустить субагента, который смотрит картинку; вставить свою картинку → все четыре в ленте. `/clear` → новые картинки продолжают появляться. «Продолжить» → картинки истории видны.
- PowerShell 7, cmd, Git Bash, WSL: интерактивные программы (vim/less/htop в WSL).

## 11. Структура проекта

```
ClaudeTerm/
  package.json
  electron.vite.config.ts
  electron-builder.yml
  build/installer.nsh
  src/
    shared/      protocol.ts (пайп), ipc.ts (каналы main↔renderer), types.ts
    main/        index.ts, args.ts, settings.ts, profiles.ts, pty-host.ts, tab-manager.ts,
                 image-watcher.ts, image-hub.ts, pipe-server.ts, img-protocol.ts, mcp-registrar.ts,
                 claude-tab-settings.ts, session-store.ts, transcript-images.ts, transcript-feed.ts, log.ts
    preload/     index.ts
    renderer/    index.html, main.ts, tabbar.ts, terminal-view.ts, image-panel.ts, lightbox.ts,
                 restore-banner.ts, keymap.ts, styles.css
    mcp/         show-image-server.ts
    hook/        session-hook.ts
  tests/
    unit/  integration/  e2e/
  docs/superpowers/specs/
```

## 12. Риски

| Риск | Митигация |
|---|---|
| Сборка node-pty под Electron требует MSVC Build Tools | Предсобранные бинарники node-pty; иначе VS Build Tools (на машине разработки уже есть VS) |
| Shift+Enter / Ctrl+V-картинка ведут себя в claude не так, как ожидается | Проверяется в первом же вертикальном срезе (ручной чек-лист) до остальной работы над UI |
| Наследование env MCP-сервером от claude | Проверяется интеграционным тестом с реальным claude на этапе MCP; запасной вариант — tabId = null → активная вкладка |
| Нагрузка watcher на больших UE-проектах | `ignore` + `maxDepth` по умолчанию; отказ для корня диска/home; ошибка → отключение без падения |
| Win11 современное меню не показывает пункты | Принято: используем классическое меню (у пользователя оно используется) |
| Формат транскрипта Claude Code внутренний и может измениться | Рекурсивный поиск image-блоков по любой структуре строки; фикстуры повторяют реально наблюдаемую структуру (image внутри `message.content[]` и внутри `tool_result.content[]`); при поломке формата теряется только этот источник, watcher и `show_image` продолжают работать |
| Хуки из `--settings` не применяются / хук запускается не тем шеллом / stdin не доходит через `.cmd` | Проверяется в первом вертикальном срезе с реальным claude: открыть Claude-вкладку, `/clear`, убедиться, что пришли два `session`. Запасной вариант — запуск с `--session-id <uuid>` от приложения (теряем отслеживание `/clear` и `/resume`) |
