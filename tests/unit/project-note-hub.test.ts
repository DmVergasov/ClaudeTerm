import { describe, expect, it } from 'vitest'
import { ProjectNoteHub } from '../../src/main/project-note-hub'
import type { ProjectNote } from '../../src/shared/note'
import { applyNoteOp, type NoteOp } from '../../src/shared/note-items'

const KEY = 'c0ffee-demo-project'
const OTHER = 'c0ffee-other-project'
const P = { key: KEY, name: 'Demo' }
const Q = { key: OTHER, name: 'Other' }

function setup(stored: Record<string, ProjectNote> = {}) {
  const store = new Map(Object.entries(stored))
  const published: [string, ProjectNote | null, number][] = []
  const ops: [string, NoteOp, number][] = []
  const hub = new ProjectNoteHub({
    store: {
      get: (key) => store.get(key) ?? null,
      set: (key, n) => {
        if (n && n.text.trim().length > 0) store.set(key, { ...n })
        else store.delete(key)
      }
    },
    publish: (key, n, generation) => published.push([key, n, generation]),
    publishOp: (key, op, generation) => ops.push([key, op, generation])
  })
  return { hub, store, published, ops }
}

const release: ProjectNote = { text: 'Release' }

describe('ProjectNoteHub', () => {
  it('the first tab of a project gets the stored note with number 1; another tab of it, or the same place again, publishes nothing', () => {
    const { hub, published } = setup({ [KEY]: release })
    hub.place('t1', P)
    hub.place('t2', P)
    hub.place('t1', P)
    expect(published).toEqual([[KEY, release, 1]])
    expect(hub.get(KEY)).toEqual(release)
  })
  it('a project with no stored note is published as null with number 1', () => {
    const { hub, published } = setup()
    hub.place('t1', P)
    expect(published).toEqual([[KEY, null, 1]])
    expect(hub.get(KEY)).toBeNull()
  })
  it('a tab outside git, or not placed yet, has no project note', () => {
    const { hub, published, ops } = setup()
    const tag: NoteOp = { kind: 'append', text: 'x' }
    expect(hub.projectOf('t1')).toEqual({ key: null, why: 'unknown' })
    hub.place('t2', null)
    expect(hub.projectOf('t2')).toEqual({ key: null, why: 'outside' })
    expect(hub.apply('t1', tag)).toBeNull()
    expect(hub.apply('t2', tag)).toBeNull()
    expect(published).toEqual([])
    expect(ops).toEqual([])
  })
  it('text typed in any tab of the project is stored under its key; a text for another key is dropped', () => {
    const { hub, store } = setup()
    hub.place('t1', P)
    hub.place('t2', P)
    hub.place('t3', Q)
    hub.setText('t1', KEY, 'A', 1)
    expect(store.get(KEY)).toEqual({ text: 'A' })
    hub.setText('t2', KEY, 'B', 1)
    expect(store.get(KEY)).toEqual({ text: 'B' })
    hub.setText('t3', KEY, 'C', 1)
    expect(store.get(KEY)).toEqual({ text: 'B' })
    expect(store.has(OTHER)).toBe(false)
  })
  it("Claude's edit is applied to the current text, stored, and published as an op with the next number", () => {
    const { hub, store, ops } = setup({ [KEY]: release })
    hub.place('t1', P)
    const op: NoteOp = { kind: 'append', text: '- [ ] Tag the release' }
    hub.apply('t1', op)
    expect(store.get(KEY)?.text).toBe('Release\n\n- [ ] Tag the release')
    expect(ops).toEqual([[KEY, op, 2]])
  })
  it('a refused or unchanged op stores and publishes nothing', () => {
    const { hub, store, ops } = setup({ [KEY]: { text: '- [ ] Tag\n- [x] Ship' } })
    hub.place('t1', P)
    expect(hub.apply('t1', { kind: 'append', text: '   ' })).toEqual({ ok: false, reason: 'empty' })
    expect(hub.apply('t1', { kind: 'check', item: 'Nope', checked: true })).toEqual({ ok: false, reason: 'no-match' })
    expect(hub.apply('t1', { kind: 'check', item: 'Ship', checked: true })).toEqual({ ok: true, text: '- [ ] Tag\n- [x] Ship', changed: false })
    expect(store.get(KEY)?.text).toBe('- [ ] Tag\n- [x] Ship')
    expect(ops).toEqual([])
  })
  it('a text typed against the number before Claude\'s edit keeps the edit, as the window makes it', () => {
    const { hub, store } = setup()
    hub.place('t1', P)
    hub.setText('t1', KEY, 'Release', 1)
    const op: NoteOp = { kind: 'append', text: '- [ ] Tag the release' }
    hub.apply('t1', op)
    hub.setText('t1', KEY, 'Release checklist', 1)
    const merged = 'Release checklist\n\n- [ ] Tag the release'
    expect(store.get(KEY)?.text).toBe(merged)
    expect(merged).toBe(applyNoteOp('Release checklist', op))
    hub.setText('t1', KEY, 'Release checklist!\n\n- [ ] Tag the release', 2)
    expect(store.get(KEY)?.text).toBe('Release checklist!\n\n- [ ] Tag the release')
  })
  it('a tick Claude made stays when the person typed elsewhere at the same moment', () => {
    const { hub, store } = setup({ [KEY]: { text: '- [ ] Tag\n- [ ] Ship' } })
    hub.place('t1', P)
    hub.apply('t1', { kind: 'check', item: 'Ship', checked: true })
    hub.setText('t1', KEY, 'Notes\n- [ ] Tag\n- [ ] Ship', 1)
    expect(store.get(KEY)?.text).toBe('Notes\n- [ ] Tag\n- [x] Ship')
  })
  it("when the person changed the very item Claude ticked, the person's text wins", () => {
    const { hub, store } = setup({ [KEY]: { text: '- [ ] Tag\n- [ ] Ship' } })
    hub.place('t1', P)
    hub.apply('t1', { kind: 'check', item: 'Ship', checked: true })
    hub.setText('t1', KEY, '- [ ] Tag\n- [ ] Ship it', 1)
    expect(store.get(KEY)?.text).toBe('- [ ] Tag\n- [ ] Ship it')
  })
  it('a text typed against a number older than the kept edits is dropped', () => {
    const { hub, store } = setup({ [KEY]: release })
    hub.place('t1', P)
    for (let k = 0; k < 65; k++) hub.apply('t1', { kind: 'append', text: `item ${k}` })
    const kept = store.get(KEY)?.text
    hub.setText('t1', KEY, 'typed', 1)
    expect(store.get(KEY)?.text).toBe(kept)
  })
  it('the size is stored with the note; null removes it', () => {
    const { hub, store } = setup({ [KEY]: release })
    hub.place('t1', P)
    hub.place('t3', Q)
    hub.setSize('t1', KEY, { width: 480, height: 320 })
    expect(store.get(KEY)).toEqual({ text: 'Release', size: { width: 480, height: 320 } })
    hub.setSize('t3', KEY, null)
    expect(store.get(KEY)).toEqual({ text: 'Release', size: { width: 480, height: 320 } })
    hub.setSize('t1', KEY, null)
    expect(store.get(KEY)).toEqual(release)
    expect('size' in store.get(KEY)!).toBe(false)
  })
})
