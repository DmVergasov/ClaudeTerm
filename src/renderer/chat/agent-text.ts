import { agentDuration, type ChatAgentInfo, type ChatToolCall, type ForwardState, isAgentId } from '../../shared/chat'

// The texts of the agent page, as pure functions: a test reads them without the page

/** the state of an agent as its header says it: the state, and how long it has run (or ran, once it ended); no length while it is not known */
export function agentStateText(a: ChatAgentInfo, now: number): string {
  if (a.state === 'stopped') return 'Stopped'
  const label = a.state === 'running' ? 'Running' : a.state === 'done' ? 'Done' : 'Failed'
  const ms = a.state === 'running' ? (a.startedAt === null ? null : now - a.startedAt) : a.ms
  return ms === null ? label : `${label} · ${agentDuration(ms)}`
}

/** the column of an agent that has no item yet, while it runs */
export const EMPTY_RUNNING = 'Nothing yet — the agent has just started'
/** the column of an agent whose conversation was not saved (its transcript is gone) */
export const EMPTY_LOST = "This agent's conversation was not saved"

/** the line under the page's composer: a message is sent through Claude, and it takes a turn of the main conversation */
export const WRITE_HINT = 'Claude forwards it with SendMessage · uses a turn of the main conversation'
/** the composer's line for a stopped agent: it may not come back when a message is sent to it */
export const STOPPED_HINT = 'You stopped this agent: Claude may not be able to resume it'
/** the composer's line when the chat has exited: nothing can be sent to the agent */
export const OFF_EXITED = 'Claude Code is not running in this tab'
/** the composer's line on a member's device: the host's agents are read, not written */
export const OFF_MEMBER = 'Read-only on this device'
/** the refusal under the message box when the send does not reach the chat (main refused it, or the window's send failed) */
export const NOT_REACHED = 'Not sent: it could not reach Claude Code'

/** a forward's mark under its bubble or note: how it goes through Claude, and why it did not go when it did not */
export function forwardMark(state: ForwardState, reason: string | null): string {
  switch (state) {
    case 'queued': return 'via Claude · Queued'
    case 'sending': return 'via Claude · Sending…'
    case 'delivered': return 'via Claude · Delivered'
    case 'failed': return reason ? `via Claude · Not delivered: ${reason}` : 'via Claude · Not delivered'
    case 'skipped': return reason ? `via Claude · Not delivered: ${reason}` : 'via Claude · Claude did not forward it'
  }
}

/** the agent a call's row opens: its first agent, when its id is a valid agent id (a pushed id is checked before it is a key or an argument); null otherwise */
export function rowAgent(call: ChatToolCall): string | null {
  const id = call.agents[0]?.id
  return isAgentId(id) ? id : null
}
