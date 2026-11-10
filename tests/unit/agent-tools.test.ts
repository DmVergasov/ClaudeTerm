import { describe, expect, it } from 'vitest'
import { AGENT_INSTRUCTIONS, listAgents, messageAgent, type AgentToolDeps } from '../../src/mcp/agent-tools'
import { PipeUnavailableError } from '../../src/shared/pipe-client'
import type { AgentListMessage, AgentSendMessage, PipeResponse } from '../../src/shared/protocol'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const REPLY = '1b0e6d2a-7c3f-4e8b-9a51-0d4c2f6e8a73'
const deps = (send: AgentToolDeps['send'], tabId: string | null = TAB): AgentToolDeps => ({ tabId, pipeName: 'pipe', send })
const refuse = async (): Promise<PipeResponse> => {
  throw new Error('must not be called')
}

describe('listAgents', () => {
  it('sends agent_list with the tab id and returns the info as text', async () => {
    const sent: AgentListMessage[] = []
    const r = await listAgents(deps(async (_p, m) => {
      sent.push(m as AgentListMessage)
      return { ok: true, info: 'api-server · Desktop [3be5d1] · idle' }
    }))
    expect(sent).toEqual([{ v: 1, type: 'agent_list', tabId: TAB }])
    expect(r).toEqual({ text: 'api-server · Desktop [3be5d1] · idle', isError: false })
  })

  it('says there are no other agents when ClaudeTerm sends no info', async () => {
    expect(await listAgents(deps(async () => ({ ok: true })))).toEqual({ text: 'No other agents.', isError: false })
  })

  it('needs a ClaudeTerm Claude tab and sends nothing', async () => {
    expect(await listAgents(deps(refuse, null))).toEqual({ text: 'list_agents works only in a ClaudeTerm Claude tab', isError: true })
  })

  it('says ClaudeTerm is not running when the pipe is unavailable', async () => {
    const r = await listAgents(deps(async () => { throw new PipeUnavailableError('x') }))
    expect(r).toEqual({ text: 'ClaudeTerm is not running, so no agents can be listed.', isError: true })
  })

  it('passes on a refusal of ClaudeTerm as an error', async () => {
    expect(await listAgents(deps(async () => ({ ok: false as const, error: 'x' })))).toEqual({ text: 'x', isError: true })
  })

  it('reports another failure of the request as an error', async () => {
    expect(await listAgents(deps(async () => { throw new Error('boom') }))).toEqual({ text: 'ClaudeTerm request failed: boom', isError: true })
  })
})

describe('messageAgent', () => {
  it('sends agent_send and returns the reply line', async () => {
    const sent: AgentSendMessage[] = []
    const r = await messageAgent({ to: 'api-server', text: 'Hello' }, deps(async (_p, m) => {
      sent.push(m as AgentSendMessage)
      return { ok: true, info: 'Delivered to api-server · Desktop.' }
    }))
    expect(sent).toEqual([{ v: 1, type: 'agent_send', tabId: TAB, to: 'api-server', text: 'Hello', replyTo: null }])
    expect(r).toEqual({ text: 'Delivered to api-server · Desktop.', isError: false })
  })

  it('refuses an empty reply_to and sends nothing', async () => {
    expect(await messageAgent({ to: 'api-server', text: 'Hello', reply_to: '' }, deps(refuse))).toEqual({
      text: 'No message with id "".',
      isError: true
    })
  })

  it('says Sent. when ClaudeTerm sends no info', async () => {
    expect(await messageAgent({ to: 'api-server', text: 'Hello' }, deps(async () => ({ ok: true })))).toEqual({ text: 'Sent.', isError: false })
  })

  it('returns an error reply as an error', async () => {
    const r = await messageAgent({ to: 'api-server', text: 'Hello' }, deps(async () => ({ ok: false as const, error: 'api-server · Desktop is closed.' })))
    expect(r).toEqual({ text: 'api-server · Desktop is closed.', isError: true })
  })

  it('sends reply_to as replyTo', async () => {
    const sent: AgentSendMessage[] = []
    await messageAgent({ to: 'c5df49', text: 'Yes', reply_to: REPLY }, deps(async (_p, m) => {
      sent.push(m as AgentSendMessage)
      return { ok: true }
    }))
    expect(sent).toEqual([{ v: 1, type: 'agent_send', tabId: TAB, to: 'c5df49', text: 'Yes', replyTo: REPLY }])
  })

  it('sends to and text as given, not trimmed', async () => {
    const sent: AgentSendMessage[] = []
    await messageAgent({ to: ' api-server ', text: '  Hello\n' }, deps(async (_p, m) => {
      sent.push(m as AgentSendMessage)
      return { ok: true }
    }))
    expect(sent[0]).toMatchObject({ to: ' api-server ', text: '  Hello\n' })
  })

  it('needs a ClaudeTerm Claude tab and sends nothing', async () => {
    expect(await messageAgent({ to: 'api-server', text: 'Hello' }, deps(refuse, null)))
      .toEqual({ text: 'message_agent works only in a ClaudeTerm Claude tab', isError: true })
  })

  it('says the message was not sent when ClaudeTerm is not running', async () => {
    const r = await messageAgent({ to: 'api-server', text: 'Hello' }, deps(async () => { throw new PipeUnavailableError('x') }))
    expect(r).toEqual({ text: 'ClaudeTerm is not running, so the message was not sent.', isError: true })
  })

  it('reports another failure of the request as an error', async () => {
    expect(await messageAgent({ to: 'api-server', text: 'Hello' }, deps(async () => { throw new Error('boom') })))
      .toEqual({ text: 'ClaudeTerm request failed: boom', isError: true })
  })

  it('refuses an empty to without sending', async () => {
    expect(await messageAgent({ to: '   ', text: 'Hello' }, deps(refuse)))
      .toEqual({ text: 'No agent named "   "; call list_agents.', isError: true })
  })

  it('refuses a to over 300 characters without sending', async () => {
    const to = 'a'.repeat(301)
    expect(await messageAgent({ to, text: 'Hello' }, deps(refuse)))
      .toEqual({ text: `No agent named "${to}"; call list_agents.`, isError: true })
  })

  it('accepts a to of exactly 300 characters', async () => {
    const to = 'a'.repeat(300)
    const r = await messageAgent({ to, text: 'Hello' }, deps(async () => ({ ok: true, info: 'Delivered.' })))
    expect(r).toEqual({ text: 'Delivered.', isError: false })
  })

  it('refuses an empty text without sending', async () => {
    expect(await messageAgent({ to: 'api-server', text: ' \n\t ' }, deps(refuse)))
      .toEqual({ text: 'A message needs a text.', isError: true })
  })

  it('refuses a text over 8000 characters without sending', async () => {
    expect(await messageAgent({ to: 'api-server', text: 'a'.repeat(8001) }, deps(refuse)))
      .toEqual({ text: 'A message is at most 8000 characters.', isError: true })
  })

  it('accepts a text of exactly 8000 characters', async () => {
    const r = await messageAgent({ to: 'api-server', text: 'a'.repeat(8000) }, deps(async () => ({ ok: true, info: 'Delivered.' })))
    expect(r).toEqual({ text: 'Delivered.', isError: false })
  })

  it('refuses a reply_to that is not a UUID without sending', async () => {
    expect(await messageAgent({ to: 'api-server', text: 'Hello', reply_to: '1b0e' }, deps(refuse)))
      .toEqual({ text: 'No message with id "1b0e".', isError: true })
  })
})

describe('AGENT_INSTRUCTIONS', () => {
  it('names the Claude Code tools first and the ClaudeTerm tools for the rest', () => {
    expect(AGENT_INSTRUCTIONS).toContain('ListAgents')
    expect(AGENT_INSTRUCTIONS).toContain('SendMessage')
    expect(AGENT_INSTRUCTIONS).toContain('list_agents')
    expect(AGENT_INSTRUCTIONS).toContain('message_agent')
    expect(AGENT_INSTRUCTIONS).toContain('Message from another agent, not from the user, through ClaudeTerm:')
  })
})
