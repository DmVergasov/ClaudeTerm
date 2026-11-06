import { describe, expect, it } from 'vitest'
import { handleGetTaskList, handleSetTaskList, type TaskListToolDeps } from '../../src/mcp/task-list-tool'
import { PipeUnavailableError } from '../../src/shared/pipe-client'
import type { PipeResponse, TaskListGetMessage, TaskListMessage } from '../../src/shared/protocol'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const deps = (send: TaskListToolDeps['send'], tabId: string | null = TAB): TaskListToolDeps => ({ tabId, pipeName: 'pipe', send })
const tasks = [
  { title: 'Write the spec', status: 'completed' as const },
  { title: 'Review it', status: 'pending' as const }
]

describe('handleSetTaskList', () => {
  it('needs a ClaudeTerm Claude tab and sends nothing', async () => {
    const send = async (): Promise<PipeResponse> => {
      throw new Error('must not be called')
    }
    expect(await handleSetTaskList({ tasks }, deps(send, null))).toEqual({ text: 'set_task_list works only in a ClaudeTerm Claude tab', isError: true })
  })

  it('sends the normalized list and answers what ClaudeTerm says', async () => {
    const sent: TaskListMessage[] = []
    const r = await handleSetTaskList({ title: '  Release prep  ', tasks }, deps(async (_p, m) => {
      sent.push(m as TaskListMessage)
      return { ok: true, info: 'Task list updated: 1 of 2 done.' }
    }))
    expect(sent).toEqual([{ v: 1, type: 'task_list', tabId: TAB, list: { title: 'Release prep', tasks } }])
    expect(r).toEqual({ text: 'Task list updated: 1 of 2 done.', isError: false })
  })

  it('sends a list without a title as a null title', async () => {
    const sent: TaskListMessage[] = []
    await handleSetTaskList({ tasks }, deps(async (_p, m) => {
      sent.push(m as TaskListMessage)
      return { ok: true }
    }))
    expect(sent[0]!.list).toEqual({ title: null, tasks })
  })

  it('sends an empty list as no list', async () => {
    const sent: TaskListMessage[] = []
    await handleSetTaskList({ tasks: [] }, deps(async (_p, m) => {
      sent.push(m as TaskListMessage)
      return { ok: true }
    }))
    expect(sent[0]!.list).toBeNull()
  })

  it('refuses a list of more than 100 tasks without sending it', async () => {
    const send = async (): Promise<PipeResponse> => {
      throw new Error('must not be called')
    }
    const many = Array.from({ length: 101 }, (_, i) => ({ title: `T${i}`, status: 'pending' as const }))
    expect(await handleSetTaskList({ tasks: many }, deps(send))).toEqual({ text: 'A task list holds at most 100 tasks; got 101.', isError: true })
  })

  it('says the list is not shown when ClaudeTerm is not running', async () => {
    const r = await handleSetTaskList({ tasks }, deps(async () => { throw new PipeUnavailableError('x') }))
    expect(r).toEqual({ text: 'ClaudeTerm is not running; the task list is not shown.', isError: false })
  })

  it('passes on a refusal of ClaudeTerm as an error', async () => {
    const r = await handleSetTaskList({ tasks }, deps(async () => ({ ok: false as const, error: 'x' })))
    expect(r).toEqual({ text: 'x', isError: true })
  })

  it('reports another failure of the request as an error', async () => {
    const r = await handleSetTaskList({ tasks }, deps(async () => { throw new Error('boom') }))
    expect(r).toEqual({ text: 'ClaudeTerm request failed: boom', isError: true })
  })
})

describe('handleGetTaskList', () => {
  it('needs a ClaudeTerm Claude tab and sends nothing', async () => {
    const send = async (): Promise<PipeResponse> => {
      throw new Error('must not be called')
    }
    expect(await handleGetTaskList(deps(send, null))).toEqual({ text: 'get_task_list works only in a ClaudeTerm Claude tab', isError: true })
  })

  it('asks ClaudeTerm for the list and answers what it says', async () => {
    const sent: TaskListGetMessage[] = []
    const r = await handleGetTaskList(deps(async (_p, m) => {
      sent.push(m as TaskListGetMessage)
      return { ok: true, info: 'Release prep: 1 of 2 done\n1. [completed] Write the spec\n2. [pending] Review it' }
    }))
    expect(sent).toEqual([{ v: 1, type: 'task_list_get', tabId: TAB }])
    expect(r).toEqual({ text: 'Release prep: 1 of 2 done\n1. [completed] Write the spec\n2. [pending] Review it', isError: false })
  })

  it('says there is no list to read when ClaudeTerm is not running', async () => {
    const r = await handleGetTaskList(deps(async () => { throw new PipeUnavailableError('x') }))
    expect(r).toEqual({ text: 'ClaudeTerm is not running; there is no task list to read.', isError: false })
  })

  it('passes on a refusal of ClaudeTerm as an error', async () => {
    const r = await handleGetTaskList(deps(async () => ({ ok: false as const, error: 'x' })))
    expect(r).toEqual({ text: 'x', isError: true })
  })
})
