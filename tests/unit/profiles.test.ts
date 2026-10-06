import { describe, expect, it } from 'vitest'
import {
  buildClaudeCommandLine, buildLaunch, canHostClaude, detectProfiles, filterAvailable, mergeProfiles, parseWslList,
  pickClaudeProfile, pickProfile, profileResolver, quoteForShell, shellFamily, type DetectDeps
} from '../../src/main/profiles'
import type { ProfileDef } from '../../src/shared/types'

const SID = '5d2c1b7a-8e4f-4a3b-b1c2-d3e4f5a6b7c8'
const PS: ProfileDef = { name: 'Windows PowerShell', command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: ['-NoLogo'] }
const CMD: ProfileDef = { name: 'Command Prompt', command: 'C:\\Windows\\System32\\cmd.exe', args: [] }
const BASH: ProfileDef = { name: 'Git Bash', command: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] }
const WSL: ProfileDef = { name: 'WSL: Ubuntu', command: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'] }

function deps(files: string[], extra: Partial<DetectDeps> = {}): DetectDeps {
  return {
    exists: (p) => files.includes(p),
    env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
    findInPath: () => null,
    listWslDistros: () => ['Ubuntu', 'Debian'],
    ...extra
  }
}

describe('detectProfiles', () => {
  it('finds Windows PowerShell, cmd, Git Bash and WSL distros', () => {
    const found = detectProfiles(deps([PS.command, CMD.command, BASH.command, WSL.command]))
    expect(found.map((p) => p.name)).toEqual(['Windows PowerShell', 'Command Prompt', 'Git Bash', 'WSL: Ubuntu', 'WSL: Debian'])
    expect(found.find((p) => p.name === 'WSL: Debian')?.args).toEqual(['-d', 'Debian'])
  })

  it('prefers pwsh from PATH and lists it first', () => {
    const found = detectProfiles(deps([PS.command], { findInPath: (exe) => (exe === 'pwsh.exe' ? 'C:\\tools\\pwsh.exe' : null) }))
    expect(found[0]).toEqual({ name: 'PowerShell 7', command: 'C:\\tools\\pwsh.exe', args: ['-NoLogo'] })
  })

  it('falls back to Program Files for pwsh', () => {
    const found = detectProfiles(deps(['C:\\Program Files\\PowerShell\\7\\pwsh.exe']))
    expect(found[0].command).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
  })
})

describe('profile selection', () => {
  it('mergeProfiles: user overrides by name and appends new ones', () => {
    const userBash = { ...BASH, args: ['-l'] }
    const custom = { name: 'Custom', command: 'C:\\x.exe', args: [] }
    expect(mergeProfiles([PS, BASH], [userBash, custom])).toEqual([PS, userBash, custom])
  })

  it('pickProfile: preferred, then PowerShell 7, then Windows PowerShell, then first', () => {
    const pwsh = { name: 'PowerShell 7', command: 'C:\\pwsh.exe', args: [] }
    expect(pickProfile([CMD, PS, pwsh], 'Command Prompt')).toBe(CMD)
    expect(pickProfile([CMD, PS, pwsh], null)).toBe(pwsh)
    expect(pickProfile([CMD, PS], 'Missing')).toBe(PS)
    expect(pickProfile([CMD], null)).toBe(CMD)
    expect(() => pickProfile([], null)).toThrow()
  })

  it('pickClaudeProfile refuses WSL and warns', () => {
    expect(canHostClaude(WSL)).toBe(false)
    const r = pickClaudeProfile([PS, WSL], 'WSL: Ubuntu')
    expect(r.profile).toBe(PS)
    expect(r.warning).toContain('cannot run claude')
    expect(pickClaudeProfile([PS, BASH], 'Git Bash')).toEqual({ profile: BASH, warning: null })
    expect(pickClaudeProfile([PS], 'Nope').warning).toContain('not found')
  })
})

describe('filterAvailable', () => {
  const bare: ProfileDef = { name: 'Bare', command: 'pwsh.exe', args: [] }
  const rel: ProfileDef = { name: 'Rel', command: 'tools\\sh.exe', args: [] }
  const rel2: ProfileDef = { name: 'Rel2', command: 'tools/sh.exe', args: [] }

  it('keeps an absolute path that exists', () => {
    expect(filterAvailable([PS], (p) => p === PS.command)).toEqual({ available: [PS], missing: [] })
  })

  it('marks an absolute path that does not exist as missing', () => {
    expect(filterAvailable([PS], () => false)).toEqual({ available: [], missing: [PS] })
  })

  it('marks a relative path with a separator as missing when absent', () => {
    expect(filterAvailable([rel, rel2], () => false)).toEqual({ available: [], missing: [rel, rel2] })
  })

  it('keeps bare executable names even when exists returns false', () => {
    expect(filterAvailable([bare], () => false)).toEqual({ available: [bare], missing: [] })
  })

  it('preserves order in both arrays', () => {
    const r = filterAvailable([PS, bare, CMD, rel, BASH, WSL], (p) => p === PS.command || p === BASH.command)
    expect(r.available).toEqual([PS, bare, BASH])
    expect(r.missing).toEqual([CMD, rel, WSL])
  })
})

describe('shell families and quoting', () => {
  it('shellFamily by executable name', () => {
    expect(shellFamily(PS)).toBe('powershell')
    expect(shellFamily({ ...PS, command: 'C:\\tools\\pwsh.exe' })).toBe('powershell')
    expect(shellFamily(CMD)).toBe('cmd')
    expect(shellFamily(BASH)).toBe('bash')
    expect(shellFamily(WSL)).toBe('wsl')
    expect(shellFamily({ name: 'x', command: 'C:\\nu.exe', args: [] })).toBe('other')
  })

  it('quotes paths with spaces and apostrophes for every shell', () => {
    const p = "C:\\Users\\Bob O'Neil\\AppData\\Roaming\\ClaudeTerm\\claude-tab-settings.json"
    expect(quoteForShell('powershell', p)).toBe("'C:\\Users\\Bob O''Neil\\AppData\\Roaming\\ClaudeTerm\\claude-tab-settings.json'")
    expect(quoteForShell('cmd', p)).toBe(`"${p}"`)
    expect(quoteForShell('bash', p)).toBe("'C:/Users/Bob O'\\''Neil/AppData/Roaming/ClaudeTerm/claude-tab-settings.json'")
    expect(() => quoteForShell('wsl', p)).toThrow()
  })
})

describe('claude launch', () => {
  const claude = { command: 'claude', settingsPath: 'C:\\Users\\me\\AppData\\Roaming\\ClaudeTerm\\claude-tab-settings.json', resumeSessionId: null }

  it('buildClaudeCommandLine adds --settings and optional --resume', () => {
    expect(buildClaudeCommandLine('powershell', claude)).toBe("claude --settings 'C:\\Users\\me\\AppData\\Roaming\\ClaudeTerm\\claude-tab-settings.json'")
    expect(buildClaudeCommandLine('cmd', { ...claude, resumeSessionId: SID })).toBe(`claude --settings "${claude.settingsPath}" --resume ${SID}`)
  })

  it('rejects a non-UUID resume id', () => {
    expect(() => buildClaudeCommandLine('cmd', { ...claude, resumeSessionId: 'x & calc' })).toThrow()
  })

  it('buildLaunch for shell tabs uses the profile as is', () => {
    expect(buildLaunch(BASH, 'shell', null)).toEqual({ file: BASH.command, args: ['--login', '-i'] })
  })

  it('buildLaunch for claude tabs keeps the shell open after claude exits', () => {
    expect(buildLaunch(PS, 'claude', claude)).toEqual({ file: PS.command, args: ['-NoLogo', '-NoExit', '-Command', buildClaudeCommandLine('powershell', claude)] })
    expect(buildLaunch(CMD, 'claude', claude)).toEqual({ file: CMD.command, args: `/k ${buildClaudeCommandLine('cmd', claude)}` })
    expect(buildLaunch(BASH, 'claude', claude)).toEqual({ file: BASH.command, args: ['--login', '-i', '-c', `${buildClaudeCommandLine('bash', claude)}; exec bash --login -i`] })
    expect(() => buildLaunch(WSL, 'claude', claude)).toThrow()
    expect(() => buildLaunch(PS, 'claude', null)).toThrow()
  })
})

describe('parseWslList', () => {
  it('decodes UTF-16LE output with BOM and blank lines', () => {
    expect(parseWslList(Buffer.from('\uFEFFUbuntu\r\nDebian\r\n\r\n', 'utf16le'))).toEqual(['Ubuntu', 'Debian'])
  })

  it('decodes UTF-8 output', () => {
    expect(parseWslList(Buffer.from('Ubuntu\nkali-linux\n', 'utf8'))).toEqual(['Ubuntu', 'kali-linux'])
  })
})

describe('profileResolver', () => {
  it('detects the installed shells once, however often the settings are applied', () => {
    let detections = 0
    const detected: ProfileDef = { name: 'PowerShell 7', command: 'pwsh.exe', args: [] }
    const mine: ProfileDef = { name: 'Mine', command: 'C:\\x\\sh.exe', args: [] }
    const gone: ProfileDef = { name: 'Gone', command: 'C:\\gone\\sh.exe', args: [] }
    const resolve = profileResolver(() => { detections++; return [detected] }, (p) => p !== gone.command)
    expect(resolve([mine, gone])).toEqual({ profiles: [detected, mine], notices: ['Profile "Gone" not found: C:\\gone\\sh.exe'] })
    resolve([])
    expect(resolve([mine]).profiles).toEqual([detected, mine])
    expect(detections).toBe(1)
  })
})
