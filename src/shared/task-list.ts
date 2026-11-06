import type { PlanStatus, PlanTask, PlanTaskState } from './types'

/** The state of one task of the list Claude keeps for the status bar. */
export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed']

export interface AgentTask {
  title: string
  status: TaskStatus
}

/** The list Claude keeps for a session; a list always has at least one task, and no list is `null`. */
export interface TaskList {
  title: string | null
  tasks: AgentTask[]
}

export const MAX_LIST_TASKS = 100
export const MAX_TASK_TITLE = 200
export const MAX_TASK_LIST_TITLE = 100
export const DEFAULT_TASK_LIST_TITLE = 'Tasks'

export type TaskListResult = { ok: true; list: TaskList | null } | { ok: false; error: string }

const fold = (text: string): string => text.replace(/[\s\p{Cc}]+/gu, ' ').trim()

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isTaskStatus = (value: unknown): value is TaskStatus => TASK_STATUSES.includes(value as TaskStatus)

/** Checks a list sent by Claude and cuts its texts to the limits; an empty list is no list. */
export function normalizeTaskList(raw: unknown): TaskListResult {
  if (raw === null) return { ok: true, list: null }
  if (!isObject(raw) || !Array.isArray(raw.tasks)) {
    return { ok: false, error: 'The task list must be an object with a tasks array.' }
  }
  if (raw.title !== undefined && raw.title !== null && typeof raw.title !== 'string') {
    return { ok: false, error: 'The title must be a string.' }
  }
  if (raw.tasks.length === 0) return { ok: true, list: null }
  if (raw.tasks.length > MAX_LIST_TASKS) {
    return { ok: false, error: `A task list holds at most ${MAX_LIST_TASKS} tasks; got ${raw.tasks.length}.` }
  }

  const tasks: AgentTask[] = []
  for (let i = 0; i < raw.tasks.length; i++) {
    const task = isObject(raw.tasks[i]) ? (raw.tasks[i] as Record<string, unknown>) : {}
    const number = i + 1
    const title = typeof task.title === 'string' ? fold(task.title) : ''
    if (!title) return { ok: false, error: `Task ${number} has no title.` }
    if (!isTaskStatus(task.status)) {
      return { ok: false, error: `Task ${number}: status must be pending, in_progress or completed.` }
    }
    tasks.push({ title: title.slice(0, MAX_TASK_TITLE), status: task.status })
  }

  const title = typeof raw.title === 'string' ? fold(raw.title).slice(0, MAX_TASK_LIST_TITLE) : ''
  return { ok: true, list: { title: title || null, tasks } }
}

const TASK_STATE: Record<TaskStatus, PlanTaskState> = { pending: 'left', in_progress: 'current', completed: 'done' }

/** The progress of a task list in the form the status bar draws, as a superpowers plan's progress. */
export function taskListStatus(list: TaskList): PlanStatus {
  const tasks: PlanTask[] = list.tasks.map((task, i) => ({ n: i + 1, title: task.title, state: TASK_STATE[task.status] }))
  const done = list.tasks.filter((task) => task.status === 'completed').length
  return {
    title: list.title ?? DEFAULT_TASK_LIST_TITLE,
    tasks,
    done,
    total: list.tasks.length,
    finished: done === list.tasks.length
  }
}

/** The line Claude gets back after it changes the list. */
export function taskListSummary(list: TaskList | null): string {
  if (!list) return 'Task list removed.'
  const done = list.tasks.filter((task) => task.status === 'completed').length
  return `Task list updated: ${done} of ${list.tasks.length} done.`
}

/** The list as text, for the tool's answer when Claude asks for it. */
export function describeTaskList(list: TaskList | null): string {
  if (!list) return 'No task list.'
  const done = list.tasks.filter((task) => task.status === 'completed').length
  const lines = list.tasks.map((task, i) => `${i + 1}. [${task.status}] ${task.title}`)
  return [`${list.title ?? DEFAULT_TASK_LIST_TITLE}: ${done} of ${list.tasks.length} done`, ...lines].join('\n')
}
