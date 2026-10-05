import { userInfo } from 'node:os'
import { defaultPipeName, isUuid, type PipeResponse, type SessionMessage } from '../shared/protocol'

export type Sender = (pipeName: string, msg: SessionMessage) => Promise<PipeResponse>

export async function runSessionHook(stdinText: string, env: NodeJS.ProcessEnv, send: Sender): Promise<boolean> {
  const tabId = env.CLAUDETERM_TAB_ID
  if (!isUuid(tabId)) return false
  let input: unknown
  try {
    input = JSON.parse(stdinText)
  } catch {
    return false
  }
  if (typeof input !== 'object' || input === null) return false
  const i = input as Record<string, unknown>
  if (!isUuid(i.session_id)) return false
  const msg: SessionMessage = {
    v: 1,
    type: 'session',
    tabId,
    sessionId: i.session_id,
    source: typeof i.source === 'string' ? i.source : 'unknown',
    transcriptPath: typeof i.transcript_path === 'string' ? i.transcript_path : null
  }
  try {
    await send(env.CLAUDETERM_PIPE || defaultPipeName(userInfo().username), msg)
    return true
  } catch {
    return false
  }
}
