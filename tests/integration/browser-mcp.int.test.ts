import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { build } from 'esbuild'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startPipeServer, type PipeServerHandle } from '../../src/main/pipe-server'
import { BROWSER_TOOL_NAMES } from '../../src/shared/browser'
import type { BrowserMessage, PipeResponse } from '../../src/shared/protocol'
import { testPipeName } from '../fixtures/platform'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const work = realpathSync(mkdtempSync(join(tmpdir(), 'ct-browserint-')))
const bundle = join(work, 'show-image-server.js')
const pipe = testPipeName('browser')
const browserMsgs: BrowserMessage[] = []
// what the stub answers the next browser message with
let browserReply: PipeResponse = { ok: true, info: 'Done.' }
let server: PipeServerHandle

/** a client of the bundled server, started with the given environment */
async function connect(env: Record<string, string | undefined>): Promise<Client> {
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (v !== undefined) merged[k] = v
  const transport = new StdioClientTransport({ command: process.execPath, args: [bundle], cwd: work, env: merged })
  const client = new Client({ name: 'claudeterm-test', version: '1.0.0' })
  await client.connect(transport)
  return client
}

const inTab = { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }

beforeAll(async () => {
  await build({ entryPoints: [resolve(__dirname, '../../src/mcp/show-image-server.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' })
  server = await startPipeServer(pipe, { showImage: async () => ({ ok: true }), session: () => ({ ok: true }), status: () => ({ ok: true }), subagent: () => ({ ok: true }), sessionEnd: () => ({ ok: true }), attention: () => ({ ok: true }), turn: () => ({ ok: true }), editBefore: () => ({ ok: true }), deviceStatus: () => ({ ok: true }), openDeviceSettings: () => ({ ok: true }), showDocument: async () => ({ ok: true }), showDiff: async () => ({ ok: true }), taskList: () => ({ ok: true }), taskListGet: () => ({ ok: true }), agentList: () => ({ ok: true }), agentSend: () => ({ ok: true }), coord: async () => ({ ok: true }), browser: async (m) => { browserMsgs.push(m); return browserReply }, noteRead: () => ({ ok: true }), noteAdd: () => ({ ok: true }), noteCheck: () => ({ ok: true }), mailWait: async () => ({ ok: true }) })
})

afterAll(async () => { await server.close() })

describe('browser MCP tools', () => {
  it('lists all the browser tools and says how to use them', async () => {
    const client = await connect(inTab)
    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining([...BROWSER_TOOL_NAMES]))
    expect(BROWSER_TOOL_NAMES).toHaveLength(19)
    const instructions = client.getInstructions() ?? ''
    expect(instructions).toContain('browser_snapshot')
    expect(instructions).toContain('the person\'s permission')
    await client.close()
  })

  it('sends a click on a snapshot ref to ClaudeTerm and returns what it says', async () => {
    const client = await connect(inTab)
    const before = browserMsgs.length
    browserReply = { ok: true, info: 'Clicked Sign in.' }
    const res = await client.callTool({ name: 'browser_click', arguments: { ref: 'e3', element: 'Sign in' } })
    expect(res.isError).toBeFalsy()
    expect(res.content).toEqual([{ type: 'text', text: 'Clicked Sign in.' }])
    expect(browserMsgs.slice(before)).toEqual([{ v: 1, type: 'browser', tabId: TAB, command: { op: 'click', ref: 'e3', element: 'Sign in', button: 'left', doubleClick: false } }])
    await client.close()
  })

  it('returns a screenshot as an image with its text', async () => {
    const client = await connect(inTab)
    browserReply = { ok: true, info: 'shot', image: { data: 'AAAA', mimeType: 'image/png' } }
    const res = await client.callTool({ name: 'browser_take_screenshot', arguments: {} })
    expect(res.isError).toBeFalsy()
    expect(res.content).toEqual([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'text', text: 'shot' }])
    await client.close()
  })

  it('answers a refusal from ClaudeTerm as an error with its text', async () => {
    const client = await connect(inTab)
    browserReply = { ok: false, error: 'The person did not allow example.com.' }
    const res = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com' } })
    expect(res.isError).toBe(true)
    expect(res.content).toEqual([{ type: 'text', text: 'The person did not allow example.com.' }])
    await client.close()
  })

  it('says the browser works only in a Claude tab when no tab is set, and sends nothing', async () => {
    const client = await connect({ CLAUDETERM_TAB_ID: undefined, CLAUDETERM_PIPE: pipe })
    const before = browserMsgs.length
    const res = await client.callTool({ name: 'browser_snapshot', arguments: {} })
    expect(res.isError).toBe(true)
    expect(res.content).toEqual([{ type: 'text', text: 'The browser works only in a ClaudeTerm Claude tab.' }])
    expect(browserMsgs.length).toBe(before)
    await client.close()
  })

  it('says ClaudeTerm is not running when nothing listens on the pipe', async () => {
    const client = await connect({ CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: testPipeName('browser-nobody-listens') })
    const res = await client.callTool({ name: 'browser_snapshot', arguments: {} })
    expect(res.isError).toBe(true)
    expect(res.content).toEqual([{ type: 'text', text: 'ClaudeTerm is not running; the browser is not available.' }])
    await client.close()
  })

  it('refuses a text longer than the limit in the schema and sends nothing', async () => {
    const client = await connect(inTab)
    const before = browserMsgs.length
    const outcome = await client.callTool({ name: 'browser_type', arguments: { ref: 'e1', element: 'Search', text: 'x'.repeat(20_001) } }).then(
      (r) => (r.isError ? 'error' : 'ok'),
      () => 'error'
    )
    expect(outcome).toBe('error')
    expect(browserMsgs.length).toBe(before)
    await client.close()
  })
})
