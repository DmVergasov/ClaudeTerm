import { describe, expect, it } from 'vitest'
import { handleAddToNote, handleCheckNoteItem, handleReadNotes, type NoteToolDeps } from '../../src/mcp/note-tools'
import { PipeUnavailableError } from '../../src/shared/pipe-client'
import type { NoteAddMessage, NoteCheckMessage, NoteReadMessage, PipeResponse } from '../../src/shared/protocol'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
type Sent = NoteReadMessage | NoteAddMessage | NoteCheckMessage
const deps = (send: NoteToolDeps['send'], tabId: string | null = TAB): NoteToolDeps => ({ tabId, pipeName: 'pipe', send })
const refuse = async (): Promise<PipeResponse> => {
  throw new Error('must not be called')
}

describe('note tools need a ClaudeTerm Claude tab', () => {
  it('each tool needs a ClaudeTerm Claude tab and sends nothing', async () => {
    expect(await handleReadNotes(deps(refuse, null))).toEqual({ text: 'read_notes works only in a ClaudeTerm Claude tab', isError: true })
    expect(await handleAddToNote({ note: 'project', text: 'Tag' }, deps(refuse, null))).toEqual({ text: 'add_to_note works only in a ClaudeTerm Claude tab', isError: true })
    expect(await handleCheckNoteItem({ note: 'session', item: 'Tag', checked: true }, deps(refuse, null))).toEqual({ text: 'check_note_item works only in a ClaudeTerm Claude tab', isError: true })
  })
})

describe('add_to_note refuses a bad text without sending', () => {
  it('add_to_note refuses an empty text or one over 10000 characters without sending', async () => {
    expect(await handleAddToNote({ note: 'session', text: '  \n ' }, deps(refuse))).toEqual({ text: 'The text is empty. Nothing was added.', isError: true })
    expect(await handleAddToNote({ note: 'session', text: 'x'.repeat(10_001) }, deps(refuse))).toEqual({ text: 'The text is longer than 10000 characters; add it in parts.', isError: true })
  })

  it('accepts a text of exactly 10000 characters', async () => {
    const sent: Sent[] = []
    const text = 'x'.repeat(10_000)
    await handleAddToNote({ note: 'session', text }, deps(async (_p, m) => {
      sent.push(m)
      return { ok: true }
    }))
    expect(sent).toEqual([{ v: 1, type: 'note_add', tabId: TAB, note: 'session', text }])
  })
})

describe('check_note_item refuses a bad item without sending', () => {
  it('check_note_item refuses an empty item or one over 2000 characters without sending', async () => {
    expect(await handleCheckNoteItem({ note: 'project', item: ' ', checked: true }, deps(refuse))).toEqual({ text: 'The item is empty.', isError: true })
    expect(await handleCheckNoteItem({ note: 'project', item: 'y'.repeat(2_001), checked: true }, deps(refuse))).toEqual({ text: 'The item is longer than 2000 characters.', isError: true })
  })
})

describe('note tools send their message and answer what ClaudeTerm says', () => {
  it('each tool sends its message and answers what ClaudeTerm says', async () => {
    const sent: Sent[] = []
    const answer = async (_p: string, m: Sent): Promise<PipeResponse> => {
      sent.push(m)
      return { ok: true, info: 'ok text' }
    }
    expect(await handleReadNotes(deps(answer))).toEqual({ text: 'ok text', isError: false })
    expect(await handleAddToNote({ note: 'project', text: '  - [ ] Tag\r\n' }, deps(answer))).toEqual({ text: 'ok text', isError: false })
    expect(await handleCheckNoteItem({ note: 'session', item: 'Tag', checked: false }, deps(answer))).toEqual({ text: 'ok text', isError: false })
    expect(sent).toEqual([
      { v: 1, type: 'note_read', tabId: TAB },
      { v: 1, type: 'note_add', tabId: TAB, note: 'project', text: '  - [ ] Tag\r\n' },
      { v: 1, type: 'note_check', tabId: TAB, note: 'session', item: 'Tag', checked: false }
    ])
  })
})

describe('an error from ClaudeTerm is an error result', () => {
  it('an error from ClaudeTerm is an error result', async () => {
    const r = await handleCheckNoteItem({ note: 'project', item: 'Tag', checked: true }, deps(async () => ({ ok: false, error: 'No item "Tag" in the project note.' })))
    expect(r).toEqual({ text: 'No item "Tag" in the project note.', isError: true })
  })

  it('reports another failure of the request as an error', async () => {
    const r = await handleReadNotes(deps(async () => { throw new Error('boom') }))
    expect(r).toEqual({ text: 'ClaudeTerm request failed: boom', isError: true })
  })
})

describe('ClaudeTerm not running is said, as an error', () => {
  const down = async (): Promise<PipeResponse> => {
    throw new PipeUnavailableError('x')
  }

  it('ClaudeTerm not running is said, as an error', async () => {
    expect(await handleReadNotes(deps(down))).toEqual({ text: 'ClaudeTerm is not running; the notes cannot be read.', isError: true })
    expect(await handleAddToNote({ note: 'session', text: 'Tag' }, deps(down))).toEqual({ text: 'ClaudeTerm is not running; nothing was added.', isError: true })
    expect(await handleCheckNoteItem({ note: 'session', item: 'Tag', checked: true }, deps(down))).toEqual({ text: 'ClaudeTerm is not running; nothing was changed.', isError: true })
  })
})
