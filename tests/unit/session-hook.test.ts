import { describe, expect, it, vi } from 'vitest'
import { WIN } from '../fixtures/platform'
import { askDecisionLine, hookMessage, permissionPrompt, questionPrompt, runSessionHook, runStatusLine, turnContextLine } from '../../src/hook/session-hook'
import { encodeMessage, type AttentionMessage, type PipeMessage, type PipeResponse } from '../../src/shared/protocol'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const TP = 'C:\\Users\\me\\.claude\\projects\\D--x\\5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8.jsonl'
// the hook checks the folder with the platform's isAbsolute: the sample is absolute where the tests run
const WORK = WIN ? 'D:\\x' : '/x'
const input = JSON.stringify({ session_id: SID, transcript_path: TP, cwd: WORK, hook_event_name: 'SessionStart', source: 'clear' })

describe('runSessionHook', () => {
  it('sends the session id and transcript path for the tab', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    expect(await runSessionHook(input, { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: '\\\\.\\pipe\\x' }, send)).toBe('')
    expect(send).toHaveBeenCalledWith('\\\\.\\pipe\\x', { v: 1, type: 'session', tabId: TAB, sessionId: SID, source: 'clear', transcriptPath: TP, cwd: WORK, remote: null })
  })

  it('passes the folder the session starts in, and none for a missing, relative or non-string one', async () => {
    const sent = async (cwd: unknown): Promise<unknown> => {
      const send = vi.fn(async () => ({ ok: true as const }))
      const text = JSON.stringify({ session_id: SID, transcript_path: TP, cwd, hook_event_name: 'SessionStart', source: 'resume' })
      await runSessionHook(text, { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: 'p' }, send)
      return (send.mock.calls[0] as unknown as [string, { cwd?: unknown }])[1].cwd
    }
    expect(await sent(WORK)).toBe(WORK)
    for (const bad of [undefined, 'rel/dir', '', 42, null, ['x']]) expect(await sent(bad)).toBeNull()
  })

  it('does nothing outside a ClaudeTerm tab', async () => {
    const send = vi.fn()
    expect(await runSessionHook(input, {}, send)).toBe('')
    expect(send).not.toHaveBeenCalled()
  })

  it('ignores bad stdin and non-UUID session ids', async () => {
    const send = vi.fn()
    expect(await runSessionHook('not json', { CLAUDETERM_TAB_ID: TAB }, send)).toBe('')
    expect(await runSessionHook(JSON.stringify({ session_id: 'x' }), { CLAUDETERM_TAB_ID: TAB }, send)).toBe('')
    expect(send).not.toHaveBeenCalled()
  })

  it('swallows send failures', async () => {
    const send = vi.fn(async () => { throw new Error('no pipe') })
    await expect(runSessionHook(input, { CLAUDETERM_TAB_ID: TAB }, send)).resolves.toBe('')
  })
})

const ENV = { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: '\\\\.\\pipe\\x' }
const AGENT = 'a40a10c1d655cf759'

describe('turnContextLine: the line a UserPromptSubmit hook prints for its turn', () => {
  const line = (info: string): string => `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: info } })}\n`
  const prompt = JSON.stringify({ session_id: SID, transcript_path: TP, cwd: WORK, hook_event_name: 'UserPromptSubmit', prompt: 'go on' })

  it('a valid instruction is the one JSON line with its additionalContext', () => {
    expect(turnContextLine({ ok: true, info: 'Note from ClaudeTerm.' })).toBe(line('Note from ClaudeTerm.'))
  })

  it('an empty instruction prints nothing, and so does a missing answer', () => {
    expect(turnContextLine({ ok: true, info: '' })).toBe('')
    expect(turnContextLine({ ok: true })).toBe('')
    expect(turnContextLine(null)).toBe('')
  })

  it('an answer that is not ok prints nothing, even with info in it', () => {
    expect(turnContextLine({ ok: false, error: 'unknown claude tab', info: 'Note from ClaudeTerm.' } as unknown as PipeResponse)).toBe('')
  })

  it('2000 characters are printed, 2001 are not', () => {
    expect(turnContextLine({ ok: true, info: 'n'.repeat(2000) })).toBe(line('n'.repeat(2000)))
    expect(turnContextLine({ ok: true, info: 'n'.repeat(2001) })).toBe('')
  })

  it('a non-UserPromptSubmit event prints nothing, even when its answer carries info', async () => {
    const send = vi.fn(async () => ({ ok: true as const, info: 'Note from ClaudeTerm.' }))
    expect(await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'Stop', stop_hook_active: false }), ENV, send)).toBe('')
    expect(await runSessionHook(prompt, ENV, send)).toBe(line('Note from ClaudeTerm.'))
  })
})

describe('askDecisionLine and the AskUserQuestion decision', () => {
  const line = (reason: string): string => `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`
  const browser = { question: 'Where should the browser live?', header: 'Browser', multiSelect: false, options: [{ label: 'Own tab', description: 'A tab of its own' }, { label: 'Side panel', description: 'Beside the chat' }] }
  const colour = { question: 'Which colour?', header: 'Colour', multiSelect: true, options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }] }
  const ask = { session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [browser, colour] } }

  it('the question\'s attention carries the whole questions, and the first question\'s line as its prompt', () => {
    expect(hookMessage(ask, TAB)).toEqual({ v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'question', prompt: 'Where should the browser live?', questions: [browser, colour] })
  })

  it('questions out of bounds are left out; the attention still goes with its prompt', () => {
    const five = { ...ask, tool_input: { questions: Array.from({ length: 5 }, (_, i) => ({ ...browser, question: `Question ${i}?` })) } }
    const msg = hookMessage(five, TAB)
    expect(msg).toEqual({ v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'question', prompt: 'Question 0?' })
    expect(msg).not.toHaveProperty('questions')
  })

  it('askDecisionLine: an answer with info is the deny line; none, an error, an empty info or one of 2001 characters is \'\'', () => {
    expect(askDecisionLine({ ok: true, info: 'Ask later.' })).toBe(line('Ask later.'))
    expect(askDecisionLine({ ok: true, info: 'n'.repeat(2000) })).toBe(line('n'.repeat(2000)))
    expect(askDecisionLine({ ok: true, info: '' })).toBe('')
    expect(askDecisionLine({ ok: true, info: 'n'.repeat(2001) })).toBe('')
    expect(askDecisionLine({ ok: true })).toBe('')
    expect(askDecisionLine(null)).toBe('')
    expect(askDecisionLine({ ok: false, error: 'unknown claude tab', info: 'Ask later.' } as unknown as PipeResponse)).toBe('')
  })

  it('runSessionHook prints the decision for AskUserQuestion\'s PreToolUse when main\'s answer has info, and nothing for a Stop whose answer has info', async () => {
    const send = vi.fn(async () => ({ ok: true as const, info: 'Ask later.' }))
    expect(await runSessionHook(JSON.stringify(ask), ENV, send)).toBe(line('Ask later.'))
    expect(send).toHaveBeenCalledWith('\\\\.\\pipe\\x', { v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'question', prompt: 'Where should the browser live?', questions: [browser, colour], remote: null })
    expect(await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'Stop', stop_hook_active: false }), ENV, send)).toBe('')
  })
})

describe('hookMessage: the head of a turn\'s prompt', () => {
  const turn = (extra: object) => hookMessage({ session_id: SID, hook_event_name: 'UserPromptSubmit', ...extra }, TAB)

  it('the turn carries the head of its prompt, cut to 300 characters', () => {
    expect(turn({ prompt: 'go on' })).toEqual({ v: 1, type: 'turn', tabId: TAB, sessionId: SID, prompt: 'go on' })
    expect(turn({ prompt: 'p'.repeat(301) })).toEqual({ v: 1, type: 'turn', tabId: TAB, sessionId: SID, prompt: 'p'.repeat(300) })
  })

  it('the turn carries no prompt when it is missing, empty or not text', () => {
    for (const extra of [{}, { prompt: '' }, { prompt: 7 }]) expect(turn(extra)).not.toHaveProperty('prompt')
  })
})

describe('runSessionHook: other hook events', () => {
  it('maps SubagentStart and SubagentStop to subagent messages', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'SubagentStart', agent_id: AGENT, agent_type: 'Explore' }), ENV, send)
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'SubagentStop', agent_id: AGENT, agent_type: 'Explore', effort: 'high' }), ENV, send)
    expect(send).toHaveBeenNthCalledWith(1, '\\\\.\\pipe\\x', { v: 1, type: 'subagent', tabId: TAB, sessionId: SID, event: 'start', agentId: AGENT, agentType: 'Explore' })
    expect(send).toHaveBeenNthCalledWith(2, '\\\\.\\pipe\\x', { v: 1, type: 'subagent', tabId: TAB, sessionId: SID, event: 'stop', agentId: AGENT, agentType: 'Explore' })
  })

  it('maps SessionEnd to session_end', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    expect(await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'SessionEnd', reason: 'clear' }), ENV, send)).toBe('')
    expect(send).toHaveBeenCalledWith('\\\\.\\pipe\\x', { v: 1, type: 'session_end', tabId: TAB, sessionId: SID })
  })

  it('maps a permission prompt, AskUserQuestion and Stop to attention messages', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'mkdir x' } }), ENV, send)
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: {} }), ENV, send)
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'Stop', stop_hook_active: false }), ENV, send)
    const attention = (reason: string) => ({ v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason, remote: null })
    expect(send).toHaveBeenNthCalledWith(1, '\\\\.\\pipe\\x', { ...attention('permission'), prompt: 'Allow Bash: mkdir x' })
    expect(send).toHaveBeenNthCalledWith(2, '\\\\.\\pipe\\x', attention('question'))
    expect(send).toHaveBeenNthCalledWith(3, '\\\\.\\pipe\\x', attention('done'))
  })

  it('reports a question once, as a question: the permission dialog Claude Code opens for AskUserQuestion is no permission prompt', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    // what Claude Code sends for one question, a second apart: PreToolUse, then PermissionRequest for the same tool
    const ask = { session_id: SID, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which colour?', options: [] }] } }
    await runSessionHook(JSON.stringify({ ...ask, hook_event_name: 'PreToolUse' }), ENV, send)
    await runSessionHook(JSON.stringify({ ...ask, hook_event_name: 'PermissionRequest' }), ENV, send)
    expect(send.mock.calls.map((c) => (c as unknown[])[1])).toEqual([{ v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'question', prompt: 'Which colour?', remote: null }])
  })

  it('marks a Stop with background work still in flight and lists it; an empty background_tasks lists none; a missing one says nothing of it', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    const task = { id: 'bmv6531d6', type: 'shell', status: 'running', description: 'build', command: 'make' }
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [task], session_crons: [] }), ENV, send)
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [], session_crons: [] }), ENV, send)
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'Stop', stop_hook_active: false }), ENV, send)
    const done = { v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'done', remote: null }
    expect(send).toHaveBeenNthCalledWith(1, '\\\\.\\pipe\\x', { ...done, background: true, tasks: [{ id: 'bmv6531d6', type: 'shell', description: 'build', command: 'make' }] })
    expect(send).toHaveBeenNthCalledWith(2, '\\\\.\\pipe\\x', { ...done, tasks: [] })
    expect(send).toHaveBeenNthCalledWith(3, '\\\\.\\pipe\\x', done)
  })

  it('lists a background task without a description or command with null for them, and leaves out one without an id', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    const tasks = [{ id: 'm1', type: 'monitor', status: 'running' }, { type: 'shell', command: 'make' }, 'junk']
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'Stop', background_tasks: tasks }), ENV, send)
    expect(send).toHaveBeenCalledWith('\\\\.\\pipe\\x', { v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'done', background: true, tasks: [{ id: 'm1', type: 'monitor', description: null, command: null }], remote: null })
  })

  it('a Stop with 80 background tasks of 5000-character commands keeps 50 tasks of at most 300 characters, and its line stays under the pipe limit', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    const tasks = Array.from({ length: 80 }, (_, i) => ({ id: `bg${i}`, type: 'shell', status: 'running', description: 'build', command: 'c'.repeat(5000) }))
    expect(await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'Stop', background_tasks: tasks }), ENV, send)).toBe('')
    const msg = (send.mock.calls[0] as unknown as [string, AttentionMessage])[1]
    expect(msg.tasks).toHaveLength(50)
    expect(Math.max(...msg.tasks!.map((t) => t.command!.length))).toBeLessThanOrEqual(300)
    expect(encodeMessage(msg).length).toBeLessThan(64 * 1024)
  })

  it('a scheduled wakeup alone is no background work', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    const cron = { id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: '/loop check' }
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'Stop', stop_hook_active: false, background_tasks: [], session_crons: [cron] }), ENV, send)
    expect(send).toHaveBeenCalledWith('\\\\.\\pipe\\x', { v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'done', tasks: [], remote: null })
  })

  it('maps StopFailure to the end of a turn with the error it ended in', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    const cutOff = 'API Error: Connection lost mid-response. The response above may be incomplete.'
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'StopFailure', error: 'server_error', last_assistant_message: cutOff }), ENV, send)
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'StopFailure' }), ENV, send)
    expect(send).toHaveBeenNthCalledWith(1, '\\\\.\\pipe\\x', { v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'done', error: 'server_error', remote: null })
    expect(send).toHaveBeenNthCalledWith(2, '\\\\.\\pipe\\x', { v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'done', error: 'unknown', remote: null })
  })

  it('ignores notifications and other tools', async () => {
    const send = vi.fn()
    expect(await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'Notification', notification_type: 'permission_prompt' }), ENV, send)).toBe('')
    expect(await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'Bash' }), ENV, send)).toBe('')
    expect(send).not.toHaveBeenCalled()
  })

  it('ignores other events and subagent events without agent_id', async () => {
    const send = vi.fn()
    expect(await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse' }), ENV, send)).toBe('')
    expect(await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'SubagentStart' }), ENV, send)).toBe('')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('runStatusLine', () => {
  const input = JSON.stringify({ session_id: SID, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } })

  it('sends the status for the tab', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    expect(await runStatusLine(input, ENV, send)).toBe(true)
    expect(send).toHaveBeenCalledWith('\\\\.\\pipe\\x', {
      v: 1, type: 'status', tabId: TAB, sessionId: SID,
      model: { id: 'claude-opus-5-5', displayName: 'Opus 5.5' }, effort: null, context: null, fiveHour: null, sevenDay: null, remote: null
    })
  })

  it('does nothing outside a tab or for bad stdin, and swallows send failures', async () => {
    const send = vi.fn()
    expect(await runStatusLine(input, {}, send)).toBe(false)
    expect(await runStatusLine('not json', ENV, send)).toBe(false)
    expect(send).not.toHaveBeenCalled()
    await expect(runStatusLine(input, ENV, async () => { throw new Error('no pipe') })).resolves.toBe(false)
  })
})

describe('runSessionHook: a change of folder', () => {
  const OLD = process.platform === 'win32' ? 'D:\\proj' : '/proj'
  const NEW = process.platform === 'win32' ? 'D:\\other' : '/other'

  // a Bash cd only looks around; the session's own folder comes with the status line
  it('sends nothing for CwdChanged, from the conversation or a subagent', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    const changed = (extra: object): string => JSON.stringify({ session_id: SID, hook_event_name: 'CwdChanged', cwd: NEW, old_cwd: OLD, new_cwd: NEW, ...extra })
    await expect(runSessionHook(changed({}), ENV, send)).resolves.toBe('')
    await expect(runSessionHook(changed({ agent_id: AGENT }), ENV, send)).resolves.toBe('')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('runSessionHook: review events', () => {
  const CWD = process.platform === 'win32' ? 'D:\\proj' : '/proj'
  const ABS = process.platform === 'win32' ? 'D:\\proj\\src\\a.ts' : '/proj/src/a.ts'

  it('maps UserPromptSubmit to a turn, without the folder Claude\'s shell is in', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'UserPromptSubmit', prompt: 'fix it', cwd: CWD }), ENV, send)
    expect(send).toHaveBeenCalledWith('\\\\.\\pipe\\x', { v: 1, type: 'turn', tabId: TAB, sessionId: SID, prompt: 'fix it', remote: null })
  })

  it('maps PreToolUse of Edit, Write, MultiEdit and NotebookEdit to edit_before', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    const pre = (tool_name: string, tool_input: object, tool_use_id = 'toolu_1') =>
      runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id, cwd: CWD }), ENV, send)
    await pre('Edit', { file_path: ABS, old_string: 'a', new_string: 'b' })
    await pre('Write', { file_path: 'src/a.ts', content: 'x' }, 'toolu_2')
    await pre('MultiEdit', { file_path: ABS, edits: [] }, 'toolu_3')
    await pre('NotebookEdit', { notebook_path: ABS, new_source: '' }, 'toolu_4')
    const msg = (toolUseId: string) => ({ v: 1, type: 'edit_before', tabId: TAB, sessionId: SID, toolUseId, path: ABS })
    expect(send).toHaveBeenNthCalledWith(1, '\\\\.\\pipe\\x', msg('toolu_1'))
    expect(send).toHaveBeenNthCalledWith(2, '\\\\.\\pipe\\x', msg('toolu_2'))
    expect(send).toHaveBeenNthCalledWith(3, '\\\\.\\pipe\\x', msg('toolu_3'))
    expect(send).toHaveBeenNthCalledWith(4, '\\\\.\\pipe\\x', msg('toolu_4'))
  })

  it('ignores PreToolUse of other tools and edits without a path or a tool use id', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't' }), ENV, send)
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {}, tool_use_id: 't' }), ENV, send)
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: ABS } }), ENV, send)
    expect(send).not.toHaveBeenCalled()
  })

  it('puts the subagent id on a permission prompt from a subagent', async () => {
    const send = vi.fn(async () => ({ ok: true as const }))
    await runSessionHook(JSON.stringify({ session_id: SID, hook_event_name: 'PermissionRequest', tool_name: 'Bash', agent_id: AGENT }), ENV, send)
    expect(send).toHaveBeenCalledWith('\\\\.\\pipe\\x', { v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'permission', agentId: AGENT, prompt: 'Allow Bash', remote: null })
  })
})

describe('hookMessage: the last answer and the prompt line', () => {
  it('Stop passes the last answer, cut to 8000 characters; StopFailure passes none', () => {
    expect(hookMessage({ session_id: SID, hook_event_name: 'Stop', last_assistant_message: 'Done.' }, TAB))
      .toEqual({ v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'done', lastMessage: 'Done.' })
    expect((hookMessage({ session_id: SID, hook_event_name: 'Stop', last_assistant_message: 'x'.repeat(9000) }, TAB) as AttentionMessage).lastMessage).toHaveLength(8000)
    expect(hookMessage({ session_id: SID, hook_event_name: 'StopFailure', error: 'server_error', last_assistant_message: 'API Error' }, TAB))
      .toEqual({ v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'done', error: 'server_error' })
  })

  it('a permission prompt names the tool and what it runs or touches', () => {
    const p = (tool_name: string, tool_input: object) => (hookMessage({ session_id: SID, hook_event_name: 'PermissionRequest', tool_name, tool_input }, TAB) as AttentionMessage).prompt
    expect(p('Bash', { command: 'python tools/fetch_net.py --env prod' })).toBe('Allow Bash: python tools/fetch_net.py --env prod')
    expect(p('Edit', { file_path: '/w/a.ts' })).toBe('Allow Edit: /w/a.ts')
    expect(p('mcp__acme__deploy', {})).toBe('Allow mcp__acme__deploy')
  })

  it('a question is its first question, on one line of at most 200 characters', () => {
    const q = hookMessage({ session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which\nbranch?' }] } }, TAB)
    expect(q).toEqual({ v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'question', prompt: 'Which branch?' })
    expect(questionPrompt({ questions: [{ question: 'y'.repeat(300) }] })).toBe(`${'y'.repeat(199)}…`)
  })

  it('the prompt helpers give null for input they cannot read, and a blank detail is no detail', () => {
    expect(permissionPrompt(undefined, {})).toBeNull()
    expect(permissionPrompt('Bash', { command: '  \n ' })).toBe('Allow Bash')
    expect(permissionPrompt('Bash', { command: 42, description: 'run tests' })).toBe('Allow Bash: run tests')
    expect(questionPrompt({ questions: [] })).toBeNull()
    expect(questionPrompt({ questions: [{ question: 7 }] })).toBeNull()
    expect(questionPrompt(null)).toBeNull()
  })

  it('a Stop whose answer would overflow the pipe line keeps its end and drops the answer', () => {
    // 8000 control characters encode to 48000 characters of JSON; 50 background tasks of 300 characters add 15000 more
    const tasks = Array.from({ length: 50 }, (_, i) => ({ id: `bg${i}`, type: 'shell', status: 'running', description: 'build', command: 'c'.repeat(300) }))
    const msg = hookMessage({ session_id: SID, hook_event_name: 'Stop', last_assistant_message: '\u0001'.repeat(8000), background_tasks: tasks }, TAB)
    expect(msg).toMatchObject({ v: 1, type: 'attention', tabId: TAB, sessionId: SID, reason: 'done', background: true })
    expect(msg).not.toHaveProperty('lastMessage')
    expect((msg as AttentionMessage).tasks).toHaveLength(50)
  })
})

describe('the Remote Control id', () => {
  const ID = 'session_011edtAbC'
  const sentBy = async (input: object, env: Record<string, string>, statusLine = false): Promise<PipeMessage[]> => {
    const sent: PipeMessage[] = []
    const send = async (_pipe: string, msg: PipeMessage): Promise<PipeResponse> => { sent.push(msg); return { ok: true } }
    const full = { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: 'p', ...env }
    if (statusLine) await runStatusLine(JSON.stringify(input), full, send)
    else await runSessionHook(JSON.stringify(input), full, send)
    return sent
  }
  const events = [
    { session_id: SID, hook_event_name: 'SessionStart', source: 'startup' },
    { session_id: SID, hook_event_name: 'UserPromptSubmit' },
    { session_id: SID, hook_event_name: 'Stop' },
    { session_id: SID, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } }
  ]
  it('SessionStart, UserPromptSubmit, Stop and a permission request carry CLAUDE_CODE_BRIDGE_SESSION_ID as remote', async () => {
    for (const e of events) expect((await sentBy(e, { CLAUDE_CODE_BRIDGE_SESSION_ID: ID }))[0]).toMatchObject({ remote: ID })
  })
  it('without the variable, or with a value that is no id, they carry null', async () => {
    for (const e of events) {
      expect((await sentBy(e, {}))[0]).toMatchObject({ remote: null })
      expect((await sentBy(e, { CLAUDE_CODE_BRIDGE_SESSION_ID: 'not an id' }))[0]).toMatchObject({ remote: null })
    }
  })
  it('a subagent start, a session end and an edit carry no remote field', async () => {
    const file = WIN ? 'C:\\w\\a.ts' : '/w/a.ts'
    for (const e of [
      { session_id: SID, hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' },
      { session_id: SID, hook_event_name: 'SessionEnd' },
      { session_id: SID, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'toolu_1', tool_input: { file_path: file } }
    ]) expect('remote' in (await sentBy(e, { CLAUDE_CODE_BRIDGE_SESSION_ID: ID }))[0]).toBe(false)
  })
  it('the statusLine carries it too', async () => {
    const input = { session_id: SID, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' } }
    expect((await sentBy(input, { CLAUDE_CODE_BRIDGE_SESSION_ID: ID }, true))[0]).toMatchObject({ type: 'status', remote: ID })
    expect((await sentBy(input, {}, true))[0]).toMatchObject({ type: 'status', remote: null })
  })
})
