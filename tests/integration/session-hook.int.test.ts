import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { hookCommandString, writeClaudeTabFiles } from '../../src/main/claude-tab-settings'
import { startPipeServer, type PipeServerHandle } from '../../src/main/pipe-server'
import type { PipeMessage, PipeResponse } from '../../src/shared/protocol'
import { testPipeName, WIN } from '../fixtures/platform'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const TP = WIN ? 'C:\\Users\\me\\.claude\\projects\\D--x\\s.jsonl' : '/home/me/.claude/projects/-x/s.jsonl'
const INPUT = JSON.stringify({ session_id: SID, transcript_path: TP, hook_event_name: 'SessionStart', source: 'startup' })
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
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
  context: { usedTokens: 82314, size: 200000, usedPct: 41.2 }, fiveHour: null, sevenDay: null
}

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
  const pipe = testPipeName('test')
  const got: PipeMessage[] = []
  const take = (m: PipeMessage): PipeResponse => {
    got.push(m)
    return { ok: true }
  }
  server = await startPipeServer(pipe, {
    showImage: async () => ({ ok: true }), session: take, status: take, subagent: take, sessionEnd: take, attention: take,
    turn: take, editBefore: take, showDiff: async (m) => take(m)
  })
  return { pipe, got }
}

const expected = { v: 1, type: 'session', tabId: TAB, sessionId: SID, source: 'startup', transcriptPath: TP }

/** the hook script in a folder of its own, for paths with spaces and apostrophes */
function bundleIn(folder: string): string {
  const dir = join(work, folder)
  mkdirSync(dir, { recursive: true })
  const copy = join(dir, 'session-hook.js')
  copyFileSync(bundle, copy)
  return copy
}

type SettingsHook = { command: string; args?: string[] }

/** the first hook the settings file declares for the event */
function settingsHook(settingsPath: string, event: string): SettingsHook {
  return (JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks: Record<string, { hooks: SettingsHook[] }[]> }).hooks[event][0].hooks[0]
}

/** runs the hook as Claude Code runs an exec-form hook: the executable with its arguments, no shell */
function runExecForm(hook: SettingsHook, env: Record<string, string>, input = INPUT): Promise<{ code: number | null; stdout: string }> {
  return run(hook.command, hook.args ?? [], env, input)
}

describe('session hook end to end', () => {
  it('node bundle: sends the session and prints nothing', async () => {
    const { pipe, got } = await listen()
    const r = await run(process.execPath, [bundle], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe })
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([expected])
  })

  it('node bundle: StopFailure forwards the end of the turn with the error it ended in and prints nothing', async () => {
    const { pipe, got } = await listen()
    const failure = JSON.stringify({ session_id: SID, hook_event_name: 'StopFailure', error: 'server_error', last_assistant_message: 'API Error: The response stopped arriving. The response above may be incomplete.' })
    const r = await run(process.execPath, [bundle], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }, failure)
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([{ v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'done', error: 'server_error' }])
  })

  it.runIf(WIN)('the exec-form hook from the settings file runs with no shell and no batch file, and passes stdin through', async () => {
    const { pipe, got } = await listen()
    const { settingsPath } = writeClaudeTabFiles(join(work, 'data-exec'), process.execPath, bundle)
    const r = await runExecForm(settingsHook(settingsPath, 'SessionStart'), { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe })
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([expected])
  })

  it.runIf(WIN)('the exec-form hook runs a script in a folder with an apostrophe and a space', async () => {
    const { pipe, got } = await listen()
    const { settingsPath } = writeClaudeTabFiles(join(work, 'data-exec-quoted'), process.execPath, bundleIn("Bob's data"))
    const r = await runExecForm(settingsHook(settingsPath, 'SessionStart'), { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe })
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([expected])
  })

  // a user name such as R&D puts cmd's special characters into both paths, and a path without spaces goes to cmd unquoted
  it.runIf(WIN)('the exec-form hook runs a script in a folder with cmd\'s special characters, with and without a space', async () => {
    const { pipe, got } = await listen()
    for (const [i, folder] of ['R&D^(1)%OS%', 'R&D ^(2)'].entries()) {
      const { settingsPath } = writeClaudeTabFiles(join(work, `data-exec-special-${i}`), process.execPath, bundleIn(folder))
      const r = await runExecForm(settingsHook(settingsPath, 'SessionStart'), { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe })
      expect(r).toEqual({ code: 0, stdout: '' })
    }
    expect(got).toEqual([expected, expected])
  })

  it.skipIf(!existsSync(GIT_BASH))('the statusLine command string from the settings file runs from Git Bash', async () => {
    const { pipe, got } = await listen()
    const { settingsPath } = writeClaudeTabFiles(join(work, 'data-status'), process.execPath, bundleIn("Bob's status"))
    const command = (JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine: { command: string } }).statusLine.command
    const r = await run(GIT_BASH, ['-c', command], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }, STATUS_INPUT)
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([expectedStatus])
  })

  it.runIf(WIN)('SubagentStart via the exec-form hook forwards a subagent message', async () => {
    const { pipe, got } = await listen()
    const { settingsPath } = writeClaudeTabFiles(join(work, 'data-sub'), process.execPath, bundle)
    const r = await runExecForm(settingsHook(settingsPath, 'SubagentStart'), { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }, SUBAGENT_INPUT)
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([{ v: 1, type: 'subagent', tabId: TAB, sessionId: SID, event: 'start', agentId: AGENT, agentType: 'Explore' }])
  })

  it.runIf(WIN)('Stop and AskUserQuestion via the exec-form hooks forward attention and print nothing', async () => {
    const { pipe, got } = await listen()
    const { settingsPath } = writeClaudeTabFiles(join(work, 'data-attention'), process.execPath, bundle)
    const env = { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }
    const ask = JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [] } })
    const stop = JSON.stringify({ session_id: SID, hook_event_name: 'Stop', stop_hook_active: false })
    // anything on stdout would be read by Claude Code as a hook decision
    expect(await runExecForm(settingsHook(settingsPath, 'PreToolUse'), env, ask)).toEqual({ code: 0, stdout: '' })
    expect(await runExecForm(settingsHook(settingsPath, 'Stop'), env, stop)).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([
      { v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'question' },
      { v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'done' }
    ])
  })

  it.runIf(!WIN)('the generated .sh, run by sh -c the way Claude Code runs hooks, passes stdin through', async () => {
    const { pipe, got } = await listen()
    const { hookPath } = writeClaudeTabFiles(join(work, 'data-sh'), process.execPath, bundle)
    const r = await run('/bin/sh', ['-c', hookCommandString(hookPath!)], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe })
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([expected])
  })

  it.runIf(!WIN)('the .sh works from a folder with an apostrophe and a space', async () => {
    const { pipe, got } = await listen()
    const { hookPath } = writeClaudeTabFiles(join(work, "Bob's data sh"), process.execPath, bundle)
    const r = await run('/bin/sh', ['-c', hookCommandString(hookPath!)], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe })
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
    expect(await run('/bin/sh', ['-c', hookCommandString(hookPath!)], env, ask)).toEqual({ code: 0, stdout: '' })
    expect(await run('/bin/sh', ['-c', hookCommandString(hookPath!)], env, stop)).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([
      { v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'question' },
      { v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'done' }
    ])
  })

  it('exits 0 silently when ClaudeTerm is not running', async () => {
    const r = await run(process.execPath, [bundle], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: testPipeName('none') })
    expect(r).toEqual({ code: 0, stdout: '' })
  })
})
