import { execFile, type ChildProcess } from 'node:child_process'
import { ptyCommand, spawnChatProcess, type ChatLaunch } from '../chat/claude-spawn'
import { spawnPty, type PtyHandle } from '../pty-host'

/** the time limit of a `claude mcp` or `claude plugin` call */
export const CLI_TIMEOUT_MS = 60_000
/** `claude mcp login` waits for the browser sign-in, so it has this much longer */
export const LOGIN_TIMEOUT_MS = 300_000

const MAX_STDOUT = 4 * 1024 * 1024
const MAX_STDERR = 64 * 1024
const MAX_MESSAGE = 500

export interface CliRun { code: number; stdout: string; stderr: string }

export interface CliOptions {
  cwd: string
  env: Record<string, string>
  timeoutMs?: number
  stdin?: string
  signal?: AbortSignal
  maxStdout?: number // 4 MiB
  /**
   * runs the command in a pseudo terminal, so its stdin and stdout are a terminal: `claude mcp login` waits for the browser's
   * sign-in only then. What it prints is the run's stdout (a terminal has no stderr of its own); `stdin` is not sent
   */
  tty?: boolean
}

export class CliError extends Error {
  constructor(readonly reason: 'timeout' | 'cancelled' | 'failed' | 'too-large', message: string) {
    super(message)
    this.name = 'CliError'
  }
}

/**
 * runs `claude <args>` as the tab's Claude Code is started (spawnChatProcess), with NO_COLOR=1. Resolves with any exit code;
 * rejects only with a CliError. On the time limit or an abort the process tree is killed before the promise rejects.
 * Nothing is logged here: the arguments may carry secrets.
 */
export function runClaudeCli(launch: Exclude<ChatLaunch, { how: 'none' }>, args: string[], o: CliOptions): Promise<CliRun> {
  if (o.tty === true) return runInTerminal(launch, args, o)
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) {
      reject(new CliError('cancelled', 'Cancelled'))
      return
    }
    const timeoutMs = o.timeoutMs ?? CLI_TIMEOUT_MS
    const maxStdout = o.maxStdout ?? MAX_STDOUT
    const out: Buffer[] = []
    let outBytes = 0
    const err: Buffer[] = []
    let errBytes = 0
    let settled = false
    let child: ChildProcess | undefined
    let timer: NodeJS.Timeout | undefined

    const detach = (): void => {
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
    }
    const succeed = (code: number | null): void => {
      if (settled) return
      settled = true
      detach()
      resolve({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    }
    const fail = (error: CliError): void => {
      if (settled) return
      settled = true
      detach()
      void killTree(child).then(() => reject(error))
    }
    const onAbort = (): void => fail(new CliError('cancelled', 'Cancelled'))

    try {
      child = spawnChatProcess(launch, args, o.cwd, { ...o.env, NO_COLOR: '1' })
    } catch (error) {
      settled = true
      reject(new CliError('failed', errorMessage(error)))
      return
    }
    const proc = child

    proc.on('error', (error) => fail(new CliError('failed', error.message)))
    proc.on('close', (code) => succeed(code))
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      outBytes += chunk.length
      if (outBytes > maxStdout) {
        fail(new CliError('too-large', "Claude Code's answer is too large"))
        return
      }
      out.push(chunk)
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      const room = MAX_STDERR - errBytes
      if (room <= 0) return
      const kept = chunk.subarray(0, room)
      err.push(kept)
      errBytes += kept.length
    })
    // a process that ends before it reads its input gets an error on stdin, which is not a failure of the call
    proc.stdin?.on('error', () => undefined)
    proc.stdin?.end(o.stdin ?? '')

    timer = setTimeout(() => fail(new CliError('timeout', `Claude Code did not answer in ${timeoutMs / 1000} s`)), timeoutMs)
    o.signal?.addEventListener('abort', onAbort)
  })
}

/** the size of the pseudo terminal a command runs in: wide, so a URL it prints is not wrapped */
const TTY_COLS = 400
const TTY_ROWS = 50

/** runClaudeCli in a pseudo terminal: the same time limit, abort and cap; the terminal is closed on either, which ends its programs */
function runInTerminal(launch: Exclude<ChatLaunch, { how: 'none' }>, args: string[], o: CliOptions): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) {
      reject(new CliError('cancelled', 'Cancelled'))
      return
    }
    const timeoutMs = o.timeoutMs ?? CLI_TIMEOUT_MS
    const maxStdout = o.maxStdout ?? MAX_STDOUT
    const out: string[] = []
    let outBytes = 0
    let settled = false
    let term: PtyHandle | undefined
    let timer: NodeJS.Timeout | undefined

    const detach = (): void => {
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: CliError): void => {
      if (settled) return
      settled = true
      detach()
      term?.kill()
      reject(error)
    }
    const onAbort = (): void => fail(new CliError('cancelled', 'Cancelled'))

    const env = { ...o.env, NO_COLOR: '1' }
    try {
      const command = ptyCommand(launch, args, env)
      term = spawnPty({
        file: command.file,
        args: command.args,
        cwd: o.cwd,
        env,
        cols: TTY_COLS,
        rows: TTY_ROWS,
        onData: (data) => {
          if (settled) return
          outBytes += Buffer.byteLength(data)
          if (outBytes > maxStdout) {
            fail(new CliError('too-large', "Claude Code's answer is too large"))
            return
          }
          out.push(data)
        },
        onExit: (code) => {
          if (settled) return
          settled = true
          detach()
          resolve({ code, stdout: out.join(''), stderr: '' })
        }
      })
    } catch (error) {
      settled = true
      reject(new CliError('failed', errorMessage(error)))
      return
    }
    timer = setTimeout(() => fail(new CliError('timeout', `Claude Code did not answer in ${timeoutMs / 1000} s`)), timeoutMs)
    o.signal?.addEventListener('abort', onAbort)
  })
}

/**
 * kills the process and its children: taskkill's tree on Windows, the process group elsewhere (the process leads its group,
 * spawnChatProcess starts it detached). Resolves when the kill has been issued, or at once when there is no live process.
 */
function killTree(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.pid === undefined) return Promise.resolve()
  // a process that has exited is not signalled again: its pid may belong to another process by now
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  const pid = child.pid
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
    })
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
  return Promise.resolve()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** ANSI colour and title sequences, which a failed command's output can carry */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/**
 * what a failed command says: the last 3 non-empty lines of stderr, else of stdout; ANSI codes stripped; at most 500 chars,
 * the END of them. The callers mask the secrets of the whole output first, so this cut cannot split one.
 */
export function cliMessage(r: CliRun): string {
  const lines = (text: string): string[] => text.replace(ANSI, '').split(/\r?\n/).filter(line => line.trim() !== '')
  const stderr = lines(r.stderr)
  const source = stderr.length > 0 ? stderr : lines(r.stdout)
  return source.slice(-3).join('\n').slice(-MAX_MESSAGE)
}

function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown }
  } catch {
    return undefined
  }
}

/**
 * the command's JSON: the whole trimmed stdout when it parses, else the last line that starts with { or [ and parses
 * (a login shell's banner comes first); undefined when none
 */
export function jsonOutput(stdout: string): unknown {
  const text = stdout.trim()
  const whole = parseJson(text)
  if (whole !== undefined) return whole.value
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.startsWith('{') || line.startsWith('['))
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseJson(lines[i])
    if (parsed !== undefined) return parsed.value
  }
  return undefined
}
