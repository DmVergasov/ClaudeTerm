import { describe, expect, it } from 'vitest'
import {
  buildClaudeCommandLine, buildLaunch, buildProbe, canHostClaude, detectPosixProfiles, detectProfiles, filterAvailable, mergeProfiles, parseWslList,
  pickClaudeProfile, pickProfile, profileResolver, quoteForShell, shellFamily, type DetectDeps, type PosixDetectDeps, typedPaths
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
  const claude = { command: 'claude', settingsPath: 'C:\\Users\\me\\AppData\\Roaming\\ClaudeTerm\\claude-tab-settings.json', resumeSessionId: null, forkSession: false }

  it('buildClaudeCommandLine adds --settings and optional --resume', () => {
    expect(buildClaudeCommandLine('powershell', claude)).toBe("claude --settings 'C:\\Users\\me\\AppData\\Roaming\\ClaudeTerm\\claude-tab-settings.json'")
    expect(buildClaudeCommandLine('cmd', { ...claude, resumeSessionId: SID })).toBe(`claude --settings "${claude.settingsPath}" --resume ${SID}`)
  })

  it('buildClaudeCommandLine adds --fork-session after --resume', () => {
    expect(buildClaudeCommandLine('powershell', { ...claude, resumeSessionId: SID, forkSession: true })).toMatch(new RegExp(` --resume ${SID} --fork-session$`))
    expect(() => buildClaudeCommandLine('powershell', { ...claude, resumeSessionId: null, forkSession: true })).toThrow('--fork-session needs a session to resume')
  })

  it('rejects a non-UUID resume id', () => {
    expect(() => buildClaudeCommandLine('cmd', { ...claude, resumeSessionId: 'x & calc' })).toThrow()
  })

  it('a command line without a settings file has no --settings: the Get a token tab', () => {
    const setup = { command: 'claude setup-token', settingsPath: null, resumeSessionId: null, forkSession: false }
    expect(buildClaudeCommandLine('powershell', setup)).toBe('claude setup-token')
    expect(buildLaunch(PS, 'claude', setup)).toEqual({ file: PS.command, args: ['-NoLogo', '-NoExit', '-Command', 'claude setup-token'] })
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

  it('a run-once launch ends with its command in every shell', () => {
    const once = { once: true }
    const setup = { command: 'claude setup-token', settingsPath: null, resumeSessionId: null, forkSession: false }
    expect(buildLaunch(PS, 'claude', setup, once)).toEqual({ file: PS.command, args: ['-NoLogo', '-Command', 'claude setup-token'] })
    expect(buildLaunch(CMD, 'claude', setup, once)).toEqual({ file: CMD.command, args: '/c claude setup-token' })
    expect(buildLaunch(BASH, 'claude', setup, once)).toEqual({ file: BASH.command, args: ['--login', '-i', '-c', 'claude setup-token'] })
    expect(buildLaunch(ZSH, 'claude', setup, once)).toEqual({ file: ZSH.command, args: ['-l', '-i', '-c', 'claude setup-token'] })
    expect(buildLaunch(FISH, 'claude', setup, once)).toEqual({ file: FISH.command, args: ['-l', '-c', 'claude setup-token'] })
    expect(() => buildLaunch(WSL, 'claude', setup, once)).toThrow()
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

const ZSH: ProfileDef = { name: 'zsh', command: '/usr/bin/zsh', args: ['-l'] }
const LBASH: ProfileDef = { name: 'bash', command: '/bin/bash', args: ['-l'] }
const FISH: ProfileDef = { name: 'fish', command: '/usr/bin/fish', args: ['-l'] }

describe('detectPosixProfiles', () => {
  const shells = '# /etc/shells: valid login shells\n/bin/sh\n/bin/bash\n/usr/bin/bash\n/usr/bin/zsh\n/usr/bin/fish\n'
  const installed = ['/bin/sh', '/bin/bash', '/usr/bin/bash', '/usr/bin/zsh', '/usr/bin/fish']
  const d = (o: Partial<PosixDetectDeps> = {}): PosixDetectDeps => ({ loginShell: '/usr/bin/zsh', etcShells: shells, exists: (p) => installed.includes(p), ...o })

  it('lists the login shell first, then bash, zsh and fish once each, as login shells', () => {
    expect(detectPosixProfiles(d())).toEqual([ZSH, LBASH, FISH])
  })

  it('keeps a login shell it does not know, and finds shells without /etc/shells', () => {
    expect(detectPosixProfiles(d({ loginShell: '/usr/bin/tcsh', etcShells: null, exists: (p) => p === '/usr/bin/tcsh' || p === '/bin/bash' })))
      .toEqual([{ name: 'tcsh', command: '/usr/bin/tcsh', args: ['-l'] }, LBASH])
  })

  it('skips shells that are listed but not installed', () => {
    expect(detectPosixProfiles(d({ loginShell: null, exists: (p) => p === '/bin/bash' })).map((p) => p.name)).toEqual(['bash'])
  })
})

describe('Linux shells', () => {
  const claude = { command: 'claude', settingsPath: '/home/me/.config/ClaudeTerm/claude-tab-settings.json', resumeSessionId: SID, forkSession: false }
  const line = `claude --settings '/home/me/.config/ClaudeTerm/claude-tab-settings.json' --resume ${SID}`

  it('families: zsh and fish by name, bash and pwsh as on Windows', () => {
    expect(shellFamily(ZSH)).toBe('zsh')
    expect(shellFamily(FISH)).toBe('fish')
    expect(shellFamily(LBASH)).toBe('bash')
    expect(shellFamily({ name: 'pwsh', command: '/usr/bin/pwsh', args: [] })).toBe('powershell')
    expect([ZSH, FISH, LBASH].every(canHostClaude)).toBe(true)
  })

  it('Linux paths keep their backslashes; zsh quotes like bash, fish its own way', () => {
    const p = "/home/bob o'neil/.config/ClaudeTerm/a\\b.json"
    expect(quoteForShell('bash', p)).toBe("'/home/bob o'\\''neil/.config/ClaudeTerm/a\\b.json'")
    expect(quoteForShell('zsh', p)).toBe(quoteForShell('bash', p))
    expect(quoteForShell('fish', p)).toBe("'/home/bob o\\'neil/.config/ClaudeTerm/a\\\\b.json'")
  })

  it('bash and zsh run claude, then become the shell; fish runs it as its first command and stays', () => {
    expect(buildLaunch(LBASH, 'claude', claude)).toEqual({ file: '/bin/bash', args: ['--login', '-i', '-c', `${line}; exec bash --login -i`] })
    expect(buildLaunch(ZSH, 'claude', claude)).toEqual({ file: '/usr/bin/zsh', args: ['-l', '-i', '-c', `${line}; exec zsh -l -i`] })
    expect(buildLaunch(FISH, 'claude', claude)).toEqual({ file: '/usr/bin/fish', args: ['-l', '-C', line] })
  })

  it('Automatic is the first profile, the login shell', () => {
    expect(pickProfile([ZSH, LBASH], null)).toBe(ZSH)
    expect(pickClaudeProfile([ZSH, LBASH], null)).toEqual({ profile: ZSH, warning: null })
  })
})

describe('version probe', () => {
  const GITBASH = BASH

  it('runs `<command> --version` in the shell a Claude tab runs the command in, read the same way', () => {
    expect(buildProbe(PS, '& "C:\\x\\claude.exe"', 'win32')).toEqual({ file: PS.command, args: ['-NoLogo', '-NonInteractive', '-Command', '& "C:\\x\\claude.exe" --version'], verbatim: false, detached: false })
    expect(buildProbe(CMD, 'claude', 'win32')).toEqual({ file: CMD.command, args: ['/c', 'claude --version'], verbatim: true, detached: false })
    expect(buildProbe(GITBASH, 'claude', 'win32')).toEqual({ file: GITBASH.command, args: ['--login', '-i', '-c', 'claude --version'], verbatim: false, detached: false })
  })

  it('a Unix login shell sets the PATH, in a session of its own', () => {
    expect(buildProbe(LBASH, 'claude', 'linux')).toEqual({ file: '/bin/bash', args: ['--login', '-i', '-c', 'claude --version'], verbatim: false, detached: true })
    expect(buildProbe(ZSH, 'claude', 'darwin')).toEqual({ file: '/usr/bin/zsh', args: ['-l', '-i', '-c', 'claude --version'], verbatim: false, detached: true })
    expect(buildProbe(FISH, 'claude', 'linux')).toEqual({ file: '/usr/bin/fish', args: ['-l', '-c', 'claude --version'], verbatim: false, detached: true })
  })

  it('a profile that cannot host claude has no probe', () => {
    expect(() => buildProbe(WSL, 'claude', 'win32')).toThrow()
  })
})

describe('typedPaths', () => {
  const FISH: ProfileDef = { name: 'fish', command: '/usr/bin/fish', args: [] }
  const POSIX_BASH: ProfileDef = { name: 'Test Bash', command: '/bin/bash', args: ['--norc'] }

  it('a Claude tab gets double quotes whatever its profile', () => {
    expect(typedPaths(PS, 'claude', ['C:\\a b\\x.png'])).toBe('"C:\\a b\\x.png"')
    expect(typedPaths(POSIX_BASH, 'claude', ['/home/bo$b/x.png'])).toBe('"/home/bo$b/x.png"')
  })

  it('a PowerShell tab gets single quotes, with a single quote doubled', () => {
    expect(typedPaths(PS, 'shell', ["C:\\Bo$b\\it's.png"])).toBe("'C:\\Bo$b\\it''s.png'")
  })

  it('a bash tab gets single quotes, and a Git Bash Windows path is typed with slashes', () => {
    expect(typedPaths(POSIX_BASH, 'shell', ['/home/bo$b/a!b.png'])).toBe("'/home/bo$b/a!b.png'")
    expect(typedPaths(BASH, 'shell', ['C:\\T\\a.png'])).toBe("'C:/T/a.png'")
    expect(typedPaths(BASH, 'shell', ["C:\\T\\it's.png"])).toBe("'C:/T/it'\\''s.png'")
  })

  it('a cmd tab gets double quotes', () => {
    expect(typedPaths(CMD, 'shell', ['C:\\T\\a.png'])).toBe('"C:\\T\\a.png"')
  })

  it('a zsh or fish tab quotes as quoteForShell does', () => {
    expect(typedPaths(ZSH, 'shell', ["/home/bo/it's.png"])).toBe(quoteForShell('zsh', "/home/bo/it's.png"))
    expect(typedPaths(FISH, 'shell', ['/home/bo/a\\b.png'])).toBe(quoteForShell('fish', '/home/bo/a\\b.png'))
  })

  it('a WSL, other or missing profile gets double quotes', () => {
    expect(typedPaths(WSL, 'shell', ['/mnt/c/a.png'])).toBe('"/mnt/c/a.png"')
    expect(typedPaths({ name: 'x', command: 'C:\\nu.exe', args: [] }, 'shell', ['C:\\a.png'])).toBe('"C:\\a.png"')
    expect(typedPaths(null, 'shell', ['C:\\a.png'])).toBe('"C:\\a.png"')
  })

  it('two paths are joined by one space', () => {
    expect(typedPaths(PS, 'shell', ['C:\\a.png', "C:\\b c\\it's.png"])).toBe("'C:\\a.png' 'C:\\b c\\it''s.png'")
  })

  it('PowerShell also reads the typographic single quotes as quotes, so each one is doubled', () => {
    // U+2018, U+2019, U+201A, U+201B: a dropped "Bob’s report.docx" must not end the string
    expect(typedPaths(PS, 'shell', ['C:\\T\\Bob\u2019s.txt'])).toBe("'C:\\T\\Bob\u2019\u2019s.txt'")
    expect(quoteForShell('powershell', 'C:\\T\\a\u2018b\u201ac\u201bd.txt')).toBe("'C:\\T\\a\u2018\u2018b\u201a\u201ac\u201b\u201bd.txt'")
  })
})
