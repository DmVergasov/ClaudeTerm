import { describe, expect, it } from 'vitest'
import { describeTaskList, normalizeTaskList, taskListStatus, taskListSummary } from '../../src/shared/task-list'
import type { TaskList } from '../../src/shared/task-list'

const threeTasks: TaskList = {
  title: null,
  tasks: [
    { title: 'A', status: 'completed' },
    { title: 'B', status: 'in_progress' },
    { title: 'C', status: 'pending' }
  ]
}

describe('task list model', () => {
  describe('normalizeTaskList', () => {
    it('reads no list from null and from an empty tasks array', () => {
      expect(normalizeTaskList(null)).toEqual({ ok: true, list: null })
      expect(normalizeTaskList({ title: 'x', tasks: [] })).toEqual({ ok: true, list: null })
    })

    it('folds whitespace in the title and in the task titles', () => {
      expect(
        normalizeTaskList({ title: '  Release\n prep ', tasks: [{ title: 'Write\tthe  parser', status: 'completed' }] })
      ).toEqual({ ok: true, list: { title: 'Release prep', tasks: [{ title: 'Write the parser', status: 'completed' }] } })
    })

    it('folds control characters into the spaces between words, as whitespace', () => {
      expect(
        normalizeTaskList({ title: 'Release\u0007prep', tasks: [{ title: 'Write\u001b the\u0000parser', status: 'pending' }] })
      ).toEqual({ ok: true, list: { title: 'Release prep', tasks: [{ title: 'Write the parser', status: 'pending' }] } })
    })

    it('drops a blank or missing title and cuts long titles', () => {
      const task = { title: 'A', status: 'pending' }
      expect(normalizeTaskList({ title: '   ', tasks: [task] })).toEqual({ ok: true, list: { title: null, tasks: [task] } })
      expect(normalizeTaskList({ tasks: [task] })).toEqual({ ok: true, list: { title: null, tasks: [task] } })
      expect(normalizeTaskList({ title: 'x'.repeat(150), tasks: [task] })).toEqual({
        ok: true,
        list: { title: 'x'.repeat(100), tasks: [task] }
      })
      expect(normalizeTaskList({ tasks: [{ title: 'y'.repeat(300), status: 'pending' }] })).toEqual({
        ok: true,
        list: { title: null, tasks: [{ title: 'y'.repeat(200), status: 'pending' }] }
      })
    })

    it('refuses more than 100 tasks', () => {
      const tasks = Array.from({ length: 101 }, (_, i) => ({ title: `T${i}`, status: 'pending' }))
      expect(normalizeTaskList({ tasks })).toEqual({ ok: false, error: 'A task list holds at most 100 tasks; got 101.' })
    })

    it('refuses a task without a title and a task with an unknown status', () => {
      expect(normalizeTaskList({ tasks: [{ title: 'A', status: 'completed' }, { title: '  ', status: 'pending' }] })).toEqual({
        ok: false,
        error: 'Task 2 has no title.'
      })
      expect(normalizeTaskList({ tasks: [{ title: 'A', status: 'blocked' }] })).toEqual({
        ok: false,
        error: 'Task 1: status must be pending, in_progress or completed.'
      })
    })

    it('refuses a value that is not an object with a tasks array', () => {
      for (const raw of ['text', [], { tasks: 'a' }]) {
        expect(normalizeTaskList(raw)).toEqual({ ok: false, error: 'The task list must be an object with a tasks array.' })
      }
    })

    it('checks the title type before it reads an empty list', () => {
      expect(normalizeTaskList({ title: 5, tasks: [] })).toEqual({ ok: false, error: 'The title must be a string.' })
    })
  })

  describe('taskListStatus', () => {
    it('numbers the tasks and marks them done, current or left', () => {
      expect(taskListStatus(threeTasks)).toEqual({
        title: 'Tasks',
        tasks: [
          { n: 1, title: 'A', state: 'done' },
          { n: 2, title: 'B', state: 'current' },
          { n: 3, title: 'C', state: 'left' }
        ],
        done: 1,
        total: 3,
        finished: false
      })
    })

    it('is finished when every task is done', () => {
      const status = taskListStatus({ title: 'Ship', tasks: [{ title: 'A', status: 'completed' }] })
      expect(status.title).toBe('Ship')
      expect(status.finished).toBe(true)
    })
  })

  describe('taskListSummary', () => {
    it('says how many tasks are done', () => {
      expect(taskListSummary(threeTasks)).toBe('Task list updated: 1 of 3 done.')
    })

    it('says the list was removed', () => {
      expect(taskListSummary(null)).toBe('Task list removed.')
    })
  })

  describe('describeTaskList', () => {
    it('says there is no list', () => {
      expect(describeTaskList(null)).toBe('No task list.')
    })

    it('lists the tasks with their statuses', () => {
      expect(
        describeTaskList({
          title: 'Release prep',
          tasks: [
            { title: 'A', status: 'completed' },
            { title: 'B', status: 'in_progress' }
          ]
        })
      ).toBe('Release prep: 1 of 2 done\n1. [completed] A\n2. [in_progress] B')
    })
  })
})
