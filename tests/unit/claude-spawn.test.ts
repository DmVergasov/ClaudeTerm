import { describe, expect, it } from 'vitest'
import { cmdShimLine, quoteForLoginShell, quoteForPosixShell, resolveChatLaunch, type ChatLaunchDeps } from '../../src/main/chat/claude-spawn'

const reason = (command: string): string => `The Claude command "${command}" cannot be started without a terminal`

interface FakeOpts {
  files?: string[]
  executables?: string[]
  where?: string[]
  login?: string | null
}

/** fake deps: `where` answers with the given paths and records the names it was asked for */
function fake(platform: NodeJS.Platform, o: FakeOpts = {}): ChatLaunchDeps & { asked: string[] } {
  const asked: string[] = []
  return {
    platform,
    asked,
    isFile: (p) => (o.files ?? []).includes(p),
    isExecutable: (p) => (o.executables ?? []).includes(p),
    where: async (name) => {
      asked.push(name)
      return o.where ?? []
    },
    loginShell: () => (o.login === undefined ? '/bin/zsh' : o.login),
    pathext: '.COM;.EXE;.BAT;.CMD'
  }
}

describe('resolveChatLaunch on Windows', () => {
  it('an existing absolute .exe starts directly', async () => {
    const file = 'C:\\Tools\\Claude\\claude.exe'
    expect(await resolveChatLaunch(file, fake('win32', { files: [file] }))).toEqual({ how: 'direct', file })
  })

  it('an existing absolute .cmd or .bat runs through cmd.exe, whatever the case of the extension', async () => {
    const cmd = 'C:\\npm\\claude.cmd'
    const bat = 'C:\\npm\\claude.BAT'
    expect(await resolveChatLaunch(cmd, fake('win32', { files: [cmd] }))).toEqual({ how: 'cmd', file: cmd })
    expect(await resolveChatLaunch(bat, fake('win32', { files: [bat] }))).toEqual({ how: 'cmd', file: bat })
  })

  it('an existing absolute file with another extension cannot be started without a terminal', async () => {
    const file = 'C:\\npm\\claude'
    expect(await resolveChatLaunch(file, fake('win32', { files: [file] }))).toEqual({ how: 'none', reason: reason(file) })
  })

  it('an absolute path with spaces that exists is a file, not arguments', async () => {
    const file = 'C:\\Program Files\\Claude\\claude.exe'
    expect(await resolveChatLaunch(file, fake('win32', { files: [file] }))).toEqual({ how: 'direct', file })
  })

  it('an absolute path that does not exist cannot be started without a terminal', async () => {
    const file = 'C:\\Missing\\claude.exe'
    expect(await resolveChatLaunch(file, fake('win32'))).toEqual({ how: 'none', reason: reason(file) })
  })

  it('a bare name is looked up with where, and its first .exe starts directly', async () => {
    const deps = fake('win32', { where: ['C:\\bin\\claude.exe', 'C:\\npm\\claude.cmd'] })
    expect(await resolveChatLaunch('claude', deps)).toEqual({ how: 'direct', file: 'C:\\bin\\claude.exe' })
    expect(deps.asked).toEqual(['claude'])
  })

  it('a bare name without an .exe uses the first .cmd or .bat in PATHEXT order, and skips the extensionless npm script', async () => {
    // the default PATHEXT lists .BAT before .CMD, as cmd.exe tries them
    const deps = fake('win32', { where: ['C:\\npm\\claude', 'C:\\npm\\claude.cmd', 'C:\\npm\\claude.bat'] })
    expect(await resolveChatLaunch('claude', deps)).toEqual({ how: 'cmd', file: 'C:\\npm\\claude.bat' })
  })

  it('an earlier .cmd wins over a later .exe', async () => {
    // where.exe lists the PATH folders in order: the first folder with a match is the one cmd.exe runs from
    const deps = fake('win32', { where: ['C:\\old\\claude.cmd', 'C:\\new\\claude.exe'] })
    expect(await resolveChatLaunch('claude', deps)).toEqual({ how: 'cmd', file: 'C:\\old\\claude.cmd' })
  })

  it('within one folder the PATHEXT order decides between an .exe and a .cmd', async () => {
    const listed = ['C:\\bin\\claude.cmd', 'C:\\bin\\claude.exe']
    expect(await resolveChatLaunch('claude', fake('win32', { where: listed }))).toEqual({ how: 'direct', file: 'C:\\bin\\claude.exe' })
    const pathext = { ...fake('win32', { where: listed }), pathext: '.COM;.CMD;.EXE' }
    expect(await resolveChatLaunch('claude', pathext)).toEqual({ how: 'cmd', file: 'C:\\bin\\claude.cmd' })
  })

  it('a bare name that where finds only as an extensionless file cannot be started without a terminal', async () => {
    expect(await resolveChatLaunch('claude', fake('win32', { where: ['C:\\npm\\claude'] }))).toEqual({ how: 'none', reason: reason('claude') })
  })

  it('a bare name that where does not find cannot be started without a terminal', async () => {
    expect(await resolveChatLaunch('claude', fake('win32'))).toEqual({ how: 'none', reason: reason('claude') })
  })

  it('a command with arguments or shell syntax cannot be started without a terminal', async () => {
    for (const command of ['claude --resume abc', 'npx claude', 'claude "x"', 'claude\'x\'', 'claude\\x']) {
      expect(await resolveChatLaunch(command, fake('win32', { where: ['C:\\bin\\claude.exe'] }))).toEqual({ how: 'none', reason: reason(command) })
    }
  })

  it('an empty command cannot be started without a terminal and does not reach where', async () => {
    const deps = fake('win32', { where: ['C:\\bin\\claude.exe'] })
    expect(await resolveChatLaunch('', deps)).toEqual({ how: 'none', reason: reason('') })
    expect(deps.asked).toEqual([])
  })

  it('a where that fails is no program found', async () => {
    const deps: ChatLaunchDeps = { ...fake('win32'), where: () => Promise.reject(new Error('where.exe is missing')) }
    expect(await resolveChatLaunch('claude', deps)).toEqual({ how: 'none', reason: reason('claude') })
  })
})

describe('resolveChatLaunch on Linux and macOS', () => {
  it('an existing absolute executable starts directly', async () => {
    const file = '/usr/local/bin/claude'
    expect(await resolveChatLaunch(file, fake('linux', { files: [file], executables: [file] }))).toEqual({ how: 'direct', file })
  })

  it('an existing absolute file that is not executable cannot be started without a terminal', async () => {
    const file = '/usr/local/bin/claude'
    expect(await resolveChatLaunch(file, fake('linux', { files: [file] }))).toEqual({ how: 'none', reason: reason(file) })
  })

  it('an absolute path that does not exist is handed to the login shell, which reports it', async () => {
    const command = '/nope/claude'
    expect(await resolveChatLaunch(command, fake('linux'))).toEqual({ how: 'shell', shell: '/bin/zsh', command })
  })

  it('a bare name runs through the login shell, and is not looked up with where', async () => {
    const deps = fake('linux')
    expect(await resolveChatLaunch('claude', deps)).toEqual({ how: 'shell', shell: '/bin/zsh', command: 'claude' })
    expect(deps.asked).toEqual([])
  })

  it('a bare name without a login shell cannot be started without a terminal', async () => {
    expect(await resolveChatLaunch('claude', fake('linux', { login: null }))).toEqual({ how: 'none', reason: reason('claude') })
  })

  it('a command with arguments or shell syntax runs through the login shell as it is written', async () => {
    const command = 'claude --settings "$HOME/s.json" && echo done'
    expect(await resolveChatLaunch(command, fake('darwin', { login: '/bin/bash' }))).toEqual({ how: 'shell', shell: '/bin/bash', command })
  })
})

describe('cmdShimLine', () => {
  it('quotes the file path and each argument, and escapes the metacharacters twice for cmd.exe', () => {
    expect(cmdShimLine('C:\\Tools\\claude.cmd', ['plain'])).toBe('^"C:\\Tools\\claude.cmd^" ^^^"plain^^^"')
  })

  it('escapes a space in the file path so cmd.exe reads one name', () => {
    expect(cmdShimLine('C:\\Program Files\\claude.cmd', [])).toBe('^"C:\\Program^ Files\\claude.cmd^"')
  })

  it('escapes a space inside an argument', () => {
    expect(cmdShimLine('C:\\c.cmd', ['with space'])).toBe('^"C:\\c.cmd^" ^^^"with^^^ space^^^"')
  })

  it('doubles the backslashes before a quote and escapes the quote', () => {
    expect(cmdShimLine('C:\\c.cmd', ['quote"inside'])).toContain(' ^^^"quote\\^^^"inside^^^"')
  })

  it('escapes every cmd.exe metacharacter of an argument', () => {
    expect(cmdShimLine('C:\\c.cmd', ['%PATH%'])).toContain(' ^^^"^^^%PATH^^^%^^^"')
    expect(cmdShimLine('C:\\c.cmd', ['a^b&c|d'])).toContain(' ^^^"a^^^^b^^^&c^^^|d^^^"')
  })

  it('turns an empty argument into an empty quoted string', () => {
    expect(cmdShimLine('C:\\c.cmd', [''])).toMatch(/ \^\^\^"\^\^\^"$/)
  })

  it('doubles the backslashes at the end of an argument so the closing quote is not escaped', () => {
    expect(cmdShimLine('C:\\c.cmd', ['dir\\'])).toMatch(/ \^\^\^"dir\\\\\^\^\^"$/)
  })
})

describe('quoteForLoginShell', () => {
  it('fish escapes each single quote and backslash, so a trailing backslash cannot leave a quote open', () => {
    expect(quoteForLoginShell('/usr/bin/fish', "it's")).toBe("'it\\'s'")
    expect(quoteForLoginShell('/usr/bin/fish', 'trail\\')).toBe("'trail\\\\'")
  })

  it('bash, zsh and an unknown shell keep the backslash and close, escape and reopen the quote', () => {
    for (const shell of ['/bin/bash', '/bin/zsh', '/usr/local/bin/xyz']) {
      expect(quoteForLoginShell(shell, 'C:\\x')).toBe("'C:\\x'")
      expect(quoteForLoginShell(shell, "it's")).toBe("'it'\\''s'")
    }
  })
})

describe('quoteForPosixShell', () => {
  it('quotes a Windows-looking path exactly, backslash kept', () => {
    expect(quoteForPosixShell('C:\\x')).toBe("'C:\\x'")
  })

  it('closes, escapes and reopens the quotes around a single quote', () => {
    expect(quoteForPosixShell("it's")).toBe("'it'\\''s'")
  })

  it('leaves the other shell characters inside the single quotes', () => {
    expect(quoteForPosixShell('a"b$c`d;e&f')).toBe("'a\"b$c`d;e&f'")
  })
})
