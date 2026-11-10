import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import type { Settings } from '../shared/types'
import { isWindowsPath } from './path-key'

/** a word for sh, in single quotes: an apostrophe in it is closed, escaped and reopened */
const shQuote = (p: string): string => `'${p.replace(/'/g, "'\\''")}'`

/** The wrapper for Linux and macOS: sh runs the hook script under ClaudeTerm's own Node and always succeeds. */
export function hookShContent(execPath: string, hookScriptPath: string): string {
  return ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 ${shQuote(execPath)} ${shQuote(hookScriptPath)} "$@"`, 'exit 0', ''].join('\n')
}

export function hookCommandString(hookPath: string): string {
  // Always double-quote: the command is run by bash (Git Bash, Linux). Inside bash double quotes
  // only \ " $ ` are special, so escape those; ' & ( ) ; # and spaces are then literal. Git Bash takes C:/… paths.
  const p = (isWindowsPath(hookPath) ? hookPath.replace(/\\/g, '/') : hookPath).replace(/(["$`\\])/g, '\\$1')
  return `"${p}"`
}

/** How Claude Code starts the hook: a shell command, or with `args` an executable it spawns without a shell (exec form) */
export interface HookRun {
  command: string
  args?: string[]
}

/**
 * A path on cmd's command line. Claude Code quotes an argument only when it holds a space or a tab, and inside quotes cmd
 * takes & ^ ( ) literally; a path without them reaches cmd bare, so its special characters get cmd's escape, a ^ before
 * each (^% keeps %NAME% from expanding). Inside quotes cmd has no escape for %, so a quoted %NAME% naming a set variable
 * still expands.
 */
function cmdPathArg(p: string): string {
  return /[ \t]/.test(p) ? p : p.replace(/[%^&|<>()]/g, '^$&')
}

/**
 * Windows: an exec-form hook, cmd.exe given on its command line what a batch file would hold. AppLocker's default script
 * rules, where a policy enforces them, refuse batch files outside Program Files and Windows (and with them every hook run
 * through one), but not cmd.exe and its command line; and no Git Bash is involved. Every argument is one token without
 * spaces except the two paths. Exec form (`args`) needs Claude Code 2.1.139 or later.
 */
export function windowsHookRun(execPath: string, hookScriptPath: string, env: Record<string, string | undefined>): HookRun {
  return windowsExecRun(execPath, hookScriptPath, env, ['&', 'exit', '0'])
}

/** Windows: the mail watcher's run. cmd gives the exit code of the last command it ran, so nothing follows the script: its code 2 reaches Claude Code. */
export function windowsMailRun(execPath: string, hookScriptPath: string, env: Record<string, string | undefined>): HookRun {
  return windowsExecRun(execPath, hookScriptPath, env, ['mail'])
}

/** the exec-form run of the hook script under cmd.exe, with the arguments that follow the script */
function windowsExecRun(execPath: string, hookScriptPath: string, env: Record<string, string | undefined>, tail: string[]): HookRun {
  const cmd = win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  return { command: cmd, args: ['/d', '/s', '/c', 'set', 'ELECTRON_RUN_AS_NODE=1&&', cmdPathArg(execPath), cmdPathArg(hookScriptPath), ...tail] }
}

/** statusLine has no exec form: a command line for Git Bash, the shell Claude Code runs it in on Windows */
export function windowsStatusCommand(execPath: string, hookScriptPath: string): string {
  return `ELECTRON_RUN_AS_NODE=1 ${hookCommandString(execPath)} ${hookCommandString(hookScriptPath)} status`
}

/** the statusLine's refreshInterval the claude settings ask for; null: no timer */
export function statusRefreshInterval(claude: Settings['claude']): number | null {
  return claude.statusRefresh ? claude.statusRefreshInterval : null
}

/** mailRun: the mail watcher's run, or null when the tab gets no mail watcher */
export function claudeTabSettingsJson(hookRun: HookRun, statusCommand: string, refreshInterval: number | null, mailRun: HookRun | null): string {
  const run = { type: 'command', ...hookRun, timeout: 10 }
  const hook = [{ hooks: [run] }]
  // the watcher is held by main until mail comes: asyncRewake wakes the model when it exits 2, and a day is its limit
  const mailEntry = mailRun ? { type: 'command', ...mailRun, asyncRewake: true, timeout: 86400 } : null
  const sessionHook = mailEntry ? [{ hooks: [run, mailEntry] }] : hook
  return JSON.stringify(
    {
      // refreshInterval: Claude Code re-runs statusLine only on new messages, /compact and mode changes,
      // so /effort and /model alone would not show up without it. Each run starts a few processes, so it is a setting.
      statusLine: { type: 'command', command: statusCommand, ...(refreshInterval !== null ? { refreshInterval } : {}) },
      // the task list tools are ClaudeTerm's own, bundled with it: Claude may keep its list without asking each time
      permissions: { allow: ['mcp__claudeterm__set_task_list', 'mcp__claudeterm__get_task_list', 'mcp__claudeterm__list_agents', 'mcp__claudeterm__message_agent'] },
      hooks: {
        SessionStart: sessionHook,
        SubagentStart: hook,
        SubagentStop: hook,
        SessionEnd: hook,
        // the moments Claude waits for the user. PermissionRequest fires as the dialog opens, while
        // Notification(permission_prompt) only comes after ~6 s without an answer
        PermissionRequest: hook,
        // a turn starts: Last turn compares with the files as they were before it
        UserPromptSubmit: hook,
        PreToolUse: [
          { matcher: 'AskUserQuestion', hooks: [run] },
          // ClaudeTerm keeps each file as it was before Claude's first change in the turn and in the session
          { matcher: 'Edit|MultiEdit|Write|NotebookEdit', hooks: [run] }
        ],
        Stop: sessionHook,
        // a turn that ends in an API error (a connection lost mid-response, a rate limit) runs this instead of Stop
        // (no CwdChanged: a Bash cd only looks around; the session's own folder comes with the statusLine)
        StopFailure: hook
      }
    },
    null,
    2
  )
}

export interface ClaudeTabFiles {
  settingsPath: string
  /** the sh wrapper; Windows needs none */
  hookPath: string | null
}

/** mail: whether the tab's settings carry the mail watcher, which runs the hook script with `mail` and no exit 0 after it */
export function writeClaudeTabFiles(dataDir: string, execPath: string, hookScriptPath: string, refreshInterval: number | null, mail: boolean, platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): ClaudeTabFiles {
  mkdirSync(dataDir, { recursive: true })
  const settingsPath = join(dataDir, 'claude-tab-settings.json')
  if (platform === 'win32') {
    const mailRun = mail ? windowsMailRun(execPath, hookScriptPath, env) : null
    writeFileSync(settingsPath, claudeTabSettingsJson(windowsHookRun(execPath, hookScriptPath, env), windowsStatusCommand(execPath, hookScriptPath), refreshInterval, mailRun), 'utf8')
    return { settingsPath, hookPath: null }
  }
  const hookPath = join(dataDir, 'session-hook.sh')
  writeFileSync(hookPath, hookShContent(execPath, hookScriptPath), 'utf8')
  chmodSync(hookPath, 0o755)
  const command = hookCommandString(hookPath)
  const mailRun = mail ? { command: `ELECTRON_RUN_AS_NODE=1 ${shQuote(execPath)} ${shQuote(hookScriptPath)} mail` } : null
  writeFileSync(settingsPath, claudeTabSettingsJson({ command }, `${command} status`, refreshInterval, mailRun), 'utf8')
  return { settingsPath, hookPath }
}
