import { configPaths } from './mcp/mcp-config'

// A WorktreeCreate hook takes over EnterWorktree's worktree creation from git, and must print the worktree's path. A hook
// that prints nothing, or fails (another app's hook registered for every event), breaks EnterWorktree in every session that
// loads it. ClaudeTerm never edits the user's settings and creates no worktree itself: it tells the person which hook it is.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** an error of EnterWorktree that Claude Code blames on a WorktreeCreate hook ("WorktreeCreate hook failed: …") */
const HOOK_ERROR = /\bWorktreeCreate hook\b/
/** the EnterWorktree calls a watch keeps waiting for their results: a conversation makes one or two at a time */
const MAX_CALLS = 32
/** an error or a hook's command, as a toast shows it */
const TEXT_MAX = 300

/** one line of at most TEXT_MAX characters */
const shown = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > TEXT_MAX ? `${line.slice(0, TEXT_MAX - 1)}…` : line
}

/** the text of a tool result: its content is a string or a list of blocks; Claude Code may wrap an error in <tool_use_error> */
function resultText(content: unknown): string | null {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b) => (isObj(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
      : null
  if (text === null) return null
  return text.replace(/<\/?tool_use_error>/g, '').replace(/^\s*Error:\s*/, '')
}

/** the blocks of a message's content: an SDK message and a transcript entry carry them alike */
function blocks(entry: Record<string, unknown>): unknown[] {
  const content = isObj(entry.message) ? entry.message.content : null
  return Array.isArray(content) ? content : []
}

/**
 * The EnterWorktree calls of one conversation that a WorktreeCreate hook broke, from its entries in order: the messages of a
 * chat's SDK stream, or the entries of a transcript. A call is in an assistant message and its result in a later user
 * message; a call that worked, one that failed for another reason, and any other tool's failure are none.
 */
export class EnterWorktreeWatch {
  private readonly calls: string[] = []

  /** the hook's error, one line, when the entry answers an EnterWorktree call with it; else null */
  entry(entry: unknown): string | null {
    if (!isObj(entry)) return null
    if (entry.type === 'assistant') {
      for (const b of blocks(entry)) {
        if (isObj(b) && b.type === 'tool_use' && b.name === 'EnterWorktree' && typeof b.id === 'string' && !this.calls.includes(b.id)) this.calls.push(b.id)
      }
      if (this.calls.length > MAX_CALLS) this.calls.splice(0, this.calls.length - MAX_CALLS)
      return null
    }
    if (entry.type !== 'user') return null
    for (const b of blocks(entry)) {
      if (!isObj(b) || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
      const at = this.calls.indexOf(b.tool_use_id)
      if (at < 0) continue
      this.calls.splice(at, 1)
      const text = b.is_error === true ? resultText(b.content) : null
      if (text !== null && HOOK_ERROR.test(text)) return shown(text)
    }
    return null
  }
}

/** what one hook runs, as a toast names it: its command with its arguments, the URL it calls, or its type */
function hookText(hook: unknown): string | null {
  if (!isObj(hook)) return null
  if (typeof hook.command === 'string' && hook.command.trim() !== '') {
    const args = Array.isArray(hook.args) ? hook.args.filter((a): a is string => typeof a === 'string') : []
    return shown([hook.command, ...args].join(' '))
  }
  if (typeof hook.url === 'string' && hook.url.trim() !== '') return shown(hook.url)
  return null
}

/** the WorktreeCreate hooks a settings file configures (hooks.WorktreeCreate: matcher groups of hooks), as hookText names them */
export function worktreeCreateHooks(settings: unknown): string[] {
  const groups = isObj(settings) && isObj(settings.hooks) ? settings.hooks.WorktreeCreate : null
  if (!Array.isArray(groups)) return []
  return groups.flatMap((g) => (isObj(g) && Array.isArray(g.hooks) ? g.hooks.map(hookText).filter((t): t is string => t !== null) : []))
}

/** the settings files Claude Code merges for a tab, in its order: the account's settings.json, then the project's .claude/settings.json and .claude/settings.local.json */
export function tabSettingsFiles(env: Record<string, string | undefined>, home: string, folder: string): string[] {
  const p = configPaths(env, home, folder)
  return [p.userSettings, p.projectSettings, p.localSettings]
}

/** a WorktreeCreate hook, and the settings file that has it */
interface FoundHook {
  file: string
  command: string
}

export const WORKTREE_HOOK_TEXT = {
  found: (hooks: FoundHook[]): string => {
    const one = hooks.length === 1
    return `EnterWorktree failed because of the WorktreeCreate hook${one ? '' : 's'} in ${hooks.map((h) => `${h.file}: ${h.command}`).join('; ')}. ` +
      "A WorktreeCreate hook replaces git's worktree creation, so " +
      (one ? 'EnterWorktree fails until that hook prints the worktree path or is removed.' : 'EnterWorktree fails until those hooks print the worktree path or are removed.')
  },
  unknown: (files: string[], error: string): string =>
    `EnterWorktree failed because of a WorktreeCreate hook: ${error}. None of ${files.join(', ')} has one, so a plugin or a managed setting adds it. ` +
    'EnterWorktree fails until that hook prints the worktree path or is removed.'
}

export interface WorktreeHookDeps {
  /** the settings files Claude Code merges for the tab (tabSettingsFiles); null when it is no Claude tab now */
  files(tabId: string): Promise<string[] | null>
  /** a settings file parsed; null or UNREADABLE (or a throw) when it is missing or cannot be read */
  readJson(file: string): Promise<unknown>
  toast(text: string): void
}

/**
 * The warning about a WorktreeCreate hook that broke EnterWorktree: shown once per hook (per text) in an app run, whichever
 * tab hit it and however often Claude retried, since every session that loads those settings fails the same way.
 */
export class WorktreeHookWarnings {
  /** each chat tab's SDK stream */
  private readonly watches = new Map<string, EnterWorktreeWatch>()
  private readonly said = new Set<string>()

  constructor(private readonly d: WorktreeHookDeps) {}

  /** a message of a chat tab's SDK stream */
  message(tabId: string, msg: unknown): void {
    let watch = this.watches.get(tabId)
    if (watch === undefined) this.watches.set(tabId, (watch = new EnterWorktreeWatch()))
    const error = watch.entry(msg)
    if (error !== null) void this.failed(tabId, error)
  }

  /** the tab closed */
  removeTab(tabId: string): void {
    this.watches.delete(tabId)
  }

  /** an EnterWorktree of the tab failed because of a WorktreeCreate hook, with this error: the person learns which hook, once */
  async failed(tabId: string, error: string): Promise<void> {
    const files = await this.d.files(tabId)
    if (files === null) return
    const found: FoundHook[] = []
    for (const file of files) {
      let settings: unknown = null
      try {
        settings = await this.d.readJson(file)
      } catch {
        // a file that cannot be read configures nothing
      }
      for (const command of worktreeCreateHooks(settings)) found.push({ file, command })
    }
    const text = found.length > 0 ? WORKTREE_HOOK_TEXT.found(found) : WORKTREE_HOOK_TEXT.unknown(files, error)
    if (this.said.has(text)) return
    this.said.add(text)
    this.d.toast(text)
  }
}
