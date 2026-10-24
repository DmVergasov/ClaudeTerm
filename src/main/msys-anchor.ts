import { spawn, type ChildProcess } from 'node:child_process'
import { win32 } from 'node:path'
import type { Logger } from './log'

/*
 * Git for Windows' MSYS runtime (msys-2.0.dll) keeps a shared memory section per user, filled by the first MSYS process
 * that maps it while the others wait on a lock for up to 15 s. A process killed while it holds that lock leaves it held:
 * from then on every bash, sh, git hook and credential helper waits 15 s and dies with "add_item (...) failed, errno 1",
 * until no MSYS process maps the section any more (git-for-windows/git#6368, anthropics/claude-code#95755). Claude Code
 * runs a Claude tab's statusLine through Git Bash every few seconds and kills a run still going when the next starts,
 * so Claude tabs both make that kill likely and keep the section from ever being released. While one idle MSYS process
 * of the same runtime lives, the section stays filled and a starting process never takes the lock.
 */

/** the names Claude Code accepts in CLAUDE_CODE_GIT_BASH_PATH */
const BASH_NAMES = ['bash.exe', 'sh.exe', 'bash', 'sh']
/** where Claude Code looks for Git Bash before it looks for git on PATH */
const USUAL_BASH = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']

/**
 * The Git Bash a Claude tab's statusLine and hooks run in, found as Claude Code finds it: CLAUDE_CODE_GIT_BASH_PATH when
 * it names a bash or sh that exists, else Git's usual install folders, else bin\bash.exe of the first git.exe on PATH.
 */
export function findGitBash(env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | null {
  const custom = env.CLAUDE_CODE_GIT_BASH_PATH
  if (custom && BASH_NAMES.includes(win32.basename(custom).toLowerCase()) && exists(custom)) return custom
  const usual = USUAL_BASH.find((p) => exists(p))
  if (usual) return usual
  // Claude Code asks where.exe, and skips a git.exe it finds in the current folder: a relative folder in PATH is one
  const gitDir = (env.PATH ?? '').split(';').find((dir) => win32.isAbsolute(dir) && exists(win32.join(dir, 'git.exe')))
  if (!gitDir) return null
  const bash = win32.join(gitDir, '..', 'bin', 'bash.exe')
  return exists(bash) ? bash : null
}

/**
 * The anchor: sleep.exe of the same runtime, since the section is that runtime's own. It is in usr\bin under Git's
 * bin\bash.exe (a launcher that starts usr\bin\bash.exe), or next to a bash that is in usr\bin itself.
 */
export function anchorExe(bash: string, exists: (p: string) => boolean): string | null {
  const dir = win32.dirname(bash)
  return [win32.join(dir, 'sleep.exe'), win32.join(dir, '..', 'usr', 'bin', 'sleep.exe')].find((p) => exists(p)) ?? null
}

/**
 * Hidden, without a console window, in its own folder (so it never holds a project folder open). Not detached: libuv
 * puts the child in a job that Windows ends together with ClaudeTerm, after a crash too.
 */
export function spawnAnchor(file: string): ChildProcess {
  return spawn(file, ['infinity'], { cwd: win32.dirname(file), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
}

/** what MsysAnchor needs of a started process */
export interface AnchorChild {
  readonly pid?: number
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  on(event: 'spawn', listener: () => void): unknown
  on(event: 'error', listener: (e: Error) => void): unknown
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(): boolean
}

export interface MsysAnchorDeps {
  spawn(file: string): AnchorChild
  log: Pick<Logger, 'info' | 'warn'>
}

/** how much of the end of what an anchor wrote is kept for the log */
const STDERR_KEEP = 1000

/**
 * Keeps one anchor running while Claude tabs may start Git Bash. An anchor that ends (a runtime already stuck ends it
 * after 15 s; someone may end it) is not restarted on its own: the next Claude tab, restart or account switch starts one.
 */
export class MsysAnchor {
  private child: AnchorChild | null = null
  private stopped = false

  constructor(private readonly file: string, private readonly d: MsysAnchorDeps) {}

  /** starts the anchor unless it is running, or stop() was called */
  ensure(): void {
    if (this.child || this.stopped) return
    let child: AnchorChild
    try {
      child = this.d.spawn(this.file)
    } catch (e) {
      this.d.log.warn(`cannot start the MSYS anchor ${this.file}: ${(e as Error).message}`)
      return
    }
    this.child = child
    let stderr = ''
    child.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-STDERR_KEEP) })
    const ended = (what: string): void => {
      // once per anchor, and never for one stop() ended
      if (this.child !== child) return
      this.child = null
      const said = stderr.trim().replace(/\s+/g, ' ')
      this.d.log.warn(`MSYS anchor ${what}${said ? `: ${said}` : ''}`)
    }
    child.on('spawn', () => this.d.log.info(`MSYS anchor started: ${this.file} (pid ${child.pid})`))
    child.on('error', (e) => ended(`failed: ${e.message}`))
    // 'close' comes after the output: the log has the runtime's last words
    child.on('close', (code, signal) => ended(`ended (${signal ?? `exit code ${code}`})`))
  }

  /** ends the anchor for good */
  stop(): void {
    this.stopped = true
    this.child?.kill()
    this.child = null
  }
}
