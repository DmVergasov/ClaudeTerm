import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UNREADABLE } from '../../src/main/mcp/mcp-config'
import { EnterWorktreeWatch, tabSettingsFiles, worktreeCreateHooks, WorktreeHookWarnings } from '../../src/main/worktree-hook'

// the error Claude Code gives EnterWorktree when a WorktreeCreate hook prints no path (Claude Code 2.1.325)
const NO_PATH = 'WorktreeCreate hook failed: hook succeeded but returned no worktree path (command: echo the path to stdout; http/callback: return hookSpecificOutput.worktreePath)'
const FAILS_UNTIL = 'EnterWorktree fails until that hook prints the worktree path or is removed'

const call = (id: string, name = 'EnterWorktree'): Record<string, unknown> => ({
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { name: 'notes' } }] }
})
const answer = (id: string, content: unknown, isError = true): Record<string, unknown> => ({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] },
  tool_use_result: isError ? `Error: ${String(content)}` : { worktreePath: '/work/acme-wt' }
})

describe('EnterWorktreeWatch', () => {
  it("gives the error of an EnterWorktree call that a WorktreeCreate hook broke, as the SDK and the transcript carry it", () => {
    const watch = new EnterWorktreeWatch()
    expect(watch.entry(call('w1'))).toBeNull()
    expect(watch.entry(answer('w1', NO_PATH))).toBe(NO_PATH)
    // a later Claude Code wraps the error, or gives it as text blocks
    watch.entry(call('w2'))
    expect(watch.entry(answer('w2', `<tool_use_error>${NO_PATH}</tool_use_error>`))).toBe(NO_PATH)
    watch.entry(call('w3'))
    expect(watch.entry(answer('w3', [{ type: 'text', text: 'WorktreeCreate hook failed: exit code 1: no repo' }]))).toBe('WorktreeCreate hook failed: exit code 1: no repo')
  })

  it('gives nothing for a call that worked, a failure for another reason, another tool, or a result of no known call', () => {
    const watch = new EnterWorktreeWatch()
    watch.entry(call('ok'))
    expect(watch.entry(answer('ok', 'Switched to worktree /work/acme-wt', false))).toBeNull()
    watch.entry(call('other'))
    expect(watch.entry(answer('other', 'Not in a git repository'))).toBeNull()
    watch.entry(call('bash', 'Bash'))
    expect(watch.entry(answer('bash', `Exit code 1\n${NO_PATH}`))).toBeNull()
    expect(watch.entry(answer('never-called', NO_PATH))).toBeNull()
    expect(watch.entry(null)).toBeNull()
    expect(watch.entry({ type: 'user', message: { content: 'text' } })).toBeNull()
  })
})

describe('worktreeCreateHooks', () => {
  it("lists what each WorktreeCreate hook of a settings file runs: a command with its arguments, or the URL it calls", () => {
    expect(worktreeCreateHooks({
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'not-this' }] }],
        WorktreeCreate: [
          { matcher: '', hooks: [{ type: 'command', command: 'node "C:/Tools/hook handler.js"' }, { type: 'http', url: 'http://localhost:9000/worktree' }] },
          { hooks: [{ type: 'command', command: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'make-wt.cmd'] }] }
        ]
      }
    })).toEqual(['node "C:/Tools/hook handler.js"', 'http://localhost:9000/worktree', 'C:\\Windows\\System32\\cmd.exe /c make-wt.cmd'])
  })

  it('finds none in a file without hooks, one that is not JSON, or malformed entries', () => {
    expect(worktreeCreateHooks(null)).toEqual([])
    expect(worktreeCreateHooks(UNREADABLE)).toEqual([])
    expect(worktreeCreateHooks({ hooks: { WorktreeCreate: 'echo' } })).toEqual([])
    expect(worktreeCreateHooks({ hooks: { WorktreeCreate: [null, { hooks: [{ type: 'command' }, 7] }] } })).toEqual([])
  })
})

describe('tabSettingsFiles', () => {
  it("is the account's settings.json, then the project's .claude/settings.json and .claude/settings.local.json", () => {
    const home = join('/', 'home', 'ann')
    const work = join('/', 'work', 'acme')
    expect(tabSettingsFiles({ CLAUDE_CONFIG_DIR: join('/', 'cfg', 'work-account') }, home, work)).toEqual([
      join('/', 'cfg', 'work-account', 'settings.json'), join(work, '.claude', 'settings.json'), join(work, '.claude', 'settings.local.json')
    ])
    expect(tabSettingsFiles({}, home, work)[0]).toBe(join(home, '.claude', 'settings.json'))
  })
})

/** warnings over settings files held in memory; `files` are the ones Claude Code merges for every tab */
function warnings(contents: Record<string, unknown>, files = ['/cfg/settings.json', '/work/acme/.claude/settings.json', '/work/acme/.claude/settings.local.json']) {
  const toasts: string[] = []
  const w = new WorktreeHookWarnings({
    files: async (tabId) => (tabId === 'gone' ? null : files),
    readJson: async (file) => contents[file] ?? null,
    toast: (text) => toasts.push(text)
  })
  return { w, toasts }
}

const HOOKED = { hooks: { WorktreeCreate: [{ hooks: [{ type: 'command', command: 'node "C:/Tools/other-terminal/hook-handler.js"' }] }] } }

describe('WorktreeHookWarnings', () => {
  it("tells the person once which settings file's hook broke EnterWorktree, whatever the tab and however often it is retried", async () => {
    const { w, toasts } = warnings({ '/cfg/settings.json': HOOKED })
    await w.failed('tab-1', NO_PATH)
    await w.failed('tab-1', NO_PATH)
    await w.failed('tab-2', NO_PATH)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('/cfg/settings.json')
    expect(toasts[0]).toContain('node "C:/Tools/other-terminal/hook-handler.js"')
    expect(toasts[0]).toContain(FAILS_UNTIL)
  })

  it("names a project's own hook too, every file that has one, in the order Claude Code merges them", async () => {
    const { w, toasts } = warnings({
      '/cfg/settings.json': { hooks: {} },
      '/work/acme/.claude/settings.json': { hooks: { WorktreeCreate: [{ hooks: [{ type: 'command', command: 'make-wt' }] }] } },
      '/work/acme/.claude/settings.local.json': HOOKED
    })
    await w.failed('tab-1', NO_PATH)
    expect(toasts).toHaveLength(1)
    const [project, local] = ['/work/acme/.claude/settings.json: make-wt', '/work/acme/.claude/settings.local.json: node "C:/Tools/other-terminal/hook-handler.js"'].map((s) => toasts[0].indexOf(s))
    expect(project).toBeGreaterThanOrEqual(0)
    expect(local).toBeGreaterThan(project)
  })

  it('names the files it looked in and the error when none of them has the hook (a plugin or a managed setting adds it)', async () => {
    const { w, toasts } = warnings({})
    await w.failed('tab-1', NO_PATH)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain(NO_PATH)
    expect(toasts[0]).toContain('/work/acme/.claude/settings.local.json')
    expect(toasts[0]).toContain(FAILS_UNTIL)
  })

  it("watches a chat's messages: a failed EnterWorktree warns, one that worked never does, even with a WorktreeCreate hook set", async () => {
    const { w, toasts } = warnings({ '/cfg/settings.json': HOOKED })
    w.message('tab-1', call('ok'))
    w.message('tab-1', answer('ok', 'Switched to worktree /work/acme-wt', false))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(toasts).toEqual([])
    w.message('tab-1', call('w1'))
    w.message('tab-1', answer('w1', NO_PATH))
    await expect.poll(() => toasts.length).toBe(1)
  })

  it('says nothing for a tab that is no Claude tab any more', async () => {
    const { w, toasts } = warnings({ '/cfg/settings.json': HOOKED })
    await w.failed('gone', NO_PATH)
    expect(toasts).toEqual([])
  })
})
