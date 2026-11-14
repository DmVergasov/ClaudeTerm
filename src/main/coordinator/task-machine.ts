import type { ReportOutcome } from '../../shared/mail'
import type { HandOver } from '../mail/mail-hub'
import type { StoredHosted, StoredTask } from './coordinator-store'

/** what happens to a task: handed to its session, its turn starts or ends, or it fails or is stopped */
export type TaskEvent =
  | { kind: 'handed'; into: HandOver; at: number }
  | { kind: 'turn' }
  | { kind: 'rest' }
  | { kind: 'failed'; reason: string }
  | { kind: 'stopped'; reason: string }

/** the task after the event, or the outcome it ends with */
export type TaskStep = { task: StoredTask } | { outcome: ReportOutcome; reason: string | null }

/** the task after the event, its outcome, or null when the event does not apply in its state */
export function stepTask(t: StoredTask, e: TaskEvent): TaskStep | null {
  switch (e.kind) {
    case 'handed':
      // a task is only ever given to an idle session, or written as a prompt; never into a running turn or the next one
      if (t.state !== 'queued') return null
      if (e.into === 'idle') return { task: { ...t, state: 'open', deliveredAt: e.at } }
      if (e.into === 'prompt') return { task: { ...t, state: 'delivered', deliveredAt: e.at } }
      return null
    case 'turn':
      return t.state === 'delivered' ? { task: { ...t, state: 'open' } } : null
    case 'rest':
      return t.state === 'open' ? { outcome: 'finished', reason: null } : null
    case 'failed':
      return { outcome: 'failed', reason: e.reason }
    case 'stopped':
      return t.state === 'queued' ? null : { outcome: 'stopped', reason: e.reason }
  }
}

/** the delivered or open task of a session, else null */
export function currentTask(h: StoredHosted): StoredTask | null {
  return h.tasks.find((t) => t.state !== 'queued') ?? null
}

/** the oldest queued task, when no task of the session is delivered or open; else null */
export function nextTask(h: StoredHosted): StoredTask | null {
  if (h.tasks.some((t) => t.state !== 'queued')) return null
  let oldest: StoredTask | null = null
  for (const t of h.tasks) if (!oldest || t.queuedAt < oldest.queuedAt) oldest = t
  return oldest
}
