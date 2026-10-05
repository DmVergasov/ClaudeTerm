# Строка статуса Claude-вкладки — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Внизу окна для активной Claude-вкладки постоянно видны модель·effort, заполненность контекста (% и токены), расход 5-часового лимита и работающие сабагенты с их model·effort.

**Architecture:** ClaudeTerm добавляет в `claude-tab-settings.json` команду `statusLine` и хуки `SubagentStart`/`SubagentStop`/`SessionEnd`; все они вызывают существующий скрипт хука (`session-hook.js` через `session-hook.cmd`), который пересылает данные в named pipe новыми сообщениями `status`/`subagent`/`session_end`. В main чистый `StatusHub` держит состояние по вкладкам (model·effort сабагентов дописывает `TranscriptFeed` из их транскриптов), склеенные обновления уходят в renderer событием `ev:status`, а `status-bar.ts` рисует строку `#statusbar`.

**Tech Stack:** TypeScript ~5.9, Electron ^44, electron-vite ^5, vitest ^5, @playwright/test ^1.63, esbuild (бандл хука).

**Spec:** `docs/superpowers/specs/2026-10-05-status-bar-design.md` — читать вместе с планом.

## Global Constraints

- Платформа: только Windows 10/11 x64; все тесты запускаются на Windows. Node.js для разработки ≥ 22.12.
- **Никаких git-коммитов** (глобальное правило пользователя: коммит — только по явной просьбе в разговоре). Шаг «Checkpoint» в конце задачи = тесты и `npm run typecheck` зелёные, изменения оставлены незакоммиченными. Субагентам — то же правило.
- Скрипт хука: **stdout всегда пустой, код выхода всегда 0**, любые ошибки проглатываются. Таймаут пайпа: 1000 мс для `status`, 2000 мс для остальных сообщений.
- Протокол пайпа: `v: 1`; `tabId`/`sessionId` — UUID; `agentId` — `^[A-Za-z0-9_-]{1,64}$`; строки-метки (`model.id`, `model.displayName`, `effort`, `agentType`) обрезаются до 100 символов; описание сабагента — до 200.
- `statusLine` в `claude-tab-settings.json`: `{ "type": "command", "command": "<hookCommandString(cmdPath)> status", "refreshInterval": 5 }`; хуки `SessionStart`, `SubagentStart`, `SubagentStop`, `SessionEnd` — одна и та же команда `hookCommandString(cmdPath)` с `timeout: 10`.
- Склейка обновлений статуса в main: не чаще одного `ev:status` на вкладку за 50 мс.
- Пороги подсветки: `warn` при ≥ 70 %, `crit` при ≥ 90 % (для ctx и 5h). Цвета: `#e5c07b` (warn), `#e06c75` (crit).
- Тексты строки статуса (из спека): `Opus 5.5 · xhigh`, `ctx 41% · 82k/200k`, `5h 23%`, `⚙ 3: opus·high ×2, haiku`; подсказки по-русски: `82 314 из 200 000 токенов`, `сброс в 21:40`, `code-reviewer · opus·high · 3 мин · «Review font fix»`.
- Строка статуса видна только у вкладки, для которой пришёл хотя бы один `status`; шелл-вкладки сообщения статуса не принимают (`unknown claude tab: <id>`).
- Установщик собирать **вне папки проекта** (`--config.directories.output="%LOCALAPPDATA%\claudeterm-dist"`): запущенный ClaudeTerm с Claude-вкладкой в этой папке держит открытыми `.asar` в `dist\` (известный отдельный баг наблюдателя картинок).

## Review Focus

1. **Начало сессии / Haiku в основной сессии**: в JSON statusLine `current_usage: null`, `used_percentage: null`, нет `effort` и `rate_limits` → строка показывает только модель, без `NaN%`, `undefined` и пустых сегментов. Тесты — Task 3 (`status-line.test.ts`, «early in a session») и Task 7 (`status-bar.test.ts`, «only the model»).
2. **`/clear` во время работы сабагентов**: запоздавший `SubagentStop`/`status` прошлой сессии приходит после `SessionStart` новой → состояние новой сессии не сбрасывается и не смешивается со старым. Тест — Task 6 (`status-hub.test.ts`, «late hooks of a previous session»).
3. **Синтетические реплики в транскрипте сабагента** (`message.model: "<synthetic>"` при прерывании/ошибке API) → не затирают реальную модель агента. Тест — Task 5 (`transcript-agent-info.test.ts` и `transcript-feed.int.test.ts`).
4. **Много параллельных сабагентов** (10 агентов трёх видов + один без модели) → компактная группировка `⚙ 10: sonnet·medium ×6, opus·xhigh ×2, haiku, …`, строка не ломает раскладку (CSS `text-overflow: ellipsis`). Тест — Task 7.
5. **Сообщение статуса для шелл-вкладки или уже закрытой вкладки** (запоздавший хук) → отклоняется, состояние не создаётся, строка не появляется. Тест — Task 8 (e2e «a shell tab has no status bar»).

## File Structure

```
src/shared/types.ts            + MainStatus, AgentStatus
src/shared/ipc.ts              + StatusUpdate, IPC.evStatus, CtApi.onStatus
src/shared/protocol.ts         + StatusMessage, SubagentMessage, SessionEndMessage, их парсинг
src/main/pipe-server.ts        + обработчики status / subagent / sessionEnd
src/hook/status-line.ts        НОВЫЙ: statusFromStatusLine — JSON statusLine → StatusMessage
src/hook/session-hook.ts       диспетчер хуков (SessionStart/SubagentStart/SubagentStop/SessionEnd) + runStatusLine
src/hook/main.ts               выбор ветки по аргументу `status`
src/main/claude-tab-settings.ts  statusLine + 4 хука; `%*` в .cmd
src/main/transcript-agent-info.ts НОВЫЙ: assistantInfo, readAgentMeta (+ completedToolUses в Task 9)
src/main/transcript-feed.ts    + onSubagentInfo (+ onToolUseDone в Task 9)
src/main/status-hub.ts         НОВЫЙ: состояние статуса по вкладкам
src/main/index.ts              проводка: пайп → StatusHub → ev:status
src/preload/index.ts           + onStatus
src/renderer/status-bar.ts     НОВЫЙ: statusSegments (чистая) + StatusBar (DOM)
src/renderer/main.ts           хранение StatusUpdate по вкладкам, рендер активной
src/renderer/index.html        + #statusbar
src/renderer/styles.css        + стили #statusbar
tests/unit/status-line.test.ts, tests/unit/transcript-agent-info.test.ts, tests/unit/status-hub.test.ts, tests/unit/status-bar.test.ts  НОВЫЕ
tests/e2e/status.spec.ts       НОВЫЙ
tests/fixtures/transcript.ts   + assistantLine, queueNotificationLine (Task 9)
tests/e2e/helpers.ts           + launchClaudeTab
```

---

### Task 1: Проба поведения Claude Code (вручную, с пользователем)

Выполняет контроллер вместе с пользователем: нужен живой `claude` и нажатие Esc. Код пробы — одноразовый, в проект не попадает.

**Files:**
- Create (вне репозитория): `%TEMP%\ct-probe\probe.cmd`, `%TEMP%\ct-probe\probe-settings.json`
- Modify: `docs/superpowers/specs/2026-10-05-status-bar-design.md` (§3.6 — записать результат)

**Interfaces:**
- Consumes: —
- Produces: решение, выполнять ли Task 9 (запись в §3.6 спека).

- [ ] **Step 1: Создать файлы пробы** (Git Bash)

```bash
P="$(cygpath -m "$TEMP")/ct-probe"; mkdir -p "$P"; rm -f "$P/probe.log"
printf '@echo off\r\necho ==== %%1 %%date%% %%time%%>> "%%~dp0probe.log"\r\nmore >> "%%~dp0probe.log"\r\necho.>> "%%~dp0probe.log"\r\nexit /b 0\r\n' > "$P/probe.cmd"
cat > "$P/probe-settings.json" <<EOF
{
  "statusLine": { "type": "command", "command": "\"$P/probe.cmd\" status" },
  "hooks": {
    "SubagentStart": [{ "hooks": [{ "type": "command", "command": "\"$P/probe.cmd\" SubagentStart" }] }],
    "SubagentStop":  [{ "hooks": [{ "type": "command", "command": "\"$P/probe.cmd\" SubagentStop" }] }]
  }
}
EOF
echo "claude --settings \"$P/probe-settings.json\""
```

- [ ] **Step 2: Попросить пользователя прогнать сценарий** в **шелл-вкладке** ClaudeTerm (не в Claude-вкладке), запустив напечатанную команду:
  1. Посмотреть низ интерфейса Claude Code (по возможности — скриншот до и после): есть ли пустая строка над футером; пропали ли `esc to interrupt` / `? for shortcuts`; **осталась ли встроенная строка под полем ввода `Opus 5.5 · Ctx: 40% (80k) · … · Effort: high`** (пользователь спрашивал о ней). Если она пропадает — сообщить пользователю до продолжения: наша строка статуса показывает те же данные, но решение за ним.
  2. Промпт: `Запусти сабагента general-purpose: пусть выполнит в Bash sleep 120 и ответит OK`. Когда агент начал работу — нажать **Esc**.
  3. Промпт: `Запусти сабагента general-purpose в фоне (run_in_background): sleep 20 и ответ OK`. Дождаться уведомления о завершении.
  4. `/exit`.

- [ ] **Step 3: Разобрать лог**

```bash
P="$(cygpath -m "$TEMP")/ct-probe"; grep -n "^==== Subagent" "$P/probe.log"; grep -c "^==== status" "$P/probe.log"; grep -o '"rate_limits":{[^}]*}' "$P/probe.log" | tail -1; grep -o '"effort":{[^}]*}' "$P/probe.log" | tail -1
```

Ожидаемо: для сценария 2 — `SubagentStart`, и вопрос в том, есть ли парный `SubagentStop` после Esc; для сценария 3 — `SubagentStart` и `SubagentStop`. Заодно видно, приходят ли `rate_limits` (у подписки пользователя) и `effort`.

- [ ] **Step 4: Записать результат в спек** — в конец §3.6 одной строкой, например: `Результат пробы 2026-10-05: SubagentStop при Esc приходит → подстраховка не нужна.` или `… не приходит → выполняется Task 9 плана.` Если `rate_limits` у пользователя не приходят — сказать ему, что сегмента 5h не будет.

- [ ] **Step 5: Checkpoint** — решение по Task 9 зафиксировано.

---

### Task 2: Общие типы, протокол пайпа и маршрутизация в pipe-server

**Files:**
- Modify: `src/shared/types.ts` (в конец файла)
- Modify: `src/shared/ipc.ts` (импорт типов + `StatusUpdate` после `ImagesUpdate`)
- Modify: `src/shared/protocol.ts`
- Modify: `src/main/pipe-server.ts`
- Modify: `tests/unit/protocol.test.ts`, `tests/integration/pipe.test.ts`, `tests/integration/mcp.int.test.ts:21`, `tests/integration/session-hook.int.test.ts:44`

**Interfaces:**
- Consumes: —
- Produces:
  - `types.ts`: `interface MainStatus { model: { id: string; displayName: string }; effort: string | null; context: { usedTokens: number; size: number; usedPct: number } | null; fiveHour: { usedPct: number; resetsAt: number } | null }`; `interface AgentStatus { agentId: string; type: string; description: string | null; model: string | null; effort: string | null; startedAt: number }`
  - `ipc.ts`: `interface StatusUpdate { tabId: string; main: MainStatus | null; agents: AgentStatus[] }`
  - `protocol.ts`: `interface StatusMessage extends MainStatus { v: 1; type: 'status'; tabId: string; sessionId: string }`; `interface SubagentMessage { v: 1; type: 'subagent'; tabId: string; sessionId: string; event: 'start' | 'stop'; agentId: string; agentType: string }`; `interface SessionEndMessage { v: 1; type: 'session_end'; tabId: string; sessionId: string }`; `PipeMessage` включает все пять типов.
  - `pipe-server.ts`: `PipeHandlers` получает обязательные `status(msg: StatusMessage): PipeResponse`, `subagent(msg: SubagentMessage): PipeResponse`, `sessionEnd(msg: SessionEndMessage): PipeResponse`.

- [ ] **Step 1: Написать падающие тесты протокола** — добавить в конец `tests/unit/protocol.test.ts`:

```ts
describe('status, subagent and session_end messages', () => {
  const ids = { v: 1, tabId: TAB, sessionId: SID }

  it('accepts a full status message', () => {
    const msg = {
      ...ids,
      type: 'status',
      model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
      effort: 'xhigh',
      context: { usedTokens: 82314, size: 200000, usedPct: 41.2 },
      fiveHour: { usedPct: 23.5, resetsAt: 1790000000 }
    }
    expect(parsePipeMessage(JSON.stringify(msg))).toEqual({ ok: true, message: msg })
  })

  it('nulls malformed optional parts and defaults displayName to the model id', () => {
    const r = parsePipeMessage(JSON.stringify({ ...ids, type: 'status', model: { id: 'claude-x' }, effort: 7, context: { usedTokens: 'a', size: 1, usedPct: 1 }, fiveHour: { usedPct: 5 } }))
    expect(r).toEqual({ ok: true, message: { ...ids, type: 'status', model: { id: 'claude-x', displayName: 'claude-x' }, effort: null, context: null, fiveHour: null } })
  })

  it('rejects a zero context size', () => {
    const r = parsePipeMessage(JSON.stringify({ ...ids, type: 'status', model: { id: 'm' }, context: { usedTokens: 1, size: 0, usedPct: 1 } }))
    expect(r.ok && r.message.type === 'status' && r.message.context).toBe(null)
  })

  it('truncates labels to 100 characters', () => {
    const r = parsePipeMessage(JSON.stringify({ ...ids, type: 'status', model: { id: 'm'.repeat(300), displayName: 'd'.repeat(300) }, effort: 'e'.repeat(300) }))
    expect(r.ok && r.message.type === 'status' && [r.message.model.id.length, r.message.model.displayName.length, r.message.effort?.length]).toEqual([100, 100, 100])
  })

  it('rejects a status without model id or with bad ids', () => {
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'status', model: {} })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'status', tabId: 'x', model: { id: 'm' } })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'status', sessionId: 'x', model: { id: 'm' } })).ok).toBe(false)
  })

  it('accepts subagent start/stop and defaults agentType', () => {
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'subagent', event: 'start', agentId: 'a40a10c1d655cf759', agentType: 'Explore' }))).toEqual({
      ok: true,
      message: { ...ids, type: 'subagent', event: 'start', agentId: 'a40a10c1d655cf759', agentType: 'Explore' }
    })
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'subagent', event: 'stop', agentId: 'a1' }))).toEqual({
      ok: true,
      message: { ...ids, type: 'subagent', event: 'stop', agentId: 'a1', agentType: 'agent' }
    })
  })

  it('rejects a bad subagent event or agentId', () => {
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'subagent', event: 'pause', agentId: 'a1' })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'subagent', event: 'start', agentId: '../x' })).ok).toBe(false)
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'subagent', event: 'start', agentId: 'a'.repeat(65) })).ok).toBe(false)
  })

  it('accepts session_end and rejects it with a bad session id', () => {
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'session_end' }))).toEqual({ ok: true, message: { ...ids, type: 'session_end' } })
    expect(parsePipeMessage(JSON.stringify({ ...ids, type: 'session_end', sessionId: 'x' })).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Запустить — убедиться, что падает**

Run: `npx vitest run tests/unit/protocol.test.ts`
Expected: FAIL — новые тесты получают `{ ok: false, error: 'unknown message type: status' }` и т.п.

- [ ] **Step 3: Типы** — в конец `src/shared/types.ts`:

```ts
export interface MainStatus {
  model: { id: string; displayName: string }
  effort: string | null
  context: { usedTokens: number; size: number; usedPct: number } | null
  fiveHour: { usedPct: number; resetsAt: number } | null
}

export interface AgentStatus {
  agentId: string
  type: string
  description: string | null
  model: string | null
  effort: string | null
  startedAt: number
}
```

В `src/shared/ipc.ts` заменить строку импорта и добавить тип после `ImagesUpdate`:

```ts
import type { AgentStatus, ImageCard, MainStatus, OpenTabRequest, Settings, TabInfo } from './types'
```

```ts
export interface StatusUpdate {
  tabId: string
  main: MainStatus | null
  agents: AgentStatus[]
}
```

- [ ] **Step 4: Протокол** — в `src/shared/protocol.ts`:

Импорт и константы в начало файла (после существующих констант):

```ts
import type { MainStatus } from './types'
```

```ts
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_LABEL = 100
```

Новые типы после `SessionMessage`, и обновлённый `PipeMessage`:

```ts
export interface StatusMessage extends MainStatus {
  v: 1
  type: 'status'
  tabId: string
  sessionId: string
}

export interface SubagentMessage {
  v: 1
  type: 'subagent'
  tabId: string
  sessionId: string
  event: 'start' | 'stop'
  agentId: string
  agentType: string
}

export interface SessionEndMessage {
  v: 1
  type: 'session_end'
  tabId: string
  sessionId: string
}

export type PipeMessage = ShowImageMessage | SessionMessage | StatusMessage | SubagentMessage | SessionEndMessage
```

Помощники перед `parsePipeMessage`:

```ts
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const label = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_LABEL) : null)

function parseContext(v: unknown): MainStatus['context'] {
  if (!isObj(v) || !isNum(v.usedTokens) || !isNum(v.size) || v.size <= 0 || !isNum(v.usedPct)) return null
  return { usedTokens: v.usedTokens, size: v.size, usedPct: v.usedPct }
}

function parseFiveHour(v: unknown): MainStatus['fiveHour'] {
  if (!isObj(v) || !isNum(v.usedPct) || !isNum(v.resetsAt)) return null
  return { usedPct: v.usedPct, resetsAt: v.resetsAt }
}
```

В `parsePipeMessage` перед финальным `return { ok: false, error: \`unknown message type: ...\` }`:

```ts
  if (m.type === 'status' || m.type === 'subagent' || m.type === 'session_end') {
    if (!isUuid(m.tabId)) return { ok: false, error: 'tabId must be a UUID' }
    if (!isUuid(m.sessionId)) return { ok: false, error: 'sessionId must be a UUID' }
    const ids = { tabId: m.tabId, sessionId: m.sessionId }
    if (m.type === 'session_end') return { ok: true, message: { v: 1, type: 'session_end', ...ids } }
    if (m.type === 'subagent') {
      if (m.event !== 'start' && m.event !== 'stop') return { ok: false, error: 'event must be "start" or "stop"' }
      if (typeof m.agentId !== 'string' || !AGENT_ID_RE.test(m.agentId)) return { ok: false, error: 'agentId must match [A-Za-z0-9_-]{1,64}' }
      return { ok: true, message: { v: 1, type: 'subagent', ...ids, event: m.event, agentId: m.agentId, agentType: label(m.agentType) ?? 'agent' } }
    }
    const model: Obj = isObj(m.model) ? m.model : {}
    const id = label(model.id)
    if (!id) return { ok: false, error: 'model.id must be a non-empty string' }
    return {
      ok: true,
      message: { v: 1, type: 'status', ...ids, model: { id, displayName: label(model.displayName) ?? id }, effort: label(m.effort), context: parseContext(m.context), fiveHour: parseFiveHour(m.fiveHour) }
    }
  }
```

- [ ] **Step 5: Запустить тесты протокола — проходят**

Run: `npx vitest run tests/unit/protocol.test.ts`
Expected: PASS

- [ ] **Step 6: Падающий тест маршрутизации** — в `tests/integration/pipe.test.ts` заменить `okHandlers` и добавить тест в `describe('pipe server + client')`:

```ts
const okHandlers: PipeHandlers = {
  showImage: async () => ({ ok: true }),
  session: () => ({ ok: true }),
  status: () => ({ ok: true }),
  subagent: () => ({ ok: true }),
  sessionEnd: () => ({ ok: true })
}
```

```ts
  it('routes status, subagent and session_end messages', async () => {
    const pipe = newPipe()
    const got: string[] = []
    server = await startPipeServer(pipe, {
      ...okHandlers,
      status: (m) => { got.push(m.type); return { ok: true } },
      subagent: (m) => { got.push(`${m.type}:${m.event}`); return { ok: true } },
      sessionEnd: (m) => { got.push(m.type); return { ok: false, error: 'unknown claude tab' } }
    })
    expect(await sendPipeMessage(pipe, { v: 1, type: 'status', tabId: TAB, sessionId: SID, model: { id: 'm', displayName: 'M' }, effort: null, context: null, fiveHour: null })).toEqual({ ok: true })
    expect(await sendPipeMessage(pipe, { v: 1, type: 'subagent', tabId: TAB, sessionId: SID, event: 'start', agentId: 'a1', agentType: 'Explore' })).toEqual({ ok: true })
    expect(await sendPipeMessage(pipe, { v: 1, type: 'session_end', tabId: TAB, sessionId: SID })).toEqual({ ok: false, error: 'unknown claude tab' })
    expect(got).toEqual(['status', 'subagent:start', 'session_end'])
  })
```

Run: `npx vitest run tests/integration/pipe.test.ts`
Expected: FAIL — новый тест: `h.session is not a function`-подобная ошибка или `got` пустой (сервер шлёт всё не-`show_image` в `session`).

- [ ] **Step 7: Маршрутизация** — в `src/main/pipe-server.ts` заменить импорт, `PipeHandlers` и `handleLine`:

```ts
import { encodeMessage, parsePipeMessage, type PipeResponse, type SessionEndMessage, type SessionMessage, type ShowImageMessage, type StatusMessage, type SubagentMessage } from '../shared/protocol'

export interface PipeHandlers {
  showImage(msg: ShowImageMessage): Promise<PipeResponse>
  session(msg: SessionMessage): PipeResponse
  status(msg: StatusMessage): PipeResponse
  subagent(msg: SubagentMessage): PipeResponse
  sessionEnd(msg: SessionEndMessage): PipeResponse
}
```

```ts
async function handleLine(line: string, h: PipeHandlers): Promise<PipeResponse> {
  const parsed = parsePipeMessage(line)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const m = parsed.message
  try {
    switch (m.type) {
      case 'show_image': return await h.showImage(m)
      case 'session': return h.session(m)
      case 'status': return h.status(m)
      case 'subagent': return h.subagent(m)
      case 'session_end': return h.sessionEnd(m)
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
```

- [ ] **Step 8: Обновить остальные места, создающие `PipeHandlers`**, чтобы прошёл typecheck:
  - `tests/integration/mcp.int.test.ts:21` — объект обработчиков дополнить `status: () => ({ ok: true }), subagent: () => ({ ok: true }), sessionEnd: () => ({ ok: true })`.
  - `tests/integration/session-hook.int.test.ts:44` — так же дополнить объект обработчиков в `listen()` (Task 4 перепишет `listen()` целиком).
  - `src/main/index.ts` — в объект `startPipeServer(pipeName, { ... })` временно добавить заглушки (Task 8 заменит их настоящими):

```ts
    status: () => ({ ok: false, error: 'not implemented' }),
    subagent: () => ({ ok: false, error: 'not implemented' }),
    sessionEnd: () => ({ ok: false, error: 'not implemented' })
```

- [ ] **Step 9: Проверка**

Run: `npx vitest run tests/unit/protocol.test.ts tests/integration/pipe.test.ts tests/integration/mcp.int.test.ts tests/integration/session-hook.int.test.ts && npm run typecheck`
Expected: PASS, typecheck без ошибок.

- [ ] **Step 10: Checkpoint** (без коммита).

---

### Task 3: Скрипт хука — statusLine и события сабагентов

**Files:**
- Create: `src/hook/status-line.ts`
- Modify: `src/hook/session-hook.ts` (переписать целиком)
- Modify: `src/hook/main.ts` (переписать целиком)
- Create: `tests/unit/status-line.test.ts`
- Modify: `tests/unit/session-hook.test.ts`

**Interfaces:**
- Consumes: `StatusMessage`, `PipeMessage`, `PipeResponse`, `isUuid`, `defaultPipeName` (Task 2).
- Produces:
  - `statusFromStatusLine(input: unknown, tabId: string): StatusMessage | null`
  - `type Sender = (pipeName: string, msg: PipeMessage) => Promise<PipeResponse>`
  - `hookMessage(input: Record<string, unknown>, tabId: string): PipeMessage | null`
  - `runSessionHook(stdinText: string, env: NodeJS.ProcessEnv, send: Sender): Promise<boolean>` (теперь все хук-события)
  - `runStatusLine(stdinText: string, env: NodeJS.ProcessEnv, send: Sender): Promise<boolean>`
  - бандл `session-hook.js`: аргумент `status` → ветка statusLine.

- [ ] **Step 1: Падающие тесты `statusFromStatusLine`** — `tests/unit/status-line.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { statusFromStatusLine } from '../../src/hook/status-line'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

// shape from code.claude.com/docs/en/statusline
const full = {
  session_id: SID,
  transcript_path: 'C:\\Users\\me\\.claude\\projects\\D--x\\s.jsonl',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  effort: { level: 'xhigh' },
  context_window: {
    total_input_tokens: 90000,
    total_output_tokens: 4000,
    context_window_size: 200000,
    used_percentage: 41.2,
    remaining_percentage: 58.8,
    current_usage: { input_tokens: 14, output_tokens: 500, cache_creation_input_tokens: 2300, cache_read_input_tokens: 80000 }
  },
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1790000000 }, seven_day: { used_percentage: 41.2, resets_at: 1790500000 } }
}

describe('statusFromStatusLine', () => {
  it('maps the documented fields; context counts input tokens only', () => {
    expect(statusFromStatusLine(full, TAB)).toEqual({
      v: 1,
      type: 'status',
      tabId: TAB,
      sessionId: SID,
      model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
      effort: 'xhigh',
      context: { usedTokens: 82314, size: 200000, usedPct: 41.2 },
      fiveHour: { usedPct: 23.5, resetsAt: 1790000000 }
    })
  })

  it('early in a session: no effort, no usage, no rate limits', () => {
    const input = { session_id: SID, model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' }, context_window: { context_window_size: 200000, used_percentage: null, current_usage: null } }
    expect(statusFromStatusLine(input, TAB)).toEqual({
      v: 1, type: 'status', tabId: TAB, sessionId: SID,
      model: { id: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
      effort: null, context: null, fiveHour: null
    })
  })

  it('computes the percentage when used_percentage is null', () => {
    const input = { ...full, context_window: { context_window_size: 200000, used_percentage: null, current_usage: { input_tokens: 50000 } } }
    expect(statusFromStatusLine(input, TAB)?.context).toEqual({ usedTokens: 50000, size: 200000, usedPct: 25 })
  })

  it('drops a five_hour window without resets_at and defaults displayName to the id', () => {
    const input = { ...full, model: { id: 'claude-opus-5-5' }, rate_limits: { five_hour: { used_percentage: 10 } } }
    const s = statusFromStatusLine(input, TAB)
    expect(s?.fiveHour).toBe(null)
    expect(s?.model).toEqual({ id: 'claude-opus-5-5', displayName: 'claude-opus-5-5' })
  })

  it('returns null without a session id or a model id, or for non-objects', () => {
    expect(statusFromStatusLine({ ...full, session_id: 'x' }, TAB)).toBe(null)
    expect(statusFromStatusLine({ ...full, model: {} }, TAB)).toBe(null)
    expect(statusFromStatusLine([1], TAB)).toBe(null)
    expect(statusFromStatusLine(null, TAB)).toBe(null)
  })
})
```

- [ ] **Step 2: Падающие тесты диспетчера** — в `tests/unit/session-hook.test.ts` заменить строку импорта на `import { runSessionHook, runStatusLine } from '../../src/hook/session-hook'` и добавить в конец файла:

```ts
const ENV = { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: '\\\\.\\pipe\\x' }
const AGENT = 'a40a10c1d655cf759'

describe('runSessionHook: other hook events', () => {
  it('maps SubagentStart and SubagentStop to subagent messages', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'SubagentStart', agent_id: AGENT, agent_type: 'Explore' }), ENV, send)
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'SubagentStop', agent_id: AGENT, agent_type: 'Explore', effort: 'high' }), ENV, send)
    expect(send).toHaveBeenNthCalledWith(1, '\\\\.\\pipe\\x', { v: 1, type: 'subagent', tabId: TAB, sessionId: SID, event: 'start', agentId: AGENT, agentType: 'Explore' })
    expect(send).toHaveBeenNthCalledWith(2, '\\\\.\\pipe\\x', { v: 1, type: 'subagent', tabId: TAB, sessionId: SID, event: 'stop', agentId: AGENT, agentType: 'Explore' })
  })

  it('maps SessionEnd to session_end', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    expect(await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'SessionEnd', reason: 'clear' }), ENV, send)).toBe(true)
    expect(send).toHaveBeenCalledWith('\\\\.\\pipe\\x', { v: 1, type: 'session_end', tabId: TAB, sessionId: SID })
  })

  it('ignores other events and subagent events without agent_id', async () => {
    const send = vi.fn()
    expect(await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse' }), ENV, send)).toBe(false)
    expect(await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'SubagentStart' }), ENV, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('runStatusLine', () => {
  const input = JSON.stringify({ session_id: SID, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } })

  it('sends the status for the tab', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    expect(await runStatusLine(input, ENV, send)).toBe(true)
    expect(send).toHaveBeenCalledWith('\\\\.\\pipe\\x', {
      v: 1, type: 'status', tabId: TAB, sessionId: SID,
      model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: null, context: null, fiveHour: null
    })
  })

  it('does nothing outside a tab or for bad stdin, and swallows send failures', async () => {
    const send = vi.fn()
    expect(await runStatusLine(input, {}, send)).toBe(false)
    expect(await runStatusLine('not json', ENV, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
    await expect(runStatusLine(input, ENV, async () => { throw new Error('no pipe') })).resolves.toBe(false)
  })
})
```

- [ ] **Step 3: Запустить — падает**

Run: `npx vitest run tests/unit/status-line.test.ts tests/unit/session-hook.test.ts`
Expected: FAIL — `Cannot find module '../../src/hook/status-line'` / `runStatusLine is not a function`.

- [ ] **Step 4: `src/hook/status-line.ts`**

```ts
import { isUuid, type StatusMessage } from '../shared/protocol'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/** The fields ClaudeTerm shows, taken from the JSON Claude Code passes to a statusLine command (code.claude.com/docs/en/statusline). */
export function statusFromStatusLine(input: unknown, tabId: string): StatusMessage | null {
  const i = obj(input)
  const sessionId = i?.session_id
  const model = obj(i?.model)
  const id = str(model?.id)
  if (!i || !isUuid(sessionId) || !id) return null
  const cw = obj(i.context_window)
  const size = num(cw?.context_window_size)
  const usage = obj(cw?.current_usage)
  let context: StatusMessage['context'] = null
  if (usage && size !== null && size > 0) {
    // same input-only formula as used_percentage
    const usedTokens = (num(usage.input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0)
    context = { usedTokens, size, usedPct: num(cw?.used_percentage) ?? (usedTokens / size) * 100 }
  }
  const fiveHour = obj(obj(i.rate_limits)?.five_hour)
  const usedPct = num(fiveHour?.used_percentage)
  const resetsAt = num(fiveHour?.resets_at)
  return {
    v: 1,
    type: 'status',
    tabId,
    sessionId,
    model: { id, displayName: str(model?.display_name) ?? id },
    effort: str(obj(i.effort)?.level),
    context,
    fiveHour: usedPct !== null && resetsAt !== null ? { usedPct, resetsAt } : null
  }
}
```

- [ ] **Step 5: `src/hook/session-hook.ts`** — заменить целиком:

```ts
import { userInfo } from 'node:os'
import { defaultPipeName, isUuid, type PipeMessage, type PipeResponse } from '../shared/protocol'
import { statusFromStatusLine } from './status-line'

export type Sender = (pipeName: string, msg: PipeMessage) => Promise<PipeResponse>

type Obj = Record<string, unknown>

function parseInput(stdinText: string): Obj | null {
  try {
    const v: unknown = JSON.parse(stdinText)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : null
  } catch {
    return null
  }
}

/** Pipe message for a hook event; SessionStart is assumed when hook_event_name is missing. */
export function hookMessage(input: Obj, tabId: string): PipeMessage | null {
  const sessionId = input.session_id
  if (!isUuid(sessionId)) return null
  const event = input.hook_event_name ?? 'SessionStart'
  if (event === 'SessionStart') {
    return {
      v: 1,
      type: 'session',
      tabId,
      sessionId,
      source: typeof input.source === 'string' ? input.source : 'unknown',
      transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : null
    }
  }
  if (event === 'SubagentStart' || event === 'SubagentStop') {
    if (typeof input.agent_id !== 'string' || input.agent_id === '') return null
    return {
      v: 1,
      type: 'subagent',
      tabId,
      sessionId,
      event: event === 'SubagentStart' ? 'start' : 'stop',
      agentId: input.agent_id,
      agentType: typeof input.agent_type === 'string' ? input.agent_type : 'agent'
    }
  }
  if (event === 'SessionEnd') return { v: 1, type: 'session_end', tabId, sessionId }
  return null
}

async function deliver(msg: PipeMessage, env: NodeJS.ProcessEnv, send: Sender): Promise<boolean> {
  try {
    await send(env.CLAUDETERM_PIPE || defaultPipeName(userInfo().username), msg)
    return true
  } catch {
    return false
  }
}

export async function runSessionHook(stdinText: string, env: NodeJS.ProcessEnv, send: Sender): Promise<boolean> {
  const tabId = env.CLAUDETERM_TAB_ID
  if (!isUuid(tabId)) return false
  const input = parseInput(stdinText)
  const msg = input ? hookMessage(input, tabId) : null
  return msg ? deliver(msg, env, send) : false
}

export async function runStatusLine(stdinText: string, env: NodeJS.ProcessEnv, send: Sender): Promise<boolean> {
  const tabId = env.CLAUDETERM_TAB_ID
  if (!isUuid(tabId)) return false
  const input = parseInput(stdinText)
  const msg = input ? statusFromStatusLine(input, tabId) : null
  return msg ? deliver(msg, env, send) : false
}
```

- [ ] **Step 6: `src/hook/main.ts`** — заменить целиком:

```ts
import { sendPipeMessage } from '../shared/pipe-client'
import { runSessionHook, runStatusLine } from './session-hook'

// Never write to stdout: SessionStart hook stdout is added to Claude's context, and statusLine stdout
// is shown in Claude's own status row (kept empty: ClaudeTerm shows the data in its status bar).
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

const statusLine = process.argv.slice(2).includes('status')

Promise.resolve()
  .then(() => readStdin(3000))
  .then((text) =>
    statusLine
      ? runStatusLine(text, process.env, (pipe, msg) => sendPipeMessage(pipe, msg, 1000))
      : runSessionHook(text, process.env, (pipe, msg) => sendPipeMessage(pipe, msg, 2000))
  )
  .catch(() => false)
  .finally(() => process.exit(0))
```

- [ ] **Step 7: Тесты проходят**

Run: `npx vitest run tests/unit/status-line.test.ts tests/unit/session-hook.test.ts && npm run typecheck`
Expected: PASS (включая четыре старых теста `runSessionHook`), typecheck чистый.

- [ ] **Step 8: Checkpoint** (без коммита).

---

### Task 4: `claude-tab-settings.json` — statusLine и хуки, сквозной тест

**Files:**
- Modify: `src/main/claude-tab-settings.ts` (`hookCmdContent`, `claudeTabSettingsJson`)
- Modify: `tests/unit/claude-tab-settings.test.ts`
- Modify: `tests/integration/session-hook.int.test.ts`

**Interfaces:**
- Consumes: бандл хука из Task 3 (`src/hook/main.ts`), `PipeHandlers` (Task 2).
- Produces: `.cmd` передаёт аргументы (`%*`); `claudeTabSettingsJson(cmdPath)` возвращает `{ statusLine, hooks: { SessionStart, SubagentStart, SubagentStop, SessionEnd } }` (см. Global Constraints).

- [ ] **Step 1: Обновить юнит-тесты на новое поведение** — в `tests/unit/claude-tab-settings.test.ts`:

В тесте `hookCmdContent runs the script under ELECTRON_RUN_AS_NODE and always exits 0` строку запуска заменить на:

```ts
      '"C:\\Program Files\\ClaudeTerm\\ClaudeTerm.exe" "C:\\Program Files\\ClaudeTerm\\resources\\hook\\session-hook.js" %*',
```

Тест `claudeTabSettingsJson declares one SessionStart command hook` заменить на:

```ts
  it('claudeTabSettingsJson declares the statusLine and the session/subagent hooks', () => {
    const command = '"C:/Users/me/AppData/Roaming/ClaudeTerm/session-hook.cmd"'
    const hook = [{ hooks: [{ type: 'command', command, timeout: 10 }] }]
    expect(JSON.parse(claudeTabSettingsJson('C:\\Users\\me\\AppData\\Roaming\\ClaudeTerm\\session-hook.cmd'))).toEqual({
      statusLine: { type: 'command', command: `${command} status`, refreshInterval: 5 },
      hooks: { SessionStart: hook, SubagentStart: hook, SubagentStop: hook, SessionEnd: hook }
    })
  })
```

- [ ] **Step 2: Запустить — падает**

Run: `npx vitest run tests/unit/claude-tab-settings.test.ts`
Expected: FAIL — нет `%*` и нет `statusLine`/новых хуков.

- [ ] **Step 3: Реализация** — в `src/main/claude-tab-settings.ts`:

В `hookCmdContent` строку запуска заменить на:

```ts
  return ['@echo off', 'chcp 65001 >nul 2>&1', 'set ELECTRON_RUN_AS_NODE=1', `"${esc(execPath)}" "${esc(hookScriptPath)}" %*`, 'exit /b 0', ''].join('\r\n')
```

`claudeTabSettingsJson` заменить на:

```ts
export function claudeTabSettingsJson(cmdPath: string): string {
  const command = hookCommandString(cmdPath)
  const hook = [{ hooks: [{ type: 'command', command, timeout: 10 }] }]
  return JSON.stringify(
    {
      // refreshInterval: Claude Code re-runs statusLine only on new messages, /compact and mode changes,
      // so /effort and /model alone would not show up without it
      statusLine: { type: 'command', command: `${command} status`, refreshInterval: 5 },
      hooks: { SessionStart: hook, SubagentStart: hook, SubagentStop: hook, SessionEnd: hook }
    },
    null,
    2
  )
}
```

- [ ] **Step 4: Юнит-тесты проходят**

Run: `npx vitest run tests/unit/claude-tab-settings.test.ts`
Expected: PASS

- [ ] **Step 5: Сквозные тесты** — в `tests/integration/session-hook.int.test.ts`:

Импорты: `import { existsSync, mkdtempSync, readFileSync } from 'node:fs'` и `import type { PipeMessage, PipeResponse } from '../../src/shared/protocol'` (вместо импорта `SessionMessage`).

Константы после `INPUT`:

```ts
const AGENT = 'a40a10c1d655cf759'
const STATUS_INPUT = JSON.stringify({
  session_id: SID,
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  effort: { level: 'xhigh' },
  context_window: { context_window_size: 200000, used_percentage: 41.2, current_usage: { input_tokens: 14, cache_creation_input_tokens: 2300, cache_read_input_tokens: 80000 } }
})
const SUBAGENT_INPUT = JSON.stringify({ session_id: SID, hook_event_name: 'SubagentStart', agent_id: AGENT, agent_type: 'Explore' })
const expectedStatus = {
  v: 1, type: 'status', tabId: TAB, sessionId: SID,
  model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: 'xhigh',
  context: { usedTokens: 82314, size: 200000, usedPct: 41.2 }, fiveHour: null
}
```

`run` и `listen` заменить на:

```ts
function run(file: string, args: string[], env: Record<string, string>, input = INPUT): Promise<{ code: number | null; stdout: string }> {
  return new Promise((res) => {
    const p = spawn(file, args, { env: { ...(process.env as Record<string, string>), ...env }, windowsHide: true })
    let stdout = ''
    p.stdout.on('data', (d) => { stdout += String(d) })
    p.on('close', (code) => res({ code, stdout }))
    p.stdin.end(input)
  })
}

async function listen(): Promise<{ pipe: string; got: PipeMessage[] }> {
  const pipe = `\\\\.\\pipe\\claudeterm-test-${randomUUID()}`
  const got: PipeMessage[] = []
  const take = (m: PipeMessage): PipeResponse => {
    got.push(m)
    return { ok: true }
  }
  server = await startPipeServer(pipe, { showImage: async () => ({ ok: true }), session: take, status: take, subagent: take, sessionEnd: take })
  return { pipe, got }
}
```

Новые тесты в конец `describe('session hook end to end')`:

```ts
  it('statusLine via the generated .cmd: forwards the status and prints nothing', async () => {
    const { pipe, got } = await listen()
    const { cmdPath } = writeClaudeTabFiles(join(work, 'data-status'), process.execPath, bundle)
    const r = await run('cmd.exe', ['/d', '/c', cmdPath, 'status'], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }, STATUS_INPUT)
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([expectedStatus])
  })

  it.skipIf(!existsSync(GIT_BASH))('the statusLine command string from the settings file runs from Git Bash', async () => {
    const { pipe, got } = await listen()
    const { settingsPath } = writeClaudeTabFiles(join(work, "Bob's status"), process.execPath, bundle)
    const command = (JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine: { command: string } }).statusLine.command
    const r = await run(GIT_BASH, ['-c', command], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }, STATUS_INPUT)
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([expectedStatus])
  })

  it('SubagentStart via the generated .cmd forwards a subagent message', async () => {
    const { pipe, got } = await listen()
    const { cmdPath } = writeClaudeTabFiles(join(work, 'data-sub'), process.execPath, bundle)
    const r = await run('cmd.exe', ['/d', '/c', cmdPath], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }, SUBAGENT_INPUT)
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([{ v: 1, type: 'subagent', tabId: TAB, sessionId: SID, event: 'start', agentId: AGENT, agentType: 'Explore' }])
  })
```

- [ ] **Step 6: Проверка**

Run: `npx vitest run tests/integration/session-hook.int.test.ts tests/unit/claude-tab-settings.test.ts && npm run typecheck`
Expected: PASS (старые 6 тестов + 3 новых; тесты Git Bash пропускаются, если его нет).

- [ ] **Step 7: Checkpoint** (без коммита).

---

### Task 5: Model·effort и описание сабагентов из транскриптов

**Files:**
- Create: `src/main/transcript-agent-info.ts`
- Modify: `src/main/transcript-feed.ts`
- Modify: `tests/fixtures/transcript.ts`
- Create: `tests/unit/transcript-agent-info.test.ts`
- Modify: `tests/integration/transcript-feed.int.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `interface AgentModelInfo { model: string; effort: string | null }`
  - `interface AgentMeta { description: string | null; toolUseId: string | null; background: boolean }`
  - `assistantInfo(line: string): AgentModelInfo | null`
  - `readAgentMeta(subagentDir: string, agentId: string): AgentMeta | null`
  - `TranscriptFeedOptions.onSubagentInfo?(agentId: string, info: AgentModelInfo): void` — для строк `subagents/agent-<agentId>.jsonl`, только при изменении пары model·effort.
  - фикстура `assistantLine(model: string, effort?: string): string`

- [ ] **Step 1: Фикстура** — в конец `tests/fixtures/transcript.ts`:

```ts
export function assistantLine(model: string, effort?: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-10-05T10:00:03.000Z',
    ...(effort ? { effort, perTurnEffort: effort } : { perTurnEffort: null }),
    message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] }
  })
}
```

- [ ] **Step 2: Падающие юнит-тесты** — `tests/unit/transcript-agent-info.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assistantInfo, readAgentMeta } from '../../src/main/transcript-agent-info'
import { assistantLine, textLine, toolResultLine } from '../fixtures/transcript'

describe('assistantInfo', () => {
  it('returns model and effort of an assistant line', () => {
    expect(assistantInfo(assistantLine('claude-opus-5-5', 'xhigh'))).toEqual({ model: 'claude-opus-5-5', effort: 'xhigh' })
  })

  it('effort is null for models without it (Haiku)', () => {
    expect(assistantInfo(assistantLine('claude-haiku-4-5-20251001'))).toEqual({ model: 'claude-haiku-4-5-20251001', effort: null })
  })

  it('falls back to perTurnEffort', () => {
    const line = JSON.stringify({ type: 'assistant', perTurnEffort: 'high', message: { model: 'claude-sonnet-5-5' } })
    expect(assistantInfo(line)).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' })
  })

  it('ignores synthetic messages, lines without a model, other line types and bad JSON', () => {
    expect(assistantInfo(assistantLine('<synthetic>'))).toBe(null)
    expect(assistantInfo(textLine)).toBe(null)
    expect(assistantInfo(toolResultLine('toolu_1'))).toBe(null)
    expect(assistantInfo('{not json')).toBe(null)
  })
})

describe('readAgentMeta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-meta-'))

  it('reads description, toolUseId and background flag', () => {
    writeFileSync(join(dir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find asar users', toolUseId: 'toolu_1', requestShape: 'background' }))
    expect(readAgentMeta(dir, 'a1')).toEqual({ description: 'Find asar users', toolUseId: 'toolu_1', background: true })
  })

  it('truncates long descriptions and tolerates missing fields', () => {
    writeFileSync(join(dir, 'agent-a2.meta.json'), JSON.stringify({ description: 'd'.repeat(500) }))
    expect(readAgentMeta(dir, 'a2')).toEqual({ description: 'd'.repeat(200), toolUseId: null, background: false })
  })

  it('returns null for a missing or broken file', () => {
    expect(readAgentMeta(dir, 'nope')).toBe(null)
    writeFileSync(join(dir, 'agent-a3.meta.json'), '{oops')
    expect(readAgentMeta(dir, 'a3')).toBe(null)
  })
})
```

Run: `npx vitest run tests/unit/transcript-agent-info.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/transcript-agent-info'`.

- [ ] **Step 3: `src/main/transcript-agent-info.ts`**

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface AgentModelInfo {
  model: string
  effort: string | null
}

export interface AgentMeta {
  description: string | null
  toolUseId: string | null
  background: boolean
}

const MAX_DESCRIPTION = 200

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

function parseObj(text: string): Obj | null {
  try {
    const v: unknown = JSON.parse(text)
    return isObj(v) ? v : null
  } catch {
    return null
  }
}

/** Model and effort of an assistant transcript line; null for other lines and synthetic messages ("<synthetic>"). */
export function assistantInfo(line: string): AgentModelInfo | null {
  const o = parseObj(line)
  if (!o || o.type !== 'assistant' || !isObj(o.message)) return null
  const model = str(o.message.model)
  if (!model || model.startsWith('<')) return null
  return { model, effort: str(o.effort) ?? str(o.perTurnEffort) }
}

/** subagents/agent-<agentId>.meta.json written by Claude Code next to the subagent transcript. */
export function readAgentMeta(subagentDir: string, agentId: string): AgentMeta | null {
  let o: Obj | null
  try {
    o = parseObj(readFileSync(join(subagentDir, `agent-${agentId}.meta.json`), 'utf8'))
  } catch {
    return null
  }
  if (!o) return null
  return { description: str(o.description)?.slice(0, MAX_DESCRIPTION) ?? null, toolUseId: str(o.toolUseId), background: o.requestShape === 'background' }
}
```

Run: `npx vitest run tests/unit/transcript-agent-info.test.ts`
Expected: PASS

- [ ] **Step 4: Падающий тест фида** — в `tests/integration/transcript-feed.int.test.ts`:

Импорты: добавить `assistantLine` в импорт из `../fixtures/transcript` и `import type { AgentModelInfo } from '../../src/main/transcript-agent-info'`.

В `setup()` добавить сбор и колбэк, вернуть `infos`:

```ts
  const infos: [string, AgentModelInfo][] = []
  const feed = new TranscriptFeed({
    transcriptPath, sessionId: SID, cacheRoot, fileExists: existsSync,
    onImage: (i) => images.push(i), onError: (m) => errors.push(m),
    onSubagentInfo: (id, info) => infos.push([id, info])
  })
  return { root, projectDir, transcriptPath, cacheRoot, images, errors, infos, feed }
```

Новый тест рядом с `picks up subagent transcripts`:

```ts
  it('reports model and effort of a subagent once per change, ignoring synthetic lines and the main transcript', async () => {
    const { transcriptPath, infos, feed } = setup()
    writeFileSync(transcriptPath, assistantLine('claude-opus-5-5', 'xhigh') + '\n')
    mkdirSync(feed.subagentDir, { recursive: true })
    const sub = join(feed.subagentDir, 'agent-a40a10c1d655cf759.jsonl')
    writeFileSync(sub, [assistantLine('claude-sonnet-5-5', 'medium'), assistantLine('claude-sonnet-5-5', 'medium'), assistantLine('<synthetic>'), ''].join('\n'))
    feed.scanSubagents()
    await feed.poll()
    expect(infos).toEqual([['a40a10c1d655cf759', { model: 'claude-sonnet-5-5', effort: 'medium' }]])
    appendFileSync(sub, assistantLine('claude-sonnet-5-5', 'high') + '\n')
    await feed.poll()
    expect(infos.map(([, i]) => i.effort)).toEqual(['medium', 'high'])
  })
```

Run: `npx vitest run tests/integration/transcript-feed.int.test.ts`
Expected: FAIL — `infos` пустой (typecheck тоже ругается на неизвестную опцию `onSubagentInfo`).

- [ ] **Step 5: Реализация в `src/main/transcript-feed.ts`**

Импорт: `import { assistantInfo, type AgentModelInfo } from './transcript-agent-info'`.

В `TranscriptFeedOptions` добавить:

```ts
  /** model·effort of a subagent (from subagents/agent-<agentId>.jsonl), reported when it changes */
  onSubagentInfo?(agentId: string, info: AgentModelInfo): void
```

`interface Source` заменить на:

```ts
interface Source {
  tailer: LineTailer
  parser: TranscriptParser
  /** null for the main transcript */
  agentId: string | null
  lastInfo: string | null
}
```

В конструкторе: `this.main = { tailer: new LineTailer(o.transcriptPath), parser: new TranscriptParser({ subagent: false }), agentId: null, lastInfo: null }`.

В `scanSubagents()` строку `this.subagents.set(...)` заменить на:

```ts
      const agentId = n.startsWith('agent-') ? n.slice('agent-'.length, -'.jsonl'.length) : n.slice(0, -'.jsonl'.length)
      this.subagents.set(n, { tailer: new LineTailer(join(this.subagentDir, n)), parser: new TranscriptParser({ subagent: true }), agentId, lastInfo: null })
```

В `consume()` первой строкой тела цикла после `if (this.stopped) return` добавить `this.reportInfo(src, line)`, и добавить метод:

```ts
  private reportInfo(src: Source, line: string): void {
    if (src.agentId === null || !this.o.onSubagentInfo) return
    const info = assistantInfo(line)
    if (!info) return
    const key = `${info.model}|${info.effort ?? ''}`
    if (key === src.lastInfo) return
    src.lastInfo = key
    try {
      this.o.onSubagentInfo(src.agentId, info)
    } catch (e) {
      this.report(e)
    }
  }
```

- [ ] **Step 6: Проверка**

Run: `npx vitest run tests/integration/transcript-feed.int.test.ts tests/unit/transcript-agent-info.test.ts && npm run typecheck`
Expected: PASS (все старые тесты фида тоже).

- [ ] **Step 7: Checkpoint** (без коммита).

---

### Task 6: `StatusHub` — состояние статуса по вкладкам

**Files:**
- Create: `src/main/status-hub.ts`
- Create: `tests/unit/status-hub.test.ts`

**Interfaces:**
- Consumes: `MainStatus`, `AgentStatus` (types.ts), `StatusUpdate` (ipc.ts), `StatusMessage`, `SubagentMessage` (Task 2); `AgentMeta`, `AgentModelInfo` (Task 5).
- Produces:

```ts
interface StatusHubDeps { now(): number; readMeta(tabId: string, agentId: string): AgentMeta | null; onChange(tabId: string): void }
class StatusHub {
  constructor(deps: StatusHubDeps)
  session(tabId: string, sessionId: string): void
  status(m: StatusMessage): void
  subagent(m: SubagentMessage): void
  subagentInfo(tabId: string, agentId: string, info: AgentModelInfo): void
  sessionEnd(tabId: string, sessionId: string): void
  removeTab(tabId: string): void
  get(tabId: string): StatusUpdate
}
```

- [ ] **Step 1: Падающие тесты** — `tests/unit/status-hub.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { StatusHub } from '../../src/main/status-hub'
import type { AgentMeta } from '../../src/main/transcript-agent-info'
import type { StatusMessage, SubagentMessage } from '../../src/shared/protocol'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const TAB2 = '1c9f9d2f-4a8b-4d52-8e1b-3c7a2b8f0d22'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const SID2 = '6e3d2c8b-9f5a-4b4c-a2d3-e4f5a6b7c8d9'

const status = (over: Partial<StatusMessage> = {}): StatusMessage => ({
  v: 1, type: 'status', tabId: TAB, sessionId: SID,
  model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: 'xhigh', context: null, fiveHour: null,
  ...over
})
const sub = (event: 'start' | 'stop', agentId: string, over: Partial<SubagentMessage> = {}): SubagentMessage => ({
  v: 1, type: 'subagent', tabId: TAB, sessionId: SID, event, agentId, agentType: 'Explore', ...over
})

function makeHub(meta: Record<string, AgentMeta> = {}) {
  let now = 1000
  const changes: string[] = []
  const hub = new StatusHub({ now: () => now, readMeta: (_tab, id) => meta[id] ?? null, onChange: (t) => changes.push(t) })
  return { hub, changes, meta, tick: (ms: number) => { now += ms } }
}
const meta = (description: string): AgentMeta => ({ description, toolUseId: null, background: false })

describe('StatusHub', () => {
  it('status sets the main part and notifies', () => {
    const { hub, changes } = makeHub()
    hub.status(status())
    expect(hub.get(TAB)).toEqual({ tabId: TAB, main: { model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: 'xhigh', context: null, fiveHour: null }, agents: [] })
    expect(changes).toEqual([TAB])
  })

  it('start adds an agent with its description, stop removes it', () => {
    const { hub, changes } = makeHub({ a1: meta('Find asar users') })
    hub.status(status())
    hub.subagent(sub('start', 'a1'))
    expect(hub.get(TAB).agents).toEqual([{ agentId: 'a1', type: 'Explore', description: 'Find asar users', model: null, effort: null, startedAt: 1000 }])
    hub.subagent(sub('stop', 'a1'))
    expect(hub.get(TAB).agents).toEqual([])
    expect(changes).toEqual([TAB, TAB, TAB])
  })

  it('model·effort seen before the start hook is applied on start', () => {
    const { hub } = makeHub()
    hub.session(TAB, SID)
    hub.subagentInfo(TAB, 'a1', { model: 'claude-sonnet-5-5', effort: 'medium' })
    hub.subagent(sub('start', 'a1'))
    expect(hub.get(TAB).agents[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
  })

  it('model·effort after start updates the agent and retries a description that was not there yet', () => {
    const { hub, meta: m } = makeHub()
    hub.session(TAB, SID)
    hub.subagent(sub('start', 'a1'))
    expect(hub.get(TAB).agents[0].description).toBe(null)
    m.a1 = meta('Review font fix')
    hub.subagentInfo(TAB, 'a1', { model: 'claude-opus-5-5', effort: 'high' })
    expect(hub.get(TAB).agents[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', description: 'Review font fix' })
  })

  it('a new session via status or SessionStart drops the previous main part and agents', () => {
    const { hub } = makeHub()
    hub.status(status())
    hub.subagent(sub('start', 'a1'))
    hub.status(status({ sessionId: SID2 }))
    expect(hub.get(TAB).agents).toEqual([])
    hub.subagent(sub('start', 'a2', { sessionId: SID2 }))
    hub.session(TAB, SID)
    expect(hub.get(TAB)).toEqual({ tabId: TAB, main: null, agents: [] })
  })

  it('late hooks of a previous session leave the new session alone', () => {
    const { hub } = makeHub()
    hub.status(status())
    hub.subagent(sub('start', 'a1'))
    hub.sessionEnd(TAB, SID)
    hub.session(TAB, SID2)
    hub.status(status({ sessionId: SID2, effort: 'low' }))
    hub.subagent(sub('start', 'a2', { sessionId: SID2 }))
    hub.subagent(sub('stop', 'a1'))
    hub.status(status())
    expect(hub.get(TAB).main?.effort).toBe('low')
    expect(hub.get(TAB).agents.map((a) => a.agentId)).toEqual(['a2'])
  })

  it('an ended session is accepted again after it starts again (resume)', () => {
    const { hub } = makeHub()
    hub.status(status())
    hub.sessionEnd(TAB, SID)
    expect(hub.get(TAB).main).toBe(null)
    hub.session(TAB, SID)
    hub.status(status())
    expect(hub.get(TAB).main).not.toBe(null)
  })

  it('SessionEnd clears the tab only for its current session', () => {
    const { hub } = makeHub()
    hub.status(status())
    hub.sessionEnd(TAB, SID2)
    expect(hub.get(TAB).main).not.toBe(null)
    hub.sessionEnd(TAB, SID)
    expect(hub.get(TAB)).toEqual({ tabId: TAB, main: null, agents: [] })
  })

  it('tabs are independent; removeTab forgets a tab', () => {
    const { hub } = makeHub()
    hub.status(status())
    hub.status(status({ tabId: TAB2, sessionId: SID2, effort: 'low' }))
    hub.subagent(sub('start', 'a1'))
    expect(hub.get(TAB2)).toMatchObject({ main: { effort: 'low' }, agents: [] })
    hub.removeTab(TAB)
    expect(hub.get(TAB)).toEqual({ tabId: TAB, main: null, agents: [] })
    expect(hub.get(TAB2).main?.effort).toBe('low')
  })

  it('stop of an unknown agent and a repeated start do not notify', () => {
    const { hub, changes } = makeHub()
    hub.status(status())
    hub.subagent(sub('start', 'a1'))
    changes.length = 0
    hub.subagent(sub('stop', 'zz'))
    hub.subagent(sub('start', 'a1'))
    expect(changes).toEqual([])
  })

  it('a throwing readMeta leaves the description empty', () => {
    const hub = new StatusHub({ now: () => 0, readMeta: () => { throw new Error('io') }, onChange: () => {} })
    hub.subagent(sub('start', 'a1'))
    expect(hub.get(TAB).agents[0].description).toBe(null)
  })
})
```

Run: `npx vitest run tests/unit/status-hub.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/status-hub'`.

- [ ] **Step 2: `src/main/status-hub.ts`**

```ts
import type { StatusUpdate } from '../shared/ipc'
import type { StatusMessage, SubagentMessage } from '../shared/protocol'
import type { AgentStatus, MainStatus } from '../shared/types'
import type { AgentMeta, AgentModelInfo } from './transcript-agent-info'

export interface StatusHubDeps {
  now(): number
  /** meta of a subagent of the tab's current session; null when it cannot be read (yet) */
  readMeta(tabId: string, agentId: string): AgentMeta | null
  onChange(tabId: string): void
}

interface TrackedAgent extends AgentStatus {
  meta: AgentMeta | null
}

interface TabState {
  sessionId: string | null
  main: MainStatus | null
  agents: Map<string, TrackedAgent>
  /** model·effort seen in a subagent transcript before its SubagentStart hook */
  early: Map<string, AgentModelInfo>
}

export class StatusHub {
  private readonly tabs = new Map<string, TabState>()
  /** sessions that got SessionEnd; their late statusLine/hook messages are dropped until they start again */
  private readonly ended = new Set<string>()

  constructor(private readonly deps: StatusHubDeps) {}

  session(tabId: string, sessionId: string): void {
    this.ended.delete(sessionId)
    const t = this.tab(tabId)
    if (t.sessionId === sessionId) return
    this.reset(t, sessionId)
    this.deps.onChange(tabId)
  }

  status(m: StatusMessage): void {
    if (this.ended.has(m.sessionId)) return
    const t = this.tab(m.tabId)
    if (t.sessionId !== m.sessionId) this.reset(t, m.sessionId)
    t.main = { model: m.model, effort: m.effort, context: m.context, fiveHour: m.fiveHour }
    this.deps.onChange(m.tabId)
  }

  subagent(m: SubagentMessage): void {
    if (this.ended.has(m.sessionId)) return
    const t = this.tab(m.tabId)
    if (t.sessionId === null) t.sessionId = m.sessionId
    else if (t.sessionId !== m.sessionId) return // a late hook of a previous session
    if (m.event === 'stop') {
      t.early.delete(m.agentId)
      if (t.agents.delete(m.agentId)) this.deps.onChange(m.tabId)
      return
    }
    if (t.agents.has(m.agentId)) return
    const info = t.early.get(m.agentId)
    t.early.delete(m.agentId)
    const a: TrackedAgent = {
      agentId: m.agentId,
      type: m.agentType,
      description: null,
      model: info?.model ?? null,
      effort: info?.effort ?? null,
      startedAt: this.deps.now(),
      meta: null
    }
    this.loadMeta(m.tabId, a)
    t.agents.set(m.agentId, a)
    this.deps.onChange(m.tabId)
  }

  subagentInfo(tabId: string, agentId: string, info: AgentModelInfo): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    const a = t.agents.get(agentId)
    if (!a) {
      t.early.set(agentId, info)
      return
    }
    a.model = info.model
    a.effort = info.effort
    this.loadMeta(tabId, a)
    this.deps.onChange(tabId)
  }

  sessionEnd(tabId: string, sessionId: string): void {
    this.ended.add(sessionId)
    const t = this.tabs.get(tabId)
    if (!t || t.sessionId !== sessionId) return
    this.tabs.delete(tabId)
    this.deps.onChange(tabId)
  }

  removeTab(tabId: string): void {
    this.tabs.delete(tabId)
  }

  get(tabId: string): StatusUpdate {
    const t = this.tabs.get(tabId)
    const agents = t ? [...t.agents.values()].map(({ agentId, type, description, model, effort, startedAt }) => ({ agentId, type, description, model, effort, startedAt })) : []
    return { tabId, main: t?.main ?? null, agents }
  }

  private tab(tabId: string): TabState {
    let t = this.tabs.get(tabId)
    if (!t) {
      t = { sessionId: null, main: null, agents: new Map(), early: new Map() }
      this.tabs.set(tabId, t)
    }
    return t
  }

  private reset(t: TabState, sessionId: string): void {
    t.sessionId = sessionId
    t.main = null
    t.agents.clear()
    t.early.clear()
  }

  private loadMeta(tabId: string, a: TrackedAgent): void {
    if (a.meta) return
    try {
      a.meta = this.deps.readMeta(tabId, a.agentId)
    } catch {
      a.meta = null
    }
    a.description = a.meta?.description ?? null
  }
}
```

- [ ] **Step 3: Проверка**

Run: `npx vitest run tests/unit/status-hub.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 4: Checkpoint** (без коммита).

---

### Task 7: Форматирование строки статуса (чистые функции renderer)

**Files:**
- Create: `src/renderer/status-bar.ts` (в этой задаче — только чистые функции; класс `StatusBar` добавит Task 8)
- Create: `tests/unit/status-bar.test.ts`

**Interfaces:**
- Consumes: `StatusUpdate` (ipc.ts), `AgentStatus` (types.ts).
- Produces:
  - `type Level = 'normal' | 'warn' | 'crit'`
  - `interface Segment { key: 'model' | 'context' | 'limit' | 'agents'; text: string; title: string; level: Level }`
  - `formatTokens(n: number): string`, `levelFor(pct: number): Level`, `modelFamily(id: string): string`
  - `statusSegments(u: StatusUpdate, now: number): Segment[]` — пустой массив, если `u.main === null`.

- [ ] **Step 1: Падающие тесты** — `tests/unit/status-bar.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { formatTokens, levelFor, modelFamily, statusSegments } from '../../src/renderer/status-bar'
import type { AgentStatus, MainStatus } from '../../src/shared/types'

const main: MainStatus = {
  model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  effort: 'xhigh',
  context: { usedTokens: 82_314, size: 200_000, usedPct: 41.2 },
  fiveHour: { usedPct: 23.5, resetsAt: new Date(2026, 9, 5, 21, 40).getTime() / 1000 }
}
const agent = (over: Partial<AgentStatus>): AgentStatus => ({ agentId: 'a', type: 'Explore', description: null, model: 'claude-opus-5-5', effort: 'high', startedAt: 0, ...over })

describe('statusSegments', () => {
  it('formats all four segments', () => {
    const agents = [agent({ type: 'code-reviewer', description: 'Review font fix' })]
    expect(statusSegments({ tabId: 't', main, agents }, 3 * 60_000 + 5_000)).toEqual([
      { key: 'model', text: 'Opus 5.5 · xhigh', title: 'claude-opus-5-5', level: 'normal' },
      { key: 'context', text: 'ctx 41% · 82k/200k', title: '82 314 из 200 000 токенов', level: 'normal' },
      { key: 'limit', text: '5h 24%', title: 'сброс в 21:40', level: 'normal' },
      { key: 'agents', text: '⚙ 1: opus·high', title: 'code-reviewer · opus·high · 3 мин · «Review font fix»', level: 'normal' }
    ])
  })

  it('shows only the model early in a session', () => {
    const early: MainStatus = { model: { id: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' }, effort: null, context: null, fiveHour: null }
    expect(statusSegments({ tabId: 't', main: early, agents: [] }, 0)).toEqual([{ key: 'model', text: 'Haiku 4.5', title: 'claude-haiku-4-5-20251001', level: 'normal' }])
  })

  it('returns nothing without the main status', () => {
    expect(statusSegments({ tabId: 't', main: null, agents: [agent({})] }, 0)).toEqual([])
  })

  it('marks context and the 5h limit warn from 70% and crit from 90%', () => {
    const s = statusSegments({ tabId: 't', main: { ...main, context: { usedTokens: 1, size: 2, usedPct: 91 }, fiveHour: { usedPct: 70, resetsAt: 0 } }, agents: [] }, 0)
    expect(s.map((x) => x.level)).toEqual(['normal', 'crit', 'warn'])
  })

  it('groups many agents by model·effort, most frequent first; unknown model shows …', () => {
    const agents = [
      agent({ agentId: '1', effort: 'xhigh' }),
      ...['2', '3', '4', '5', '6', '7'].map((id) => agent({ agentId: id, model: 'claude-sonnet-5-5', effort: 'medium' })),
      agent({ agentId: '8', effort: 'xhigh' }),
      agent({ agentId: '9', model: 'claude-haiku-4-5-20251001', effort: null }),
      agent({ agentId: '10', model: null, effort: null })
    ]
    expect(statusSegments({ tabId: 't', main, agents }, 0).at(-1)?.text).toBe('⚙ 10: sonnet·medium ×6, opus·xhigh ×2, haiku, …')
  })

  it('agent tooltip: under a minute, no description', () => {
    expect(statusSegments({ tabId: 't', main, agents: [agent({ startedAt: 1000 })] }, 30_000).at(-1)?.title).toBe('Explore · opus·high · <1 мин')
  })
})

describe('helpers', () => {
  it('levelFor', () => {
    expect([69.9, 70, 89.9, 90].map(levelFor)).toEqual(['normal', 'warn', 'warn', 'crit'])
  })

  it('formatTokens', () => {
    expect([999, 1000, 82_314, 200_000, 999_499, 999_500, 1_000_000, 1_500_000].map(formatTokens)).toEqual(['999', '1k', '82k', '200k', '999k', '1M', '1M', '1.5M'])
  })

  it('modelFamily', () => {
    expect(['claude-opus-5-5', 'claude-haiku-4-5-20251001', 'gpt-x'].map(modelFamily)).toEqual(['opus', 'haiku', 'gpt-x'])
  })
})
```

Run: `npx vitest run tests/unit/status-bar.test.ts`
Expected: FAIL — `Cannot find module '../../src/renderer/status-bar'`.

- [ ] **Step 2: `src/renderer/status-bar.ts`**

```ts
import type { StatusUpdate } from '../shared/ipc'
import type { AgentStatus } from '../shared/types'

export type Level = 'normal' | 'warn' | 'crit'

export interface Segment {
  key: 'model' | 'context' | 'limit' | 'agents'
  text: string
  title: string
  level: Level
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n >= 999_500) return `${+(n / 1_000_000).toFixed(1)}M`
  return `${Math.round(n / 1000)}k`
}

export const levelFor = (pct: number): Level => (pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'normal')

/** claude-opus-5-5 → opus; anything else as is */
export function modelFamily(id: string): string {
  return /^claude-([a-z]+)-/.exec(id)?.[1] ?? id
}

const groupDigits = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
const pad2 = (n: number): string => String(n).padStart(2, '0')
const agentKind = (a: AgentStatus): string => (a.model === null ? '…' : a.effort ? `${modelFamily(a.model)}·${a.effort}` : modelFamily(a.model))

function minutes(ms: number): string {
  const m = Math.floor(ms / 60_000)
  return m < 1 ? '<1 мин' : `${m} мин`
}

function agentGroups(agents: AgentStatus[]): string {
  const counts = new Map<string, number>()
  for (const a of agents) counts.set(agentKind(a), (counts.get(agentKind(a)) ?? 0) + 1)
  return [...counts]
    .sort((x, y) => y[1] - x[1])
    .map(([kind, n]) => (n > 1 ? `${kind} ×${n}` : kind))
    .join(', ')
}

const agentLine = (a: AgentStatus, now: number): string =>
  [a.type, agentKind(a), minutes(now - a.startedAt), ...(a.description ? [`«${a.description}»`] : [])].join(' · ')

export function statusSegments(u: StatusUpdate, now: number): Segment[] {
  const main = u.main
  if (!main) return []
  const segments: Segment[] = [
    { key: 'model', text: main.effort ? `${main.model.displayName} · ${main.effort}` : main.model.displayName, title: main.model.id, level: 'normal' }
  ]
  if (main.context) {
    const c = main.context
    segments.push({
      key: 'context',
      text: `ctx ${Math.round(c.usedPct)}% · ${formatTokens(c.usedTokens)}/${formatTokens(c.size)}`,
      title: `${groupDigits(c.usedTokens)} из ${groupDigits(c.size)} токенов`,
      level: levelFor(c.usedPct)
    })
  }
  if (main.fiveHour) {
    const f = main.fiveHour
    const reset = new Date(f.resetsAt * 1000)
    segments.push({ key: 'limit', text: `5h ${Math.round(f.usedPct)}%`, title: `сброс в ${pad2(reset.getHours())}:${pad2(reset.getMinutes())}`, level: levelFor(f.usedPct) })
  }
  if (u.agents.length > 0) {
    segments.push({ key: 'agents', text: `⚙ ${u.agents.length}: ${agentGroups(u.agents)}`, title: u.agents.map((a) => agentLine(a, now)).join('\n'), level: 'normal' })
  }
  return segments
}
```

- [ ] **Step 3: Проверка**

Run: `npx vitest run tests/unit/status-bar.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 4: Checkpoint** (без коммита).

---

### Task 8: Проводка main → renderer, DOM строки статуса, e2e

**Files:**
- Modify: `src/shared/ipc.ts` (`IPC.evStatus`, `CtApi.onStatus`)
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/status-bar.ts` (+ класс `StatusBar`)
- Modify: `src/renderer/main.ts`, `src/renderer/index.html`, `src/renderer/styles.css`
- Modify: `tests/e2e/helpers.ts` (+ `launchClaudeTab`)
- Create: `tests/e2e/status.spec.ts`
- Modify: `tests/e2e/layout.spec.ts` (+ тест с видимой строкой статуса)

**Interfaces:**
- Consumes: всё из Tasks 2–7: `PipeHandlers`, `StatusHub`, `readAgentMeta`, `TranscriptFeedOptions.onSubagentInfo`, `statusSegments`, `StatusUpdate`, `assistantLine`.
- Produces: `IPC.evStatus = 'ev:status'`; `CtApi.onStatus(cb: (update: StatusUpdate) => void): Unsubscribe`; `class StatusBar { constructor(el: HTMLElement); render(u: StatusUpdate | null, now?: number): void }`; `launchClaudeTab(): Promise<Launched & { work: string; tabId: string }>`; DOM `#statusbar` с дочерними `.status-model`, `.status-context`, `.status-limit`, `.status-agents`, разделителями `.status-sep`, классами уровня `warn`/`crit`.

- [ ] **Step 1: `launchClaudeTab` в `tests/e2e/helpers.ts`** (в конец файла):

```ts
export async function launchClaudeTab(): Promise<Launched & { work: string; tabId: string }> {
  const work = mkdtempSync(join(tmpdir(), 'ct-work-'))
  const launched = await launchApp({ settings: FAKE_CLAUDE_SETTINGS, args: ['--claude', work] })
  await launched.page.waitForFunction(() => window.__ct!.tabIds().length === 1)
  const tabId = (await launched.page.evaluate(() => window.__ct!.activeTabId()))!
  return { ...launched, work, tabId }
}
```

- [ ] **Step 2: Падающие e2e** — `tests/e2e/status.spec.ts`:

```ts
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendPipeMessage } from '../../src/shared/pipe-client'
import type { StatusMessage } from '../../src/shared/protocol'
import { assistantLine } from '../fixtures/transcript'
import { launchApp, launchClaudeTab } from './helpers'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'

const statusMsg = (tabId: string): StatusMessage => ({
  v: 1,
  type: 'status',
  tabId,
  sessionId: SID,
  model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  effort: 'xhigh',
  context: { usedTokens: 82_314, size: 200_000, usedPct: 41.2 },
  fiveHour: { usedPct: 23.5, resetsAt: Math.floor(Date.now() / 1000) + 3600 }
})

test('a claude tab shows model, context, the 5h limit and running subagents', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  const projectDir = join(mkdtempSync(join(tmpdir(), 'ct-proj-')), 'projects', 'D--e2e')
  const subagentDir = join(projectDir, SID, 'subagents')
  mkdirSync(subagentDir, { recursive: true })
  const transcriptPath = join(projectDir, `${SID}.jsonl`)
  writeFileSync(transcriptPath, '')
  writeFileSync(join(subagentDir, 'agent-a1.jsonl'), assistantLine('claude-opus-5-5', 'high') + '\n')
  writeFileSync(join(subagentDir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find asar users' }))

  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session', tabId, sessionId: SID, source: 'startup', transcriptPath })).toEqual({ ok: true })
  expect(await sendPipeMessage(pipeName, statusMsg(tabId))).toEqual({ ok: true })
  expect(await sendPipeMessage(pipeName, { v: 1, type: 'subagent', tabId, sessionId: SID, event: 'start', agentId: 'a1', agentType: 'Explore' })).toEqual({ ok: true })

  const bar = page.locator('#statusbar')
  await expect(bar.locator('.status-model')).toHaveText('Opus 5.5 · xhigh')
  await expect(bar.locator('.status-context')).toHaveText('ctx 41% · 82k/200k')
  await expect(bar.locator('.status-limit')).toHaveText('5h 24%')
  await expect(bar.locator('.status-agents')).toHaveText('⚙ 1: opus·high', { timeout: 10_000 })
  await expect(bar.locator('.status-agents')).toHaveAttribute('title', 'Explore · opus·high · <1 мин · «Find asar users»')

  expect(await sendPipeMessage(pipeName, { v: 1, type: 'subagent', tabId, sessionId: SID, event: 'stop', agentId: 'a1', agentType: 'Explore' })).toEqual({ ok: true })
  await expect(bar.locator('.status-agents')).toHaveCount(0)

  expect(await sendPipeMessage(pipeName, { v: 1, type: 'session_end', tabId, sessionId: SID })).toEqual({ ok: true })
  await expect(bar).toBeHidden()
  await app.close()
})

test('a shell tab has no status bar and its status messages are rejected', async () => {
  const { app, page, pipeName } = await launchApp()
  await page.waitForFunction(() => window.__ct!.activeTabId() !== null)
  const tabId = (await page.evaluate(() => window.__ct!.activeTabId()))!
  expect(await sendPipeMessage(pipeName, statusMsg(tabId))).toEqual({ ok: false, error: `unknown claude tab: ${tabId}` })
  await expect(page.locator('#statusbar')).toBeHidden()
  await app.close()
})
```

Тест раскладки — в конец `tests/e2e/layout.spec.ts` (импорты: `import { sendPipeMessage } from '../../src/shared/pipe-client'`, `launchClaudeTab` из `./helpers`):

```ts
test('terminal grid fits above the status bar at every window height', async () => {
  const { app, page, tabId, pipeName } = await launchClaudeTab()
  const status = { v: 1 as const, type: 'status' as const, tabId, sessionId: '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8', model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: 'xhigh', context: null, fiveHour: null }
  expect(await sendPipeMessage(pipeName, status)).toEqual({ ok: true })
  const bar = page.locator('#statusbar')
  await expect(bar).toBeVisible()
  const failures: string[] = []
  for (let h = 600; h < 640; h++) {
    await setContentSize(app, page, 1000, h)
    const l = await termLayout(page)
    const barTop = await bar.evaluate((e) => e.getBoundingClientRect().top)
    for (const f of overflows(l)) failures.push(`1000x${h}: ${f}`)
    if (l.screenBottom - barTop > 0.5) failures.push(`1000x${h}: last row under the status bar by ${(l.screenBottom - barTop).toFixed(1)}px`)
  }
  expect(failures).toEqual([])
  await app.close()
})
```

Run: `npm run build && npx playwright test tests/e2e/status.spec.ts tests/e2e/layout.spec.ts`
Expected: FAIL — `status` возвращает `{ ok: false, error: 'not implemented' }` (заглушка из Task 2), `#statusbar` не найден.

- [ ] **Step 3: IPC и preload**

`src/shared/ipc.ts`: в объект `IPC` после `evRestore: 'ev:restore'` добавить `evStatus: 'ev:status'` (не забыть запятую); в `CtApi` после `onRestore(...)` добавить:

```ts
  onStatus(cb: (update: StatusUpdate) => void): Unsubscribe
```

`src/preload/index.ts`: после `onRestore: (cb) => on(IPC.evRestore, cb)` добавить `onStatus: (cb) => on(IPC.evStatus, cb)` (с запятой перед ним).

- [ ] **Step 4: Main** — `src/main/index.ts`:

Импорты:

```ts
import { StatusHub } from './status-hub'
import { readAgentMeta } from './transcript-agent-info'
```

Сразу после `const sources = new Map<string, TabImageSources>()`:

```ts
  const statusTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const statusHub = new StatusHub({
    now: () => Date.now(),
    readMeta: (tabId, agentId) => {
      const dir = sources.get(tabId)?.feed?.subagentDir
      return dir ? readAgentMeta(dir, agentId) : null
    },
    // coalesce bursts (statusLine, hooks, subagent transcripts) into one update per tab
    onChange: (tabId) => {
      if (statusTimers.has(tabId)) return
      statusTimers.set(tabId, setTimeout(() => {
        statusTimers.delete(tabId)
        send(IPC.evStatus, statusHub.get(tabId))
      }, 50))
    }
  })

  const stopTabStatus = (tabId: string): void => {
    const timer = statusTimers.get(tabId)
    if (timer) clearTimeout(timer)
    statusTimers.delete(tabId)
    statusHub.removeTab(tabId)
  }
```

В `attachTranscript` в опции `new TranscriptFeed({ ... })` после `onError: (m) => log.warn(m)` добавить:

```ts
      onSubagentInfo: (agentId, info) => statusHub.subagentInfo(tabId, agentId, info),
```

В `new TabManager({ ... })` заменить `onTabClosed: stopTabImages,` на:

```ts
    onTabClosed: (tabId) => {
      stopTabImages(tabId)
      stopTabStatus(tabId)
    },
```

Сразу после создания `tabs`:

```ts
  const isClaudeTab = (tabId: string): boolean => tabs.get(tabId)?.kind === 'claude'
```

В `startPipeServer(pipeName, { ... })`: в обработчике `session` после проверки `setClaudeSession` добавить `statusHub.session(msg.tabId, msg.sessionId)`; заглушки из Task 2 заменить на:

```ts
    status: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      statusHub.status(msg)
      return { ok: true }
    },
    subagent: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      log.info(`subagent ${msg.event} tab=${msg.tabId} id=${msg.agentId} type=${msg.agentType}`)
      statusHub.subagent(msg)
      return { ok: true }
    },
    sessionEnd: (msg) => {
      if (!isClaudeTab(msg.tabId)) return { ok: false, error: `unknown claude tab: ${msg.tabId}` }
      log.info(`session end tab=${msg.tabId} id=${msg.sessionId}`)
      statusHub.sessionEnd(msg.tabId, msg.sessionId)
      return { ok: true }
    }
```

- [ ] **Step 5: DOM** — в конец `src/renderer/status-bar.ts`:

```ts
export class StatusBar {
  constructor(private readonly el: HTMLElement) {}

  render(u: StatusUpdate | null, now = Date.now()): void {
    const segments = u ? statusSegments(u, now) : []
    this.el.hidden = segments.length === 0
    this.el.replaceChildren(
      ...segments.flatMap((s, i) => {
        const span = document.createElement('span')
        span.className = `status-seg status-${s.key}${s.level === 'normal' ? '' : ` ${s.level}`}`
        span.textContent = s.text
        span.title = s.title
        if (i === 0) return [span]
        const sep = document.createElement('span')
        sep.className = 'status-sep'
        sep.textContent = '│'
        return [sep, span]
      })
    )
  }
}
```

`src/renderer/index.html`: после закрывающего `</div>` элемента `#workspace` (внутри `#app`) добавить `<div id="statusbar" hidden></div>`.

`src/renderer/styles.css` (в конец):

```css
#statusbar { display: flex; align-items: center; gap: 8px; flex-shrink: 0; height: 22px; padding: 0 10px; background: var(--chrome); border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; user-select: none; }
#statusbar .status-sep { color: var(--border); }
#statusbar .status-agents { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
#statusbar .warn { color: #e5c07b; }
#statusbar .crit { color: #e06c75; }
```

- [ ] **Step 6: Renderer** — `src/renderer/main.ts`:
  - импорт: `import type { AppInfo, RestoreInfo, ImagesUpdate, StatusUpdate } from '../shared/ipc'` и `import { StatusBar } from './status-bar'`;
  - состояние рядом с `imageUpdates`: `let statusBar: StatusBar` и `const statusUpdates = new Map<string, StatusUpdate>()`;
  - в `activate()` последней строкой: `statusBar.render(statusUpdates.get(tabId) ?? null)`;
  - в `boot()` сразу после `lightbox = new Lightbox(...)`:

```ts
  statusBar = new StatusBar(document.getElementById('statusbar')!)
  ct.onStatus((u) => {
    statusUpdates.set(u.tabId, u)
    if (u.tabId === activeId) statusBar.render(u)
  })
```

  - в обработчике `ct.onTabClosed` после `imageUpdates.delete(id)`: `statusUpdates.delete(id)`, а в ветке `if (activeId === id) activeId = null` — заменить на `if (activeId === id) { activeId = null; statusBar.render(null) }`.

- [ ] **Step 7: Проверка**

Run: `npm run typecheck && npm test && npm run build && npx playwright test`
Expected: всё зелёное — unit/integration и весь e2e, включая `status.spec.ts` и новый тест в `layout.spec.ts`.

- [ ] **Step 8: Checkpoint** (без коммита).

---

### Task 9 (условная): снятие сабагентов по основному транскрипту

**Выполнять, только если проба из Task 1 показала, что `SubagentStop` не приходит при Esc.** Иначе — пропустить и отметить в отчёте.

**Files:**
- Modify: `src/main/transcript-agent-info.ts` (+ `completedToolUses`)
- Modify: `src/main/transcript-feed.ts` (+ `onToolUseDone`)
- Modify: `src/main/status-hub.ts` (+ `toolUseDone`)
- Modify: `src/main/index.ts` (проводка)
- Modify: `tests/fixtures/transcript.ts` (+ `queueNotificationLine`)
- Modify: `tests/unit/transcript-agent-info.test.ts`, `tests/unit/status-hub.test.ts`, `tests/integration/transcript-feed.int.test.ts`

**Interfaces:**
- Consumes: `AgentMeta` (`toolUseId`, `background`), `StatusHub`, `TranscriptFeed` (Tasks 5–6).
- Produces:
  - `type ToolUseDoneVia = 'result' | 'notification'`; `completedToolUses(line: string): { toolUseId: string; via: ToolUseDoneVia }[]`
  - `TranscriptFeedOptions.onToolUseDone?(toolUseId: string, via: ToolUseDoneVia): void` — только для основного транскрипта.
  - `StatusHub.toolUseDone(tabId: string, toolUseId: string, via: ToolUseDoneVia): void` — снимает не-фонового агента по `result`, фонового — по `notification`.

Формат в транскрипте (проверено на реальном файле): завершение не-фонового агента — строка `type: "user"` с `message.content[]` → `{ type: "tool_result", tool_use_id }`; завершение фонового — строка `{ type: "queue-operation", operation: "enqueue", content: "<task-notification>…<tool-use-id>toolu_…</tool-use-id>…" }`.

- [ ] **Step 1: Фикстура** — в конец `tests/fixtures/transcript.ts`:

```ts
export function queueNotificationLine(toolUseId: string, operation = 'enqueue'): string {
  return JSON.stringify({ type: 'queue-operation', operation, content: `<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n</task-notification>` })
}
```

- [ ] **Step 2: Падающие тесты**

В `tests/unit/transcript-agent-info.test.ts` (импорты: `completedToolUses`; `queueNotificationLine`, `assistantLine` из фикстур):

```ts
describe('completedToolUses', () => {
  it('tool_result blocks of a user line', () => {
    expect(completedToolUses(toolResultLine('toolu_1'))).toEqual([{ toolUseId: 'toolu_1', via: 'result' }])
  })

  it('a task notification enqueued for a background agent', () => {
    expect(completedToolUses(queueNotificationLine('toolu_2'))).toEqual([{ toolUseId: 'toolu_2', via: 'notification' }])
  })

  it('ignores dequeued notifications, assistant lines and bad JSON', () => {
    expect(completedToolUses(queueNotificationLine('toolu_2', 'remove'))).toEqual([])
    expect(completedToolUses(assistantLine('claude-opus-5-5'))).toEqual([])
    expect(completedToolUses('{oops')).toEqual([])
  })
})
```

В `tests/unit/status-hub.test.ts`:

```ts
describe('StatusHub.toolUseDone', () => {
  it('removes a foreground agent on its tool_result and a background one on its notification', () => {
    const { hub } = makeHub({ fg: { description: null, toolUseId: 'toolu_fg', background: false }, bg: { description: null, toolUseId: 'toolu_bg', background: true } })
    hub.status(status())
    hub.subagent(sub('start', 'fg'))
    hub.subagent(sub('start', 'bg'))
    hub.toolUseDone(TAB, 'toolu_bg', 'result') // "async agent launched" result of a background agent
    expect(hub.get(TAB).agents.map((a) => a.agentId)).toEqual(['fg', 'bg'])
    hub.toolUseDone(TAB, 'toolu_fg', 'result')
    hub.toolUseDone(TAB, 'toolu_bg', 'notification')
    expect(hub.get(TAB).agents).toEqual([])
  })

  it('reads meta that appeared after the start hook', () => {
    const { hub, meta: m } = makeHub()
    hub.status(status())
    hub.subagent(sub('start', 'fg'))
    m.fg = { description: 'late', toolUseId: 'toolu_fg', background: false }
    hub.toolUseDone(TAB, 'toolu_fg', 'result')
    expect(hub.get(TAB).agents).toEqual([])
  })
})
```

В `tests/integration/transcript-feed.int.test.ts`: в `setup()` добавить `const done: [string, string][] = []`, опцию `onToolUseDone: (id, via) => done.push([id, via])` и вернуть `done`; тест:

```ts
  it('reports completed tool uses of the main transcript only', async () => {
    const { transcriptPath, done, feed } = setup()
    writeFileSync(transcriptPath, [toolResultLine('toolu_m'), queueNotificationLine('toolu_b'), ''].join('\n'))
    mkdirSync(feed.subagentDir, { recursive: true })
    writeFileSync(join(feed.subagentDir, 'agent-a1.jsonl'), toolResultLine('toolu_sub') + '\n')
    feed.scanSubagents()
    await feed.poll()
    expect(done).toEqual([['toolu_m', 'result'], ['toolu_b', 'notification']])
  })
```

Run: `npx vitest run tests/unit/transcript-agent-info.test.ts tests/unit/status-hub.test.ts tests/integration/transcript-feed.int.test.ts`
Expected: FAIL — `completedToolUses`/`toolUseDone`/`onToolUseDone` не существуют.

- [ ] **Step 3: Реализация**

`src/main/transcript-agent-info.ts` (в конец):

```ts
export type ToolUseDoneVia = 'result' | 'notification'

const NOTIFIED_TOOL_USE_RE = /<tool-use-id>([^<]+)<\/tool-use-id>/g

/** Tool uses a main-transcript line reports as finished: tool_result blocks, or a background task notification. */
export function completedToolUses(line: string): { toolUseId: string; via: ToolUseDoneVia }[] {
  const o = parseObj(line)
  if (!o) return []
  if (o.type === 'queue-operation' && o.operation === 'enqueue' && typeof o.content === 'string' && o.content.includes('<task-notification>')) {
    return [...o.content.matchAll(NOTIFIED_TOOL_USE_RE)].map((m) => ({ toolUseId: m[1], via: 'notification' as const }))
  }
  if (o.type !== 'user' || !isObj(o.message) || !Array.isArray(o.message.content)) return []
  return o.message.content.flatMap((c: unknown) => (isObj(c) && c.type === 'tool_result' && typeof c.tool_use_id === 'string' ? [{ toolUseId: c.tool_use_id, via: 'result' as const }] : []))
}
```

`src/main/transcript-feed.ts`: импорт расширить до `import { assistantInfo, completedToolUses, type AgentModelInfo, type ToolUseDoneVia } from './transcript-agent-info'`; в `TranscriptFeedOptions`:

```ts
  /** a tool use of the main transcript finished (tool_result, or a background task notification) */
  onToolUseDone?(toolUseId: string, via: ToolUseDoneVia): void
```

В `consume()` сразу после `this.reportInfo(src, line)` добавить `this.reportDone(src, line)` и метод:

```ts
  private reportDone(src: Source, line: string): void {
    // cheap pre-filter before parsing: only these lines can complete a tool use
    if (src.agentId !== null || !this.o.onToolUseDone || !(line.includes('tool_result') || line.includes('<task-notification>'))) return
    for (const d of completedToolUses(line)) {
      try {
        this.o.onToolUseDone(d.toolUseId, d.via)
      } catch (e) {
        this.report(e)
      }
    }
  }
```

`src/main/status-hub.ts`: импорт `type ToolUseDoneVia` из `./transcript-agent-info`; в `loadMeta` заменить `if (a.meta) return` на `if (a.meta?.toolUseId) return` (meta без `toolUseId` перечитывается); метод:

```ts
  toolUseDone(tabId: string, toolUseId: string, via: ToolUseDoneVia): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    for (const [agentId, a] of t.agents) {
      this.loadMeta(tabId, a)
      if (a.meta?.toolUseId !== toolUseId) continue
      // a background agent's tool_result only says it was launched; it finishes with a task notification
      if ((via === 'result') === a.meta.background) continue
      t.agents.delete(agentId)
      this.deps.onChange(tabId)
    }
  }
```

`src/main/index.ts`: в опции `TranscriptFeed` в `attachTranscript` добавить `onToolUseDone: (toolUseId, via) => statusHub.toolUseDone(tabId, toolUseId, via),`.

- [ ] **Step 4: Проверка**

Run: `npm run typecheck && npm test`
Expected: PASS (в т.ч. тест `model·effort after start … retries a description` из Task 6 — `loadMeta` по-прежнему перечитывает meta, пока её нет).

- [ ] **Step 5: Checkpoint** (без коммита).

---

### Task 10: Итоговая проверка на живой вкладке и сборка установщика

**Files:** — (только проверка; правки — если найдутся дефекты, с возвратом в соответствующую задачу)

**Interfaces:**
- Consumes: всё.
- Produces: проверенная сборка `%LOCALAPPDATA%\claudeterm-dist\ClaudeTerm-Setup-0.1.0.exe`.

- [ ] **Step 1: Полный прогон**

Run: `npm run typecheck && npm test && npm run build && npx playwright test`
Expected: всё зелёное.

- [ ] **Step 2: Ручная проверка в dev-сборке** (вместе с пользователем; dev использует отдельные `%APPDATA%\ClaudeTerm-dev` и пайп `claudeterm-dev-<user>`, установленная версия не мешает): `npm run dev` → `+ ▾ → Claude Code`. Проверить:
  1. до первого ответа строка показывает модель·effort; после ответа — `ctx`, у подписки Pro/Max — `5h`;
  2. `/effort low` → в течение ~5 с строка показывает `· low`;
  3. промпт с двумя параллельными сабагентами → `⚙ 2: …`, подсказка со списком; по завершении счётчик пропадает;
  4. Esc во время сабагента → агент пропадает из счётчика (Task 9, если она выполнялась, иначе — благодаря `SubagentStop`);
  5. `/clear` → строка сбрасывается и снова заполняется новой сессией; `/exit` → строка скрыта;
  6. над футером Claude Code — пустая строка statusLine; терминал не обрезан.

- [ ] **Step 3: Установщик** (вне папки проекта — см. Global Constraints)

```bash
npx electron-builder --win nsis --config.directories.output="$(cygpath -w "$LOCALAPPDATA")\\claudeterm-dist"
```

Expected: `ClaudeTerm-Setup-0.1.0.exe` с текущим временем в `%LOCALAPPDATA%\claudeterm-dist`.

- [ ] **Step 4: Checkpoint** — сообщить пользователю, что готово к коммиту (список изменённых файлов), и что установщик лежит в `%LOCALAPPDATA%\claudeterm-dist`.
