import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { userInfo } from 'node:os'
import { z } from 'zod'
import { NOTE_ADD_MAX, NOTE_ITEM_MAX, type NoteSide } from '../shared/note'
import { PipeUnavailableError, sendPipeMessage } from '../shared/pipe-client'
import { defaultPipeName, isUuid, type NoteAddMessage, type NoteCheckMessage, type NoteReadMessage, type PipeResponse } from '../shared/protocol'
import type { ToolResult } from './show-image-tool'

export interface NoteToolDeps {
  tabId: string | null
  pipeName: string
  send(pipeName: string, msg: NoteReadMessage | NoteAddMessage | NoteCheckMessage): Promise<PipeResponse>
}

export const NOTE_INSTRUCTIONS =
  'ClaudeTerm keeps two notes for this tab, written by the person: the session note, kept with this conversation, and the project note, shared by every Claude tab of the same git project. ' +
  'They are the person\'s. Read them with read_notes when your work needs their context, add what the person should not lose with add_to_note, and tick the items you finished with check_note_item. ' +
  'You cannot remove or rewrite their text, and should not try.'

export async function handleReadNotes(deps: NoteToolDeps): Promise<ToolResult> {
  if (!deps.tabId) return { text: 'read_notes works only in a ClaudeTerm Claude tab', isError: true }
  const msg: NoteReadMessage = { v: 1, type: 'note_read', tabId: deps.tabId }
  return send(deps, msg, 'ClaudeTerm is not running; the notes cannot be read.')
}

export async function handleAddToNote(input: { note: NoteSide; text: string }, deps: NoteToolDeps): Promise<ToolResult> {
  if (!deps.tabId) return { text: 'add_to_note works only in a ClaudeTerm Claude tab', isError: true }
  if (input.text.trim() === '') return { text: 'The text is empty. Nothing was added.', isError: true }
  if (input.text.length > NOTE_ADD_MAX) return { text: `The text is longer than ${NOTE_ADD_MAX} characters; add it in parts.`, isError: true }
  const msg: NoteAddMessage = { v: 1, type: 'note_add', tabId: deps.tabId, note: input.note, text: input.text }
  return send(deps, msg, 'ClaudeTerm is not running; nothing was added.')
}

export async function handleCheckNoteItem(input: { note: NoteSide; item: string; checked: boolean }, deps: NoteToolDeps): Promise<ToolResult> {
  if (!deps.tabId) return { text: 'check_note_item works only in a ClaudeTerm Claude tab', isError: true }
  if (input.item.trim() === '') return { text: 'The item is empty.', isError: true }
  if (input.item.length > NOTE_ITEM_MAX) return { text: `The item is longer than ${NOTE_ITEM_MAX} characters.`, isError: true }
  const msg: NoteCheckMessage = { v: 1, type: 'note_check', tabId: deps.tabId, note: input.note, item: input.item, checked: input.checked }
  return send(deps, msg, 'ClaudeTerm is not running; nothing was changed.')
}

export function registerNoteTools(server: McpServer): void {
  const deps = (): NoteToolDeps => {
    const tabId = process.env.CLAUDETERM_TAB_ID
    return {
      tabId: isUuid(tabId) ? tabId : null,
      pipeName: process.env.CLAUDETERM_PIPE || defaultPipeName(userInfo().username),
      send: (pipe, msg) => sendPipeMessage(pipe, msg, 3000)
    }
  }
  const noteSchema = z.enum(['session', 'project']).describe('session: the note of this conversation; project: the note shared by every Claude tab of this git project')

  server.registerTool(
    'read_notes',
    {
      title: 'Read the notes in ClaudeTerm',
      description:
        'Read the person\'s two notes for this tab in ClaudeTerm, as Markdown: the session note, kept with this conversation, and the project note, shared by every Claude tab of the same git project (its worktrees included). ' +
        'Checkbox items read "- [ ] text" (open) and "- [x] text" (ticked).',
      inputSchema: {}
    },
    async () => toContent(await handleReadNotes(deps()))
  )

  server.registerTool(
    'add_to_note',
    {
      title: 'Add to a note in ClaudeTerm',
      description:
        'Add text at the end of the session note or the project note in ClaudeTerm, after a blank line. ' +
        'Use it for what the person should not lose: a TODO you found, a decision, how to reach something. ' +
        'The text may hold checkbox items ("- [ ] text") and bullets ("- text"). Nothing already in the note changes.',
      inputSchema: {
        note: noteSchema,
        text: z.string().describe(`The Markdown text to add, at most ${NOTE_ADD_MAX} characters`)
      }
    },
    async ({ note, text }) => toContent(await handleAddToNote({ note, text }, deps()))
  )

  server.registerTool(
    'check_note_item',
    {
      title: 'Tick a note item in ClaudeTerm',
      description:
        'Tick (checked: true) or untick (checked: false) a checkbox item of the session note or the project note in ClaudeTerm, named by its text as read_notes shows it after "- [ ] " or "- [x] ". ' +
        'Use it when you finished an item.',
      inputSchema: {
        note: noteSchema,
        item: z.string().describe("The item's text, exactly as in the note"),
        checked: z.boolean().describe('true ticks the item, false unticks it')
      }
    },
    async ({ note, item, checked }) => toContent(await handleCheckNoteItem({ note, item, checked }, deps()))
  )
}

async function send(deps: NoteToolDeps, msg: NoteReadMessage | NoteAddMessage | NoteCheckMessage, notRunning: string): Promise<ToolResult> {
  let res: PipeResponse
  try {
    res = await deps.send(deps.pipeName, msg)
  } catch (e) {
    if (e instanceof PipeUnavailableError) return { text: notRunning, isError: true }
    return { text: `ClaudeTerm request failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }
  return res.ok ? { text: res.info ?? 'Done.', isError: false } : { text: res.error, isError: true }
}

function toContent(r: ToolResult) {
  return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError }
}
