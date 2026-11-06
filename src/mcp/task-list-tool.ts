import { PipeUnavailableError } from '../shared/pipe-client'
import type { PipeResponse, TaskListGetMessage, TaskListMessage } from '../shared/protocol'
import { normalizeTaskList, type TaskStatus } from '../shared/task-list'
import type { ToolResult } from './show-image-tool'

export interface TaskListToolDeps {
  tabId: string | null
  pipeName: string
  send(pipeName: string, msg: TaskListMessage | TaskListGetMessage): Promise<PipeResponse>
}

export async function handleSetTaskList(input: { title?: string; tasks: { title: string; status: TaskStatus }[] }, deps: TaskListToolDeps): Promise<ToolResult> {
  if (!deps.tabId) return { text: 'set_task_list works only in a ClaudeTerm Claude tab', isError: true }
  const checked = normalizeTaskList({ title: input.title, tasks: input.tasks })
  if (!checked.ok) return { text: checked.error, isError: true }
  const msg: TaskListMessage = { v: 1, type: 'task_list', tabId: deps.tabId, list: checked.list }
  let res: PipeResponse
  try {
    res = await deps.send(deps.pipeName, msg)
  } catch (e) {
    if (e instanceof PipeUnavailableError) return { text: 'ClaudeTerm is not running; the task list is not shown.', isError: false }
    return { text: `ClaudeTerm request failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }
  return res.ok ? { text: res.info ?? 'Task list updated.', isError: false } : { text: res.error, isError: true }
}

export async function handleGetTaskList(deps: TaskListToolDeps): Promise<ToolResult> {
  if (!deps.tabId) return { text: 'get_task_list works only in a ClaudeTerm Claude tab', isError: true }
  const msg: TaskListGetMessage = { v: 1, type: 'task_list_get', tabId: deps.tabId }
  let res: PipeResponse
  try {
    res = await deps.send(deps.pipeName, msg)
  } catch (e) {
    if (e instanceof PipeUnavailableError) return { text: 'ClaudeTerm is not running; there is no task list to read.', isError: false }
    return { text: `ClaudeTerm request failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }
  return res.ok ? { text: res.info ?? 'No task list.', isError: false } : { text: res.error, isError: true }
}
