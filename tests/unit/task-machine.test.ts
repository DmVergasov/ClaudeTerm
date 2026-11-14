import { describe, expect, it } from 'vitest'
import { currentTask, nextTask, stepTask, type TaskEvent } from '../../src/main/coordinator/task-machine'
import type { StoredHosted, StoredTask } from '../../src/main/coordinator/coordinator-store'

const ID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const ID2 = '4a2d3c5b-6e7f-4081-9b0c-1d2e3f4a5b6c'
const ID3 = '5b3e4d6c-7f80-4192-8c1d-2e3f4a5b6c7d'
const COORD = { device: null, session: '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e', name: 'Coordinator' }
const q: StoredTask = { id: ID, from: COORD, state: 'queued', queuedAt: 1, deliveredAt: null }

describe('task machine', () => {
  it('a queued task handed to a watcher is open; one written as a prompt is delivered', () => {
    expect(stepTask(q, { kind: 'handed', into: 'idle', at: 5 })).toEqual({ task: { ...q, state: 'open', deliveredAt: 5 } })
    expect(stepTask(q, { kind: 'handed', into: 'prompt', at: 5 })).toEqual({ task: { ...q, state: 'delivered', deliveredAt: 5 } })
  })

  it('a task is never handed into a running turn or the next one', () => {
    const d = { ...q, state: 'delivered' as const, deliveredAt: 5 }
    const o = { ...q, state: 'open' as const, deliveredAt: 5 }
    for (const t of [q, d, o]) {
      expect(stepTask(t, { kind: 'handed', into: 'running', at: 9 })).toBeNull()
      expect(stepTask(t, { kind: 'handed', into: 'next', at: 9 })).toBeNull()
    }
  })

  it('a delivered task opens with its turn; turn, rest and stop do not apply to a queued one', () => {
    const d = { ...q, state: 'delivered' as const, deliveredAt: 5 }
    expect(stepTask(d, { kind: 'turn' })).toEqual({ task: { ...d, state: 'open' } })
    for (const e of [{ kind: 'turn' }, { kind: 'rest' }, { kind: 'stopped', reason: 'its turn was interrupted' }] as TaskEvent[]) expect(stepTask(q, e)).toBeNull()
  })

  it('rest on a delivered task is null: the prompt has not started a turn yet', () => {
    const d = { ...q, state: 'delivered' as const, deliveredAt: 5 }
    expect(stepTask(d, { kind: 'rest' })).toBeNull()
  })

  it('rest finishes, failed fails in any state, stopped stops a delivered or open task', () => {
    const o = { ...q, state: 'open' as const, deliveredAt: 5 }
    expect(stepTask(o, { kind: 'rest' })).toEqual({ outcome: 'finished', reason: null })
    expect(stepTask(q, { kind: 'failed', reason: 'its tab was closed' })).toEqual({ outcome: 'failed', reason: 'its tab was closed' })
    expect(stepTask(o, { kind: 'stopped', reason: 'its turn was interrupted' })).toEqual({ outcome: 'stopped', reason: 'its turn was interrupted' })
    expect(stepTask(o, { kind: 'handed', into: 'idle', at: 9 })).toBeNull()
  })

  it('nextTask is the oldest queued task while none is delivered or open', () => {
    const newer: StoredTask = { ...q, id: ID2, queuedAt: 9 }
    const h = (tasks: StoredTask[]): StoredHosted => ({ session: COORD.session, coordinator: COORD, project: 'Ship', tasks })
    expect(nextTask(h([newer, q]))).toEqual(q)
    const open: StoredTask = { ...q, id: ID3, state: 'open', deliveredAt: 5 }
    expect(nextTask(h([newer, q, open]))).toBeNull()
    expect(currentTask(h([newer, q, open]))?.id).toBe(ID3)
    expect(currentTask(h([q]))).toBeNull()
  })
})
