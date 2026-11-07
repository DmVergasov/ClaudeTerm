import { describe, expect, it } from 'vitest'
import { NoteHub } from '../../src/main/note-hub'
import { hasText, MAX_NOTE_LENGTH, type Note } from '../../src/shared/note'

const A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const B = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
const C = 'a3c2cf68-2929-4166-9a00-000000000001'
function setup(stored: Record<string, Note> = {}) {
  const store = new Map(Object.entries(stored))
  const published: [string, Note | null, number][] = []
  const sets: [string, Note | null, unknown][] = []
  const hub = new NoteHub({
    store: {
      get: (id) => store.get(id) ?? null,
      set: (id, n, base) => {
        sets.push([id, n, base])
        if (n && hasText(n)) store.set(id, { ...n })
        else store.delete(id)
      }
    },
    publish: (tabId, n, generation) => published.push([tabId, n, generation])
  })
  return { hub, store, published, sets }
}
const alpha: Note = { text: 'alpha', shown: true, form: 'label' }

describe('NoteHub', () => {
  it('a tab opened in a conversation with a note takes it and tells the renderer', () => {
    const { hub, published } = setup({ [A]: alpha })
    hub.addTab('t1', A)
    expect(hub.get('t1')).toEqual(alpha)
    expect(published).toEqual([['t1', alpha, 1]])
  })
  it('a tab without a note publishes nothing', () => {
    const { hub, published } = setup()
    hub.addTab('t1', A)
    hub.addTab('t2', null)
    expect(published).toEqual([])
    expect(hub.get('t1')).toBeNull()
  })
  it('text and view are stored under the conversation; erasing the text removes the entry', () => {
    const { hub, store, published } = setup()
    hub.addTab('t1', A)
    hub.setView('t1', true, 'card', 0)
    expect(store.has(A)).toBe(false)
    hub.setText('t1', 'Goal', 0)
    expect(store.get(A)).toEqual({ text: 'Goal', shown: true, form: 'card' })
    hub.setView('t1', true, 'label', 0)
    expect(store.get(A)?.form).toBe('label')
    hub.setText('t1', '  ', 0)
    expect(store.has(A)).toBe(false)
    expect(published).toEqual([])
  })
  it('a note written before the conversation is known is stored once it is', () => {
    const { hub, store } = setup()
    hub.addTab('t1', null)
    hub.setText('t1', 'early', 0)
    expect(store.size).toBe(0)
    hub.session('t1', A)
    expect(store.get(A)?.text).toBe('early')
  })
  it('a note written before the conversation is known is appended to the note that conversation already has', () => {
    const { hub, store, published } = setup({ [A]: alpha })
    hub.addTab('t1', null)
    hub.setText('t1', 'early', 0)
    hub.session('t1', A)
    const merged: Note = { text: 'alpha\n\nearly', shown: alpha.shown, form: alpha.form }
    expect(hub.get('t1')).toEqual(merged)
    expect(store.get(A)).toEqual(merged)
    expect(published).toEqual([['t1', merged, 1]])
  })
  it('the merged text is cut at the length limit', () => {
    const { hub } = setup({ [A]: { ...alpha, text: 'a'.repeat(MAX_NOTE_LENGTH - 2) } })
    hub.addTab('t1', null)
    hub.setText('t1', 'xyz', 0)
    hub.session('t1', A)
    expect(hub.get('t1')?.text.length).toBe(MAX_NOTE_LENGTH)
  })
  it('a tab with no id and no text takes the stored note unchanged', () => {
    const { hub, published } = setup({ [A]: alpha })
    hub.addTab('t1', null)
    hub.session('t1', A)
    expect(hub.get('t1')).toEqual(alpha)
    expect(published).toEqual([['t1', alpha, 1]])
  })
  it('a tab closed before its conversation was known takes its note with it', () => {
    const { hub, store } = setup()
    hub.addTab('t1', null)
    hub.setText('t1', 'lost', 0)
    hub.removeTab('t1')
    expect(store.size).toBe(0)
  })
  it('/clear: the note moves to the new conversation and leaves the old one', () => {
    const { hub, store, published } = setup()
    hub.addTab('t1', A)
    hub.setText('t1', 'mine', 0)
    hub.session('t1', B)
    expect(store.has(A)).toBe(false)
    expect(store.get(B)?.text).toBe('mine')
    expect(hub.get('t1')?.text).toBe('mine')
    expect(published).toEqual([])
  })
  it('/resume into a conversation with a note: the tab takes it, the one it left keeps the tab\'s own', () => {
    const { hub, store, published } = setup({ [A]: alpha })
    hub.addTab('t1', B)
    hub.setText('t1', 'beta', 0)
    hub.session('t1', A)
    expect(hub.get('t1')).toEqual(alpha)
    expect(published).toEqual([['t1', alpha, 1]])
    expect(store.get(B)?.text).toBe('beta')
    expect(store.get(A)).toEqual(alpha)
  })
  it('the same conversation again changes nothing', () => {
    const { hub, store, published } = setup()
    hub.addTab('t1', A)
    hub.setText('t1', 'x', 0)
    hub.session('t1', A)
    expect(store.get(A)?.text).toBe('x')
    expect(published).toEqual([])
  })
  it('closing a tab keeps its note with the conversation; unknown tabs are ignored', () => {
    const { hub, store } = setup()
    hub.addTab('t1', A)
    hub.setText('t1', 'kept', 0)
    hub.removeTab('t1')
    expect(hub.get('t1')).toBeNull()
    expect(store.get(A)?.text).toBe('kept')
    hub.setText('shell', 'x', 0)
    hub.setView('shell', true, 'card', 0)
    expect(store.size).toBe(1)
  })

  it('a fork restored without its own conversation takes the note stored under the old one; the next conversation keeps it', () => {
    const { hub, store, published } = setup({ [B]: alpha })
    hub.addTab('t1', null)
    hub.adopt('t1', B)
    expect(hub.get('t1')).toEqual(alpha)
    expect(published).toEqual([['t1', alpha, 1]])
    hub.session('t1', C)
    expect(store.get(C)).toEqual(alpha)
    expect(store.has(B)).toBe(false)
  })
  it('the adopted note stays stored under the old conversation, with its edits, until the tab gets its own: a fork that never starts loses nothing', () => {
    const { hub, store } = setup({ [B]: alpha })
    hub.addTab('t1', null)
    hub.adopt('t1', B)
    expect(store.get(B)).toEqual(alpha)
    hub.setText('t1', 'alpha, edited', 1)
    expect(store.get(B)?.text).toBe('alpha, edited')
    // Claude did not start, and the tab is closed: the note is where it was
    hub.removeTab('t1')
    expect(store.get(B)?.text).toBe('alpha, edited')
  })
  it('text the tab typed before its conversation was known is joined to the adopted note', () => {
    const { hub, store } = setup({ [B]: alpha })
    hub.addTab('t1', null)
    hub.setText('t1', 'early', 0)
    hub.adopt('t1', B)
    const merged: Note = { text: 'alpha\n\nearly', shown: alpha.shown, form: alpha.form }
    expect(hub.get('t1')).toEqual(merged)
    expect(store.get(B)).toEqual(merged)
    hub.session('t1', C)
    expect(store.get(C)).toEqual(merged)
    expect(store.has(B)).toBe(false)
  })
  it('adopt of a conversation with no note changes nothing', () => {
    const { hub, store, published } = setup()
    hub.addTab('t1', null)
    hub.adopt('t1', B)
    expect(hub.get('t1')).toBeNull()
    expect(published).toEqual([])
    expect(store.size).toBe(0)
  })
  describe('edits typed against an older note', () => {
    it('text typed against the note the tab had before /resume goes to the conversation it left', () => {
      const { hub, store, published } = setup({ [A]: alpha })
      hub.addTab('t1', B)
      hub.setView('t1', true, 'card', 0)
      hub.setText('t1', 'b', 0)
      hub.session('t1', A)
      // still in flight when main gave the tab A's note
      hub.setText('t1', 'beta', 0)
      expect(hub.get('t1')).toEqual(alpha)
      expect(store.get(A)).toEqual(alpha)
      expect(store.get(B)).toEqual({ text: 'beta', shown: true, form: 'card' })
      expect(published).toEqual([['t1', alpha, 1]])
      // typed against A's note: A's
      hub.setText('t1', 'alpha!', 1)
      expect(store.get(A)).toEqual({ ...alpha, text: 'alpha!' })
      expect(store.get(B)?.text).toBe('beta')
    })
    it('text typed against a note the conversation it left never stored is stored there', () => {
      const { hub, store } = setup({ [A]: alpha })
      hub.addTab('t1', B)
      hub.session('t1', A)
      hub.setText('t1', 'late', 0)
      expect(store.get(B)).toEqual({ text: 'late', shown: false, form: 'card' })
      expect(store.get(A)).toEqual(alpha)
    })
    it('text typed against a note held before the first id replaces the tab\'s part of the merged note', () => {
      const { hub, store, published } = setup({ [A]: alpha })
      hub.addTab('t1', null)
      hub.setText('t1', 'ear', 0)
      hub.session('t1', A)
      hub.setText('t1', 'early', 0)
      const merged: Note = { ...alpha, text: 'alpha\n\nearly' }
      expect(hub.get('t1')).toEqual(merged)
      expect(store.get(A)).toEqual(merged)
      expect(published).toEqual([['t1', { ...alpha, text: 'alpha\n\near' }, 1], ['t1', merged, 1]])
      // erased: the stored note alone
      hub.setText('t1', '', 0)
      expect(store.get(A)).toEqual(alpha)
      expect(published.at(-1)).toEqual(['t1', alpha, 1])
    })
    it('text typed before the first id, when none had reached main, joins the stored note the tab took', () => {
      const { hub, store, published } = setup({ [A]: alpha })
      hub.addTab('t1', null)
      hub.session('t1', A)
      hub.setText('t1', 'early', 0)
      const merged: Note = { ...alpha, text: 'alpha\n\nearly' }
      expect(store.get(A)).toEqual(merged)
      expect(published).toEqual([['t1', alpha, 1], ['t1', merged, 1]])
    })
    it('a /clear keeps the note and its number: the next edit lands on the new conversation', () => {
      const { hub, store, published } = setup({ [A]: alpha })
      hub.addTab('t1', A)
      hub.session('t1', B)
      expect(published).toEqual([['t1', alpha, 1]])
      hub.setText('t1', 'alpha, cleared', 1)
      expect(store.has(A)).toBe(false)
      expect(store.get(B)).toEqual({ ...alpha, text: 'alpha, cleared' })
      hub.setView('t1', false, 'label', 1)
      expect(store.get(B)?.shown).toBe(false)
    })
    it('a change of the shown note or its form made against an older note is dropped', () => {
      const { hub, store } = setup({ [A]: alpha })
      hub.addTab('t1', B)
      hub.setView('t1', true, 'card', 0)
      hub.setText('t1', 'beta', 0)
      hub.session('t1', A)
      hub.setView('t1', false, 'label', 0)
      expect(store.get(A)).toEqual(alpha)
      expect(store.get(B)).toEqual({ text: 'beta', shown: true, form: 'card' })
      expect(hub.get('t1')).toEqual(alpha)
    })
    it('an edit two notes back, or with a number main never gave, is dropped', () => {
      const { hub, store } = setup({ [A]: alpha, [C]: { ...alpha, text: 'gamma' } })
      hub.addTab('t1', B)
      hub.setText('t1', 'beta', 0)
      hub.session('t1', A)
      hub.session('t1', C)
      hub.setText('t1', 'stale', 0)
      hub.setText('t1', 'future', 3)
      hub.setView('t1', false, 'card', 3)
      expect(store.get(A)).toEqual(alpha)
      expect(store.get(B)?.text).toBe('beta')
      expect(store.get(C)).toEqual({ ...alpha, text: 'gamma' })
      expect(hub.get('t1')).toEqual({ ...alpha, text: 'gamma' })
    })
  })

  it('a remote tab takes the stored note of its new conversation and writes nothing', () => {
    const beta: Note = { text: 'beta', shown: true, form: 'card' }
    const { hub, published, sets } = setup({ [A]: alpha, [B]: beta })
    hub.addTab('t1', A, { remote: true })
    hub.setText('t1', 'typed here', 1)
    hub.session('t1', B)
    expect(published.at(-1)).toEqual(['t1', beta, 2])
    hub.session('t1', C)
    expect(published.at(-1)).toEqual(['t1', null, 3])
    expect(sets.map(([id]) => id)).toEqual([A])
  })

  describe('notes from another device', () => {
    const beta: Note = { text: 'beta', shown: false, form: 'card' }
    const S1 = A
    const S2 = B

    it('a note from another device goes to every tab on that conversation with the next number', () => {
      const { hub, published } = setup()
      hub.addTab('t1', S1)
      hub.addTab('t2', S1)
      hub.addTab('t3', S2)
      hub.external(S1, beta, 'v0')
      expect(published).toEqual([['t1', beta, 1], ['t2', beta, 1]])
      expect(hub.get('t1')).toEqual(beta)
    })
    it('a removed note from another device clears the tab', () => {
      const { hub, published } = setup({ [S1]: alpha })
      hub.addTab('t1', S1)
      hub.external(S1, null, 'v0')
      expect(published.at(-1)).toEqual(['t1', null, 2])
      expect(hub.get('t1')).toBeNull()
    })
    it('text typed against the note before it was replaced is written on the old base', () => {
      const { hub, sets } = setup()
      hub.addTab('t1', S1)
      hub.external(S1, beta, 'v0')
      hub.setText('t1', 'typed before', 0)
      expect(sets.at(-1)).toEqual([S1, { ...beta, text: 'typed before' }, 'v0'])
    })
    it('text typed against the note before it was replaced is stored, not published back to the tab', () => {
      const { hub, store, published } = setup()
      hub.addTab('t1', S1)
      hub.external(S1, beta, 'v0')
      const before = published.length
      hub.setText('t1', 'typed before', 0)
      expect(store.get(S1)?.text).toBe('typed before')
      expect(published.length).toBe(before)
    })
    it('the edit typed against the current note keeps no base', () => {
      const { hub, sets } = setup()
      hub.addTab('t1', S1)
      hub.external(S1, beta, 'v0')
      hub.setText('t1', 'now', 1)
      expect(sets.at(-1)).toEqual([S1, { ...beta, text: 'now' }, undefined])
    })
    it('a note from another device is not written to the store', () => {
      const { hub, sets, store } = setup()
      hub.addTab('t1', S1)
      hub.external(S1, beta, 'v0')
      expect(sets).toEqual([])
      expect(store.size).toBe(0)
    })
    it('the tab\'s own later edit after the replacement is not on the old base', () => {
      const { hub, sets } = setup({ [S1]: alpha })
      hub.addTab('t1', S1)
      hub.external(S1, beta, 'v0')
      hub.setText('t1', 'typed before', 1)
      expect(sets.at(-1)).toEqual([S1, { ...beta, text: 'typed before' }, 'v0'])
      hub.setView('t1', false, 'label', 2)
      expect(sets.at(-1)).toEqual([S1, { ...beta, text: 'typed before', shown: false, form: 'label' }, undefined])
    })
    it('a note from a conversation no tab has changes nothing', () => {
      const { hub, published, sets } = setup()
      hub.addTab('t1', S1)
      hub.external(S2, beta, 'v0')
      expect(published).toEqual([])
      expect(sets).toEqual([])
    })
    it('text typed against the note before two notes from another device is written on the base of the first', () => {
      const { hub, sets } = setup({ [S1]: alpha })
      hub.addTab('t1', S1)
      hub.external(S1, beta, 'v0')
      hub.external(S1, { ...beta, text: 'gamma' }, 'v1')
      hub.setText('t1', 'typed', 1)
      expect(sets.at(-1)).toEqual([S1, { ...beta, text: 'typed' }, 'v0'])
    })
    it('several keystrokes typed against the same older note all use its base', () => {
      const { hub, sets } = setup({ [S1]: alpha })
      hub.addTab('t1', S1)
      hub.external(S1, beta, 'v0')
      hub.setText('t1', 't', 1)
      hub.setText('t1', 'ty', 1)
      hub.setText('t1', 'typed', 1)
      expect(sets.slice(-3).map(([, , base]) => base)).toEqual(['v0', 'v0', 'v0'])
      expect(sets.at(-1)?.[1]?.text).toBe('typed')
    })
    it('the replaced notes kept are the last sixteen: an edit older than them is dropped', () => {
      const { hub, sets } = setup()
      hub.addTab('t1', S1)
      for (let k = 0; k < 17; k++) hub.external(S1, beta, `v${k}`)
      const count = sets.length
      hub.setText('t1', 'old', 0)
      expect(sets.length).toBe(count)
      hub.setText('t1', 'kept', 1)
      expect(sets.at(-1)).toEqual([S1, { ...beta, text: 'kept' }, 'v1'])
    })
    it('a late edit after the tab changed conversation is dropped', () => {
      const { hub, sets, store } = setup({ [S1]: alpha })
      hub.addTab('t1', S1)
      hub.external(S1, beta, 'v0')
      hub.session('t1', S2)
      const count = sets.length
      hub.setText('t1', 'late', 1)
      expect(sets.length).toBe(count)
      expect(store.get(S2)).toEqual(beta)
    })
  })
})

describe('NoteHub.resetTab (fix 1, I3)', () => {
  it("a reset empties the window's note, keeps the number going, and an edit after it is kept under the new conversation", () => {
    const { hub, store, published } = setup({ [A]: alpha })
    hub.addTab('t1', A)
    const first = published[0][2]
    hub.resetTab('t1')
    const [, n, gen] = published.at(-1)!
    expect(n).toBeNull()
    expect(gen).toBeGreaterThan(first)
    hub.setText('t1', 'fresh', gen)
    hub.session('t1', C)
    expect(store.get(C)?.text).toBe('fresh')
    expect(store.get(A)?.text).toBe('alpha')
  })

  it('the old text never reaches the new conversation', () => {
    const { hub, store } = setup({ [A]: alpha })
    hub.addTab('t1', A)
    hub.resetTab('t1')
    hub.session('t1', C)
    expect(store.has(C)).toBe(false)
    expect(hub.get('t1')).toBeNull()
  })

  it('text typed against the old note after the reset is kept with the old conversation', () => {
    const { hub, store } = setup({ [A]: alpha })
    hub.addTab('t1', A)
    hub.resetTab('t1')
    hub.setText('t1', 'late', 1)
    expect(store.get(A)?.text).toBe('late')
  })
})
