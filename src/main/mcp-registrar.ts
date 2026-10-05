import { execFile } from 'node:child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export type Runner = (file: string, args: string[], opts?: { verbatim?: boolean }) => Promise<RunResult>

export const execRunner: Runner = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 60_000, windowsVerbatimArguments: opts?.verbatim ?? false, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })

export interface ClaudeCli {
  file: string
  viaCmd: boolean
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
  if (!cli.viaCmd) return run(cli.file, args)
  // .cmd shims cannot be spawned without a shell; cmd /s /c strips the outer quotes
  const line = [cli.file, ...args].map((a) => `"${a}"`).join(' ')
  return run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { verbatim: true })
}

export type RegisterResult = 'registered' | 'already' | 'no-claude' | 'failed'

export async function ensureMcpRegistered(o: { run: Runner; execPath: string; serverScript: string; log(message: string): void }): Promise<RegisterResult> {
  const cli = await resolveClaude(o.run)
  if (!cli) return 'no-claude'
  const get = await runClaude(o.run, cli, ['mcp', 'get', 'claudeterm'])
  if (get.code === 0 && get.stdout.toLowerCase().includes(o.serverScript.toLowerCase())) return 'already'
  await runClaude(o.run, cli, ['mcp', 'remove', '--scope', 'user', 'claudeterm'])
  const add = await runClaude(o.run, cli, ['mcp', 'add', '--scope', 'user', 'claudeterm', '-e', 'ELECTRON_RUN_AS_NODE=1', '--', o.execPath, o.serverScript])
  if (add.code !== 0) {
    o.log(`claude mcp add failed (${add.code}): ${add.stderr || add.stdout}`)
    return 'failed'
  }
  return 'registered'
}
