# Строка статуса Claude-вкладки — дизайн

Дата: 2026-10-05
Статус: утверждён в чате (2026-10-05), ждёт ревью спека

## 1. Цель

Постоянно и ненавязчиво видеть для активной Claude-вкладки:

1. текущую модель и её effort;
2. сколько занято контекстного окна — в процентах и токенах;
3. сколько израсходовано 5-часового лимита;
4. сколько сабагентов работает прямо сейчас и с какими model·effort.

### Критерии успеха

- В Claude-вкладке внизу окна видна строка вида `Opus 5.5 · xhigh │ ctx 41% · 82k/200k │ 5h 23% │ ⚙ 3: opus·high ×2, haiku`.
- `/effort` или `/model` посреди сессии → строка обновляется в течение ~5 с (без ожидания ответа модели).
- Запущен сабагент → `⚙` появляется/увеличивается в течение ~1 с; модель·effort агента подставляются, как только в его транскрипте появилась первая реплика ассистента (≤ ~3 с).
- Сабагент закончил → он пропадает из счётчика в течение ~1 с.
- В шелл-вкладке строки нет; после выхода из `claude` в шелл строка пропадает.
- Терминал не обрезается строкой статуса (последняя строка и колонка видны при любом размере окна).
- Если ClaudeTerm/пайп недоступны, Claude Code работает как обычно, без задержек и ошибок.

### Вне скоупа

- Просмотр транскрипта сабагента по клику — есть в самом Claude Code (`/tasks`, бейдж фоновых задач).
- 7-дневный лимит, стоимость, git-статус.
- Сохранение пользовательского `statusLine` из `~/.claude/settings.json` внутри Claude-вкладок (у пользователя его нет; см. §7).
- Настройка вкл/выкл строки статуса в `settings.json`.

## 2. Источники данных

| Что | Откуда | Поля |
|---|---|---|
| Модель, effort основной сессии | stdin команды `statusLine` | `model.id`, `model.display_name`, `effort.level` (отсутствует, если модель не поддерживает effort; отражает `/effort` посреди сессии) |
| Контекст | stdin `statusLine` | `context_window.context_window_size`, `context_window.used_percentage`, `context_window.current_usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens}` (`current_usage` = `null` до первого запроса и сразу после `/compact`) |
| 5-часовой лимит | stdin `statusLine` | `rate_limits.five_hour.used_percentage`, `rate_limits.five_hour.resets_at` (unix-секунды; только Pro/Max и после первого ответа модели; окно пропадает после `resets_at`) |
| Какие сабагенты работают | хуки `SubagentStart` / `SubagentStop` | `session_id`, `agent_id`, `agent_type` |
| Model·effort сабагента | его транскрипт `<dirname(transcript)>/<sessionId>/subagents/agent-<agentId>.jsonl` | у строк `type: "assistant"`: `message.model`, `effort` (нет у моделей без effort, напр. Haiku) |
| Описание сабагента | `agent-<agentId>.meta.json` рядом с транскриптом | `description`, `agentType`, `toolUseId`, `requestShape` |
| Конец сессии claude | хук `SessionEnd` | `session_id` |

Документация: code.claude.com/docs/en/statusline, code.claude.com/docs/en/hooks. Поля `effort`/`message.model` в транскриптах сабагентов проверены на реальных файлах (`claude-opus-5-5 effort=xhigh`, `claude-sonnet-5-5 effort=medium`, у `claude-haiku-4-5-*` поля нет).

## 3. Архитектура

```
claude (в Claude-вкладке, --settings claude-tab-settings.json)
   ├─ statusLine ──────────► session-hook.cmd status ─┐
   ├─ SessionStart hook ───► session-hook.cmd ────────┤  ClaudeTerm.exe (ELECTRON_RUN_AS_NODE=1) session-hook.js
   ├─ SubagentStart hook ──► session-hook.cmd ────────┤  ──► named pipe: session | status | subagent | session_end
   ├─ SubagentStop hook ───► session-hook.cmd ────────┤
   └─ SessionEnd hook ─────► session-hook.cmd ────────┘
                                                         main: pipe-server → StatusHub ◄── TranscriptFeed.onSubagentInfo
                                                                              │
                                                                   IPC ev:status (≤ 1 раз / 50 мс на вкладку)
                                                                              ▼
                                                         renderer: status-bar.ts (#statusbar)
```

### 3.1 `claude-tab-settings.json` (`src/main/claude-tab-settings.ts`)

Генерируется при каждом старте, как сейчас. Новое содержимое:

```jsonc
{
  "statusLine": { "type": "command", "command": "\"C:/…/ClaudeTerm/session-hook.cmd\" status", "refreshInterval": 5 },
  "hooks": {
    "SessionStart":  [{ "hooks": [{ "type": "command", "command": "\"C:/…/session-hook.cmd\"", "timeout": 10 }] }],
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "\"C:/…/session-hook.cmd\"", "timeout": 10 }] }],
    "SubagentStop":  [{ "hooks": [{ "type": "command", "command": "\"C:/…/session-hook.cmd\"", "timeout": 10 }] }],
    "SessionEnd":    [{ "hooks": [{ "type": "command", "command": "\"C:/…/session-hook.cmd\"", "timeout": 10 }] }]
  }
}
```

`session-hook.cmd` передаёт аргументы скрипту (`… "<session-hook.js>" %*`). `refreshInterval: 5` нужен потому, что Claude Code перезапускает statusLine только на новой реплике ассистента, `/compact`, смене режима разрешений, vim-режима и сбросе окна лимита — `/effort` и `/model` сами по себе обновления не вызывают. Состояние сабагентов от таймера не зависит: оно приходит хуками.

### 3.2 Скрипт хука (`src/hook/`)

Один бандл `resources/hook/session-hook.js` (имя файла не меняется). Диспетчеризация:

- `argv` содержит `status` → разбор JSON statusLine → сообщение `status`;
- иначе по `hook_event_name`: `SessionStart` → `session` (как сейчас), `SubagentStart`/`SubagentStop` → `subagent`, `SessionEnd` → `session_end`; любое другое — ничего не делать.

Правила для всех веток: `CLAUDETERM_TAB_ID`/`CLAUDETERM_PIPE` из env (нет валидного tabId → выход), **ничего не писать в stdout** (для statusLine пустой вывод = пустая строка статуса в Claude Code; для SessionStart stdout попадает в контекст), таймаут пайпа 1 с для `status` и 2 с для остальных, код выхода всегда 0, любые исключения проглатываются.

Преобразование statusLine-JSON → `status` — чистая функция `statusFromStatusLine(input)`; сырой JSON по пайпу не передаётся.

### 3.3 Протокол пайпа (`src/shared/protocol.ts`)

Новые сообщения (`v: 1`), валидируются в `parsePipeMessage`; невалидное → `{ ok: false, error }`, как сейчас:

```ts
interface StatusMessage {
  v: 1; type: 'status'; tabId: string /* UUID */; sessionId: string /* UUID */
  model: { id: string; displayName: string }
  effort: string | null
  context: { usedTokens: number; size: number; usedPct: number } | null   // null, если current_usage = null
  fiveHour: { usedPct: number; resetsAt: number /* unix-секунды */ } | null
}
interface SubagentMessage {
  v: 1; type: 'subagent'; tabId: string; sessionId: string
  event: 'start' | 'stop'; agentId: string /* [A-Za-z0-9_-]{1,64} */; agentType: string /* ≤ 100 символов */
}
interface SessionEndMessage { v: 1; type: 'session_end'; tabId: string; sessionId: string }
```

`context.usedTokens` = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (та же формула, что у `used_percentage`); `usedPct` = `used_percentage`, а если он `null` — `usedTokens / size × 100`. Строки обрезаются до разумной длины (`displayName`, `id`, `effort` ≤ 100).

### 3.4 `StatusHub` (`src/main/status-hub.ts`)

Чистое состояние по вкладкам, без IO, с колбэком `onChange(tabId)`:

```ts
interface AgentState { agentId: string; type: string; description: string | null; model: string | null; effort: string | null; startedAt: number }
type MainStatus = Pick<StatusMessage, 'model' | 'effort' | 'context' | 'fiveHour'>
interface TabStatus { sessionId: string | null; main: MainStatus | null; agents: AgentState[] }
```

- `status` → `main` обновляется; если `sessionId` отличается от текущего — агенты сбрасываются.
- `session` (SessionStart) с другим `sessionId` → `main` и агенты сбрасываются (`/clear`, `/resume`), строка скрыта до первого `status` новой сессии.
- `subagent start` → добавить агента (`startedAt = now`); `stop` → удалить. Проверено на живой сессии: агент, закончивший ход в ожидании своих фоновых задач, получает `SubagentStop`, а при возобновлении — снова `SubagentStart`; строка показывает агентов, которые работают прямо сейчас.
- `onSubagentInfo(tabId, agentId, model, effort)` → дописать в существующего агента (для неизвестного агента — запомнить, чтобы применить при `start`: транскрипт может опередить хук).
- `session_end` и закрытие вкладки → состояние вкладки очищается (строка скрывается).
- Описание агента — через инжектируемую `readMeta(tabId, agentId)`; читается лениво при `start` и повторно при `onSubagentInfo`, пока не получено (файл может появиться позже хука).

`index.ts` связывает: пайп-сообщения → hub; `TranscriptFeed` получает колбэк `onSubagentInfo`; `onChange` склеивает обновления (50 мс на вкладку, как для картинок) и шлёт `IPC.evStatus` с `StatusUpdate { tabId, main, agents }`.

### 3.5 `TranscriptFeed`

Новый необязательный колбэк `onSubagentInfo(agentId, model, effort)`. Для строк из `subagents/agent-<agentId>.jsonl` с `type: "assistant"` чистая функция `assistantInfo(line)` (`src/main/transcript-agent-info.ts`) возвращает `{ model, effort }` (`effort` — поле `effort`, иначе `perTurnEffort`, иначе `null`); колбэк вызывается, только если пара изменилась.

### 3.6 Подстраховка для незакрытых сабагентов

Первый шаг реализации — проверить на живой вкладке, приходит ли `SubagentStop`, когда пользователь прерывает работу (Esc) во время сабагента. Если приходит — подстраховка не нужна. Если нет — агент снимается по основному транскрипту, используя `toolUseId` и `requestShape` из `meta.json`:

- не-фоновый агент (`requestShape` ≠ `background`) — когда появляется `tool_result` с `tool_use_id` = `toolUseId`;
- фоновый — когда появляется `<task-notification>` с `<tool-use-id>` = `toolUseId`.

## 4. Renderer

### 4.1 Разметка и стиль

`<div id="statusbar" hidden>` после `#workspace` в `index.html`. Высота ~28 px, шрифт 15 px «Segoe UI» (подобрано пользователем: ×1,5, затем −15 %), цвет `--muted`, фон как у таб-бара, разделители `│`. Видна, только если у активной вкладки есть `main` (то есть пришёл хотя бы один `status`). Терминал подстраивается через существующий `ResizeObserver` (`#workspace` — flex-элемент).

### 4.2 Сегменты (`src/renderer/status-bar.ts`)

Чистая функция `statusSegments(update, now)` → список `{ text, title, level }`; DOM-рендер отдельно.

| Сегмент | Текст | Подсказка (`title`) | Когда скрыт |
|---|---|---|---|
| Модель | `Opus 5.5 · xhigh` (`displayName` + effort) | `model.id` | никогда (при наличии `main`) |
| Контекст | `ctx 41% · 82k/200k` | `82 314 из 200 000 токенов` | `context = null` |
| 5 часов | `5h 23%` | `сброс в 21:40` (локальное время из `resetsAt`) | `fiveHour = null` |
| Сабагенты | `⚙ 3: opus·high ×2, haiku` | по строке на агента: `code-reviewer · opus·high · 3 мин · «Review font fix»` | агентов нет |

- Токены: `< 1000` как есть, иначе `82k`, `1M` для 1 000 000; проценты — целые.
- `level` для ctx и 5h: `warn` при ≥ 70 %, `crit` при ≥ 90 % (жёлтый `#e5c07b` / красный).
- Модель сабагента сокращается до семейства: `claude-opus-5-5` → `opus`, `claude-haiku-4-5-20251001` → `haiku`; неизвестный формат — id как есть; модель ещё неизвестна — `…`. Группировка по `модель·effort` (без effort — только модель), группы по убыванию количества, `×N` при N > 1.

### 4.3 Связь с вкладками

Renderer хранит последний `StatusUpdate` по вкладке; при переключении вкладки и при каждом `ev:status` активной вкладки перерисовывает строку. Закрытие вкладки удаляет запись.

## 5. Обработка ошибок

| Ситуация | Поведение |
|---|---|
| Пайп недоступен / таймаут | скрипт молча завершается с кодом 0; Claude Code не замечает |
| Невалидный JSON на stdin, нет `CLAUDETERM_TAB_ID` | ничего не отправлять, код 0 |
| Невалидное сообщение в пайпе | `{ ok: false, error }`, состояние не меняется |
| Сообщение для неизвестной вкладки | игнорируется |
| `SubagentStop` без `SubagentStart` | игнорируется |
| `meta.json` / транскрипт агента не читаются | агент показывается без описания / с моделью `…` |
| Выход из claude в шелл | `session_end` → строка скрыта |
| Падение claude без `SessionEnd` | строка остаётся с последними данными до следующего `status`/`session` во вкладке; новый `session` с другим `sessionId` сбрасывает агентов |

## 6. Тестирование

- **unit** (`vitest`):
  - `parsePipeMessage` для `status`/`subagent`/`session_end`: валидные, невалидные tabId/sessionId/agentId, обрезка строк, `null`-поля;
  - `statusFromStatusLine`: полный пример из документации; без `effort`; `current_usage = null`; `used_percentage = null`; без `rate_limits`; без `five_hour`;
  - диспетчер хука: `status`-аргумент, `SessionStart`, `SubagentStart`/`SubagentStop`, `SessionEnd`, неизвестное событие, нет tabId;
  - `claudeTabSettingsJson`: `statusLine` + четыре хука, `%*` в `.cmd`;
  - `StatusHub`: start/stop, info до и после start, смена sessionId через `status` и через `session`, `session_end`, закрытие вкладки, ленивое описание;
  - `assistantInfo`: assistant-строка с effort, без effort (Haiku), не-assistant строка, битый JSON;
  - `statusSegments`: форматирование токенов, пороги warn/crit, сокращение моделей, группировка агентов, скрытие сегментов.
- **integration**: настоящий скрипт хука → настоящий пайп-сервер для statusLine-JSON и `SubagentStart` (по образцу `session-hook.int.test.ts`).
- **e2e** (Playwright): после `status` и `subagent` в пайп для Claude-вкладки строка показывает ожидаемый текст; у шелл-вкладки строки нет; после `session_end` строка скрыта; с видимой строкой статуса сетка терминала не выходит за границы (проверка `overflows` из `layout.spec.ts`).
- **вручную на живой Claude-вкладке**: как выглядит пустая строка statusLine над футером; Esc во время сабагента (§3.6); `/effort` и `/model` посреди сессии.

## 7. Риски и компромиссы

| Риск | Решение |
|---|---|
| `statusLine` из `--settings` перекрывает пользовательский `statusLine` | принято: у пользователя своего нет; при появлении — отдельная задача на проброс его вывода |
| С кастомным statusLine Claude Code скрывает подсказки футера (`esc to interrupt`, `? for shortcuts`, `hold space to speak`) и показывает пустую строку над футером | принято пользователем; бейджи футера и `/tasks` остаются |
| `SubagentStop` может не прийти при прерывании | проверка первым шагом; подстраховка §3.6 |
| Запуск ClaudeTerm.exe на каждое обновление statusLine | замер: ~85 мс (как у обычного node); обновления дебаунсятся Claude Code (300 мс), устаревший запуск отменяется им же; `refreshInterval: 5` добавляет один запуск раз в 5 с на Claude-вкладку (~2 % одного ядра) |
| Формат транскрипта (`effort`, `message.model`) не документирован | используется только для model·effort сабагентов; при отсутствии полей показывается `…` |
