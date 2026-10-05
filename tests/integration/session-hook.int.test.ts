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

  it('exits 0 silently when ClaudeTerm is not running', async () => {
    const r = await run(process.execPath, [bundle], { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: `\\\\.\\pipe\\claudeterm-none-${randomUUID()}` })
    expect(r).toEqual({ code: 0, stdout: '' })
  })
})
