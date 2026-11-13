import { hasText, MAX_NOTE_LENGTH, type Note, type NoteForm, type NoteSide, type NoteSize } from '../shared/note'
import { type NoteOp, type OpResult, replayNoteOps, tryNoteOp } from '../shared/note-items'
import type { SessionNotes } from './session-notes'

export interface NoteHubDeps {
  store: Pick<SessionNotes, 'get' | 'set'>
  /**
   * Tells the renderer a tab's note that came from main (a stored one), never an echo of its own edits, with its
   * number: the renderer's edits carry the number of the note they were typed against.
   */
  publish(tabId: string, note: Note | null, generation: number): void
  /** one of Claude's edits of the tab's note, with the number it makes; never for the renderer's own edits */
  publishOp(tabId: string, op: NoteOp, generation: number): void
}

const EMPTY: Note = { text: '', shown: false, form: 'card' }

/** an edit Claude made, with the number it made the note */
export interface KeptOp {
  generation: number
  op: NoteOp
}

/** how many of Claude's edits a note keeps: a text typed against an older number is dropped */
export const OPS_KEPT = 64

/** the edits made after `generation` when they are exactly the numbers generation+1 … current; else null */
export function opsSince(kept: readonly KeptOp[], current: number, generation: number): NoteOp[] | null {
  const since = kept.filter((k) => k.generation > generation)
  // kept edits are consecutive and end at the current number, so as many as there are numbers in between means none is missing
  if (since.length !== current - generation) return null
  return since.map((k) => k.op)
}

/** The tab's text after the stored note's, an empty line between; the stored note's state, cut at the length limit. */
function merge(stored: Note, own: Note): Note {
  return { ...stored, text: `${stored.text}\n\n${own.text}`.slice(0, MAX_NOTE_LENGTH) }
}

/** the stored note the tab takes with its first id, with the tab's own text joined to it, if it has any */
const joined = (stored: Note, own: Note | null): Note => (own && hasText(own) ? merge(stored, own) : stored)

/** where the note the tab had before main gave it the current one lives */
type Before =
  /** stored under the conversation the tab left */
  | { left: string }
  /** held in the tab, without a conversation: it joined this stored note */
  | { joined: Note }

/** a note another device replaced: the number the tab showed it under, and the store version it was based on */
interface Replaced {
  generation: number
  sessionId: string
  base: unknown
}

/** how many replaced notes a tab keeps: an edit typed against an older one is dropped */
const REPLACED_KEPT = 16

interface TabNote {
  sessionId: string | null
  /** a tab another device shows: it takes only what is stored for its conversation and never writes the store */
  remote: boolean
  note: Note | null
  /** the number of the note main gave the tab last; 0 until it gives one */
  generation: number
  /** the number main gave the note last: the edits Claude made came after it */
  givenAt: number
  /** Claude's edits of the note since it was given, oldest first */
  ops: KeptOp[]
  /** the note of the number before; null when the tab had none (its first note came with it) */
  before: Before | null
  /** the notes another device replaced since the tab's conversation last changed, oldest first */
  replaced: Replaced[]
}

/** Each Claude tab's note: kept with the tab's conversation, and moved or swapped when the conversation changes. */
export class NoteHub {
  private readonly tabs = new Map<string, TabNote>()

  constructor(private readonly deps: NoteHubDeps) {}

  addTab(tabId: string, sessionId: string | null, opts: { remote?: boolean } = {}): void {
    const stored = sessionId ? this.deps.store.get(sessionId) : null
    const tab: TabNote = {
      sessionId,
      remote: opts.remote === true,
      note: null,
      generation: 0,
      givenAt: 0,
      ops: [],
      before: null,
      replaced: []
    }
    this.tabs.set(tabId, tab)
    if (stored) this.give(tabId, tab, stored)
  }

  /**
   * A tab with no conversation yet takes the note stored under `fromSessionId` as its own: a fork restored without a
   * conversation of its own is forked again from its head, and keeps the note it had. The note stays stored under
   * `fromSessionId`, edits included, until the tab's own conversation starts and takes it, so a fork that never starts
   * loses nothing.
   */
  adopt(tabId: string, fromSessionId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.sessionId !== null) return
    const stored = this.deps.store.get(fromSessionId)
    if (!stored) return
    const note = joined(stored, tab.note)
    if (note !== stored) this.deps.store.set(fromSessionId, note)
    tab.sessionId = fromSessionId
    this.give(tabId, tab, note)
  }

  /**
   * The tab starts again in another folder: the window's note is emptied for the new conversation, which takes the next
   * note. The note of the old conversation stays stored under it, and text typed against it still goes there. The number
   * keeps going (never back to 0).
   */
  resetTab(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    const old = tab.sessionId
    tab.sessionId = null
    tab.replaced = []
    tab.before = old ? { left: old } : null
    this.give(tabId, tab, null)
  }

  /** Forgets the tab; the note stays stored under the tab's last conversation. */
  removeTab(tabId: string): void {
    this.tabs.delete(tabId)
  }

  /** The tab's conversation changed (/clear, /resume, a first id). */
  session(tabId: string, sessionId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.sessionId === sessionId) return
    const old = tab.sessionId
    tab.sessionId = sessionId
    tab.replaced = []
    const stored = this.deps.store.get(sessionId)
    if (tab.remote) {
      // a remote tab takes only what is stored under its new conversation (or nothing) and never writes the store
      tab.before = old ? { left: old } : stored ? { joined: stored } : null
      this.give(tabId, tab, stored)
      return
    }
    if (stored) {
      // A note written before the first id arrived has nothing stored to stay in: it joins the stored one.
      const note = old ? stored : joined(stored, tab.note)
      if (note !== stored) this.deps.store.set(sessionId, note)
      tab.before = old ? { left: old } : { joined: stored }
      this.give(tabId, tab, note)
      return
    }
    // the tab keeps its note, and the note its number
    if (!tab.note) return
    this.deps.store.set(sessionId, tab.note)
    if (old) this.deps.store.set(old, null)
  }

  get(tabId: string): Note | null {
    const note = this.tabs.get(tabId)?.note
    return note ? { ...note } : null
  }

  /**
   * `generation`: the number of the note the text was typed against. Against the current number the text replaces the
   * note; against an older one that Claude's edits came after, the edits are replayed onto the text.
   */
  setText(tabId: string, text: string, generation: number): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    if (generation === tab.generation) {
      this.change(tab, (n) => ({ ...n, text }))
      return
    }
    const ops = opsSince(tab.ops, tab.generation, generation)
    if (ops) {
      this.change(tab, (n) => ({ ...n, text: replayNoteOps(text, ops) }))
      return
    }
    const replaced = this.replacedFor(tab, generation)
    if (replaced) this.lateReplaced(tab, replaced, text)
    else if (generation === tab.givenAt - 1 && tab.before) this.late(tabId, tab, tab.before, text)
  }

  /** a change made against a note the tab no longer has is dropped: it is no text, and nothing is lost */
  setView(tabId: string, shown: boolean, form: NoteForm, generation: number): void {
    const tab = this.tabs.get(tabId)
    if (tab && this.takes(tab, generation)) this.change(tab, (n) => ({ ...n, shown, form }))
  }

  /** the card a note is drawn on; dropped against a note the tab no longer has, as setView */
  setSide(tabId: string, side: NoteSide, generation: number): void {
    const tab = this.tabs.get(tabId)
    if (tab && this.takes(tab, generation)) this.change(tab, (n) => ({ ...n, side }))
  }

  /** the card size of a note; null removes it, so the default size is drawn; dropped against a note the tab no longer has */
  setSize(tabId: string, size: NoteSize | null, generation: number): void {
    const tab = this.tabs.get(tabId)
    if (!tab || !this.takes(tab, generation)) return
    this.change(tab, (n) => {
      const next: Note = { ...n }
      if (size) next.size = { width: size.width, height: size.height }
      else delete next.size
      return next
    })
  }

  /** one of Claude's edits of the tab's session note; null for an unknown or a remote tab */
  apply(tabId: string, op: NoteOp): OpResult | null {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.remote) return null
    const result = tryNoteOp(tab.note?.text ?? '', op)
    if (!result.ok || !result.changed) return result
    const text = result.text
    this.change(tab, (n) => ({ ...n, text }))
    tab.generation++
    tab.ops.push({ generation: tab.generation, op })
    if (tab.ops.length > OPS_KEPT) tab.ops.shift()
    this.deps.publishOp(tabId, op, tab.generation)
    return result
  }

  /**
   * Another device changed the note of a conversation: every tab on it takes the note with the next number. `before` is
   * the version the store held before the change; text typed against the note the tab had goes on that version.
   */
  external(sessionId: string, note: Note | null, before: unknown): void {
    for (const [tabId, tab] of this.tabs) {
      if (tab.sessionId !== sessionId) continue
      tab.replaced.push({ generation: tab.generation, sessionId, base: before })
      if (tab.replaced.length > REPLACED_KEPT) tab.replaced.shift()
      this.give(tabId, tab, note)
    }
  }

  /**
   * The replaced note text typed against `generation` goes on: the first one from that number on, the note the tab
   * showed then. Null when the kept notes do not reach back that far, or when the number is the current one or later.
   */
  private replacedFor(tab: TabNote, generation: number): Replaced | null {
    const first = tab.replaced[0]
    if (!first || generation < first.generation || generation >= tab.generation) return null
    return tab.replaced.find((r) => r.generation >= generation) ?? null
  }

  /** main gives the tab a note: it gets the next number, and the renderer gets the note; Claude's edits of the old one end */
  private give(tabId: string, tab: TabNote, note: Note | null): void {
    tab.note = note
    tab.generation++
    tab.givenAt = tab.generation
    tab.ops = []
    this.deps.publish(tabId, note && { ...note }, tab.generation)
  }

  /** a change of a side, a size or a view is taken against the current number or against one Claude's edits came after */
  private takes(tab: TabNote, generation: number): boolean {
    return generation === tab.generation || opsSince(tab.ops, tab.generation, generation) !== null
  }

  private change(tab: TabNote, edit: (note: Note) => Note): void {
    tab.note = edit(tab.note ?? EMPTY)
    if (tab.sessionId) this.deps.store.set(tab.sessionId, tab.note)
  }

  /** text typed against a note another device replaced: stored on that note's base, the store joins it with the note there */
  private lateReplaced(tab: TabNote, replaced: Replaced, text: string): void {
    // the tab keeps the text it has now
    tab.note = { ...(tab.note ?? EMPTY), text }
    this.deps.store.set(replaced.sessionId, { ...tab.note }, replaced.base)
  }

  /** text typed against the note the tab had before: it goes where that note lives */
  private late(tabId: string, tab: TabNote, before: Before, text: string): void {
    if ('left' in before) {
      this.deps.store.set(before.left, { ...(this.deps.store.get(before.left) ?? EMPTY), text })
      return
    }
    // the tab's part of the merged note
    tab.note = { ...(tab.note ?? before.joined), text: joined(before.joined, { ...EMPTY, text }).text }
    if (tab.sessionId) this.deps.store.set(tab.sessionId, tab.note)
    this.deps.publish(tabId, { ...tab.note }, tab.generation)
  }
}
