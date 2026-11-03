import { describe, expect, it } from 'vitest'
import { NoteHub } from '../../src/main/note-hub'
import { hasText, type Note } from '../../src/shared/note'

const A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const B = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
function setup(stored: Record<string, Note> = {}) {
  const store = new Map(Object.entries(stored))
  const published: [string, Note | null][] = []
  const hub = new NoteHub({
    store: { get: (id) => store.get(id) ?? null, set: (id, n) => { if (n && hasText(n)) store.set(id, { ...n }); else store.delete(id) } },
    publish: (tabId, n) => published.push([tabId, n])
  })
  return { hub, store, published }
}
const alpha: Note = { text: 'alpha', shown: true, form: 'label' }

describe('NoteHub', () => {
  it('a tab opened in a conversation with a note takes it and tells the renderer', () => {
    const { hub, published } = setup({ [A]: alpha })
    hub.addTab('t1', A)
    expect(hub.get('t1')).toEqual(alpha)
    expect(published).toEqual([['t1', alpha]])
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
    hub.setView('t1', true, 'card')
    expect(store.has(A)).toBe(false)
    hub.setText('t1', 'Goal')
    expect(store.get(A)).toEqual({ text: 'Goal', shown: true, form: 'card' })
    hub.setView('t1', true, 'label')
    expect(store.get(A)?.form).toBe('label')
    hub.setText('t1', '  ')
    expect(store.has(A)).toBe(false)
    expect(published).toEqual([])
  })
  it('a note written before the conversation is known is stored once it is', () => {
    const { hub, store } = setup()
    hub.addTab('t1', null)
    hub.setText('t1', 'early')
    expect(store.size).toBe(0)
    hub.session('t1', A)
    expect(store.get(A)?.text).toBe('early')
  })
  it('a tab closed before its conversation was known takes its note with it', () => {
    const { hub, store } = setup()
    hub.addTab('t1', null)
    hub.setText('t1', 'lost')
    hub.removeTab('t1')
    expect(store.size).toBe(0)
  })
  it('/clear: the note moves to the new conversation and leaves the old one', () => {
    const { hub, store, published } = setup()
    hub.addTab('t1', A)
    hub.setText('t1', 'mine')
    hub.session('t1', B)
    expect(store.has(A)).toBe(false)
    expect(store.get(B)?.text).toBe('mine')
    expect(hub.get('t1')?.text).toBe('mine')
    expect(published).toEqual([])
  })
  it('/resume into a conversation with a note: the tab takes it, the one it left keeps the tab\'s own', () => {
    const { hub, store, published } = setup({ [A]: alpha })
    hub.addTab('t1', B)
    hub.setText('t1', 'beta')
    hub.session('t1', A)
    expect(hub.get('t1')).toEqual(alpha)
    expect(published).toEqual([['t1', alpha]])
    expect(store.get(B)?.text).toBe('beta')
    expect(store.get(A)).toEqual(alpha)
  })
  it('the same conversation again changes nothing', () => {
    const { hub, store, published } = setup()
    hub.addTab('t1', A)
    hub.setText('t1', 'x')
    hub.session('t1', A)
    expect(store.get(A)?.text).toBe('x')
    expect(published).toEqual([])
  })
  it('closing a tab keeps its note with the conversation; unknown tabs are ignored', () => {
    const { hub, store } = setup()
    hub.addTab('t1', A)
    hub.setText('t1', 'kept')
    hub.removeTab('t1')
    expect(hub.get('t1')).toBeNull()
    expect(store.get(A)?.text).toBe('kept')
    hub.setText('shell', 'x')
    hub.setView('shell', true, 'card')
    expect(store.size).toBe(1)
  })
})
