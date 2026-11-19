import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  type BrowserCommand,
  type BrowserOp,
  MAX_ELEMENT,
  MAX_FUNCTION,
  MAX_KEY,
  MAX_SCROLL,
  MAX_TEXT,
  MAX_URL,
  MAX_VALUE,
  MAX_VALUES,
  MAX_WAIT_SECONDS,
  parseBrowserCommand,
  REF_RE,
  REQUEST_ID_RE
} from '../shared/browser'
import { PipeUnavailableError } from '../shared/pipe-client'
import type { BrowserMessage, PipeResponse } from '../shared/protocol'

export interface BrowserToolDeps {
  tabId: string | null
  pipeName: string
  send(pipeName: string, msg: BrowserMessage): Promise<PipeResponse>
}

export type BrowserToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export interface BrowserToolResult {
  content: BrowserToolContent[]
  isError: boolean
}

/** a browser page action can wait for the person's answer to a permission card, so the pipe waits as long as it takes */
export const BROWSER_PIPE_TIMEOUT_MS = 720_000

export const BROWSER_INSTRUCTIONS =
  'ClaudeTerm\'s built-in browser (browser_* tools) shows its pages to the person in the Browser panel of this tab. ' +
  'On local pages (localhost, 127.0.0.1, files) you work freely; any other site needs the person\'s permission, which ClaudeTerm asks for when you first open or use it, and the call waits for the answer. ' +
  'Take browser_snapshot before clicking or typing, and use the refs it gives.'

function fail(text: string): BrowserToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** one command on the browser of this tab: the pipe message, and what ClaudeTerm answers as the tool's result */
export async function runBrowserCommand(command: BrowserCommand, deps: BrowserToolDeps): Promise<BrowserToolResult> {
  if (!deps.tabId) return fail('The browser works only in a ClaudeTerm Claude tab.')
  const msg: BrowserMessage = { v: 1, type: 'browser', tabId: deps.tabId, command }
  let res: PipeResponse
  try {
    res = await deps.send(deps.pipeName, msg)
  } catch (e) {
    if (e instanceof PipeUnavailableError) return fail('ClaudeTerm is not running; the browser is not available.')
    return fail(`ClaudeTerm request failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) return fail(res.error)
  const content: BrowserToolContent[] = []
  if (res.image) content.push({ type: 'image', data: res.image.data, mimeType: res.image.mimeType })
  content.push({ type: 'text', text: res.info ?? 'Done.' })
  return { content, isError: false }
}

const ref = z.string().regex(REF_RE).describe('The element ref from browser_snapshot, such as e12')
const element = z.string().min(1).max(MAX_ELEMENT).describe('A short human-readable name of the element, such as "Sign in button"')
const optRef = ref.optional().describe('The element ref from browser_snapshot, such as e12; absent: the whole page')

interface BrowserToolSpec {
  name: string
  op: BrowserOp
  title: string
  description: string
  shape: z.ZodRawShape
}

const BROWSER_TOOLS: BrowserToolSpec[] = [
  {
    name: 'browser_navigate', op: 'navigate', title: 'Open a page in the ClaudeTerm browser',
    description: 'Open a web address in the browser of this tab; a site other than local pages needs the person\'s permission, which ClaudeTerm asks for when you first open it, and the call waits for the answer.',
    shape: { url: z.string().min(1).max(MAX_URL).describe('The web address, such as http://localhost:3000 or https://example.com') }
  },
  { name: 'browser_navigate_back', op: 'back', title: 'Go back in the ClaudeTerm browser', description: 'Go back to the previous page in the browser of this tab.', shape: {} },
  { name: 'browser_navigate_forward', op: 'forward', title: 'Go forward in the ClaudeTerm browser', description: 'Go forward to the next page in the browser of this tab.', shape: {} },
  { name: 'browser_reload', op: 'reload', title: 'Reload the ClaudeTerm browser page', description: 'Reload the current page in the browser of this tab.', shape: {} },
  {
    name: 'browser_snapshot', op: 'snapshot', title: 'Snapshot the ClaudeTerm browser page',
    description: 'Read the current page as a tree of its elements, each with a ref such as e12 for the other browser tools; take it before clicking or typing.',
    shape: {}
  },
  {
    name: 'browser_click', op: 'click', title: 'Click in the ClaudeTerm browser',
    description: 'Click an element of the current page, named by its ref from browser_snapshot.',
    shape: {
      ref,
      element,
      button: z.enum(['left', 'right', 'middle']).optional().describe('The mouse button; default: left'),
      doubleClick: z.boolean().optional().describe('true for a double click; default: false')
    }
  },
  {
    name: 'browser_type', op: 'type', title: 'Type in the ClaudeTerm browser',
    description: 'Type text into an input of the current page, named by its ref from browser_snapshot.',
    shape: {
      ref,
      element,
      text: z.string().max(MAX_TEXT).describe('The text to type'),
      submit: z.boolean().optional().describe('true to press Enter after the text; default: false'),
      slowly: z.boolean().optional().describe('true to type one key at a time, for pages that react to each key; default: false')
    }
  },
  {
    name: 'browser_press_key', op: 'press_key', title: 'Press a key in the ClaudeTerm browser',
    description: 'Press a key or a key combination such as Enter or Control+A on the current page.',
    shape: { key: z.string().min(1).max(MAX_KEY).describe('The key, such as Enter, ArrowDown or Control+A') }
  },
  {
    name: 'browser_hover', op: 'hover', title: 'Hover in the ClaudeTerm browser',
    description: 'Move the mouse over an element of the current page, named by its ref from browser_snapshot.',
    shape: { ref, element }
  },
  {
    name: 'browser_select_option', op: 'select_option', title: 'Select an option in the ClaudeTerm browser',
    description: 'Select one or more options of a dropdown of the current page, named by its ref from browser_snapshot.',
    shape: {
      ref,
      element,
      values: z.array(z.string().max(MAX_VALUE)).min(1).max(MAX_VALUES).describe('The values or labels of the options to select')
    }
  },
  {
    name: 'browser_scroll', op: 'scroll', title: 'Scroll the ClaudeTerm browser page',
    description: 'Scroll the current page, or an element of it named by its ref, in a direction by a number of pixels.',
    shape: {
      ref: optRef,
      direction: z.enum(['up', 'down', 'left', 'right']).describe('The direction to scroll'),
      amount: z.number().int().min(1).max(MAX_SCROLL).optional().describe('The number of pixels; default: 600')
    }
  },
  {
    name: 'browser_wait_for', op: 'wait_for', title: 'Wait in the ClaudeTerm browser',
    description: 'Wait until a text appears or disappears on the current page, or for a number of seconds.',
    shape: {
      text: z.string().min(1).max(MAX_TEXT).optional().describe('A text to wait for until it appears'),
      textGone: z.string().min(1).max(MAX_TEXT).optional().describe('A text to wait for until it disappears'),
      time: z.number().gt(0).max(MAX_WAIT_SECONDS).optional().describe(`Seconds to wait, at most ${MAX_WAIT_SECONDS}`)
    }
  },
  {
    name: 'browser_take_screenshot', op: 'screenshot', title: 'Screenshot the ClaudeTerm browser page',
    description: 'Take a screenshot of the current page, or of an element named by its ref, and show it to you as an image.',
    shape: {
      fullPage: z.boolean().optional().describe('true for the whole page, not only the visible part; default: false'),
      ref: optRef
    }
  },
  {
    name: 'browser_evaluate', op: 'evaluate', title: 'Run JavaScript in the ClaudeTerm browser',
    description: 'Run a JavaScript function in the current page and return its result, or run it on an element named by its ref.',
    shape: {
      function: z.string().min(1).max(MAX_FUNCTION).describe('A JavaScript function, such as "() => document.title", that takes the element when a ref is given'),
      ref: optRef
    }
  },
  {
    name: 'browser_console_messages', op: 'console', title: 'Read the console of the ClaudeTerm browser page',
    description: 'Read the console messages of the current page, or only its errors.',
    shape: { onlyErrors: z.boolean().optional().describe('true for the errors only; default: false') }
  },
  {
    name: 'browser_network_requests', op: 'network', title: 'List the network requests of the ClaudeTerm browser page',
    description: 'List the network requests the current page made, each with an id such as r3.',
    shape: {}
  },
  {
    name: 'browser_network_request', op: 'network_request', title: 'Read a network request of the ClaudeTerm browser page',
    description: 'Read the details of one network request of the current page by its id from browser_network_requests.',
    shape: { id: z.string().regex(REQUEST_ID_RE).describe('The request id from browser_network_requests, such as r3') }
  },
  {
    name: 'browser_handle_dialog', op: 'handle_dialog', title: 'Set the answer for the next dialog in the ClaudeTerm browser',
    description: 'Pages here never show alert, confirm or prompt windows: an alert is closed, a confirm answers Cancel and a prompt answers nothing, and the page footer reports each one. Call this BEFORE the action that opens a dialog to answer the next one differently: accept true answers OK (a prompt gets promptText).',
    shape: {
      accept: z.boolean().describe('true to answer OK, false to answer Cancel'),
      promptText: z.string().max(MAX_TEXT).optional().describe('the text a prompt answers when accept is true')
    }
  },
  {
    name: 'browser_tabs', op: 'tabs', title: 'Manage the pages of the ClaudeTerm browser',
    description: 'List, open, select or close the pages of the browser of this tab, by their index.',
    shape: {
      action: z.enum(['list', 'new', 'select', 'close']).describe('list the pages, open a new one, select one, or close one'),
      index: z.number().int().min(0).optional().describe('The index of the page to select or close, from the list'),
      url: z.string().min(1).max(MAX_URL).optional().describe('The web address of a new page; absent: a blank page')
    }
  }
]

export function registerBrowserTools(server: McpServer, deps: () => BrowserToolDeps): void {
  for (const spec of BROWSER_TOOLS) {
    server.registerTool(spec.name, { title: spec.title, description: spec.description, inputSchema: spec.shape }, async (args) => {
      const parsed = parseBrowserCommand({ op: spec.op, ...args })
      const r = parsed.ok ? await runBrowserCommand(parsed.command, deps()) : fail(parsed.error)
      return { content: r.content, isError: r.isError }
    })
  }
}

