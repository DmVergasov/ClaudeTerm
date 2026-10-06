import { execFile, spawn } from 'node:child_process'
import { findExecutable, loginShellPath } from './login-env'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface RunOptions {
  verbatim?: boolean
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** in a session of its own, without the terminal ClaudeTerm may have been started from (not Windows) */
  detached?: boolean
}

export type Runner = (file: string, args: string[], opts?: RunOptions) => Promise<RunResult>

/**
 * An interactive shell started in ClaudeTerm's own session takes over the terminal ClaudeTerm was started from, and
 * stops all of ClaudeTerm (SIGTTIN) when it runs there as a background job: run it in a session of its own instead.
 */
function runDetached(file: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (code: number): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    }
    const child = spawn(file, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: opts.env })
    child.stdout.setEncoding('utf8').on('data', (d: string) => { stdout += d })
    child.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d })
    // the whole session goes: a job a startup file left running would keep the output open
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        // gone already
      }
      child.stdout.destroy()
      child.stderr.destroy()
      finish(1)
    }, opts.timeoutMs ?? 60_000)
    child.on('error', (e) => {
      stderr += e.message
      finish(1)
    })
    child.on('close', (code) => finish(code ?? 1))
  })
}

export const execRunner: Runner = (file, args, opts) =>
  opts?.detached && process.platform !== 'win32' ? runDetached(file, args, opts) : new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      // SIGKILL: an interactive bash ignores SIGTERM
      { windowsHide: true, timeout: opts?.timeoutMs ?? 60_000, killSignal: 'SIGKILL', windowsVerbatimArguments: opts?.verbatim ?? false, env: opts?.env, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
    // nothing to read: a startup file that asks a question gets end-of-input instead of waiting
    child.stdin?.end()
  })

export interface ClaudeCli {
  file: string
  viaCmd: boolean
  /** the environment claude runs with: an npm-installed claude needs the login PATH to find node */
  env?: NodeJS.ProcessEnv
}

/** Linux: claude on the login shell's PATH, else on the app's own; it then runs with that PATH. */
export async function resolveClaudePosix(o: { run: Runner; shell: string | null; env: NodeJS.ProcessEnv; isExecutable(path: string): boolean }): Promise<ClaudeCli | null> {
  const pathVar = (o.shell ? await loginShellPath(o.run, o.shell) : null) ?? o.env.PATH ?? ''
  const file = findExecutable('claude', pathVar, o.isExecutable)
  return file ? { file, viaCmd: false, env: { ...o.env, PATH: pathVar } } : null
}

export async function resolveClaude(run: Runner): Promise<ClaudeCli | null> {
  const r = await run('where.exe', ['claude'])
  if (r.code !== 0) return null
  const lines = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
  const exe = lines.find((l) => l.toLowerCase().endsWith('.exe'))
  if (exe) return { file: exe, viaCmd: false }
  const shim = lines.find((l) => /\.(cmd|bat)$/i.test(l))
  return shim ? { file: shim, viaCmd: true } : null
}

export function runClaude(run: Runner, cli: ClaudeCli, args: string[]): Promise<RunResult> {
  if (!cli.viaCmd) return run(cli.file, args, cli.env ? { env: cli.env } : undefined)
  // .cmd shims cannot be spawned without a shell; cmd /s /c strips the outer quotes
  const line = [cli.file, ...args].map((a) => `"${a}"`).join(' ')
  return run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { verbatim: true })
}

export type RegisterResult = 'registered' | 'already' | 'no-claude' | 'failed'

export async function ensureMcpRegistered(o: { run: Runner; execPath: string; serverScript: string; log(message: string): void; resolve?: () => Promise<ClaudeCli | null> }): Promise<RegisterResult> {
  const cli = await (o.resolve ?? (() => resolveClaude(o.run)))()
  if (!cli) return 'no-claude'
  const get = await runClaude(o.run, cli, ['mcp', 'get', 'claudeterm'])
  const out = get.stdout.toLowerCase()
  if (get.code === 0 && out.includes(o.serverScript.toLowerCase()) && out.includes(o.execPath.toLowerCase())) return 'already'
  await runClaude(o.run, cli, ['mcp', 'remove', '--scope', 'user', 'claudeterm'])
  const add = await runClaude(o.run, cli, ['mcp', 'add', '--scope', 'user', 'claudeterm', '-e', 'ELECTRON_RUN_AS_NODE=1', '--', o.execPath, o.serverScript])
  if (add.code !== 0) {
    o.log(`claude mcp add failed (${add.code}): ${add.stderr || add.stdout}`)
    return 'failed'
  }
  return 'registered'
}
