import { userInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { runMailWatch } from '../../src/hook/mail-watch'
import type { Sender } from '../../src/hook/session-hook'
import { defaultPipeName, type PipeMessage, type PipeResponse } from '../../src/shared/protocol'
import { PipeUnavailableError } from '../../src/shared/pipe-client'
import { testPipeName } from '../fixtures/platform'

const TAB = '0b8f8c1e-3f7a-4c41-9d0a-2b6f1a7e9c11'
const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const PIPE = testPipeName('watch')
const INPUT = JSON.stringify({ session_id: SID, hook_event_name: 'Stop', stop_hook_active: false })
const env = { CLAUDETERM_TAB_ID: TAB, CLAUDETERM_PIPE: PIPE }

/** a sender that records what it was asked to send and answers with res */
function answering(res: PipeResponse, sent: { pipe: string; msg: PipeMessage }[] = []): Sender {
  return async (pipe, msg) => {
    sent.push({ pipe, msg })
    return res
  }
}

describe('runMailWatch', () => {
  it('with mail it returns code 2 and the info as stderr', async () => {
    const r = await runMailWatch(INPUT, env, answering({ ok: true, info: 'You have mail from reviewer.' }))
    expect(r).toEqual({ code: 2, stderr: 'You have mail from reviewer.' })
  })

  it('an answer without info, an error, or no pipe give code 0 and no stderr', async () => {
    expect(await runMailWatch(INPUT, env, answering({ ok: true }))).toEqual({ code: 0, stderr: '' })
    expect(await runMailWatch(INPUT, env, answering({ ok: true, info: '' }))).toEqual({ code: 0, stderr: '' })
    expect(await runMailWatch(INPUT, env, answering({ ok: false, error: 'superseded' }))).toEqual({ code: 0, stderr: '' })
    expect(await runMailWatch(INPUT, env, async () => { throw new PipeUnavailableError('no pipe') })).toEqual({ code: 0, stderr: '' })
  })

  it('it sends mail_wait with the tab id and the session id of the hook input', async () => {
    const sent: { pipe: string; msg: PipeMessage }[] = []
    await runMailWatch(INPUT, env, answering({ ok: true }, sent))
    expect(sent).toEqual([{ pipe: PIPE, msg: { v: 1, type: 'mail_wait', tabId: TAB, sessionId: SID } }])
  })

  it('without CLAUDETERM_PIPE it asks the default pipe of the user', async () => {
    const sent: { pipe: string; msg: PipeMessage }[] = []
    await runMailWatch(INPUT, { CLAUDETERM_TAB_ID: TAB }, answering({ ok: true }, sent))
    expect(sent.map((s) => s.pipe)).toEqual([defaultPipeName(userInfo().username)])
  })

  it('a hook input without a session id, or a tab id that is not a UUID, sends nothing and gives 0', async () => {
    const sent: { pipe: string; msg: PipeMessage }[] = []
    const send = answering({ ok: true, info: 'mail' }, sent)
    for (const input of ['{}', JSON.stringify({ session_id: 'x' }), 'not json', '[]']) {
      expect(await runMailWatch(input, env, send)).toEqual({ code: 0, stderr: '' })
    }
    expect(await runMailWatch(INPUT, { CLAUDETERM_TAB_ID: 'x', CLAUDETERM_PIPE: PIPE }, send)).toEqual({ code: 0, stderr: '' })
    expect(sent).toEqual([])
  })
})
