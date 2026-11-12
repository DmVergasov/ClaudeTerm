import { describe, expect, it } from 'vitest'
import { ChatModel } from '../../src/main/chat/chat-model'
import type { ChatCard } from '../../src/shared/chat'

// The working line says "Working" after Claude Code has finished: each test feeds the model what the SDK hands the chat in
// one such case and expects the turn to be over at the end. The SDK reads Claude Code's session_state_changed frames itself
// (sdk_host_only: true) and never yields them, so no idle frame of Claude Code's comes to end a turn the model left running.

/** a model with a clock the test moves, sequential ids and the work folder /work/acme */
function model(): { m: ChatModel; clock: { t: number } } {
  const clock = { t: 0 }
  let n = 0
  const m = new ChatModel({ now: () => clock.t, newId: () => `id${++n}`, folder: () => '/work/acme' })
  return { m, clock }
}

const queued = (m: ChatModel, text: string): boolean => m.items().some(item => item.kind === 'user' && item.text === text && item.queued)

const card: ChatCard = {
  type: 'permission', tool: 'Bash', title: 'Run a command', subject: 'npm run lint', description: null, diff: null, suggestions: [], defaultToNo: false,
}

/** a typed prompt starts the turn: its first stream event and its first assistant message name it, as Claude Code stamps a typed turn */
function startTypedTurn(m: ChatModel, text: string, uuid: string): void {
  m.userSent({ text, attachments: [] }, uuid)
  m.apply({ type: 'stream_event', user_message_uuid: uuid, user_message_uuids: [uuid], parent_tool_use_id: null, event: { type: 'message_start' } })
  m.apply({
    type: 'assistant', user_message_uuid: uuid, user_message_uuids: [uuid], parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_test', name: 'Bash', input: { command: 'npm test' } }] },
  })
}

/** the tool round ends and Claude answers: frames of a typed turn after its first ones carry no uuid */
function finishToolRound(m: ChatModel, answer: string): void {
  m.apply({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_test', content: 'all tests pass' }] } })
  m.apply({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start' } })
  m.apply({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: answer }] } })
}

/** a turn that starts a background agent: the Agent call returns at once, the agent runs on after the turn's result */
function startBackgroundAgent(m: ChatModel): void {
  m.userSent({ text: 'audit the docs in the background', attachments: [] }, 'u-audit')
  m.apply({
    type: 'assistant', user_message_uuid: 'u-audit', user_message_uuids: ['u-audit'], parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'Audit the docs', prompt: 'audit', subagent_type: 'general-purpose', run_in_background: true } }] },
  })
  m.apply({ type: 'system', subtype: 'task_started', task_id: 'task_audit', tool_use_id: 'toolu_agent', description: 'Audit the docs', subagent_type: 'general-purpose', task_type: 'local_agent' })
  m.apply({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_agent', content: 'Async agent launched successfully.' }] } })
}

const result = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'result', subtype: 'success', is_error: false, result: 'done', ...fields })

describe('the turn ends when Claude Code has finished', () => {
  it('a send Claude Code folds into the running turn ends with that turn, whose result names it', () => {
    const { m, clock } = model()
    clock.t = 100
    startTypedTurn(m, 'run the tests', 'u-tests')
    // the person writes while the tests run: the send waits behind the turn
    clock.t = 200
    m.userSent({ text: 'and check the docs too', attachments: [] }, 'u-docs')
    expect(queued(m, 'and check the docs too')).toBe(true)

    // Claude Code takes it into the running turn between two tool rounds; a typed turn stamps no later frame with its uuid,
    // so only the result names it, among the sends the turn consumed, and no send is left for another turn
    clock.t = 300
    finishToolRound(m, 'The tests pass, and the docs are up to date.')
    clock.t = 400
    m.apply(result({ user_message_uuid: 'u-tests', user_message_uuids: ['u-tests', 'u-docs'], queued_turn_count: 0 }))

    // nothing else comes: Claude Code is idle, and so is the chat
    expect(queued(m, 'and check the docs too')).toBe(false)
    expect(m.state()).toMatchObject({ turn: 'idle', turnStartedAt: null })
  })

  it('two sends folded into the running turn: Claude Code\'s own idle after the result does not end it either', () => {
    const { m } = model()
    startTypedTurn(m, 'run the tests', 'u-tests')
    m.userSent({ text: 'and check the docs too', attachments: [] }, 'u-docs')
    m.userSent({ text: 'and the changelog', attachments: [] }, 'u-log')

    finishToolRound(m, 'The tests pass; the docs and the changelog are up to date.')
    m.apply(result({ user_message_uuid: 'u-tests', user_message_uuids: ['u-tests', 'u-docs', 'u-log'], queued_turn_count: 0 }))
    // the frame the SDK keeps to itself, here as if it came: the session has nothing left to run
    m.apply({ type: 'system', subtype: 'session_state_changed', state: 'idle', sdk_host_only: true })

    expect(m.state()).toMatchObject({ turn: 'idle', turnStartedAt: null })
    expect([queued(m, 'and check the docs too'), queued(m, 'and the changelog')]).toEqual([false, false])
  })

  it('a send still on its way when a result says no turn follows: it stays queued, and its own turn draws one bubble', () => {
    const { m } = model()
    startTypedTurn(m, 'run the tests', 'u-tests')
    m.userSent({ text: 'and check the docs too', attachments: [] }, 'u-docs')
    finishToolRound(m, 'The tests pass, and the docs are up to date.')
    // a send the person writes just before the result: Claude Code has not taken it, and the result does not name it
    m.userSent({ text: 'and one more thing', attachments: [] }, 'u-late')
    m.apply(result({ user_message_uuid: 'u-tests', user_message_uuids: ['u-tests', 'u-docs'], queued_turn_count: 0 }))

    // the turn is over; the folded send left the queue, the unnamed one still waits for its own turn
    expect(m.state()).toMatchObject({ turn: 'idle', turnStartedAt: null })
    expect([queued(m, 'and check the docs too'), queued(m, 'and one more thing')]).toEqual([false, true])

    // Claude Code runs that send as its own turn: its echo is the bubble the chat already drew, and the turn takes it from the queue
    m.apply({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'and one more thing' } })
    m.apply({ type: 'stream_event', user_message_uuid: 'u-late', user_message_uuids: ['u-late'], parent_tool_use_id: null, event: { type: 'message_start' } })
    m.apply({ type: 'assistant', user_message_uuid: 'u-late', user_message_uuids: ['u-late'], parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'One more thing, done.' }] } })

    expect(m.items().filter(item => item.kind === 'user' && item.text === 'and one more thing')).toHaveLength(1)
    expect(queued(m, 'and one more thing')).toBe(false)
  })

  it('a card a background agent opens after the turn\'s result: once answered, the chat is idle again', () => {
    const { m } = model()
    startBackgroundAgent(m)
    m.apply({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'The audit runs in the background.' }] } })
    m.apply(result())
    expect(m.state().turn).toBe('idle')

    // the agent, still running on its own, asks to run a command: the chat waits for the person
    m.cardOpened('card-agent', card)
    expect(m.state().turn).toBe('waiting')
    // the person allows it: the agent goes on in the background, as it did before it asked, and no turn of the chat runs
    m.cardAnswered('card-agent', 'Allowed')
    expect(m.state()).toMatchObject({ turn: 'idle', turnStartedAt: null })
  })

  it('a background agent\'s card still open at the turn\'s result: answering it after the result leaves the chat idle', () => {
    const { m } = model()
    startBackgroundAgent(m)
    // the agent asks while the main turn is still writing its answer
    m.cardOpened('card-agent', card)
    m.apply({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'The audit runs in the background.' }] } })
    m.apply(result())

    m.cardAnswered('card-agent', 'Allowed')
    expect(m.state()).toMatchObject({ turn: 'idle', turnStartedAt: null })
  })
})
