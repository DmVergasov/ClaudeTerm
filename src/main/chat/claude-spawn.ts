import { spawn, type ChildProcess } from 'node:child_process'
import { posix, win32 } from 'node:path'
import { loginShellCommandFlags, shellFamily } from '../profiles'

/** How a chat tab starts the user's Claude command as a plain child process, without a terminal */
export type ChatLaunch =
  | { how: 'direct'; file: string }
  | { how: 'cmd'; file: string }                      // a .cmd / .bat shim, run by cmd.exe
  | { how: 'shell'; shell: string; command: string }  // the login shell execs the command line
  | { how: 'none'; reason: string }

export interface ChatLaunchDeps {
  platform: NodeJS.Platform
  isFile(p: string): boolean
  isExecutable(p: string): boolean
  /** where.exe's matches for a name: PATH folders in order */
  where(name: string): Promise<string[]>
  loginShell(): string | null
  /** Windows' PATHEXT: the extensions cmd.exe tries in order (default .COM;.EXE;.BAT;.CMD) */
  pathext?: string
}

/** the extensions a Claude command starts with: .exe directly, .cmd and .bat through cmd.exe */
const LAUNCH_EXTS = ['.exe', '.bat', '.cmd']
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * The match cmd.exe runs: where.exe lists the PATH folders in order, so the first folder with a launchable file wins;
 * in that folder the first extension in PATHEXT order wins, which is the one cmd.exe tries first. where.exe itself does
 * not list a folder's matches in PATHEXT order, so they are sorted here.
 */
function firstLaunchable(hits: string[], pathext: string): ChatLaunch | null {
  const ext = (p: string): string => win32.extname(p).toLowerCase()
  const folder = (p: string): string => win32.dirname(p).toLowerCase()
  const first = hits.find((p) => LAUNCH_EXTS.includes(ext(p)))
  if (first === undefined) return null
  const order = [...new Set([...pathext.split(';').map((e) => e.trim().toLowerCase()), ...LAUNCH_EXTS])].filter((e) => LAUNCH_EXTS.includes(e))
  const inFolder = hits.filter((p) => folder(p) === folder(first))
  const file = order.map((e) => inFolder.find((p) => ext(p) === e)).find((p) => p !== undefined) ?? first
  return ext(file) === '.exe' ? { how: 'direct', file } : { how: 'cmd', file }
}

/**
 * How the `claude.command` setting starts without a terminal. Windows: an absolute path to an existing .exe starts
 * directly, a .cmd / .bat runs through cmd.exe, any other file cannot start; a bare name is looked up with where and
 * takes the match cmd.exe would run (firstLaunchable). Elsewhere: an existing executable starts directly, a bare name or
 * a command with arguments runs through the login shell. Anything else (arguments, shell syntax) cannot start on Windows.
 *
 * `claude.shellProfile` is not used here: the command is resolved on this computer. A Claude Code found only inside
 * a WSL or Git Bash profile resolves to `none` on Windows, and the tab opens in the terminal with that reason.
 */
export async function resolveChatLaunch(command: string, deps: ChatLaunchDeps): Promise<ChatLaunch> {
  const win = deps.platform === 'win32'
  const path = win ? win32 : posix
  const none = (): ChatLaunch => ({ how: 'none', reason: `The Claude command "${command}" cannot be started without a terminal` })
  const viaShell = (): ChatLaunch => {
    const shell = deps.loginShell()
    return shell === null ? none() : { how: 'shell', shell, command }
  }
  if (command.trim() === '') return none()

  if (path.isAbsolute(command) && deps.isFile(command)) {
    if (!win) return deps.isExecutable(command) ? { how: 'direct', file: command } : none()
    const ext = path.extname(command).toLowerCase()
    if (ext === '.exe') return { how: 'direct', file: command }
    if (ext === '.cmd' || ext === '.bat') return { how: 'cmd', file: command }
    return none()
  }

  if (!/[\s/\\"']/.test(command)) {
    if (!win) return viaShell()
    let hits: string[] = []
    try {
      hits = await deps.where(command)
    } catch {
      // where.exe failed: no program found
    }
    return firstLaunchable(hits, deps.pathext ?? process.env.PATHEXT ?? DEFAULT_PATHEXT) ?? none()
  }

  return win ? none() : viaShell()
}

/** the MSVCRT quoting of one argument: backslashes before a quote are doubled, the quote is escaped, the whole is quoted */
function msvcrtQuote(arg: string): string {
  return `"${arg.replace(/(\\*)"/g, (_, b: string) => `${b}${b}\\"`).replace(/\\+$/, (b) => b + b)}"`
}

/** cmd.exe's metacharacters: each one gets a caret in front */
const CMD_META = /([()%!^"<>&|;, ])/g

/**
 * cmd.exe's command line for a batch file and its arguments, escaped as cross-spawn escapes for .cmd shims: each
 * argument is MSVCRT-quoted and its metacharacters are escaped twice (the shim's own %* is parsed by cmd.exe again);
 * the file path is quoted and escaped once.
 */
export function cmdShimLine(file: string, args: string[]): string {
  const escape = (s: string): string => s.replace(CMD_META, '^$1')
  return [escape(msvcrtQuote(file)), ...args.map((a) => escape(escape(msvcrtQuote(a))))].join(' ')
}

/** POSIX single quotes: nothing inside is interpreted, and a single quote is closed, escaped and reopened; backslashes are kept */
export function quoteForPosixShell(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`
}

/** fish single quotes: only \ and ' are special inside them, and each gets a backslash in front */
export function quoteForFish(arg: string): string {
  return `'${arg.replace(/[\\']/g, '\\$&')}'`
}

/** the argument quoted for the login shell: fish has its own rule, every other shell takes the POSIX one */
export function quoteForLoginShell(shell: string, arg: string): string {
  return shellFamily({ name: 'login', command: shell, args: [] }) === 'fish' ? quoteForFish(arg) : quoteForPosixShell(arg)
}

/**
 * starts a resolved launch as a child process with piped stdio; nothing is interpreted by a shell except through the launch's
 * own rule. On POSIX the process leads a group of its own (detached), so ending the chat ends the group: the commands and
 * servers Claude Code started go with it (sdk-engine's killChild).
 */
export function spawnChatProcess(launch: Exclude<ChatLaunch, { how: 'none' }>, args: string[], cwd: string, env: Record<string, string | undefined>): ChildProcess {
  const options = { cwd, env, stdio: 'pipe' as const, windowsHide: true, detached: process.platform !== 'win32' }
  switch (launch.how) {
    case 'direct':
      return spawn(launch.file, args, options)
    case 'cmd':
      return spawn(env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${cmdShimLine(launch.file, args)}"`], { ...options, detached: false, windowsVerbatimArguments: true })
    case 'shell': {
      // the shell reads its rc files the way a terminal's shell does (loginShellCommandFlags), so the command is found where the terminal finds it
      const family = shellFamily({ name: 'login', command: launch.shell, args: [] })
      const line = `exec ${launch.command} ${args.map((a) => quoteForLoginShell(launch.shell, a)).join(' ')}`
      return spawn(launch.shell, [...loginShellCommandFlags(family), line], options)
    }
  }
}
