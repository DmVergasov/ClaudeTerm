import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startPipeServer, type PipeServerHandle } from '../../src/main/pipe-server'
import type { ShowImageMessage } from '../../src/shared/protocol'
import { testPipeName } from '../fixtures/platform'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const work = mkdtempSync(join(tmpdir(), 'ct-mcpint-'))
const bundle = join(work, 'show-image-server.js')
const pipe = testPipeName('test')
const got: ShowImageMessage[] = []
let server: PipeServerHandle

beforeAll(async () => {
  await build({ entryPoints: [resolve(__dirname, '../../src/mcp/show-image-server.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' })
  server = await startPipeServer(pipe, { showImage: async (m) => { got.push(m); return { ok: true } }, session: () => ({ ok: true }), status: () => ({ ok: true }), subagent: () => ({ ok: true }), sessionEnd: () => ({ ok: true }), attention: () => ({ ok: true }) })
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
