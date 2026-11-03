import type { Note, NoteForm } from '../shared/note'
import type { SessionNotes } from './session-notes'

export interface NoteHubDeps {
  store: Pick<SessionNotes, 'get' | 'set'>
  /** Tells the renderer a tab's note that came from main (a stored one), never an echo of its own edits. */
  publish(tabId: string, note: Note | null): void
}

interface TabNote {
  sessionId: string | null
  note: Note | null
}

/** Each Claude tab's note: kept with the tab's conversation, and moved or swapped when the conversation changes. */
export class NoteHub {
  private readonly tabs = new Map<string, TabNote>()

  constructor(private readonly deps: NoteHubDeps) {}

  addTab(tabId: string, sessionId: string | null): void {
    const stored = sessionId ? this.deps.store.get(sessionId) : null
    this.tabs.set(tabId, { sessionId, note: stored })
    if (stored) this.deps.publish(tabId, { ...stored })
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
      tab.note = stored
      this.deps.publish(tabId, { ...stored })
      return
    }
    if (!tab.note) return
    this.deps.store.set(sessionId, tab.note)
    if (old) this.deps.store.set(old, null)
  }

  get(tabId: string): Note | null {
    const note = this.tabs.get(tabId)?.note
    return note ? { ...note } : null
  }

  setText(tabId: string, text: string): void {
    this.change(tabId, (n) => ({ ...n, text }))
  }

  setView(tabId: string, shown: boolean, form: NoteForm): void {
    this.change(tabId, (n) => ({ ...n, shown, form }))
  }

  private change(tabId: string, edit: (note: Note) => Note): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    tab.note = edit(tab.note ?? { text: '', shown: false, form: 'card' })
    if (tab.sessionId) this.deps.store.set(tab.sessionId, tab.note)
  }
}
