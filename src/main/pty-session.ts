import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runOffThread } from './off-thread-spawn'

/** runs a program and resolves what it prints */
export type OutputRunner = (file: string, args: string[]) => Promise<string>

const output: OutputRunner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 1000, maxBuffer: 16 * 1024 * 1024 }, (e, stdout) => (e ? reject(e) : resolve(stdout)))
})

/** State and session id from a /proc/<pid>/stat line; the program name in parentheses may hold spaces and ')'. */
export function parseStat(stat: string): { state: string; session: number } | null {
  const end = stat.lastIndexOf(')')
  if (end < 0) return null
  // after the name: state ppid pgrp session …
  const f = stat.slice(end + 2).split(' ')
  const session = Number(f[3])
  return f[0] && Number.isInteger(session) ? { state: f[0], session } : null
}

/** Whether a live (not zombie) process still belongs to the session. Reads /proc: false where there is none. */
export function sessionAlive(sid: number, proc = '/proc'): boolean {
  let names: string[]
  try {
    names = readdirSync(proc)
  } catch {
    return false
  }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue
    let line: string
    try {
      line = readFileSync(join(proc, n, 'stat'), 'utf8')
    } catch {
      continue // the process is gone
    }
    const s = parseStat(line)
    if (s && s.session === sid && s.state !== 'Z') return true
  }
  return false
}

/** The processes `pid` started and the ones they started, from the lines "pid ppid" that `ps -A -o pid=,ppid=` prints. */
export function descendantsOf(pid: number, ps: string): number[] {
  const children = new Map<number, number[]>()
  for (const line of ps.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    if (Number.isInteger(child) && Number.isInteger(parent)) children.set(parent!, [...(children.get(parent!) ?? []), child!])
  }
  const found = new Set<number>()
  const queue = [pid]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const c of children.get(next) ?? []) {
      if (found.has(c)) continue
      found.add(c)
      queue.push(c)
    }
  }
  return [...found]
}

/**
 * Where there is no /proc (macOS, whose pgrep cannot select by session either): the programs a PTY's shell started,
 * by who started them. They are noted before the shell is hung up: once it exits, launchd adopts them. None when ps fails.
 */
export async function sessionPrograms(pid: number, run: OutputRunner = output): Promise<number[]> {
  try {
    return descendantsOf(pid, await run('ps', ['-A', '-o', 'pid=,ppid=']))
  } catch {
    return []
  }
}

/** how long reading a console's programs may take: its own close ends them after about 5 s anyway */
const CONSOLE_LIST_TIMEOUT_MS = 5000

// node-pty's reader of a console's programs (conpty_console_list.node), in a process of its own as node-pty runs it for
// Windows' own ConPTY: a process can look into one console only, and the reader leaves itself out of the list
const CONSOLE_LIST = "const { loadNativeModule } = require(process.argv[1]);" +
  "const list = loadNativeModule('conpty_console_list').module.getConsoleProcessList(Number(process.argv[2]));" +
  "process.stdout.write(JSON.stringify(list.filter((p) => p !== process.pid)))"

/**
 * Windows: the programs of the console a PTY's shell runs in, the shell among them. Read off the main thread; none when
 * that fails or takes too long.
 */
export async function consolePrograms(pid: number): Promise<number[]> {
  try {
    const r = await runOffThread(process.execPath, ['-e', CONSOLE_LIST, require.resolve('node-pty/lib/utils'), String(pid)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeoutMs: CONSOLE_LIST_TIMEOUT_MS
    })
    const list: unknown = JSON.parse(r.stdout.toString('utf8'))
    return Array.isArray(list) ? list.filter((n): n is number => Number.isInteger(n) && n > 0) : []
  } catch {
    return []
  }
}

/** whether a process is still there; a zombie is until its parent collects it, which launchd and init do at once */
export function processAlive(pid: number, signal: (pid: number, sig: number) => void = process.kill): boolean {
  try {
    signal(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Resolves once the session has no live process, or after timeoutMs. */
export async function waitSessionGone(sid: number, timeoutMs: number, alive: (sid: number) => boolean = sessionAlive, stepMs = 100): Promise<void> {
  const until = Date.now() + timeoutMs
  while (alive(sid) && Date.now() < until) await new Promise((r) => setTimeout(r, stepMs))
}
