import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startPipeServer, type PipeServerHandle } from '../../src/main/pipe-server'
import type { AgentListMessage, AgentSendMessage, NoteAddMessage, NoteCheckMessage, NoteReadMessage, ShowDiffMessage, ShowDocumentMessage, ShowImageMessage, TaskListGetMessage, TaskListMessage } from '../../src/shared/protocol'
import { testPipeName } from '../fixtures/platform'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
// by its real path, the server's working folder (macOS's temp folder is in /var, a link to /private/var)
const work = realpathSync(mkdtempSync(join(tmpdir(), 'ct-mcpint-')))
const bundle = join(work, 'show-image-server.js')
const pipe = testPipeName('test')
const got: ShowImageMessage[] = []
const diffs: ShowDiffMessage[] = []
const docs: ShowDocumentMessage[] = []
const taskLists: TaskListMessage[] = []
const taskListGets: TaskListGetMessage[] = []
const deviceMsgs: unknown[] = []
const agentLists: AgentListMessage[] = []
const agentSends: AgentSendMessage[] = []
const noteMsgs: (NoteReadMessage | NoteAddMessage | NoteCheckMessage)[] = []
let server: PipeServerHandle

beforeAll(async () => {
  await build({ entryPoints: [resolve(__dirname, '../../src/mcp/show-image-server.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' })
  server = await startPipeServer(pipe, { showImage: async (m) => { got.push(m); return { ok: true } }, session: () => ({ ok: true }), status: () => ({ ok: true }), subagent: () => ({ ok: true }), sessionEnd: () => ({ ok: true }), attention: () => ({ ok: true }), turn: () => ({ ok: true }), editBefore: () => ({ ok: true }), deviceStatus: (m) => { deviceMsgs.push(m); return { ok: true, info: 'status text' } }, openDeviceSettings: (m) => { deviceMsgs.push(m); return { ok: true } }, showDocument: async (m) => { docs.push(m); return { ok: true, info: 'Opened out/spec.md in the Docs panel.' } }, showDiff: async (m) => { diffs.push(m); return { ok: true, info: 'Opened 1 file (+1 −0) in the Changes panel.' } }, taskList: (m) => { taskLists.push(m); return { ok: true, info: 'Task list updated: 1 of 2 done.' } }, taskListGet: (m) => { taskListGets.push(m); return { ok: true, info: 'Release prep: 1 of 2 done' } }, agentList: (m) => { agentLists.push(m); return { ok: true, info: 'api-server · Desktop [3be5d1] · idle' } }, agentSend: (m) => { agentSends.push(m); return { ok: true, info: 'Delivered to api-server · Desktop.' } }, noteRead: (m) => { noteMsgs.push(m); return { ok: true, info: '## Session note\n- [ ] Tag' } }, noteAdd: (m) => { noteMsgs.push(m); return { ok: true, info: 'Added to the project note.' } }, noteCheck: (m) => { noteMsgs.push(m); return { ok: true, info: 'Ticked: Tag.' } },mailWait: async () => ({ ok: true }) })
  mkdirSync(join(work, 'out'))
  writeFileSync(join(work, 'out', 'plot.png'), Buffer.from([1, 2, 3]))
  writeFileSync(join(work, 'out', 'spec.md'), '# Spec\n')
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
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['add_to_note', 'check_note_item', 'device_status', 'get_task_list', 'list_agents', 'message_agent', 'open_device_settings', 'read_notes', 'set_task_list', 'show_diff', 'show_document', 'show_image'])
    const instructions = client.getInstructions() ?? ''
    for (const name of ['ListAgents', 'SendMessage', 'list_agents', 'message_agent', 'read_notes', 'add_to_note', 'check_note_item']) expect(instructions).toContain(name)
    const res = await client.callTool({ name: 'show_image', arguments: { path: 'out/plot.png', caption: 'Plot' } })
    expect(res.isError).toBeFalsy()
    expect(res.content).toEqual([{ type: 'text', text: `Shown in ClaudeTerm: ${join(work, 'out', 'plot.png')}` }])
    expect(got).toEqual([{ v: 1, type: 'show_image', tabId: TAB, path: join(work, 'out', 'plot.png'), caption: 'Plot' }])
    await client.close()
  })

  it('forwards show_diff with paths resolved against its folder', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      cwd: work,
      env: { ...(process.env as Record<string, string>), CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }
    })
    const client = new Client({ name: 'claudeterm-test', version: '1.0.0' })
    await client.connect(transport)
    const res = await client.callTool({ name: 'show_diff', arguments: { from: 'HEAD~1', paths: ['out'] } })
    expect(res.isError).toBeFalsy()
    expect(res.content).toEqual([{ type: 'text', text: 'Opened 1 file (+1 −0) in the Changes panel.' }])
    expect(diffs).toEqual([{ v: 1, type: 'show_diff', tabId: TAB, cwd: work, scope: null, from: 'HEAD~1', to: null, paths: [join(work, 'out')], title: null }])
    await client.close()
  })

  it('forwards show_document with its path resolved against its folder', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      cwd: work,
      env: { ...(process.env as Record<string, string>), CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }
    })
    const client = new Client({ name: 'claudeterm-test', version: '1.0.0' })
    await client.connect(transport)
    const res = await client.callTool({ name: 'show_document', arguments: { path: 'out/spec.md' } })
    expect(res.isError).toBeFalsy()
    expect(res.content).toEqual([{ type: 'text', text: 'Opened out/spec.md in the Docs panel.' }])
    expect(docs).toEqual([{ v: 1, type: 'show_document', tabId: TAB, path: join(work, 'out', 'spec.md'), title: null }])
    await client.close()
  })

  it('forwards set_task_list to ClaudeTerm and answers what it says', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      cwd: work,
      env: { ...(process.env as Record<string, string>), CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }
    })
    const client = new Client({ name: 'claudeterm-test', version: '1.0.0' })
    await client.connect(transport)
    const tasks = [{ title: 'Write the spec', status: 'completed' }, { title: 'Review it', status: 'pending' }]
    const res = await client.callTool({ name: 'set_task_list', arguments: { title: 'Release prep', tasks } })
    expect(res.isError).toBeFalsy()
    expect(res.content).toEqual([{ type: 'text', text: 'Task list updated: 1 of 2 done.' }])
    expect(taskLists).toEqual([{ v: 1, type: 'task_list', tabId: TAB, list: { title: 'Release prep', tasks } }])
    await client.close()
  })

  it('answers get_task_list with the list ClaudeTerm reads', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      cwd: work,
      env: { ...(process.env as Record<string, string>), CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }
    })
    const client = new Client({ name: 'claudeterm-test', version: '1.0.0' })
    await client.connect(transport)
    const res = await client.callTool({ name: 'get_task_list', arguments: {} })
    expect(res.isError).toBeFalsy()
    expect(res.content).toEqual([{ type: 'text', text: 'Release prep: 1 of 2 done' }])
    expect(taskListGets).toEqual([{ v: 1, type: 'task_list_get', tabId: TAB }])
    await client.close()
  })

  it('forwards device_status and open_device_settings to ClaudeTerm', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      cwd: work,
      env: { ...(process.env as Record<string, string>), CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }
    })
    const client = new Client({ name: 'claudeterm-test', version: '1.0.0' })
    await client.connect(transport)
    const status = await client.callTool({ name: 'device_status', arguments: {} })
    expect(status.isError).toBeFalsy()
    expect(status.content).toEqual([{ type: 'text', text: 'status text' }])
    const opened = await client.callTool({ name: 'open_device_settings', arguments: {} })
    expect(opened.isError).toBeFalsy()
    expect(opened.content).toEqual([{ type: 'text', text: 'Opened Settings → Devices in ClaudeTerm.' }])
    expect(deviceMsgs).toEqual([{ v: 1, type: 'device_status' }, { v: 1, type: 'open_device_settings' }])
    await client.close()
  })

  it('forwards list_agents and message_agent to ClaudeTerm and answers what it says', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      cwd: work,
      env: { ...(process.env as Record<string, string>), CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }
    })
    const client = new Client({ name: 'claudeterm-test', version: '1.0.0' })
    await client.connect(transport)
    const listed = await client.callTool({ name: 'list_agents', arguments: {} })
    expect(listed.isError).toBeFalsy()
    expect(listed.content).toEqual([{ type: 'text', text: 'api-server · Desktop [3be5d1] · idle' }])
    expect(agentLists).toEqual([{ v: 1, type: 'agent_list', tabId: TAB }])
    const replyTo = '1b0e6d2a-7c3f-4e8b-9a51-0d4c2f6e8a73'
    const sent = await client.callTool({ name: 'message_agent', arguments: { to: 'api-server', text: 'Hello', reply_to: replyTo } })
    expect(sent.isError).toBeFalsy()
    expect(sent.content).toEqual([{ type: 'text', text: 'Delivered to api-server · Desktop.' }])
    expect(agentSends).toEqual([{ v: 1, type: 'agent_send', tabId: TAB, to: 'api-server', text: 'Hello', replyTo }])
    await client.close()
  })

  it('forwards read_notes, add_to_note and check_note_item to ClaudeTerm and answers what it says', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      cwd: work,
      env: { ...(process.env as Record<string, string>), CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: pipe }
    })
    const client = new Client({ name: 'claudeterm-test', version: '1.0.0' })
    await client.connect(transport)
    const read = await client.callTool({ name: 'read_notes', arguments: {} })
    expect(read.isError).toBeFalsy()
    expect(read.content).toEqual([{ type: 'text', text: '## Session note\n- [ ] Tag' }])
    const added = await client.callTool({ name: 'add_to_note', arguments: { note: 'project', text: '- [ ] Tag' } })
    expect(added.isError).toBeFalsy()
    expect(added.content).toEqual([{ type: 'text', text: 'Added to the project note.' }])
    const ticked = await client.callTool({ name: 'check_note_item', arguments: { note: 'session', item: 'Tag', checked: true } })
    expect(ticked.isError).toBeFalsy()
    expect(ticked.content).toEqual([{ type: 'text', text: 'Ticked: Tag.' }])
    expect(noteMsgs).toEqual([
      { v: 1, type: 'note_read', tabId: TAB },
      { v: 1, type: 'note_add', tabId: TAB, note: 'project', text: '- [ ] Tag' },
      { v: 1, type: 'note_check', tabId: TAB, note: 'session', item: 'Tag', checked: true }
    ])
    await client.close()
  })
})
