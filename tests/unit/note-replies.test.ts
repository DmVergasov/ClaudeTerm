import { describe, expect, it } from 'vitest'
import { NoteHub } from '../../src/main/note-hub'
import { addToNoteReply, checkNoteItemReply, type NoteReplyDeps, readNotesReply } from '../../src/main/note-replies'
import { ProjectNoteHub } from '../../src/main/project-note-hub'
import { MAX_NOTE_LENGTH, type Note, type ProjectNote } from '../../src/shared/note'
import type { NoteAddMessage, NoteCheckMessage, NoteReadMessage, PipeResponse } from '../../src/shared/protocol'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const OTHER_TAB = 'a3c2cf68-2929-4166-9a00-000000000002'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const KEY = 'c0ffee-demo-project'
const ACME = { key: KEY, name: 'acme' }

interface Rig {
  /** the session note the tab starts with */
  session?: string
  /** the project the tab is in: null outside git; undefined while its place is not known */
  project?: { key: string; name: string } | null
  /** the project note stored under the project's key */
  projectText?: string
}

/** the real hubs over Map stores, with one Claude tab in a conversation and its place */
function rig(opts: Rig = {}) {
  const sessions = new Map<string, Note>()
  const projects = new Map<string, ProjectNote>()
  if (opts.session !== undefined) sessions.set(SID, { text: opts.session, shown: false, form: 'card' })
  if (opts.projectText !== undefined) projects.set(KEY, { text: opts.projectText })
  const session = new NoteHub({
    store: {
      get: (id) => sessions.get(id) ?? null,
      set: (id, n) => {
        if (n && n.text.trim() !== '') sessions.set(id, { ...n })
        else sessions.delete(id)
      }
    },
    publish: () => {},
    publishOp: () => {}
  })
  const project = new ProjectNoteHub({
    store: {
      get: (key) => projects.get(key) ?? null,
      set: (key, n) => {
        if (n && n.text.trim() !== '') projects.set(key, { ...n })
        else projects.delete(key)
      }
    },
    publish: () => {},
    publishOp: () => {}
  })
  session.addTab(TAB, SID)
  if (opts.project !== undefined) project.place(TAB, opts.project)
  const deps: NoteReplyDeps = { isClaudeTab: (id) => id === TAB, session, project }
  return { deps, session, project }
}

const read = (tabId = TAB): NoteReadMessage => ({ v: 1, type: 'note_read', tabId })
const infoOf = (reply: PipeResponse): string | undefined => (reply.ok ? reply.info : undefined)
const add = (note: 'session' | 'project', text: string, tabId = TAB): NoteAddMessage => ({ v: 1, type: 'note_add', tabId, note, text })
const check = (note: 'session' | 'project', item: string, checked: boolean, tabId = TAB): NoteCheckMessage => ({ v: 1, type: 'note_check', tabId, note, item, checked })

describe('read_notes', () => {
  it('read gives both notes under their names; an empty note reads (empty)', () => {
    const { deps } = rig({ session: 'Goal: payments', project: ACME, projectText: 'Release' })
    expect(readNotesReply(deps, read())).toEqual({ ok: true, info: '## Session note\nGoal: payments\n\n## Project note (acme)\nRelease' })
    const empty = rig({ project: ACME })
    expect(readNotesReply(empty.deps, read())).toEqual({ ok: true, info: '## Session note\n(empty)\n\n## Project note (acme)\n(empty)' })
  })

  it('read says why a tab has no project: outside git, or not found yet', () => {
    const outside = rig({ project: null })
    expect(infoOf(readNotesReply(outside.deps, read()))).toBe("## Session note\n(empty)\n\n## Project note\n(none: this tab's folder is not in a git repository)")
    const unknown = rig()
    expect(infoOf(readNotesReply(unknown.deps, read()))).toBe("## Session note\n(empty)\n\n## Project note\n(none yet: ClaudeTerm has not found this tab's project; try again in a moment)")
  })
})

describe('add_to_note', () => {
  it('add names the note it added to; an empty text, a text past the limit and a missing project are refused, nothing added', () => {
    const { deps, session, project } = rig({ session: 'Goal', project: ACME, projectText: 'Release' })
    expect(addToNoteReply(deps, add('session', '- [ ] Write the tests'))).toEqual({ ok: true, info: 'Added to the session note.' })
    expect(session.get(TAB)?.text).toBe('Goal\n\n- [ ] Write the tests')
    expect(addToNoteReply(deps, add('project', '- [ ] Tag'))).toEqual({ ok: true, info: 'Added to the project note (acme).' })
    expect(project.get(KEY)?.text).toBe('Release\n\n- [ ] Tag')

    expect(addToNoteReply(deps, add('session', ' \n\t'))).toEqual({ ok: false, error: 'The text is empty. Nothing was added.' })
    const full = rig({ session: 'x'.repeat(MAX_NOTE_LENGTH - 5) })
    expect(addToNoteReply(full.deps, add('session', 'abcdef'))).toEqual({
      ok: false,
      error: 'The text would make the session note longer than 100000 characters (it has 99995, the text adds 8). Nothing was added.'
    })
    expect(full.session.get(TAB)?.text).toBe('x'.repeat(MAX_NOTE_LENGTH - 5))

    const outside = rig({ project: null })
    expect(addToNoteReply(outside.deps, add('project', 'Tag'))).toEqual({
      ok: false,
      error: 'This tab has no project note: its folder is not in a git repository. Nothing was added.'
    })
    const unknown = rig()
    expect(addToNoteReply(unknown.deps, add('project', 'Tag'))).toEqual({
      ok: false,
      error: "ClaudeTerm has not found this tab's project yet; try again in a moment. Nothing was added."
    })
  })
})

describe('check_note_item', () => {
  it('check ticks and unticks, and says when the item already was', () => {
    const { deps, session, project } = rig({ session: '- [ ] Tag the release\n- [ ] Write the changelog', project: ACME, projectText: '- [ ] Tag' })
    expect(checkNoteItemReply(deps, check('session', 'Tag the release', true))).toEqual({ ok: true, info: 'Ticked "Tag the release" in the session note.' })
    expect(session.get(TAB)?.text).toBe('- [x] Tag the release\n- [ ] Write the changelog')
    expect(checkNoteItemReply(deps, check('session', 'Tag the release', true))).toEqual({ ok: true, info: '"Tag the release" is already ticked in the session note.' })
    expect(checkNoteItemReply(deps, check('session', 'Tag the release', false))).toEqual({ ok: true, info: 'Unticked "Tag the release" in the session note.' })
    expect(checkNoteItemReply(deps, check('project', 'Tag', true))).toEqual({ ok: true, info: 'Ticked "Tag" in the project note (acme).' })
    expect(project.get(KEY)?.text).toBe('- [x] Tag')
  })

  it('check lists the items when none or several match, at most 50', () => {
    const none = rig({ session: 'Goal' })
    expect(checkNoteItemReply(none.deps, check('session', 'Publish', true))).toEqual({ ok: false, error: 'The session note has no checkbox items.' })
    const noneProject = rig({ project: ACME, projectText: 'Release' })
    expect(checkNoteItemReply(noneProject.deps, check('project', 'Publish', true))).toEqual({ ok: false, error: 'The project note (acme) has no checkbox items.' })

    const two = rig({ session: '- [ ] Tag the release\n- [ ] Write the changelog' })
    expect(checkNoteItemReply(two.deps, check('session', 'Publish', true))).toEqual({
      ok: false,
      error: 'No item "Publish" in the session note. Its items:\n- [ ] Tag the release\n- [ ] Write the changelog'
    })

    const several = rig({ session: '- [ ] Tag\n- [x] Tag\n- [ ] Other' })
    expect(checkNoteItemReply(several.deps, check('session', 'Tag', true))).toEqual({
      ok: false,
      error: '2 items in the session note read "Tag"; nothing was changed. Its items:\n- [ ] Tag\n- [x] Tag\n- [ ] Other'
    })

    const many = Array.from({ length: 60 }, (_, i) => `- [ ] item ${i}`)
    const long = rig({ session: many.join('\n') })
    const listed = many.slice(0, 50).join('\n')
    expect(checkNoteItemReply(long.deps, check('session', 'nope', true))).toEqual({
      ok: false,
      error: `No item "nope" in the session note. Its items:\n${listed}\n… and 10 more`
    })
  })

  it('a tab that is not a Claude tab is refused by each tool', () => {
    const { deps } = rig({ session: 'Goal', project: ACME })
    expect(readNotesReply(deps, read(OTHER_TAB))).toEqual({ ok: false, error: 'read_notes works only in a ClaudeTerm Claude tab' })
    expect(addToNoteReply(deps, add('session', 'x', OTHER_TAB))).toEqual({ ok: false, error: 'add_to_note works only in a ClaudeTerm Claude tab' })
    expect(checkNoteItemReply(deps, check('session', 'x', true, OTHER_TAB))).toEqual({ ok: false, error: 'check_note_item works only in a ClaudeTerm Claude tab' })
  })
})
