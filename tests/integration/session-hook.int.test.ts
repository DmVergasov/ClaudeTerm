import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { hookCommandString, writeClaudeTabFiles } from '../../src/main/claude-tab-settings'
import { startPipeServer, type PipeServerHandle } from '../../src/main/pipe-server'
import type { PipeMessage, PipeResponse } from '../../src/shared/protocol'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const TP = 'C:\\Users\\me\\.claude\\projects\\D--x\\s.jsonl'
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
  const pipe = `\\\\.\\pipe\\claudeterm-test-${randomUUID()}`
  const got: PipeMessage[] = []
  const take = (m: PipeMessage): PipeResponse => {
    got.push(m)
    return { ok: true }
  }
  server = await startPipeServer(pipe, { showImage: async () => ({ ok: true }), session: take, status: take, subagent: take, sessionEnd: take, attention: take })
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

  it.skipIf(!existsSync(GIT_BASH))('hook command string runs from Git Bash with an apostrophe and a space in the path', async () => {
    const { pipe, got } = await listen()
    const { cmdPath } = writeClaudeTabFiles(join(work, "Bob's data"), process.execPath, bundle)
    const r = await run(GIT_BASH, ['-c', hookCommandString(cmdPath)], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe })
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([expected])
  })

  it.skipIf(!existsSync(GIT_BASH))('hook command string runs from Git Bash with an apostrophe and no space', async () => {
    const { pipe, got } = await listen()
    const { cmdPath } = writeClaudeTabFiles(join(work, "Bob's"), process.execPath, bundle)
    const r = await run(GIT_BASH, ['-c', hookCommandString(cmdPath)], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe })
    expect(r).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([expected])
  })

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

  it('Stop and AskUserQuestion via the generated .cmd forward attention and print nothing', async () => {
    const { pipe, got } = await listen()
    const { cmdPath } = writeClaudeTabFiles(join(work, 'data-attention'), process.execPath, bundle)
    const env = { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }
    const ask = JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [] } })
    const stop = JSON.stringify({ session_id: SID, hook_event_name: 'Stop', stop_hook_active: false })
    // anything on stdout would be read by Claude Code as a hook decision
    expect(await run('cmd.exe', ['/d', '/c', cmdPath], env, ask)).toEqual({ code: 0, stdout: '' })
    expect(await run('cmd.exe', ['/d', '/c', cmdPath], env, stop)).toEqual({ code: 0, stdout: '' })
    expect(got).toEqual([
      { v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'question' },
      { v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'done' }
    ])
  })

  it('exits 0 silently when ClaudeTerm is not running', async () => {
    const r = await run(process.execPath, [bundle], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: `\\\\.\\pipe\\claudeterm-none-${randomUUID()}` })
    expect(r).toEqual({ code: 0, stdout: '' })
  })
})
