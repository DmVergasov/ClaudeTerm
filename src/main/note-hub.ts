import { hasText, MAX_NOTE_LENGTH, type Note, type NoteForm } from '../shared/note'
import type { SessionNotes } from './session-notes'

export interface NoteHubDeps {
  store: Pick<SessionNotes, 'get' | 'set'>
  /**
   * Tells the renderer a tab's note that came from main (a stored one), never an echo of its own edits, with its
   * number: the renderer's edits carry the number of the note they were typed against.
   */
  publish(tabId: string, note: Note | null, generation: number): void
}

const EMPTY: Note = { text: '', shown: false, form: 'card' }

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

interface TabNote {
  sessionId: string | null
  note: Note | null
  /** the number of the note main gave the tab last; 0 until it gives one */
  generation: number
  /** the note of the number before; null when the tab had none (its first note came with it) */
  before: Before | null
}

/** Each Claude tab's note: kept with the tab's conversation, and moved or swapped when the conversation changes. */
export class NoteHub {
  private readonly tabs = new Map<string, TabNote>()

  constructor(private readonly deps: NoteHubDeps) {}

  addTab(tabId: string, sessionId: string | null): void {
    const stored = sessionId ? this.deps.store.get(sessionId) : null
    const tab: TabNote = { sessionId, note: null, generation: 0, before: null }
    this.tabs.set(tabId, tab)
    if (stored) this.give(tabId, tab, stored)
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
    const stored = this.deps.store.get(sessionId)
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

  /** `generation`: the number of the note the text was typed against */
  setText(tabId: string, text: string, generation: number): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    if (generation === tab.generation) this.change(tab, (n) => ({ ...n, text }))
    else if (generation === tab.generation - 1 && tab.before) this.late(tabId, tab, tab.before, text)
  }

  /** a change made against a note the tab no longer has is dropped: it is no text, and nothing is lost */
  setView(tabId: string, shown: boolean, form: NoteForm, generation: number): void {
    const tab = this.tabs.get(tabId)
    if (tab && generation === tab.generation) this.change(tab, (n) => ({ ...n, shown, form }))
  }

  /** main gives the tab a note: it gets the next number, and the renderer gets the note */
  private give(tabId: string, tab: TabNote, note: Note): void {
    tab.note = note
    tab.generation++
    this.deps.publish(tabId, { ...note }, tab.generation)
  }

  private change(tab: TabNote, edit: (note: Note) => Note): void {
    tab.note = edit(tab.note ?? EMPTY)
    if (tab.sessionId) this.deps.store.set(tab.sessionId, tab.note)
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
