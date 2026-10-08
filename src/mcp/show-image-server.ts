import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { userInfo } from 'node:os'
import { z } from 'zod'
import { sendPipeMessage } from '../shared/pipe-client'
import { defaultPipeName, isUuid } from '../shared/protocol'
import { handleShowDiff } from './show-diff-tool'
import { handleShowImage } from './show-image-tool'

const server = new McpServer({ name: 'claudeterm', version: '0.1.0' })

server.registerTool(
  'show_image',
  {
    title: 'Show image in ClaudeTerm',
    description: 'Show an image file to the user in the ClaudeTerm image panel. Use after creating or finding an image the user should see.',
    inputSchema: {
      path: z.string().describe('Absolute path (preferred) or a path relative to the current working directory'),
      caption: z.string().optional().describe('Short caption shown under the image')
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
      paths: z.array(z.string()).optional().describe('Files or folders to limit the diff to, absolute or relative to the current directory'),
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

void server.connect(new StdioServerTransport())
