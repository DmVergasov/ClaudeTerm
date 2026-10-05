import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function hookCmdContent(execPath: string, hookScriptPath: string): string {
  const esc = (p: string): string => p.replace(/%/g, '%%')
  return ['@echo off', 'chcp 65001 >nul 2>&1', 'set ELECTRON_RUN_AS_NODE=1', `"${esc(execPath)}" "${esc(hookScriptPath)}" %*`, 'exit /b 0', ''].join('\r\n')
}

export function hookCommandString(cmdPath: string): string {
  // Always double-quote: the command is run by bash (Git Bash) as well as cmd. Inside bash double quotes
  // only \ " $ ` are special, so escape those; ' & ( ) ; # and spaces are then literal.
  const p = cmdPath.replace(/\\/g, '/').replace(/(["$`\\])/g, '\\$1')
  return `"${p}"`
}

export function claudeTabSettingsJson(cmdPath: string): string {
  const command = hookCommandString(cmdPath)
  const hook = [{ hooks: [{ type: 'command', command, timeout: 10 }] }]
  return JSON.stringify(
    {
      // refreshInterval: Claude Code re-runs statusLine only on new messages, /compact and mode changes,
      // so /effort and /model alone would not show up without it
      statusLine: { type: 'command', command: `${command} status`, refreshInterval: 5 },
      hooks: { SessionStart: hook, SubagentStart: hook, SubagentStop: hook, SessionEnd: hook }
    },
    null,
    2
  )
}

export interface ClaudeTabFiles {
  settingsPath: string
  cmdPath: string
}

export function writeClaudeTabFiles(dataDir: string, execPath: string, hookScriptPath: string): ClaudeTabFiles {
  mkdirSync(dataDir, { recursive: true })
  const cmdPath = join(dataDir, 'session-hook.cmd')
  const settingsPath = join(dataDir, 'claude-tab-settings.json')
  writeFileSync(cmdPath, hookCmdContent(execPath, hookScriptPath), 'utf8')
  writeFileSync(settingsPath, claudeTabSettingsJson(cmdPath), 'utf8')
  return { settingsPath, cmdPath }
}
