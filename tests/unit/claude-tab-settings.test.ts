import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeTabSettingsJson, hookCmdContent, hookCommandString, hookShContent, writeClaudeTabFiles } from '../../src/main/claude-tab-settings'
import { WIN } from '../fixtures/platform'

describe('hook files', () => {
  it('hookCmdContent runs the script under ELECTRON_RUN_AS_NODE and always exits 0', () => {
    const c = hookCmdContent('C:\\Program Files\\ClaudeTerm\\ClaudeTerm.exe', 'C:\\Program Files\\ClaudeTerm\\resources\\hook\\session-hook.js')
    expect(c.split('\r\n')).toEqual([
      '@echo off',
      'chcp 65001 >nul 2>&1',
      'set ELECTRON_RUN_AS_NODE=1',
      '"C:\\Program Files\\ClaudeTerm\\ClaudeTerm.exe" "C:\\Program Files\\ClaudeTerm\\resources\\hook\\session-hook.js" %*',
      'exit /b 0',
      ''
    ])
  })

  it('escapes percent signs for cmd', () => {
    expect(hookCmdContent('C:\\100%\\a.exe', 'C:\\b.js')).toContain('"C:\\100%%\\a.exe"')
  })

  it('hookCommandString uses forward slashes and always double-quotes', () => {
    expect(hookCommandString('C:\\Users\\me\\AppData\\Roaming\\ClaudeTerm\\session-hook.cmd')).toBe('"C:/Users/me/AppData/Roaming/ClaudeTerm/session-hook.cmd"')
    expect(hookCommandString('C:\\Users\\John Doe\\AppData\\Roaming\\ClaudeTerm\\session-hook.cmd')).toBe('"C:/Users/John Doe/AppData/Roaming/ClaudeTerm/session-hook.cmd"')
  })

  it('hookCommandString is safe for apostrophes and bash-special characters', () => {
    expect(hookCommandString("C:\\Users\\Bob's\\ClaudeTerm\\session-hook.cmd")).toBe('"C:/Users/Bob\'s/ClaudeTerm/session-hook.cmd"')
    expect(hookCommandString("C:\\Users\\Bob's data\\session-hook.cmd")).toBe('"C:/Users/Bob\'s data/session-hook.cmd"')
    expect(hookCommandString('C:\\Users\\a$b`c\\session-hook.cmd')).toBe('"C:/Users/a\\$b\\`c/session-hook.cmd"')
    expect(hookCommandString('C:\\Users\\a&(b);#\\session-hook.cmd')).toBe('"C:/Users/a&(b);#/session-hook.cmd"')
  })

  it('claudeTabSettingsJson declares the statusLine, the session/subagent hooks and the attention hooks', () => {
    const command = '"C:/Users/me/AppData/Roaming/ClaudeTerm/session-hook.cmd"'
    const run = { type: 'command', command, timeout: 10 }
    const hook = [{ hooks: [run] }]
    expect(JSON.parse(claudeTabSettingsJson('C:\\Users\\me\\AppData\\Roaming\\ClaudeTerm\\session-hook.cmd'))).toEqual({
      statusLine: { type: 'command', command: `${command} status`, refreshInterval: 5 },
      hooks: {
        SessionStart: hook,
        SubagentStart: hook,
        SubagentStop: hook,
        SessionEnd: hook,
        PermissionRequest: hook,
        UserPromptSubmit: hook,
        PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [run] }, { matcher: 'Edit|MultiEdit|Write|NotebookEdit', hooks: [run] }],
        Stop: hook
      }
    })
  })

  it('writeClaudeTabFiles writes the .cmd and the settings on Windows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-hook-'))
    const files = writeClaudeTabFiles(dir, 'C:\\e.exe', 'C:\\h.js', 'win32')
    expect(files).toEqual({ settingsPath: join(dir, 'claude-tab-settings.json'), hookPath: join(dir, 'session-hook.cmd') })
    expect(readFileSync(files.hookPath, 'utf8')).toBe(hookCmdContent('C:\\e.exe', 'C:\\h.js'))
    expect(readFileSync(files.settingsPath, 'utf8')).toBe(claudeTabSettingsJson(files.hookPath))
  })

  it('hookShContent runs the script under ELECTRON_RUN_AS_NODE, passes the arguments on and always exits 0', () => {
    expect(hookShContent('/opt/ClaudeTerm/claudeterm', '/opt/ClaudeTerm/resources/hook/session-hook.js').split('\n')).toEqual([
      '#!/bin/sh',
      "ELECTRON_RUN_AS_NODE=1 '/opt/ClaudeTerm/claudeterm' '/opt/ClaudeTerm/resources/hook/session-hook.js' \"$@\"",
      'exit 0',
      ''
    ])
  })

  it('hookShContent quotes apostrophes for sh', () => {
    expect(hookShContent("/home/bob's/e", '/h.js')).toContain("'/home/bob'\\''s/e'")
  })

  it('hookCommandString keeps a Linux path as it is, escaping what bash would expand', () => {
    expect(hookCommandString('/home/me/.config/ClaudeTerm/session-hook.sh')).toBe('"/home/me/.config/ClaudeTerm/session-hook.sh"')
    expect(hookCommandString('/home/a\\b$c/session-hook.sh')).toBe('"/home/a\\\\b\\$c/session-hook.sh"')
  })

  it('writeClaudeTabFiles writes a runnable session-hook.sh on Linux', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-hook-'))
    const files = writeClaudeTabFiles(dir, '/e', '/h.js', 'linux')
    expect(files).toEqual({ settingsPath: join(dir, 'claude-tab-settings.json'), hookPath: join(dir, 'session-hook.sh') })
    expect(readFileSync(files.hookPath, 'utf8')).toBe(hookShContent('/e', '/h.js'))
    if (!WIN) expect(statSync(files.hookPath).mode & 0o777).toBe(0o755)
  })
})
