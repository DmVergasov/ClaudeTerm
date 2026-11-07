import { describe, expect, it } from 'vitest'
import { shownPlan, TaskListHub } from '../../src/main/task-list-hub'
import type { TaskList } from '../../src/shared/task-list'
import type { PlanStatus } from '../../src/shared/types'

const A = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const B = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f2a3b4c5d'
const C = 'a3c2cf68-2929-4166-9a00-000000000001'

const unfinished: TaskList = { title: 'Release checks', tasks: [{ title: 'Write the notes', status: 'completed' }, { title: 'Tag', status: 'pending' }] }
const finished: TaskList = { title: 'Release checks', tasks: [{ title: 'Write the notes', status: 'completed' }, { title: 'Tag', status: 'completed' }] }

function setup(stored: Record<string, TaskList> = {}) {
  const store = new Map(Object.entries(stored))
  const changed: string[] = []
  const hub = new TaskListHub({
    store: {
      get: (id) => (store.has(id) ? structuredClone(store.get(id)!) : null),
      set: (id, list) => {
        if (list) store.set(id, structuredClone(list))
        else store.delete(id)
      }
    },
    onChange: (tabId) => changed.push(tabId)
  })
  return { hub, store, changed }
}

const plan = (finishedPlan: boolean): PlanStatus => ({ title: 'Plan', tasks: [], done: 0, total: 0, finished: finishedPlan })
const listStatus = (finishedList: boolean): PlanStatus => ({
  title: 'Tasks',
  tasks: [],
  done: finishedList ? 1 : 0,
  total: 1,
  finished: finishedList
})

describe('TaskListHub', () => {
  it('a tab opened in a conversation with a list takes it and reports the change', () => {
    const { hub, changed } = setup({ [A]: unfinished })
    hub.addTab('t1', A)
    expect(hub.get('t1')).toEqual(unfinished)
    expect(hub.status('t1')?.title).toBe('Release checks')
    expect(changed).toEqual(['t1'])
  })

  it('a tab without a list reports nothing', () => {
    const { hub, changed } = setup()
    hub.addTab('t1', A)
    hub.addTab('t2', null)
    expect(hub.get('t1')).toBeNull()
    expect(hub.status('t2')).toBeNull()
    expect(changed).toEqual([])
  })

  it('session to the id the tab has moves nothing and shows a list hidden by sessionEnd again', () => {
    const { hub, store, changed } = setup({ [A]: unfinished })
    hub.addTab('t1', A)
    hub.sessionEnd('t1', A)
    hub.session('t1', A, null)
    expect(hub.get('t1')).toEqual(unfinished)
    expect(store.get(A)).toEqual(unfinished)
    expect(changed).toEqual(['t1', 't1', 't1'])
  })

  it('a folder change forgets the list the tab shows and its conversation; the list stays stored under the old conversation, and the next conversation takes none of it', () => {
    const { hub, store, changed } = setup({ [A]: unfinished })
    hub.addTab('t1', A)
    changed.length = 0
    hub.resetTab('t1')
    expect(hub.get('t1')).toBeNull()
    expect(hub.status('t1')).toBeNull()
    expect(changed).toEqual(['t1'])
    expect(store.get(A)).toEqual(unfinished)
    // the next SessionStart of the moved tab starts a conversation with no list of the old folder
    hub.session('t1', B, null)
    expect(hub.get('t1')).toBeNull()
    expect(store.get(A)).toEqual(unfinished)
    expect(store.has(B)).toBe(false)
  })

  it('a folder change of a tab with no list reports nothing', () => {
    const { hub, changed } = setup()
    hub.addTab('t1', null)
    changed.length = 0
    hub.resetTab('t1')
    expect(changed).toEqual([])
  })

  it('session to a new id shows the list stored under it, and the old one stays stored', () => {
    const { hub, store } = setup({ [A]: unfinished, [B]: finished })
    hub.addTab('t1', A)
    hub.session('t1', B, null)
    expect(hub.get('t1')).toEqual(finished)
    expect(store.get(A)).toEqual(unfinished)
  })

  it('session to a new id with a fork source copies the source list under the new id, and the head keeps its own', () => {
    const { hub, store, changed } = setup({ [A]: unfinished })
    hub.addTab('t1', null)
    hub.set('t1', finished)
    changed.length = 0
    hub.session('t1', B, A)
    expect(store.get(B)).toEqual(unfinished)
    expect(store.get(A)).toEqual(unfinished)
    expect(hub.get('t1')).toEqual(unfinished)
    expect(changed).toEqual(['t1'])
  })

  it('session to a new id with an unfinished list moves it to the new id', () => {
    const { hub, store } = setup({ [A]: unfinished })
    hub.addTab('t1', A)
    hub.session('t1', B, null)
    expect(store.get(B)).toEqual(unfinished)
    expect(store.has(A)).toBe(false)
    expect(hub.get('t1')).toEqual(unfinished)
  })

  it('session to a new id with a finished list leaves it under the old id, and the tab shows none', () => {
    const { hub, store, changed } = setup({ [A]: finished })
    hub.addTab('t1', A)
    changed.length = 0
    hub.session('t1', B, null)
    expect(store.get(A)).toEqual(finished)
    expect(store.has(B)).toBe(false)
    expect(hub.get('t1')).toBeNull()
    expect(changed).toEqual(['t1'])
  })

  it('a list set before any session id is stored under the first one', () => {
    const { hub, store } = setup()
    hub.addTab('t1', null)
    hub.set('t1', unfinished)
    hub.session('t1', A, null)
    expect(store.get(A)).toEqual(unfinished)
    expect(hub.get('t1')).toEqual(unfinished)
  })

  it('a finished list held in the tab is stored under the first id and keeps showing', () => {
    const { hub, store } = setup()
    hub.addTab('t1', null)
    hub.set('t1', finished)
    hub.session('t1', A, null)
    expect(store.get(A)).toEqual(finished)
    expect(hub.get('t1')).toEqual(finished)
    expect(hub.status('t1')?.finished).toBe(true)
  })

  it('sessionEnd for the tab session hides the list, which stays stored', () => {
    const { hub, store, changed } = setup({ [A]: unfinished })
    hub.addTab('t1', A)
    changed.length = 0
    hub.sessionEnd('t1', A)
    expect(hub.get('t1')).toBeNull()
    expect(hub.status('t1')).toBeNull()
    expect(store.get(A)).toEqual(unfinished)
    expect(changed).toEqual(['t1'])
  })

  it('sessionEnd for another session id does nothing', () => {
    const { hub, changed } = setup({ [A]: unfinished })
    hub.addTab('t1', A)
    changed.length = 0
    hub.sessionEnd('t1', B)
    expect(hub.get('t1')).toEqual(unfinished)
    expect(changed).toEqual([])
  })

  it('set stores the list under the tab session id', () => {
    const { hub, store, changed } = setup({ [A]: unfinished })
    hub.addTab('t1', A)
    changed.length = 0
    expect(hub.set('t1', finished)).toBe(true)
    expect(store.get(A)).toEqual(finished)
    expect(hub.status('t1')?.finished).toBe(true)
    expect(changed).toEqual(['t1'])
  })

  it('set before any session id keeps the list in the tab, out of the store', () => {
    const { hub, store, changed } = setup()
    hub.addTab('t1', null)
    changed.length = 0
    expect(hub.set('t1', unfinished)).toBe(true)
    expect(hub.get('t1')).toEqual(unfinished)
    expect(store.size).toBe(0)
    expect(changed).toEqual(['t1'])
  })

  it('set on a removed tab returns false and leaves the store untouched', () => {
    const { hub, store, changed } = setup({ [A]: unfinished })
    hub.addTab('t1', A)
    hub.removeTab('t1')
    changed.length = 0
    expect(hub.set('t1', finished)).toBe(false)
    expect(store.get(A)).toEqual(unfinished)
    expect(changed).toEqual([])
  })

  it('set with a list the tab already shows reports nothing', () => {
    const { hub, changed } = setup({ [A]: unfinished })
    hub.addTab('t1', A)
    changed.length = 0
    hub.set('t1', structuredClone(unfinished))
    expect(changed).toEqual([])
  })

  it('removeTab forgets the tab and reports nothing', () => {
    const { hub, changed } = setup({ [A]: unfinished })
    hub.addTab('t1', A)
    changed.length = 0
    hub.removeTab('t1')
    expect(hub.get('t1')).toBeNull()
    expect(hub.status('t1')).toBeNull()
    expect(changed).toEqual([])
  })

  it('status is the list in the form the status bar draws', () => {
    const { hub } = setup({ [A]: unfinished })
    hub.addTab('t1', A)
    expect(hub.status('t1')).toEqual({
      title: 'Release checks',
      tasks: [
        { n: 1, title: 'Write the notes', state: 'done' },
        { n: 2, title: 'Tag', state: 'left' }
      ],
      done: 1,
      total: 2,
      finished: false
    })
  })

  it('a session change to an id with nothing stored and no tab list shows none', () => {
    const { hub } = setup()
    hub.addTab('t1', A)
    hub.session('t1', C, null)
    expect(hub.get('t1')).toBeNull()
  })
})

describe('shownPlan', () => {
  it('an unfinished plan with an unfinished list shows the plan, whichever side changed last', () => {
    expect(shownPlan(plan(false), listStatus(false), 'list')).toEqual({ plan: plan(false), agentList: false })
    expect(shownPlan(plan(false), listStatus(false), 'plan')).toEqual({ plan: plan(false), agentList: false })
  })

  it('an unfinished plan with a finished list shows the plan, whichever side changed last', () => {
    expect(shownPlan(plan(false), listStatus(true), 'list')).toEqual({ plan: plan(false), agentList: false })
    expect(shownPlan(plan(false), listStatus(true), 'plan')).toEqual({ plan: plan(false), agentList: false })
  })

  it('a finished plan with an unfinished list shows the list, whichever side changed last', () => {
    expect(shownPlan(plan(true), listStatus(false), 'plan')).toEqual({ plan: listStatus(false), agentList: true })
    expect(shownPlan(plan(true), listStatus(false), 'list')).toEqual({ plan: listStatus(false), agentList: true })
  })

  it('a finished plan with a finished list shows the list when the list finished last', () => {
    expect(shownPlan(plan(true), listStatus(true), 'list')).toEqual({ plan: listStatus(true), agentList: true })
  })

  it('a finished plan with a finished list shows the plan when the plan finished last', () => {
    expect(shownPlan(plan(true), listStatus(true), 'plan')).toEqual({ plan: plan(true), agentList: false })
  })

  it('no plan with a finished list shows the list', () => {
    expect(shownPlan(null, listStatus(true), 'list')).toEqual({ plan: listStatus(true), agentList: true })
  })

  it('no plan and no list shows nothing', () => {
    expect(shownPlan(null, null, 'plan')).toEqual({ plan: null, agentList: false })
  })

  it('an unfinished plan with no list shows the plan', () => {
    expect(shownPlan(plan(false), null, 'plan')).toEqual({ plan: plan(false), agentList: false })
  })
})
