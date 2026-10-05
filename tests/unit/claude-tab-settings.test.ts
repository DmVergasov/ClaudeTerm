import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeTabSettingsJson, hookCmdContent, hookCommandString, writeClaudeTabFiles } from '../../src/main/claude-tab-settings'

describe('hook files', () => {
  it('hookCmdContent runs the script under ELECTRON_RUN_AS_NODE and always exits 0', () => {
    const c = hookCmdContent('C:\\Program Files\\ClaudeTerm\\ClaudeTerm.exe', 'C:\\Program Files\\ClaudeTerm\\resources\\hook\\session-hook.js')
    expect(c.split('\r\n')).toEqual([
      '@echo off',
      'chcp 65001 >nul 2>&1',
      'set ELECTRON_RUN_AS_NODE=1',
      '"C:\\Program Files\\ClaudeTerm\\ClaudeTerm.exe" "C:\\Program Files\\ClaudeTerm\\resources\\hook\\session-hook.js"',
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

  it('claudeTabSettingsJson declares one SessionStart command hook', () => {
    expect(JSON.parse(claudeTabSettingsJson('C:\\Users\\me\\AppData\\Roaming\\ClaudeTerm\\session-hook.cmd'))).toEqual({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '"C:/Users/me/AppData/Roaming/ClaudeTerm/session-hook.cmd"', timeout: 10 }] }] }
    })
  })

  it('writeClaudeTabFiles writes both files into the data dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ct-hook-'))
    const files = writeClaudeTabFiles(dir, 'C:\\e.exe', 'C:\\h.js')
    expect(files).toEqual({ settingsPath: join(dir, 'claude-tab-settings.json'), cmdPath: join(dir, 'session-hook.cmd') })
    expect(readFileSync(files.cmdPath, 'utf8')).toBe(hookCmdContent('C:\\e.exe', 'C:\\h.js'))
    expect(readFileSync(files.settingsPath, 'utf8')).toBe(claudeTabSettingsJson(files.cmdPath))
  })
})
