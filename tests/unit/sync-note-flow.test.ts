import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NoteHub } from '../../src/main/note-hub'
import { SessionNotes } from '../../src/main/session-notes'
import { StarredSessions } from '../../src/main/starred-sessions'
import { type BridgeGroup, StoreBridge } from '../../src/main/sync/store-bridge'
import { type Dot, emptyReplica, Replica, type VersionVector } from '../../src/main/sync/replica'
import { noteOf } from '../../src/main/sync/views'
import type { Note } from '../../src/shared/note'

const S = '11111111-1111-4111-8111-111111111111'
const ME = '22222222-2222-4222-8222-222222222222'
const THEM = '33333333-3333-4333-8333-333333333333'
const TAB = 't1'

const note = (text: string): Note => ({ text, shown: true, form: 'card' })

/** a note's paragraphs, sorted: the order follows the stamps, so the test compares them as a set */
const paragraphs = (text: string | null): string[] => (text ?? '').split('\n\n').sort()

const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/**
 * This device wired the way the app wires it: a Claude tab's note hub, the note store, the store bridge and a replica behind
 * the group's calls. Clocks are fixed, so the order of the writes decides which text comes first.
 */
function device() {
  const dir = mkdtempSync(join(tmpdir(), 'ct-note-flow-'))
  dirs.push(dir)
  const notes = new SessionNotes(dir, { debounceMs: 10_000 })
  const starred = new StarredSessions(dir)
  const replica = new Replica(emptyReplica(ME), () => 1000)
  const group: BridgeGroup = {
    write: (col, key, value, base?: VersionVector): Dot | null => {
      const update = replica.write(col, key, value, base)
      // the sibling this write added is this device's, and the latest of its own
      return update.state.siblings.map((s) => s.dot).filter((d) => d[0] === ME).reduce((a, d) => (d[1] > a[1] ? d : a))
    },
    context: (col, key) => replica.context(col, key),
    state: (col, key) => replica.get(col, key),
    keys: (col) => replica.keys(col)
  }
  // the number of the note the renderer has: its edits carry the number they were typed against
  let generation = 0
  // the text in the renderer's textarea: the last note main sent it, then the keystrokes typed since
  let rendered = ''
  // every note main hands the renderer, as `number:text`
  const sent: string[] = []
  const hub = new NoteHub({
    store: notes,
    publish: (_tabId, n, g) => {
      generation = g
      rendered = n?.text ?? ''
      sent.push(`${g}:${rendered}`)
    },
    publishOp: () => {}
  })
  notes.onExternal((id, n, before) => hub.external(id, n, before))
  const bridge = new StoreBridge(starred, notes, group, { debounceMs: 10_000 })
  bridge.start()
  hub.addTab(TAB, S)

  const them = new Replica(emptyReplica(THEM), () => 1000)
  /** the other device changes the note, on what it has seen of it, and this device receives the change */
  const remote = (text: string) => {
    const seen = replica.get('notes', S)
    if (seen) them.apply([{ col: 'notes', key: S, state: seen }])
    bridge.applied(replica.apply([them.write('notes', S, note(text))]))
  }

  return {
    bridge,
    hub,
    notes,
    remote,
    /** the number of the note the renderer has now */
    current: () => generation,
    /** a keystroke in the tab, typed against the note with the given number */
    typed: (text: string, against: number) => {
      rendered = text
      hub.setText(TAB, text, against)
    },
    /** what the renderer's textarea holds now */
    rendered: () => rendered,
    /** the notes main has handed the renderer so far */
    sent,
    groupNote: () => noteOf(replica.get('notes', S))?.text ?? null,
    storeNote: () => notes.get(S)?.text ?? null,
    tabNote: () => hub.get(TAB)?.text ?? null
  }
}

describe('a note typed while a remote note arrives', () => {
  it('a late keystroke, then a keystroke on the new note inside one pause: both texts are kept, the remote one once', () => {
    const d = device()
    d.typed('N', d.current())
    d.bridge.flush()
    const againstN = d.current()
    d.remote('R')
    d.typed('Nb', againstN)
    d.typed('Rx', d.current())
    d.bridge.flush()
    expect(d.groupNote()).toBe('Rx\n\nNb')
    expect(d.storeNote()).toBe('Rx\n\nNb')
    expect(d.tabNote()).toBe('Rx\n\nNb')
  })

  it('a keystroke typed before a remote note arrived, after a write that waits for its pause: the superseded text is gone', () => {
    const d = device()
    d.typed('N', d.current())
    d.bridge.flush()
    const againstN = d.current()
    d.typed('Na', againstN)
    d.remote('R')
    d.typed('Nab', againstN)
    d.bridge.flush()
    expect(d.groupNote()).toBe('Nab\n\nR')
    expect(d.storeNote()).toBe('Nab\n\nR')
    expect(d.tabNote()).toBe('Nab\n\nR')
  })

  it('a late keystroke only, with no further typing in the pause: the late text joins the remote one', () => {
    const d = device()
    d.typed('N', d.current())
    d.bridge.flush()
    const againstN = d.current()
    d.remote('R')
    d.typed('Nb', againstN)
    d.bridge.flush()
    expect(d.groupNote()).toBe('Nb\n\nR')
    expect(d.storeNote()).toBe('Nb\n\nR')
  })

  it('the flush a keystroke causes does not hand the view back: the renderer is sent nothing until the next flush', () => {
    const d = device()
    d.typed('N', d.current())
    d.bridge.flush()
    const againstN = d.current()
    d.remote('R')
    d.typed('Nb', againstN)
    const sentBefore = d.sent.length
    d.typed('Rx', d.current())
    expect(d.sent.length).toBe(sentBefore)
    expect(d.storeNote()).toBe('Rx')
    d.bridge.flush()
    expect(paragraphs(d.groupNote())).toEqual(['Nb', 'Rx'])
    expect(paragraphs(d.storeNote())).toEqual(['Nb', 'Rx'])
    expect(paragraphs(d.tabNote())).toEqual(['Nb', 'Rx'])
  })

  it('a keystroke typed into the textarea after such a flush: the late text appears once and every keystroke is kept', () => {
    const d = device()
    d.typed('N', d.current())
    d.bridge.flush()
    const againstN = d.current()
    d.remote('R')
    d.typed('Nb', againstN)
    d.typed('Rx', d.current())
    d.typed(`${d.rendered()}y`, d.current())
    d.bridge.flush()
    expect(paragraphs(d.groupNote())).toEqual(['Nb', 'Rxy'])
    expect(paragraphs(d.storeNote())).toEqual(['Nb', 'Rxy'])
    expect(paragraphs(d.tabNote())).toEqual(['Nb', 'Rxy'])
  })

  it('a keystroke against the note before a remote one, after a waiting write: the superseded text is gone, and a further one is kept', () => {
    const d = device()
    d.typed('N', d.current())
    d.bridge.flush()
    const againstN = d.current()
    d.typed('Na', againstN)
    d.remote('R')
    d.typed('Nab', againstN)
    d.typed('Nabc', againstN)
    d.bridge.flush()
    expect(paragraphs(d.groupNote())).toEqual(['Nabc', 'R'])
    expect(paragraphs(d.storeNote())).toEqual(['Nabc', 'R'])
    expect(paragraphs(d.tabNote())).toEqual(['Nabc', 'R'])
  })

  it('a keystroke typed on the number the previous keystroke was typed on, after a waiting write: the superseded text is gone', () => {
    const d = device()
    d.typed('N', d.current())
    d.bridge.flush()
    const againstN = d.current()
    d.remote('R')
    d.typed('Nb', againstN)
    const onR = d.current()
    d.typed('Rx', onR)
    d.typed('Rxy', onR)
    d.bridge.flush()
    expect(paragraphs(d.groupNote())).toEqual(['Nb', 'Rxy'])
    expect(paragraphs(d.storeNote())).toEqual(['Nb', 'Rxy'])
    expect(paragraphs(d.tabNote())).toEqual(['Nb', 'Rxy'])
  })
})
