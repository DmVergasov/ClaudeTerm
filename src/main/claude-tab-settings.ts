import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isWindowsPath } from './path-key'

export function hookCmdContent(execPath: string, hookScriptPath: string): string {
  const esc = (p: string): string => p.replace(/%/g, '%%')
  return ['@echo off', 'chcp 65001 >nul 2>&1', 'set ELECTRON_RUN_AS_NODE=1', `"${esc(execPath)}" "${esc(hookScriptPath)}" %*`, 'exit /b 0', ''].join('\r\n')
}

/** The same wrapper for Linux: sh runs the hook script under ClaudeTerm's own Node and always succeeds. */
export function hookShContent(execPath: string, hookScriptPath: string): string {
  const q = (p: string): string => `'${p.replace(/'/g, "'\\''")}'`
  return ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 ${q(execPath)} ${q(hookScriptPath)} "$@"`, 'exit 0', ''].join('\n')
}

export function hookCommandString(hookPath: string): string {
  // Always double-quote: the command is run by bash (Git Bash, Linux) as well as cmd. Inside bash double quotes
  // only \ " $ ` are special, so escape those; ' & ( ) ; # and spaces are then literal. Git Bash takes C:/… paths.
  const p = (isWindowsPath(hookPath) ? hookPath.replace(/\\/g, '/') : hookPath).replace(/(["$`\\])/g, '\\$1')
  return `"${p}"`
}

export function claudeTabSettingsJson(hookPath: string): string {
  const command = hookCommandString(hookPath)
  const run = { type: 'command', command, timeout: 10 }
  const hook = [{ hooks: [run] }]
  return JSON.stringify(
    {
      // refreshInterval: Claude Code re-runs statusLine only on new messages, /compact and mode changes,
      // so /effort and /model alone would not show up without it
      statusLine: { type: 'command', command: `${command} status`, refreshInterval: 5 },
      hooks: {
        SessionStart: hook,
        SubagentStart: hook,
        SubagentStop: hook,
        SessionEnd: hook,
        // the moments Claude waits for the user. PermissionRequest fires as the dialog opens, while
        // Notification(permission_prompt) only comes after ~6 s without an answer
        PermissionRequest: hook,
        PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [run] }],
        Stop: hook
      }
    },
    null,
    2
  )
}

export interface ClaudeTabFiles {
  settingsPath: string
  hookPath: string
}

export function writeClaudeTabFiles(dataDir: string, execPath: string, hookScriptPath: string, platform: NodeJS.Platform = process.platform): ClaudeTabFiles {
  mkdirSync(dataDir, { recursive: true })
  const win = platform === 'win32'
  const hookPath = join(dataDir, win ? 'session-hook.cmd' : 'session-hook.sh')
  const settingsPath = join(dataDir, 'claude-tab-settings.json')
  writeFileSync(hookPath, win ? hookCmdContent(execPath, hookScriptPath) : hookShContent(execPath, hookScriptPath), 'utf8')
  if (!win) chmodSync(hookPath, 0o755)
  writeFileSync(settingsPath, claudeTabSettingsJson(hookPath), 'utf8')
  return { settingsPath, hookPath }
}
