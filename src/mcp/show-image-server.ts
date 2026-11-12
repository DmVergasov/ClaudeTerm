import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { userInfo } from 'node:os'
import { z } from 'zod'
import { sendPipeMessage } from '../shared/pipe-client'
import { defaultPipeName, isUuid } from '../shared/protocol'
import { AGENT_INSTRUCTIONS, listAgents, messageAgent } from './agent-tools'
import { handleDeviceStatus, handleOpenDeviceSettings } from './device-tools'
import { handleShowDiff } from './show-diff-tool'
import { handleShowDocument } from './show-document-tool'
import { handleGetTaskList, handleSetTaskList } from './task-list-tool'
import { handleShowImage } from './show-image-tool'

const server = new McpServer({ name: 'claudeterm', version: '0.1.0' }, { instructions: AGENT_INSTRUCTIONS })

server.registerTool(
  'show_image',
  {
    title: 'Show image in ClaudeTerm',
    description: 'Show an image, audio or video file to the user in the ClaudeTerm panel. Use after creating or finding a file the user should see or open.',
    inputSchema: {
      path: z.string().describe('Absolute path (preferred) or a path relative to the current working directory'),
      caption: z.string().optional().describe('Short caption shown under the file')
    }
  },
  async ({ path, caption }) => {
    const tabId = process.env.CLAUDETERM_TAB_ID
    const r = await handleShowImage(
      { path, caption },
      {
        cwd: process.cwd(),
        tabId: isUuid(tabId) ? tabId : null,
        pipeName: process.env.CLAUDETERM_PIPE || defaultPipeName(userInfo().username),
        send: (pipe, msg) => sendPipeMessage(pipe, msg, 3000)
      }
    )
    return { content: [{ type: 'text', text: r.text }], isError: r.isError }
  }
)

server.registerTool(
  'show_diff',
  {
    title: 'Show a diff in ClaudeTerm',
    description:
      'Open a diff in the Changes panel next to the terminal in ClaudeTerm, where the user reviews it and comments on lines. ' +
      'Use it when the user asks to see a diff or the changes. Without arguments it shows the uncommitted changes. ' +
      'To review a branch like a pull request, pass the output of `git merge-base <base branch> HEAD` as from.',
    inputSchema: {
      scope: z.enum(['uncommitted', 'last_turn', 'session']).optional()
        .describe('uncommitted (default): everything not committed; last_turn: what Claude changed in its latest turn with edits; session: what Claude changed in this conversation. Ignored when from is given'),
      from: z.string().optional().describe('A git revision to compare with: HEAD~3, a branch, a tag or a commit'),
      to: z.string().optional().describe('A git revision to compare up to; default: the working tree'),
      paths: z.array(z.string()).optional().describe('Files or folders to limit the diff to, absolute or relative to the current directory. A file or folder git ignores that is named here shows as new files'),
      title: z.string().optional().describe('A short title shown above the diff')
    }
  },
  async (input) => {
    const tabId = process.env.CLAUDETERM_TAB_ID
    const r = await handleShowDiff(input, {
      cwd: process.cwd(),
      tabId: isUuid(tabId) ? tabId : null,
      pipeName: process.env.CLAUDETERM_PIPE || defaultPipeName(userInfo().username),
      // the diff is read before ClaudeTerm answers: git in a big repository takes a while
      send: (pipe, msg) => sendPipeMessage(pipe, msg, 15_000)
    })
    return { content: [{ type: 'text', text: r.text }], isError: r.isError }
  }
)

server.registerTool(
  'show_document',
  {
    title: 'Show a document in ClaudeTerm',
    description:
      'Show a document to the user in the Docs panel next to the terminal in ClaudeTerm: Markdown (formatted; the user can comment on it and send the comments back to you), PDF or HTML (a report, a generated page). ' +
      'Use it after writing a spec, a plan, a report or another document the user should read, or when the user asks to see one.',
    inputSchema: {
      path: z.string().describe('Absolute path (preferred) or a path relative to the current working directory'),
      title: z.string().optional().describe('A short title shown in the panel instead of the file name')
    }
  },
  async ({ path, title }) => {
    const tabId = process.env.CLAUDETERM_TAB_ID
    const r = await handleShowDocument(
      { path, title },
      {
        cwd: process.cwd(),
        tabId: isUuid(tabId) ? tabId : null,
        pipeName: process.env.CLAUDETERM_PIPE || defaultPipeName(userInfo().username),
        send: (pipe, msg) => sendPipeMessage(pipe, msg, 3000)
      }
    )
    return { content: [{ type: 'text', text: r.text }], isError: r.isError }
  }
)

server.registerTool(
  'set_task_list',
  {
    title: 'Show a task list in ClaudeTerm',
    description:
      'Show a task list with progress in the status bar of ClaudeTerm, for multi-step work, or when the user asks for one. ' +
      'Send the whole list each time, every task with its status; an empty list removes it. ' +
      'A superpowers plan is tracked by ClaudeTerm itself: do not mirror a single plan here. An unfinished list shows in place ' +
      'of the plan, so set one while a plan runs only for work across several plans, or when the user asks for it.',
    inputSchema: {
      title: z.string().optional().describe('A short title shown above the list; default: Tasks'),
      tasks: z.array(z.object({ title: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) })).describe('The whole list, in order')
    }
  },
  async ({ title, tasks }) => {
    const tabId = process.env.CLAUDETERM_TAB_ID
    const r = await handleSetTaskList(
      { title, tasks },
      {
        tabId: isUuid(tabId) ? tabId : null,
        pipeName: process.env.CLAUDETERM_PIPE || defaultPipeName(userInfo().username),
        send: (pipe, msg) => sendPipeMessage(pipe, msg, 3000)
      }
    )
    return { content: [{ type: 'text', text: r.text }], isError: r.isError }
  }
)

server.registerTool(
  'get_task_list',
  {
    title: 'Read the task list in ClaudeTerm',
    description: 'Read the task list shown in ClaudeTerm for this conversation, with each task\'s status.',
    inputSchema: {}
  },
  async () => {
    const tabId = process.env.CLAUDETERM_TAB_ID
    const r = await handleGetTaskList({
      tabId: isUuid(tabId) ? tabId : null,
      pipeName: process.env.CLAUDETERM_PIPE || defaultPipeName(userInfo().username),
      send: (pipe, msg) => sendPipeMessage(pipe, msg, 3000)
    })
    return { content: [{ type: 'text', text: r.text }], isError: r.isError }
  }
)

server.registerTool(
  'device_status',
  {
    title: 'Device sync status in ClaudeTerm',
    description:
      "Read-only status of ClaudeTerm's device sync: the devices of the group, whether each is connected, a port problem, whether the other devices can reach this one, and the tabs open on each device. Never shows pairing codes or keys.",
    inputSchema: {}
  },
  async () => {
    const r = await handleDeviceStatus({
      pipeName: process.env.CLAUDETERM_PIPE || defaultPipeName(userInfo().username),
      send: (pipe, msg) => sendPipeMessage(pipe, msg, 3000)
    })
    return { content: [{ type: 'text', text: r.text }], isError: r.isError }
  }
)

server.registerTool(
  'open_device_settings',
  {
    title: 'Open device settings in ClaudeTerm',
    description: "Open ClaudeTerm's Settings window at the Devices section, where the user pairs, joins and removes devices themselves.",
    inputSchema: {}
  },
  async () => {
    const r = await handleOpenDeviceSettings({
      pipeName: process.env.CLAUDETERM_PIPE || defaultPipeName(userInfo().username),
      send: (pipe, msg) => sendPipeMessage(pipe, msg, 3000)
    })
    return { content: [{ type: 'text', text: r.text }], isError: r.isError }
  }
)

server.registerTool(
  'list_agents',
  {
    title: 'List agents in ClaudeTerm',
    description:
      'List the agents that message_agent can reach: the Claude tabs in ClaudeTerm on this device and on connected paired devices, except this one. ' +
      'Use it only for an agent that Claude Code\'s ListAgents does not show, such as one on another device or another Claude account.',
    inputSchema: {}
  },
  async () => {
    const tabId = process.env.CLAUDETERM_TAB_ID
    const r = await listAgents({
      tabId: isUuid(tabId) ? tabId : null,
      pipeName: process.env.CLAUDETERM_PIPE || defaultPipeName(userInfo().username),
      send: (pipe, msg) => sendPipeMessage(pipe, msg, 3000)
    })
    return { content: [{ type: 'text', text: r.text }], isError: r.isError }
  }
)

server.registerTool(
  'message_agent',
  {
    title: 'Message an agent in ClaudeTerm',
    description:
      'Send a message to an agent listed by list_agents, or answer a message from another agent by passing its id as reply_to. ' +
      'Use it only for an agent that Claude Code\'s ListAgents does not show; use SendMessage for the others. ' +
      'The reply says whether the message was delivered or is waiting for the agent\'s device to connect.',
    inputSchema: {
      to: z.string().describe('a name or a ref from list_agents, or the sender of a message being answered'),
      text: z.string().describe('The message text, at most 8000 characters'),
      reply_to: z.string().optional().describe('The id of the message being answered, from the id line of a message from another agent')
    }
  },
  async ({ to, text, reply_to }) => {
    const tabId = process.env.CLAUDETERM_TAB_ID
    const r = await messageAgent(
      { to, text, reply_to },
      {
        tabId: isUuid(tabId) ? tabId : null,
        pipeName: process.env.CLAUDETERM_PIPE || defaultPipeName(userInfo().username),
        send: (pipe, msg) => sendPipeMessage(pipe, msg, 3000)
      }
    )
    return { content: [{ type: 'text', text: r.text }], isError: r.isError }
  }
)

void server.connect(new StdioServerTransport())
