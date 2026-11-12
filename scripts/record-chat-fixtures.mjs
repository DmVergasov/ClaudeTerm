// Records the protocol fixtures of the chat view (tests/fixtures/chat) from the real Claude Code, once, by hand:
//   node scripts/record-chat-fixtures.mjs                 records every scenario with a few short Haiku turns into a new
//                                                          temp folder and prints it (the raw lines are not scrubbed)
//   node scripts/record-chat-fixtures.mjs --scrub <dir>   scrubs a recording into tests/fixtures/chat
// The recording runs on the account Claude Code is signed in with, in throwaway temp folders, with settingSources: [] so
// the user's own settings, CLAUDE.md, plugins and MCP servers stay out of it. Its session lands in a project of its own
// under ~/.claude/projects, which is deleted by hand afterwards (tests/fixtures/chat/README.md). Never run by a test.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixturesDir = join(repo, 'tests', 'fixtures', 'chat')

const SCENARIOS = [
  { name: 'answer', turns: ['Reply with exactly this sentence and nothing else: The fixture says hello.'] },
  { name: 'read', turns: ['Read notes.txt in the current folder and reply with its first line only.'] },
  {
    name: 'permission-allow',
    turns: ['Create a file named out.txt that contains the single word fixture.'],
    canUseTool: (_tool, input) => ({ behavior: 'allow', updatedInput: input })
  },
  {
    name: 'permission-deny',
    turns: ['Run the shell command `echo fixture` with the Bash tool.'],
    canUseTool: () => ({ behavior: 'deny', message: 'The user said no.' })
  },
  {
    name: 'question',
    turns: ['Use the AskUserQuestion tool to ask me one question: which format I want, with the options PDF report and HTML page. Then reply with only my answer.'],
    canUseTool: (tool, input) =>
      tool === 'AskUserQuestion'
        ? { behavior: 'allow', updatedInput: { questions: input.questions, answers: { [input.questions[0].question]: 'PDF report' } } }
        : { behavior: 'allow', updatedInput: input }
  },
  {
    name: 'plan',
    permissionMode: 'plan',
    turns: ['Make a two-step plan to add a line to notes.txt, then call ExitPlanMode with it. Do not edit anything.'],
    canUseTool: (tool, input) => (tool === 'ExitPlanMode' ? { behavior: 'deny', message: 'Keep planning.' } : { behavior: 'allow', updatedInput: input })
  },
  { name: 'slash', turns: ['/context', '/config'] },
  // the second message goes in while the first turn runs, to show how a message sent during a turn is acknowledged
  { name: 'compact', turns: [['Say one.', 'Say two.'], '/compact'] },
  { name: 'interrupt', turns: ['Count from 1 to 200, one number per line.'], interruptOnFirstDelta: true },
  { name: 'control', turns: [], control: true },
  { name: 'resume', resumeOf: 'answer', turns: ['Say again.'], history: true }
]

/** a turn is over once its result came, no message is streaming and the CLI has been quiet this long */
const QUIET_MS = 4000
/** a scenario that runs longer than this is interrupted and closed: no scenario may loop on the account */
const SCENARIO_LIMIT_MS = 240_000

// ---------------------------------------------------------------------------------------------------------------- record

/** the user's claude: where.exe on Windows (an .exe, or a .cmd shim), the login shell elsewhere */
function findClaude() {
  if (process.platform === 'win32') {
    const found = execFileSync('where.exe', ['claude'], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
    const hit = found.find((p) => /\.(exe|cmd|bat)$/i.test(p))
    if (!hit) throw new Error(`no claude executable on PATH: ${found.join(', ')}`)
    return hit
  }
  const shell = process.env.SHELL || '/bin/sh'
  const hit = spawnSync(shell, ['-lc', 'command -v claude'], { encoding: 'utf8' }).stdout.trim().split('\n').pop()
  if (!hit) throw new Error('no claude in the login shell')
  return hit
}

/** a word on cmd's command line for a .cmd shim */
const cmdQuote = (a) => (/^[\w./:\\=@,+-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`)

/** the hook and statusLine command for Git Bash or sh: this Node appends {hook, stdin} as one JSON line to the log */
function hookCommand(logPath, hook) {
  // no " $ ` \ in the code: inside bash double quotes it reaches Node as written
  const log = logPath.replace(/\\/g, '/')
  const code =
    "const f=require('fs');let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{d+=c});" +
    "process.stdin.on('end',()=>{let s=d;try{s=JSON.parse(d)}catch(e){}" +
    `f.appendFileSync('${log}',JSON.stringify({hook:process.argv[1],at:Date.now(),stdin:s})+String.fromCharCode(10))})`
  return `"${process.execPath.replace(/\\/g, '/')}" -e "${code}" ${hook}`
}

function writeSettings(dir) {
  const log = join(dir, 'hooks.log')
  const run = (hook) => [{ hooks: [{ type: 'command', command: hookCommand(log, hook), timeout: 10 }] }]
  const settings = {
    statusLine: { type: 'command', command: hookCommand(log, 'statusLine') },
    hooks: {
      SessionStart: run('SessionStart'),
      UserPromptSubmit: run('UserPromptSubmit'),
      PreToolUse: [{ matcher: 'AskUserQuestion', hooks: run('PreToolUse')[0].hooks }],
      PermissionRequest: run('PermissionRequest'),
      Stop: run('Stop')
    }
  }
  const path = join(dir, 'settings.json')
  writeFileSync(path, JSON.stringify(settings, null, 2))
  return path
}

/** the environment of a Claude tab started by ClaudeTerm: nothing of the Claude Code session this script may run in */
function cleanEnv() {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'CLAUDE_CONFIG_DIR' || !/^(CLAUDE|AI_AGENT)/i.test(k)) env[k] = v
  }
  return env
}

const userMessage = (text) => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, origin: { kind: 'human' } })

/** splits a stream into lines and hands each to `onLine` */
function lines(stream, onLine) {
  let rest = ''
  stream.on('data', (chunk) => {
    rest += chunk.toString('utf8')
    let i
    while ((i = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, i).replace(/\r$/, '')
      rest = rest.slice(i + 1)
      if (line) onLine(line)
    }
  })
  stream.on('end', () => {
    if (rest) onLine(rest)
  })
}

const parsed = (line) => {
  try {
    return JSON.parse(line)
  } catch {
    return line
  }
}

async function record(only, into) {
  const { query, getSessionMessages } = await import('@anthropic-ai/claude-agent-sdk')
  const claude = findClaude()
  const version = spawnSync(claude, ['--version'], { encoding: 'utf8', shell: /\.(cmd|bat)$/i.test(claude) }).stdout.trim()
  let out, meta
  if (into) {
    out = into
    meta = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8'))
  } else {
    const work = mkdtempSync(join(tmpdir(), 'ct-chat-fixture-'))
    writeFileSync(join(work, 'notes.txt'), 'first line of the fixture\nsecond line\n')
    out = mkdtempSync(join(tmpdir(), 'ct-chat-record-'))
    meta = { claudeVersion: version, work, home: homedir(), settings: writeSettings(out), sessions: {}, spawn: {}, stopped: {} }
  }
  const { work, settings: settingsPath } = meta
  const env = cleanEnv()
  const saveMeta = () => writeFileSync(join(out, 'meta.json'), JSON.stringify(meta, null, 2))
  console.log(`recording with ${version} into ${out}`)

  for (const sc of SCENARIOS.filter((s) => !only || only.includes(s.name))) {
    if (existsSync(join(out, `${sc.name}.raw.jsonl`))) throw new Error(`${sc.name} is recorded already`)
    const raw = join(out, `${sc.name}.raw.jsonl`)
    const log = (entry) => appendFileSync(raw, JSON.stringify(entry) + '\n')
    let child = null
    let teeIn = null
    let results = 0
    let open = false
    let lastAt = Date.now()
    const watchers = []
    const seen = (m) => {
      lastAt = Date.now()
      if (m && typeof m === 'object') {
        if (m.type === 'result') {
          results++
          open = false
        } else if (m.type === 'assistant' || (m.type === 'stream_event' && m.event?.type === 'message_start')) open = true
        if (m.type === 'system' && m.subtype === 'init') meta.sessions[sc.name] ??= m.session_id
        // every session the scenario touched, for the clean-up (a /compact or a run without init has its own)
        const all = (meta.allSessions ??= {})[sc.name] ??= []
        if (typeof m.session_id === 'string' && m.session_id && !all.includes(m.session_id)) all.push(m.session_id)
      }
      for (const w of watchers.splice(0)) if (!w.test(m)) watchers.push(w)
      else w.resolve(m)
    }
    const waitFor = (test) => new Promise((resolve) => watchers.push({ test, resolve }))
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    let ended = false
    const turnEnd = async (before) => {
      while (!ended && !(results > before && !open && Date.now() - lastAt >= QUIET_MS)) await wait(200)
    }

    const spawnClaudeCodeProcess = (options) => {
      const added = {}
      for (const [k, v] of Object.entries(options.env)) if (env[k] !== v) added[k] = v
      meta.spawn[sc.name] = { command: options.command, args: options.args, cwd: options.cwd, envAdded: added }
      saveMeta()
      const shim = /\.(cmd|bat)$/i.test(claude)
      child = shim
        ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[claude, ...options.args].map(cmdQuote).join(' ')}"`], {
            cwd: options.cwd,
            env: options.env,
            windowsVerbatimArguments: true,
            windowsHide: true
          })
        : spawn(claude, options.args, { cwd: options.cwd, env: options.env, windowsHide: true })
      const stdin = new PassThrough()
      teeIn = stdin
      lines(stdin, (line) => log({ dir: 'in', line: parsed(line) }))
      stdin.pipe(child.stdin)
      child.stdin.on('error', (e) => stdin.emit('error', e))
      const stdout = new PassThrough()
      lines(child.stdout, (line) => {
        const m = parsed(line)
        log({ dir: 'out', line: m })
        if (m && typeof m === 'object' && m.type === 'control_response') seen(m)
      })
      child.stdout.pipe(stdout)
      child.stderr.on('data', (c) => appendFileSync(join(out, `${sc.name}.stderr.log`), c))
      if (options.signal) options.signal.addEventListener('abort', () => child.kill(), { once: true })
      return {
        stdin,
        stdout,
        get killed() {
          return child.killed
        },
        get exitCode() {
          return child.exitCode
        },
        get signalCode() {
          return child.signalCode
        },
        kill: (s) => child.kill(s),
        on: (e, l) => child.on(e, l),
        once: (e, l) => child.once(e, l),
        off: (e, l) => child.off(e, l)
      }
    }

    const canUseTool = async (tool, input, options) => {
      const { signal, ...rest } = options
      const answer = await (sc.canUseTool ?? ((_t, i) => ({ behavior: 'allow', updatedInput: i })))(tool, input, options)
      log({ dir: 'host', canUseTool: { tool, input, optionKeys: Object.keys(options), options: rest, answer } })
      return answer
    }

    let q = null
    let interrupted = false
    async function* prompts() {
      for (const turn of sc.turns) {
        const before = results
        const texts = Array.isArray(turn) ? turn : [turn]
        yield userMessage(texts[0])
        for (const text of texts.slice(1)) {
          // the next message goes in while the turn streams
          await waitFor((m) => m && m.type === 'stream_event')
          yield userMessage(text)
        }
        await turnEnd(before)
        if (ended) return
      }
      if (sc.control) await controlCalls()
    }

    async function controlCalls() {
      while (!q) await wait(50)
      const call = async (name, fn) => {
        try {
          log({ dir: 'host', call: name, result: await fn() })
        } catch (e) {
          log({ dir: 'host', call: name, error: String(e) })
        }
      }
      await call('initializationResult', () => q.initializationResult())
      await call('supportedCommands', () => q.supportedCommands())
      await call('supportedModels', () => q.supportedModels())
      await call('getContextUsage', () => q.getContextUsage())
      await call('setPermissionMode', () => q.setPermissionMode('acceptEdits'))
      await call('setModel', () => q.setModel('haiku'))
      // finding (g): the SDK has no method for it, so the request goes straight onto Claude Code's stdin
      const id = 'req_file_suggestions_1'
      teeIn.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'file_suggestions', query: 'notes' } }) + '\n')
      const reply = await Promise.race([waitFor((m) => m && m.type === 'control_response' && m.response?.request_id === id), wait(5000).then(() => null)])
      log({ dir: 'host', call: 'file_suggestions', answered: reply !== null })
    }

    const options = {
      cwd: work,
      model: 'haiku',
      settingSources: [],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      includePartialMessages: true,
      perTaskStopAffordance: true,
      extraArgs: { settings: settingsPath },
      env,
      canUseTool,
      spawnClaudeCodeProcess,
      ...(sc.permissionMode ? { permissionMode: sc.permissionMode } : {}),
      ...(sc.resumeOf ? { resume: meta.sessions[sc.resumeOf] } : {})
    }
    if (sc.resumeOf && !options.resume) throw new Error(`no session of ${sc.resumeOf} to resume`)
    console.log(`- ${sc.name}`)
    q = query({ prompt: prompts(), options })
    const limit = setTimeout(async () => {
      meta.stopped[sc.name] = 'time limit'
      ended = true
      try {
        await q.interrupt()
      } catch {}
      setTimeout(() => q.close(), 20_000).unref()
    }, SCENARIO_LIMIT_MS)
    try {
      for await (const m of q) {
        seen(m)
        if (sc.interruptOnFirstDelta && !interrupted && m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') {
          interrupted = true
          q.interrupt().catch((e) => log({ dir: 'host', call: 'interrupt', error: String(e) }))
        }
        if (interrupted && m.type === 'result') ended = true
      }
    } catch (e) {
      meta.stopped[sc.name] = String(e)
      console.log(`  failed: ${e}`)
    } finally {
      clearTimeout(limit)
      ended = true
    }
    saveMeta()
    if (sc.history) {
      const id = meta.sessions[sc.resumeOf]
      const history = await getSessionMessages(id, { dir: work, includeSystemMessages: true })
      writeFileSync(join(out, 'history.raw.json'), JSON.stringify(history, null, 2))
    }
  }
  saveMeta()
  console.log(`done: ${out}\nwork folder: ${work}\nsessions: ${JSON.stringify(meta.sessions)}`)
}

// ----------------------------------------------------------------------------------------------------------------- scrub

/** words for the invented English that replaces what the model wrote */
const WORDS = (
  'the small garden keeps a quiet path where morning light settles on stones and leaves while a patient river ' +
  'carries old boats past the mill toward a market that opens early for bakers painters and travelers who share ' +
  'simple stories about weather roads bridges lanterns and the long summer evenings by the harbor'
).split(' ')

/** invented English with the line lengths of `text`, so the streamed pieces of a block can be cut from it at the same places */
function invent(text, seed) {
  let i = seed * 7
  return text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line
      const words = []
      let length = 0
      for (;;) {
        // the room left for the next word, after its space
        const room = line.length - length - (words.length ? 1 : 0)
        if (room <= 0) break
        let word = WORDS[i++ % WORDS.length]
        if (word.length > room) {
          const fits = WORDS.filter((w) => w.length === room)
          word = fits.length ? fits[seed % fits.length] : word.slice(0, room)
        }
        length += word.length + (words.length ? 1 : 0)
        words.push(word)
      }
      const s = words.join(' ').padEnd(line.length, '.')
      return s.charAt(0).toUpperCase() + s.slice(1)
    })
    .join('\n')
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const ZERO_UUID = '00000000-0000-0000-0000-000000000000'
/** the agents every Claude Code has; any other agent in a recording is left out */
const BUILTIN_AGENTS = ['general-purpose', 'Explore', 'Plan', 'statusline-setup']
const regexpOf = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function scrub(dir) {
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))

  // ids: one placeholder per real id, the same in every fixture
  const sessions = new Map()
  const sessionId = (id) => {
    const k = id.toLowerCase()
    if (!sessions.has(k)) sessions.set(k, `00000000-0000-4000-8000-${String(sessions.size + 1).padStart(12, '0')}`)
    return sessions.get(k)
  }
  for (const id of Object.values(meta.sessions)) sessionId(id)
  for (const ids of Object.values(meta.allSessions ?? {})) for (const id of ids) sessionId(id)
  const uuids = new Map()
  const uuid = (id) => {
    const k = id.toLowerCase()
    if (sessions.has(k)) return sessions.get(k)
    if (!uuids.has(k)) uuids.set(k, `11111111-1111-4111-8111-${String(uuids.size + 1).padStart(12, '0')}`)
    return uuids.get(k)
  }
  const fixtureIds = { msg: new Map(), toolu: new Map(), req: new Map() }
  const fixtureId = (kind, id) => {
    const m = fixtureIds[kind]
    if (!m.has(id)) m.set(id, `${kind}_fixture_${m.size + 1}`)
    return m.get(id)
  }

  // paths: \ and /, doubled \ (JSON inside a string), either case, Git Bash's /c/…, and the ~/.claude/projects folder name
  const spellings = (p) => {
    const set = new Set([p, p.replace(/\\/g, '/'), p.replace(/\\/g, '\\\\')])
    if (/^[a-z]:\\/i.test(p)) set.add(`/${p[0].toLowerCase()}${p.slice(2).replace(/\\/g, '/')}`)
    return [...set]
  }
  const munged = (p) => p.replace(/[^A-Za-z0-9]/g, '-')
  const recordDir = dirname(meta.settings)
  const pathRules = [
    ...spellings(meta.settings).map((s) => [s, '{{SETTINGS}}']),
    ...spellings(recordDir).map((s) => [s, '{{SETTINGS_DIR}}']),
    ...spellings(meta.work).map((s) => [s, '{{CWD}}']),
    [munged(meta.work), '{{CWD}}'],
    ...spellings(meta.home).map((s) => [s, '{{HOME}}']),
    [munged(meta.home), '{{HOME}}']
  ]
    .sort((a, b) => b[0].length - a[0].length)
    .map(([from, to]) => [new RegExp(regexpOf(from), 'gi'), to])

  const str = (s) => {
    let r = s
    for (const [from, to] of pathRules) r = r.replace(from, to)
    r = r.replace(EMAIL, 'user@example.com')
    r = r.replace(/\bmsg_(?!fixture_)[A-Za-z0-9]{8,}/g, (m) => fixtureId('msg', m))
    r = r.replace(/\btoolu_(?!fixture_)[A-Za-z0-9_]{8,}/g, (m) => fixtureId('toolu', m))
    r = r.replace(/\breq_(?!fixture_)[A-Za-z0-9_]{8,}/g, (m) => fixtureId('req', m))
    r = r.replace(UUID, (m) => uuid(m))
    r = r.replace(/cc-msg-[0-9a-f]{16,}/g, 'cc-msg-fixture')
    return r
  }
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if ((key === 'session_id' || key === 'sessionId') && /^[0-9a-f-]{36}$/i.test(v)) return sessionId(v)
      if ((key === 'request_id' || key === 'requestId') && !v.startsWith('req_fixture_')) return fixtureId('req', v)
      return str(v)
    }
    if (typeof v === 'number' && key === 'pid') return 4242
    if (Array.isArray(v)) return v.map((x) => walk(x, key))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]))
    return v
  }

  // what the model wrote becomes invented English; the same text the same way everywhere (a block, its deltas, the result)
  const invented = new Map()
  let seed = 0
  const inventText = (t) => {
    if (typeof t !== 'string' || !t) return t
    if (!invented.has(t)) invented.set(t, invent(t, ++seed))
    return invented.get(t)
  }
  /** whether the last assistant message was Claude Code's own output of a local command (/context, /config): kept as it is, and its result too */
  let commandOutput = false
  const rewriteAssistant = (message) => {
    if (!Array.isArray(message?.content)) return
    commandOutput = message.model === '<synthetic>'
    if (commandOutput) return
    for (const b of message.content) {
      if (b.type === 'text') b.text = inventText(b.text)
      if (b.type === 'thinking') {
        b.thinking = inventText(b.thinking)
        if (b.signature) b.signature = 'fixture-signature'
      }
      if (b.type === 'redacted_thinking') b.data = 'fixture-redacted'
    }
  }
  const rewriteUser = (m) => {
    const c = m.message?.content
    // a compaction's summary is the model's writing; the line before it is Claude Code's
    if (typeof c === 'string' && c.startsWith('This session is being continued') && c.includes('Summary:')) {
      const at = c.indexOf('Summary:') + 'Summary:'.length
      m.message.content = c.slice(0, at) + inventText(c.slice(at))
    }
  }

  /** the parts of init, the initialize reply and the limits that describe the user's machine, account and setup */
  const structural = (m) => {
    if (m.type === 'system' && m.subtype === 'init') {
      m.mcp_servers = []
      m.plugins = []
      m.skills = []
      if (Array.isArray(m.agents)) m.agents = m.agents.filter((a) => BUILTIN_AGENTS.includes(a))
      if (Array.isArray(m.slash_commands)) m.slash_commands = [...m.slash_commands, 'acme-deploy']
      if (Array.isArray(m.tools)) m.tools = m.tools.filter((t) => !String(t).startsWith('mcp__'))
    }
    const r = m.type === 'control_response' ? m.response?.response : null
    if (r && typeof r === 'object') {
      if (Array.isArray(r.commands) && r.commands.length) {
        const shape = r.commands[0]
        const blank = Object.fromEntries(Object.keys(shape).map((k) => [k, typeof shape[k] === 'string' ? '' : shape[k]]))
        r.commands = [...r.commands, { ...blank, name: 'acme-deploy', description: 'Deploy the Acme service (project)' }]
      }
      if (Array.isArray(r.agents)) r.agents = r.agents.filter((a) => BUILTIN_AGENTS.includes(a?.name))
      if (r.account && typeof r.account === 'object') {
        const a = {}
        for (const [k, v] of Object.entries(r.account)) {
          if (k === 'email') a[k] = 'user@example.com'
          else if (/uuid/i.test(k)) a[k] = ZERO_UUID
          else if (/organi[sz]ation/i.test(k)) a[k] = 'Example Org'
          else if (/subscription/i.test(k)) a[k] = 'pro'
          else if (/name/i.test(k)) a[k] = 'Example User'
          else a[k] = v
        }
        r.account = a
      }
    }
    if (m.type === 'rate_limit_event' && m.rate_limit_info) {
      const limits = (o) => {
        if (!o || typeof o !== 'object') return
        if (typeof o.resetsAt === 'number') o.resetsAt = 1893456000
        if (typeof o.utilization === 'number') o.utilization = o.status === 'allowed_warning' ? 0.8 : 0.5
        for (const v of Object.values(o)) limits(v)
      }
      limits(m.rate_limit_info)
    }
    return m
  }

  const scrubMessage = (m, dir) => {
    if (!m || typeof m !== 'object') return typeof m === 'string' ? str(m) : m
    structural(m)
    if (dir === 'out' || dir === 'history') {
      if (m.type === 'assistant') rewriteAssistant(m.message)
      if (m.type === 'user') rewriteUser(m)
      if (m.type === 'result' && typeof m.result === 'string' && !commandOutput) m.result = inventText(m.result)
    }
    return walk(m)
  }

  mkdirSync(fixturesDir, { recursive: true })
  const names = readdirSync(dir).filter((f) => f.endsWith('.raw.jsonl')).map((f) => f.slice(0, -'.raw.jsonl'.length))
  for (const name of names) {
    const entries = readFileSync(join(dir, `${name}.raw.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.dir === 'in' || e.dir === 'out')
    // a streamed block's pieces are joined, the whole is replaced, and the same number of pieces is cut from it again
    const blockKey = (m, n) => `${m.parent_tool_use_id ?? ''}:${n}:${m.event?.index}`
    const PIECE = { text_delta: 'text', thinking_delta: 'thinking', input_json_delta: 'partial_json' }
    const blocks = new Map()
    let n = 0
    for (const { dir: d, line: m } of entries) {
      if (d !== 'out' || m?.type !== 'stream_event') continue
      if (m.event?.type === 'message_start') n++
      const field = PIECE[m.event?.delta?.type]
      if (!field) continue
      const b = blocks.get(blockKey(m, n)) ?? { kind: m.event.delta.type, pieces: [] }
      b.pieces.push(m.event.delta[field])
      blocks.set(blockKey(m, n), b)
    }
    for (const b of blocks.values()) {
      const whole = b.pieces.join('')
      let replaced
      if (b.kind === 'input_json_delta') {
        try {
          replaced = JSON.stringify(walk(JSON.parse(whole)))
        } catch {
          replaced = str(whole)
        }
      } else replaced = inventText(whole)
      // cut at the original lengths, scaled to the new whole, never inside a {{PLACEHOLDER}}
      const scale = whole.length ? replaced.length / whole.length : 1
      const snap = (end) => {
        const open = replaced.lastIndexOf('{{', end - 1)
        const close = open < 0 ? -1 : replaced.indexOf('}}', open)
        return open >= 0 && open < end && close + 2 > end ? close + 2 : end
      }
      let at = 0
      let done = 0
      b.cut = b.pieces.map((p, i) => {
        done += p.length
        const end = i === b.pieces.length - 1 ? replaced.length : Math.max(at, snap(Math.round(done * scale)))
        const piece = replaced.slice(at, end)
        at = end
        return piece
      })
      b.next = 0
    }
    n = 0
    const lines = []
    for (const { dir: d, line } of entries) {
      const m = structuredClone(line)
      if (d === 'out' && m?.type === 'stream_event') {
        if (m.event?.type === 'message_start') n++
        const field = PIECE[m.event?.delta?.type]
        if (field) {
          const b = blocks.get(blockKey(m, n))
          m.event.delta[field] = b.cut[b.next++]
        }
        if (m.event?.delta?.type === 'signature_delta') m.event.delta.signature = 'fixture-signature'
        const cb = m.event?.content_block
        if (cb?.type === 'text' && cb.text) cb.text = inventText(cb.text)
        if (cb?.type === 'thinking' && cb.thinking) cb.thinking = inventText(cb.thinking)
        if (cb?.signature) cb.signature = 'fixture-signature'
        if (m.event?.message?.content) rewriteAssistant(m.event.message)
      }
      lines.push(JSON.stringify({ dir: d, line: scrubMessage(m, d) }))
    }
    writeFileSync(join(fixturesDir, `${name}.jsonl`), lines.join('\n') + '\n')
  }

  // spawn-args.json: what the SDK hands spawnClaudeCodeProcess (the answer scenario), and what other options add to it
  const base = meta.spawn.answer
  const extra = (args) => {
    const rest = [...args]
    for (const a of base.args) {
      const i = rest.indexOf(a)
      if (i >= 0) rest.splice(i, 1)
    }
    return rest
  }
  const spawnArgs = {
    command: "the SDK's own binary (node_modules/@anthropic-ai/claude-agent-sdk-<platform>/claude[.exe]): never run, spawnClaudeCodeProcess starts the user's claude",
    args: walk(base.args),
    cwd: '{{CWD}}',
    envAdded: walk(base.envAdded),
    argsAddedBy: {
      "permissionMode: 'plan'": walk(extra(meta.spawn.plan.args)),
      'resume: <session id>': walk(extra(meta.spawn.resume.args))
    }
  }
  writeFileSync(join(fixturesDir, 'spawn-args.json'), JSON.stringify(spawnArgs, null, 2) + '\n')

  const history = JSON.parse(readFileSync(join(dir, 'history.raw.json'), 'utf8')).map((m) => scrubMessage(structuredClone(m), 'history'))
  writeFileSync(join(fixturesDir, 'history.json'), JSON.stringify(history, null, 2) + '\n')
  console.log(`scrubbed ${names.length} scenarios into ${fixturesDir}`)
  for (const [name, id] of Object.entries(meta.sessions)) console.log(`  ${name}: ${sessions.get(id.toLowerCase())}`)
  for (const [name, ids] of Object.entries(meta.allSessions ?? {})) if (!meta.sessions[name]) console.log(`  ${name}: ${ids.map((id) => sessions.get(id.toLowerCase())).join(', ')}`)
}

const args = process.argv.slice(2)
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
if (args[0] === '--scrub') {
  if (!args[1]) throw new Error('usage: node scripts/record-chat-fixtures.mjs --scrub <recording folder>')
  scrub(args[1])
} else {
  // --only a,b records just those scenarios; --into <dir> adds them to an earlier recording (its work folder and settings)
  await record(flag('--only')?.split(','), flag('--into'))
}
