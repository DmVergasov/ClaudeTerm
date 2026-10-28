import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { isWindowsPath } from './path-key'

/** The wrapper for Linux and macOS: sh runs the hook script under ClaudeTerm's own Node and always succeeds. */
export function hookShContent(execPath: string, hookScriptPath: string): string {
  const q = (p: string): string => `'${p.replace(/'/g, "'\\''")}'`
  return ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 ${q(execPath)} ${q(hookScriptPath)} "$@"`, 'exit 0', ''].join('\n')
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
  const cmd = win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  return { command: cmd, args: ['/d', '/s', '/c', 'set', 'ELECTRON_RUN_AS_NODE=1&&', cmdPathArg(execPath), cmdPathArg(hookScriptPath), '&', 'exit', '0'] }
}

/** statusLine has no exec form: a command line for Git Bash, the shell Claude Code runs it in on Windows */
export function windowsStatusCommand(execPath: string, hookScriptPath: string): string {
  return `ELECTRON_RUN_AS_NODE=1 ${hookCommandString(execPath)} ${hookCommandString(hookScriptPath)} status`
}

export function claudeTabSettingsJson(hookRun: HookRun, statusCommand: string): string {
  const run = { type: 'command', ...hookRun, timeout: 10 }
  const hook = [{ hooks: [run] }]
  return JSON.stringify(
    {
      // refreshInterval: Claude Code re-runs statusLine only on new messages, /compact and mode changes,
      // so /effort and /model alone would not show up without it
      statusLine: { type: 'command', command: statusCommand, refreshInterval: 5 },
      hooks: {
        SessionStart: hook,
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
        Stop: hook,
        // a turn that ends in an API error (a connection lost mid-response, a rate limit) runs this instead of Stop
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

export function writeClaudeTabFiles(dataDir: string, execPath: string, hookScriptPath: string, platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): ClaudeTabFiles {
  mkdirSync(dataDir, { recursive: true })
  const settingsPath = join(dataDir, 'claude-tab-settings.json')
  if (platform === 'win32') {
    writeFileSync(settingsPath, claudeTabSettingsJson(windowsHookRun(execPath, hookScriptPath, env), windowsStatusCommand(execPath, hookScriptPath)), 'utf8')
    return { settingsPath, hookPath: null }
  }
  const hookPath = join(dataDir, 'session-hook.sh')
  writeFileSync(hookPath, hookShContent(execPath, hookScriptPath), 'utf8')
  chmodSync(hookPath, 0o755)
  const command = hookCommandString(hookPath)
  writeFileSync(settingsPath, claudeTabSettingsJson({ command }, `${command} status`), 'utf8')
  return { settingsPath, hookPath }
}
