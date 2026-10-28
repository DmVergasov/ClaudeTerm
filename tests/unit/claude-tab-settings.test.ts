import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeTabSettingsJson, hookCommandString, hookShContent, windowsHookRun, windowsStatusCommand, writeClaudeTabFiles } from '../../src/main/claude-tab-settings'
import { WIN } from '../fixtures/platform'

describe('hook files', () => {
  it('windowsHookRun runs the script under ELECTRON_RUN_AS_NODE from cmd.exe\'s command line and always exits 0', () => {
    const exe = 'C:\\Program Files\\ClaudeTerm\\ClaudeTerm.exe'
    const script = 'C:\\Program Files\\ClaudeTerm\\resources\\hook\\session-hook.js'
    expect(windowsHookRun(exe, script, { SystemRoot: 'C:\\WINDOWS' })).toEqual({
      command: 'C:\\WINDOWS\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'set', 'ELECTRON_RUN_AS_NODE=1&&', exe, script, '&', 'exit', '0']
    })
  })

  it('windowsHookRun escapes cmd\'s special characters in a path without spaces, which Claude Code passes unquoted', () => {
    const exe = 'C:\\Users\\R&D^(1)\\ClaudeTerm.exe'
    const script = 'C:\\Users\\R&D^(1)\\%OS%\\session-hook.js'
    expect(windowsHookRun(exe, script, { SystemRoot: 'C:\\WINDOWS' }).args!.slice(5, 7)).toEqual([
      'C:\\Users\\R^&D^^^(1^)\\ClaudeTerm.exe',
      'C:\\Users\\R^&D^^^(1^)\\^%OS^%\\session-hook.js'
    ])
  })

  it('windowsHookRun leaves a path with spaces as it is: Claude Code quotes it, and inside quotes cmd takes & ^ ( ) literally', () => {
    const exe = 'C:\\Users\\R&D ^(1)\\ClaudeTerm.exe'
    expect(windowsHookRun(exe, exe, { SystemRoot: 'C:\\WINDOWS' }).args!.slice(5, 7)).toEqual([exe, exe])
  })

  it('windowsStatusCommand runs the script with "status" from Git Bash, quoted for bash', () => {
    expect(windowsStatusCommand("C:\\Users\\Bob's data\\ClaudeTerm.exe", 'C:\\a$b\\session-hook.js')).toBe(
      'ELECTRON_RUN_AS_NODE=1 "C:/Users/Bob\'s data/ClaudeTerm.exe" "C:/a\\$b/session-hook.js" status'
    )
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
    const hookRun = { command: 'C:\\WINDOWS\\System32\\cmd.exe', args: ['/d', '/s', '/c', 'hook'] }
    const run = { type: 'command', ...hookRun, timeout: 10 }
    const hook = [{ hooks: [run] }]
    expect(JSON.parse(claudeTabSettingsJson(hookRun, 'status command'))).toEqual({
      statusLine: { type: 'command', command: 'status command', refreshInterval: 5 },
      hooks: {
        SessionStart: hook,
        SubagentStart: hook,
        SubagentStop: hook,
        SessionEnd: hook,
        PermissionRequest: hook,
        UserPromptSubmit: hook,
        PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [run] }, { matcher: 'Edit|MultiEdit|Write|NotebookEdit', hooks: [run] }],
        Stop: hook,
        StopFailure: hook
      }
    })
  })

  it('writeClaudeTabFiles on Windows writes only the settings: the hooks run cmd.exe, never a batch file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-hook-'))
    const env = { SystemRoot: 'C:\\Windows' }
    const files = writeClaudeTabFiles(dir, 'C:\\e.exe', 'C:\\h.js', 'win32', env)
    expect(files).toEqual({ settingsPath: join(dir, 'claude-tab-settings.json'), hookPath: null })
    expect(readdirSync(dir)).toEqual(['claude-tab-settings.json'])
    expect(readFileSync(files.settingsPath, 'utf8')).toBe(claudeTabSettingsJson(windowsHookRun('C:\\e.exe', 'C:\\h.js', env), windowsStatusCommand('C:\\e.exe', 'C:\\h.js')))
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
    const hookPath = join(dir, 'session-hook.sh')
    expect(files).toEqual({ settingsPath: join(dir, 'claude-tab-settings.json'), hookPath })
    expect(readFileSync(hookPath, 'utf8')).toBe(hookShContent('/e', '/h.js'))
    if (!WIN) expect(statSync(hookPath).mode & 0o777).toBe(0o755)
    const command = hookCommandString(hookPath)
    expect(readFileSync(files.settingsPath, 'utf8')).toBe(claudeTabSettingsJson({ command }, `${command} status`))
  })
})
