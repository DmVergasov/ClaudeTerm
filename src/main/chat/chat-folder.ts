import { isAbsolute } from 'node:path'

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const folderText = (v: unknown): string | null => (typeof v === 'string' && v !== '' && v.length <= 4096 && !v.includes('\0') && isAbsolute(v) ? v : null)

/**
 * The folder a chat's session moves to, from one SDK message: the result of Claude Code's EnterWorktree (the worktree entered) or
 * ExitWorktree (the folder the session was in before it entered one). A statusLine never runs for an SDK-hosted session, so these
 * results are what tells a chat tab its session works elsewhere. Null for any other message, a failed call, or a path that is not
 * absolute; whether the folder exists is for the caller to check.
 */
export function sessionFolderOf(msg: unknown): string | null {
  if (!isObj(msg) || msg.type !== 'user' || (typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id !== '')) return null
  const content = isObj(msg.message) ? msg.message.content : null
  if (!Array.isArray(content)) return null
  const answered = content.some(b => isObj(b) && b.type === 'tool_result' && b.is_error !== true)
  const out = msg.tool_use_result
  if (!answered || !isObj(out)) return null
  // ExitWorktree names the folder it came from; EnterWorktree names the worktree, and has no `action`
  if (typeof out.action === 'string') return folderText(out.originalCwd)
  return folderText(out.worktreePath)
}
