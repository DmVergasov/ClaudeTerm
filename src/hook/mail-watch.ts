import { isUuid, type MailWaitMessage } from '../shared/protocol'
import { hookPipe, parseInput, type Sender } from './session-hook'

export interface MailWatchResult {
  code: 0 | 2
  stderr: string
}

const QUIET: MailWatchResult = { code: 0, stderr: '' }

/**
 * The mail watcher: asks main for the mail of the tab and holds until main answers. Mail is handed to Claude Code as
 * stderr with exit code 2 (asyncRewake wakes the model with it); anything else exits 0 without output.
 */
export async function runMailWatch(stdinText: string, env: NodeJS.ProcessEnv, send: Sender): Promise<MailWatchResult> {
  const tabId = env.CLAUDETERM_TAB_ID
  const sessionId = parseInput(stdinText)?.session_id
  if (!isUuid(tabId) || !isUuid(sessionId)) return QUIET
  const msg: MailWaitMessage = { v: 1, type: 'mail_wait', tabId, sessionId }
  try {
    const res = await send(hookPipe(env), msg)
    if (res.ok && typeof res.info === 'string' && res.info !== '') return { code: 2, stderr: res.info }
    return QUIET
  } catch {
    return QUIET
  }
}
